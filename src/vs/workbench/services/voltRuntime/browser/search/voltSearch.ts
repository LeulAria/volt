/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IVoltCodeIndexOptions, IVoltCodeIndexService, IVoltCodeSymbol, VoltCodeSymbolKind, VoltFffMode } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { ISearchService, ITextSearchContext, QueryType, resultIsMatch } from '../../../search/common/search.js';
import { SearchCache } from '../../common/search/searchCache.js';
import { displayPath } from '../tools/workspacePath.js';

/**
 * Volt's code index, when Settings > Code Intelligence allows it, and how fuzzy file searches
 * may use FFF.
 */
export interface ISearchIndex {
	readonly service: IVoltCodeIndexService;
	readonly enabled: () => boolean;
	readonly options: () => IVoltCodeIndexOptions;
	readonly fff?: () => { readonly mode: VoltFffMode; readonly path?: string };
}

export type VoltSearchEngine = 'index' | 'ripgrep' | 'fff' | 'cache';

/** How an answer was produced: which engine, how long, and why a faster engine passed. */
export interface IVoltSearchMeta {
	readonly engine: VoltSearchEngine;
	readonly ms: number;
	/** The index (or FFF) could not answer exactly, and this is why; the next engine did. */
	readonly fallback?: string;
}

export interface IVoltGrepQuery {
	/** The workspace root: index root and the base of the paths shown. */
	readonly root: URI | undefined;
	/** Search below this folder. */
	readonly folder: URI;
	readonly pattern: string;
	readonly literal?: boolean;
	readonly caseSensitive?: boolean;
	readonly multiline?: boolean;
	readonly wholeWord?: boolean;
	/** Lines around each match, 0-5. */
	readonly context?: number;
	/** Globs over workspace-relative paths; a file must match one. */
	readonly includes?: readonly string[];
	/** Matching lines to collect before stopping; `limitHit` says more exist. */
	readonly maxMatches: number;
	readonly maxLineChars?: number;
	/** Only what the index answers: nothing (with the reason as `fallback`) rather than a ripgrep scan. */
	readonly indexOnly?: boolean;
}

export interface IVoltGrepFile {
	/** Shown relative to the root. */
	readonly path: string;
	readonly matches: number;
	/** Line number to its text; `match` false for context lines. */
	readonly lines: ReadonlyMap<number, { readonly text: string; readonly match: boolean }>;
}

export interface IVoltGrepResult extends IVoltSearchMeta {
	readonly files: readonly IVoltGrepFile[];
	readonly limitHit: boolean;
}

export interface IVoltPathsResult extends IVoltSearchMeta {
	/** Shown relative to the root; best first for fuzzy searches, sorted for globs. */
	readonly paths: readonly string[];
	readonly limitHit: boolean;
}

export interface IVoltSymbolsResult extends IVoltSearchMeta {
	readonly symbols: readonly IVoltCodeSymbol[];
	readonly limitHit: boolean;
}

const DEFAULT_EXCLUDES = { '**/node_modules': true, '**/.git': true } as const;
const LINE_CHARS = 500;
/**
 * The index answers in milliseconds; past this it is stuck (a huge first load, a hung process)
 * and ripgrep answers instead, with the reason. The index call keeps running and warms up.
 */
const INDEX_TIMEOUT_MS = 5_000;

type Declined = { readonly kind: 'fallback'; readonly reason: string };

/** An index call that becomes a `fallback` (never a rejection) when it fails or takes too long. */
function bounded<T>(call: Promise<T>, timeoutMs: number): Promise<T | Declined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Declined>(resolve => {
		timer = setTimeout(() => resolve({ kind: 'fallback', reason: `the code index did not answer within ${timeoutMs} ms` }), timeoutMs);
	});
	const settled = call.then(value => value, (err): Declined => ({ kind: 'fallback', reason: err instanceof Error ? err.message : String(err) }));
	return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** Declarations without the index: one ripgrep pass for the usual declaring keywords. */
const DECLARATION_KEYWORDS = 'function|class|interface|type|enum|def|fn|func|fun|struct|trait|impl|module|namespace|const|let|var|val|static|macro_rules!';

/**
 * The one search API in Volt: the agent's tools, the MCP tools for Claude Code and Codex, and the
 * context retriever all go through it. Routing, fastest first:
 *
 * - text and regex: the code index (trigram candidates, verified on the files as they are now),
 *   then ripgrep through the search service when the index cannot answer exactly;
 * - globs: the index's file list, then ripgrep;
 * - fuzzy file names: FFF when installed, the index's own fuzzy search, then the search service's;
 * - symbols: the index's declarations, then a ripgrep pass for declaring keywords.
 *
 * Each engine either answers exactly or declines with a reason; a partial answer always says so
 * (`limitHit`). Answers are cached until any file changes.
 */
