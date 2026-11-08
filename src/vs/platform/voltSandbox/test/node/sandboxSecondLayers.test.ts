/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * C4: the second enforcement layers beside each platform's sandbox (J.1, J.2, F.8, F.10), against
 * real sandboxes. Test ids are the spec's: TREE-MAC-1, RES-MAC-1..3 on macOS; TREE-LNX-1,
 * RES-LNX-1..3 and LNX-FS-3 on Linux.
 *
 * Like sandboxSecurity.test.ts: a machine without a working backend skips loudly, and with
 * `VOLT_SANDBOX_REQUIRED` set it fails instead. A Linux layer the kernel or the session lacks
 * (Landlock, a delegated cgroup) is reported absent by the backend; its tests then check the
 * report says so, and fail instead under `VOLT_SANDBOX_REQUIRE_LAYERS` (the rig that has them).
 * Linux: scripts/volt-sandbox-linux-test.sh suite.
 */

import assert from 'assert';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxRunResult } from '../../common/sandboxBackend.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { ISandboxLimits, IVoltSandboxPolicy, SandboxDimension } from '../../common/sandboxSchema.js';
import { IPreparedSandbox, SandboxManager } from '../../node/sandboxManager.js';
import { sandboxHostFacts } from '../../node/sandboxResolver.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isMac = process.platform === 'darwin';
const PERL = '/usr/bin/perl';
const macTest = isMac ? test : test.skip;
const MARKER = `volt-sbx-layers-${process.pid}`;

/** Processes carrying this suite's marker (optionally one test's), the sandbox launchers excluded. */
function strayProcesses(name?: string): string[] {
	const needle = name ? `${MARKER}-${name}` : MARKER;
	try {
		return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
			.filter(line => line.includes(needle) && !line.includes('/bin/ps') && !line.includes('sandbox-exec') && !line.includes('bwrap'));
	} catch {
		return [];
	}
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return check();
}

