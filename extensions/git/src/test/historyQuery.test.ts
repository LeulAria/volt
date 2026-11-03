/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { isValidHistoryQueryDate, parseHistoryQuery } from '../historyQuery';

suite('historyQuery', () => {
	test('plain text has no fields', () => {
		const query = parseHistoryQuery('fix blame hover');
		assert.strictEqual(query.hasFields, false);
		assert.strictEqual(query.message, 'fix blame hover');
		assert.strictEqual(query.commit, undefined);
	});

	test('empty query', () => {
		const query = parseHistoryQuery('   ');
		assert.strictEqual(query.hasFields, false);
		assert.strictEqual(query.message, undefined);
	});

	test('author with a quoted value', () => {
		const query = parseHistoryQuery('author:"Jane Doe" crash');
		assert.strictEqual(query.hasFields, true);
		assert.strictEqual(query.author, 'Jane Doe');
		assert.strictEqual(query.message, 'crash');
	});

	test('quoted bare phrase', () => {
		const query = parseHistoryQuery('"make repo frontend-only" author:leul');
		assert.strictEqual(query.author, 'leul');
		assert.strictEqual(query.message, 'make repo frontend-only');
	});

	test('field keys are case-insensitive', () => {
		const query = parseHistoryQuery('Author:jane MESSAGE:fix');
		assert.strictEqual(query.author, 'jane');
		assert.strictEqual(query.message, 'fix');
	});

	test('message field and bare words form one phrase', () => {
		const query = parseHistoryQuery('message:"null check" in parser');
		assert.strictEqual(query.message, 'null check in parser');
	});

	test('dates', () => {
		const query = parseHistoryQuery('after:2026-01-15 before:@1760000000');
		// A bare day is its start (git would read it as that day at the current time).
		assert.strictEqual(query.since, '2026-01-15T00:00:00');
		assert.strictEqual(query.until, '@1760000000');
		assert.strictEqual(parseHistoryQuery('before:2026-10-04').until, '2026-10-04T00:00:00');
		assert.strictEqual(query.message, undefined);

		const aliases = parseHistoryQuery('since:2026-01-15T10:30:00Z until:2.weeks.ago');
		assert.strictEqual(aliases.since, '2026-01-15T10:30:00Z');
		assert.strictEqual(aliases.until, '2.weeks.ago');
	});

	test('invalid date is text', () => {
		const query = parseHistoryQuery('after:someday');
		assert.strictEqual(query.since, undefined);
		assert.strictEqual(query.hasFields, false);
		assert.strictEqual(query.message, 'after:someday');
	});

	test('date validation', () => {
		assert.strictEqual(isValidHistoryQueryDate('2026-10-25'), true);
		assert.strictEqual(isValidHistoryQueryDate('2026-10-25 08:00'), true);
		assert.strictEqual(isValidHistoryQueryDate('2026-10-25T08:00:00+02:00'), true);
		assert.strictEqual(isValidHistoryQueryDate('@0'), true);
		assert.strictEqual(isValidHistoryQueryDate('yesterday'), true);
		assert.strictEqual(isValidHistoryQueryDate('3.days.ago'), true);
		assert.strictEqual(isValidHistoryQueryDate('2026/10/25'), false);
		assert.strictEqual(isValidHistoryQueryDate('--all'), false);
		assert.strictEqual(isValidHistoryQueryDate(''), false);
	});

	test('path of a single file is followed', () => {
		const query = parseHistoryQuery('path:src/vs/base/common/uri.ts');
		assert.strictEqual(query.path, 'src/vs/base/common/uri.ts');
		assert.strictEqual(query.follow, true);
	});

	test('path glob or folder is not followed', () => {
		assert.strictEqual(parseHistoryQuery('path:src/*.ts').follow, false);
		assert.strictEqual(parseHistoryQuery('path:src/').follow, false);
	});

	test('path is normalized', () => {
		const query = parseHistoryQuery('path:"./my folder\\file name.ts"');
		assert.strictEqual(query.path, 'my folder/file name.ts');
	});

	test('lines', () => {
		const query = parseHistoryQuery('lines:10-12:src/app.tsx');
		assert.deepStrictEqual(query.lineRange, { startLine: 10, endLine: 12, path: 'src/app.tsx' });
		assert.strictEqual(query.hasFields, true);
		assert.strictEqual(query.message, undefined);
	});

	test('lines with a single line, a comma and a quoted path', () => {
		assert.deepStrictEqual(parseHistoryQuery('lines:7:a.ts').lineRange, { startLine: 7, endLine: 7, path: 'a.ts' });
		assert.deepStrictEqual(parseHistoryQuery('lines:3,4:a.ts').lineRange, { startLine: 3, endLine: 4, path: 'a.ts' });
		assert.deepStrictEqual(parseHistoryQuery('lines:"1-2:my dir/a b.ts"').lineRange, { startLine: 1, endLine: 2, path: 'my dir/a b.ts' });
		assert.deepStrictEqual(parseHistoryQuery('lines:1-2:"my dir/a b.ts"').lineRange, { startLine: 1, endLine: 2, path: 'my dir/a b.ts' });
		assert.deepStrictEqual(parseHistoryQuery('lines:5-6:c:/odd/path.ts').lineRange, { startLine: 5, endLine: 6, path: 'c:/odd/path.ts' });
	});

	test('invalid lines are text', () => {
		assert.strictEqual(parseHistoryQuery('lines:12-10:a.ts').lineRange, undefined);
		assert.strictEqual(parseHistoryQuery('lines:0-1:a.ts').lineRange, undefined);
		assert.strictEqual(parseHistoryQuery('lines:a.ts').lineRange, undefined);
		assert.strictEqual(parseHistoryQuery('lines:1-2').lineRange, undefined);
		assert.strictEqual(parseHistoryQuery('lines:1-2').message, 'lines:1-2');
	});

	test('hex token is a commit and message text', () => {
		const query = parseHistoryQuery('ABC1234');
		assert.strictEqual(query.commit, 'abc1234');
		assert.strictEqual(query.message, 'ABC1234');
		assert.strictEqual(query.hasFields, false);

		const full = parseHistoryQuery('author:jane 0123456789abcdef0123456789abcdef01234567');
		assert.strictEqual(full.commit, '0123456789abcdef0123456789abcdef01234567');
	});

	test('short, long or quoted hex is not a commit', () => {
		assert.strictEqual(parseHistoryQuery('abc123').commit, undefined);
		assert.strictEqual(parseHistoryQuery('0123456789abcdef0123456789abcdef012345678').commit, undefined);
		assert.strictEqual(parseHistoryQuery('"abc1234"').commit, undefined);
		assert.strictEqual(parseHistoryQuery('deadbeefz').commit, undefined);
	});

	test('merges', () => {
		assert.strictEqual(parseHistoryQuery('merges:only').merges, 'only');
		assert.strictEqual(parseHistoryQuery('merges:NONE').merges, 'none');
		assert.strictEqual(parseHistoryQuery('merges:maybe').merges, undefined);
		assert.strictEqual(parseHistoryQuery('merges:maybe').message, 'merges:maybe');
	});

	test('unknown keys and conventional commit prefixes are text', () => {
		const query = parseHistoryQuery('fix: blame hover feat(scm):x');
		assert.strictEqual(query.hasFields, false);
		assert.strictEqual(query.message, 'fix: blame hover feat(scm):x');
	});

	test('combined query', () => {
		const query = parseHistoryQuery('author:jane after:2026-01-01 path:src/a.ts merges:none "null check"');
		assert.deepStrictEqual(query, {
			author: 'jane',
			since: '2026-01-01T00:00:00',
			until: undefined,
			path: 'src/a.ts',
			follow: true,
			lineRange: undefined,
			message: 'null check',
			commit: undefined,
			merges: 'none',
			hasFields: true
		});
	});
});