export class VoltSearch extends Disposable {

	private readonly cache = new SearchCache<IVoltSearchMeta>();

	constructor(
		private readonly search: ISearchService,
		private readonly index: ISearchIndex | undefined,
		onDidChangeFiles: Event<unknown>,
		private readonly indexTimeoutMs = INDEX_TIMEOUT_MS,
	) {
		super();
		this._register(onDidChangeFiles(() => this.cache.invalidate()));
	}

	private bounded<T>(call: Promise<T>): Promise<T | Declined> {
		return bounded(call, this.indexTimeoutMs);
	}

	/** The agent wrote a file: forget what was found before. */
	invalidate(): void {
		this.cache.invalidate();
	}

	cacheStats(): { readonly hits: number; readonly misses: number; readonly size: number } {
		return this.cache.stats();
	}

	private readonly fileCounts = new Map<string, { readonly at: number; readonly count: Promise<number | undefined> }>();

	/** Files the index holds for `root` (for term weights), cached for a minute; undefined without an index. */
	fileCount(root: URI): Promise<number | undefined> {
		const indexed = this.indexFor(root, root);
		if (!indexed) {
			return Promise.resolve(undefined);
		}
		const key = root.toString();
		const cached = this.fileCounts.get(key);
		if (cached && Date.now() - cached.at < 60_000) {
			return cached.count;
		}
		const count = this.bounded(indexed.service.status([root.fsPath])).then(result => Array.isArray(result) && result[0]?.files ? result[0].files : undefined);
		this.fileCounts.set(key, { at: Date.now(), count });
		return count;
	}

	private indexFor(root: URI | undefined, folder: URI): ISearchIndex | undefined {
		return this.index && root?.scheme === Schemas.file && folder.scheme === Schemas.file && this.index.enabled() ? this.index : undefined;
	}

	private async cached<T extends IVoltSearchMeta>(key: string, run: () => Promise<T>, folder?: URI, indexOnly?: boolean): Promise<T> {
		// node_modules is outside the workspace watcher: a change there would never reach the cache.
		// An index-only answer may be "not now": it never stands in for a full search, and the index is fast.
		if (folder?.path.includes('/node_modules') || indexOnly) {
			return run();
		}
		const hit = this.cache.get(key) as T | undefined;
		if (hit) {
			return { ...hit, engine: 'cache', ms: 0 };
		}
		const epoch = this.cache.begin();
		const value = await run();
		this.cache.set(key, value, epoch);
		return value;
	}

	grep(query: IVoltGrepQuery, token: CancellationToken): Promise<IVoltGrepResult> {
		const key = JSON.stringify(['grep', query.root?.toString(), query.folder.toString(), query.pattern, !!query.literal, !!query.caseSensitive, !!query.multiline, !!query.wholeWord, query.context ?? 0, query.includes ?? [], query.maxMatches]);
		return this.cached(key, () => this.doGrep(query, token), query.folder, query.indexOnly);
	}

	private async doGrep(query: IVoltGrepQuery, token: CancellationToken): Promise<IVoltGrepResult> {
		const started = Date.now();
		const { root, folder } = query;
		const maxLineChars = query.maxLineChars ?? LINE_CHARS;
		let fallback: string | undefined;
		const indexed = this.indexFor(root, folder);
		if (indexed && root) {
			const result = await this.bounded(indexed.service.search({
				root: root.fsPath,
				folder: folder.fsPath,
				pattern: query.pattern,
				isRegExp: !query.literal,
				caseSensitive: !!query.caseSensitive,
				multiline: !!query.multiline,
				wholeWord: !!query.wholeWord,
				includes: query.includes,
				context: query.context,
				maxMatches: query.maxMatches,
				maxLineChars,
				options: indexed.options(),
			}));
			if (result.kind === 'results') {
				return {
					files: result.files.map(file => ({
						path: displayPath(root, joinPath(root, file.path)),
						lines: new Map(file.lines.map(line => [line.line, { text: line.text.replace(/\s+$/, ''), match: line.match }])),
						matches: file.matches,
					})),
					limitHit: result.limitHit,
					engine: 'index',
					ms: Date.now() - started,
				};
			}
			fallback = result.reason;
		}
		if (query.indexOnly) {
			return { files: [], limitHit: false, engine: 'index', ms: Date.now() - started, fallback: fallback ?? 'no index' };
		}
		const includes = query.includes?.length ? Object.fromEntries(query.includes.map(glob => [glob, true])) : undefined;
		const complete = await this.search.textSearch({
			type: QueryType.Text,
			contentPattern: {
				pattern: query.pattern,
				isRegExp: !query.literal,
				isCaseSensitive: !!query.caseSensitive,
				isMultiline: !!query.multiline,
				isWordMatch: !!query.wholeWord,
			},
			folderQueries: [{ folder }],
			// One more than asked, to know whether more exist.
			maxResults: query.maxMatches + 1,
			previewOptions: { matchLines: 1, charsPerLine: maxLineChars },
			...(query.context ? { surroundingContext: query.context } : {}),
			...(includes ? { includePattern: includes } : {}),
			...(folder.path.includes('/node_modules') ? {} : { excludePattern: { ...DEFAULT_EXCLUDES } }),
		}, token);
		const files: IVoltGrepFile[] = [];
		let total = 0;
		for (const file of complete.results) {
			const lines = new Map<number, { text: string; match: boolean }>();
			let matches = 0;
			for (const result of file.results ?? []) {
				if (resultIsMatch(result)) {
					const line = (result.rangeLocations[0]?.source.startLineNumber ?? 0) + 1;
					lines.set(line, { text: firstLine(result.previewText, maxLineChars), match: true });
					matches++;
				} else {
					const ctx = result as ITextSearchContext;
					if (!lines.has(ctx.lineNumber)) {
						lines.set(ctx.lineNumber, { text: firstLine(ctx.text, maxLineChars), match: false });
					}
				}
			}
			if (matches) {
				files.push({ path: displayPath(root, file.resource), lines, matches });
				total += matches;
			}
		}
		return { files, limitHit: !!complete.limitHit || total > query.maxMatches, engine: 'ripgrep', ms: Date.now() - started, ...(fallback ? { fallback } : {}) };
	}

