/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IVoltCodeIndexOptions, IVoltCodeIndexService, VoltCodeSymbolKind } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { ISearchService, ITextSearchContext, QueryType, resultIsMatch } from '../../../search/common/search.js';
import { formatSymbols, SYMBOL_KIND_NAMES } from '../../common/codeIntelligence.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

const DEFAULT_MATCHES = 100;
const DEFAULT_FILES = 200;
const DEFAULT_SYMBOLS = 30;
const LINE_CHARS = 500;

/** `type: "ts"` without the model having to remember brace globs. */
const FILE_TYPES: Record<string, string> = {
	ts: '**/*.{ts,tsx,mts,cts}',
	js: '**/*.{js,jsx,mjs,cjs}',
	py: '**/*.{py,pyi}',
	go: '**/*.go',
	rust: '**/*.rs',
	rs: '**/*.rs',
	java: '**/*.java',
	kotlin: '**/*.{kt,kts}',
	ruby: '**/*.rb',
	php: '**/*.php',
	cs: '**/*.cs',
	cpp: '**/*.{c,cc,cpp,cxx,h,hh,hpp}',
	c: '**/*.{c,h}',
	swift: '**/*.swift',
	css: '**/*.{css,scss,sass,less}',
	html: '**/*.{html,htm}',
	json: '**/*.json',
	md: '**/*.{md,mdx}',
	yaml: '**/*.{yml,yaml}',
	sh: '**/*.{sh,bash,zsh}',
	sql: '**/*.sql',
	vue: '**/*.vue',
	svelte: '**/*.svelte',
};

const DEFAULT_EXCLUDES = { '**/node_modules': true, '**/.git': true } as const;

/**
 * Volt's code index, when Settings > Code Intelligence allows it. Searches try it first and
 * fall back to ripgrep whenever it cannot answer exactly (still building, a folder it does not
 * cover, a pattern that rules nothing out).
 */
export interface ISearchIndex {
	readonly service: IVoltCodeIndexService;
	readonly enabled: () => boolean;
	readonly options: () => IVoltCodeIndexOptions;
}

export function createSearchTools(search: ISearchService, root: () => URI | undefined, index?: ISearchIndex): IVoltTool[] {
	return [
		{
			name: 'grep',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'grep - search file contents (regex or literal)',
			description: [
				'Search file contents across the workspace (ripgrep semantics; honors .gitignore). Results are grouped by file with line numbers.',
				'Answered from Volt\'s code index when it is on, so it stays instant in large repos.',
				'Use to find a symbol, string, or pattern, or to see where something is used. Run several searches in parallel when exploring.',
				'output_mode "files" lists matching files, "count" counts them; context adds lines around each match.',
				'Do not use to read a file you already know (use read_file).',
			].join(' '),
			schema: objectSchema({
				pattern: { type: 'string', description: 'Regular expression (or literal text when literal is true)' },
				path: { type: 'string', description: 'Folder to search in (default: workspace root)' },
				glob: { type: 'string', description: 'File filter, e.g. src/**/*.ts' },
				type: { type: 'string', description: 'File type shortcut: ts, js, py, go, rust, java, css, html, json, md, ...' },
				literal: { type: 'boolean', description: 'Treat pattern as plain text' },
				case_sensitive: { type: 'boolean' },
				output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'Default content' },
				context: { type: 'integer', description: 'Lines of context around each match (0-5)' },
				head_limit: { type: 'integer', description: 'Maximum matches (content) or files (files/count)' },
				multiline: { type: 'boolean', description: 'Let the pattern span lines' },
			}, ['pattern']),
			idempotent: true,
			timeoutMs: 60_000,
			execute: async (args, ctx) => runGrep(search, root(), args, ctx.signal, index),
		},
		{
			name: 'glob',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'glob - find files by name pattern',
			description: [
				'Find files by glob pattern (honors .gitignore), e.g. **/*.test.ts or src/**/config*.',
				'Use when you need paths and do not yet know them.',
				'Do not use to list a single known directory (use list_dir).',
			].join(' '),
			schema: objectSchema({
				pattern: { type: 'string', description: 'Glob such as **/*.ts or src/**/*.json' },
				path: { type: 'string', description: 'Folder to search in' },
				limit: { type: 'integer', description: 'Maximum paths (default 200)' },
			}, ['pattern']),
			idempotent: true,
			timeoutMs: 60_000,
			execute: async (args, ctx) => runGlob(search, root(), args, ctx.signal, index),
		},
		{
			name: 'find_symbol',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'find_symbol - where a function, class or type is declared, by name',
			description: [
				'Where functions, classes, interfaces, types, methods and constants are declared, by name, across the whole workspace, without a language server.',
				'match "exact" (default), "prefix", or "fuzzy" (camel-case and substring: "usrSvc" finds UserService).',
				'Use it first when you know or can guess a name; use code_nav references for its uses.',
			].join(' '),
			schema: objectSchema({
				name: { type: 'string', description: 'Symbol name, e.g. createServer or UserService' },
				match: { type: 'string', enum: ['exact', 'prefix', 'fuzzy'] },
				kind: { type: 'string', enum: [...SYMBOL_KIND_NAMES], description: 'Only this kind' },
				path: { type: 'string', description: 'Only under this folder' },
				limit: { type: 'integer', description: `Maximum results (default ${DEFAULT_SYMBOLS})` },
			}, ['name']),
			idempotent: true,
			timeoutMs: 30_000,
			execute: async (args, ctx) => runFindSymbol(search, root(), args, ctx.signal, index),
		},
	];
}

