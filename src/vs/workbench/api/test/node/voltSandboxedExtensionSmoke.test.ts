/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P2's smoke run (H.5, D-10): real Open VSX extensions, each opted in, activated in VS Code's real
 * extension host inside the T3 sandbox, and the same extension activated in an unsandboxed host
 * with the same stand-in main thread (the baseline), so what breaks is what the sandbox breaks, not
 * the stand-in. It also lists the `exports` each extension loses when it runs alone (H.5).
 *
 * Opt-in: `VOLT_T3_SMOKE_DIR=<dir>` holding one folder per extension, either an unpacked `.vsix`
 * (`<folder>/extension/package.json`) or an installed extension (`<folder>/package.json`). The
 * result is written to `<dir>/report.json`. Without it the suite skips (it needs downloads);
 * `scripts/volt-t3-smoke.sh` fetches Open VSX's most downloaded extensions and runs it.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
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
import { IT3ExportsFacts, t3BrokenExports } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { SandboxedExtensionHosts } from '../../../../platform/voltSandbox/node/extensionHostSandbox.js';
import { PrincipalRegistry } from '../../../../platform/voltSandbox/node/principalRegistry.js';
import { SandboxManager } from '../../../../platform/voltSandbox/node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../../../platform/voltSandbox/node/sandboxResolver.js';
import { SandboxSupervisor } from '../../../../platform/voltSandbox/node/supervisor.js';
import { realSandboxAvailable } from '../../../../platform/voltSandbox/test/node/sandboxSuiteGate.js';
import { IExtensionHostInitData, isMessageOfType, MessageType, UIKind } from '../../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';

const SMOKE_DIR = process.env.VOLT_T3_SMOKE_DIR;
const ACTIVATION_MS = 20_000;

interface IRunResult {
	readonly started: boolean;
	readonly refused?: string;
	readonly activated?: boolean | 'timeout';
	readonly commands: number;
	readonly errors: string[];
	readonly stderr?: string;
}

interface IHostHandle {
	readonly ready: Promise<boolean>;
	send(message: unknown, socket: net.Socket): boolean;
	stop(): Promise<void>;
	stderr(): string;
}

interface ISmokeExtension {
	readonly id: string;
	readonly location: string;
	readonly manifest: Record<string, unknown>;
}

