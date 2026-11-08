/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C5: the supervisor for long-lived sandboxed hosts (spec F.4-F.11), against real sandboxes. Test
 * ids are the spec's families: ATTEST-HOST (a test host attests), IPC-CHAN-1/2 (the
 * `NODE_CHANNEL_FD` channel round-trips and is unreachable from another sandbox), RES-6 (a crash
 * loop stops at the restart budget), RES-1-POLL (a memory bomb over a polled limit is killed),
 * LIFE-IDLE-1, LIFE-BUDGET-1, TREE-1 (quitting kills every host's tree), LIFE-RECOVER-1 (the next
 * start reaps what a crash left), FAULT-HOST-1, LIFE-FLAG-1 (the feature flag) and PERF-HOST-1
 * (cold host start against the budget in 04-performance.md).
 *
 * Like the other real-sandbox suites: a machine without a working backend skips loudly, and with
 * `VOLT_SANDBOX_REQUIRED` set it fails instead. Linux: run in the rig (scripts/volt-sandbox-linux-test.sh suite).
 */

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chatSubject, IPrincipal } from '../../common/principals.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { ISandboxResourceSample } from '../../common/sandboxWorkloads.js';
import { SandboxFault } from '../../node/sandboxBackends.js';
import { processAlive, SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { HostStartResult, IHostExit, IHostStartRequest, ISandboxedHost, ISandboxSupervisorOptions, killTagged, parseCpuTime, SandboxSupervisor } from '../../node/supervisor.js';
import { PrincipalRegistry } from '../../node/principalRegistry.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isLinux = process.platform === 'linux';

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

/**
 * `root` and every process below it, as pids seen from outside the sandbox. A pid the host reports
 * about itself is its own pid namespace's on Linux, so the tests never use those from outside.
 */
async function treeOf(root: number): Promise<number[]> {
	const parents = new Map<number, number>();
	if (isLinux) {
		for (const name of await fs.readdir('/proc')) {
			const stat = /^\d+$/.test(name) ? await fs.readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined) : undefined;
			if (stat) {
				parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
			}
		}
	} else {
		const stdout = await new Promise<string>(resolve => execFile('/bin/ps', ['-axo', 'pid=,ppid='], (_err, out) => resolve(out ?? '')));
		for (const line of stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)/.exec(line);
			if (match) {
				parents.set(Number(match[1]), Number(match[2]));
			}
		}
	}
	const tree = [root];
	for (let i = 0; i < tree.length; i++) {
		for (const [pid, ppid] of parents) {
			if (ppid === tree[i] && !tree.includes(pid)) {
				tree.push(pid);
			}
		}
	}
	return tree;
}

function principal(id = 'host'): IPrincipal {
	return { id: `p-${id}-${Math.random().toString(36).slice(2)}`, subject: chatSubject(`supervisor-${id}`), kind: 't2', executionHost: 'test', launchPolicyHash: '', createdAt: Date.now() };
}

/** The test host: answers pings, reports its channel fd and pid, starts a grandchild on request, can crash or grow. */
const HOST_SCRIPT = `
const { spawn } = require('child_process');
const fd = process.env.NODE_CHANNEL_FD;
process.on('message', m => {
	if (m && m.op === 'ping') { process.send({ op: 'pong', n: m.n, pid: process.pid, fd: process.channel && process.channel.fd }); }
	if (m && m.op === 'child') { const c = spawn('/bin/sleep', ['300'], { stdio: 'ignore' }); process.send({ op: 'child', pid: c.pid }); }
	if (m && m.op === 'grow') { globalThis.keep = []; for (let i = 0; i < 40; i++) { globalThis.keep.push(Buffer.alloc(8 * 1024 * 1024, 1)); } process.send({ op: 'grown' }); }
});
if (process.argv[2] === 'crash') { process.stderr.write('host failed: boom\\n'); setTimeout(() => process.exit(3), 50); }
setInterval(() => {}, 1 << 30);
`;