	/** Files by glob over workspace-relative paths, sorted. */
	glob(query: { readonly root: URI | undefined; readonly folder: URI; readonly pattern: string; readonly limit: number; readonly indexOnly?: boolean }, token: CancellationToken): Promise<IVoltPathsResult> {
		const key = JSON.stringify(['glob', query.root?.toString(), query.folder.toString(), query.pattern, query.limit]);
		return this.cached(key, async () => {
			const started = Date.now();
			const { root, folder } = query;
			let fallback: string | undefined;
			const indexed = this.indexFor(root, folder);
			if (indexed && root) {
				const result = await this.bounded(indexed.service.files({ root: root.fsPath, folder: folder.fsPath, pattern: query.pattern, limit: query.limit, options: indexed.options() }));
				if (result.kind === 'results') {
					return { paths: result.paths.map(path => displayPath(root, joinPath(root, path))), limitHit: result.limitHit, engine: 'index', ms: Date.now() - started };
				}
				fallback = result.reason;
			}
			if (query.indexOnly) {
				return { paths: [], limitHit: false, engine: 'index', ms: Date.now() - started, fallback: fallback ?? 'no index' };
			}
			const complete = await this.search.fileSearch({
				type: QueryType.File,
				filePattern: query.pattern,
				shouldGlobMatchFilePattern: true,
				folderQueries: [{ folder }],
				maxResults: query.limit + 1,
				...(folder.path.includes('/node_modules') ? {} : { excludePattern: { ...DEFAULT_EXCLUDES } }),
			}, token);
			const all = complete.results.map(file => displayPath(root, file.resource)).sort();
			return { paths: all.slice(0, query.limit), limitHit: !!complete.limitHit || all.length > query.limit, engine: 'ripgrep', ms: Date.now() - started, ...(fallback ? { fallback } : {}) };
		}, query.folder, query.indexOnly);
	}

