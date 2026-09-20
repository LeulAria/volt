/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findEditorCommandsContext } from '../../browser/editor/agentEditorCommandsContext.js';

suite('Agent editor command context', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds groupId after the title-bar resource argument', () => {
		const context = findEditorCommandsContext([
			URI.parse('volt-agent://session/new'),
			{ groupId: 7, editorIndex: 0 },
		]);
		assert.strictEqual(context?.groupId, 7);
		assert.strictEqual(context?.editorIndex, 0);
	});

	test('accepts a bare editor commands context', () => {
		assert.strictEqual(findEditorCommandsContext([{ groupId: 3 }])?.groupId, 3);
	});

	test('ignores a resource-only invocation', () => {
		assert.strictEqual(findEditorCommandsContext([URI.parse('volt-agent://session/new')]), undefined);
	});
});
