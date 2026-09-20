/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { catalogOverlay, canonicalModelKey } from '../../common/models/agentModelCatalogs.js';
import { MODEL_OPTION_CONTEXT, MODEL_OPTION_REASONING, MODEL_OPTION_SERVICE_TIER } from '../../common/models/modelOptions.js';

suite('CLI model catalog overlays', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('canonical keys drop dates, prefixes, and 1m suffixes', () => {
		assert.strictEqual(canonicalModelKey('claude-opus-4-7-20260101[1m]'), 'opus-4-7');
		assert.strictEqual(canonicalModelKey('gpt-5.6-sol'), 'gpt-5-6-sol');
		assert.strictEqual(canonicalModelKey('anthropic/claude-sonnet-5'), 'sonnet-5');
		assert.strictEqual(canonicalModelKey('opencode/hy3-free'), 'hy3-free');
	});

	test('Claude Fable overlay carries reasoning, ultracode, and a 200K/1M window', () => {
		const overlay = catalogOverlay('claude-code', 'claude-fable-5-1', 'Fable 5.1');
		assert.ok(overlay);
		assert.strictEqual(overlay.description, 'Most intelligent model for building agents');
		const reasoning = overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING);
		assert.ok(reasoning?.options?.some(choice => choice.value === 'ultracode'));
		assert.ok(reasoning?.options?.some(choice => choice.value === 'ultrathink'));
		const context = overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_CONTEXT);
		assert.deepStrictEqual(context?.options?.map(choice => choice.value), ['200k', '1m']);
	});

	test('Codex Astra overlay carries Ultra reasoning and a service tier', () => {
		const overlay = catalogOverlay('codex', 'gpt-6-astra', 'GPT-6-Astra');
		assert.ok(overlay);
		const reasoning = overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING);
		assert.ok(reasoning?.options?.some(choice => choice.value === 'ultra'));
		assert.ok(overlay.optionDescriptors.some(option => option.id === MODEL_OPTION_SERVICE_TIER));
	});

	test('Daybreak Blue has no service tier overlay', () => {
		const overlay = catalogOverlay('codex', 'gpt-daybreak-blue-latest');
		assert.ok(overlay);
		assert.ok(!overlay.optionDescriptors.some(option => option.id === MODEL_OPTION_SERVICE_TIER));
	});

	test('Antigravity overlay matches Gemini 3.6 Flash by display name', () => {
		const overlay = catalogOverlay('antigravity', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash');
		assert.ok(overlay);
		assert.deepStrictEqual(
			overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value),
			['low', 'medium', 'high'],
		);
	});

	test('OpenCode Hy3 overlay carries a low/medium/high ladder', () => {
		const overlay = catalogOverlay('opencode', 'opencode/hy3-free', 'Hy3 Free');
		assert.ok(overlay);
		assert.deepStrictEqual(
			overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value),
			['low', 'medium', 'high'],
		);
	});
});
