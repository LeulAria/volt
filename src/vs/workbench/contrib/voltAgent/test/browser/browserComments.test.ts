/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { commentPreviewText } from '../../browser/preview/browserComments.js';

suite('Browser comment pins', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows the words the user typed, without the element chip', () => {
		assert.strictEqual(commentPreviewText('button make the padding tighter', 'button'), 'make the padding tighter');
		assert.strictEqual(commentPreviewText('section\nkeep the heading', 'section'), 'keep the heading');
	});

	test('keeps the element name when that is all they wrote', () => {
		assert.strictEqual(commentPreviewText('button', 'button'), 'button');
		assert.strictEqual(commentPreviewText('   ', 'div'), 'div');
	});

	test('keeps text that does not start with the element name', () => {
		assert.strictEqual(commentPreviewText('change the hero', 'button'), 'change the hero');
	});
});
