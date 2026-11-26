/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C6 through the stdio service, against real sandboxes: a stdio MCP server Volt starts for a
 * sandboxed chat (`spawnSandboxedMcp`) is written, read and killed like a spawn, while it runs as a
 * supervisor host. Test ids: MCP-HOST-1 (tools/list and tools/call round-trip), MCP-5-LIVE (the
 * canary through the service), MCP-HOST-ROW (listed on the Security page with its chat and server
 * name, attested; Stop works), MCP-HOST-CLOSE (closing the chat stops its servers' trees, and only
 * its own), MCP-HOST-RESTART (F.11: the caller is told of each restart and initializes again; the
 * third crash in a minute is final, with its stderr), MCP-HOST-FLAG (supervisor off: refused,
 * typed, nothing runs) and MCP-HOST-REFUSE (a request that is not the sandboxed chat's own).
 * Idle stop, quotas and crash recovery are on the launcher: sandboxMcpHost.test.ts, which the
 * Linux rig runs.
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails.
 */

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltSandboxRequest } from '../../../voltSandbox/common/sandboxPolicy.js';
import { VoltSandboxLauncher } from '../../../voltSandbox/node/sandboxLauncher.js';
import { MCP_TEST_SERVER_SCRIPT, MCP_TEST_SERVER_TOOLS, McpTestClient } from '../../../voltSandbox/test/node/mcpTestServer.js';
import { realSandboxAvailable } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { IVoltSandboxedMcpRequest, IVoltSandboxEvent, VoltExecRefusedError } from '../../common/voltStdio.js';
import { VoltStdioService } from '../../node/voltStdioService.js';

const isLinux = process.platform === 'linux';
const posix = process.platform !== 'win32';

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

/** Whether a process whose command line holds `needle` runs, as Volt sees them. */
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

