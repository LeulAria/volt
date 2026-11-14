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
import { ISearchConfinement, IVoltGrepFile, IVoltSearchMeta, VoltSearch } from '../search/voltSearch.js';
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

/**
 * The agent's search tools, answered by Volt's unified search (index, FFF, ripgrep); `confine` for a
 * sandboxed chat's, or a function asked at each call (a native model's chat, whose sandbox the
 * runtime knows only then: SEC3-1).
 */
export function createSearchTools(search: VoltSearch, root: () => URI | undefined, confinement?: ISearchConfinement | (() => ISearchConfinement | undefined)): IVoltTool[] {
	const confine = () => typeof confinement === 'function' ? confinement() : confinement;
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
				glob: { type: 'string', description: 'File filter, e.g. src/**/*.ts; a leading ! leaves files out (!**/*.spec.ts). Applies together with type.' },
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
			execute: async (args, ctx) => runGrep(search, root(), args, ctx.signal, confine()),
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
			execute: async (args, ctx) => runGlob(search, root(), args, ctx.signal, confine()),
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
			execute: async (args, ctx) => runFindFiles(search, root(), args, ctx.signal, confine()),
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
			execute: async (args, ctx) => runFindSymbol(search, root(), args, ctx.signal, confine()),
		},
	];
}

/**
 * Space-separated relative paths, as globs over workspace-relative paths (a file stays a file, a
 * folder covers what is under it); undefined for a single path or one with spaces in a name.
 */
export function severalPaths(path: string | undefined): string[] | undefined {
	const parts = path?.trim().split(/\s+/).map(part => part.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
	if (!parts || parts.length < 2 || parts.some(part => part.startsWith('/') || part.startsWith('-') || part.includes('..'))) {
		return undefined;
	}
	return parts.map(part => /\.[\w]+$/.test(part) || /[*?{]/.test(part) ? part : `${part}/**`);
}

/** A line saying which engine did not answer and why, only when it matters to the reader. */
function fallbackNote(meta: IVoltSearchMeta): string {
	return meta.fallback && /error|failed|unusable/i.test(meta.fallback) ? `\n[The code index could not answer (${meta.fallback}); searched with ripgrep.]` : '';
}

async function runGrep(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal, confine?: ISearchConfinement): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'query', 'regex');
	if (!pattern) {
		return fail('grep', 'pattern is required.');
	}
	// Several paths in one string, as rg takes them ("apps/web/src packages/api/src/index.ts"): the
	// index answered "not indexed" for the whole string. Each becomes a glob instead.
	const several = severalPaths(pickString(args, 'path', 'directory'));
	if (several && (pickString(args, 'glob', 'include') || pickString(args, 'type'))) {
		return fail('grep', 'path takes one folder or file. For several, leave out path and pass them as glob: "{apps/web/src/**,packages/api/src/index.ts}".');
	}
	const folder = several ? root : resolveWorkspaceUri(root, pickString(args, 'path', 'directory')) ?? root;
	if (!folder) {
		return fail('grep', 'No workspace is open.');
	}
	const mode = pickString(args, 'output_mode') ?? 'content';
	const literal = pickBoolean(args, 'literal');
	const context = Math.min(5, Math.max(0, pickNumber(args, 'context') ?? 0));
	const limit = Math.max(1, pickNumber(args, 'head_limit') ?? (mode === 'content' ? DEFAULT_MATCHES : DEFAULT_FILES));
	const filter = fileFilter(pickString(args, 'glob', 'include'), pickString(args, 'type'));
	const includes = several ?? filter.includes;
	const excludes = filter.excludes;
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
			...(excludes ? { excludes } : {}),
			maxMatches: mode === 'content' ? limit : Math.max(limit * 20, 2_000),
			maxLineChars: LINE_CHARS,
			...(confine ? { confine } : {}),
		}, tokenFor(signal));
	} catch (err) {
		return fail('grep', err instanceof Error ? err.message : String(err));
	}
	const files = result.files;
	const hitLimit = result.limitHit || (mode !== 'content' && files.length > limit);
	const note = fallbackNote(result);
	if (!files.length) {
		return { callId: '', name: 'grep', kind: 'search', text: `No matches for ${literal ? 'text' : 'pattern'} ${JSON.stringify(pattern)}${includes ? ` in ${includes.join(', ')}` : ''}${excludes ? ` (not ${excludes.join(', ')})` : ''}.${note}`, display: { card: 'search', shape: 'matches', files: [], truncated: false, total: 0 } };
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
	const owners = await enclosingDeclarations(search, root, files.slice(0, MAX_LABELLED_FILES), signal, confine);
	const { text, view } = formatMatches(files, limit, context, owners);
	return {
		callId: '', name: 'grep', kind: 'search',
		text: `${text}${more}${note}`,
		display: { card: 'search', shape: 'matches', files: view, truncated: hitLimit, total: matches },
	};
}

/** Matches in at most this many files get the declaration they sit in. */
const MAX_LABELLED_FILES = 25;
/** The labels are a bonus: past this the matches go out without them. */
const LABEL_BUDGET_MS = 1_500;

/** Declarations that enclose code a reader cares about; a local `const` is not one (exported ones are). */
const OWNER_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'interface', 'type', 'enum', 'module', 'struct', 'trait']);

/**
 * For each file, its declarations by line, so a match can say which function, method or exported
 * table it sits in. "Who calls X" and "which tables reference Y" then take one grep instead of a
 * grep plus a read of every file it found. From the code index (no language server); undefined
 * when the index cannot say in time.
 */
