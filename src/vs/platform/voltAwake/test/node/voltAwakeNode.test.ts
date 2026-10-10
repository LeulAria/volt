/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { parseKeyValues } from '../../common/voltAwake.js';
import { DarwinLidBackend, RECOVERY_SCRIPT } from '../../node/awakeDarwin.js';
import { AwakeExec, IExecResult } from '../../node/awakeExec.js';
import { AwakeRegistry, IAwakeHolder, IAwakeProcessProbe } from '../../node/awakeRegistry.js';

const DEAD_PID = 2_000_000_000;
const OTHER_PID = 1_999_999_999;

function fakeProbe(alive: Set<number>, started: Record<number, string> = {}): IAwakeProcessProbe {
	return {
		startedOf: async pid => started[pid] ?? 'started-self',
		bootId: async () => 'boot-1',
		isAlive: pid => pid === process.pid || alive.has(pid),
	};
}

function holder(pid: number, overrides: Partial<IAwakeHolder> = {}): IAwakeHolder {
	return { pid, started: `started-${pid}`, boot: 'boot-1', deadline: Math.floor(Date.now() / 1000) + 600, lid: true, owner: 'volt', ...overrides };
}

async function tempDir(): Promise<string> {
	return fs.mkdtemp(join(tmpdir(), 'volt-awake-'));
}

suite('Volt awake registry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => dir = await tempDir());
	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	test('holders: dead, reused, rebooted and expired ones are removed; live ones stay', async () => {
		const registry = new AwakeRegistry(join(dir, 'awake'), fakeProbe(new Set([OTHER_PID, 77, 78]), { [OTHER_PID]: `started-${OTHER_PID}`, 77: 'someone else now', 78: 'started-78' }));
		await registry.writeHolder(holder(OTHER_PID));
		await registry.writeHolder(holder(DEAD_PID));
		await registry.writeHolder(holder(77));
		await registry.writeHolder(holder(78, { boot: 'boot-0' }));
		await registry.writeHolder(holder(process.pid, { deadline: Math.floor(Date.now() / 1000) - 1 }));
		const live = await registry.liveHolders();
		assert.deepStrictEqual(live.map(h => h.pid), [OTHER_PID]);
		assert.deepStrictEqual((await registry.readHolders()).map(h => h.pid), [OTHER_PID]);
	});

	test('changes are journaled and cleared; the file goes with the last one', async () => {
		const registry = new AwakeRegistry(join(dir, 'awake'), fakeProbe(new Set()));
		await registry.setChange('darwinSleepDisabled', '1');
		await registry.setChange('win32Lid', 'guid,1,1');
		assert.deepStrictEqual(await registry.readChanges(), new Map([['darwinSleepDisabled', '1'], ['win32Lid', 'guid,1,1']]));
		await registry.setChange('darwinSleepDisabled', undefined);
		await registry.setChange('win32Lid', undefined);
		await assert.rejects(fs.stat(join(dir, 'awake', 'changes')));
	});

	test('the lock serializes callers and a dead owner\'s lock is taken over', async () => {
		const registry = new AwakeRegistry(join(dir, 'awake'), fakeProbe(new Set()));
		const order: string[] = [];
		await Promise.all([1, 2, 3].map(n => registry.withLock(async () => {
			order.push(`in${n}`);
			await new Promise(resolve => setTimeout(resolve, 10));
			order.push(`out${n}`);
		})));
		for (let i = 0; i < order.length; i += 2) {
			assert.strictEqual(order[i].replace('in', ''), order[i + 1].replace('out', ''), `no overlap: ${order.join(' ')}`);
		}
		await fs.mkdir(join(dir, 'awake', 'lock.d'));
		await fs.writeFile(join(dir, 'awake', 'lock.d', 'pid'), String(DEAD_PID));
		assert.strictEqual(await registry.withLock(async () => 'taken'), 'taken');
	});
});

/** pmset/sudo/launchctl/ioreg as a fake Mac that records what it was asked. */
class FakeMac {
	sleepDisabled = false;
	granted = true;
	loaded = false;
	failDisable = false;
	readonly calls: string[] = [];
	/** What the journal said each time `disablesleep 1` ran. */
	readonly journalAtDisable: string[] = [];

	constructor(private readonly registry: () => AwakeRegistry) { }