	/** Files by fuzzy name or path (typos allowed), best first. */
	findFiles(query: { readonly root: URI | undefined; readonly folder?: URI; readonly query: string; readonly limit: number; readonly indexOnly?: boolean }, token: CancellationToken): Promise<IVoltPathsResult> {
		const folder = query.folder ?? query.root;
		if (!folder) {
			return Promise.resolve({ paths: [], limitHit: false, engine: 'index', ms: 0, fallback: 'no workspace' });
		}
		const key = JSON.stringify(['find', query.root?.toString(), folder.toString(), query.query, query.limit]);
		return this.cached(key, async () => {
			const started = Date.now();
			const { root } = query;
			const fallbacks: string[] = [];
			const indexed = this.indexFor(root, folder);
			if (indexed && root) {
				const fff = indexed.fff?.() ?? { mode: 'off' as const };
				const result = await this.bounded(indexed.service.findFiles({
					root: root.fsPath,
					...(query.folder ? { folder: query.folder.fsPath } : {}),
					query: query.query,
					limit: query.limit,
					options: indexed.options(),
					fff: fff.mode,
					...(fff.path ? { fffPath: fff.path } : {}),
				}));
				if (result.kind === 'results') {
					return {
						paths: result.paths.map(path => displayPath(root, joinPath(root, path))),
						limitHit: result.limitHit,
						engine: result.engine,
						ms: Date.now() - started,
						...(result.fffSkipped && fff.mode !== 'off' ? { fallback: `FFF: ${result.fffSkipped}` } : {}),
					};
				}
				fallbacks.push(result.reason);
			}
			if (query.indexOnly) {
				return { paths: [], limitHit: false, engine: 'index', ms: Date.now() - started, fallback: fallbacks.join('; ') || 'no index' };
			}
			// The search service's own fuzzy matching (Quick Open's scorer), ranked by score.
			const complete = await this.search.fileSearch({
				type: QueryType.File,
				filePattern: query.query,
				sortByScore: true,
				folderQueries: [{ folder }],
				maxResults: query.limit + 1,
				...(folder.path.includes('/node_modules') ? {} : { excludePattern: { ...DEFAULT_EXCLUDES } }),
			}, token);
			const paths = complete.results.map(file => displayPath(root, file.resource));
			return { paths: paths.slice(0, query.limit), limitHit: !!complete.limitHit || paths.length > query.limit, engine: 'ripgrep', ms: Date.now() - started, ...(fallbacks.length ? { fallback: fallbacks.join('; ') } : {}) };
		}, folder, query.indexOnly);
	}

	/** Where symbols are declared, by name. */
	symbols(query: { readonly root: URI; readonly folder?: URI; readonly name: string; readonly match: 'exact' | 'prefix' | 'fuzzy'; readonly kind?: VoltCodeSymbolKind; readonly limit: number; readonly indexOnly?: boolean }, token: CancellationToken): Promise<IVoltSymbolsResult> {
		const key = JSON.stringify(['symbols', query.root.toString(), query.folder?.toString(), query.name, query.match, query.kind, query.limit]);
		return this.cached(key, async () => {
			const started = Date.now();
			const { root } = query;
			let fallback: string | undefined;
			const indexed = this.indexFor(root, query.folder ?? root);
			if (indexed) {
				const result = await this.bounded(indexed.service.symbols({
					root: root.fsPath,
					query: query.name,
					match: query.match,
					...(query.kind ? { kinds: [query.kind] } : {}),
					...(query.folder ? { path: displayPath(root, query.folder) } : {}),
					limit: query.limit,
					options: indexed.options(),
				}));
				if (result.kind === 'results') {
					return { symbols: result.symbols, limitHit: result.limitHit, engine: 'index', ms: Date.now() - started };
				}
				fallback = result.reason;
			}
			if (query.indexOnly) {
				return { symbols: [], limitHit: false, engine: 'index', ms: Date.now() - started, fallback: fallback ?? 'no index' };
			}
			const escaped = query.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const tail = query.match === 'exact' ? '\\b' : '\\w*';
			const lead = query.match === 'fuzzy' ? '\\w*' : '';
			const pattern = new RegExp(`\\b(${DECLARATION_KEYWORDS})\\s+(${lead}${escaped}${tail})`, query.match === 'exact' ? '' : 'i');
			const found = await this.doGrep({
				root,
				folder: query.folder ?? root,
				pattern: `\\b(?:${DECLARATION_KEYWORDS})\\s+${lead}${escaped}${tail}`,
				caseSensitive: query.match === 'exact',
				maxMatches: query.limit,
			}, token);
			const symbols: IVoltCodeSymbol[] = [];
			for (const file of found.files) {
				for (const [line, hit] of file.lines) {
					const declared = hit.match ? pattern.exec(hit.text) : null;
					if (declared) {
						symbols.push({ name: declared[2], kind: keywordKind(declared[1]), path: file.path, line, text: hit.text.trim() });
					}
				}
			}
			return { symbols, limitHit: found.limitHit, engine: 'ripgrep', ms: Date.now() - started, ...(fallback ? { fallback } : {}) };
		}, undefined, query.indexOnly);
	}
}

function keywordKind(keyword: string): VoltCodeSymbolKind {
	switch (keyword) {
		case 'class': return 'class';
		case 'interface': return 'interface';
		case 'type': return 'type';
		case 'enum': return 'enum';
		case 'struct': return 'struct';
		case 'trait': case 'impl': return 'trait';
		case 'module': case 'namespace': return 'module';
		case 'const': case 'static': return 'constant';
		case 'let': case 'var': case 'val': return 'variable';
		case 'macro_rules!': return 'macro';
		default: return 'function';
	}
}

function firstLine(preview: string, max: number): string {
	const line = preview.split('\n')[0]?.replace(/\s+$/, '') ?? '';
	return line.length > max ? `${line.slice(0, max)}\u2026` : line;
}
