/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fileFilter, formatMatches } from '../../browser/tools/searchTools.js';

/** grep's glob and type follow ripgrep: both apply, and `!glob` leaves files out. */
suite('grep file filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a glob naming one file is not widened by type', () => {
		assert.deepStrictEqual(fileFilter('apps/api/src/reservation.service.ts', 'ts'), { includes: ['apps/api/src/reservation.service.ts'] });
		assert.deepStrictEqual(fileFilter('*.spec.ts', 'ts'), { includes: ['**/*.spec.ts'] });
	});

	test('a folder glob gets the type\'s files below it', () => {
		assert.deepStrictEqual(fileFilter('apps/api/**', 'ts'), { includes: ['apps/api/**/*.{ts,tsx,mts,cts}'] });
		assert.deepStrictEqual(fileFilter('packages/database', 'ts'), { includes: ['packages/database/**/*.{ts,tsx,mts,cts}'] });
	});

	test('a negated glob excludes', () => {
		assert.deepStrictEqual(fileFilter('!**/*.spec.ts', 'ts'), { includes: ['**/*.{ts,tsx,mts,cts}'], excludes: ['**/*.spec.ts'] });
		assert.deepStrictEqual(fileFilter('!*.test.ts', undefined), { excludes: ['**/*.test.ts'] });
	});

	test('type alone, glob alone, neither', () => {
		assert.deepStrictEqual(fileFilter(undefined, 'py'), { includes: ['**/*.{py,pyi}'] });
		assert.deepStrictEqual(fileFilter('src/**/*.ts', undefined), { includes: ['src/**/*.ts'] });
		assert.deepStrictEqual(fileFilter(undefined, undefined), {});
	});
});

suite('grep matches name the declaration they sit in', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first match in each declaration is labelled, a method with its class', () => {
		const file = {
			path: 'src/reservation.service.ts',
			matches: 3,
			lines: new Map([[12, { text: 'assertTransition(r.status, \'confirmed\');', match: true }], [14, { text: 'assertTransition(r.status, \'assigned\');', match: true }], [40, { text: 'assertTransition(r.status, \'cancelled\');', match: true }]]),
		};
		const owners = new Map([['src/reservation.service.ts', [{ line: 3, name: 'ReservationService' }, { line: 10, name: 'ReservationService.confirm' }, { line: 38, name: 'ReservationService.cancel' }]]]);
		assert.strictEqual(formatMatches([file], 10, 0, owners).text, [
			'src/reservation.service.ts:',
			'  12: assertTransition(r.status, \'confirmed\');  (in ReservationService.confirm)',
			'  14: assertTransition(r.status, \'assigned\');',
			'  40: assertTransition(r.status, \'cancelled\');  (in ReservationService.cancel)',
		].join('\n'));
		assert.ok(!formatMatches([file], 10, 0).text.includes('(in '));
	});
});