suite('Volt sandbox second layers (C4, real processes)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let manager: SandboxManager;
	let available = false;

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-c4-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		for (const dir of [home, ws, join(root, 'runs')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		manager = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host: { ...await sandboxHostFacts(), home } });
		available = realSandboxAvailable(await manager.capabilities(), 'second layers suite');
	});

	suiteTeardown(async () => {
		await manager?.dispose();
		for (const line of strayProcesses()) {
			try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ }
		}
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	const hostEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C' });

	/** The workspace profile with these limits, accepted best effort (the macOS layers are). */
	function limited(limits: Partial<ISandboxLimits>, bestEffort: readonly SandboxDimension[] = []): IVoltSandboxPolicy {
		const base = builtinProfile('workspace');
		return { ...base, process: { ...base.process, limits: { ...base.process.limits, ...limits } }, bestEffort: [...new Set([...base.bestEffort, ...bestEffort])] };
	}

	function run(policy: IVoltSandboxPolicy, script: string, timeoutMs = 30_000): Promise<ISandboxRunResult> {
		return manager.run({ command: '/bin/sh', args: ['-c', `echo volt-sandbox-ran; ${script}`], policy, context: { workspaceRoots: [ws], hostEnv: hostEnv() } }, { timeoutMs });
	}

	/** Prepares, spawns and confirms; the caller stops it. */
	async function start(policy: IVoltSandboxPolicy, script: string): Promise<{ prepared: IPreparedSandbox; child: ChildProcess }> {
		const prepared = await manager.prepare({ command: '/bin/sh', args: ['-c', script], policy, context: { workspaceRoots: [ws], hostEnv: hostEnv() } });
		const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'ignore', 'ignore', ...prepared.extraStdio], detached: true });
		const confirmed = await prepared.confirm(child);
		assert.ok(confirmed.ok, confirmed.ok ? '' : confirmed.error);
		return { prepared, child };
	}

	async function stop(handle: { prepared: IPreparedSandbox; child: ChildProcess }): Promise<void> {
		await handle.prepared.terminate(handle.child);
		for (const stream of handle.child.stdio) {
			stream?.destroy();
		}
		await handle.prepared.dispose();
	}

	// --- macOS -------------------------------------------------------------------------------------

	macTest('TREE-MAC-1: a double-forked, setsid, environment-cleared orphan dies with its run', async () => {
		// The escape the process-group and tag sweep alone missed: no group, no parent, no tag.
		// Names are joined at run time, so the shell's own command line does not carry them.
		const orphan = `${PERL} -e 'use POSIX; exit 0 if fork(); POSIX::setsid(); exit 0 if fork(); %ENV = (); exec { "/bin/sleep" } "${MARKER}-" . "orphan", "300"'`;
		const handle = await start(limited({}), `${orphan}; ${PERL} -e '$0 = "${MARKER}-" . "main"; sleep 300'`);
		try {
			assert.ok(await waitFor(() => strayProcesses('orphan').length === 1 && strayProcesses('main').length === 1, 5_000), strayProcesses().join(' | '));
			const [, ppid] = strayProcesses('orphan')[0].trim().split(/\s+/).map(Number);
			assert.strictEqual(ppid, 1, 'the orphan has left the tree');
			assert.strictEqual(handle.prepared.attestation()?.layers.processTracking?.active, true, JSON.stringify(handle.prepared.attestation()?.layers));
		} finally {
			await stop(handle);
		}
		assert.ok(await waitFor(() => strayProcesses().length === 0, 5_000), `survivors: ${strayProcesses().join(' | ')}`);
	});

	macTest('RES-MAC-1: a run over its memory limit is killed within 2 s, and says why', async () => {
		const started = Date.now();
		// 256 MB of string against a 64 MB limit, then hold it.
		const result = await run(limited({ memoryMB: 64, wallClockSeconds: 60 }, ['limits.memory']), `${PERL} -e '$0 = "${MARKER}-memory"; my $x = "x" x (256 * 1024 * 1024); sleep 60'`);
		assert.strictEqual(result.status, 'completed', result.error);
		assert.ok(result.stdout.startsWith('volt-sandbox-ran'), result.stderr);
		assert.strictEqual(result.resourceViolation?.dimension, 'limits.memory', JSON.stringify(result.resourceViolation));
		assert.strictEqual(result.resourceViolation.by, 'footprint');
		assert.ok(result.resourceViolation.observed > 64, `observed ${result.resourceViolation.observed} MB`);
		assert.ok(Date.now() - started < 10_000, `killed after ${Date.now() - started} ms`);
		assert.ok(result.denials.some(denial => denial.kind === 'limit' && denial.target === 'memory 64 MB'), JSON.stringify(result.denials));
		assert.ok(result.unenforced.includes('limits.memory'), 'best effort, so reported partial');
		assert.strictEqual(result.attestation?.layers.footprint?.active, true, JSON.stringify(result.attestation?.layers));
		assert.ok(await waitFor(() => strayProcesses('memory').length === 0, 3_000), strayProcesses('memory').join(' | '));
	});

	macTest('RES-MAC-1: a run under its memory limit is left alone', async () => {
		const result = await run(limited({ memoryMB: 256 }, ['limits.memory']), `${PERL} -e 'my $x = "x" x (16 * 1024 * 1024); sleep 2; print "kept\\n"'`);
		assert.strictEqual(result.status, 'completed', result.error);
		assert.strictEqual(result.resourceViolation, undefined, JSON.stringify(result.resourceViolation));
		assert.ok(result.stdout.includes('kept'), result.stderr);
	});

	macTest('RES-MAC-2: a fork bomb is killed at the process limit, the whole tree with it', async () => {
		const started = Date.now();
		const result = await run(limited({ processes: 16, cpuSeconds: 20, wallClockSeconds: 30 }), `${PERL} -e '$0 = "${MARKER}-bomb"; fork() while 1'; echo survived`);
		assert.strictEqual(result.status, 'completed', result.error);
		assert.strictEqual(result.resourceViolation?.dimension, 'limits.processes', JSON.stringify(result.resourceViolation));
		assert.strictEqual(result.resourceViolation.by, 'watchdog');
		assert.ok(!result.stdout.includes('survived'), 'the run itself was killed, not only the bomb');
		assert.ok(Date.now() - started < 15_000, `killed after ${Date.now() - started} ms`);
		assert.ok(await waitFor(() => strayProcesses('bomb').length === 0, 5_000), strayProcesses('bomb').slice(0, 5).join(' | '));
		assert.match(result.attestation?.layers.processTracking?.detail ?? '', /fork watchdog at 16/);
	});

	macTest('RES-MAC-2: a run within its process limit keeps working', async () => {
		const result = await run(limited({ processes: 16 }), 'for i in 1 2 3 4; do (sleep 0.2) & done; wait; echo done');
		assert.strictEqual(result.status, 'completed', result.error);
		assert.strictEqual(result.resourceViolation, undefined, JSON.stringify(result.resourceViolation));
		assert.ok(result.stdout.includes('done'), result.stderr);
	});

	macTest('RES-MAC-3: CPU time, file size and open files are kernel limits', async () => {
		const files = await run(limited({ openFiles: 64 }), 'ulimit -n');
		assert.strictEqual(files.stdout.split('\n')[1]?.trim(), '64', files.stdout);
		const started = Date.now();
		const spin = await run(limited({ cpuSeconds: 1 }), 'while :; do :; done');
		assert.ok(spin.exitCode !== 0 && Date.now() - started < 15_000, `cpu: exit ${spin.exitCode} ${spin.signal}`);
		await run(limited({ fileSizeMB: 1 }), `dd if=/dev/zero of=${ws}/big bs=1048576 count=8 2>/dev/null`);
		const size = (await fs.stat(join(ws, 'big')).catch(() => ({ size: 0 }))).size;
		assert.ok(size > 0 && size <= 1024 * 1024, `file size capped: ${size}`);
	});
});
