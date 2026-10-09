/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentServerEventLog } from '../../common/eventLog.js';

suite('AgentServerEventLog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function seqs(decision: ReturnType<AgentServerEventLog['resume']>): number[] | string {
		return decision.kind === 'replay' ? decision.events.map(e => e.event.seq) : decision.reason;
	}

	test('numbers events contiguously from 1', () => {
		const log = new AgentServerEventLog('e1');
		assert.strictEqual(log.seq, 0);
		assert.strictEqual(log.append('col', { a: 1 }).event.seq, 1);
		assert.strictEqual(log.append('session', {}).event.seq, 2);
		assert.strictEqual(log.seq, 2);
		assert.deepStrictEqual(JSON.parse(log.append('server', 'x').text), { t: 'evt', seq: 3, topic: 'server', data: 'x' });
	});

	test('replays exactly the events after the cursor', () => {
		const log = new AgentServerEventLog('e1');
		for (let i = 0; i < 5; i++) {
			log.append('col', i);
		}
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 2 })), [3, 4, 5]);
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 0 })), [1, 2, 3, 4, 5]);
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 5 })), []);
	});

	test('asks for a snapshot without a cursor, across epochs, and for cursors from the future', () => {
		const log = new AgentServerEventLog('e2');
		log.append('col', 1);
		assert.strictEqual(seqs(log.resume(undefined)), 'none');
		assert.strictEqual(seqs(log.resume({ epoch: 'e1', seq: 1 })), 'epoch');
		assert.strictEqual(seqs(log.resume({ epoch: 'e2', seq: 7 })), 'ahead');
	});

	test('evicts by count and then asks for a snapshot past the buffer', () => {
		const log = new AgentServerEventLog('e1', { maxEvents: 3, maxBytes: Number.MAX_SAFE_INTEGER });
		for (let i = 0; i < 10; i++) {
			log.append('col', i);
		}
		assert.strictEqual(log.size, 3);
		assert.strictEqual(log.oldestSeq, 8);
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 7 })), [8, 9, 10]);
		assert.strictEqual(seqs(log.resume({ epoch: 'e1', seq: 6 })), 'evicted');
	});

	test('evicts by bytes but always keeps the newest event', () => {
		const log = new AgentServerEventLog('e1', { maxEvents: 1000, maxBytes: 100 });
		log.append('col', 'x'.repeat(40));
		log.append('col', 'y'.repeat(40));
		log.append('col', 'z'.repeat(500));
		assert.strictEqual(log.size, 1);
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 2 })), [3]);
		assert.strictEqual(seqs(log.resume({ epoch: 'e1', seq: 1 })), 'evicted');
	});

	test('stays correct across buffer compaction', () => {
		const log = new AgentServerEventLog('e1', { maxEvents: 50, maxBytes: Number.MAX_SAFE_INTEGER });
		for (let i = 0; i < 5000; i++) {
			log.append('col', i);
			if (i % 997 === 0) {
				const cursor = Math.max(0, log.seq - 10);
				const replay = log.resume({ epoch: 'e1', seq: cursor });
				assert.strictEqual(replay.kind, 'replay');
				assert.deepStrictEqual(seqs(replay), Array.from({ length: log.seq - cursor }, (_, k) => cursor + 1 + k));
			}
		}
		assert.strictEqual(log.size, 50);
		assert.deepStrictEqual(seqs(log.resume({ epoch: 'e1', seq: 4998 })), [4999, 5000]);
	});
});