suite('Volt sandbox supervisor (C5, real processes)', function () {

	this.timeout(120_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let runRoot: string;
	let script: string;
	let host: ISandboxHostFacts;
	let available = false;
	const managers: SandboxManager[] = [];

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-sup-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		runRoot = join(home, '.volt', 'sandbox', 'runs');
		for (const dir of [home, ws, runRoot]) {
			await fs.mkdir(dir, { recursive: true });
		}
		script = join(ws, 'host.js');
		await fs.writeFile(script, HOST_SCRIPT);
		host = { ...await sandboxHostFacts(), home };
		const probe = new SandboxManager(undefined, { runRoot, host });
		managers.push(probe);
		available = realSandboxAvailable(await probe.capabilities(), 'supervisor suite');
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

	function supervisorWith(options: ISandboxSupervisorOptions = {}, fault?: SandboxFault): SandboxSupervisor {
		const manager = new SandboxManager(undefined, { runRoot, host, ...(fault ? { fault } : {}) });
		managers.push(manager);
		const supervisor = new SandboxSupervisor(manager, undefined, { backoffMs: 50, sampleMs: 100, ...options });
		store.add({ dispose: () => supervisor.dispose() });
		return supervisor;
	}

	function nodeHost(overrides: Partial<IHostStartRequest> = {}, args: readonly string[] = []): IHostStartRequest {
		return {
			principal: principal(),
			label: 'test host',
			command: { fork: script, args },
			policy: builtinProfile('workspace'),
			context: { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin', HOME: home } },
			...overrides,
		};
	}

	async function started(result: HostStartResult): Promise<ISandboxedHost> {
		assert.ok(result.ok, result.ok ? '' : `${result.refused}: ${result.reason}`);
		return result.host;
	}

	function request(h: ISandboxedHost, message: { op: string; n?: number }, reply: string, ms = 10_000): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { listener.dispose(); reject(new Error(`no ${reply} from the host: ${h.stderrTail()}`)); }, ms);
			const listener = h.onMessage(m => {
				const value = m as Record<string, unknown>;
				if (value.op === reply) {
					clearTimeout(timer);
					listener.dispose();
					resolve(value);
				}
			});
			assert.ok(h.send(message), 'the channel is open');
		});
	}

	// --- ATTEST / IPC ---------------------------------------------------------------------------

	test('ATTEST-HOST: a Node host starts only on external evidence and is listed with its attestation', async () => {
		const supervisor = supervisorWith();
		const h = await started(await supervisor.start(nodeHost()));
		try {
			assert.strictEqual(h.state, 'running');
			const attestation = h.attestation;
			assert.ok(attestation, 'the host carries its attestation');
			assert.match(attestation.launchPolicyHash, /^[0-9a-f]{64}$/);
			assert.deepStrictEqual(attestation.canary, { credOpen: 'denied' });
			if (isLinux) {
				assert.strictEqual(attestation.evidence.seccomp, 2, '/proc/<pid>/status from outside');
				assert.strictEqual(attestation.evidence.noNewPrivs, 1);
			} else {
				assert.strictEqual(attestation.evidence.sandbox_check, 1, 'sandbox_check(pid) from outside');
			}
			const pong = await request(h, { op: 'ping', n: 1 }, 'pong');
			assert.strictEqual(pong.n, 1, 'the workload runs and answers');
			const rows = await supervisor.workloads();
			const row = rows.find(r => r.id === h.id);
			assert.ok(row, 'listed for the Security page');
			assert.strictEqual(row.lifetime, 'host');
			assert.strictEqual(row.subject, h.principal.subject);
			assert.strictEqual(row.attestation?.launchPolicyHash, attestation.launchPolicyHash);
			assert.strictEqual(row.policy.network, 'none');
			assert.ok(!rows.some(r => r.lifetime === 'command' && r.id !== h.id && r.attestation?.launchPolicyHash === attestation.launchPolicyHash), 'the host is not listed twice');
		} finally {
			await h.terminate();
		}
		assert.strictEqual(h.state, 'stopped');
		assert.strictEqual(supervisor.list().length, 0, 'a stopped host leaves the list');
	});

	test('IPC-CHAN-1: NODE_CHANNEL_FD round-trips, as the fd after the launch protocol\'s, and only after the go byte', async () => {
		const supervisor = supervisorWith();
		const h = await started(await supervisor.start(nodeHost()));
		try {
			for (let n = 0; n < 20; n++) {
				const pong = await request(h, { op: 'ping', n }, 'pong');
				assert.strictEqual(pong.n, n);
			}
			const pong = await request(h, { op: 'ping', n: 99 }, 'pong');
			assert.strictEqual(typeof pong.fd, 'number', 'the host has a Node channel');
			assert.ok((pong.fd as number) >= 5, `the channel follows the backend's control fds (fd ${pong.fd})`);
		} finally {
			await h.terminate();
		}
		assert.strictEqual(h.send({ op: 'ping' }), false, 'no channel once stopped');
	});

	test('IPC-CHAN-2: another sandbox cannot reach a host\'s channel: it has no path, and the host process is out of sight', async () => {
		const supervisor = supervisorWith();
		const h = await started(await supervisor.start(nodeHost()));
		try {
			const pong = await request(h, { op: 'ping', n: 1 }, 'pong');
			const fd = pong.fd as number;
			// The host's processes as Volt sees them (on Linux the host's own pid is its namespace's).
			const pids = await treeOf(h.pid!);
			assert.ok(isLinux || pids.includes(pong.pid as number), `the host ${pong.pid} is in its tree ${pids.join(', ')}`);
			// The channel is a socketpair: nothing in the run folders (or anywhere) names it.
			const sockets: string[] = [];
			const walk = async (dir: string) => {
				for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
					const path = join(dir, entry.name);
					if (entry.isSocket()) {
						sockets.push(path);
					} else if (entry.isDirectory()) {
						await walk(path);
					}
				}
			};
			await walk(runRoot);
			assert.deepStrictEqual(sockets, [], 'no socket file for the channel');
			let received = 0;
			const listener = h.onMessage(() => received++);
			try {
				// From another sandbox: the same fd number is not open there, and the host's /proc fds are out of reach (Linux: another pid namespace).
				// macOS: process-info is not mediated (the residual the Security page states), so lsof may see that the fd exists, but it names no path anything could connect to.
				const probe = `echo ran; (echo forged >&${fd}) 2>/dev/null && echo WROTE-FD; ` + pids.map(pid => isLinux
					? `ls -l /proc/${pid}/fd 2>/dev/null | grep -c socket || true; cat /proc/${pid}/fd/${fd} 2>/dev/null && echo READ-PROC; `
					: `/usr/sbin/lsof -a -p ${pid} -d ${fd} -Fn 2>/dev/null | grep '^n' | grep -c / || true; `).join('');
				const result = await supervisor.manager.run({ command: '/bin/sh', args: ['-c', probe], policy: builtinProfile('workspace'), context: { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin:/usr/sbin', HOME: home } } }, { timeoutMs: 30_000 });
				assert.strictEqual(result.status, 'completed', result.error);
				const lines = result.stdout.trim().split('\n');
				assert.strictEqual(lines[0], 'ran', 'the probe ran');
				assert.ok(!/WROTE-FD|READ-PROC/.test(result.stdout), result.stdout);
				assert.ok(lines.slice(1).every(line => line === '0'), `nothing of the host's fds is visible: ${result.stdout}`);
				await new Promise(resolve => setTimeout(resolve, 200));
				assert.strictEqual(received, 0, 'nothing reached the host but its own channel');
			} finally {
				listener.dispose();
			}
			// And the channel still works.
			assert.strictEqual((await request(h, { op: 'ping', n: 2 }, 'pong')).n, 2);
		} finally {
			await h.terminate();
		}
	});

	test('IPC-CHAN-3: with a registry, the channel is bound to the principal and closing it revokes the principal', async () => {
		const registry = new PrincipalRegistry('test');
		store.add(registry);
		const minted = registry.mint({ subject: chatSubject('supervisor-registry'), kind: 't2', launchPolicyHash: '' });
		const supervisor = supervisorWith({ registry });
		const h = await started(await supervisor.start(nodeHost({ principal: minted })));
		assert.ok(registry.isLive(minted.id));
		await h.terminate();
		assert.strictEqual(registry.isLive(minted.id), false, 'the principal ends with its channel');
	});

	// --- restart budget, resources ----------------------------------------------------------------

	test('RES-6: a crash loop restarts with backoff as new principals, then is broken with its stderr kept', async () => {
		const supervisor = supervisorWith({ backoffMs: 50 });
		const exits: IHostExit[] = [];
		const ids: string[] = [];
		const h = await started(await supervisor.start(nodeHost({}, ['crash'])));
		store.add(h.onExit(exit => exits.push(exit)));
		ids.push(h.principal.id);
		store.add(h.onDidChangeState(state => {
			if (state === 'running') {
				ids.push(h.principal.id);
			}
		}));
		assert.ok(await waitFor(() => h.state === 'broken', 20_000), `state ${h.state}`);
		assert.deepStrictEqual(exits.map(exit => [exit.reason, exit.restarting]), [['crash', true], ['crash', true], ['crash', false]]);
		assert.strictEqual(h.restarts, 2);
		assert.strictEqual(new Set(ids).size, 3, `each launch is a new principal: ${ids.join(', ')}`);
		assert.match(h.stderrTail(), /host failed: boom/);
		const row = (await supervisor.workloads()).find(r => r.id === h.id);
		assert.strictEqual(row?.state, 'broken', 'a broken host stays listed');
		assert.match(row?.detail ?? '', /3 crashes.*host failed: boom/);
		assert.ok(await supervisor.stop(h.id), 'dismissed');
		assert.strictEqual(supervisor.list().length, 0);
	});

	test('RES-1-POLL: resource samples arrive for a running host, and a tree over its polled memory limit is killed', async () => {
		const supervisor = supervisorWith();
		const h = await started(await supervisor.start(nodeHost({ limits: { memoryMB: 120 }, restart: { maxPerMinute: 0 } })));
		const samples: ISandboxResourceSample[] = [];
		store.add(h.onResource(sample => samples.push(sample)));
		const exited = new Promise<IHostExit>(resolve => store.add(h.onExit(resolve)));
		assert.ok(await waitFor(() => samples.length >= 2, 10_000), 'samples at the sampling rate');
		const first = samples[0];
		assert.ok(first.memoryBytes > 10 * 1024 * 1024, `memory ${first.memoryBytes}`);
		assert.ok(first.processes >= 1);
		assert.ok(first.cpuMs >= 0);
		assert.deepStrictEqual(first.sources, ['poll']);
		h.send({ op: 'grow' });
		const exit = await exited;
		assert.strictEqual(exit.reason, 'resource');
		assert.strictEqual(exit.restarting, false);
		assert.strictEqual(h.state, 'broken');
	});

	// --- idle, budget -------------------------------------------------------------------------

	test('LIFE-IDLE-1: no activity for the idle budget makes a host idle, then stops it; activity keeps it running', async () => {
		const supervisor = supervisorWith();
		// Budgets wide enough for a loaded machine: a ping every 100 ms never leaves 1 s of quiet.
		const h = await started(await supervisor.start(nodeHost({ idle: { afterMs: 1_000, stopAfterMs: 2_500 } })));
		const states: string[] = [];
		store.add(h.onDidChangeState(state => states.push(state)));
		// Busy for longer than the idle budget: never idle.
		const busyUntil = Date.now() + 1_500;
		for (let i = 0; Date.now() < busyUntil; i++) {
			await request(h, { op: 'ping', n: i }, 'pong');
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(!states.includes('idle'), states.join(','));
		assert.ok(await waitFor(() => h.state === 'idle', 4_000), `state ${h.state}`);
		// An activation brings it back.
		await request(h, { op: 'ping', n: 7 }, 'pong');
		assert.strictEqual(h.state, 'running');
		const exited = new Promise<IHostExit>(resolve => store.add(h.onExit(resolve)));
		const exit = await exited;
		assert.strictEqual(exit.reason, 'idle');
		assert.strictEqual(h.state, 'stopped');
		assert.deepStrictEqual(states.filter((s, i) => s !== states[i - 1]), ['idle', 'running', 'idle', 'stopping', 'stopped']);
	});

	test('LIFE-BUDGET-1: over the host budget a start is refused unless an idle host can be stopped for it', async () => {
		const supervisor = supervisorWith({ maxHosts: 1 });
		const a = await started(await supervisor.start(nodeHost({ idle: { afterMs: 400, stopAfterMs: 60_000 } })));
		const refused = await supervisor.start(nodeHost());
		assert.strictEqual(refused.ok, false);
		assert.strictEqual(refused.ok ? '' : refused.refused, 'budget', 'never co-hosted, never over budget');
		assert.ok(await waitFor(() => a.state === 'idle', 3_000));
		const aExit = new Promise<IHostExit>(resolve => store.add(a.onExit(resolve)));
		const b = await started(await supervisor.start(nodeHost()));
		try {
			assert.strictEqual((await aExit).reason, 'budget', 'the idle host made room');
			assert.strictEqual(supervisor.list().filter(x => x.state === 'running').length, 1);
		} finally {
			await b.terminate();
		}
	});

	// --- trees, quit, recovery ----------------------------------------------------------------

	test('TREE-1: quitting kills every host\'s whole tree', async () => {
		const supervisor = supervisorWith();
		const hosts = [await started(await supervisor.start(nodeHost())), await started(await supervisor.start(nodeHost()))];
		const pids: number[] = [];
		for (const h of hosts) {
			const child = (await request(h, { op: 'child' }, 'child')).pid as number;
			// Every process of the host's tree, as Volt sees them (on Linux the child's pid above is the sandbox's namespace's).
			const tree = await treeOf(h.pid!);
			assert.ok(isLinux ? tree.length >= 3 : tree.includes(child), `the host's child is in its tree: ${tree.join(', ')}`);
			pids.push(...tree);
		}
		assert.ok(pids.every(pid => processAlive(pid)), 'hosts and their children run');
		const started_ = Date.now();
		await supervisor.shutdown();
		assert.ok(await waitFor(() => pids.every(pid => !processAlive(pid)), 5_000), `survivors: ${pids.filter(processAlive).join(', ')}`);
		assert.ok(Date.now() - started_ < 5_000);
		assert.ok(hosts.every(h => h.state === 'stopped'));
		const late = await supervisor.start(nodeHost());
		assert.strictEqual(late.ok ? '' : late.refused, 'disabled', 'nothing starts while quitting');
	});

	test('LIFE-RECOVER-1: the next start reaps a dead owner\'s hosts by their tag and leaves a live owner\'s alone', async () => {
		const supervisor = supervisorWith();
		await supervisor.manager.runRootPath();
		const dead = spawn('/usr/bin/true');
		await new Promise(resolve => dead.once('exit', resolve));
		const deadPid = dead.pid!;
		assert.ok(!processAlive(deadPid));
		const owner = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
		const tagDead = 'a1b2c3d4e5f60718';
		const tagLive = 'b1b2c3d4e5f60718';
		// Survivors of the crashed Volt: its host's tree (a Node host tagged as the manager tags every run, with a
		// platform-binary child whose environment macOS hides), and an untagged bystander.
		const survivor = spawn(process.execPath, ['-e', `const c = require('child_process').spawn('/bin/sleep', ['300'], { stdio: 'ignore' }); process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1 << 30);`], { env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', VOLT_SANDBOX_TAG: tagDead }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
		const grandchild = await new Promise<number>((resolve, reject) => {
			survivor.stdout!.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
			survivor.once('exit', () => reject(new Error('the survivor exited')));
		});
		const liveHost = spawn('/bin/sleep', ['300'], { env: { PATH: '/usr/bin:/bin', VOLT_SANDBOX_TAG: tagLive }, stdio: 'ignore' });
		const bystander = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
		const write = async (name: string, tag: string, ownerPid: number, pid: number) => {
			const dir = join(runRoot, name);
			await fs.mkdir(join(dir, 'tmp'), { recursive: true });
			await fs.writeFile(join(dir, 'ledger.json'), JSON.stringify({ version: 1, ownerPid, tag, pid, principalId: 'x', subject: 'chat:x', label: 'old host', startedAt: 1 }));
			return dir;
		};
		try {
			await new Promise(resolve => setTimeout(resolve, 200));
			const deadDir = await write('volt-sbx-crashed', tagDead, deadPid, survivor.pid!);
			const liveDir = await write('volt-sbx-other', tagLive, owner.pid!, liveHost.pid!);
			assert.strictEqual(await supervisor.recover(), 1);
			assert.ok(await waitFor(() => !processAlive(survivor.pid!) && !processAlive(grandchild), 3_000), `the crashed owner's host and its child are killed (alive: ${[survivor.pid!, grandchild].filter(processAlive).join(', ')})`);
			assert.ok(!await fs.stat(deadDir).then(() => true, () => false), 'and its run folder removed');
			assert.ok(processAlive(liveHost.pid!), 'a live owner\'s host is left alone');
			assert.ok(await fs.stat(liveDir).then(() => true, () => false));
			assert.ok(processAlive(bystander.pid!), 'untagged processes are never touched');
		} finally {
			for (const child of [owner, survivor, liveHost, bystander]) {
				child.kill('SIGKILL');
			}
			await killTagged(tagDead);
		}
	});

	// --- refusals -------------------------------------------------------------------------------

	test('FAULT-HOST-1: a host whose attestation fails is refused, typed, and its workload never runs', async () => {
		const marker = join(ws, 'fault-host-marker');
		const supervisor = supervisorWith({}, 'attest');
		const result = await supervisor.start(nodeHost({ command: { file: '/usr/bin/touch', args: [marker] }, ipc: false }));
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.ok ? '' : result.refused, 'attest');
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.ok(!await fs.stat(marker).then(() => true, () => false), 'the workload never ran');
		assert.strictEqual(supervisor.list().length, 0);
	});

	test('LIFE-FLAG-1: with the supervisor turned off nothing starts and nothing is reaped', async () => {
		const supervisor = supervisorWith({ enabled: () => false });
		const result = await supervisor.start(nodeHost());
		assert.strictEqual(result.ok ? '' : result.refused, 'disabled');
		assert.strictEqual(await supervisor.recover(), 0);
	});

	// --- performance ----------------------------------------------------------------------------

	test('PERF-HOST-1: cold host start to first RPC (budget: 04-performance.md, T2 150/300 ms p50/p95)', async () => {
		const supervisor = supervisorWith();
		// Warm the probe (once per process in Volt).
		await supervisor.manager.capabilities();
		const times: number[] = [];
		for (let i = 0; i < 8; i++) {
			const t0 = Date.now();
			const h = await started(await supervisor.start(nodeHost()));
			await request(h, { op: 'ping', n: i }, 'pong');
			times.push(Date.now() - t0);
			await h.terminate();
		}
		times.sort((a, b) => a - b);
		const p50 = times[Math.floor(times.length / 2)];
		const p95 = times[times.length - 1];
		if (process.env.VOLT_SANDBOX_BENCH_FILE) {
			await fs.appendFile(process.env.VOLT_SANDBOX_BENCH_FILE, `PERF-HOST-1 ${process.platform} cold host start to first RPC: p50 ${p50} ms, max ${p95} ms (${times.join(', ')})\n`);
		}
		// A loose bound here (CI machines vary); the budget itself is reported, not gated, until the bench lands.
		assert.ok(p50 < 2_000, `p50 ${p50} ms`);
	});
});

suite('Volt sandbox supervisor helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ps CPU time parses every form', () => {
		assert.strictEqual(parseCpuTime('0:00.03'), 30);
		assert.strictEqual(parseCpuTime('1:02.50'), 62_500);
		assert.strictEqual(parseCpuTime('01:00:00'), 3_600_000);
		assert.strictEqual(parseCpuTime('2-00:00:01'), 2 * 86_400_000 + 1_000);
	});

	test('killTagged refuses a tag that is not one', async () => {
		assert.strictEqual(await killTagged('not a tag'), 0);
		assert.strictEqual(await killTagged(''), 0);
	});
});
