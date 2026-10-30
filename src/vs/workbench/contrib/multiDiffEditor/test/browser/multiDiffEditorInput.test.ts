/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { publishInOrder } from '../../browser/multiDiffEditorInput.js';

suite('MultiDiffEditorInput publishInOrder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function deferred(count: number): DeferredPromise<string | undefined>[] {
		return Array.from({ length: count }, () => new DeferredPromise<string | undefined>());
	}

	test('shows the first documents before the rest resolve, in list order', () => runWithFakedTimers({}, async () => {
		const items = deferred(1000);
		const published: string[][] = [];
		const publisher = publishInOrder<string>(items.map(item => item.p), values => published.push(values));

		void items[1].complete('b');
		void items[0].complete('a');
		await timeout(50);
		assert.deepStrictEqual(published, [['a', 'b']], 'the first two show while 998 are still loading');

		// Out of order: a later file shows, an earlier one fills in above it in the next batch.
		void items[5].complete('f');
		await timeout(200);
		void items[2].complete('c');
		await timeout(200);
		assert.deepStrictEqual(published.slice(1), [['a', 'b', 'f'], ['a', 'b', 'c', 'f']]);

		publisher.dispose();
	}));

	test('batches publishes while documents stream in, and publishes all at the end', () => runWithFakedTimers({}, async () => {
		const items = deferred(500);
		const published: string[][] = [];
		const publisher = publishInOrder<string>(items.map(item => item.p), values => published.push(values));

		for (let i = 0; i < items.length; i++) {
			void items[i].complete(`f${i}`);
			if (i % 10 === 9) {
				await timeout(10);
			}
		}
		await timeout(0);
		assert.ok(published.length < 10, `${published.length} publishes for 500 files`);
		assert.strictEqual(published.at(-1)?.length, 500);

		publisher.dispose();
	}));

	test('says nothing until a document resolves: failures alone keep it loading', () => runWithFakedTimers({}, async () => {
		const items = deferred(3);
		const published: string[][] = [];
		const publisher = publishInOrder<string>(items.map(item => item.p), values => published.push(values));

		void items[0].complete(undefined);
		void items[1].error(new Error('binary'));
		await timeout(500);
		assert.deepStrictEqual(published, []);

		void items[2].complete(undefined);
		await timeout(0);
		assert.deepStrictEqual(published, [[]], 'all failed: an empty list, not "Loading..."');

		publisher.dispose();
	}));

	test('an empty list publishes at once; a disposed publisher stops', () => runWithFakedTimers({}, async () => {
		const published: string[][] = [];
		publishInOrder<string>([], values => published.push(values)).dispose();
		assert.deepStrictEqual(published, [[]]);

		const items = deferred(2);
		const later: string[][] = [];
		const publisher = publishInOrder<string>(items.map(item => item.p), values => later.push(values));
		publisher.dispose();
		void items[0].complete('a');
		void items[1].complete('b');
		await timeout(500);
		assert.deepStrictEqual(later, []);
	}));
});
