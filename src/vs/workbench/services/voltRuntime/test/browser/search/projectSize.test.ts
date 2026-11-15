/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IVoltCodeIndexService, NullVoltCodeIndexService } from '../../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { ISearchComplete, ISearchService } from '../../../../search/common/search.js';
import { ContextRetriever } from '../../../browser/search/contextRetriever.js';
import { gitDirFromFile, gitIndexEntryCount, gitTrackedFileCount } from '../../../browser/search/projectSize.js';
import { VoltSearch } from '../../../browser/search/voltSearch.js';

function header(count: number): Uint8Array {
	const bytes = new Uint8Array(12);
	bytes.set([0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2]);
	new DataView(bytes.buffer).setUint32(8, count);
	return bytes;
}

suite('Volt search: a project\'s size from git, and a send\'s context search without the index (round 7)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function files() {
		const service = store.add(new FileService(new NullLogService()));
		store.add(service.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const write = (path: string, bytes: Uint8Array | string) => service.writeFile(URI.file(path), typeof bytes === 'string' ? VSBuffer.fromString(bytes) : VSBuffer.wrap(bytes));
		return { service, write };
	}

	test('the entry count is read from the index header', () => {
		assert.strictEqual(gitIndexEntryCount(header(14)), 14);
		assert.strictEqual(gitIndexEntryCount(header(70_000)), 70_000);
		assert.strictEqual(gitIndexEntryCount(header(3_000_000_000)), 3_000_000_000);
		assert.strictEqual(gitIndexEntryCount(new Uint8Array([1, 2, 3])), undefined);
		assert.strictEqual(gitIndexEntryCount(VSBuffer.fromString('not an index file').buffer), undefined);
	});

	test('a .git file points to its git folder, relative or absolute', () => {
		assert.strictEqual(gitDirFromFile('gitdir: /main/.git/worktrees/w\n', URI.file('/w'))?.fsPath, URI.file('/main/.git/worktrees/w').fsPath);
		assert.strictEqual(gitDirFromFile('gitdir: ../.git/modules/sub', URI.file('/repo/sub'))?.path, '/repo/.git/modules/sub');
		assert.strictEqual(gitDirFromFile('nonsense', URI.file('/x')), undefined);
	});

	test('the tracked-file count of a repository, a folder inside it, a linked worktree; none outside a repository or with a split index', async () => {
		const { service, write } = files();
		await write('/repo/.git/index', header(14));
		await write('/repo/src/a.ts', 'x');
		await write('/main/.git/worktrees/w/index', header(4_200));
		await write('/w/.git', 'gitdir: /main/.git/worktrees/w\n');
		await write('/split/.git/index', header(3));
		await write('/split/.git/sharedindex.0123456789abcdef', 'x');
		await write('/plain/a.txt', 'x');
		assert.strictEqual(await gitTrackedFileCount(service, URI.file('/repo')), 14);
		assert.strictEqual(await gitTrackedFileCount(service, URI.file('/repo/src')), 14);
		assert.strictEqual(await gitTrackedFileCount(service, URI.file('/w')), 4_200);
		assert.strictEqual(await gitTrackedFileCount(service, URI.file('/split')), undefined);
		assert.strictEqual(await gitTrackedFileCount(service, URI.file('/plain')), undefined);
	});

	test('a send\'s context search marked noIndex never calls the code index (no index process starts)', async () => {
		const { service } = files();
		let indexCalls = 0;
		const index = new Proxy(new NullVoltCodeIndexService(), {
			get: (target, name) => {
				const value = Reflect.get(target, name);
				return typeof value === 'function' ? (...args: unknown[]) => { indexCalls++; return value.apply(target, args); } : value;
			},
		}) as IVoltCodeIndexService;
		let ripgrep = 0;
		const searchService = {
			textSearch: async () => { ripgrep++; return { limitHit: false, messages: [], results: [] } as unknown as ISearchComplete; },
			fileSearch: async () => { ripgrep++; return { limitHit: false, messages: [], results: [] } as unknown as ISearchComplete; },
		} as unknown as ISearchService;
		const indexed = store.add(new VoltSearch(searchService, { service: index, enabled: () => true, options: () => ({}) }, Event.None));
		const plain = store.add(new VoltSearch(searchService, undefined, Event.None));
		const retriever = new ContextRetriever(indexed, service, plain);
		await retriever.retrieve(URI.file('/repo'), 'why does paginate in src/paginate.ts skip the last page', { budgetTokens: 400, deadlineMs: 2_000, snippets: false, indexOnly: true, noIndex: true, token: CancellationToken.None });
		assert.strictEqual(indexCalls, 0);
		assert.ok(ripgrep > 0, 'ripgrep answered instead');
		// Without noIndex the same send asks the index first.
		await retriever.retrieve(URI.file('/repo'), 'why does paginate in src/paginate.ts skip the last page', { budgetTokens: 400, deadlineMs: 2_000, snippets: false, token: CancellationToken.None });
		assert.ok(indexCalls > 0);
	});
});
