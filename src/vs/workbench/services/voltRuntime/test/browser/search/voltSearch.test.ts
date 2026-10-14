/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltCodeIndexSearchResult, IVoltCodeIndexService, NullVoltCodeIndexService } from '../../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { ISearchComplete, ISearchService, ITextQuery } from '../../../../search/common/search.js';
import { VoltSearch } from '../../../browser/search/voltSearch.js';

const ROOT = URI.file('/repo');

/** The search service's answer (ripgrep): one match in `src/a.ts`. */
function fakeRipgrep(calls: { count: number }): ISearchService {
	return {
		textSearch: async (_query: ITextQuery): Promise<ISearchComplete> => {
			calls.count++;
			return {
				limitHit: false,
				messages: [],
				results: [{ resource: URI.file('/repo/src/a.ts'), results: [{ previewText: 'const needle = 1;', rangeLocations: [{ source: { startLineNumber: 0, startColumn: 6, endLineNumber: 0, endColumn: 12 }, preview: { startLineNumber: 0, startColumn: 6, endLineNumber: 0, endColumn: 12 } }] }] }],
			} as unknown as ISearchComplete;
		},
	} as unknown as ISearchService;
}

class FakeIndex extends NullVoltCodeIndexService {
	searches = 0;
	constructor(private readonly answer: () => Promise<IVoltCodeIndexSearchResult>) {
		super();
	}
	override search(): Promise<IVoltCodeIndexSearchResult> {
		this.searches++;
		return this.answer();
	}
}

function engine(service: IVoltCodeIndexService, ripgrep: ISearchService, changes: Emitter<void>, timeoutMs = 50): VoltSearch {
	return new VoltSearch(ripgrep, { service, enabled: () => true, options: () => ({}) }, changes.event, timeoutMs);
}

const QUERY = { root: ROOT, folder: ROOT, pattern: 'needle', literal: true, maxMatches: 10 };

suite('Volt search: routing, fallbacks and cache', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the index answers; paths are shown relative to the root', async () => {
		const changes = store.add(new Emitter<void>());
		const index = new FakeIndex(async () => ({ kind: 'results', files: [{ path: 'src/b.ts', matches: 1, lines: [{ line: 3, text: 'needle', match: true }] }], limitHit: false, stats: { candidates: 1, scanned: 1, indexedFiles: 10, ms: 1, engine: 'index' } }));
		const search = store.add(engine(index, fakeRipgrep({ count: 0 }), changes));
		const result = await search.grep(QUERY, CancellationToken.None);
		assert.strictEqual(result.engine, 'index');
		assert.deepStrictEqual(result.files.map(file => file.path), ['src/b.ts']);
	});

	test('a hung index: ripgrep answers after the timeout and says why', async () => {
		const changes = store.add(new Emitter<void>());
		const ripgrep = { count: 0 };
		const search = store.add(engine(new FakeIndex(() => new Promise(() => { /* never */ })), fakeRipgrep(ripgrep), changes));
		const result = await search.grep(QUERY, CancellationToken.None);
		assert.strictEqual(result.engine, 'ripgrep');
		assert.match(result.fallback ?? '', /did not answer within 50 ms/);
		assert.deepStrictEqual(result.files.map(file => file.path), ['src/a.ts']);
		assert.strictEqual(ripgrep.count, 1);
	});

	test('a failing index: ripgrep answers', async () => {
		const changes = store.add(new Emitter<void>());
		const search = store.add(engine(new FakeIndex(() => Promise.reject(new Error('index process exited'))), fakeRipgrep({ count: 0 }), changes));
		const result = await search.grep(QUERY, CancellationToken.None);
		assert.strictEqual(result.engine, 'ripgrep');
		assert.strictEqual(result.fallback, 'index process exited');
	});

	test('the same search is cached until a file changes', async () => {
		const changes = store.add(new Emitter<void>());
		const index = new FakeIndex(async () => ({ kind: 'results', files: [], limitHit: false, stats: { candidates: 0, scanned: 0, indexedFiles: 10, ms: 1, engine: 'index' } }));
		const search = store.add(engine(index, fakeRipgrep({ count: 0 }), changes));
		await search.grep(QUERY, CancellationToken.None);
		assert.strictEqual((await search.grep(QUERY, CancellationToken.None)).engine, 'cache');
		assert.strictEqual(index.searches, 1);
		changes.fire();
		assert.strictEqual((await search.grep(QUERY, CancellationToken.None)).engine, 'index');
		search.invalidate();
		await search.grep(QUERY, CancellationToken.None);
		assert.strictEqual(index.searches, 3);
		assert.strictEqual(search.cacheStats().hits, 1);
	});

	test('node_modules (outside the watcher) is never cached', async () => {
		const changes = store.add(new Emitter<void>());
		const index = new FakeIndex(async () => ({ kind: 'results', files: [], limitHit: false, stats: { candidates: 0, scanned: 0, indexedFiles: 10, ms: 1, engine: 'index' } }));
		const search = store.add(engine(index, fakeRipgrep({ count: 0 }), changes));
		const inModules = { ...QUERY, folder: URI.file('/repo/node_modules/lib') };
		await search.grep(inModules, CancellationToken.None);
		await search.grep(inModules, CancellationToken.None);
		assert.strictEqual(index.searches, 2);
	});
});
