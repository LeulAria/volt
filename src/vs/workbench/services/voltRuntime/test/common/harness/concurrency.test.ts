/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ConcurrencyManager } from '../../../common/harness/concurrency.js';

suite('Volt concurrency manager', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs a job and reports timing', async () => {
		const gate = new ConcurrencyManager({ limit: 1, defaultTimeoutMs: 1_000 });
		const { result } = gate.enqueue({ priority: 'normal', timeoutMs: 1_000, run: () => 42 });
		const done = await result;
		assert.strictEqual(done.status, 'done');
		assert.strictEqual(done.value, 42);
	});

	test('high priority jumps the queue', async () => {
		const order: string[] = [];
		let release!: () => void;
		const hold = new Promise<void>(resolve => { release = resolve; });
		const gate = new ConcurrencyManager({ limit: 1, maxQueue: 8 });

		const first = gate.enqueue({
			id: 'hold',
			priority: 'normal',
			timeoutMs: 2_000,
			run: async () => { await hold; order.push('hold'); },
		});
		const low = gate.enqueue({
			id: 'low',
			priority: 'low',
			timeoutMs: 2_000,
			run: () => { order.push('low'); },
		});
		const high = gate.enqueue({
			id: 'high',
			priority: 'high',
			timeoutMs: 2_000,
			run: () => { order.push('high'); },
		});

		release();
		await Promise.all([first.result, low.result, high.result]);
		assert.deepStrictEqual(order, ['hold', 'high', 'low']);
	});

	test('cancel prevents a queued job from starting', async () => {
		let release!: () => void;
		const hold = new Promise<void>(resolve => { release = resolve; });
		const gate = new ConcurrencyManager({ limit: 1 });
		const running = gate.enqueue({
			id: 'run',
			priority: 'normal',
			timeoutMs: 2_000,
			run: async () => { await hold; },
		});
		const queued = gate.enqueue({
			id: 'skip',
			priority: 'normal',
			timeoutMs: 2_000,
			run: () => { throw new Error('should not run'); },
		});
		assert.strictEqual(gate.cancel('skip'), true);
		release();
		assert.strictEqual((await queued.result).status, 'cancelled');
		assert.strictEqual((await running.result).status, 'done');
	});

	test('backpressure refuses another enqueue', () => {
		const gate = new ConcurrencyManager({ limit: 1, maxQueue: 1 });
		let release!: () => void;
		const hold = new Promise<void>(resolve => { release = resolve; });
		gate.enqueue({ priority: 'normal', timeoutMs: 2_000, run: async () => { await hold; } });
		gate.enqueue({ priority: 'normal', timeoutMs: 2_000, run: () => undefined });
		assert.throws(() => gate.enqueue({ priority: 'normal', timeoutMs: 2_000, run: () => undefined }));
		release();
	});
});