	readonly exec: AwakeExec = async (file, args) => {
		const line = [file, ...args].join(' ');
		this.calls.push(line);
		const ok = (stdout = ''): IExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
		const fail = (stderr = ''): IExecResult => ({ code: 1, stdout: '', stderr, timedOut: false });
		if (file === '/usr/sbin/ioreg') {
			return ok('  "AppleClamshellState" = No\n');
		}
		if (file === '/usr/bin/pmset' && args[0] === '-g') {
			return ok(` SleepDisabled\t\t${this.sleepDisabled ? 1 : 0}\n`);
		}
		if (file === '/usr/bin/pmset' && args[0] === 'displaysleepnow') {
			return ok();
		}
		if (file === '/usr/bin/sudo' && args[1] === '-l') {
			return this.granted ? ok('/usr/bin/pmset -a disablesleep 1\n') : fail('sudo: a password is required');
		}
		if (file === '/usr/bin/sudo' && args.includes('disablesleep')) {
			if (!this.granted) {
				return fail('sudo: a password is required');
			}
			const value = args[args.length - 1] === '1';
			if (value) {
				this.journalAtDisable.push(JSON.stringify([...(await this.registry().readChanges())]));
				if (this.failDisable) {
					return fail('pmset: failed');
				}
			}
			this.sleepDisabled = value;
			return ok();
		}
		if (file === '/bin/launchctl') {
			if (args[0] === 'print') {
				return this.loaded ? ok() : fail('Could not find service');
			}
			if (args[0] === 'bootstrap') {
				this.loaded = true;
			}
			return ok();
		}
		return fail(`unexpected: ${line}`);
	};

	count(fragment: string): number {
		return this.calls.filter(call => call.includes(fragment)).length;
	}
}

suite('Volt awake macOS backend', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => dir = await tempDir());
	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	function create(alive = new Set<number>()) {
		const registry = new AwakeRegistry(join(dir, 'awake'), fakeProbe(alive));
		const mac = new FakeMac(() => registry);
		const backend = new DarwinLidBackend({ exec: mac.exec, registry, probe: fakeProbe(alive), log: new NullLogService(), owner: 'volt' }, { launchAgentsDir: join(dir, 'LaunchAgents'), caffeinate: false });
		return { registry, mac, backend };
	}

	test('hold: the journal and the recovery agent come first, then sleep goes off; release turns it back on', async () => {
		const { registry, mac, backend } = create();
		assert.deepStrictEqual(await backend.probe(), { kind: 'ready' });
		assert.strictEqual(await backend.hold({ kind: 'ready' }), true);
		assert.strictEqual(mac.sleepDisabled, true);
		assert.deepStrictEqual(mac.journalAtDisable, [JSON.stringify([['darwinSleepDisabled', '1']])]);
		assert.strictEqual(mac.loaded, true, 'recovery agent loaded before the change');
		assert.ok(mac.calls.findIndex(c => c.includes('bootstrap')) < mac.calls.findIndex(c => c.includes('disablesleep 1') && !c.includes('-l')));
		const plist = await fs.readFile(join(dir, 'LaunchAgents', 'dev.volt.lid-closed-mode.plist'), 'utf8');
		assert.ok(plist.includes('<integer>60</integer>') && plist.includes('recovery.sh'));
		assert.strictEqual(await fs.readFile(join(dir, 'awake', 'recovery.sh'), 'utf8'), RECOVERY_SCRIPT);

		assert.strictEqual(await backend.hold({ kind: 'ready' }), true);
		assert.strictEqual(mac.count('disablesleep 1'), 2, 'a second hold changes nothing (one -l probe, one disable)');

		await backend.release();
		assert.strictEqual(mac.sleepDisabled, false);
		assert.deepStrictEqual(await registry.readChanges(), new Map());
		assert.deepStrictEqual(await registry.readHolders(), []);
		backend.dispose();
	});

	test('release leaves sleep off while another live Volt process still holds the lid', async () => {
		const { registry, mac, backend } = create(new Set([OTHER_PID]));
		await backend.hold({ kind: 'ready' });
		await registry.writeHolder(holder(OTHER_PID, { started: 'started-self' }));
		await backend.release();
		assert.strictEqual(mac.sleepDisabled, true);
		assert.ok((await registry.readChanges()).has('darwinSleepDisabled'));
		backend.dispose();
	});

	test('startup recovery undoes what a dead process left; a foreign setting is never touched', async () => {
		const { registry, mac, backend } = create();
		mac.sleepDisabled = true;
		assert.strictEqual((await backend.probe()).kind, 'foreign', 'sleep off but not in our journal: someone else did it');
		assert.strictEqual(await backend.hold({ kind: 'ready' }), false);
		await backend.reconcile();
		assert.strictEqual(mac.sleepDisabled, true, 'foreign: left alone');

		await registry.setChange('darwinSleepDisabled', '1');
		await registry.writeHolder(holder(DEAD_PID));
		await backend.reconcile();
		assert.strictEqual(mac.sleepDisabled, false);
		assert.deepStrictEqual(await registry.readChanges(), new Map());
		assert.deepStrictEqual(await registry.readHolders(), []);
		backend.dispose();
	});

	test('without the approval nothing runs as root, and a failed pmset leaves nothing journaled', async () => {
		const { registry, mac, backend } = create();
		mac.granted = false;
		assert.strictEqual((await backend.probe()).kind, 'needsSetup');
		assert.strictEqual(await backend.hold({ kind: 'needsSetup', detail: '' }), false);
		assert.strictEqual(mac.count('disablesleep 1') - mac.count('-l'), 0);

		mac.granted = true;
		mac.failDisable = true;
		await assert.rejects(backend.hold({ kind: 'ready' }), /Could not turn off lid-close sleep/);
		assert.deepStrictEqual(await registry.readChanges(), new Map());
		assert.deepStrictEqual(await registry.readHolders(), []);
		backend.dispose();
	});
});

