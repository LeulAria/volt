/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2 with VS Code's real extension host process (`bootstrap-fork` +
 * `vs/workbench/api/node/extensionHostProcess`) in a real sandbox, under the T3 policy. This test
 * plays the window: it hands the host its connection, speaks the extension host protocol on it
 * (ready, init data, initialized, then RPC), answers the main thread's calls, activates a test
 * extension and runs its command. T3-REAL-1: the extension activates, runs a command, starts a
 * language-server-style child, and is denied the network and the home folder; the secrets it asks
 * for are asked under its own id (the window's per-host check, B-08, is tested in the browser suite).
 *
 * A machine without a working sandbox skips loudly; with `VOLT_SANDBOX_REQUIRED` set it fails.
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { PersistentProtocol } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { LogLevel } from '../../../../platform/log/common/log.js';
import { handOffWhenReady, SandboxedExtensionHosts } from '../../../../platform/voltSandbox/node/extensionHostSandbox.js';
import { PrincipalRegistry } from '../../../../platform/voltSandbox/node/principalRegistry.js';
import { SandboxManager } from '../../../../platform/voltSandbox/node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../../../platform/voltSandbox/node/sandboxResolver.js';
import { ISandboxedHost, SandboxSupervisor } from '../../../../platform/voltSandbox/node/supervisor.js';
import { realSandboxAvailable } from '../../../../platform/voltSandbox/test/node/sandboxSuiteGate.js';
import { IExtensionHostInitData, isMessageOfType, MessageType, UIKind } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';

const EXTENSION_JS = `
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const tryRead = p => { try { fs.readFileSync(p); return 'read'; } catch (e) { return e.code || 'error'; } };
exports.activate = function (context) {
	context.subscriptions.push(vscode.commands.registerCommand('t3.run', async () => {
		const out = { activated: true };
		const storage = context.globalStorageUri.fsPath;
		try { fs.mkdirSync(storage, { recursive: true }); fs.writeFileSync(path.join(storage, 'cache.json'), '{}'); out.storageWrite = 'wrote'; } catch (e) { out.storageWrite = e.code; }
		out.homeRead = tryRead(path.join(os.homedir(), 'notes.txt'));
		out.workspaceWrite = (() => { try { fs.writeFileSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'planted.txt'), 'x'); return 'wrote'; } catch (e) { return e.code; } })();
		// A language server: a child process speaking on stdio.
		out.server = await new Promise(resolve => {
			const child = spawn('/bin/sh', ['-c', 'read line; echo "lsp:$line"; cat "$HOME/notes.txt" >/dev/null 2>&1 && echo child-read-home || echo child-denied']);
			let text = '';
			child.stdout.on('data', d => { text += d; });
			child.on('close', () => resolve(text.trim().split('\\n')));
			child.stdin.end('initialize\\n');
		});
		out.direct = await new Promise(resolve => {
			const socket = net.connect({ host: '1.1.1.1', port: 443 });
			socket.once('connect', () => { socket.destroy(); resolve('connected'); });
			socket.once('error', e => resolve(e.code || 'error'));
			setTimeout(() => resolve('timeout'), 5000);
		});
		out.secret = await context.secrets.get('token');
		return out;
	}));
};
`;

suite('Volt T3: the real extension host in the sandbox (P2)', function () {

	this.timeout(180_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let ext: string;
	let storageHome: string;
	let logs: string;
	let host: ISandboxHostFacts;
	let available = false;
	const managers: SandboxManager[] = [];

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-t3real-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		ext = join(home, '.volt', 'extensions', 'pub.lint-1.0.0');
		storageHome = join(root, 'data', 'User', 'globalStorage');
		logs = join(root, 'logs', 'sandboxed-extensions', 'pub.lint');
		for (const dir of [home, ws, ext, storageHome, logs, join(home, '.volt', 'sandbox', 'runs')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		await fs.writeFile(join(ext, 'package.json'), JSON.stringify({ name: 'lint', publisher: 'pub', version: '1.0.0', main: './extension.js', engines: { vscode: '*' } }));
		await fs.writeFile(join(ext, 'extension.js'), EXTENSION_JS);
		await fs.writeFile(join(home, 'notes.txt'), 'private');
		host = { ...await sandboxHostFacts(), home };
		const probe = new SandboxManager(undefined, { runRoot: join(home, '.volt', 'sandbox', 'runs'), host });
		managers.push(probe);
		available = realSandboxAvailable(await probe.capabilities(), 'T3 real extension host suite');
	});

	suiteTeardown(async () => {
		await Promise.all(managers.map(m => m.dispose()));
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	test('T3-REAL-1: an opted-in extension activates in its own sandboxed host, runs a command and a language server, and is denied the network and home', async () => {
		const manager = new SandboxManager(undefined, { runRoot: join(home, '.volt', 'sandbox', 'runs'), host });
		managers.push(manager);
		const registry = new PrincipalRegistry('t3-real');
		const supervisor = new SandboxSupervisor(manager, undefined, { sampleMs: 0, registry });
		store.add({ dispose: () => { supervisor.dispose(); registry.dispose(); } });
		const hosts = new SandboxedExtensionHosts(supervisor, registry);

		const result = await hosts.start({
			extension: { id: 'pub.lint', builtin: false, main: true, browser: false, extensionKind: ['workspace'], location: ext },
			workspaceRoots: [ws],
			workspaceTrusted: true,
			storageDir: join(storageHome, 'pub.lint'),
			extraWritable: [logs],
			bootstrapFork: FileAccess.asFileUri('bootstrap-fork').fsPath,
			args: ['--type=extensionHost', '--useHostProxy=false'],
			hostEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
			home,
		});
		assert.ok(result.ok, result.ok ? '' : `${result.code}: ${result.reason}`);
		const h: ISandboxedHost = result.host;
		const disposables: { dispose(): void }[] = [];
		try {
			// The window's end of the connection, and the end the host gets on its channel.
			const server = net.createServer();
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const windowSocket = net.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
			const hostSocket = await new Promise<net.Socket>(resolve => server.once('connection', resolve));
			server.close();
			const handed = await handOffWhenReady(result, () => ({ message: { type: 'VSCODE_EXTHOST_IPC_SOCKET', initialDataChunk: '', skipWebSocketFrames: true, permessageDeflate: false, inflateBytes: '' }, socket: hostSocket }));
			assert.ok(handed, `the host asked for its connection: ${h.stderrTail()}`);
			hostSocket.destroy(); // Ours closes; the host holds its own copy of the descriptor.

			const nodeSocket = new NodeSocket(windowSocket);
			const protocol = new PersistentProtocol({ socket: nodeSocket });
			disposables.push(protocol, nodeSocket);
			const description = extensionDescription(ext);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no handshake: ${h.stderrTail()}`)), 60_000);
				const listener = protocol.onMessage(msg => {
					if (isMessageOfType(msg, MessageType.Ready)) {
						protocol.send(VSBuffer.fromString(JSON.stringify(initData(description, join(storageHome), logs))));
					} else if (isMessageOfType(msg, MessageType.Initialized)) {
						clearTimeout(timer);
						listener.dispose();
						resolve();
					}
				});
			});

			const rpc = new RPCProtocol(protocol);
			disposables.push(rpc);
			const secretCalls: unknown[][] = [];
			// The main thread: every customer answers, none does anything, except what the test watches.
			for (const identifier of Object.values(MainContext)) {
				rpc.set(identifier, new Proxy({}, {
					get: (_target, name) => typeof name === 'string' && name.startsWith('$') ? (...args: unknown[]) => {
						if (identifier.sid === 'MainThreadSecretState' && name === '$getPassword') {
							secretCalls.push(args);
						}
						return undefined;
					} : undefined,
				}) as never);
			}
			rpc.getProxy(ExtHostContext.ExtHostConfiguration).$initializeConfiguration({
				defaults: emptyModel(), policy: emptyModel(), application: emptyModel(), userLocal: emptyModel(), userRemote: emptyModel(), workspace: emptyModel(), folders: [], configurationScopes: [],
			});
			rpc.getProxy(ExtHostContext.ExtHostWorkspace).$initializeWorkspace({ id: 'ws', name: 'ws', folders: [{ uri: URI.file(ws), name: 'ws', index: 0 }], configuration: null, isUntitled: false, transient: false }, true);
			const extensions = rpc.getProxy(ExtHostContext.ExtHostExtensionService);
			assert.strictEqual(await extensions.$activate(description.identifier, { startup: false, extensionId: description.identifier, activationEvent: 'onCommand:t3.run' }), true, 'activated');
			const out = await rpc.getProxy(ExtHostContext.ExtHostCommands).$executeContributedCommand('t3.run') as Record<string, unknown>;
			assert.strictEqual(out.activated, true, 'the command ran in the extension');
			assert.strictEqual(out.storageWrite, 'wrote', 'its own storage is writable');
			assert.notStrictEqual(out.homeRead, 'read', 'the home folder is not readable');
			assert.notStrictEqual(out.workspaceWrite, 'wrote', 'no raw workspace write');
			assert.deepStrictEqual(out.server, ['lsp:initialize', 'child-denied'], 'the language server answers and is confined');
			assert.notStrictEqual(out.direct, 'connected', 'no network');
			assert.deepStrictEqual(secretCalls.map(call => (call[0] as string).toLowerCase()), ['pub.lint'], 'secrets are asked for under its own id');
			assert.ok(h.attestation, 'the host was attested');
			await assert.rejects(fs.stat(join(ws, 'planted.txt')));
		} finally {
			for (const disposable of disposables.reverse()) {
				disposable.dispose();
			}
			await h.terminate();
		}
	});
});

function emptyModel() {
	return { contents: {}, keys: [], overrides: [] };
}

function extensionDescription(location: string): IExtensionDescription {
	return {
		identifier: new ExtensionIdentifier('pub.lint'),
		name: 'lint',
		publisher: 'pub',
		version: '1.0.0',
		engines: { vscode: '*' },
		main: './extension.js',
		activationEvents: ['onCommand:t3.run'],
		contributes: { commands: [{ command: 't3.run', title: 'Run' }] },
		extensionLocation: URI.file(location),
		isBuiltin: false,
		isUserBuiltin: false,
		isUnderDevelopment: false,
		targetPlatform: TargetPlatform.UNDEFINED,
		preRelease: false,
		extensionDependencies: [],
	} as IExtensionDescription;
}

function initData(description: IExtensionDescription, globalStorageHome: string, logsLocation: string): IExtensionHostInitData {
	return {
		version: '1.105.1',
		quality: undefined,
		// The sandboxed host can't signal outside its sandbox: no parent polling (the supervisor kills it with Volt).
		parentPid: 0,
		environment: {
			isExtensionDevelopmentDebug: false, appName: 'Volt', appHost: 'desktop', appLanguage: 'en', isExtensionTelemetryLoggingOnly: false, appUriScheme: 'volt',
			globalStorageHome: URI.file(globalStorageHome), workspaceStorageHome: URI.file(join(logsLocation, 'workspaceStorage')),
		},
		workspace: { id: 'ws', name: 'ws' },
		extensions: { versionId: 1, allExtensions: [description], myExtensions: [description.identifier], activationEvents: { 'pub.lint': ['onCommand:t3.run'] } },
		telemetryInfo: { sessionId: 's', machineId: 'm', sqmId: '', devDeviceId: '', firstSessionDate: '' },
		logLevel: LogLevel.Info,
		loggers: [],
		logsLocation: URI.file(logsLocation),
		autoStart: true,
		remote: { isRemote: false, authority: undefined, connectionData: null },
		consoleForward: { includeStack: false, logNative: false },
		uiKind: UIKind.Desktop,
	};
}
