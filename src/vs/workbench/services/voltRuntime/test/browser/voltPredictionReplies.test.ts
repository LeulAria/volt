/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { inlineReplyIsComplete } from '../../browser/prediction/voltPredictionService.js';

suite('Volt prediction: when a streamed reply is complete', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a closed insert is the whole answer', () => {
		assert.strictEqual(inlineReplyIsComplete('<insert> a + b;</insert>', 'function add() {\n\treturn', '\treturn'), true);
	});

	test('an open insert on its first line is not done yet', () => {
		assert.strictEqual(inlineReplyIsComplete('<insert> a + b', 'function add() {\n\treturn', '\treturn'), false);
	});

	test('an untagged reply still ends at a model end token', () => {
		assert.strictEqual(inlineReplyIsComplete('a + b;<|endoftext|>', 'function add() {\n\treturn', '\treturn'), true);
	});

	test('a tagged reply that runs past its block is cut', () => {
		const reply = '<insert> a + b;\n}\n\nfunction other() {\n';
		assert.strictEqual(inlineReplyIsComplete(reply, 'function add() {\n\treturn', '\treturn'), true);
	});
});