suite('Volt MCP servers through the stdio service (C6, real sandboxes)', function () {

	this.timeout(120_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let ws: string;
	let userData: string;
	let script: string;
	let stdio: VoltStdioService;
	let available = false;
	let counter = 0;
	const markers: string[] = [];

	suiteSetup(async function () {
		if (!posix) {
			return;
		}
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-mcp-host-')));
		ws = join(root, 'ws');
		userData = join(root, 'user-data');
		await fs.mkdir(ws, { recursive: true });
		await fs.mkdir(userData, { recursive: true });
		script = join(ws, 'mcp-server.sh');
		await fs.writeFile(script, MCP_TEST_SERVER_SCRIPT);
		await fs.writeFile(join(ws, 'inside.txt'), 'workspace-token');
		stdio = new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData);
		// The user's shell environment, resolved once up front.
		await stdio.which('sh');
		const probe = new VoltSandboxLauncher(userData, new NullLogService());
		try {
			available = realSandboxAvailable(await probe.capabilities(), 'MCP stdio suite');
		} finally {
			probe.dispose();
		}
	});

	suiteTeardown(async () => {
		stdio?.dispose();
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
		const path = join(homedir(), `.volt-mcp-host-${process.pid}-${name}-${counter++}`);
		markers.push(path);
		if (content !== undefined) {
			await fs.writeFile(path, content);
		}
		return path;
	}

	function chatSandbox(): IVoltSandboxRequest {
		return { level: 'workspace-write', network: false, providerId: '', workspaceRoots: [ws] };
	}

	function mcpRequest(chatId: string, overrides: Partial<IVoltSandboxedMcpRequest> = {}): IVoltSandboxedMcpRequest {
		return {
			chatId,
			server: 'shtest',
			digest: 'ab'.repeat(32),
			command: '/bin/sh',
			args: [script],
			cwd: ws,
			sandbox: chatSandbox(),
			context: { principal: `chat:${chatId}`, reason: 'mcp', sandboxed: true },
			...overrides,
		};
	}

	/** Starts a server through the stdio service and speaks JSON-RPC to it. */
	async function start(chatId: string, overrides: Partial<IVoltSandboxedMcpRequest> = {}) {
		const disposables = store.add(new DisposableStore());
		const id = await stdio.spawnSandboxedMcp(mcpRequest(chatId, overrides));
		const rpc = new McpTestClient(line => stdio.write(id, line));
		const exits: { code: number | null; stderr?: string }[] = [];
		const events: IVoltSandboxEvent[] = [];
		disposables.add(stdio.onData(e => e.id === id && rpc.push(e.data)));
		disposables.add(stdio.onExit(e => e.id === id && exits.push(e)));
		disposables.add(stdio.onSandboxEvent(e => e.id === id && events.push(e)));
		return { id, rpc, exits, events, disposables };
	}

	test('MCP-HOST-1: tools/list and tools/call round-trip with a stdio server started for a sandboxed chat', async () => {
		const { id, rpc, disposables } = await start('mcp-rt');
		try {
			assert.deepStrictEqual(await rpc.initialize(), MCP_TEST_SERVER_TOOLS);
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token', 'it runs, and reads the workspace');
			const home = await rpc.call('env');
			assert.match(home, /^HOME:.*mcp-[0-9a-f]{16}\/home$/, `its HOME is its own storage, not the user's: ${home}`);
		} finally {
			await stdio.kill(id);
			disposables.dispose();
		}
	});

	test('MCP-5-LIVE: the canary: the server cannot read or write the home folder outside its policy', async () => {
		const secret = await homeFile('secret', 'home-secret-token');
		const planted = await homeFile('planted');
		const { id, rpc, disposables } = await start('mcp-canary');
		try {
			await rpc.initialize();
			// Proof it runs and can do both where allowed.
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			assert.strictEqual(await rpc.call('write', { path: join(ws, 'written.txt') }), 'WROTE');
			assert.strictEqual(await rpc.call('read', { path: secret }), 'DENIED', 'the home folder is out of reach');
			assert.strictEqual(await rpc.call('write', { path: planted }), 'DENIED');
			assert.strictEqual(await fs.stat(planted).then(() => true, () => false), false, 'nothing was planted in the home folder');
		} finally {
			await stdio.kill(id);
			disposables.dispose();
		}
	});

	test('MCP-HOST-ROW: listed on the Security page with its chat and server name and its attestation; Stop ends it', async () => {
		const { rpc, exits, disposables } = await start('mcp-row');
		try {
			await rpc.initialize();
			const row = (await stdio.sandboxWorkloads()).find(r => r.onBehalfOf?.subject === 'chat:mcp-row');
			assert.ok(row, 'listed');
			assert.strictEqual(row.label, 'MCP shtest');
			assert.strictEqual(row.lifetime, 'host');
			assert.strictEqual(row.subject, `mcp:${'ab'.repeat(32)}`);
			assert.strictEqual(row.state, 'running');
			assert.ok(row.attestation, 'attested before it ran');
			assert.strictEqual(row.policy.network, 'none', 'no approved hosts: no network');
			assert.strictEqual(row.policy.name, 'mcp shtest');
			assert.ok(await stdio.stopSandboxWorkload(row.id), 'Stop');
			assert.ok(await waitFor(() => exits.length === 1, 10_000), 'the caller sees it end');
			assert.ok(!(await stdio.sandboxWorkloads()).some(r => r.id === row.id), 'and it leaves the list');
		} finally {
			disposables.dispose();
		}
	});

	test('MCP-HOST-CLOSE: closing the chat stops its servers\' whole trees, and only its own', async () => {
		const a = await start('mcp-close');
		const other = await start('mcp-other');
		try {
			await a.rpc.initialize();
			await other.rpc.initialize();
			assert.strictEqual(await a.rpc.call('child'), 'CHILD');
			assert.ok(await waitFor(() => running('sleep 31337'), 5_000), 'the server\'s child runs');
			assert.strictEqual(await stdio.stopSandboxedHosts('mcp-close'), 1);
			assert.ok(await waitFor(() => a.exits.length === 1, 10_000), 'the server ended');
			assert.ok(await waitFor(async () => !await running('sleep 31337'), 5_000), 'its child went with it');
			assert.strictEqual(other.exits.length, 0, 'another chat\'s server runs on');
			assert.strictEqual(await other.rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
		} finally {
			await stdio.kill(other.id);
			a.disposables.dispose();
			other.disposables.dispose();
		}
	});

	test('MCP-HOST-RESTART: a crash restarts it with backoff (the caller is told, and initializes again); the third crash in a minute is final', async () => {
		const { rpc, exits, events, disposables } = await start('mcp-restart');
		try {
			await rpc.initialize();
			for (let crash = 1; crash <= 2; crash++) {
				await rpc.request('tools/call', { name: 'crash', arguments: {} }, 2_000).catch(() => undefined);
				assert.ok(await waitFor(() => events.filter(e => e.host === 'restarted').length === crash, 15_000), `restart ${crash}: ${JSON.stringify(events)}`);
				assert.strictEqual(events.filter(e => e.host === 'restarting').length, crash);
				assert.strictEqual(exits.length, 0, 'not ended while within the budget');
				assert.deepStrictEqual(await rpc.initialize(), MCP_TEST_SERVER_TOOLS, 'a new instance, initialized again');
			}
			await rpc.request('tools/call', { name: 'crash', arguments: {} }, 2_000).catch(() => undefined);
			assert.ok(await waitFor(() => exits.length === 1, 15_000), 'broken after the third crash');
			assert.match(exits[0].stderr ?? '', /crash requested/, 'its stderr is kept');
			const row = (await stdio.sandboxWorkloads()).find(r => r.onBehalfOf?.subject === 'chat:mcp-restart');
			assert.strictEqual(row?.state, 'broken', 'a broken server stays listed until dismissed');
			assert.ok(await stdio.stopSandboxWorkload(row.id));
		} finally {
			disposables.dispose();
		}
	});

	test('MCP-HOST-FLAG: with the supervisor turned off, a sandboxed chat\'s server is refused (typed) and nothing runs', async () => {
		const marker = await homeFile('flag');
		const off = new VoltStdioService(new NullLogService(), new TestConfigurationService({ volt: { sandbox: { supervisor: { enabled: false } } } }), userData);
		try {
			await assert.rejects(off.spawnSandboxedMcp(mcpRequest('mcp-flag', { command: '/usr/bin/touch', args: [marker] })), (err: Error) => err instanceof VoltExecRefusedError && err.refusal.kind === 'sandbox' && err.refusal.step === 'disabled' && /\(disabled\)/.test(err.message));
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.strictEqual(await fs.stat(marker).then(() => true, () => false), false, 'never started another way');
		} finally {
			off.dispose();
		}
	});

	test('MCP-HOST-REFUSE: a request that is not the sandboxed chat\'s own is refused before anything runs', async () => {
		const marker = await homeFile('refuse');
		const touch = { command: '/usr/bin/touch', args: [marker] };
		await assert.rejects(stdio.spawnSandboxedMcp(mcpRequest('mcp-ref', { ...touch, context: { principal: 'chat:someone-else', reason: 'mcp', sandboxed: true } })), (err: Error) => err instanceof VoltExecRefusedError && err.refusal.kind === 'no-context');
		await assert.rejects(stdio.spawnSandboxedMcp(mcpRequest('mcp-ref', { ...touch, context: { principal: 'chat:mcp-ref', reason: 'mcp', sandboxed: false } })), (err: Error) => err instanceof VoltExecRefusedError && err.refusal.kind === 'no-sandbox');
		await assert.rejects(stdio.spawnSandboxedMcp(mcpRequest('mcp-ref', { ...touch, digest: 'not-a-digest' })), (err: Error) => err instanceof VoltExecRefusedError && err.refusal.step === 'launch');
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.strictEqual(await fs.stat(marker).then(() => true, () => false), false);
	});
});
