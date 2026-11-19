/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IVoltCodeIndexService } from '../../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { createCodeIndexNav, isCodeUse } from '../../../browser/tools/codeIndexNav.js';

suite('code_nav by name from the code index', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a use in a comment or a quoted string is not a reference', () => {
		assert.strictEqual(isCodeUse('// LineTotal is the price of one line: unit price times quantity.', 'LineTotal', 'cart/cart.go'), false);
		assert.strictEqual(isCodeUse('\t\tt.Fatalf("LineTotal = %v, want 10", got)', 'LineTotal', 'cart/cart_test.go'), false);
		assert.strictEqual(isCodeUse('\tif got := cart.LineTotal(item); got != 10 { // LineTotal again', 'LineTotal', 'cart/cart_test.go'), true);
		assert.strictEqual(isCodeUse('\tsum += LineTotal(item) // per line', 'LineTotal', 'cart/cart.go'), true);
		assert.strictEqual(isCodeUse('\treturn x // uses LineTotal', 'LineTotal', 'cart/cart.go'), false);
		assert.strictEqual(isCodeUse(' * lineTotal is documented here', 'lineTotal', 'src/cart.ts'), false);
		assert.strictEqual(isCodeUse('test(\'lineTotal multiplies price by quantity\', () => {', 'lineTotal', 'test/cart.test.ts'), false);
		assert.strictEqual(isCodeUse('\tassert.equal(lineTotal({ sku: \'tea\' }), 10);', 'lineTotal', 'test/cart.test.ts'), true);
		assert.strictEqual(isCodeUse('const total = a * b;', 'total', 'src/a.ts'), true);
		assert.strictEqual(isCodeUse('# line_total is used below', 'line_total', 'shop/cart.py'), false);
		assert.strictEqual(isCodeUse('    return sum(line_total(item) for item in items)  # line_total', 'line_total', 'shop/cart.py'), true);
		assert.strictEqual(isCodeUse('    print("it\\\'s line_total")', 'line_total', 'shop/cart.py'), false);
		// A template literal's `${...}` is code: backticks are not judged as strings.
		assert.strictEqual(isCodeUse('\treturn `total=${lineTotal(item)}`;', 'lineTotal', 'src/a.ts'), true);
	});

	test('references drop comment and string matches; implementations find Python base classes', async () => {
		const searches: string[] = [];
		const service = {
			search: async (request: { pattern: string }) => {
				searches.push(request.pattern);
				return {
					kind: 'results', files: [{
						path: 'cart/cart.go', lines: [
							{ line: 10, text: '// LineTotal is the price of one line.', match: true },
							{ line: 11, text: 'func LineTotal(item CartItem) float64 {', match: true },
							{ line: 31, text: '\t\tsum += LineTotal(item)', match: true },
						],
					}],
				};
			},
		} as unknown as IVoltCodeIndexService;
		const nav = createCodeIndexNav({ service, enabled: () => true, options: () => ({}) as never });
		const found = await nav.references(URI.file('/repo'), 'LineTotal');
		assert.deepStrictEqual(found?.map(item => item.line), [11, 31]);
		await nav.implementations!(URI.file('/repo'), 'PriceRule');
		const pattern = new RegExp(searches[1]);
		assert.ok(pattern.test('class BaseRule(PriceRule):'));
		assert.ok(pattern.test('class FreeShipping(Mixin, PriceRule):'));
		assert.ok(pattern.test('export abstract class BaseRule implements PriceRule {'));
		assert.ok(!pattern.test('def apply(rule: PriceRule):'));
	});
});
