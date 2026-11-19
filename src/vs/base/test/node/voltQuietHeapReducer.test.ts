/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { FileAccess } from '../../common/network.js';
import { IQuietHeapHost, QUIET_HEAP_BUSY_RETRY_MS, QUIET_HEAP_FIRST_LOOK_MS, QUIET_HEAP_LOOK_MS, QUIET_HEAP_MAX_LOOK_MS, QUIET_HEAP_PROBE_MS, QUIET_HEAP_REGROWTH_BYTES, QuietHeapReducer, memoryReducingGc } from '../../node/voltQuietHeapReducer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

const MB = 1024 * 1024;

/** A process on a clock the test moves: its heap, its processor time and what a collection leaves. */
class FakeProcess implements IQuietHeapHost {
	time = 0;
	heap = 100 * MB;
	live = 50 * MB;
	/** Share of a core in use. */
	load = 0;
	collected: number[] = [];
	private cpu = 0;
	private readonly timers: { at: number; callback: () => void }[] = [];

	readonly gc = () => { this.collected.push(this.time); this.heap = this.live; };
	heapTotal(): number { return this.heap; }
	cpuMicros(): number { return this.cpu; }
	now(): number { return this.time; }
	setTimeout(callback: () => void, ms: number): unknown {
		const timer = { at: this.time + ms, callback };
		this.timers.push(timer);
		return timer;
	}
	clearTimeout(handle: unknown): void {
		const index = this.timers.indexOf(handle as { at: number; callback: () => void });
		if (index >= 0) {
			this.timers.splice(index, 1);
		}
	}
	get pending(): number { return this.timers.length; }

	advance(ms: number): void {
		const until = this.time + ms;
		for (; ;) {
			const next = this.timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!next) {
				break;
			}
			this.cpu += (next.at - this.time) * 1000 * this.load;
			this.time = next.at;
			this.timers.splice(this.timers.indexOf(next), 1);
			next.callback();
		}
		this.cpu += (until - this.time) * 1000 * this.load;
		this.time = until;
	}
}

suite('Quiet heap reducer: Node-side processes give startup garbage back (round 10)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a quiet process is collected once after the first look, and not again while its heap stays small', () => {
		const p = new FakeProcess();
		const reducer = new QuietHeapReducer(p);
		p.advance(QUIET_HEAP_FIRST_LOOK_MS + QUIET_HEAP_PROBE_MS - 1);
		assert.deepStrictEqual(p.collected, []);
		p.advance(1);
		assert.deepStrictEqual(p.collected, [QUIET_HEAP_FIRST_LOOK_MS + QUIET_HEAP_PROBE_MS]);
		assert.strictEqual(p.heap, 50 * MB);
		p.heap += QUIET_HEAP_REGROWTH_BYTES - 1;
		p.advance(60 * 60_000);
		assert.strictEqual(reducer.collections, 1);
		reducer.dispose();
	});

	test('a busy process is left alone and looked at again later', () => {
		const p = new FakeProcess();
		p.load = 0.5;
		const reducer = new QuietHeapReducer(p);
		p.advance(QUIET_HEAP_FIRST_LOOK_MS + QUIET_HEAP_PROBE_MS + 5 * QUIET_HEAP_BUSY_RETRY_MS);
		assert.deepStrictEqual(p.collected, [], 'no collection while the process works');
		p.load = 0.01;
		p.advance(QUIET_HEAP_BUSY_RETRY_MS + 2 * QUIET_HEAP_PROBE_MS);
		assert.strictEqual(reducer.collections, 1, 'collected once it went quiet');
		reducer.dispose();
	});

	test('a heap that grew again is collected at the next look; looks spread out while there is nothing to do', () => {
		const p = new FakeProcess();
		const reducer = new QuietHeapReducer(p);
		p.advance(QUIET_HEAP_FIRST_LOOK_MS + QUIET_HEAP_PROBE_MS);
		assert.strictEqual(reducer.collections, 1);
		// Nothing to do at the looks 1, 2 + 1, 4 + 2 + 1 ... minutes later: the wait doubles up to the maximum.
		p.advance(QUIET_HEAP_LOOK_MS + 2 * QUIET_HEAP_LOOK_MS + 4 * QUIET_HEAP_LOOK_MS + 8 * QUIET_HEAP_LOOK_MS);
		assert.strictEqual(reducer.collections, 1);
		p.heap += QUIET_HEAP_REGROWTH_BYTES;
		p.advance(QUIET_HEAP_MAX_LOOK_MS + QUIET_HEAP_PROBE_MS);
		assert.strictEqual(reducer.collections, 2);
		assert.strictEqual(p.heap, 50 * MB);
		// After a collection the next look is a minute away again.
		p.heap += QUIET_HEAP_REGROWTH_BYTES;
		p.advance(QUIET_HEAP_LOOK_MS + QUIET_HEAP_PROBE_MS);
		assert.strictEqual(reducer.collections, 3);
		reducer.dispose();
	});

	test('without a way to collect, and after dispose, nothing is scheduled', () => {
		const none = new FakeProcess();
		const reducer = new QuietHeapReducer({ ...none, gc: undefined, setTimeout: (c, ms) => none.setTimeout(c, ms), clearTimeout: h => none.clearTimeout(h), heapTotal: () => 0, cpuMicros: () => 0, now: () => 0 });
		assert.strictEqual(none.pending, 0);
		reducer.dispose();
		const p = new FakeProcess();
		const disposed = new QuietHeapReducer(p);
		disposed.dispose();
		p.advance(60 * 60_000);
		assert.deepStrictEqual(p.collected, []);
		assert.strictEqual(p.pending, 0);
	});

	test('an exposed gc is used as it is, with the collection that gives memory back', () => {
		const calls: unknown[] = [];
		memoryReducingGc({ gc: options => calls.push(options) })!();
		assert.deepStrictEqual(calls, [{ type: 'major', execution: 'sync', flavor: 'last-resort' }]);
	});

	test('in a process without --expose-gc: the young generation a burst grew is given back, and gc stays hidden', async function () {
		this.timeout(120_000);
		const module = FileAccess.asFileUri('vs/base/node/voltQuietHeapReducer.js').toString(true);
		const script = `
			const v8 = require('v8');
			const young = () => Math.round(v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space').space_size / 1048576);
			import(${JSON.stringify(module)}).then(({ memoryReducingGc }) => {
				const line = JSON.stringify({ text: 'x'.repeat(200), items: Array.from({ length: 50 }, (_, i) => ({ i, t: 'tok' + i })) });
				let kept = [];
				for (let i = 0; i < 150000; i++) { const o = JSON.parse(line); if (i % 50 === 0) { kept.push(o); } if (kept.length > 2000) { kept = kept.slice(1000); } }
				const grown = young();
				const gc = memoryReducingGc();
				gc();
				const hidden = typeof globalThis.gc === 'undefined' && require('vm').runInNewContext('typeof gc') === 'undefined';
				process.stdout.write(JSON.stringify({ grown, after: young(), hidden }));
			});
		`;
		const out = await new Promise<string>((resolve, reject) => {
			// process.execPath is Electron's binary under the Electron test runner: run as Node, as the processes are.
			execFile(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 }, (err, stdout, stderr) => err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout));
		});
		const result = JSON.parse(out) as { grown: number; after: number; hidden: boolean };
		assert.ok(result.grown >= 8, `the burst grew the young generation (${result.grown} MB)`);
		assert.ok(result.after <= 2, `the collection gave it back (${result.after} MB left)`);
		assert.ok(result.hidden, 'gc is not visible to anything else in the process');
	});
});
