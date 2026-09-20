/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	compact, estimateTokens, IContextItem, messageTokens, needsCompaction,
	packContext, SummaryLadder, totalTokens, usableTokens,
} from '../../../common/harness/contextEngine.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';

suite('Volt context engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('estimation', () => {
		test('scales with length and is zero for nothing', () => {
			assert.strictEqual(estimateTokens(''), 0);
			assert.ok(estimateTokens('x'.repeat(350)) >= 100);
			assert.ok(estimateTokens('x'.repeat(700)) > estimateTokens('x'.repeat(350)));
		});

		test('charges for tool call arguments, not just content', () => {
			const plain: INativeLoopMessage = { role: 'assistant', content: 'ok' };
			const withCall: INativeLoopMessage = {
				role: 'assistant',
				content: 'ok',
				toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'src/a.ts', content: 'x'.repeat(400) } }],
			};
			assert.ok(messageTokens(withCall) > messageTokens(plain) + 100);
		});

		test('totals across messages', () => {
			const messages: INativeLoopMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
			assert.strictEqual(totalTokens(messages), messageTokens(messages[0]) + messageTokens(messages[1]));
		});
	});

	suite('budgeting', () => {
		test('holds back room for the reply and the tool schemas', () => {
			assert.strictEqual(usableTokens({ total: 100_000, reserveOutput: 4_000, reserveTools: 1_000 }), 95_000);
			assert.ok(usableTokens({ total: 100_000 }) < 100_000);
		});

		test('keeps pinned items regardless of budget', () => {
			const packed = packContext([
				item('goal', 'goal', 'x'.repeat(40_000), 100, true),
				item('history', 'history', 'y'.repeat(40_000), 50),
			], { total: 2_000, reserveOutput: 100, reserveTools: 100 });
			assert.deepStrictEqual(packed.items.map(i => i.id), ['goal']);
			assert.deepStrictEqual(packed.dropped.map(i => i.id), ['history']);
		});

		test('gives every channel its best item before any channel gets a second', () => {
			// Three items of 700 tokens into a 2000-token window. A flat priority sort would take
			// the two history items; round-robin takes the best of each channel first.
			const packed = packContext([
				item('h1', 'history', 'a'.repeat(2_450), 90),
				item('h2', 'history', 'b'.repeat(2_450), 80),
				item('f1', 'files', 'c'.repeat(2_450), 10),
			], { total: 2_000, reserveOutput: 0, reserveTools: 0 });
			assert.deepStrictEqual(packed.items.map(i => i.id).sort(), ['f1', 'h1']);
			assert.deepStrictEqual(packed.dropped.map(i => i.id), ['h2']);
		});

		test('caps a channel so the transcript cannot eat the window', () => {
			const many = Array.from({ length: 40 }, (_, index) => item(`h${index}`, 'history', 'x'.repeat(1_400), 100 - index));
			const packed = packContext(many, { total: 10_000, reserveOutput: 100, reserveTools: 100 });
			assert.ok(packed.dropped.length > 0, 'the history cap should have dropped something');
			assert.ok(packed.tokensUsed <= packed.tokensAvailable * 0.7 + 1, 'history must stay inside its share');
		});

		test('takes the highest priority first within a channel', () => {
			const packed = packContext([
				item('low', 'files', 'x'.repeat(2_450), 1),
				item('high', 'files', 'y'.repeat(2_450), 99),
			], { total: 2_000, reserveOutput: 0, reserveTools: 0 });
			assert.deepStrictEqual(packed.items.map(i => i.id), ['high']);
		});

		test('reports pressure as the share of the window consumed', () => {
			const empty = packContext([], { total: 10_000, reserveOutput: 0, reserveTools: 0 });
			assert.strictEqual(empty.pressure, 0);

			const full = packContext([item('a', 'files', 'x'.repeat(30_000), 1)], { total: 10_000, reserveOutput: 0, reserveTools: 0 });
			assert.strictEqual(full.items.length, 0, 'an item larger than the window cannot be packed');
			assert.strictEqual(full.dropped.length, 1);
		});
	});

	suite('compaction', () => {
		test('leaves a transcript that already fits alone', () => {
			const messages = conversation(4);
			const result = compact(messages, { maxTokens: 100_000 });
			assert.strictEqual(result.compacted, false);
			assert.strictEqual(result.droppedMessages, 0);
			assert.deepStrictEqual(result.messages, messages);
		});

		test('trips only past the pressure threshold, not at the limit', () => {
			const messages = conversation(4);
			const tokens = totalTokens(messages);
			assert.strictEqual(needsCompaction(messages, tokens * 2), false);
			assert.strictEqual(needsCompaction(messages, tokens), true);
			assert.strictEqual(needsCompaction(messages, 10_000, 9_000), true, 'measured usage wins over the heuristic');
			assert.strictEqual(needsCompaction(messages, 10_000, 100), false);
		});

		test('prunes old tool results in the middle before summarizing', () => {
			const oldTools: INativeLoopMessage[] = Array.from({ length: 12 }, (_, index): INativeLoopMessage => ({
				role: 'tool',
				content: 'z'.repeat(8_000),
				callId: `old${index}`,
				name: 'read_file',
			}));
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 'system' },
				{ role: 'user', content: 'goal' },
				...oldTools,
				{ role: 'user', content: 'keep going' },
				{ role: 'assistant', content: 'still working' },
			];
			const result = compact(messages, { maxTokens: 6_000, keepRecent: 2 });
			assert.ok(result.stages.includes('prune-results') || result.stages.includes('shrink-results'));
			assert.ok(result.tokensAfter < result.tokensBefore);
		});

		test('shrinks a huge tool result before touching any conversation', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 'system' },
				{ role: 'user', content: 'find the bug' },
				{ role: 'assistant', content: 'reading' },
				{ role: 'tool', content: 'x'.repeat(200_000), callId: 'c1', name: 'read_file' },
				{ role: 'assistant', content: 'found it' },
			];
			const result = compact(messages, { maxTokens: 20_000 });
			assert.strictEqual(result.compacted, true);
			assert.deepStrictEqual(result.stages, ['shrink-results']);
			assert.strictEqual(result.droppedMessages, 0);
			assert.strictEqual(result.messages.length, messages.length, 'no message should be removed');
			assert.ok(result.tokensAfter <= 20_000);
		});

		test('never drops the system prompt or the original request', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 'you are volt' },
				{ role: 'user', content: 'migrate the schema' },
				...conversation(60),
			];
			const result = compact(messages, { maxTokens: 2_000 });
			assert.strictEqual(result.messages[0].content, 'you are volt');
			assert.strictEqual(result.messages[1].content, 'migrate the schema');
		});

		test('keeps the most recent exchange verbatim', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 'system' },
				{ role: 'user', content: 'goal' },
				...conversation(80),
				{ role: 'assistant', content: 'the very last thing I said' },
			];
			const result = compact(messages, { maxTokens: 3_000 });
			assert.strictEqual(result.messages[result.messages.length - 1].content, 'the very last thing I said');
		});

		test('summarizes the middle and says what was already tried', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 'system' },
				{ role: 'user', content: 'goal' },
				{ role: 'assistant', content: 'looking', toolCalls: [{ id: 'c1', name: 'grep', args: { pattern: 'x' } }] },
				{ role: 'tool', content: 'z'.repeat(60_000), callId: 'c1', name: 'grep' },
				{ role: 'user', content: 'also update the docs' },
				{ role: 'assistant', content: 'the schema lives in db/schema.sql' },
				...conversation(40),
			];
			const result = compact(messages, { maxTokens: 900, carryOver: 'Changed: src/a.ts' });
			assert.ok(result.stages.includes('summarize'));
			assert.ok(result.summary);
			assert.ok(/Tools already used: grep/.test(result.summary));
			assert.ok(/also update the docs/.test(result.summary));
			assert.ok(/Changed: src\/a\.ts/.test(result.summary), 'the evidence digest should survive compaction');
			assert.ok(/Do not redo work/.test(result.summary));
		});

		test('drops from the front of the recent window as a last resort', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 's'.repeat(400) },
				{ role: 'user', content: 'goal' },
				...conversation(30),
			];
			const result = compact(messages, { maxTokens: 300 });
			assert.ok(result.stages.includes('drop'));
			assert.ok(result.droppedMessages > 0);
			assert.strictEqual(result.messages[0].role, 'system');
		});

		test('always leaves at least the last message standing', () => {
			const messages: INativeLoopMessage[] = [
				{ role: 'system', content: 's'.repeat(4_000) },
				{ role: 'user', content: 'goal' },
				...conversation(20),
			];
			const result = compact(messages, { maxTokens: 10 });
			assert.ok(result.messages.length >= 3, 'system, goal, and one tail message');
		});
	});

	suite('hierarchical summaries', () => {
		test('folds three summaries into one of the next level', () => {
			const ladder = new SummaryLadder();
			ladder.add('[first] read the parser', 10, 1);
			ladder.add('[second] tried a fix', 10, 2);
			assert.strictEqual(ladder.all().length, 2);

			ladder.add('[third] reverted it', 10, 3);
			const folded = ladder.all();
			assert.strictEqual(folded.length, 1);
			assert.strictEqual(folded[0].level, 1);
			assert.strictEqual(folded[0].coversMessages, 30);
			assert.ok(/Condensed account of 30 earlier turns/.test(folded[0].text));
		});

		test('stays logarithmic rather than growing with the run', () => {
			const ladder = new SummaryLadder();
			for (let i = 0; i < 27; i++) {
				ladder.add(`summary ${i}`, 10, i);
			}
			assert.ok(ladder.all().length <= 3, `expected at most 3 layers, got ${ladder.all().length}`);
			assert.strictEqual(ladder.all().reduce((total, layer) => total + layer.coversMessages, 0), 270);
		});

		test('ignores an empty summary', () => {
			const ladder = new SummaryLadder();
			ladder.add('   ', 5);
			assert.strictEqual(ladder.all().length, 0);
			assert.strictEqual(ladder.text(), '');
		});
	});
});

function item(id: string, channel: IContextItem['channel'], text: string, priority: number, pinned = false): IContextItem {
	return { id, channel, text, priority, ...(pinned ? { pinned } : {}) };
}

function conversation(turns: number): INativeLoopMessage[] {
	return Array.from({ length: turns }, (_, index): INativeLoopMessage => index % 2 === 0
		? { role: 'assistant', content: `step ${index}: ${'a'.repeat(200)}` }
		: { role: 'tool', content: `result ${index}: ${'b'.repeat(400)}`, callId: `c${index}`, name: 'read_file' });
}
