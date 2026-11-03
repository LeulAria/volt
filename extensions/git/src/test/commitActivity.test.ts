/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { commitActivityArgs, parseCommitActivity } from '../commitActivity';

suite('commitActivity', () => {
	const at = (y: number, m: number, d: number, h: number) => Math.floor(new Date(y, m, d, h).getTime() / 1000);
	const midnight = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

	test('buckets commits into local days, oldest first, counting agent trailers', () => {
		const stdout = [
			`${at(2026, 9, 25, 9)}\x1fCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\n\x1e`,
			`${at(2026, 9, 25, 1)}\x1f\x1e`,
			`${at(2026, 9, 24, 23)}\x1fCo-authored-by: Ada Lovelace <ada@example.com>\n\x1e`,
		].join('\n');
		assert.deepStrictEqual(parseCommitActivity(stdout), [
			[midnight(2026, 9, 24), 1, 0],
			[midnight(2026, 9, 25), 2, 1],
		]);
	});

	test('skips junk records', () => {
		assert.deepStrictEqual(parseCommitActivity('\nnot a record\x1e0\x1f\x1e'), []);
	});

	test('walks branches, remotes and tags, not checkpoint refs, unless given revisions', () => {
		assert.deepStrictEqual(commitActivityArgs(false).slice(2), ['--branches', '--remotes', '--tags']);
		assert.deepStrictEqual(commitActivityArgs(true).slice(2), ['--stdin']);
	});
});
