/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C6, against real sandboxes: a stdio MCP server Volt starts for a sandboxed chat runs as a
 * long-lived host under the supervisor, attested before it runs, with a policy narrower than the
 * chat's. Test ids: MCP-HOST-1 (tools/list and tools/call round-trip through the stdio service),
 * MCP-5-LIVE (the canary: a file in the home folder, outside the policy, cannot be read or
 * written; the workspace can), MCP-HOST-ROW (listed on the Security page with its chat, Stop
 * works), MCP-HOST-CLOSE (closing the chat stops its servers' trees), MCP-HOST-RESTART (F.11:
 * restarts with backoff, then broken), MCP-HOST-IDLE (idle, then stopped), MCP-QUOTA-FSIZE and
 * MCP-QUOTA-MEM (H.8: 100 MB per file from the OS, memory polled and killed), MCP-HOST-LEDGER
 * (the next start of Volt can reap it, F.11), MCP-HOST-FLAG (supervisor off: refused, nothing
 * runs) and MCP-HOST-REFUSE (a request that is not the sandboxed chat's own is refused).
 *
 * The test server is a POSIX shell script speaking MCP's newline-delimited JSON-RPC, so it runs the
 * same on macOS and in the Linux rig with nothing installed. A machine without a working backend
 * skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails. Linux: scripts/volt-sandbox-linux-test.sh.
 */

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltSandboxRequest } from '../../../voltSandbox/common/sandboxPolicy.js';
import { IMcpHostLaunch, VoltSandboxLauncher } from '../../../voltSandbox/node/sandboxLauncher.js';
import { processAlive } from '../../../voltSandbox/node/sandboxManager.js';
import { IHostExit, ISandboxedHost } from '../../../voltSandbox/node/supervisor.js';
import { realSandboxAvailable } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { IVoltSandboxedMcpRequest, IVoltSandboxEvent, VoltExecRefusedError } from '../../common/voltStdio.js';
import { VoltStdioService } from '../../node/voltStdioService.js';

const isLinux = process.platform === 'linux';
const posix = process.platform !== 'win32';

/** A minimal MCP server: one JSON-RPC message per line, the tools the tests need. */
const SERVER_SCRIPT = `
reply() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"; }
text() { reply "$1" "{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$2\\"}]}"; }
arg() { printf '%s\\n' "$line" | sed -n "s/.*\\"$1\\":\\"\\([^\\"]*\\)\\".*/\\1/p"; }
while IFS= read -r line; do
	id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":\\([0-9][0-9]*\\).*/\\1/p')
	[ -n "$id" ] || continue
	case "$line" in
	*'"method":"initialize"'*) reply "$id" '{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"sh-test","version":"1"}}' ;;
	*'"method":"tools/list"'*) reply "$id" '{"tools":[{"name":"read","inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}},{"name":"write"},{"name":"crash"},{"name":"grow"},{"name":"bigfile"},{"name":"child"},{"name":"env"}]}' ;;
	*'"name":"read"'*) if content=$(cat "$(arg path)" 2>/dev/null); then text "$id" "READ:$content"; else text "$id" "DENIED"; fi ;;
	*'"name":"write"'*) if (echo pwned > "$(arg path)") 2>/dev/null; then text "$id" "WROTE"; else text "$id" "DENIED"; fi ;;
	*'"name":"crash"'*) echo 'mcp test server: crash requested' >&2; exit 3 ;;
	*'"name":"grow"'*) (dd if=/dev/urandom bs=67108864 count=1 2>/dev/null | sleep 60) & text "$id" "GROWING" ;;
	*'"name":"bigfile"'*) dd if=/dev/zero of="$TMPDIR/big" bs=1048576 count=150 2>/dev/null; text "$id" "SIZE:$(wc -c < "$TMPDIR/big" | tr -d ' ')" ;;
	*'"name":"child"'*) sleep 31337 & text "$id" "CHILD" ;;
	*'"name":"env"'*) text "$id" "HOME:$HOME" ;;
	esac
done
`;

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

/** Command lines of this user's processes, as Volt sees them. */
async function commandLines(): Promise<string[]> {
	if (isLinux) {
		const out: string[] = [];
		for (const name of await fs.readdir('/proc')) {
			if (/^\d+$/.test(name)) {
				const cmdline = await fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
				if (cmdline) {
					out.push(cmdline.split('\0').join(' '));
				}
			}
		}
		return out;
	}
	const stdout = await new Promise<string>(resolve => execFile('/bin/ps', ['-axo', 'command='], { maxBuffer: 64 * 1024 * 1024 }, (_err, out) => resolve(out ?? '')));
	return stdout.split('\n');
}

