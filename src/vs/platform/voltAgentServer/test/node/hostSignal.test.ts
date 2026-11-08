/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { agentServerProgram } from '../../node/agentServerLauncher.js';

/** Stands in for the server's entry: prints its Node version once up, then idles. */
const ENTRY = 'process.stdout.write(`ready ${process.versions.node}\\n`); setInterval(() => { }, 1000);\n';

interface IStarted {
	readonly child: ChildProcess;
	readonly node: string;
	stderr(): string;
}

function start(program: readonly string[]): Promise<IStarted> {
	// process.execPath is Electron's binary under the Electron test runner; this makes it run as Node, as the launcher does.
	const child = spawn(program[0], program.slice(1), { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr!.on('data', chunk => stderr += chunk);
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.stdout!.once('data', chunk => resolve({ child, node: /ready (\S+)/.exec(String(chunk))?.[1] ?? '', stderr: () => stderr }));
	});
}

/** TCP sockets the process listens on, from `lsof` (nothing when it listens on none). */
function listening(pid: number): Promise<string> {
	return new Promise(resolve => execFile('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], (_error, stdout) => resolve(String(stdout).trim())));
}

async function signalAndInspect(started: IStarted): Promise<{ alive: boolean; listens: string; stderr: string }> {
	process.kill(started.child.pid!, 'SIGUSR1');
	await new Promise(resolve => setTimeout(resolve, 1500));
	return { alive: started.child.exitCode === null && started.child.signalCode === null, listens: await listening(started.child.pid!), stderr: started.stderr() };
}

(process.platform === 'win32' ? suite.skip : suite)('Volt agent server: no inspector by signal (HOST-SIG-1, INV-30)', function () {

	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let entry: string;
	const children: ChildProcess[] = [];

	suiteSetup(async () => {
		dir = join(tmpdir(), `volt-host-sig-${generateUuid()}`);
		await fs.mkdir(dir, { recursive: true });
		entry = join(dir, 'server.js');
		await fs.writeFile(entry, ENTRY);
	});

	teardown(() => {
		for (const child of children.splice(0)) {
			child.kill('SIGKILL');
		}
	});

	suiteTeardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('HOST-SIG-1: SIGUSR1 to volt-server opens no inspector and changes no listener', async () => {
		const program = agentServerProgram(process.execPath, entry, join(dir, 'data'), false, {});
		assert.ok(program.includes('--disable-sigusr1'));
		assert.ok(program.indexOf('--disable-sigusr1') < program.indexOf(entry), 'a Node option goes before the entry');
		const started = await start(program);
		children.push(started.child);
		assert.match(started.node, /^\d+\.\d+\.\d+$/);
		const before = await listening(started.child.pid!);
		const after = await signalAndInspect(started);
		assert.ok(after.alive, 'the server survives the signal');
		assert.doesNotMatch(after.stderr, /Debugger listening|Starting inspector/);
		assert.strictEqual(after.listens, before);
		assert.strictEqual(after.listens, '');
	});

	test('control: the same signal does open an inspector without the flag (the test can see one)', async () => {
		const program = agentServerProgram(process.execPath, entry, join(dir, 'data'), false, { VSCODE_DEV: '1', VOLT_AGENT_SERVER_INSPECT: '1' });
		assert.ok(!program.includes('--disable-sigusr1'), 'only a build from sources that asks keeps the signal');
		const started = await start(program);
		children.push(started.child);
		const after = await signalAndInspect(started);
		assert.match(after.stderr, /Debugger listening|Starting inspector/);
	});
});
