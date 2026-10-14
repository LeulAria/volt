/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { wantsRtk } from '../../../common/codeIntelligence.js';
import { SearchCache } from '../../../common/search/searchCache.js';

suite('Volt search cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a hit until any file changes', () => {
		const cache = new SearchCache<string>();
		cache.set('q', 'result', cache.begin());
		assert.strictEqual(cache.get('q'), 'result');
		cache.invalidate();
		assert.strictEqual(cache.get('q'), undefined);
		assert.deepStrictEqual(cache.stats(), { hits: 1, misses: 1, size: 0 });
	});

	test('a search that raced a change is not cached', () => {
		const cache = new SearchCache<string>();
		const started = cache.begin();
		cache.invalidate(); // a file changed while the search ran
		cache.set('q', 'maybe stale', started);
		assert.strictEqual(cache.get('q'), undefined);
	});

	test('entries expire, and the least recently used go first', () => {
		let now = 0;
		const cache = new SearchCache<string>(2, 1_000, () => now);
		cache.set('a', 'A', cache.begin());
		cache.set('b', 'B', cache.begin());
		assert.strictEqual(cache.get('a'), 'A'); // a is now the most recent
		cache.set('c', 'C', cache.begin()); // evicts b
		assert.strictEqual(cache.get('b'), undefined);
		assert.strictEqual(cache.get('a'), 'A');
		now = 1_001;
		assert.strictEqual(cache.get('a'), undefined, 'too old');
	});
});

suite('Volt RTK routing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wraps ordinary commands, never RTK itself or empty ones', () => {
		assert.strictEqual(wantsRtk('git status'), true);
		assert.strictEqual(wantsRtk('  '), false);
		assert.strictEqual(wantsRtk('rtk proxy git log'), false, 'no double wrap; rtk proxy is the raw-output escape hatch');
		assert.strictEqual(wantsRtk('rtk'), false);
		assert.strictEqual(wantsRtk('rtkfoo --x'), true, 'only the rtk command itself');
	});

	test('never wraps a command that carries the wrapper\'s own variable (no recursion)', () => {
		assert.strictEqual(wantsRtk('eval "$VOLT_RTK_CMD"'), false);
	});

	test('exclusions match whole leading words', () => {
		const exclusions = ['git log', 'npm'];
		assert.strictEqual(wantsRtk('git log --oneline -5', exclusions), false);
		assert.strictEqual(wantsRtk('git status', exclusions), true);
		assert.strictEqual(wantsRtk('git logs', exclusions), true, 'a longer word is another command');
		assert.strictEqual(wantsRtk('npm test', exclusions), false);
		assert.strictEqual(wantsRtk('npx tsc', exclusions), true);
		assert.strictEqual(wantsRtk('git status', ['', '   ']), true, 'blank exclusions exclude nothing');
	});
});
