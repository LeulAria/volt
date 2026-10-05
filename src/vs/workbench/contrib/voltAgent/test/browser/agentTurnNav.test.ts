/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { turnNavPreview } from '../../browser/editor/agentTurnNav.js';

suite('Agent turn nav', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('previews a reply as one line of plain text', () => {
		assert.strictEqual(
			turnNavPreview('**What was wrong:** the `out/` folder was stale.\n\n- first\n- second'),
			'What was wrong: the out/ folder was stale. first second',
		);
	});

	test('cuts long replies with an ellipsis', () => {
		const preview = turnNavPreview('word '.repeat(200), 40);
		assert.ok(preview.endsWith('…'));
		assert.ok(preview.length <= 41);
	});

	test('an empty reply has no preview', () => {
		assert.strictEqual(turnNavPreview(''), '');
	});
});
