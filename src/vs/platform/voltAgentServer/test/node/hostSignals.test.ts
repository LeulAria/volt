/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { agentServerNodeFlags } from '../../node/agentServerLauncher.js';

interface IProbeReport {
	readonly inspector: string | null;
	readonly execArgv: string[];
	readonly child?: IProbeReport;
}

/**
 * Starts this Electron as Node (how volt-server runs) with `flags`, sends it SIGUSR1 once it is up,
 * and returns what it reports afterwards: whether an inspector is listening, for it and (when
 * `forkChild`) for a child it forked with the default execArgv, which also got SIGUSR1.
 * `--inspect-port=0` makes a SIGUSR1 that does open an inspector pick a free port.
 */
async function probe(flags: string[], forkChild: boolean): Promise<IProbeReport> {
	const dir = join(tmpdir(), `volt-host-sig-${generateUuid()}`);
	await fs.mkdir(dir, { recursive: true });
	try {
		const report = `() => ({ inspector: require('inspector').url() ?? null, execArgv: process.execArgv })`;
		await fs.writeFile(join(dir, 'child.cjs'), `
			process.send('up');
			process.on('message', () => { process.send((${report})()); process.exit(0); });
			setTimeout(() => process.exit(2), 15000);
		`);
		await fs.writeFile(join(dir, 'parent.cjs'), `
			const report = ${report};
			const done = child => { process.stdout.write('REPORT ' + JSON.stringify({ ...report(), child }) + '\\n'); process.exit(0); };
			if (${forkChild}) {
				const child = require('child_process').fork(${JSON.stringify(join(dir, 'child.cjs'))});
				child.once('message', () => {
					process.stdout.write('PIDS ' + process.pid + ' ' + child.pid + '\\n');
					process.stdin.once('data', () => { child.once('message', done); child.send('report'); });
				});
			} else {
				process.stdout.write('PIDS ' + process.pid + '\\n');
				process.stdin.once('data', () => done());
			}
			setTimeout(() => process.exit(2), 15000);
		`);
		const proc = spawn(process.execPath, [...flags, '--inspect-port=0', join(dir, 'parent.cjs')], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		proc.stderr.on('data', chunk => stderr += chunk);
		const exited = new Promise<number | null>(resolve => proc.once('exit', resolve));
		await new Promise<void>((resolve, reject) => {
			proc.stdout.on('data', chunk => {
				stdout += chunk;
				const pids = /PIDS ([\d ]+)\n/.exec(stdout);
				if (pids && !stdout.includes('SENT')) {
					stdout += 'SENT';
					for (const pid of pids[1].trim().split(' ')) {
						process.kill(Number(pid), 'SIGUSR1');
					}
					// Give a SIGUSR1 handler time to bring an inspector up before asking.
					setTimeout(() => { proc.stdin.write('report\n'); resolve(); }, 1000);
				}
			});
			proc.once('error', reject);
			exited.then(code => reject(new Error(`probe exited early with ${code}: ${stderr}`)));
		});
		const code = await exited;
		const line = /REPORT (.*)\n/.exec(stdout);
		assert.ok(line, `no report (exit ${code}): ${stdout} ${stderr}`);
		return JSON.parse(line[1]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

// SIGUSR1 doesn't exist on Windows.
(isWindows ? suite.skip : suite)('HOST-SIG-1: volt-server opens no inspector on SIGUSR1', function () {

	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('control: without the flag, SIGUSR1 opens an inspector (the probe can see one)', async () => {
		const report = await probe([], false);
		assert.ok(report.inspector, 'SIGUSR1 should have opened an inspector in a plain RUN_AS_NODE process');
	});

	test('the server and the children it forks get --disable-sigusr1 and stay closed', async () => {
		const flags = agentServerNodeFlags(false);
		assert.deepStrictEqual(flags, ['--disable-sigusr1']);
		const report = await probe(flags, true);
		assert.strictEqual(report.inspector, null);
		assert.ok(report.child, 'the forked child answered after SIGUSR1');
		assert.ok(report.child.execArgv.includes('--disable-sigusr1'), `child execArgv: ${report.child.execArgv.join(' ')}`);
		assert.strictEqual(report.child.inspector, null);
	});

	test('development keeps SIGUSR1 for debugging the server', () => {
		assert.deepStrictEqual(agentServerNodeFlags(true), []);
	});
});
