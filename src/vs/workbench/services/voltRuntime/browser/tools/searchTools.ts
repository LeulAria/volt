/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { VoltCodeSymbolKind } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { formatSymbols, SYMBOL_KIND_NAMES } from '../../common/codeIntelligence.js';
import { pickBoolean, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { IVoltGrepFile, IVoltSearchMeta, VoltSearch } from '../search/voltSearch.js';
import { objectSchema } from './schema.js';
import { resolveWorkspaceUri } from './workspacePath.js';

export type { ISearchIndex } from '../search/voltSearch.js';

const DEFAULT_MATCHES = 100;
const DEFAULT_FILES = 200;
const DEFAULT_SYMBOLS = 30;
const DEFAULT_FIND_FILES = 20;
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

/** The agent's search tools, answered by Volt's unified search (index, FFF, ripgrep). */
export function createSearchTools(search: VoltSearch, root: () => URI | undefined): IVoltTool[] {
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
			execute: async (args, ctx) => runGrep(search, root(), args, ctx.signal),
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
			execute: async (args, ctx) => runGlob(search, root(), args, ctx.signal),
		},
		{
			name: 'find_files',
			group: 'search',
			kind: 'search',
			parallelSafe: true,
			snippet: 'find_files - find a file by a fuzzy name or path, typos allowed',
			description: [
				'Find files by name when you know roughly what a file is called but not where it is: fuzzy and typo-tolerant ("rootIndx" finds rootIndex.ts), best match first.',
				'Each word narrows the results: "sched fair" finds kernel/sched/fair.c. Use 1-2 words.',
				'Use glob for exact patterns (all *.test.ts), grep for file contents.',
			].join(' '),
			schema: objectSchema({
				query: { type: 'string', description: 'Part of a file name or path, e.g. userService or auth middleware' },
				path: { type: 'string', description: 'Only under this folder' },
				limit: { type: 'integer', description: `Maximum paths (default ${DEFAULT_FIND_FILES})` },
			}, ['query']),
			idempotent: true,
			timeoutMs: 30_000,
			execute: async (args, ctx) => runFindFiles(search, root(), args, ctx.signal),
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
			execute: async (args, ctx) => runFindSymbol(search, root(), args, ctx.signal),
		},
	];
}

/** A line saying which engine did not answer and why, only when it matters to the reader. */
function fallbackNote(meta: IVoltSearchMeta): string {
	return meta.fallback && /error|failed|unusable/i.test(meta.fallback) ? `\n[The code index could not answer (${meta.fallback}); searched with ripgrep.]` : '';
}

async function runGrep(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal): Promise<IToolResult> {
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
	const context = Math.min(5, Math.max(0, pickNumber(args, 'context') ?? 0));
	const limit = Math.max(1, pickNumber(args, 'head_limit') ?? (mode === 'content' ? DEFAULT_MATCHES : DEFAULT_FILES));
	const includes = includePattern(pickString(args, 'glob', 'include'), pickString(args, 'type'));
	let result;
	try {
		result = await search.grep({
			root,
			folder,
			pattern,
			literal,
			caseSensitive: pickBoolean(args, 'case_sensitive'),
			multiline: pickBoolean(args, 'multiline'),
			context,
			includes,
			maxMatches: mode === 'content' ? limit : Math.max(limit * 20, 2_000),
			maxLineChars: LINE_CHARS,
		}, tokenFor(signal));
	} catch (err) {
		return fail('grep', err instanceof Error ? err.message : String(err));
	}
	const files = result.files;
	const hitLimit = result.limitHit || (mode !== 'content' && files.length > limit);
	const note = fallbackNote(result);
	if (!files.length) {
		return { callId: '', name: 'grep', kind: 'search', text: `No matches for ${literal ? 'text' : 'pattern'} ${JSON.stringify(pattern)}${includes ? ` in ${includes.join(', ')}` : ''}.${note}`, display: { card: 'search', shape: 'matches', files: [], truncated: false, total: 0 } };
	}
	const matches = files.reduce((sum, file) => sum + file.matches, 0);
	const more = hitLimit ? `\n[More results exist. Narrow the pattern, path, glob, or type, or raise head_limit.]` : '';
	if (mode === 'files') {
		const shown = files.slice(0, limit);
		return {
			callId: '', name: 'grep', kind: 'search',
			text: `${files.length} file${files.length === 1 ? '' : 's'} match:\n${shown.map(file => file.path).join('\n')}${more}${note}`,
			display: { card: 'search', shape: 'paths', paths: shown.map(file => file.path), truncated: hitLimit, total: files.length },
		};
	}
	if (mode === 'count') {
		const shown = files.slice(0, limit);
		return {
			callId: '', name: 'grep', kind: 'search',
			text: `${matches} match${matches === 1 ? '' : 'es'} in ${files.length} file${files.length === 1 ? '' : 's'}:\n${shown.map(file => `${file.path}: ${file.matches}`).join('\n')}${more}${note}`,
		};
	}
	const { text, view } = formatMatches(files, limit, context);
	return {
		callId: '', name: 'grep', kind: 'search',
		text: `${text}${more}${note}`,
		display: { card: 'search', shape: 'matches', files: view, truncated: hitLimit, total: matches },
	};
}

