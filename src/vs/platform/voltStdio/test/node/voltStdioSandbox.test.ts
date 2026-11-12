/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who a process runs for, against real sandboxes (spec B-04, B-06, F.6, INV-03, INV-14): a
 * sandboxed chat's commands and terminals run inside its sandbox or not at all. Every denial is
 * checked together with proof that the command ran (it wrote inside the workspace), so a test
 * cannot pass because nothing ran. Canary markers go in the real home folder, outside every
 * sandbox's writable set, and are removed afterwards.
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails.
 * Linux: run inside the container rig (scripts/volt-sandbox-linux-test.sh).
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import type { IPty } from 'node-pty';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltSandboxRequest } from '../../../voltSandbox/common/sandboxPolicy.js';
import { VoltSandboxLauncher } from '../../../voltSandbox/node/sandboxLauncher.js';
import { ptyLauncherScript, PTY_GATE_SCRIPT } from '../../../voltSandbox/node/sandboxPty.js';
import { realSandboxAvailable } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { execRefusal, IVoltExecContext, IVoltExecRequest, VoltExecRefusedError } from '../../common/voltStdio.js';
import { VoltStdioService } from '../../node/voltStdioService.js';

const posix = process.platform !== 'win32';

const chat = (sandboxed: boolean, reason: IVoltExecContext['reason'] = 'post-turn-check'): IVoltExecContext => ({ principal: 'chat:life', reason, sandboxed });

