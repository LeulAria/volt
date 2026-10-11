/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltQuery, VoltQueryCache } from '../../browser/queryCache.js';

suite('Volt query cache', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function counted<T>(key: string, values: T[], extra: Partial<IVoltQuery<T>> = {}): IVoltQuery<T> & { calls: number } {
		const query: IVoltQuery<T> & { calls: number } = {
			key,
			calls: 0,
			persist: false,
			fetch: async (): Promise<T> => values[Math.min(query.calls++, values.length - 1)],
			...extra,
		};
		return query;
	}

	test('fresh data comes from the cache; stale data is refetched', async () => {
		const cache = store.add(new VoltQueryCache(new NullLogService()));
		const query = counted('a', [1, 2], { staleTime: 60_000 });
		assert.strictEqual(await cache.get(query), 1);
		assert.strictEqual(await cache.get(query), 1);
		assert.strictEqual(query.calls, 1);
		assert.strictEqual(await cache.get(query, true), 2);
		const stale = counted('b', [1, 2], { staleTime: 0 });
		await cache.get(stale);
		assert.strictEqual(await cache.get(stale), 2);
	});

	test('one fetch per key at a time', async () => {
		const cache = store.add(new VoltQueryCache(new NullLogService()));
		const query = counted('c', ['x']);
		const [a, b] = await Promise.all([cache.get(query), cache.get(query)]);
		assert.deepStrictEqual([a, b, query.calls], ['x', 'x', 1]);
	});

	test('read answers from the cache at once and refetches behind it', async () => {
		const cache = store.add(new VoltQueryCache(new NullLogService()));
		const query = counted('d', ['old', 'new'], { staleTime: 0 });
		const updates: string[] = [];
		store.add(cache.onDidUpdate(key => updates.push(key)));
		assert.strictEqual(await cache.read(query), 'old');
		assert.strictEqual(await cache.read(query), 'old');
		await timeout(0);
		assert.strictEqual(await cache.read(query), 'new');
		assert.deepStrictEqual(updates.slice(0, 2), ['d', 'd']);
	});

	test('a new cache (a restart) shows what the last one saved', async () => {
		const key = `persist:${Date.now()}:${Math.random()}`;
		const first = new VoltQueryCache(new NullLogService());
		await first.get({ key, fetch: async () => ({ items: ['a', 'b'] }) });
		await timeout(50);
		first.dispose();
		const second = store.add(new VoltQueryCache(new NullLogService()));
		const disposables = store.add(new DisposableStore());
		const handle = disposables.add(second.watch<{ items: string[] }>({ key, staleTime: 60_000, fetch: async () => { throw new Error('should not fetch'); } }));
		await new Promise<void>(resolve => disposables.add(handle.onDidChange(() => handle.state.loaded && resolve())));
		assert.deepStrictEqual(handle.state.data, { items: ['a', 'b'] });
		assert.strictEqual(handle.state.fetching, false);
	});

	test('watch starts on cached data, keeps it through a failed refetch, and invalidate refetches', async () => {
		const cache = store.add(new VoltQueryCache(new NullLogService()));
		let fail = false;
		let n = 0;
		const query: IVoltQuery<number> = { key: 'list:1', persist: false, staleTime: 60_000, fetch: async () => { if (fail) { throw new Error('offline'); } return ++n; } };
		await cache.get(query);
		const disposables = store.add(new DisposableStore());
		const handle = disposables.add(cache.watch(query));
		assert.strictEqual(handle.state.data, 1);
		fail = true;
		await handle.refetch(true);
		assert.strictEqual(handle.state.data, 1);
		assert.ok(handle.state.error);
		assert.strictEqual(handle.state.fetching, false);
		fail = false;
		let changes = 0;
		disposables.add(handle.onDidChange(() => changes++));
		cache.invalidate('list:');
		await timeout(0);
		assert.strictEqual(handle.state.data, 2);
		assert.strictEqual(handle.state.error, undefined);
		assert.ok(changes > 0);
	});
});