/** `path:` then `  12: text` lines (context lines with `-`, gaps with `--`), up to `limit` matches. */
export function formatMatches(files: readonly IVoltGrepFile[], limit: number, context: number): { text: string; view: { path: string; matches: { lineNumber: number; line: string }[] }[] } {
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
	return { text: out.join('\n'), view };
}

async function runGlob(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal): Promise<IToolResult> {
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
	let result;
	try {
		result = await search.glob({ root, folder, pattern: filePattern, limit }, tokenFor(signal));
	} catch (err) {
		return fail('glob', err instanceof Error ? err.message : String(err));
	}
	const { paths, limitHit: truncated } = result;
	const more = truncated ? '\n[More files match. Tighten the pattern or raise limit.]' : '';
	return {
		callId: '', name: 'glob', kind: 'search',
		text: paths.length ? `${paths.join('\n')}${more}${fallbackNote(result)}` : `No files match ${pattern}.${fallbackNote(result)}`,
		display: { card: 'search', shape: 'paths', paths: [...paths], truncated, total: paths.length },
	};
}

async function runFindFiles(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal): Promise<IToolResult> {
	const query = pickString(args, 'query', 'name', 'pattern')?.trim();
	if (!query) {
		return fail('find_files', 'query is required.');
	}
	if (!root) {
		return fail('find_files', 'No workspace is open.');
	}
	const folder = resolveWorkspaceUri(root, pickString(args, 'path', 'directory'));
	const limit = Math.max(1, Math.min(200, pickNumber(args, 'limit') ?? DEFAULT_FIND_FILES));
	let result;
	try {
		result = await search.findFiles({ root, ...(folder ? { folder } : {}), query, limit }, tokenFor(signal));
	} catch (err) {
		return fail('find_files', err instanceof Error ? err.message : String(err));
	}
	const more = result.limitHit ? '\n[More files match. Add a word or a folder, or raise limit.]' : '';
	return {
		callId: '', name: 'find_files', kind: 'search',
		text: result.paths.length ? `${result.paths.join('\n')}${more}` : `No files match ${JSON.stringify(query)}. Try fewer or shorter words, or grep for the file's contents.`,
		display: { card: 'search', shape: 'paths', paths: [...result.paths], truncated: result.limitHit, total: result.paths.length },
	};
}

async function runFindSymbol(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal): Promise<IToolResult> {
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
	let result;
	try {
		result = await search.symbols({
			root,
			...(folder ? { folder } : {}),
			name,
			match,
			...(kind && SYMBOL_KIND_NAMES.includes(kind) ? { kind } : {}),
			limit,
		}, tokenFor(signal));
	} catch (err) {
		return fail('find_symbol', err instanceof Error ? err.message : String(err));
	}
	const text = formatSymbols(result.symbols, result.limitHit, name);
	return { callId: '', name: 'find_symbol', kind: 'search', text, display: { card: 'search', shape: 'paths', paths: result.symbols.map(symbol => `${symbol.path}:${symbol.line}`), truncated: result.limitHit, total: result.symbols.length } };
}

function includePattern(glob: string | undefined, type: string | undefined): string[] | undefined {
	const patterns: string[] = [];
	if (glob) {
		patterns.push(glob.includes('/') || glob.startsWith('**') ? glob : `**/${glob}`);
	}
	const typed = type ? FILE_TYPES[type.toLowerCase().replace(/^\./, '')] ?? `**/*.${type.replace(/^\./, '')}` : undefined;
	if (typed) {
		patterns.push(typed);
	}
	return patterns.length ? patterns : undefined;
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