suite('Volt exec context (B-04, B-06)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a request says who it runs for; a sandboxed chat\'s request without its sandbox is refused', () => {
		const sandbox: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: '', workspaceRoots: ['/w'] };
		assert.strictEqual(execRefusal(undefined, undefined)?.kind, 'no-context', 'no context: refused');
		assert.strictEqual(execRefusal({ reason: 'chat' } as unknown as IVoltExecContext, sandbox)?.kind, 'no-context', 'a context from an old caller without a principal: refused');
		assert.strictEqual(execRefusal(chat(true), undefined)?.kind, 'no-sandbox');
		assert.match(execRefusal(chat(true), undefined)!.reason, /life/);
		assert.strictEqual(execRefusal({ principal: 'volt', onBehalfOf: 'c1', reason: 'worktree-setup', sandboxed: true }, undefined)?.kind, 'no-sandbox');
		assert.strictEqual(execRefusal(chat(true), sandbox), undefined);
		assert.strictEqual(execRefusal(chat(false), undefined), undefined);
		assert.strictEqual(execRefusal({ principal: 'user', reason: 'user-action', sandboxed: false }, undefined), undefined);
	});

	test('the PTY launcher text depends only on the channels, and opens them in their directions', () => {
		assert.strictEqual(ptyLauncherScript(['out']), 'exec 3>"$1" || exit 125\nshift 1\nexec "$@"');
		assert.strictEqual(ptyLauncherScript(['out', 'out', 'in', 'in']), 'exec 3>"$1" 4>"$2" 5<"$3" 6<"$4" || exit 125\nshift 4\nexec "$@"');
		assert.throws(() => ptyLauncherScript([]));
		assert.ok(!/\$\{|`/.test(PTY_GATE_SCRIPT), 'the gate expands nothing it was not given');
	});
});

suite('Volt exec context against real sandboxes (LIFE-PATH, B-04, F.6)', function () {

	this.timeout(120_000);
	// A finished command's sandbox is torn down just after it returns (the tree kill, then its run
	// folder): let that land before the leak check below looks.
	teardown(() => new Promise(resolve => setTimeout(resolve, available ? 1_500 : 0)));
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let ws: string;
	let stdio: VoltStdioService;
	let available = false;
	const markers: string[] = [];
	let counter = 0;

	/** A file in the real home folder, which no sandbox may write; removed after the suite. */
	function homeMarker(name: string): string {
		const path = join(homedir(), `.volt-life-path-${process.pid}-${name}-${counter++}`);
		markers.push(path);
		return path;
	}

	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

	suiteSetup(async function () {
		if (!posix) {
			return;
		}
		// Not under a shared temp folder on Linux: a terminal cannot carry --bind-fd's folder fds, so
		// the backend refuses a workspace there (B-33, sandboxPty.test.ts).
		root = await fs.realpath(await fs.mkdtemp(join(process.platform === 'linux' ? homedir() : tmpdir(), '.volt-life-path-')));
		ws = join(root, 'ws');
		await fs.mkdir(join(root, 'user-data'), { recursive: true });
		await fs.mkdir(ws, { recursive: true });
		const service = new VoltStdioService(new NullLogService(), new TestConfigurationService(), join(root, 'user-data'));
		stdio = service;
		// The user's shell environment, resolved once up front.
		await service.which('sh');
		// The backend the service uses, asked for its capabilities: a chat's sandbox with the network
		// off runs through the proxy, which bubblewrap without socat cannot enforce.
		const probe = new VoltSandboxLauncher(join(root, 'user-data'), new NullLogService());
		try {
			available = realSandboxAvailable(await probe.capabilities(), 'LIFE-PATH suite');
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

	/** The chat's sandbox as `chatExec` builds it for a command Volt runs for the chat: its own rules, no agent state folders. */
	function chatSandbox(network = false): IVoltSandboxRequest {
		return { level: 'workspace-write', network, providerId: '', workspaceRoots: [ws] };
	}

	function request(command: string, context: IVoltExecContext, sandbox?: IVoltSandboxRequest): IVoltExecRequest {
		return { id: `life-${counter++}`, command, cwd: ws, timeoutMs: 30_000, context, ...(sandbox ? { sandbox } : {}) };
	}

	test('B-04: a sandboxed chat\'s post-turn check whose test script writes $HOME runs in the sandbox; no marker', async () => {
		const marker = homeMarker('b04');
		const inside = join(ws, `b04-ran-${counter++}`);
		// The agent rewrote the test script; Volt runs `npm test` after the turn.
		await fs.writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'b04', version: '1.0.0', scripts: { test: `touch ${quote(inside)} && touch ${quote(marker)}` } }));
		const npm = await stdio.which('npm');
		const command = npm ? 'npm test' : `touch ${quote(inside)} && touch ${quote(marker)}`;
		const result = await stdio.exec(request(command, chat(true), chatSandbox()));
		assert.strictEqual(result.refused, undefined, `the check ran: ${result.combined}`);
		assert.ok(await exists(inside), `the test script ran inside the workspace (${npm ? 'npm' : 'sh'}): ${result.combined}`);
		assert.notStrictEqual(result.exitCode, 0, 'the write outside failed, so the script failed');
		assert.strictEqual(await exists(marker), false, 'no marker in the home folder');
	});

	test('a sandboxed chat\'s command without its sandbox is refused before anything runs (INV-03)', async () => {
		const marker = homeMarker('nosandbox');
		const result = await stdio.exec(request(`touch ${quote(marker)}`, chat(true)));
		assert.strictEqual(result.refused?.kind, 'no-sandbox');
		assert.strictEqual(result.exitCode, null);
		assert.strictEqual(await exists(marker), false);
		const missing = await stdio.exec({ id: 'life-nocontext', command: `touch ${quote(marker)}`, timeoutMs: 5_000 } as unknown as IVoltExecRequest);
		assert.strictEqual(missing.refused?.kind, 'no-context');
		assert.strictEqual(await exists(marker), false);
		await assert.rejects(stdio.spawn({ command: '/usr/bin/touch', args: [marker], context: chat(true, 'agent') }), (err: Error) => err instanceof VoltExecRefusedError && err.refusal.kind === 'no-sandbox');
		assert.strictEqual(await exists(marker), false);
	});

	for (const reason of ['agent-shell', 'workflow', 'worktree-setup', 'terminal', 'hook', 'title'] as const) {
		test(`LIFE-PATH (${reason}): the chat's command runs, and its write outside the workspace fails`, async () => {
			const marker = homeMarker(reason);
			const inside = join(ws, `${reason}-${counter++}`);
			const result = await stdio.exec(request(`touch ${quote(inside)}; touch ${quote(marker)}`, chat(true, reason), chatSandbox(true)));
			assert.strictEqual(result.refused, undefined, result.combined);
			assert.ok(await exists(inside), `it ran: ${result.combined}`);
			assert.strictEqual(await exists(marker), false, 'no marker in the home folder');
		});
	}

	/** Starts a sandboxed terminal the way the agent server does, on a real PTY. */
	async function startTerminal(id: string, command: string): Promise<{ pty: IPty; output: () => string; exited: Promise<number> }> {
		const launch = await stdio.prepareSandboxedTerminal({ id, file: '/bin/sh', args: ['-c', command], cwd: ws, env: { TERM: 'xterm-256color' }, sandbox: chatSandbox(), context: chat(true, 'terminal') });
		const loaded = await import('node-pty') as unknown as { spawn?: typeof import('node-pty').spawn; default?: { spawn: typeof import('node-pty').spawn } };
		const spawn = loaded.spawn ?? loaded.default!.spawn;
		const pty = spawn(launch.file, [...launch.args], { name: 'xterm-256color', cols: 120, rows: 30, cwd: launch.cwd, env: { ...launch.env } });
		let text = '';
		const data = pty.onData(chunk => { text += chunk; });
		const exited = new Promise<number>(resolve => {
			const exit = pty.onExit(({ exitCode }) => {
				data.dispose();
				exit.dispose();
				void stdio.endSandboxedTerminal(id).then(() => resolve(exitCode));
			});
		});
		return { pty, output: () => text, exited };
	}

	test('LIFE-PATH-1: a sandboxed chat\'s terminal runs in its sandbox on a PTY; nothing runs before the go line', async () => {
		const marker = homeMarker('terminal');
		const inside = join(ws, `terminal-${counter++}`);
		const done = `volt-terminal-done-${counter++}`;
		const id = `term-life-${counter++}`;
		const { pty, output, exited } = await startTerminal(id, `touch ${quote(inside)}; touch ${quote(marker)} 2>/dev/null || echo denied-outside; [ -t 0 ] && echo on-a-tty; echo ${done}`);
		const go = await stdio.confirmSandboxedTerminal(id, pty.pid);
		assert.strictEqual(await exists(inside), false, 'the shell did not run before the go line');
		pty.write(go);
		const code = await exited;
		assert.strictEqual(code, 0, output());
		assert.ok(output().includes(done), `it ran to the end: ${output()}`);
		assert.ok(output().includes('on-a-tty'), 'it has its terminal');
		assert.ok(output().includes('denied-outside'), output());
		assert.ok(await exists(inside), 'it wrote inside the workspace');
		assert.strictEqual(await exists(marker), false, 'no marker in the home folder');
	});

	test('F.6: a terminal whose go line never comes, or is wrong, runs nothing', async () => {
		const inside = join(ws, `gate-${counter++}`);
		const id = `term-gate-${counter++}`;
		const { pty, exited } = await startTerminal(id, `touch ${quote(inside)}`);
		await stdio.confirmSandboxedTerminal(id, pty.pid);
		// Typed input that is not the go line (a user keystroke, an agent's text) ends it.
		pty.write('touch-everything\r');
		assert.strictEqual(await exited, 125);
		assert.strictEqual(await exists(inside), false);
	});

	// The evidence is attested from outside (H7, ATTEST-*): Linux reads the sandbox's /proc status
	// beside bubblewrap's, macOS asks its helper (`sandbox_check`) about the ready line's process.
	test('F.6: a process that is not the launcher Volt prepared is not confirmed', async () => {
		const id = `term-forged-${counter++}`;
		const launch = await stdio.prepareSandboxedTerminal({ id, file: '/bin/sh', args: ['-c', 'true'], cwd: ws, env: {}, sandbox: chatSandbox(), context: chat(true, 'terminal') });
		const [fifo3, fifo4] = [launch.args[3], launch.args[4]];
		// Something else writes plausible evidence into the channels: no bubblewrap or Seatbelt, no sandbox.
		const forgery = process.platform === 'linux'
			? `printf 'NoNewPrivs:1 Seccomp:2\\n' > ${quote(fifo3)}; printf '{"child-pid": %s}\\n' "$$" > ${quote(fifo4)}; sleep 30`
			: `printf 'volt-sandbox-ready %s cred=denied\\n' "$$" > ${quote(fifo3)}; sleep 30`;
		const loaded = await import('node-pty') as unknown as { spawn?: typeof import('node-pty').spawn; default?: { spawn: typeof import('node-pty').spawn } };
		const spawn = loaded.spawn ?? loaded.default!.spawn;
		const forged = spawn('/bin/sh', ['-c', forgery], { name: 'xterm', cols: 80, rows: 24, cwd: ws, env: { PATH: '/usr/bin:/bin' } });
		try {
			await assert.rejects(stdio.confirmSandboxedTerminal(id, forged.pid), /could not be established/);
		} finally {
			await stdio.endSandboxedTerminal(id);
			forged.kill('SIGKILL');
		}
	});

	test('a terminal for a sandboxed chat without its sandbox is refused', async () => {
		await assert.rejects(stdio.prepareSandboxedTerminal({ id: 'term-none', file: '/bin/sh', args: ['-c', 'true'], cwd: ws, env: {}, sandbox: undefined as unknown as IVoltSandboxRequest, context: chat(true, 'terminal') }), VoltExecRefusedError);
	});
});