/** JSON-RPC over a line stream: requests by id, replies matched by id. */
class Rpc {
	private next = 1;
	private buffer = '';
	private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

	constructor(private readonly send: (line: string) => unknown) { }

	push(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			const message = JSON.parse(line) as Record<string, unknown>;
			const resolve = this.waiting.get(message.id as number);
			if (resolve) {
				this.waiting.delete(message.id as number);
				resolve(message);
			}
		}
	}

	request(method: string, params: unknown, ms = 15_000): Promise<Record<string, unknown>> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`no reply to ${method}`));
			}, ms);
			this.waiting.set(id, message => {
				clearTimeout(timer);
				resolve(message);
			});
			void Promise.resolve(this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')).catch(err => {
				clearTimeout(timer);
				this.waiting.delete(id);
				reject(err);
			});
		});
	}

	async call(tool: string, args: Record<string, string> = {}): Promise<string> {
		// Compact JSON with `name` first, as MCP clients write it.
		const reply = await this.request('tools/call', { name: tool, arguments: args });
		const result = reply.result as { content: { text: string }[] };
		return result.content[0].text;
	}

	async initialize(): Promise<string[]> {
		const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Volt', version: '1' } });
		assert.strictEqual((init.result as { serverInfo: { name: string } }).serverInfo.name, 'sh-test');
		const list = await this.request('tools/list', {});
		return (list.result as { tools: { name: string }[] }).tools.map(tool => tool.name);
	}
}

