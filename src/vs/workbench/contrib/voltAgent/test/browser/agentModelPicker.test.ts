/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { filterPickerModels, parseFavoriteRefs, pickerShortcutLabel, PICKER_FAVORITES_TAB, toggleFavoriteRefs, type IModelOption } from '../../browser/picker/agentModelPickerModel.js';

function model(ref: string, family: string, name = ref): IModelOption {
	return {
		ref,
		name,
		providerId: family,
		family,
		optionDescriptors: [],
		contextWindow: 200_000,
		description: `${name} description`,
	};
}

suite('Agent model picker model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses favorite refs and toggles membership', () => {
		assert.deepStrictEqual(parseFavoriteRefs('["a","b"]'), ['a', 'b']);
		assert.deepStrictEqual(toggleFavoriteRefs(['a'], 'b'), ['a', 'b']);
		assert.deepStrictEqual(toggleFavoriteRefs(['a', 'b'], 'a'), ['b']);
	});

	test('provider tabs hide other families until search', () => {
		const groups = [
			{ family: 'claude', label: 'Claude', models: [model('fable', 'claude', 'Fable 5')] },
			{ family: 'codex', label: 'Codex', models: [model('astra', 'codex', 'GPT-6-Astra')] },
		];
		assert.deepStrictEqual(filterPickerModels(groups, 'claude', '', new Set()).map(item => item.ref), ['fable']);
		assert.deepStrictEqual(filterPickerModels(groups, 'claude', 'astra', new Set()).map(item => item.ref), ['astra']);
	});

	test('favorites tab only lists starred models and floats them on a provider tab', () => {
		const groups = [
			{ family: 'claude', label: 'Claude', models: [model('fable', 'claude', 'Fable 5'), model('opus', 'claude', 'Opus 5')] },
		];
		const favorites = new Set(['opus']);
		assert.deepStrictEqual(filterPickerModels(groups, PICKER_FAVORITES_TAB, '', favorites).map(item => item.ref), ['opus']);
		assert.deepStrictEqual(filterPickerModels(groups, 'claude', '', favorites).map(item => item.ref), ['opus', 'fable']);
	});

	test('shortcut badges use the platform modifier', () => {
		assert.strictEqual(pickerShortcutLabel(0, true), '\u23181');
		assert.strictEqual(pickerShortcutLabel(1, false), 'Ctrl+2');
		assert.strictEqual(pickerShortcutLabel(6, true), undefined);
	});
});
