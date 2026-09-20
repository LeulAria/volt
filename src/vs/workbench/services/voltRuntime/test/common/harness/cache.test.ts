/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { cacheKey, IntelligentCache } from '../../../common/harness/cache.js';

suite('Volt intelligent cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hits, misses, and expiry', () => {
		const cache = new IntelligentCache();
		cache.set('tool', 'read:a.ts', 'contents', 1_000, 50);
		assert.strictEqual(cache.get('tool', 'read:a.ts', 1_010), 'contents');
		assert.strictEqual(cache.get('tool', 'read:a.ts', 1_060), undefined);
		assert.strictEqual(cache.stats('tool').hits, 1);
		assert.strictEqual(cache.stats('tool').misses, 1);
	});

	test('namespaces do not collide and mutation drops tool/search', () => {
		const cache = new IntelligentCache();
		cache.set('context', 'k', 'prompt');
		cache.set('tool', 'k', 'result');
		cache.set('search', 'k', 'hits');
		cache.invalidateAfterMutation();
		assert.strictEqual(cache.get('context', 'k'), 'prompt');
		assert.strictEqual(cache.get('tool', 'k'), undefined);
		assert.strictEqual(cache.get('search', 'k'), undefined);
	});

	test('cacheKey is stable', () => {
		assert.strictEqual(cacheKey('a', 'b'), cacheKey('a', 'b'));
		assert.notStrictEqual(cacheKey('a', 'b'), cacheKey('a', 'c'));
	});
});
