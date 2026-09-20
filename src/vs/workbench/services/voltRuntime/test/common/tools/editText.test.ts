/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { applyExactEdits } from '../../../common/tools/editText.js';

suite('Volt exact edits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces a unique match', () => {
		const result = applyExactEdits('const a = 1;\nconst b = 2;\n', [{ oldString: 'const a = 1;', newString: 'const a = 2;' }]);
		assert.ok(!('error' in result));
		if (!('error' in result)) {
			assert.strictEqual(result.text, 'const a = 2;\nconst b = 2;\n');
			assert.strictEqual(result.replacements, 1);
		}
	});

	test('refuses an ambiguous match', () => {
		const result = applyExactEdits('foo\nfoo\n', [{ oldString: 'foo', newString: 'bar' }]);
		assert.ok('error' in result);
		if ('error' in result) {
			assert.ok(/2 times/.test(result.error));
		}
	});

	test('refuses a missing match and shows the file head', () => {
		const result = applyExactEdits('hello world', [{ oldString: 'goodbye', newString: 'hi' }]);
		assert.ok('error' in result);
		if ('error' in result) {
			assert.ok(/not found/.test(result.error));
			assert.ok(/hello world/.test(result.error));
		}
	});

	test('recovers a unique near-match with quote drift', () => {
		const result = applyExactEdits('const label = "hello";\n', [{ oldString: "const label = 'hello';", newString: "const label = 'hi';" }]);
		assert.ok(!('error' in result), JSON.stringify(result));
		if (!('error' in result)) {
			assert.strictEqual(result.text, "const label = 'hi';\n");
			assert.strictEqual(result.fuzzy, 1);
		}
	});

	test('refuses a fuzzy match that is not unique', () => {
		const result = applyExactEdits('const a = "x";\nconst b = "x";\n', [{ oldString: "const z = 'x';", newString: "const z = 'y';" }]);
		assert.ok('error' in result);
	});

	test('empty old_string only works on an empty file', () => {
		assert.ok('error' in applyExactEdits('x', [{ oldString: '', newString: 'y' }]));
		const created = applyExactEdits('', [{ oldString: '', newString: 'y' }]);
		assert.ok(!('error' in created));
		if (!('error' in created)) {
			assert.strictEqual(created.text, 'y');
		}
	});
});
