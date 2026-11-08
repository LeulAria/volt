/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C6 on the launcher, against real sandboxes (macOS, and Linux in the rig): a stdio MCP server
 * for a sandboxed chat runs as a supervisor host with a policy narrowed from the chat's, attested
 * before it runs. Test ids: MCP-HOST-1-LNCH (tools/list and tools/call round-trip), MCP-5-LIVE
 * (the canary: the home folder and Volt's user data are out of reach; the workspace is not),
 * MCP-HOST-REVOKE (revoking the chat's anchor principal stops its servers' whole trees, and only
 * its own), MCP-HOST-IDLE, MCP-QUOTA-FSIZE and MCP-QUOTA-MEM (H.8), MCP-HOST-LEDGER (F.11: the next
 * start of Volt leaves a live owner's server alone and reaps a dead owner's; reaping is checked on
 * Linux, where every process's tag is readable) and MCP-HOST-POLICY (an Authority refusal is typed
 * `policy`; nothing runs).
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails.
 * Linux: scripts/volt-sandbox-linux-test.sh suite.
 */

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { processAlive } from '../../node/sandboxManager.js';
import { IMcpHostLaunch, VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { IHostExit, ISandboxedHost } from '../../node/supervisor.js';
import { MCP_TEST_SERVER_SCRIPT, MCP_TEST_SERVER_TOOLS, McpTestClient } from './mcpTestServer.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isLinux = process.platform === 'linux';
const posix = process.platform !== 'win32';
const quiet = { info: () => undefined, warn: () => undefined };

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return check();
}

suite('Volt MCP hosts on the launcher (C6, real sandboxes)', function () {

	this.timeout(120_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let ws: string;
	let userData: string;
	let script: string;
	let available = false;
	let counter = 0;
	const markers: string[] = [];

	suiteSetup(async function () {
		if (!posix) {
			return;
		}
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-mcp-lnch-')));
		ws = join(root, 'ws');
		userData = join(root, 'user-data');
		await fs.mkdir(ws, { recursive: true });
		await fs.mkdir(userData, { recursive: true });
		script = join(ws, 'mcp-server.sh');
		await fs.writeFile(script, MCP_TEST_SERVER_SCRIPT);
		await fs.writeFile(join(ws, 'inside.txt'), 'workspace-token');
		await fs.writeFile(join(userData, 'volt-secret.txt'), 'user-data-token');
		const probe = new VoltSandboxLauncher(userData, quiet);
		try {
			available = realSandboxAvailable(await probe.capabilities(), 'MCP launcher suite');
		} finally {
			probe.dispose();
		}
	});

	suiteTeardown(async () => {
		for (const marker of markers) {
			await fs.rm(marker, { force: true });
		}
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!posix || !available) {
			this.skip();
		}
	});

	/** A file in the real home folder: outside every MCP policy. Removed after the suite. */
	async function homeFile(name: string, content?: string): Promise<string> {
		const path = join(homedir(), `.volt-mcp-lnch-${process.pid}-${name}-${counter++}`);
		markers.push(path);
		if (content !== undefined) {
			await fs.writeFile(path, content);
		}
		return path;
	}

	function chatSandbox(overrides: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
		return { level: 'workspace-write', network: false, providerId: '', workspaceRoots: [ws], ...overrides };
	}

	function newLauncher(): VoltSandboxLauncher {
		const launcher = new VoltSandboxLauncher(userData, quiet);
		store.add({ dispose: () => launcher.dispose() });
		return launcher;
	}

	async function start(launcher: VoltSandboxLauncher, chatId: string, overrides: Partial<IMcpHostLaunch> = {}): Promise<{ host: ISandboxedHost; rpc: McpTestClient }> {
		const result = await launcher.startMcpHost({
			chatId,
			server: 'shtest',
			digest: 'cd'.repeat(32),
			command: '/bin/sh',
			args: [script],
			cwd: ws,
			hostEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir() },
			sandbox: chatSandbox(),
			...overrides,
		});
		assert.ok(result.ok, result.ok ? '' : `${result.refused}: ${result.reason}`);
		const host = result.host;
		const rpc = new McpTestClient(line => {
			if (!host.write(line)) {
				throw new Error(`not writable (${host.state})`);
			}
		});
		store.add(host.onStdout(data => rpc.push(data)));
		return { host, rpc };
	}

	function exitOf(host: ISandboxedHost): Promise<IHostExit> {
		return new Promise(resolve => store.add(host.onExit(resolve)));
	}

	/** Processes whose command line holds `needle`, as Volt sees them. */
	async function running(needle: string): Promise<boolean> {
		if (isLinux) {
			for (const name of await fs.readdir('/proc')) {
				if (/^\d+$/.test(name) && (await fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).split('\0').join(' ').includes(needle)) {
					return true;
				}
			}
			return false;
		}
		const stdout = await new Promise<string>(resolve => execFile('/bin/ps', ['-axo', 'command='], { maxBuffer: 64 * 1024 * 1024 }, (_err, out) => resolve(out ?? '')));
		return stdout.includes(needle);
	}

	test('MCP-HOST-1-LNCH: tools/list and tools/call round-trip; attested before it ran; its HOME is its own', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-rt');
		try {
			assert.ok(host.attestation, 'attested');
			assert.strictEqual(host.principal.subject, `mcp:${'cd'.repeat(32)}`);
			assert.strictEqual(host.principal.kind, 'mcp');
			assert.deepStrictEqual(host.onBehalfOf, { subject: 'chat:lnch-rt' });
			assert.deepStrictEqual(await rpc.initialize(), MCP_TEST_SERVER_TOOLS);
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			assert.match(await rpc.call('env'), /^HOME:.*\/mcp-[0-9a-f]{16}\/home$/);
		} finally {
			await host.terminate();
		}
	});

	test('MCP-5-LIVE: the canary: the home folder and Volt\'s user data are out of reach; the workspace is not', async () => {
		const secret = await homeFile('secret', 'home-secret-token');
		const planted = await homeFile('planted');
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-canary');
		try {
			await rpc.initialize();
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token', 'it runs and reads where allowed');
			assert.strictEqual(await rpc.call('write', { path: join(ws, 'written.txt') }), 'WROTE');
			assert.strictEqual(await rpc.call('read', { path: secret }), 'DENIED');
			assert.strictEqual(await rpc.call('write', { path: planted }), 'DENIED');
			assert.strictEqual(await rpc.call('read', { path: join(userData, 'volt-secret.txt') }), 'DENIED');
			assert.strictEqual(await fs.stat(planted).then(() => true, () => false), false);
		} finally {
			await host.terminate();
		}
		// A read-only chat's server writes nothing of the user's either.
		const readOnly = await start(launcher, 'lnch-canary-ro', { sandbox: chatSandbox({ level: 'read-only' }) });
		try {
			await readOnly.rpc.initialize();
			assert.strictEqual(await readOnly.rpc.call('write', { path: join(ws, 'ro.txt') }), 'DENIED');
			assert.strictEqual(await readOnly.rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
		} finally {
			await readOnly.host.terminate();
		}
	});

	test('MCP-HOST-REVOKE: revoking the chat\'s anchor stops its servers\' whole trees, and only its own', async () => {
		const launcher = newLauncher();
		const a = await start(launcher, 'lnch-close');
		const other = await start(launcher, 'lnch-other');
		try {
			await a.rpc.initialize();
			await other.rpc.initialize();
			assert.strictEqual(await a.rpc.call('child'), 'CHILD');
			assert.ok(await waitFor(() => running('sleep 31337'), 5_000), 'the server\'s child runs');
			const exit = exitOf(a.host);
			assert.strictEqual(await launcher.stopChatHosts('lnch-close'), 1);
			assert.strictEqual((await exit).reason, 'stopped');
			assert.ok(await waitFor(async () => !await running('sleep 31337'), 5_000), 'its child went with it');
			assert.strictEqual(a.host.state, 'stopped');
			assert.strictEqual(other.host.state, 'running', 'another chat\'s server runs on');
			assert.strictEqual(await other.rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			assert.strictEqual(launcher.livePrincipals, 2, 'only the other chat\'s anchor and server are left');
		} finally {
			await other.host.terminate();
		}
		assert.strictEqual(launcher.livePrincipals, 1, 'a server\'s principal ends with it; the chat\'s anchor stays until the chat closes');
		await launcher.stopChatHosts('lnch-other');
		assert.strictEqual(launcher.livePrincipals, 0);
	});

	test('MCP-HOST-IDLE: no traffic for the idle budget makes it idle, then stops it', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-idle', { idle: { afterMs: 400, stopAfterMs: 1_500 } });
		const exit = exitOf(host);
		await rpc.initialize();
		assert.ok(await waitFor(() => host.state === 'idle', 5_000), `state ${host.state}`);
		await rpc.call('env');
		assert.strictEqual(host.state, 'running', 'traffic brings it back');
		assert.strictEqual((await exit).reason, 'idle');
		assert.strictEqual(host.state, 'stopped');
	});

	test('MCP-QUOTA-FSIZE: a file over 100 MB cannot be written (the OS limit, H.8)', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-fsize');
		try {
			await rpc.initialize();
			const size = Number((await rpc.call('bigfile')).replace('SIZE:', ''));
			assert.ok(size > 0, 'it wrote');
			assert.ok(size <= 100 * 1024 * 1024, `stopped at 100 MB: ${size}`);
		} finally {
			await host.terminate();
		}
	});

	test('MCP-QUOTA-MEM: a tree over its polled memory limit is killed (resource) and counts as a crash', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-mem', { memoryMB: 32 });
		const exit = exitOf(host);
		try {
			await rpc.initialize();
			assert.strictEqual(await rpc.call('grow'), 'GROWING');
			const ended = await exit;
			assert.strictEqual(ended.reason, 'resource');
			assert.strictEqual(ended.restarting, true, 'within the restart budget');
		} finally {
			await host.terminate();
		}
	});

	test('MCP-HOST-LEDGER: the next start of Volt leaves a live owner\'s server alone and reaps a dead owner\'s', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await start(launcher, 'lnch-ledger');
		try {
			await rpc.initialize();
			const runRoot = await launcher.supervisor.manager.runRootPath();
			let ledgerFile: string | undefined;
			for (const name of await fs.readdir(runRoot)) {
				const text = await fs.readFile(join(runRoot, name, 'ledger.json'), 'utf8').catch(() => undefined);
				if (text && (JSON.parse(text) as { principalId: string }).principalId === host.principal.id) {
					ledgerFile = join(runRoot, name, 'ledger.json');
				}
			}
			assert.ok(ledgerFile, 'the server has a ledger');
			const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as { ownerPid: number; label: string; subject: string; pid: number };
			assert.strictEqual(ledger.ownerPid, process.pid);
			assert.strictEqual(ledger.label, 'MCP shtest');
			assert.strictEqual(ledger.subject, `mcp:${'cd'.repeat(32)}`);
			const next = newLauncher();
			assert.strictEqual(await next.supervisor.recover(), 0);
			assert.strictEqual(host.state, 'running', 'a live owner\'s server is left alone');
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			if (isLinux) {
				// As if this Volt had crashed: the next start reaps the server's tree by its tag.
				const gone = spawn('/bin/true');
				await new Promise(resolve => gone.once('exit', resolve));
				await fs.writeFile(ledgerFile, JSON.stringify({ ...ledger, ownerPid: gone.pid }));
				assert.ok(await next.supervisor.recover() >= 1, 'reaped');
				assert.ok(await waitFor(() => !processAlive(ledger.pid), 5_000), 'the dead owner\'s server is gone');
			}
		} finally {
			await host.terminate();
		}
	});

	test('MCP-HOST-POLICY: a chat the Authority will not launch gets no server: typed `policy`, nothing runs', async () => {
		const marker = await homeFile('policy');
		const launcher = newLauncher();
		// A workspace inside a credential folder: the Authority refuses the chat's launch.
		const result = await launcher.startMcpHost({
			chatId: 'lnch-policy',
			server: 'shtest',
			digest: 'cd'.repeat(32),
			command: '/usr/bin/touch',
			args: [marker],
			hostEnv: { PATH: '/usr/bin:/bin', HOME: homedir() },
			sandbox: chatSandbox({ workspaceRoots: [join(homedir(), '.ssh')] }),
		});
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok ? '' : result.refused, 'policy', result.ok ? '' : result.reason);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.strictEqual(await fs.stat(marker).then(() => true, () => false), false);
		assert.strictEqual(launcher.livePrincipals, 0, 'no principal outlives a refusal');
	});
});
