/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compactEffortLabel, fillDescriptors, splitModelDisplayName, traitDescriptors, unionDescriptors } from '../../common/models/modelOptions.js';

suite('compactEffortLabel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shortens Extra High for the model trigger', () => {
		assert.strictEqual(compactEffortLabel('xhigh', 'Extra High'), 'xH');
		assert.strictEqual(compactEffortLabel('extra-high'), 'xH');
		assert.strictEqual(compactEffortLabel('extra_high', 'Extra High'), 'xH');
		assert.strictEqual(compactEffortLabel('4', 'Extra High'), 'xH');
	});

	test('uses single letters for the common levels', () => {
		assert.strictEqual(compactEffortLabel('low', 'Low'), 'L');
		assert.strictEqual(compactEffortLabel('medium', 'Medium'), 'M');
		assert.strictEqual(compactEffortLabel('high', 'High'), 'H');
	});

	test('falls back to initials for unknown multi-word labels', () => {
		assert.strictEqual(compactEffortLabel('custom', 'Very High'), 'VH');
	});
});

suite('splitModelDisplayName', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pulls Extra High off the model name', () => {
		assert.deepStrictEqual(splitModelDisplayName('Grok 4.5 Extra High'), {
			name: 'Grok 4.5',
			effortCompact: 'xH',
			effortFull: 'Extra High',
		});
	});

	test('keeps a clean model name unchanged', () => {
		assert.deepStrictEqual(splitModelDisplayName('Grok 4.5'), { name: 'Grok 4.5' });
	});
});

suite('descriptor merge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fillDescriptors keeps the first list and adds missing ids', () => {
		const filled = fillDescriptors(
			[{ id: 'reasoning', label: 'Reasoning', type: 'select', options: [{ value: 'high', label: 'High' }] }],
			[
				{ id: 'reasoning', label: 'Effort', type: 'select', options: [{ value: 'low', label: 'Low' }] },
				{ id: 'contextWindow', label: 'Context Window', type: 'select', options: [{ value: '1m', label: '1M' }, { value: '200k', label: '200K' }] },
			],
		);
		assert.strictEqual(filled[0].label, 'Reasoning');
		assert.strictEqual(filled[0].options?.length, 1);
		assert.strictEqual(filled[1].id, 'contextWindow');
	});

	test('unionDescriptors merges choices for the same id', () => {
		const merged = unionDescriptors(
			[{ id: 'contextWindow', label: 'Context Window', type: 'select', options: [{ value: '200k', label: '200K' }] }],
			[{ id: 'contextWindow', label: 'Context Window', type: 'select', options: [{ value: '1m', label: '1M' }] }],
		);
		assert.deepStrictEqual(merged[0].options?.map(choice => choice.value), ['200k', '1m']);
	});

	test('traitDescriptors put reasoning and context first', () => {
		const traits = traitDescriptors([
			{ id: 'fastMode', label: 'Fast', type: 'boolean' },
			{ id: 'contextWindow', label: 'Context Window', type: 'select', options: [{ value: '200k', label: '200K' }, { value: '1m', label: '1M' }] },
			{ id: 'reasoning', label: 'Reasoning', type: 'select', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
		]);
		assert.deepStrictEqual(traits.map(trait => trait.id), ['reasoning', 'contextWindow', 'fastMode']);
	});
});
