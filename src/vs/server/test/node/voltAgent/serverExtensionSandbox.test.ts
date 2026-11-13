/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P2/P6, the server's part: which extension a sandboxed host is for and where it may write
// come from the server's own extension folders and data dirs, never the request (T3-SRV-1..3);
// the desktop's ticket is single use, from this computer only (P6-TICKET-1).

import assert from 'assert';
import { promises as fs } from 'fs';
import type * as http from 'http';
import type { Socket } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { VOLT_EXTHOST_TICKET_QUERY } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IVoltSandboxedHostStartParams } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { ISandboxedExtensionHostRequest, SandboxedExtensionHosts, SandboxedExtensionHostResult } from '../../../../platform/voltSandbox/node/extensionHostSandbox.js';
import { IVoltExtensionHostSandboxStartOptions, startSandboxedExtensionHost } from '../../../node/extensionHostConnection.js';
import { IServerEnvironmentService } from '../../../node/serverEnvironmentService.js';
import { extensionFacts, findInstalledExtension, ServerExtensionSandbox } from '../../../node/voltAgent/serverExtensionSandbox.js';
import { ServerWorkbench } from '../../../node/voltAgent/serverWorkbench.js';

suite('Volt agent server: sandboxed extension hosts (P2, P6)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-srv-t3-')));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function install(dir: string, folder: string, manifest: Record<string, unknown>): Promise<string> {
		const location = join(dir, folder);
		await fs.mkdir(location, { recursive: true });
		await fs.writeFile(join(location, 'package.json'), JSON.stringify(manifest));
		return location;
	}

	test('T3-SRV-1: the extension is found in the server\'s own folders by its manifest id, the newest version, built-ins marked', async () => {
		const user = join(root, 'extensions');
		const builtin = join(root, 'builtin');
		await install(user, 'pub.lint-1.0.0', { publisher: 'pub', name: 'lint', version: '1.0.0', main: './a.js' });
		const newest = await install(user, 'pub.lint-1.2.0', { publisher: 'Pub', name: 'Lint', version: '1.2.0', main: './a.js', extensionKind: ['ui', 'workspace'], contributes: { voltCapabilities: { optional: [{ id: 'net.connect@1', targets: ['registry.lint.test'] }, { id: 'secrets.use:x' }] } } });
		await install(user, 'misnamed-folder', { publisher: 'pub', name: 'other', version: '9.0.0', main: './a.js' });
		await install(builtin, 'git', { publisher: 'vscode', name: 'git', version: '1.0.0', main: './a.js' });
		const found = await findInstalledExtension([{ dir: user, builtin: false }, { dir: builtin, builtin: true }], 'PUB.lint');
		assert.strictEqual(found?.location, newest);
		assert.deepStrictEqual(found?.facts, { id: 'Pub.Lint', builtin: false, main: true, browser: false, extensionKind: ['ui', 'workspace'], declaredHosts: ['registry.lint.test'] });
		assert.strictEqual((await findInstalledExtension([{ dir: user, builtin: false }, { dir: builtin, builtin: true }], 'vscode.git'))?.facts.builtin, true);
		assert.strictEqual(await findInstalledExtension([{ dir: user, builtin: false }], 'pub.missing'), undefined);
		assert.deepStrictEqual(extensionFacts('a.b', { extensionKind: 'workspace' }, false).extensionKind, ['workspace']);
	});

	test('T3-SRV-2: the host runs the scanned folder with the server\'s storage and per-extension workspace storage and logs', async () => {
		const user = join(root, 'extensions');
		const location = await install(user, 'pub.lint-1.0.0', { publisher: 'pub', name: 'lint', version: '1.0.0', main: './a.js' });
		const requests: ISandboxedExtensionHostRequest[] = [];
		const hosts = new class extends SandboxedExtensionHosts {
			override async start(request: ISandboxedExtensionHostRequest): Promise<SandboxedExtensionHostResult> {
				requests.push(request);
				return { ok: false, code: 'launch', reason: 'test' };
			}
		}(undefined!, undefined!);
		const sandbox = new ServerExtensionSandbox(() => hosts, { bootstrapFork: '/app/out/bootstrap-fork.js', home: '/home/u' }, new NullLogService());
		const options: IVoltExtensionHostSandboxStartOptions = {
			hostEnv: { PATH: '/usr/bin' }, args: ['--type=extensionHost'],
			dirs: { extensions: user, builtinExtensions: join(root, 'none'), globalStorage: '/data/User/globalStorage', workspaceStorage: '/data/User/workspaceStorage', logs: '/data/logs/20261108' },
		};
		const params: IVoltSandboxedHostStartParams = { extensionId: 'pub.lint', transformURIs: true, workspaceTrusted: true, workspaceRoots: ['/ws', 'relative/not/taken'] };
		const result = await sandbox.start(params, options);
		assert.deepStrictEqual(result, { ok: false, code: 'launch', reason: 'test' }, 'a refusal is passed on, typed');
		const request = requests[0];
		assert.strictEqual(request.extension.location, location, 'the scanned folder');
		assert.strictEqual(request.storageDir, '/data/User/globalStorage/pub.lint');
		assert.deepStrictEqual(request.extraWritable, ['/data/User/workspaceStorage-sandboxed/pub.lint', '/data/logs/20261108/sandboxed-extensions/pub.lint']);
		assert.deepStrictEqual(request.workspaceRoots, ['/ws'], 'only absolute roots');
		assert.strictEqual(request.workspaceTrusted, true);
		assert.strictEqual(request.bootstrapFork, '/app/out/bootstrap-fork.js');
		assert.deepStrictEqual(await sandbox.start({ ...params, extensionId: 'pub.missing' }, options), { ok: false, code: 'unknown', reason: 'pub.missing is not installed where Volt\'s server runs extensions.' });
	});

	test('P6-LOCAL-1: on the desktop, an extension installed the normal way (the app\'s own folder, named with the ticket) runs sandboxed: the window\'s version, never one marked obsolete', async () => {
		const serverDir = join(root, 'server-extensions');
		const desktopDir = join(root, 'desktop-extensions');
		await fs.mkdir(serverDir, { recursive: true });
		await install(desktopDir, 'vsbx.probe-0.0.1', { publisher: 'vsbx', name: 'probe', version: '0.0.1', main: './extension.js' });
		const current = await install(desktopDir, 'vsbx.probe-0.0.2', { publisher: 'vsbx', name: 'probe', version: '0.0.2', main: './extension.js' });
		await install(desktopDir, 'vsbx.probe-0.0.3', { publisher: 'vsbx', name: 'probe', version: '0.0.3', main: './extension.js' });
		await fs.writeFile(join(desktopDir, '.obsolete'), JSON.stringify({ 'vsbx.probe-0.0.3': true }));
		const requests: ISandboxedExtensionHostRequest[] = [];
		const hosts = new class extends SandboxedExtensionHosts {
			override async start(request: ISandboxedExtensionHostRequest): Promise<SandboxedExtensionHostResult> {
				requests.push(request);
				return { ok: false, code: 'launch', reason: 'test' };
			}
		}(undefined!, undefined!);
		const options: IVoltExtensionHostSandboxStartOptions = {
			hostEnv: {}, args: [],
			dirs: { extensions: serverDir, builtinExtensions: join(root, 'none'), globalStorage: '/data/User/globalStorage', workspaceStorage: '/data/User/workspaceStorage', logs: '/data/logs/1' },
		};
		const params: IVoltSandboxedHostStartParams = { extensionId: 'vsbx.probe', transformURIs: false, workspaceTrusted: true, workspaceRoots: [] };
		// Without the desktop's folder: refused, as before (the live bug: never installed on the server).
		const serverOnly = new ServerExtensionSandbox(() => hosts, { bootstrapFork: '/b.js', home: '/home/u' }, new NullLogService());
		assert.strictEqual((await serverOnly.start(params, options) as { code: string }).code, 'unknown');
		const desktop = new ServerExtensionSandbox(() => hosts, { bootstrapFork: '/b.js', home: '/home/u', localExtensionDirs: () => [desktopDir] }, new NullLogService());
		await desktop.start({ ...params, version: '0.0.2' }, options);
		assert.strictEqual(requests[0].extension.location, current, 'the version the window runs');
		await desktop.start(params, options);
		assert.strictEqual(requests[1].extension.location, current, 'the newest that is not obsolete');
		assert.strictEqual(requests[1].extension.builtin, false);

		// The folder comes with a ticket only (the server's token); a relative or missing one is ignored.
		const workbench = store.add(new ServerWorkbench({
			userDataDir: root, serverDir: join(root, 'agentServer'), label: 'test', environmentId: () => 'e', authorize: () => undefined,
			resolveEnv: async () => ({}), git: undefined!, sendFile: async () => false,
		}, new TestConfigurationService(), new NullLogService()));
		await workbench.issueExtensionHostTicket('relative/dir');
		await workbench.issueExtensionHostTicket(join(root, 'missing'));
		await workbench.issueExtensionHostTicket(desktopDir);
		assert.deepStrictEqual((workbench as unknown as { localExtensionsDirs: Set<string> }).localExtensionsDirs, new Set([desktopDir]));
	});

	test('T3-SRV-3: a sandboxed start needs an extension id and a server that runs sandboxed hosts; URIs map only for a browser window', async () => {
		const env = { extensionsPath: '/x', builtinExtensionsPath: '/y', userRoamingDataHome: { fsPath: '/data/User' }, workspaceStorageHome: { fsPath: '/data/User/workspaceStorage' }, logsHome: { fsPath: '/data/logs' }, userDataPath: root, appRoot: root, isBuilt: false, args: { 'without-browser-env-var': true } } as unknown as IServerEnvironmentService;
		const accessor = { environmentService: env, logService: new NullLogService(), configurationService: new TestConfigurationService(), userEnvironment: async () => ({ PATH: '/usr/bin' }) };
		const base = { language: 'en' };
		assert.deepStrictEqual(await startSandboxedExtensionHost(undefined, { ...base, voltSandbox: { extensionId: '../evil', transformURIs: true, workspaceTrusted: false, workspaceRoots: [] } }, accessor), { ok: false, code: 'request', reason: 'The request names no extension.' });
		assert.strictEqual((await startSandboxedExtensionHost(undefined, { ...base, voltSandbox: { extensionId: 'pub.lint', transformURIs: true, workspaceTrusted: false, workspaceRoots: [] } }, accessor)).ok, false, 'no sandbox here: refused, never a plain fork');
		const seen: string[][] = [];
		const sandbox = { start: async (_p: IVoltSandboxedHostStartParams, o: IVoltExtensionHostSandboxStartOptions) => { seen.push([...o.args, o.dirs.globalStorage]); return { ok: false as const, code: 'x', reason: 'y' }; } };
		await startSandboxedExtensionHost(sandbox, { ...base, voltSandbox: { extensionId: 'pub.lint', transformURIs: true, workspaceTrusted: false, workspaceRoots: [] } }, accessor);
		await startSandboxedExtensionHost(sandbox, { ...base, voltSandbox: { extensionId: 'pub.lint', transformURIs: false, workspaceTrusted: false, workspaceRoots: [] } }, accessor);
		assert.deepStrictEqual(seen, [['--type=extensionHost', '--transformURIs', '--useHostProxy=false', '/data/User/globalStorage'], ['--type=extensionHost', '--useHostProxy=false', '/data/User/globalStorage']]);
	});

	test('P6-TICKET-1: a desktop extension host ticket opens one connection, from this computer, and only under /code', async () => {
		const workbench = store.add(new ServerWorkbench({
			userDataDir: root, serverDir: join(root, 'agentServer'), label: 'test', environmentId: () => 'e', authorize: () => undefined,
			resolveEnv: async () => ({}), git: undefined!, sendFile: async () => false,
		}, new TestConfigurationService(), new NullLogService()));
		const upgraded: string[] = [];
		// The VS Code server itself is not started here: only who gets through to it.
		Object.assign(workbench, { ensureServer: async () => ({ handleUpgrade: (req: http.IncomingMessage) => upgraded.push(req.url ?? '') }) });
		Object.defineProperty(workbench, 'available', { get: () => true });
		const socket = () => {
			const ended: string[] = [];
			return { ended, socket: { end: (text: string) => ended.push(text), destroy: () => undefined } as unknown as Socket };
		};
		const request = (url: string, remoteAddress = '127.0.0.1') => ({ url, headers: {}, socket: { remoteAddress } }) as unknown as http.IncomingMessage;
		const ticket = await workbench.issueExtensionHostTicket();
		assert.match(ticket.connectionToken, /^[0-9A-Za-z_-]{32,}$/);
		assert.strictEqual(ticket.globalStorageHome, join(root, 'agentServer', 'workbench', 'data', 'User', 'globalStorage'));
		const url = `/code/oss-dev?reconnectionToken=r&${VOLT_EXTHOST_TICKET_QUERY}=${encodeURIComponent(ticket.ticket)}`;

		const remote = socket();
		assert.ok(workbench.handleUpgrade(request(url, '192.168.1.5'), remote.socket));
		assert.match(remote.ended[0], /401/, 'not from another machine');
		const forged = socket();
		assert.ok(workbench.handleUpgrade(request(`/code/x?${VOLT_EXTHOST_TICKET_QUERY}=forged`), forged.socket));
		assert.match(forged.ended[0], /401/, 'a forged ticket');

		const next = await workbench.issueExtensionHostTicket();
		const nextUrl = `/code/oss-dev?${VOLT_EXTHOST_TICKET_QUERY}=${encodeURIComponent(next.ticket)}`;
		const first = socket();
		assert.ok(workbench.handleUpgrade(request(nextUrl), first.socket));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(first.ended, []);
		assert.deepStrictEqual(upgraded, [nextUrl], 'through to the workbench server');
		const again = socket();
		assert.ok(workbench.handleUpgrade(request(nextUrl), again.socket));
		assert.match(again.ended[0], /401/, 'single use');
		assert.strictEqual(upgraded.length, 1);
		// The ticket refused from another machine was spent too.
		const replay = socket();
		workbench.handleUpgrade(request(url), replay.socket);
		assert.match(replay.ended[0], /401/);
	});
});
