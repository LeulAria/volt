/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseAntigravityCliModelLabel, parseAntigravityModelLines, resolveAntigravityCliModelLabel } from '../../common/models/antigravityModels.js';
import { MODEL_OPTION_REASONING } from '../../common/models/modelOptions.js';
import { catalogOverlay } from '../../common/models/agentModelCatalogs.js';

suite('Antigravity model discovery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses display labels and tab-separated slug rows', () => {
		assert.deepStrictEqual(parseAntigravityCliModelLabel('Gemini 3.5 Flash (High)'), {
			model: 'Gemini 3.5 Flash',
			effort: 'high',
		});
		assert.deepStrictEqual(parseAntigravityCliModelLabel('gemini-3.6-flash-high\tGemini 3.6 Flash (High)'), {
			model: 'Gemini 3.6 Flash',
			effort: 'high',
		});
	});

	test('collapses effort variants onto one family', () => {
		const models = parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`);
		assert.deepStrictEqual(models.map(model => ({ slug: model.slug, efforts: model.efforts, defaultEffort: model.defaultEffort })), [
			{ slug: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
			{ slug: 'Gemini 3.1 Pro', efforts: ['low', 'high'], defaultEffort: 'low' },
			{ slug: 'Claude Sonnet 4.6', efforts: ['thinking'], defaultEffort: 'thinking' },
		]);
	});

	test('rebuilds the CLI dispatch label', () => {
		assert.strictEqual(resolveAntigravityCliModelLabel('Gemini 3.5 Flash'), 'Gemini 3.5 Flash (Medium)');
		assert.strictEqual(resolveAntigravityCliModelLabel('Gemini 3.5 Flash', 'high'), 'Gemini 3.5 Flash (High)');
		assert.strictEqual(resolveAntigravityCliModelLabel('Gemini 3.5 Flash (Low)'), 'Gemini 3.5 Flash (Low)');
	});

	test('catalog overlay matches advertised Antigravity families', () => {
		const overlay = catalogOverlay('antigravity', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash');
		assert.ok(overlay);
		assert.strictEqual(overlay.description, 'Google\'s fast Antigravity model');
		assert.deepStrictEqual(
			overlay.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value),
			['low', 'medium', 'high'],
		);
	});
});