suite('Volt T3 smoke: Open VSX extensions in the sandbox (P2)', function () {

	this.timeout(60 * 60_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let host: ISandboxHostFacts;
	let hosts: SandboxedExtensionHosts;
	const managers: SandboxManager[] = [];

	suiteSetup(async function () {
		if (!SMOKE_DIR) {
			// Not a sandbox suite skip: the smoke run needs a folder of downloaded extensions.
			process.stderr.write('\n\n!!! T3 smoke: set VOLT_T3_SMOKE_DIR to a folder of unpacked .vsix extensions to run it.\n!!! T3-SMOKE-1 SKIPPED.\n\n');
			return;
		}
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-t3-smoke-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		for (const dir of [home, ws, join(home, '.volt', 'sandbox', 'runs')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		await fs.writeFile(join(ws, 'README.md'), '# Title\n\nSome text with a speling mistake.\n');
		await fs.writeFile(join(ws, 'config.yaml'), 'name: test\nitems:\n  - a\n');
		await fs.writeFile(join(ws, 'main.go'), 'package main\n\nfunc main() {}\n');
		await fs.writeFile(join(ws, 'main.py'), 'print("hi")\n');
		await fs.writeFile(join(ws, 'index.js'), 'const a = 1;\nconsole.log(a)\n');
		await fs.writeFile(join(ws, '.editorconfig'), 'root = true\n[*]\nindent_style = tab\n');
		await fs.writeFile(join(ws, 'package.json'), '{"name":"ws","version":"1.0.0"}');
		host = { ...await sandboxHostFacts(), home };
	});

	suiteTeardown(async () => {
		await Promise.all(managers.map(m => m.dispose()));
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('T3-SMOKE-1: each extension activates in the sandbox as it does without it, or the difference is recorded', async function () {
		if (!SMOKE_DIR) {
			this.skip();
		}
		const manager = new SandboxManager(undefined, { runRoot: join(home, '.volt', 'sandbox', 'runs'), host });
		managers.push(manager);
		assert.ok(realSandboxAvailable(await manager.capabilities(), 'T3 smoke'), 'the smoke run needs a working sandbox');
		const registry = new PrincipalRegistry('t3-smoke');
		const supervisor = new SandboxSupervisor(manager, undefined, { sampleMs: 0, registry });
		store.add({ dispose: () => { supervisor.dispose(); registry.dispose(); } });
		hosts = new SandboxedExtensionHosts(supervisor, registry);

		const extensions = await readSmokeDir(SMOKE_DIR!);
		const exportsFacts: IT3ExportsFacts[] = extensions.map(({ id, manifest }) => ({
			id, builtin: false, code: typeof manifest.main === 'string' || typeof manifest.browser === 'string', extensionDependencies: stringList(manifest.extensionDependencies),
		}));
		const only = process.env.VOLT_T3_SMOKE_ONLY?.toLowerCase().split(',');
		const report: Record<string, unknown>[] = [];
		for (const { id, location, manifest } of extensions) {
			if (only && !only.includes(id.toLowerCase())) {
				continue;
			}
			const known = new Set(exportsFacts.map(facts => facts.id.toLowerCase()));
			// H.5: the APIs it can't reach alone (dependencies not in the smoke set are first party or missing: listed as such).
			const exportsLost = [
				...t3BrokenExports([id], exportsFacts).filter(link => link.from === id).map(link => link.to),
				...stringList(manifest.extensionDependencies).filter(dep => !known.has(dep.toLowerCase())).map(dep => `${dep} (not in the smoke set)`),
			];
			const extensionDescription = describeExtension(id, location, manifest);
			const plainStorage = join(root, `storage-plain-${id}`);
			const baseline = typeof manifest.main === 'string' ? await run(extensionDescription, () => plainHost(plainStorage), plainStorage) : { started: false, refused: 'no Node entry point', commands: 0, errors: [] };
			const sandboxed = await run(extensionDescription, () => sandboxedHost(id, location, manifest), join(root, 'storage', id.toLowerCase()));
			report.push({ id, version: manifest.version, kind: extensionFacts(id, manifest, false).extensionKind, main: typeof manifest.main === 'string', exportsLost, baseline, sandboxed, verdict: verdict(baseline, sandboxed) });
		}
		const summary: Record<string, number> = {};
		for (const entry of report) {
			const category = String(entry.verdict).split(':')[0];
			summary[category] = (summary[category] ?? 0) + 1;
		}
		await fs.writeFile(join(SMOKE_DIR!, 'report.json'), JSON.stringify({ platform: process.platform, date: new Date().toISOString(), summary, extensions: report }, undefined, '\t'));
		assert.ok(report.length > 0, 'extensions were run');
		for (const entry of report) {
			const sandboxed = entry.sandboxed as IRunResult;
			// Never silently unsandboxed: either its host started in the sandbox or the refusal says why.
			assert.ok(sandboxed.started || sandboxed.refused || !entry.main, `${entry.id}: started, or refused with a reason`);
		}
	});

	async function sandboxedHost(id: string, location: string, manifest: Record<string, unknown>): Promise<IHostHandle | string> {
		const result = await hosts.start({
			extension: { ...extensionFacts(id, manifest, false), location },
			workspaceRoots: [ws],
			workspaceTrusted: true,
			storageDir: join(root, 'storage', id.toLowerCase()),
			bootstrapFork: FileAccess.asFileUri('bootstrap-fork').fsPath,
			args: ['--type=extensionHost', '--useHostProxy=false'],
			hostEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
			home,
		});
		if (!result.ok) {
			return `${result.code}: ${result.reason}`;
		}
		return {
			ready: result.ready,
			send: (message, socket) => result.host.send(message, socket),
			stop: () => result.host.terminate(),
			stderr: () => result.host.stderrTail(),
		};
	}

	/** The baseline: the same extension host process, not sandboxed (test only). */
	async function plainHost(storage: string): Promise<IHostHandle> {
		await fs.mkdir(storage, { recursive: true });
		const child: ChildProcess = spawn(process.execPath, ['--disable-sigusr1', FileAccess.asFileUri('bootstrap-fork').fsPath, '--type=extensionHost', '--useHostProxy=false'], {
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ELECTRON_RUN_AS_NODE: '1', VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess', VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true', VSCODE_EXTHOST_WILL_SEND_SOCKET: '1' },
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		});
		let stderr = '';
		child.stderr?.on('data', d => { stderr = (stderr + d).slice(-8192); });
		const ready = new Promise<boolean>(resolve => {
			child.on('message', m => (m as { type?: string })?.type === 'VSCODE_EXTHOST_IPC_READY' && resolve(true));
			child.once('exit', () => resolve(false));
		});
		return {
			ready,
			send: (message, socket) => child.send(message as object, socket),
			stop: async () => { child.kill('SIGKILL'); },
			stderr: () => stderr,
		};
	}

	async function run(extensionDescription: IExtensionDescription, start: () => Promise<IHostHandle | string>, storageDir: string): Promise<IRunResult> {
		const handle = await start();
		if (typeof handle === 'string') {
			return { started: false, refused: handle, commands: 0, errors: [] };
		}
		const errors: string[] = [];
		let commands = 0;
		const disposables: { dispose(): void }[] = [];
		try {
			const server = net.createServer();
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const windowSocket = net.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
			const hostSocket = await new Promise<net.Socket>(resolve => server.once('connection', resolve));
			server.close();
			// As the server does: the connection goes to the host on its channel once it is ready.
			const handed = await handle.ready && handle.send({ type: 'VSCODE_EXTHOST_IPC_SOCKET', initialDataChunk: '', skipWebSocketFrames: true, permessageDeflate: false, inflateBytes: '' }, hostSocket);
			hostSocket.destroy();
			if (!handed) {
				windowSocket.destroy();
				return { started: false, commands, errors: ['the host stopped before it was ready'], stderr: tail(handle.stderr()) };
			}
			const nodeSocket = new NodeSocket(windowSocket);
			const protocol = new PersistentProtocol({ socket: nodeSocket });
			disposables.push(protocol, nodeSocket);
			const storageHome = join(storageDir, '..');
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no handshake: ${handle.stderr()}`)), 60_000);
				const listener = protocol.onMessage(msg => {
					if (isMessageOfType(msg, MessageType.Ready)) {
						protocol.send(VSBuffer.fromString(JSON.stringify(initData(extensionDescription, storageHome, join(storageDir, 'logs'), ws))));
					} else if (isMessageOfType(msg, MessageType.Initialized)) {
						clearTimeout(timer);
						listener.dispose();
						resolve();
					}
				});
			});
			const rpc = new RPCProtocol(protocol);
			disposables.push(rpc);
			for (const identifier of Object.values(MainContext)) {
				rpc.set(identifier, new Proxy({}, {
					get: (_target, method) => typeof method === 'string' && method.startsWith('$') ? (...args: unknown[]) => {
						if (identifier.sid === 'MainThreadCommands' && method === '$registerCommand') {
							commands++;
						}
						if (identifier.sid === 'MainThreadExtensionService' && (method === '$onExtensionActivationError' || method === '$onExtensionRuntimeError')) {
							errors.push(`${method.slice(3)}: ${errorText(args[1])}`);
						}
						if (identifier.sid === 'MainThreadErrors' && method === '$onUnexpectedError') {
							errors.push(`unexpected: ${errorText(args[0])}`);
						}
						if (identifier.sid === 'MainThreadConsole' && method === '$logExtensionHostMessage') {
							const entry = args[0] as { severity?: string; arguments?: string };
							if (entry?.severity === 'error') {
								errors.push(`console: ${String(entry.arguments).slice(0, 300)}`);
							}
						}
						return undefined;
					} : undefined,
				}) as never);
			}
			rpc.getProxy(ExtHostContext.ExtHostConfiguration).$initializeConfiguration({
				defaults: emptyModel(), policy: emptyModel(), application: emptyModel(), userLocal: emptyModel(), userRemote: emptyModel(), workspace: emptyModel(), folders: [], configurationScopes: [],
			});
			rpc.getProxy(ExtHostContext.ExtHostWorkspace).$initializeWorkspace({ id: 'ws', name: 'ws', folders: [{ uri: URI.file(ws), name: 'ws', index: 0 }], configuration: null, isUntitled: false, transient: false }, true);
			const activated = await Promise.race([
				rpc.getProxy(ExtHostContext.ExtHostExtensionService).$activate(extensionDescription.identifier, { startup: true, extensionId: extensionDescription.identifier, activationEvent: '*' }).catch(err => { errors.push(`activate: ${errorText(err)}`); return false; }),
				new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ACTIVATION_MS)),
			]);
			// Late errors (a language server that fails to start, a fetch that is refused).
			await new Promise(resolve => setTimeout(resolve, 3000));
			// `$activate` resolves true even when `activate()` threw: that comes as an activation error.
			const failed = errors.some(error => error.startsWith('ExtensionActivationError') || error.startsWith('activate:'));
			// The two runs use different storage folders: name them alike so only real differences count.
			const normalized = errors.map(error => error.split(storageDir).join('<storage>').split(root).join('<root>'));
			return { started: true, activated: activated === true && failed ? false : activated, commands, errors: [...new Set(normalized)].slice(0, 12), stderr: tail(handle.stderr()) };
		} catch (err) {
			return { started: false, commands, errors: [...errors, errorText(err)], stderr: tail(handle.stderr()) };
		} finally {
			for (const disposable of disposables.reverse()) {
				disposable.dispose();
			}
			await handle.stop();
		}
	}
});

/** The extensions in `dir`: unpacked `.vsix` folders (`extension/package.json`) or installed ones (`package.json`). */
async function readSmokeDir(dir: string): Promise<ISmokeExtension[]> {
	const found: ISmokeExtension[] = [];
	for (const name of (await fs.readdir(dir)).sort()) {
		for (const location of [join(dir, name, 'extension'), join(dir, name)]) {
			const manifest = JSON.parse(await fs.readFile(join(location, 'package.json'), 'utf8').catch(() => 'null'));
			if (manifest && typeof manifest.publisher === 'string' && typeof manifest.name === 'string') {
				found.push({ id: `${manifest.publisher}.${manifest.name}`, location, manifest });
				break;
			}
		}
	}
	return found;
}

function describeExtension(id: string, location: string, manifest: Record<string, unknown>): IExtensionDescription {
	return {
		...manifest,
		name: String(manifest.name), publisher: String(manifest.publisher), version: String(manifest.version ?? '0.0.0'), engines: { vscode: '*' },
		identifier: new ExtensionIdentifier(id),
		extensionLocation: URI.file(location),
		isBuiltin: false, isUserBuiltin: false, isUnderDevelopment: false, targetPlatform: TargetPlatform.UNDEFINED, preRelease: false,
		// Alone in its host: dependencies run elsewhere (what it loses is in the report's exportsLost).
		extensionDependencies: [],
	} as IExtensionDescription;
}

function verdict(baseline: IRunResult, sandboxed: IRunResult): string {
	if (sandboxed.refused) {
		return `refused: ${sandboxed.refused}`;
	}
	if (baseline.activated === true && sandboxed.activated !== true) {
		return 'breaks: activates only without the sandbox';
	}
	const extra = sandboxed.errors.filter(error => !baseline.errors.includes(error));
	if (extra.length) {
		return `degraded: ${extra.length} error(s) only in the sandbox`;
	}
	return baseline.activated === true ? 'works' : 'same as baseline: the stand-in main thread';
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function tail(text: string): string | undefined {
	const lines = text.trim().split('\n').filter(Boolean).slice(-5).join('\n');
	return lines || undefined;
}

function errorText(err: unknown): string {
	if (err && typeof err === 'object') {
		const message = (err as { message?: unknown }).message;
		if (typeof message === 'string') {
			return message.slice(0, 300);
		}
		try {
			return JSON.stringify(err).slice(0, 300);
		} catch {
			// fall through
		}
	}
	return String(err).slice(0, 300);
}

/** What the sandbox decides on, from a manifest (as the server's scan reads it). */
function extensionFacts(id: string, manifest: Record<string, unknown>, builtin: boolean) {
	const kind = manifest.extensionKind;
	return {
		id, builtin,
		main: typeof manifest.main === 'string', browser: typeof manifest.browser === 'string',
		extensionKind: Array.isArray(kind) ? kind.filter((k): k is string => typeof k === 'string') : typeof kind === 'string' ? [kind] : ['workspace'],
	};
}

function emptyModel() {
	return { contents: {}, keys: [], overrides: [] };
}

function initData(description: IExtensionDescription, globalStorageHome: string, logsLocation: string, ws: string): IExtensionHostInitData {
	return {
		version: '1.105.1',
		quality: undefined,
		parentPid: 0,
		environment: {
			isExtensionDevelopmentDebug: false, appName: 'Volt', appHost: 'desktop', appLanguage: 'en', isExtensionTelemetryLoggingOnly: false, appUriScheme: 'volt',
			globalStorageHome: URI.file(globalStorageHome), workspaceStorageHome: URI.file(join(logsLocation, 'workspaceStorage')),
		},
		workspace: { id: 'ws', name: 'ws' },
		extensions: { versionId: 1, allExtensions: [description], myExtensions: [description.identifier], activationEvents: { [description.identifier.value]: ['*'] } },
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
