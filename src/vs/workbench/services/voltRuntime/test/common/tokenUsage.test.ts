/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseTokenUsage } from '../../common/tokenUsage.js';

suite('parseTokenUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads ACP usage_update used/size', () => {
		const usage = parseTokenUsage({ sessionUpdate: 'usage_update', used: 53_000, size: 200_000 });
		assert.deepStrictEqual(usage, { type: 'usage', input: 0, output: 0, used: 53_000, size: 200_000 });
	});

	test('reads nested prompt usage tokens', () => {
		const usage = parseTokenUsage({ usage: { inputTokens: 1_200, outputTokens: 80 } });
		assert.deepStrictEqual(usage, { type: 'usage', input: 1_200, output: 80 });
	});

	test('reads the cost Claude reports with usage_update (US dollars only)', () => {
		assert.deepStrictEqual(parseTokenUsage({ sessionUpdate: 'usage_update', used: 24_706, size: 200_000, cost: { amount: 0.0374574, currency: 'USD' } }),
			{ type: 'usage', input: 0, output: 0, used: 24_706, size: 200_000, costUsd: 0.0374574 });
		assert.strictEqual(parseTokenUsage({ sessionUpdate: 'usage_update', used: 1, cost: { amount: 2, currency: 'EUR' } })?.costUsd, undefined);
	});

	test('reads cache writes from a prompt result', () => {
		const usage = parseTokenUsage({ usage: { inputTokens: 18, outputTokens: 1044, cachedReadTokens: 35_435, cachedWriteTokens: 10_884, totalTokens: 47_381 } });
		assert.deepStrictEqual(usage, { type: 'usage', input: 18, output: 1044, cache: 35_435, cacheWrite: 10_884 });
	});

	test('bills a Claude turn from its per-model rows, which count subagents the main-loop usage leaves out', () => {
		// claude-agent-acp 0.81.2, an Opus turn that ran one Agent subagent (recorded 2026-10-11).
		const usage = parseTokenUsage({
			stopReason: 'end_turn',
			usage: { inputTokens: 4, outputTokens: 283, cachedReadTokens: 32_044, cachedWriteTokens: 13_940, totalTokens: 46_271 },
			_meta: {
				quota: {
					token_count: { totalTokens: 46_271, inputTokens: 4, cachedInputTokens: 32_044, cachedWriteTokens: 13_940, outputTokens: 283, reasoningOutputTokens: 0 },
					model_usage: [
						{ model: 'claude-haiku-4-5-20251001', token_count: { totalTokens: 942, inputTokens: 929, cachedInputTokens: 0, cachedWriteTokens: 0, outputTokens: 13, reasoningOutputTokens: 0 } },
						{ model: 'claude-opus-5-5[1m]', token_count: { totalTokens: 63_046, inputTokens: 6, cachedInputTokens: 32_044, cachedWriteTokens: 30_709, outputTokens: 287, reasoningOutputTokens: 0 } },
					],
				},
			},
		});
		assert.deepStrictEqual(usage, {
			type: 'usage', input: 4, output: 283, cache: 32_044, cacheWrite: 13_940,
			billed: { input: 935, output: 300, cacheRead: 32_044, cacheWrite: 30_709 },
		});
		// Rows that add nothing over the main loop (a turn without subagents) stay out of the event.
		assert.strictEqual(parseTokenUsage({
			usage: { inputTokens: 4, outputTokens: 10 },
			_meta: { quota: { model_usage: [{ model: 'm', token_count: { inputTokens: 4, outputTokens: 10 } }] } },
		})?.billed, undefined);
	});

	test('ignores empty payloads', () => {
		assert.strictEqual(parseTokenUsage({ sessionUpdate: 'usage_update' }), undefined);
	});
});
