/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sandboxRefusalLikely } from '../../common/sandboxDenialCheck.js';

suite('sandboxRefusalLikely', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a failed tool call is always checked', () => {
		assert.strictEqual(sandboxRefusalLikely(undefined, 'Tool failed'), true);
	});

	test('a command whose output names a refusal or a non-zero exit is checked', () => {
		assert.strictEqual(sandboxRefusalLikely([{ type: 'content', content: { type: 'text', text: 'touch: /Users/me/x: Operation not permitted' } }], undefined), true);
		assert.strictEqual(sandboxRefusalLikely('Exit code 1\nmkdir: cannot create', undefined), true);
		assert.strictEqual(sandboxRefusalLikely({ stderr: 'curl: (6) Could not resolve host: example.com' }, undefined), true);
	});

	test('an ordinary successful result is not', () => {
		assert.strictEqual(sandboxRefusalLikely([{ type: 'content', content: { type: 'text', text: 'src/a.ts\nsrc/b.ts' } }], undefined), false);
		assert.strictEqual(sandboxRefusalLikely(undefined, undefined), false);
		assert.strictEqual(sandboxRefusalLikely('Exit code 0', undefined), false);
	});
});