async function enclosingDeclarations(search: VoltSearch, root: URI | undefined, files: readonly IVoltGrepFile[], signal: AbortSignal, confine?: ISearchConfinement): Promise<Map<string, readonly IOwner[]> | undefined> {
	if (!root || !files.length) {
		return undefined;
	}
	const token = tokenFor(signal);
	const outlines = Promise.all(files.map(async file => {
		const result = await search.symbols({ root, folder: resolveWorkspaceUri(root, file.path) ?? root, name: '*', match: 'exact', limit: 2_000, indexOnly: true, ...(confine ? { confine } : {}) }, token).catch(() => undefined);
		const owners: IOwner[] = [];
		let className: string | undefined;
		for (const symbol of [...result?.symbols ?? []].filter(symbol => symbol.path === file.path).sort((a, b) => a.line - b.line)) {
			if (symbol.kind === 'class') {
				className = symbol.name;
			}
			if (OWNER_KINDS.has(symbol.kind) || ((symbol.kind === 'constant' || symbol.kind === 'variable') && /^export\b/.test(symbol.text))) {
				owners.push({ line: symbol.line, name: symbol.kind === 'method' && className ? `${className}.${symbol.name}` : symbol.name });
			}
		}
		return [file.path, owners] as const;
	}));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), LABEL_BUDGET_MS));
	const found = await Promise.race([outlines, timeout]).finally(() => clearTimeout(timer));
	return found ? new Map(found.filter(([, owners]) => owners.length)) : undefined;
}

interface IOwner {
	readonly line: number;
	readonly name: string;
}

function ownerAt(owners: readonly IOwner[] | undefined, line: number): string | undefined {
	let found: string | undefined;
	for (const owner of owners ?? []) {
		if (owner.line > line) {
			break;
		}
		found = owner.name;
	}
	return found;
}

/**
 * `path:` then `  12: text` lines (context lines with `-`, gaps with `--`), up to `limit` matches.
 * With `owners`, the first match inside each declaration ends with `  (in Name)`.
 */
export function formatMatches(files: readonly IVoltGrepFile[], limit: number, context: number, owners?: ReadonlyMap<string, readonly IOwner[]>): { text: string; view: { path: string; matches: { lineNumber: number; line: string }[] }[] } {
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
		let lastOwner: string | undefined;
		const fileOwners = owners?.get(file.path);
		for (const [line, hit] of [...file.lines.entries()].sort((a, b) => a[0] - b[0])) {
			if (hit.match && shownMatches >= limit) {
				break;
			}
			if (context && previous >= 0 && line > previous + 1) {
				out.push('  --');
			}
			const owner = hit.match ? ownerAt(fileOwners, line) : undefined;
			const label = owner && owner !== lastOwner ? `  (in ${owner})` : '';
			if (owner) {
				lastOwner = owner;
			}
			out.push(`  ${line}${hit.match ? ':' : '-'} ${hit.text}${label}`);
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

async function runGlob(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal, confine?: ISearchConfinement): Promise<IToolResult> {
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
		result = await search.glob({ root, folder, pattern: filePattern, limit, ...(confine ? { confine } : {}) }, tokenFor(signal));
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

async function runFindFiles(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal, confine?: ISearchConfinement): Promise<IToolResult> {
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
		result = await search.findFiles({ root, ...(folder ? { folder } : {}), query, limit, ...(confine ? { confine } : {}) }, tokenFor(signal));
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

async function runFindSymbol(search: VoltSearch, root: URI | undefined, args: unknown, signal: AbortSignal, confine?: ISearchConfinement): Promise<IToolResult> {
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
			...(confine ? { confine } : {}),
		}, tokenFor(signal));
	} catch (err) {
		return fail('find_symbol', err instanceof Error ? err.message : String(err));
	}
	const text = formatSymbols(result.symbols, result.limitHit, name);
	return { callId: '', name: 'find_symbol', kind: 'search', text, display: { card: 'search', shape: 'paths', paths: result.symbols.map(symbol => `${symbol.path}:${symbol.line}`), truncated: result.limitHit, total: result.symbols.length } };
}

/**
 * The files a grep looks at, with ripgrep's meaning: `glob` and `type` both apply (a file must
 * match each), and a glob starting with `!` leaves files out. Before, the two were alternatives,
 * so `glob: "src/a.ts", type: "ts"` searched every .ts file, and `glob: "!**\/*.spec.ts"` searched
 * only spec files. Benchmarks: an agent re-ran one 8 KB answer eight times trying to narrow it.
 */
export function fileFilter(glob: string | undefined, type: string | undefined): { includes?: string[]; excludes?: string[] } {
	const typed = type ? FILE_TYPES[type.toLowerCase().replace(/^\./, '')] ?? `**/*.${type.replace(/^\./, '')}` : undefined;
	const trimmed = glob?.trim();
	const rooted = (pattern: string) => pattern.includes('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`;
	if (!trimmed) {
		return typed ? { includes: [typed] } : {};
	}
	if (trimmed.startsWith('!')) {
		return { ...(typed ? { includes: [typed] } : {}), excludes: [rooted(trimmed.slice(1))] };
	}
	const pattern = rooted(trimmed);
	const last = pattern.slice(pattern.lastIndexOf('/') + 1);
	// A glob that names files (`*.spec.ts`, `src/app.ts`) is already narrower than the type; one
	// that names folders (`src/**`, `apps/api`) gets the type's files below it.
	if (!typed || last.includes('.')) {
		return { includes: [pattern] };
	}
	const folder = pattern.replace(/\/?\*\*$/, '').replace(/\/$/, '');
	return { includes: [`${folder}/${typed}`] };
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
