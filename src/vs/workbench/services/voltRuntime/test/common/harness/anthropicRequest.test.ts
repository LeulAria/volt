/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildAnthropicRequest, IAnthropicRequestInput } from '../../../common/harness/anthropicRequest.js';
import { claudeModelMeta } from '../../../common/models/claudeModels.js';

function request(modelId: string, extra: Partial<IAnthropicRequestInput>): Record<string, unknown> {
	return buildAnthropicRequest({
		modelId,
		meta: claudeModelMeta(modelId),
		messages: [{ role: 'user', content: 'hi' }],
		maxTokens: 16_000,
		firstParty: true,
		...extra,
	}).body;
}

suite('Anthropic request sampling pins', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a model without thinking takes the temperature, capped at 1', () => {
		const body = request('claude-3-5-sonnet-20241022', { temperature: 1.6 });
		assert.strictEqual(body.temperature, 1);
		assert.strictEqual(body.top_p, undefined);
	});

	test('temperature wins over top_p; newer models reject the pair', () => {
		const body = request('claude-3-5-sonnet-20241022', { temperature: 0.3, topP: 0.9 });
		assert.strictEqual(body.temperature, 0.3);
		assert.strictEqual(body.top_p, undefined);
		assert.strictEqual(request('claude-3-5-sonnet-20241022', { topP: 0.9 }).top_p, 0.9);
	});

	test('no pin is sent while extended thinking is on', () => {
		const adaptive = request('claude-sonnet-4-6', { temperature: 0.3 });
		assert.ok(adaptive.thinking);
		assert.strictEqual(adaptive.temperature, undefined);
		const budget = request('claude-sonnet-4-5', { effort: 'high', topP: 0.9 });
		assert.strictEqual((budget.thinking as { type: string }).type, 'enabled');
		assert.strictEqual(budget.top_p, undefined);
	});

	test('pins apply once thinking is turned off', () => {
		const off = request('claude-sonnet-4-6', { effort: 'off', temperature: 0.4 });
		assert.strictEqual((off.thinking as { type: string }).type, 'disabled');
		assert.strictEqual(off.temperature, 0.4);
		assert.strictEqual(request('claude-sonnet-4-5', { temperature: 0.4 }).temperature, 0.4);
	});

	test('nothing pinned, nothing sent', () => {
		const body = request('claude-3-5-sonnet-20241022', {});
		assert.ok(!('temperature' in body));
		assert.ok(!('top_p' in body));
	});
});
