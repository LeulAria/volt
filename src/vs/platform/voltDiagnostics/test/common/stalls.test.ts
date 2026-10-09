/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IpcActivityRecorder } from '../../common/ipcActivity.js';
import { DriftStallDetector, formatStall, StallRateLimiter, stallTickInterval } from '../../common/stalls.js';
import { readStallThreshold } from '../../common/voltDiagnostics.js';

suite('Volt event-loop stalls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('threshold setting: default, off, floor', () => {
		assert.strictEqual(readStallThreshold(() => undefined), 300);
		assert.strictEqual(readStallThreshold(() => 0), 0);
		assert.strictEqual(readStallThreshold(() => -5), 0);
		assert.strictEqual(readStallThreshold(() => 10), 50);
		assert.strictEqual(readStallThreshold(() => 1200.4), 1200);
		assert.strictEqual(readStallThreshold(() => 'x'), 300);
	});

	test('tick interval follows the threshold within bounds', () => {
		assert.strictEqual(stallTickInterval(300), 100);
		assert.strictEqual(stallTickInterval(150), 50);
		assert.strictEqual(stallTickInterval(50), 20);
		assert.strictEqual(stallTickInterval(5000), 100);
	});

	test('a tick at least the threshold late is a stall; shorter delays are not', () => {
		const detector = new DriftStallDetector(300, 100, 0);
		assert.strictEqual(detector.tick(100), undefined, 'on time');
		assert.strictEqual(detector.tick(450), undefined, '250 ms late is under the threshold');
		assert.deepStrictEqual(detector.tick(550 + 300), { startTime: 550, durationMs: 300 }, 'exactly the threshold counts');
		assert.strictEqual(detector.tick(950), undefined, 'the next tick is measured from the late one');
		assert.deepStrictEqual(detector.tick(1050 + 1000), { startTime: 1050, durationMs: 1000 });
	});

	test('threshold 0 never reports', () => {
		const detector = new DriftStallDetector(0, 100, 0);
		assert.strictEqual(detector.tick(10_000), undefined);
	});

	test('rate limiter lets a burst through and counts the rest', () => {
		const limiter = new StallRateLimiter(2, 1000);
		assert.strictEqual(limiter.take(0), 0);
		assert.strictEqual(limiter.take(10), 0);
		assert.strictEqual(limiter.take(20), undefined);
		assert.strictEqual(limiter.take(30), undefined);
		assert.strictEqual(limiter.take(1000), 2, 'the first report of the next window says how many were held back');
		assert.strictEqual(limiter.take(1001), 0);
	});

	test('log line', () => {
		assert.strictEqual(
			formatStall({ process: 'main', startTime: 0, durationMs: 1012.4, attribution: [{ kind: 'ipc', detail: 'voltGit.snapshot', durationMs: 990 }], suppressed: 3 }),
			'Main process event loop stalled for 1012 ms while running voltGit.snapshot [ipc, 990 ms] (3 earlier stalls not logged)',
		);
		assert.strictEqual(
			formatStall({ process: 'renderer', windowId: 2, startTime: 0, durationMs: 400, blockingMs: 350, attribution: [] }),
			'Window 2 event loop stalled for 400 ms (350 ms blocking input)',
		);
	});
});

suite('Volt IPC activity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function channel(work: (command: string) => void): IServerChannel<string> {
		return {
			call: async <T>(_ctx: string, command: string): Promise<T> => { work(command); return command as T; },
			listen: () => Event.None,
		};
	}

	test('wrapped calls are timed and attributed to a stall they caused', async () => {
		let clock = 1000;
		const recorder = new IpcActivityRecorder(() => clock);
		const observed: string[] = [];
		const wrapped = recorder.wrapChannel('voltGit', channel(command => { if (command === 'snapshot') { clock += 800; } }), (ch, command) => observed.push(`${ch}.${command}`));
		assert.strictEqual(await wrapped.call('ctx', 'resolveRepo'), 'resolveRepo');
		clock += 50;
		await wrapped.call('ctx', 'snapshot');
		assert.deepStrictEqual(observed, ['voltGit.resolveRepo', 'voltGit.snapshot']);
		assert.deepStrictEqual(recorder.recent().map(r => [r.name, r.syncMs]), [['voltGit.resolveRepo', 0], ['voltGit.snapshot', 800]]);
		assert.deepStrictEqual(recorder.attribute(1050, 1850), [{ kind: 'ipc', detail: 'voltGit.snapshot', durationMs: 800 }]);
	});

	test('without a blocking call the last call before the stall is named', () => {
		const recorder = new IpcActivityRecorder(() => 0);
		recorder.record('storage.updateItems', 900, 1);
		assert.deepStrictEqual(recorder.attribute(1000, 1500), [{ kind: 'ipc', detail: 'storage.updateItems (last call, 100 ms before)' }]);
		assert.deepStrictEqual(recorder.attribute(5000, 5500), []);
	});

	test('instrument wraps channels registered afterwards and can be undone', async () => {
		const registered = new Map<string, IServerChannel<string>>();
		const server = { registerChannel: (name: string, ch: IServerChannel<string>) => { registered.set(name, ch); } };
		const recorder = new IpcActivityRecorder(() => 0);
		const restore = recorder.instrument(server);
		server.registerChannel('a', channel(() => { }));
		await registered.get('a')!.call('ctx', 'x');
		assert.deepStrictEqual(recorder.recent().map(r => r.name), ['a.x']);
		restore();
		const plain = channel(() => { });
		server.registerChannel('b', plain);
		assert.strictEqual(registered.get('b'), plain);
	});
});
