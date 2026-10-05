/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentEmptyComposerChips } from '../../browser/composer/agentSuggestChips.js';

suite('Agent empty composer suggest chips', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('offers Plan and Multitask, never a project chip', () => {
		assert.deepStrictEqual(agentEmptyComposerChips({ mode: 'Agent' }).map(chip => chip.id), ['plan', 'multitask']);
	});

	test('hides the chip of the current mode', () => {
		assert.deepStrictEqual(agentEmptyComposerChips({ mode: 'Plan' }).map(chip => chip.id), ['multitask']);
		assert.deepStrictEqual(agentEmptyComposerChips({ mode: 'Multitask' }).map(chip => chip.id), ['plan']);
	});
});
