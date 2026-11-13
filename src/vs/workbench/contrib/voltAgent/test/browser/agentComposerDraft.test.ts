/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { composerDraftShape } from '../../browser/editor/agentComposerDraft.js';

suite('agentComposerDraft', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('one more letter on a line keeps the shape, so the keystroke needs no layout', () => {
		assert.strictEqual(composerDraftShape('ad'), composerDraftShape('ade'));
	});

	test('emptying the draft, filling it and a new line each change the shape', () => {
		assert.notStrictEqual(composerDraftShape(''), composerDraftShape('a'));
		assert.strictEqual(composerDraftShape('  '), composerDraftShape(''));
		assert.notStrictEqual(composerDraftShape('a'), composerDraftShape('a\nb'));
	});
});
