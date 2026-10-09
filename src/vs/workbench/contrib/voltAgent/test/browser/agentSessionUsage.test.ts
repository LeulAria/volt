/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildSessionUsage, ISessionUsageMessage, sessionModelIds } from '../../browser/context/agentSessionUsage.js';

const OPUS = { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6 };
const rates = (id: string) => id === 'claude-opus-5' ? OPUS : undefined;

suite('Agent session usage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sums turns per model, prefers the reported cost and prices the rest at list rates', () => {
		const messages: ISessionUsageMessage[] = [
			{ kind: 'user', id: 't1', text: 'Fix the build\nand more' },
			{ kind: 'agent', id: 't1', model: { ref: 'claude:opus', id: 'claude-opus-5', label: 'Opus 5' }, spend: { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 2000 } },
			{ kind: 'user', id: 't2', text: 'Again' },
			{ kind: 'agent', id: 't2', model: { ref: 'claude:opus', id: 'claude-opus-5', label: 'Opus 5' }, spend: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 },
			{ kind: 'user', id: 't3', text: 'Use Cursor' },
			{ kind: 'agent', id: 't3', model: { ref: 'cursor:auto', id: 'auto', label: 'Auto' }, spend: { input: 300, output: 50, cacheRead: 0, cacheWrite: 0 } },
			{ kind: 'user', id: 't4', text: 'Stopped' },
			{ kind: 'agent', id: 't4' },
		];
		const summary = buildSessionUsage(messages, { rates });

		assert.strictEqual(summary.turns.length, 3, 'a reply with no usage is not a turn');
		const [first, second, third] = summary.turns;
		assert.strictEqual(first.prompt, 'Fix the build');
		assert.strictEqual(first.index, 1);
		const listCost = 1000 * 4e-6 + 500 * 2e-5 + 10000 * 2e-7 + 2000 * 5e-6;
		assert.ok(Math.abs((first.costUsd ?? 0) - listCost) < 1e-12);
		assert.strictEqual(first.reported, false);
		assert.strictEqual(second.costUsd, 0.5);
		assert.strictEqual(second.reported, true);
		assert.ok(Math.abs(Object.values(second.costByKind!).reduce((a, b) => a + b, 0) - 0.5) < 1e-12, 'the reported cost is split in list-rate proportion');
		assert.strictEqual(third.costUsd, undefined);
		assert.strictEqual(third.index, 3);

		assert.strictEqual(summary.unpricedTurns, 1);
		assert.strictEqual(summary.reportedTurns, 1);
		assert.strictEqual(summary.total, 13500 + 200 + 350);
		assert.deepStrictEqual(summary.models.map(model => [model.label, model.turns, model.unpricedTurns]), [['Opus 5', 2, 0], ['Auto', 1, 1]]);
		assert.ok(Math.abs(summary.costUsd - (listCost + 0.5)) < 1e-12);
	});

	test('replies recorded before turns kept their model count under the chat model, from their last usage report', () => {
		const messages: ISessionUsageMessage[] = [
			{ kind: 'user', id: 't1', text: 'hi' },
			{ kind: 'agent', id: 't1', tokensIn: 10, tokensOut: 20, tokensCache: 30 },
		];
		const options = { rates, fallbackModel: { ref: 'claude:opus' }, describe: () => ({ id: 'claude-opus-5', label: 'Opus 5' }) };
		const summary = buildSessionUsage(messages, options);
		assert.deepStrictEqual(summary.turns[0].tokens, { input: 10, cacheRead: 30, cacheWrite: 0, output: 20 });
		assert.strictEqual(summary.turns[0].modelLabel, 'Opus 5');
		assert.deepStrictEqual(sessionModelIds(messages, options), ['claude-opus-5']);
	});
});
