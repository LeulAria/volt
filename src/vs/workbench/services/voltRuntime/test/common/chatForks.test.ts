/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeBackNotice, turnsThroughId } from '../../common/orchestration/chatForks.js';

suite('chatForks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('turnsThroughId keeps the turn and everything before it', () => {
		const turns = ['t1', 't2', 't3'];
		assert.strictEqual(turnsThroughId(turns, 't1'), 1);
		assert.strictEqual(turnsThroughId(turns, 't3'), 3);
		assert.strictEqual(turnsThroughId(turns, 'missing'), 0);
		assert.strictEqual(turnsThroughId([], 't1'), 0);
	});

	test('mergeBackNotice names the fork, its changes and the outcome', () => {
		const text = mergeBackNotice({
			forkId: 'agent-1', forkTitle: 'Try retry', forkedAtTurns: 2,
			diffStat: ' math.js | 4 ++--\n 1 file changed', reply: 'Added retries.',
			outcome: { kind: 'merged', commit: 'abc1234' },
		});
		assert.ok(text.startsWith('[Volt] Merged back from "Try retry" (thread agent-1), which was forked from this chat at turn 2.'));
		assert.ok(text.includes('Changes since the fork:\nmath.js | 4 ++--'));
		assert.ok(text.includes('merged into this checkout as commit abc1234'));
		assert.ok(text.endsWith('Its last reply:\nAdded retries.'));
	});

	test('mergeBackNotice says when the fork changed nothing and omits an empty reply', () => {
		const text = mergeBackNotice({
			forkId: 'agent-2', forkTitle: 'Idle', forkedAtTurns: 1, diffStat: '  ', reply: '  ',
			outcome: { kind: 'summary' },
		});
		assert.ok(text.includes('It made no file changes since the fork.'));
		assert.ok(text.includes('thread_merge_back with apply true'));
		assert.ok(!text.includes('Its last reply'));
	});

	test('mergeBackNotice says a shared checkout needs no merge and a merge with no new commits changed nothing', () => {
		const base = { forkId: 'agent-4', forkTitle: 'Same', forkedAtTurns: 1, diffStat: ' a.ts | 2 +-', reply: undefined };
		assert.ok(mergeBackNotice({ ...base, outcome: { kind: 'shared' } }).includes('its changes are already here'));
		assert.ok(mergeBackNotice({ ...base, outcome: { kind: 'nothing' } }).includes('no commits to merge beyond the fork point'));
	});

	test('mergeBackNotice reports conflicts and failures without claiming a merge', () => {
		const base = { forkId: 'agent-3', forkTitle: 'X', forkedAtTurns: 1, diffStat: 'a | 1', reply: undefined };
		const conflict = mergeBackNotice({ ...base, outcome: { kind: 'conflict' } });
		assert.ok(conflict.includes('so nothing changed here'));
		const failed = mergeBackNotice({ ...base, outcome: { kind: 'failed', reason: 'index is locked' } });
		assert.ok(failed.includes('Merging failed: index is locked'));
		assert.ok(!failed.includes('merged into this checkout'));
	});
});