interface IFileHits {
	readonly path: string;
	readonly lines: Map<number, { text: string; match: boolean }>;
	matches: number;
}

/** Whether `index` can serve searches under `folder` of the workspace at `root`. */
function indexFor(index: ISearchIndex | undefined, root: URI | undefined, folder: URI): ISearchIndex | undefined {
	return index && root?.scheme === Schemas.file && folder.scheme === Schemas.file && index.enabled() ? index : undefined;
}

async function runGrep(search: ISearchService, root: URI | undefined, args: unknown, signal: AbortSignal, index: ISearchIndex | undefined): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'query', 'regex');
	if (!pattern) {
		return fail('grep', 'pattern is required.');
	}
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory')) ?? root;
	if (!folder) {
		return fail('grep', 'No workspace is open.');
	}
	const mode = pickString(args, 'output_mode') ?? 'content';
	const literal = pickBoolean(args, 'literal');
	const caseSensitive = pickBoolean(args, 'case_sensitive');
	const multiline = pickBoolean(args, 'multiline');
	const context = Math.min(5, Math.max(0, pickNumber(args, 'context') ?? 0));
	const limit = Math.max(1, pickNumber(args, 'head_limit') ?? (mode === 'content' ? DEFAULT_MATCHES : DEFAULT_FILES));
	const includes = includePattern(pickString(args, 'glob', 'include'), pickString(args, 'type'));
	const maxMatches = mode === 'content' ? limit : Math.max(limit * 20, 2_000);
	let files: IFileHits[] | undefined;
	let hitLimit = false;

	const indexed = indexFor(index, root, folder);
	if (indexed && root) {
		const result = await indexed.service.search({
			root: root.fsPath,
			folder: folder.fsPath,
			pattern,
			isRegExp: !literal,
			caseSensitive,
			multiline,
			includes: includes ? Object.keys(includes) : undefined,
			context,
			maxMatches,
			maxLineChars: LINE_CHARS,
			options: indexed.options(),
		}).catch(() => undefined);
		if (result?.kind === 'results') {
			files = result.files.map(file => ({
				path: displayPath(root, joinPath(root, file.path)),
				lines: new Map(file.lines.map(line => [line.line, { text: line.text.replace(/\s+$/, ''), match: line.match }])),
				matches: file.matches,
			}));
			hitLimit = result.limitHit || (mode === 'content' ? false : files.length > limit);
		}
	}

	if (!files) {
		const token = tokenFor(signal);
		try {
			const complete = await search.textSearch({
				type: QueryType.Text,
				contentPattern: {
					pattern,
					isRegExp: !literal,
					isCaseSensitive: caseSensitive,
					isMultiline: multiline,
				},
				folderQueries: [{ folder }],
				maxResults: mode === 'content' ? limit + 1 : maxMatches,
				previewOptions: { matchLines: 1, charsPerLine: LINE_CHARS },
				...(context ? { surroundingContext: context } : {}),
				...(includes ? { includePattern: includes } : {}),
				...(folder.path.includes('/node_modules') ? {} : { excludePattern: { ...DEFAULT_EXCLUDES } }),
			}, token);
			files = [];
			let matches = 0;
			for (const file of complete.results) {
				const hits: IFileHits = { path: displayPath(root, file.resource), lines: new Map(), matches: 0 };
				for (const result of file.results ?? []) {
					if (resultIsMatch(result)) {
						const line = (result.rangeLocations[0]?.source.startLineNumber ?? 0) + 1;
						hits.lines.set(line, { text: firstLine(result.previewText), match: true });
						hits.matches++;
					} else {
						const ctx = result as ITextSearchContext;
						if (!hits.lines.has(ctx.lineNumber)) {
							hits.lines.set(ctx.lineNumber, { text: firstLine(ctx.text), match: false });
						}
					}
				}
				if (hits.matches) {
					files.push(hits);
					matches += hits.matches;
				}
			}
			hitLimit = complete.limitHit || (mode === 'content' ? matches > limit : files.length > limit);
		} catch (err) {
			return fail('grep', err instanceof Error ? err.message : String(err));
		}
	}

	if (!files.length) {
		return { callId: '', name: 'grep', kind: 'search', text: `No matches for ${literal ? 'text' : 'pattern'} ${JSON.stringify(pattern)}${includes ? ` in ${Object.keys(includes).join(', ')}` : ''}.`, display: { card: 'search', shape: 'matches', files: [], truncated: false, total: 0 } };
	}
	const matches = files.reduce((sum, file) => sum + file.matches, 0);
	const more = hitLimit ? `\n[More results exist. Narrow the pattern, path, glob, or type, or raise head_limit.]` : '';
	if (mode === 'files') {
		const shown = files.slice(0, limit);
		return {
			callId: '', name: 'grep', kind: 'search',
			text: `${files.length} file${files.length === 1 ? '' : 's'} match:\n${shown.map(file => file.path).join('\n')}${more}`,
			display: { card: 'search', shape: 'paths', paths: shown.map(file => file.path), truncated: hitLimit, total: files.length },
		};
	}
	if (mode === 'count') {
		const shown = files.slice(0, limit);
		return {
			callId: '', name: 'grep', kind: 'search',
			text: `${matches} match${matches === 1 ? '' : 'es'} in ${files.length} file${files.length === 1 ? '' : 's'}:\n${shown.map(file => `${file.path}: ${file.matches}`).join('\n')}${more}`,
		};
	}
	const out: string[] = [];
	const view: { path: string; matches: { lineNumber: number; line: string }[] }[] = [];
	let shownMatches = 0;
	for (const file of files) {
		if (shownMatches >= limit) {
			break;
		}
		out.push(`${file.path}:`);
		const entry = { path: file.path, matches: [] as { lineNumber: number; line: string }[] };
		let previous = -1;
		for (const [line, hit] of [...file.lines.entries()].sort((a, b) => a[0] - b[0])) {
			if (hit.match && shownMatches >= limit) {
				break;
			}
			if (context && previous >= 0 && line > previous + 1) {
				out.push('  --');
			}
			out.push(`  ${line}${hit.match ? ':' : '-'} ${hit.text}`);
			if (hit.match) {
				shownMatches++;
				entry.matches.push({ lineNumber: line, line: hit.text });
			}
			previous = line;
		}
		view.push(entry);
	}
	return {
		callId: '', name: 'grep', kind: 'search',
		text: `${out.join('\n')}${more}`,
		display: { card: 'search', shape: 'matches', files: view, truncated: hitLimit, total: matches },
	};
}