// sh, ps and the fake sudo need a POSIX system.
if (process.platform !== 'win32') {
suite('Volt awake recovery script', () => {

	let home: string;
	let bin: string;
	setup(async () => {
		home = await tempDir();
		bin = join(home, 'bin');
		await fs.mkdir(join(home, '.volt', 'awake', 'holders'), { recursive: true });
		await fs.mkdir(bin);
		// A fake sudo that records its arguments instead of running pmset.
		await fs.writeFile(join(bin, 'sudo'), `#!/bin/sh\necho "$@" >> "${join(home, 'sudo.log')}"\nexit 0\n`, { mode: 0o755 });
		await fs.writeFile(join(home, '.volt', 'awake', 'recovery.sh'), RECOVERY_SCRIPT, { mode: 0o700 });
		await fs.writeFile(join(home, '.volt', 'awake', 'changes'), 'darwinSleepDisabled=1\nwin32Lid=x,1,1\n');
	});
	teardown(() => fs.rm(home, { recursive: true, force: true }));

	const run = () => new Promise<void>((resolve, reject) => execFile('/bin/sh', [join(home, '.volt', 'awake', 'recovery.sh')], { env: { HOME: home, VOLT_AWAKE_TEST_PATH: bin } }, err => err ? reject(err) : resolve()));
	const sudoLog = () => fs.readFile(join(home, 'sudo.log'), 'utf8').catch(() => '');
	const lstart = (pid: number) => new Promise<string>(resolve => execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' } }, (_err, stdout) => resolve(stdout.trim().replace(/\s+/g, ' '))));
	const writeHolder = (pid: number, started: string, deadline = Math.floor(Date.now() / 1000) + 600) =>
		fs.writeFile(join(home, '.volt', 'awake', 'holders', String(pid)), `pid=${pid}\nstarted=${started}\nboot=\ndeadline=${deadline}\nlid=1\nowner=volt\n`);

	test('a live holder keeps sleep off; once it is gone, sleep goes back on and the journal is cleared', async () => {
		await writeHolder(process.pid, await lstart(process.pid));
		await run();
		assert.strictEqual(await sudoLog(), '', 'the live holder (this test process) keeps it');

		const exited = spawn('/bin/sh', ['-c', 'exit 0']);
		await new Promise(resolve => exited.on('exit', resolve));
		await fs.rm(join(home, '.volt', 'awake', 'holders', String(process.pid)));
		await writeHolder(exited.pid!, 'Thu Jan 1 00:00:00 1970');
		await run();
		assert.strictEqual((await sudoLog()).trim(), '-n /usr/bin/pmset -a disablesleep 0');
		assert.deepStrictEqual(parseKeyValues(await fs.readFile(join(home, '.volt', 'awake', 'changes'), 'utf8')), new Map([['win32Lid', 'x,1,1']]), 'only its own line goes');
		assert.deepStrictEqual(await fs.readdir(join(home, '.volt', 'awake', 'holders')), [], 'the dead holder is removed');
	});

	test('a holder whose pid now belongs to another process, or whose deadline passed, does not count', async () => {
		await writeHolder(process.pid, 'Thu Jan 1 00:00:00 1970');
		await run();
		assert.strictEqual((await sudoLog()).trim(), '-n /usr/bin/pmset -a disablesleep 0');

		await fs.writeFile(join(home, '.volt', 'awake', 'changes'), 'darwinSleepDisabled=1\n');
		await fs.rm(join(home, 'sudo.log'));
		await writeHolder(process.pid, await lstart(process.pid), Math.floor(Date.now() / 1000) - 5);
		await run();
		assert.strictEqual((await sudoLog()).trim(), '-n /usr/bin/pmset -a disablesleep 0');
		await assert.rejects(fs.stat(join(home, '.volt', 'awake', 'changes')), 'the last line takes the file with it');
	});

	test('nothing journaled: nothing to do', async () => {
		await fs.rm(join(home, '.volt', 'awake', 'changes'));
		await run();
		assert.strictEqual(await sudoLog(), '');
	});
});
}
