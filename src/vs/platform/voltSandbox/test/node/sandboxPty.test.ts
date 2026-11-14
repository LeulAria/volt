/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The PTY launch path (spec F.6) against the real backend: the control channels as FIFOs in the
 * run folder, the backend's own confirmation over them, and the gate that runs the workload only
 * after Volt's go line. The launcher is started here on plain pipes (node-pty is the app's, built
 * for Electron); the channels and the gate do not depend on what the terminal is. The PTY itself
 * is covered by voltStdioSandbox.test.ts. Runs in the Linux rig too:
 *
 *   scripts/volt-sandbox-linux-test.sh suite /volt/out/vs/platform/voltSandbox/test/node/sandboxPty.test.js
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { SandboxedPtySession } from '../../node/sandboxPty.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const posix = process.platform !== 'win32';

suite('Volt sandbox PTY launch (F.6)', function () {

	this.timeout(120_000);
	// A session's sandbox is torn down as it ends; let that land before the leak check below looks.
	teardown(() => new Promise(resolve => setTimeout(resolve, available ? 500 : 0)));
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let ws: string;
	let launcher: VoltSandboxLauncher;
	let available = false;
	const markers: string[] = [];
	let counter = 0;

	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

	function homeMarker(name: string): string {
		const path = join(homedir(), `.volt-pty-${process.pid}-${name}-${counter++}`);
		markers.push(path);
		return path;
	}

	suiteSetup(async () => {
		if (!posix) {
			return;
		}
		// Not under a shared temp folder on Linux: a terminal cannot carry --bind-fd's folder fds, so
		// the backend refuses a workspace there (B-33; the refusal is the test below).
		root = await fs.realpath(await fs.mkdtemp(join(process.platform === 'linux' ? homedir() : tmpdir(), '.volt-pty-')));
		ws = join(root, 'ws');
		await fs.mkdir(ws, { recursive: true });
		await fs.mkdir(join(root, 'user-data'), { recursive: true });
		launcher = new VoltSandboxLauncher(join(root, 'user-data'), { info: () => undefined, warn: () => undefined });
		// A chat's sandbox with the network off runs through the proxy: a backend without it (bubblewrap
		// without socat) cannot start these terminals, as it cannot run sandboxSecurity.test.ts.
		available = realSandboxAvailable(await launcher.capabilities(), 'PTY launch suite');
	});

	suiteTeardown(async () => {
		launcher?.dispose();
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

	const request = (): IVoltSandboxRequest => ({ level: 'workspace-write', network: false, providerId: '', workspaceRoots: [ws] });

	async function start(command: string): Promise<{ session: SandboxedPtySession; child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
		const session = await SandboxedPtySession.prepare(launcher, '/bin/sh', ['-c', command], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C' } });
		const { file, args, env, cwd } = session.launch;
		// Exactly what a PTY gets: the launcher, its arguments and the sandbox's environment; no extra descriptors.
		const child = spawn(file, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		let text = '';
		child.stdout?.on('data', chunk => { text += chunk; });
		child.stderr?.on('data', chunk => { text += chunk; });
		const exited = new Promise<number | null>(resolve => child.once('exit', code => {
			session.exited(code, null);
			resolve(code);
		}));
		return { session, child, output: () => text, exited };
	}

	test('the channels carry the backend\'s confirmation; the workload runs only after the go line, inside the sandbox', async () => {
		const marker = homeMarker('ok');
		const inside = join(ws, `inside-${counter++}`);
		const { session, child, output, exited } = await start(`touch ${quote(inside)}; touch ${quote(marker)} 2>/dev/null || echo denied-outside`);
		try {
			const go = await session.confirm(child.pid!);
			assert.strictEqual(await exists(inside), false, 'nothing ran before the go line');
			// The go line ends in the Enter key (`\r`); a terminal's line discipline (ICRNL) delivers it as `\n`, a pipe does not.
			assert.ok(go.endsWith('\r'));
			child.stdin!.write(`${go.slice(0, -1)}\n`);
			assert.strictEqual(await exited, 0, output());
			assert.ok(output().includes('denied-outside'), output());
			assert.ok(await exists(inside), `the workload ran: ${output()}`);
			assert.strictEqual(await exists(marker), false, 'no marker in the home folder');
		} finally {
			await session.end();
		}
	});

	test('any other line, or the end of input, runs nothing', async () => {
		for (const typed of ['rm -rf ~\n', '']) {
			const inside = join(ws, `gate-${counter++}`);
			const { session, child, exited } = await start(`touch ${quote(inside)}`);
			try {
				await session.confirm(child.pid!);
				child.stdin!.end(typed);
				assert.strictEqual(await exited, 125, JSON.stringify(typed));
				assert.strictEqual(await exists(inside), false);
			} finally {
				await session.end();
			}
		}
	});

	test('a launcher that never starts is not confirmed, and ending it releases the channels', async () => {
		const session = await SandboxedPtySession.prepare(launcher, '/bin/sh', ['-c', 'true'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin', HOME: homedir() } });
		// A process that holds no channel: Volt's opens wait, the backend times out, nothing is confirmed.
		const idle = spawn('/bin/sleep', ['30'], { stdio: 'ignore', detached: true });
		try {
			await assert.rejects(session.confirm(idle.pid!), /could not be established/);
		} finally {
			idle.kill('SIGKILL');
			await session.end();
		}
	});

	// The evidence is attested from outside (H7, ATTEST-*): Linux reads the sandbox's /proc status
	// beside bubblewrap's, macOS asks its helper about the ready line's process. A forger writing
	// what the prologue would write proves nothing.
	test('evidence written into the channels by something else is not accepted', async () => {
		const session = await SandboxedPtySession.prepare(launcher, '/bin/sh', ['-c', 'true'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin', HOME: homedir() } });
		// After the script, its name and the gate's mark file.
		const [fifo3, fifo4] = [session.launch.args[4], session.launch.args[5]];
		const forgery = process.platform === 'linux'
			? `printf 'NoNewPrivs:1 Seccomp:2\\n' > ${quote(fifo3)}; printf '{"child-pid": %s}\\n' "$$" > ${quote(fifo4)}; sleep 30`
			: `printf 'volt-sandbox-ready %s cred=denied\\n' "$$" > ${quote(fifo3)}; sleep 30`;
		const forged = spawn('/bin/sh', ['-c', forgery], { stdio: 'ignore', detached: true });
		try {
			await assert.rejects(session.confirm(forged.pid!), /could not be established/);
		} finally {
			forged.kill('SIGKILL');
			await session.end();
		}
	});

	(process.platform === 'linux' ? test : test.skip)('B-33: a terminal whose workspace is under a shared temp folder is refused, as it cannot be bound race-free', async () => {
		const shared = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-pty-shared-')));
		try {
			const inside = join(shared, 'ran');
			await assert.rejects(
				SandboxedPtySession.prepare(launcher, '/bin/sh', ['-c', `touch ${quote(inside)}`], { ...request(), workspaceRoots: [shared] }, { cwd: shared, hostEnv: { PATH: '/usr/bin:/bin', HOME: homedir() } }),
				/cannot bind .* race-free/,
			);
			assert.strictEqual(await exists(inside), false);
		} finally {
			await fs.rm(shared, { recursive: true, force: true });
		}
	});
});