async function runGlob(search: ISearchService, root: URI | undefined, args: unknown, signal: AbortSignal, index: ISearchIndex | undefined): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'glob', 'file_pattern');
	if (!pattern) {
		return fail('glob', 'pattern is required.');
	}
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory')) ?? root;
	if (!folder) {
		return fail('glob', 'No workspace is open.');
	}
	const limit = Math.max(1, pickNumber(args, 'limit') ?? DEFAULT_FILES);
	const filePattern = pattern.includes('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`;
	let paths: string[] | undefined;
	let truncated = false;
	const indexed = indexFor(index, root, folder);
	if (indexed && root) {
		const result = await indexed.service.files({ root: root.fsPath, folder: folder.fsPath, pattern: filePattern, limit, options: indexed.options() }).catch(() => undefined);
		if (result?.kind === 'results') {
			// Index paths are relative to the root; show them relative to the root as ripgrep's are.
			paths = result.paths.map(path => displayPath(root, joinPath(root, path)));
			truncated = result.limitHit;
		}
	}
	if (!paths) {
		try {
			const complete = await search.fileSearch({
				type: QueryType.File,
				filePattern,
				shouldGlobMatchFilePattern: true,
				folderQueries: [{ folder }],
				maxResults: limit + 1,
				...(folder.path.includes('/node_modules') ? {} : { excludePattern: { ...DEFAULT_EXCLUDES } }),
			}, tokenFor(signal));
			const all = complete.results.map(file => displayPath(root, file.resource)).sort();
			paths = all.slice(0, limit);
			truncated = complete.limitHit || all.length > limit;
		} catch (err) {
			return fail('glob', err instanceof Error ? err.message : String(err));
		}
	}
	const more = truncated ? '\n[More files match. Tighten the pattern or raise limit.]' : '';
	return {
		callId: '', name: 'glob', kind: 'search',
		text: paths.length ? `${paths.join('\n')}${more}` : `No files match ${pattern}.`,
		display: { card: 'search', shape: 'paths', paths, truncated, total: paths.length },
	};
}