suite('Volt MCP servers under the supervisor (C6, real sandboxes)', function () {

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
		await fs.writeFile(script, SERVER_SCRIPT);
		await fs.writeFile(join(ws, 'inside.txt'), 'workspace-token');
		stdio = new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData);
		// The user's shell environment, resolved once up front.
		await stdio.which('sh');
		const probe = new VoltSandboxLauncher(userData, new NullLogService());
		try {
			available = realSandboxAvailable(await probe.capabilities(), 'MCP host suite');
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
	async function startViaStdio(chatId: string, overrides: Partial<IVoltSandboxedMcpRequest> = {}) {
		const disposables = store.add(new DisposableStore());
		const id = await stdio.spawnSandboxedMcp(mcpRequest(chatId, overrides));
		const rpc = new Rpc(line => stdio.write(id, line));
		const exits: { code: number | null; stderr?: string }[] = [];
		const events: IVoltSandboxEvent[] = [];
		disposables.add(stdio.onData(e => e.id === id && rpc.push(e.data)));
		disposables.add(stdio.onExit(e => e.id === id && exits.push(e)));
		disposables.add(stdio.onSandboxEvent(e => e.id === id && events.push(e)));
		return { id, rpc, exits, events, disposables };
	}

	/** Through the launcher, for the timing knobs the stdio service keeps at H.8. */
	async function startViaLauncher(launcher: VoltSandboxLauncher, chatId: string, overrides: Partial<IMcpHostLaunch> = {}) {
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
		const rpc = new Rpc(line => {
			if (!host.write(line)) {
				throw new Error(`not writable (${host.state})`);
			}
		});
		store.add(host.onStdout(data => rpc.push(data)));
		return { host, rpc };
	}

	function newLauncher(): VoltSandboxLauncher {
		const launcher = new VoltSandboxLauncher(userData, new NullLogService());
		store.add({ dispose: () => launcher.dispose() });
		return launcher;
	}

	function exitOf(host: ISandboxedHost): Promise<IHostExit> {
		return new Promise(resolve => store.add(host.onExit(resolve)));
	}

	// --- round trip, canary, listing ----------------------------------------------------------

	test('MCP-HOST-1: tools/list and tools/call round-trip with a stdio server started for a sandboxed chat', async () => {
		const { id, rpc, disposables } = await startViaStdio('mcp-rt');
		try {
			assert.deepStrictEqual(await rpc.initialize(), ['read', 'write', 'crash', 'grow', 'bigfile', 'child', 'env']);
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
		const { id, rpc, disposables } = await startViaStdio('mcp-canary');
		try {
			await rpc.initialize();
			// Proof it runs and can do both where allowed.
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			assert.strictEqual(await rpc.call('write', { path: join(ws, 'written.txt') }), 'WROTE');
			assert.strictEqual(await rpc.call('read', { path: secret }), 'DENIED', 'the home folder is out of reach');
			assert.strictEqual(await rpc.call('write', { path: planted }), 'DENIED');
			assert.strictEqual(await fs.stat(planted).then(() => true, () => false), false, 'nothing was planted in the home folder');
			assert.strictEqual(await rpc.call('read', { path: join(userData, 'nothing') }), 'DENIED', 'Volt\'s user data is denied');
		} finally {
			await stdio.kill(id);
			disposables.dispose();
		}
	});

	test('MCP-HOST-ROW: listed on the Security page with its chat and server name and its attestation; Stop ends it', async () => {
		const { rpc, exits, disposables } = await startViaStdio('mcp-row');
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
		const a = await startViaStdio('mcp-close');
		const other = await startViaStdio('mcp-other');
		try {
			await a.rpc.initialize();
			await other.rpc.initialize();
			assert.strictEqual(await a.rpc.call('child'), 'CHILD');
			assert.ok(await waitFor(async () => (await commandLines()).some(line => line.includes('sleep 31337')), 5_000), 'the server\'s child runs');
			assert.strictEqual(await stdio.stopSandboxedHosts('mcp-close'), 1);
			assert.ok(await waitFor(() => a.exits.length === 1, 10_000), 'the server ended');
			assert.ok(await waitFor(async () => !(await commandLines()).some(line => line.includes('sleep 31337')), 5_000), 'its child went with it');
			assert.strictEqual(other.exits.length, 0, 'another chat\'s server runs on');
			assert.strictEqual(await other.rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
		} finally {
			await stdio.kill(other.id);
			a.disposables.dispose();
			other.disposables.dispose();
		}
	});

	// --- F.11 restarts, idle, quotas ------------------------------------------------------------

	test('MCP-HOST-RESTART: a crash restarts it with backoff (the caller is told, and initializes again); the third crash in a minute is final', async () => {
		const { rpc, exits, events, disposables } = await startViaStdio('mcp-restart');
		try {
			await rpc.initialize();
			for (let crash = 1; crash <= 2; crash++) {
				await rpc.request('tools/call', { name: 'crash', arguments: {} }, 2_000).catch(() => undefined);
				assert.ok(await waitFor(() => events.filter(e => e.host === 'restarted').length === crash, 15_000), `restart ${crash}: ${JSON.stringify(events)}`);
				assert.strictEqual(events.filter(e => e.host === 'restarting').length, crash);
				assert.strictEqual(exits.length, 0, 'not ended while within the budget');
				assert.deepStrictEqual(await rpc.initialize(), ['read', 'write', 'crash', 'grow', 'bigfile', 'child', 'env'], 'a new instance, initialized again');
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

	test('MCP-HOST-IDLE: no traffic for the idle budget makes it idle, then stops it', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await startViaLauncher(launcher, 'mcp-idle', { idle: { afterMs: 400, stopAfterMs: 1_500 } });
		const exit = exitOf(host);
		await rpc.initialize();
		assert.ok(await waitFor(() => host.state === 'idle', 5_000), `state ${host.state}`);
		// Traffic brings it back.
		await rpc.call('env');
		assert.strictEqual(host.state, 'running');
		assert.strictEqual((await exit).reason, 'idle');
		assert.strictEqual(host.state, 'stopped');
	});

	test('MCP-QUOTA-FSIZE: a file over 100 MB cannot be written (the OS limit, H.8)', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await startViaLauncher(launcher, 'mcp-fsize');
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
		const { host, rpc } = await startViaLauncher(launcher, 'mcp-mem', { memoryMB: 32 });
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

	test('MCP-HOST-LEDGER: a running server has a ledger the next start of Volt reaps it by; a live owner\'s is left alone', async () => {
		const launcher = newLauncher();
		const { host, rpc } = await startViaLauncher(launcher, 'mcp-ledger');
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
			// Another Volt starting now leaves a live owner's server alone.
			const next = newLauncher();
			await next.supervisor.recover();
			assert.strictEqual(host.state, 'running');
			assert.strictEqual(await rpc.call('read', { path: join(ws, 'inside.txt') }), 'READ:workspace-token');
			if (isLinux) {
				// Linux reads every process's tag from /proc: as if this Volt had crashed, the next start reaps the tree.
				const gone = spawn('/bin/true');
				await new Promise(resolve => gone.once('exit', resolve));
				const dead = gone.pid!;
				await fs.writeFile(ledgerFile, JSON.stringify({ ...ledger, ownerPid: dead }));
				const root = ledger.pid;
				assert.ok(await next.supervisor.recover() >= 1, 'reaped');
				assert.ok(await waitFor(() => !processAlive(root), 5_000), 'the crashed owner\'s server is gone');
			}
		} finally {
			await host.terminate();
		}
	});

	// --- refusals and the flag ------------------------------------------------------------------

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
