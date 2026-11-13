/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltCodeIndexFilesResult, IVoltCodeIndexFindFilesRequest, IVoltCodeIndexFindFilesResult, IVoltCodeIndexSearchRequest, IVoltCodeIndexSearchResult, NullVoltCodeIndexService } from '../../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IVoltSandboxSettings } from '../../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { ISearchService } from '../../../../search/common/search.js';
import { ISearchConfinement, VoltSearch } from '../../../browser/search/voltSearch.js';
import { createSearchTools } from '../../../browser/tools/searchTools.js';
import { sandboxReadRefusal } from '../../../common/hostToolSandbox.js';

const WS = '/Users/me/proj';
const SANDBOX: IVoltSandboxSettings = { level: 'workspace-write', network: false };
/** `proj/k` is a link the agent made to `~/.ssh`. */
const realPath = (path: string) => path.startsWith(`${WS}/k/`) ? `/Users/me/.ssh/${path.slice(`${WS}/k/`.length)}` : path;
const CONFINE: ISearchConfinement = {
	readRefusal: async path => sandboxReadRefusal(SANDBOX, realPath(path), { roots: [WS], home: '/Users/me', tmpdir: '/tmp', platform: 'darwin' }),
};

/** An index that (raced, or stale) still holds a file through the link: the result filter must catch it. */
class LeakyIndex extends NullVoltCodeIndexService {
	readonly requests: unknown[] = [];
	override async search(...request: unknown[]): Promise<IVoltCodeIndexSearchResult> {
		this.requests.push(request[0]);
		return {
			kind: 'results',
			files: [
				{ path: 'k/id_ed25519', matches: 1, lines: [{ line: 2, text: 'CANARY-c4n4ry-KEY', match: true }] },
				{ path: 'src/notes.md', matches: 1, lines: [{ line: 1, text: 'see CANARY handling', match: true }] },
			],
			limitHit: false,
			stats: { candidates: 2, scanned: 2, indexedFiles: 2, ms: 1, engine: 'index' },
		};
	}
	override async files(...request: unknown[]): Promise<IVoltCodeIndexFilesResult> {
		this.requests.push(request[0]);
		return { kind: 'results', paths: ['k/id_ed25519', 'src/a.ts'], limitHit: false };
	}
	override async findFiles(...request: unknown[]): Promise<IVoltCodeIndexFindFilesResult> {
		this.requests.push(request[0]);
		return { kind: 'results', paths: ['k/id_ed25519', 'src/id.ts'], limitHit: false, engine: 'index', ms: 1 };
	}
}

class DecliningIndex extends NullVoltCodeIndexService {
	override async search(): Promise<IVoltCodeIndexSearchResult> {
		return { kind: 'fallback', reason: 'indexing' };
	}
}

/** The search service (ripgrep) must never run for a sandboxed chat. */
const NO_RIPGREP = new Proxy({}, { get: () => () => { throw new Error('ripgrep ran for a sandboxed chat'); } }) as ISearchService;

suite('Volt search for a sandboxed chat (B-15, GATE-SYM-1)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function tools(index: NullVoltCodeIndexService) {
		const changes = store.add(new Emitter<void>());
		const search = store.add(new VoltSearch(NO_RIPGREP, { service: index, enabled: () => true, options: () => ({ ignoreSymlinks: false }), fff: () => ({ mode: 'auto' }) }, changes.event, 1_000));
		const list = createSearchTools(search, () => URI.file(WS), CONFINE);
		return (name: string, args: Record<string, unknown>) => list.find(tool => tool.name === name)!.execute(args, { signal: new AbortController().signal });
	}

	test('GATE-SYM-1: instant_grep CANARY returns nothing from the linked credential folder', async () => {
		const index = new LeakyIndex();
		const run = tools(index);
		const result = await run('grep', { pattern: 'CANARY' });
		assert.ok(!result.isError, result.text);
		assert.ok(!result.text.includes('c4n4ry'), result.text);
		assert.ok(!result.text.includes('k/id_ed25519'), result.text);
		assert.match(result.text, /src\/notes\.md/, 'the project\'s own match stays');
		const request = index.requests[0] as IVoltCodeIndexSearchRequest;
		assert.deepStrictEqual(request.options, { ignoreSymlinks: true, confined: true }, 'the confined index, never following links');
	});

	test('file listings are filtered the same way, and FFF is not used', async () => {
		const index = new LeakyIndex();
		const run = tools(index);
		const globbed = await run('glob', { pattern: '**/*' });
		assert.strictEqual(globbed.text, 'src/a.ts');
		const found = await run('find_files', { query: 'id' });
		assert.strictEqual(found.text, 'src/id.ts');
		assert.strictEqual((index.requests[1] as IVoltCodeIndexFindFilesRequest).fff, 'off');
	});

	test('what the confined index cannot answer is declined, never searched with ripgrep', async () => {
		const run = tools(new DecliningIndex());
		const result = await run('grep', { pattern: 'CANARY' });
		assert.ok(result.isError);
		assert.match(result.text, /could not answer this for a sandboxed chat \(indexing\)\. Search with your own tools/);
	});
});