/** Declarations without the index: one ripgrep pass for the usual declaring keywords. */
const DECLARATION_KEYWORDS = 'function|class|interface|type|enum|def|fn|func|fun|struct|trait|impl|module|namespace|const|let|var|val|static|macro_rules!';

async function runFindSymbol(search: ISearchService, root: URI | undefined, args: unknown, signal: AbortSignal, index: ISearchIndex | undefined): Promise<IToolResult> {
	const name = pickString(args, 'name', 'symbol', 'query')?.trim();
	if (!name) {
		return fail('find_symbol', 'name is required.');
	}
	if (!root) {
		return fail('find_symbol', 'No workspace is open.');
	}
	const match = (pickString(args, 'match') ?? 'exact') as 'exact' | 'prefix' | 'fuzzy';
	const kind = pickString(args, 'kind') as VoltCodeSymbolKind | undefined;
	const limit = Math.max(1, Math.min(200, pickNumber(args, 'limit') ?? DEFAULT_SYMBOLS));
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory'));
	const indexed = indexFor(index, root, folder ?? root);
	if (indexed) {
		const result = await indexed.service.symbols({
			root: root.fsPath,
			query: name,
			match,
			...(kind && SYMBOL_KIND_NAMES.includes(kind) ? { kinds: [kind] } : {}),
			...(folder ? { path: displayPath(root, folder) } : {}),
			limit,
			options: indexed.options(),
		}).catch(() => undefined);
		if (result?.kind === 'results') {
			const text = formatSymbols(result.symbols, result.limitHit, name);
			return { callId: '', name: 'find_symbol', kind: 'search', text, display: { card: 'search', shape: 'paths', paths: result.symbols.map(symbol => `${symbol.path}:${symbol.line}`), truncated: result.limitHit, total: result.symbols.length } };
		}
	}
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const tail = match === 'exact' ? '\\b' : '\\w*';
	const lead = match === 'fuzzy' ? '\\w*' : '';
	return runGrep(search, root, {
		pattern: `\\b(?:${DECLARATION_KEYWORDS})\\s+${lead}${escaped}${tail}`,
		path: folder ? displayPath(root, folder) : undefined,
		head_limit: limit,
		case_sensitive: match === 'exact',
	}, signal, undefined).then(result => ({ ...result, name: 'find_symbol' }));
}

function includePattern(glob: string | undefined, type: string | undefined): Record<string, boolean> | undefined {
	const patterns: Record<string, boolean> = {};
	if (glob) {
		patterns[glob.includes('/') || glob.startsWith('**') ? glob : `**/${glob}`] = true;
	}
	const typed = type ? FILE_TYPES[type.toLowerCase().replace(/^\./, '')] ?? `**/*.${type.replace(/^\./, '')}` : undefined;
	if (typed) {
		patterns[typed] = true;
	}
	return Object.keys(patterns).length ? patterns : undefined;
}

function firstLine(preview: string): string {
	const line = preview.split('\n')[0]?.replace(/\s+$/, '') ?? '';
	return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
}

function tokenFor(signal: AbortSignal): CancellationToken {
	const source = new CancellationTokenSource();
	if (signal.aborted) {
		source.cancel();
	} else {
		signal.addEventListener('abort', () => source.cancel(), { once: true });
	}
	return source.token;
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: 'search', text, isError: true };
}
