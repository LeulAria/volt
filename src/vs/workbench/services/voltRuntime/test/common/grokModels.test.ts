/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { grokModelsToInfo, parseGrokModelLines } from '../../common/models/grokModels.js';
import { MODEL_OPTION_REASONING } from '../../common/models/modelOptions.js';

suite('Grok model discovery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads grok models and ignores the login banner', () => {
		const models = parseGrokModelLines([
			'You are logged in with grok.com.',
			'',
			'Default model: grok-4.7',
			'',
			'Available models:',
			'  * grok-4.7 (default)',
			'',
		].join('\n'));
		assert.deepStrictEqual(models, [{ id: 'grok-4.7', isDefault: true }]);
	});

	test('ignores bullets before the available-models header', () => {
		assert.deepStrictEqual(parseGrokModelLines('* grok-4.7 (default)\n'), []);
	});

	test('uses the cache for the display name, effort ladder, and context', () => {
		const listed = parseGrokModelLines('Available models:\n* grok-4.7 (default)\n');
		const [info] = grokModelsToInfo(listed, {
			'grok-4.7': {
				name: 'Grok 4.7',
				description: 'Frontier model',
				contextWindow: 256000,
				efforts: ['xhigh', 'high', 'medium', 'low'],
				defaultEffort: 'high',
			},
		});
		assert.strictEqual(info.label, 'Grok 4.7');
		assert.strictEqual(info.description, 'Frontier model');
		assert.strictEqual(info.contextLabel, '256k');
		assert.strictEqual(info.capabilities.contextWindow, 256000);
		assert.deepStrictEqual(
			info.optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(choice => choice.value),
			['xhigh', 'high', 'medium', 'low'],
		);
		assert.strictEqual(info.optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING)?.options?.find(choice => choice.isDefault)?.value, 'high');
	});
});
