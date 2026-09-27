/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentEmptyComposerChips } from '../../browser/composer/agentSuggestChips.js';

suite('Agent empty composer suggest chips', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Select project is second only for no-project agents', () => {
		const withProject = agentEmptyComposerChips({ mode: 'Agent', needsProject: false }).map(chip => chip.id);
		assert.deepStrictEqual(withProject, ['plan', 'multitask', 'cloud']);
		const without = agentEmptyComposerChips({ mode: 'Agent', needsProject: true }).map(chip => chip.id);
		assert.deepStrictEqual(without, ['plan', 'selectProject', 'multitask', 'cloud']);
		assert.strictEqual(without[1], 'selectProject');
	});

	test('Select project click is a no-op placeholder chip', () => {
		const chip = agentEmptyComposerChips({ mode: 'Agent', needsProject: true }).find(item => item.id === 'selectProject');
		assert.ok(chip);
		assert.strictEqual(chip.label, 'Select project');
	});
});
