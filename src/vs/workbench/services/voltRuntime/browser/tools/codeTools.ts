/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IVoltCodeImport, IVoltCodeImporter, IVoltCodeOutlineSymbol, IVoltCodeStructuralMatch } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { asRecord, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

/**
 * The editor's own language intelligence as tools. Diagnostics are the same errors the user sees
 * in the Problems view; navigation, hierarchies and refactors go through the language servers the
 * editor already runs, on the buffers the user has open (unsaved text included). When a language
 * server has nothing to say, navigation falls back to Volt's code index (by name), so the agent
 * always gets an answer and is told which kind it got.
 */

export interface IDiagnostic {
	readonly uri: URI;
	readonly line: number;
	readonly column: number;
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly source?: string;
	readonly code?: string;
}

export interface ICodeLocation {
	readonly uri: URI;
	readonly line: number;
	readonly column: number;
	/** The line's text, trimmed. */
	readonly preview?: string;
}

export interface ICodeSymbol {
	readonly name: string;
	readonly kind: string;
	readonly line: number;
	readonly endLine: number;
	readonly depth: number;
	readonly detail?: string;
}

/** A named symbol somewhere in the workspace: a workspace symbol, a caller, a supertype. */
export interface ICodeSymbolRef {
	readonly name: string;
	readonly kind: string;
	readonly uri: URI;
	readonly line: number;
	readonly column: number;
	readonly detail?: string;
	readonly container?: string;
}

/** One edge of a call hierarchy: who calls the symbol (incoming) or what it calls (outgoing). */
export interface ICallEdge extends ICodeSymbolRef {
	/** Lines (1-based) of the call sites, in the caller for incoming edges, in the symbol for outgoing. */
	readonly sites: readonly number[];
}

/** A file a language server edit changes: its text before (what the edit was computed on) and after. */
export interface ITextFileChange {
	readonly uri: URI;
	readonly before: string;
	readonly after: string;
}

/** A code action the language server offers at a place (a quick fix, a refactor, a source action). */
export interface ICodeFix {
	readonly title: string;
	readonly kind?: string;
	readonly preferred?: boolean;
	/** The diagnostic it fixes, one line. */
	readonly fixes?: string;
	readonly disabled?: string;
}

export interface ICodeRange {
	readonly startLine: number;
	readonly endLine: number;
}

export interface ICodeIntelHost {
	/** Opens the files so language services analyze them, waits briefly for fresh results, then reads markers. */
	diagnostics(uris: readonly URI[] | undefined, severity: 'error' | 'warning' | 'all'): Promise<IDiagnostic[]>;
	definitions(uri: URI, line: number, column: number): Promise<ICodeLocation[]>;
	references(uri: URI, line: number, column: number): Promise<ICodeLocation[]>;
	symbols(uri: URI): Promise<ICodeSymbol[]>;
	/** The column of `symbol` on `line` (1-based), when the caller named the symbol instead of a column. */
	columnOf(uri: URI, line: number, symbol: string): Promise<number | undefined>;
	/** Whether language servers may be asked about this file (Settings > Code Intelligence). */
	lspAllowed(uri: URI): boolean;
	/** The identifier at a position, read from disk (no language server involved). */
	wordAt(uri: URI, line: number, column: number): Promise<string | undefined>;
	// The rest is optional: a host that cannot answer (the agent server without a window) leaves it out.
	/** The file's text as the editor has it (unsaved changes included). */
	fileText?(uri: URI): Promise<string | undefined>;
	implementations?(uri: URI, line: number, column: number): Promise<ICodeLocation[]>;
	typeDefinitions?(uri: URI, line: number, column: number): Promise<ICodeLocation[]>;
	/** Type, signature and docs at a position, as plain text. */
	hover?(uri: URI, line: number, column: number): Promise<string | undefined>;
	/** Symbols across the workspace whose name matches `query`. */
	workspaceSymbols?(query: string, limit: number): Promise<ICodeSymbolRef[]>;
	/** Undefined: no call hierarchy provider for this language. */
	calls?(uri: URI, line: number, column: number, direction: 'incoming' | 'outgoing'): Promise<ICallEdge[] | undefined>;
	/** Undefined: no type hierarchy provider for this language. */
	typeHierarchy?(uri: URI, line: number, column: number, direction: 'supertypes' | 'subtypes'): Promise<ICodeSymbolRef[] | undefined>;
	/** The files a rename changes, or why the language server refused it. */
	rename?(uri: URI, line: number, column: number, newName: string): Promise<readonly ITextFileChange[] | string>;
	/** The file formatted by its formatter; empty when it is already formatted. */
	format?(uri: URI): Promise<readonly ITextFileChange[] | string>;
	/** Code actions for a range; `only` narrows by kind (`quickfix`, `refactor`, `source.organizeImports`). */
	codeActions?(uri: URI, range: ICodeRange, only: string | undefined): Promise<ICodeFix[]>;
	/** Applies the action whose title contains `title` (or the preferred / only one) and returns the changes. */
	applyCodeAction?(uri: URI, range: ICodeRange, only: string | undefined, title: string | undefined): Promise<readonly ITextFileChange[] | string>;
}

/**
 * Name-based navigation from Volt's code index: what code_nav answers when language servers are
 * off for a checkout, or have nothing to say about a file. Undefined means the index cannot answer.
 */
export interface ICodeNavIndex {
	definitions(root: URI, name: string): Promise<ICodeLocation[] | undefined>;
	references(root: URI, name: string): Promise<ICodeLocation[] | undefined>;
	outline(root: URI, uri: URI): Promise<ICodeSymbol[] | undefined>;
	/** Classes and interfaces that name `name` after implements or extends. */
	implementations?(root: URI, name: string): Promise<ICodeLocation[] | undefined>;
	/** The file's declarations with exact ranges and its imports, from its syntax tree (tree-sitter). */
	structure?(root: URI, uri: URI): Promise<{ readonly symbols: readonly IVoltCodeOutlineSymbol[]; readonly imports: readonly IVoltCodeImport[] } | undefined>;
	/** Files importing `uri` (depth 2: and files importing those). */
	importers?(root: URI, uri: URI, depth: number): Promise<(IVoltCodeImporter & { readonly uri: URI })[] | undefined>;
	/** Code shaped like a pattern; a string says why it could not search. */
	structural?(root: URI, request: { readonly pattern: string; readonly folder?: URI; readonly language?: string; readonly includes?: readonly string[]; readonly excludes?: readonly string[]; readonly where?: Readonly<Record<string, string>>; readonly maxMatches: number }): Promise<{ readonly matches: readonly IVoltCodeStructuralMatch[]; readonly limitHit: boolean; readonly scanned: number } | string>;
}

/** Writes a computed edit into the workspace like edit_file does (buffers, ledger, change set). */
export type CodeEditWriter = (change: ITextFileChange, ctx: IToolContext) => Promise<{ readonly added: number; readonly removed: number; readonly text: string }>;

const MAX_DIAGNOSTICS = 100;
const MAX_LOCATIONS = 60;
const MAX_SYMBOLS = 80;
/** inspect shows a definition's body up to this many lines. */
const MAX_BODY_LINES = 40;
/** callers/callees with depth: levels, functions shown and time spent at most. */
const MAX_CALL_DEPTH = 4;
const MAX_CALL_TREE_NODES = 60;
const CALL_TREE_DEADLINE_MS = 20_000;

export const CODE_NAV_OPS = ['impact', 'body', 'definition', 'references', 'implementations', 'type_definition', 'hover', 'inspect', 'symbols', 'workspace_symbols', 'callers', 'callees', 'supertypes', 'subtypes', 'structural'] as const;
export type CodeNavOp = typeof CODE_NAV_OPS[number];

export const CODE_ACTION_OPS = ['rename', 'format', 'organize_imports', 'fixes', 'fix'] as const;

/** Positional ops: they need a line plus a column or the symbol's name. */
const POSITIONAL: ReadonlySet<string> = new Set(['definition', 'references', 'implementations', 'type_definition', 'hover', 'inspect', 'callers', 'callees', 'supertypes', 'subtypes']);

export const CODE_NAV_DESCRIPTION = [
	'Type-checked answers from the language servers the editor runs (live buffers), with Volt\'s code index as fallback.',
	'Use it for meaning, where grep returns look-alikes: who calls X (through other functions too), what implements interface Y, every use of method M of type T (not other methods with the same name), what type Z is.',
	'Name the symbol with symbol, plus path and line where it is written; symbol alone finds its declaration (path narrows it; path#symbol works too).',
	'Ops: impact (what changing symbol, or path alone, reaches: callers 3 levels up, every file using or importing it, the tests to run, current errors; one call before a refactor instead of several searches),',
	'body (just symbol\'s source with line numbers instead of reading the whole file; several symbols comma-separated),',
	'references, implementations, definition, type_definition, hover (type, signature, docs),',
	'inspect (hover + definition with body + references + implementations in one call),',
	'callers / callees (call hierarchy; depth 2-4 follows callers of callers to the entry points and names the route handlers or procedures the calls are in), supertypes / subtypes,',
	'symbols (outline of path), workspace_symbols (query: find declarations by name),',
	'structural (pattern: code with $X for one node and $$$ for any, e.g. fetchUser($ID, $$$): finds code by its shape across lines, not its text; where filters by a $X\'s code; path and glob narrow).',
	'Use grep for text, strings, SQL and config.',
].join(' ');

export const CODE_NAV_SCHEMA = objectSchema({
	op: { type: 'string', enum: [...CODE_NAV_OPS] },
	symbol: { type: 'string', description: 'The symbol\'s name. With line: the name on that line. Alone: found by its declaration (path narrows it)' },
	path: { type: 'string' },
	line: { type: 'integer', description: '1-based line where symbol is written' },
	column: { type: 'integer', description: '1-based column, instead of symbol' },
	depth: { type: 'integer', description: 'callers/callees/impact: levels to follow (1-4; default 1, impact 3)' },
	query: { type: 'string', description: 'workspace_symbols: the name to look for' },
	pattern: { type: 'string', description: 'structural: the code pattern' },
	where: { type: 'object', description: 'structural: a regex per metavariable, e.g. {"MS":"^\\\\d"} keeps literal numbers' },
	glob: { type: 'string', description: 'structural: files, e.g. **/*.ts; !**/*.test.* skips' },
}, ['op']);

export const DIAGNOSTICS_DESCRIPTION = [
	'Errors and warnings from the editor\'s language services (type checker, linter) for the given files, or the whole workspace.',
	'Use right after editing to confirm the change type-checks; it is much faster than a full build.',
	'Only files the language service knows about are covered; a build or test run is still the final word.',
].join(' ');

export const DIAGNOSTICS_SCHEMA = objectSchema({
	paths: { type: 'array', items: { type: 'string' }, description: 'Files to check (default: all open problems)' },
	severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Default error' },
}, []);

export const CODE_ACTION_DESCRIPTION = [
	'Language-server refactors applied to the workspace, safer than hand edits across files.',
	'rename: renames the symbol at path + line + symbol (or column) everywhere it is used (new_name).',
	'format: formats path with its formatter. organize_imports: sorts and prunes path\'s imports.',
	'fixes: lists quick fixes and refactors offered at path (line, or the whole file); kind narrows (quickfix, refactor, source).',
	'fix: applies the one whose title contains title (default: the preferred fix at line).',
	'Returns the diff of every changed file. Run diagnostics afterwards.',
].join(' ');

export const CODE_ACTION_SCHEMA = objectSchema({
	op: { type: 'string', enum: [...CODE_ACTION_OPS] },
	path: { type: 'string' },
	line: { type: 'integer', description: '1-based line' },
	end_line: { type: 'integer', description: 'fixes/fix: last line of the range (default line)' },
	column: { type: 'integer' },
	symbol: { type: 'string', description: 'rename: the name on that line, instead of a column' },
	new_name: { type: 'string' },
	kind: { type: 'string', description: 'fixes/fix: quickfix (default), refactor, source, or a full kind such as refactor.extract' },
	title: { type: 'string', description: 'fix: part of the action title from fixes' },
}, ['op', 'path']);

export function createCodeTools(host: ICodeIntelHost, root: () => URI | undefined, nav?: ICodeNavIndex, write?: CodeEditWriter): IVoltTool[] {
	const tools: IVoltTool[] = [
		{
			name: 'diagnostics',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			idempotent: true,
			snippet: 'diagnostics - compiler and linter errors from the editor',
			description: DIAGNOSTICS_DESCRIPTION,
			schema: DIAGNOSTICS_SCHEMA,
			timeoutMs: 20_000,
			execute: async args => runDiagnostics(host, root(), args),
		},
		{
			name: 'code_nav',
			group: 'read',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'code_nav - definitions, references, types, call and type hierarchies via the language server',
			description: CODE_NAV_DESCRIPTION,
			schema: CODE_NAV_SCHEMA,
			timeoutMs: 30_000,
			execute: async args => runCodeNav(host, root(), args, nav),
		},
	];
	if (write && host.rename) {
		tools.push({
			name: 'code_action',
			group: 'edit',
			kind: 'edit',
			parallelSafe: false,
			snippet: 'code_action - rename, format, organize imports, quick fixes via the language server',
			description: CODE_ACTION_DESCRIPTION,
			schema: CODE_ACTION_SCHEMA,
			timeoutMs: 60_000,
			execute: async (args, ctx) => runCodeAction(host, root(), args, write, ctx),
		});
	}
	return tools;
}

export async function runDiagnostics(host: ICodeIntelHost, root: URI | undefined, args: unknown): Promise<IToolResult> {
	const raw = asRecord(args).paths;
	const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
	const uris = list.map(path => resolveWorkspaceUri(root, path)).filter((uri): uri is URI => !!uri);
	if (list.length && !uris.length) {
		return fail('diagnostics', 'None of those paths are inside the workspace.');
	}
	const severity = (pickString(args, 'severity') ?? 'error') as 'error' | 'warning' | 'all';
	const checked = uris.filter(uri => host.lspAllowed(uri));
	if (uris.length && !checked.length) {
		return { callId: '', name: 'diagnostics', kind: 'read', text: 'Language servers are off for this checkout (Settings > Code Intelligence), so the editor has no diagnostics for it. Run the project\'s type checker or linter instead.' };
	}
	try {
		const found = await host.diagnostics(checked.length ? checked : undefined, severity);
		if (!found.length) {
			const scope = uris.length ? uris.map(uri => displayPath(root, uri)).join(', ') : 'the workspace';
			return { callId: '', name: 'diagnostics', kind: 'read', text: `No ${severity === 'all' ? 'problems' : `${severity}s`} in ${scope}.` };
		}
		const lines = found.slice(0, MAX_DIAGNOSTICS).map(item => {
			const code = item.code ? ` ${item.code}` : '';
			const source = item.source ? ` (${item.source})` : '';
			return `${displayPath(root, item.uri)}:${item.line}:${item.column} ${item.severity}${code}: ${item.message.split('\n')[0]}${source}`;
		});
		const more = found.length > MAX_DIAGNOSTICS ? `\n[${found.length - MAX_DIAGNOSTICS} more]` : '';
		const errors = found.filter(item => item.severity === 'error').length;
		return { callId: '', name: 'diagnostics', kind: 'read', text: `${errors} error${errors === 1 ? '' : 's'}, ${found.length - errors} other:\n${lines.join('\n')}${more}` };
	} catch (err) {
		return fail('diagnostics', errorText(err));
	}
}

interface IResolvedPosition {
	readonly uri: URI;
	readonly line: number;
	/** Set when a language server can be asked about the position. */
	readonly column?: number;
	/** The identifier there, for index fallbacks. */
	readonly name?: string;
	/** The line the caller gave, when the symbol was found on another one. */
	readonly movedFrom?: number;
}

/** Lines tried around a given line that misses the symbol, nearest first. */
const NEARBY_LINES = [-1, 1, -2, 2];

/**
 * Where `symbol` is when the given line misses it: agents pass a line one or two off (53 for a
 * class on 54), or a guess (1 for a method on 386), and every such call failed. Nearby lines
 * first, then the file's declaration of that name nearest the given line, then its nearest
 * whole-word use.
 */
async function findSymbolLine(host: ICodeIntelHost, uri: URI, line: number, symbol: string): Promise<{ line: number; column: number } | undefined> {
	const columnAt = async (candidate: number) => candidate >= 1 ? await host.columnOf(uri, candidate, symbol).catch(() => undefined) : undefined;
	for (const delta of NEARBY_LINES) {
		const column = await columnAt(line + delta);
		if (column) {
			return { line: line + delta, column };
		}
	}
	const declared = (await host.symbols(uri).catch(() => [])).filter(item => item.name === symbol).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line));
	for (const declaration of declared) {
		const column = await columnAt(declaration.line);
		if (column) {
			return { line: declaration.line, column };
		}
	}
	const content = await host.fileText?.(uri).catch(() => undefined);
	if (!content) {
		return undefined;
	}
	const word = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
	let best: { line: number; column: number } | undefined;
	content.split('\n').forEach((text, index) => {
		const found = word.exec(text);
		if (found && (!best || Math.abs(index + 1 - line) < Math.abs(best.line - line))) {
			best = { line: index + 1, column: found.index + 1 };
		}
	});
	return best;
}

async function resolvePosition(host: ICodeIntelHost, root: URI, uri: URI, args: unknown, lsp: boolean): Promise<IResolvedPosition | string> {
	const qualified = pickString(args, 'symbol', 'name');
	// Without a line, the symbol's declaration in the file: agents named path and symbol, and every such call failed.
	const line = pickNumber(args, 'line') ?? (qualified ? await declarationLine(host, uri, qualified) : undefined);
	if (!line) {
		return qualified ? `"${qualified}" is not declared in ${displayPath(root, uri)}. Pass the line where it is written, or leave out path to find it across the workspace.` : 'This op needs symbol (or line and column).';
	}
	const givenColumn = pickNumber(args, 'column', 'character');
	// `Type.member` names a member; the line holds only the member's own name. A line alone (the
	// agent read it in a listing) names what is declared there.
	const symbol = qualified?.split('.').filter(Boolean).at(-1) ?? (givenColumn ? undefined : declaredNameOn(await host.fileText?.(uri).catch(() => undefined), line));
	const column = lsp ? givenColumn ?? (symbol ? await host.columnOf(uri, line, symbol) : undefined) : undefined;
	const name = symbol ?? (givenColumn ? await host.wordAt(uri, line, givenColumn) : undefined);
	if (lsp && symbol && !column && !givenColumn) {
		const found = await findSymbolLine(host, uri, line, symbol);
		if (!found) {
			return `"${symbol}" does not appear on line ${line} of ${displayPath(root, uri)} or anywhere else in it.`;
		}
		return { uri, line: found.line, column: found.column, name: symbol, movedFrom: line };
	}
	if (!column && !name) {
		return 'Pass column or symbol.';
	}
	return { uri, line, ...(column ? { column } : {}), ...(name ? { name } : {}) };
}

const DECLARATION_KEYWORDS = '(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|namespace|module|def|func|fn|struct|trait|impl)';

/**
 * The line `symbol` is declared on in a file: a declaration keyword before it, else a member
 * (`name(`, `name:`, `name =` at the start of a line), else its first whole-word use. For
 * `Type.member`, the member is looked for after the type's declaration.
 */
export function declarationLineIn(text: string, qualified: string): number | undefined {
	const parts = qualified.split('.').filter(Boolean);
	const name = parts.at(-1);
	if (!name) {
		return undefined;
	}
	const lines = text.split('\n');
	let from = 0;
	if (parts.length > 1) {
		const container = declarationLineIn(text, parts.slice(0, -1).join('.'));
		if (container) {
			from = container;
		}
	}
	const word = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const patterns = [
		new RegExp(`^\\s*${DECLARATION_KEYWORDS}\\s+${word}\\b`),
		new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\\s+)*\\*?${word}\\s*(?:\\?|!)?\\s*(?:[(<:=]|\\(.*\\)\\s*\\{)`),
		new RegExp(`\\b${word}\\b`),
	];
	for (const pattern of patterns) {
		for (let index = from > 0 ? from - 1 : 0; index < lines.length; index++) {
			if (pattern.test(lines[index])) {
				return index + 1;
			}
		}
	}
	return undefined;
}

/** The name declared on a line (`export interface StateReader {` -> StateReader, `  query(sql: string)` -> query). */
export function declaredNameOn(text: string | undefined, line: number): string | undefined {
	const source = text?.split('\n')[line - 1];
	if (!source) {
		return undefined;
	}
	const member = /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?([\w$]+)\s*[?!]?\s*[(<:=]/.exec(source)?.[1];
	return new RegExp(`^\\s*${DECLARATION_KEYWORDS}\\s+([\\w$]+)`).exec(source)?.[1]
		?? (member && !/^(?:if|for|while|switch|return|catch|await|yield|throw|new|typeof)$/.test(member) ? member : undefined);
}

async function declarationLine(host: ICodeIntelHost, uri: URI, qualified: string): Promise<number | undefined> {
	const text = await host.fileText?.(uri).catch(() => undefined);
	return text === undefined ? undefined : declarationLineIn(text, qualified);
}

/**
 * Where a symbol named without a path is declared: the language server's workspace symbols, an
 * exact name (and container, for `Type.member`) first, else the code index. Several equally good
 * candidates are listed back instead of picking one at random.
 */
async function locateDeclaration(host: ICodeIntelHost, root: URI, qualified: string, nav: ICodeNavIndex | undefined): Promise<{ uri: URI; line: number } | string> {
	const parts = qualified.split('.').filter(Boolean);
	const name = parts.at(-1) ?? qualified;
	const container = parts.length > 1 ? parts.at(-2) : undefined;
	const symbols = host.workspaceSymbols ? await host.workspaceSymbols(name, MAX_SYMBOLS).catch(() => []) : [];
	const exact = symbols.filter(symbol => symbol.name === name && (!container || symbol.container === container || symbol.container?.endsWith(`.${container}`)));
	// Declarations in tests and generated or vendored code lose to the real one.
	const ranked = [...exact].sort((a, b) => noiseRank(displayPath(root, a.uri)) - noiseRank(displayPath(root, b.uri)));
	if (ranked.length === 1 || (ranked.length > 1 && noiseRank(displayPath(root, ranked[0].uri)) < noiseRank(displayPath(root, ranked[1].uri)))) {
		return { uri: ranked[0].uri, line: ranked[0].line };
	}
	if (ranked.length > 1) {
		return `"${qualified}" is declared in ${ranked.length} places; pass path (and line) for the one you mean:\n${ranked.slice(0, 10).map(symbol => `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}  ${displayPath(root, symbol.uri)}:${symbol.line}`).join('\n')}`;
	}
	const indexed = nav && /^[\w$]+$/.test(name) ? declarationsOnly(await nav.definitions(root, name).catch(() => undefined)) : undefined;
	if (indexed?.length === 1) {
		return { uri: indexed[0].uri, line: indexed[0].line };
	}
	if (indexed?.length) {
		return `"${qualified}" may be declared in ${indexed.length} places; pass path (and line) for the one you mean:\n${indexed.slice(0, 10).map(item => `${displayPath(root, item.uri)}:${item.line}${item.preview ? `  ${item.preview}` : ''}`).join('\n')}`;
	}
	return `No declaration of "${qualified}" found. Pass path and line, or search with grep.`;
}

/**
 * The index's name-matched declarations without import specifiers: its extractor reads the
 * `type StateReader,` line of a multi-line `import { ... }` as a type declaration, and
 * workspace_symbols answered two imports and one interface for "StateReader".
 */
export function declarationsOnly(found: readonly ICodeLocation[] | undefined): ICodeLocation[] | undefined {
	return found?.filter(location => !location.preview || !/^(?:import\b|type\s+[\w$]+(?:\s+as\s+[\w$]+)?,?$|[\w$]+\s+as\s+[\w$]+,?$)/.test(location.preview));
}

function noiseRank(path: string): number {
	return /(^|\/)(node_modules|dist|build|out|vendor|generated)\//.test(path) || /\.d\.ts$/.test(path) ? 2 : /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.\w+$/.test(path) ? 1 : 0;
}

export async function runCodeNav(host: ICodeIntelHost, root: URI | undefined, args: unknown, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const op = (pickString(args, 'op', 'operation') ?? '') as CodeNavOp;
	if (!(CODE_NAV_OPS as readonly string[]).includes(op)) {
		return fail('code_nav', `op must be one of ${CODE_NAV_OPS.join(', ')}.`);
	}
	if (!root) {
		return fail('code_nav', 'No workspace folder.');
	}
	if (op === 'workspace_symbols') {
		return workspaceSymbols(host, root, pickString(args, 'query', 'symbol', 'name'), nav);
	}
	args = splitPathSymbol(args);
	if (op === 'structural') {
		return structuralSearch(root, args, nav);
	}
	if (op === 'body') {
		return bodies(host, root, args, nav);
	}
	const path = pickString(args, 'path', 'file');
	let uri = resolveWorkspaceUri(root, path);
	if (op === 'impact' && uri && !pickString(args, 'symbol', 'name') && !pickNumber(args, 'line')) {
		return moduleImpact(host, root, uri, nav);
	}
	if (!uri && !path && (POSITIONAL.has(op) || op === 'impact')) {
		// A symbol without a path: its declaration, from the language server's workspace symbols or the index.
		const qualified = pickString(args, 'symbol', 'name');
		const found = qualified ? await locateDeclaration(host, root, qualified, nav) : 'This op needs symbol (or path, line and column).';
		if (typeof found === 'string') {
			return fail('code_nav', found);
		}
		uri = found.uri;
		args = { ...asRecord(args), line: found.line };
	}
	if (!uri) {
		return fail('code_nav', 'path is missing or outside the workspace.');
	}
	const lsp = host.lspAllowed(uri);
	try {
		if (op === 'symbols') {
			return outline(host, root, uri, lsp, nav);
		}
		if (op === 'impact') {
			const position = await resolvePosition(host, root, uri, args, lsp);
			if (typeof position === 'string') {
				return fail('code_nav', position);
			}
			return impact(host, root, position, nav, lsp, pickNumber(args, 'depth', 'levels'));
		}
		if (!POSITIONAL.has(op)) {
			return fail('code_nav', `Unknown op ${op}.`);
		}
		const position = await resolvePosition(host, root, uri, args, lsp);
		if (typeof position === 'string') {
			return fail('code_nav', position);
		}
		const answer = await positional(host, root, op, position, nav, lsp, pickNumber(args, 'depth', 'levels'));
		return position.movedFrom === undefined ? answer : { ...answer, text: `"${position.name}" is on line ${position.line}, not ${position.movedFrom}.\n${answer.text}` };
	} catch (err) {
		return fail('code_nav', errorText(err));
	}
}

async function positional(host: ICodeIntelHost, root: URI, op: CodeNavOp, position: IResolvedPosition, nav: ICodeNavIndex | undefined, lsp: boolean, depth: number | undefined): Promise<IToolResult> {
	const uri = position.uri;
	switch (op) {
		case 'definition':
		case 'references':
			return navigate(host, root, op, position, nav, lsp);
		case 'implementations':
		case 'type_definition': {
			const ask = op === 'implementations' ? host.implementations : host.typeDefinitions;
			const found = position.column && ask ? await ask.call(host, uri, position.line, position.column) : [];
			if (found.length) {
				const unseen = op === 'implementations' ? await unseenImplementations(host, root, position, found, nav) : '';
				return text(`${locations(root, op === 'implementations' ? 'implementation' : 'type definition', found, '').text}${unseen}`);
			}
			if (op !== 'implementations') {
				return text(`No type definition reported for ${where(root, position)}${noLspNote(lsp)}.`);
			}
			// The language server only looks in the projects it loaded: an interface in a shared
			// package had "no implementations" while nine classes in the app implement it.
			const named = position.name && nav?.implementations ? await nav.implementations(root, position.name) ?? [] : [];
			const unseen = await unseenImplementations(host, root, position, named, nav);
			if (named.length) {
				return text(`${locations(root, 'implementation', named, FROM_INDEX).text}${unseen}`);
			}
			return text(`No implementations reported for ${where(root, position)}${noLspNote(lsp)}.${unseen}`);
		}
		case 'hover': {
			const hover = position.column && host.hover ? await host.hover(uri, position.line, position.column) : undefined;
			return text(hover ? `${where(root, position)}:\n${hover}` : `No type information at ${where(root, position)}${noLspNote(lsp)}.`);
		}
		case 'inspect':
			return inspect(host, root, position, nav, lsp);
		case 'callers':
		case 'callees':
			return callHierarchy(host, root, position, op, lsp, depth);
		case 'supertypes':
		case 'subtypes':
			return typeHierarchy(host, root, position, op, lsp);
		default:
			return fail('code_nav', `Unknown op ${op}.`);
	}
}

async function outline(host: ICodeIntelHost, root: URI, uri: URI, lsp: boolean, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const symbols = lsp ? await host.symbols(uri) : [];
	if (symbols.length) {
		const shown = outlineSymbols(symbols);
		const lines = shown.slice(0, 300).map(symbol => `${'  '.repeat(symbol.depth)}${symbol.kind} ${symbol.name} [${symbol.line}-${symbol.endLine}]${symbol.detail ? ` ${symbol.detail}` : ''}`);
		const hidden = symbols.length - shown.length;
		return text(`${displayPath(root, uri)} outline${hidden ? ` (${hidden} locals and callbacks left out)` : ''}:\n${lines.join('\n')}`);
	}
	// No language server: the syntax tree's declarations, with their ranges.
	const parsed = await nav?.structure?.(root, uri).catch(() => undefined);
	if (parsed?.symbols.length) {
		const lines = parsed.symbols.slice(0, 300).map(symbol => `${'  '.repeat(symbol.depth)}${symbol.kind} ${symbol.name} [${symbol.line}-${symbol.endLine}]`);
		return text(`${displayPath(root, uri)} outline (from its syntax tree, no language server):\n${lines.join('\n')}`);
	}
	const indexed = await nav?.outline(root, uri);
	if (indexed?.length) {
		const lines = indexed.slice(0, 300).map(symbol => `${symbol.kind} ${symbol.name} [${symbol.line}]`);
		return text(`${displayPath(root, uri)} outline${FROM_INDEX}:\n${lines.join('\n')}`);
	}
	return text(`No symbols reported for ${displayPath(root, uri)} (no language server, or an empty file).`);
}

const FROM_INDEX = ' (from the code index: matched by name, not type-checked)';

const VALUE_KINDS: ReadonlySet<string> = new Set(['variable', 'property', 'constant', 'field', 'key', 'string', 'number', 'boolean', 'array', 'object', 'null', 'enum member', 'type parameter']);

/**
 * The outline an agent reads: declarations, members and the members of an object (an oRPC
 * router's procedures), without the locals and anonymous callbacks inside function bodies. A
 * 2,000-line router's full outline was 9-10k characters, mostly `variable tenantContext` and
 * `function execute() callback`; agents read four of them to map lines to procedures.
 */
export function outlineSymbols(symbols: readonly ICodeSymbol[]): ICodeSymbol[] {
	const out: ICodeSymbol[] = [];
	// Depth of the innermost function body we are in (its locals are skipped), by line range.
	const bodies: ICodeSymbol[] = [];
	for (const symbol of symbols) {
		while (bodies.length && (bodies[bodies.length - 1].depth >= symbol.depth || bodies[bodies.length - 1].endLine < symbol.line)) {
			bodies.pop();
		}
		const isCallback = / callback$/.test(symbol.name);
		const inBody = bodies.length > 0;
		if (!isCallback && !(inBody && VALUE_KINDS.has(symbol.kind))) {
			out.push(symbol);
		}
		if (isCallback || symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor') {
			bodies.push(symbol);
		}
	}
	return out;
}

/**
 * The named declaration a line sits in: `quickServiceRouter.quickCheckout` for a call inside the
 * handler callback of a router property. Callbacks and other anonymous functions are skipped.
 */
export function enclosingName(symbols: readonly ICodeSymbol[], line: number): string | undefined {
	const chain = symbols.filter(symbol => symbol.line <= line && symbol.endLine >= line).sort((a, b) => a.depth - b.depth);
	const names: string[] = [];
	let inBody = false;
	for (const symbol of chain) {
		const callback = / callback$/.test(symbol.name);
		// Inside a function body, variables and properties are locals (`const invoicing = ...`), not names of the code.
		if (!callback && !/^<.*>$/.test(symbol.name) && !(inBody && VALUE_KINDS.has(symbol.kind))) {
			names.push(symbol.name);
		}
		inBody ||= callback || symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor';
	}
	return names.length ? names.join('.') : undefined;
}

/**
 * TypeScript names the caller of a call made inside an arrow function in an object literal (every
 * oRPC procedure, every route table) as the whole module. The outline turns those call sites into
 * the procedures they are in, so the agent does not read the router's outline to map lines.
 */
async function namedSites(host: ICodeIntelHost, edge: ICallEdge): Promise<string | undefined> {
	if (edge.kind !== 'module' && edge.kind !== 'file' && !/ callback$/.test(edge.name)) {
		return undefined;
	}
	const symbols = await host.symbols(edge.uri).catch(() => []);
	if (!symbols.length) {
		return undefined;
	}
	const byName = new Map<string, number[]>();
	for (const site of edge.sites) {
		const name = enclosingName(symbols, site) ?? `line ${site}`;
		byName.set(name, [...(byName.get(name) ?? []), site]);
	}
	return [...byName].map(([name, sites]) => `${name} (${sites.join(', ')})`).join(', ');
}

async function navigate(host: ICodeIntelHost, root: URI, op: 'definition' | 'references', position: IResolvedPosition, nav: ICodeNavIndex | undefined, lsp: boolean): Promise<IToolResult> {
	if (position.column) {
		const found = op === 'definition' ? await host.definitions(position.uri, position.line, position.column) : await host.references(position.uri, position.line, position.column);
		if (found.length) {
			const result = locations(root, op, found, '');
			return op === 'references' ? withUnseenUses(root, result, found, position, nav) : result;
		}
	}
	if (nav && position.name) {
		const found = op === 'definition' ? await nav.definitions(root, position.name) : await nav.references(root, position.name);
		if (found?.length) {
			return locations(root, op, found, FROM_INDEX);
		}
	}
	return text(lsp
		? `No ${op} found (the language server returned nothing for ${where(root, position)}).`
		: `No ${op} found for ${position.name ? JSON.stringify(position.name) : where(root, position)} (language servers are off for this checkout; pass symbol to look it up by name).`);
}

/** The language server's references stay in this many files or fewer: compare with the index. */
const NARROW_REFERENCE_FILES = 1;
const MAX_UNSEEN_FILES = 15;

/**
 * A language server only searches the projects it has loaded: in a monorepo whose packages are
 * not built, or for a property of a mapped type (an ORM column, `roomTypes.maxOccupancy`), it
 * reported 1 reference where 80 uses exist, and an agent took that as "safe to rename". When the
 * server's answer stays in one file and the index sees the name in other files, those are listed
 * too, marked as matched by name.
 */
async function withUnseenUses(root: URI, result: IToolResult, found: readonly ICodeLocation[], position: IResolvedPosition, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const files = new Set(found.map(location => location.uri.toString()));
	if (!nav || !position.name || files.size > NARROW_REFERENCE_FILES) {
		return result;
	}
	const indexed = await nav.references(root, position.name).catch(() => undefined);
	const unseen = (indexed ?? []).filter(location => !files.has(location.uri.toString()));
	if (!unseen.length) {
		return result;
	}
	const byFile = groupByFile(root, unseen);
	const lines = byFile.slice(0, MAX_UNSEEN_FILES).map(([file, refs]) => `${file}: ${refs.slice(0, 8).map(ref => ref.line).join(', ')}${refs.length > 8 ? ` (+${refs.length - 8})` : ''}`);
	const more = byFile.length > MAX_UNSEEN_FILES ? `\n[${byFile.length - MAX_UNSEEN_FILES} more files]` : '';
	return text(`${result.text}\n\nThe language server found uses in this file only, but "${position.name}" also appears in ${byFile.length} other file${byFile.length === 1 ? '' : 's'} (${unseen.length} whole-word match${unseen.length === 1 ? '' : 'es'}; by name, not type-checked; the server may not have loaded those projects):\n${lines.join('\n')}${more}`);
}

function groupByFile(root: URI, found: readonly ICodeLocation[]): [string, ICodeLocation[]][] {
	const byFile = new Map<string, ICodeLocation[]>();
	for (const location of found) {
		const key = displayPath(root, location.uri);
		byFile.set(key, [...(byFile.get(key) ?? []), location]);
	}
	return [...byFile];
}

/** Places that type something as the interface by name: a return type `): StateReader`, `implements`, `satisfies`, `const x: StateReader`. */
const TYPED_AS = (name: string) => {
	const word = name.replace(/[$]/g, '\\$&');
	return new RegExp(`\\bimplements\\s+(?:[\\w$.]+\\s*,\\s*)*${word}\\b|\\)\\s*:\\s*(?:Promise<)?${word}\\b|\\bsatisfies\\s+${word}\\b|\\b(?:const|let|var)\\s+[\\w$]+\\s*:\\s*${word}\\b`);
};

/**
 * A language server finds implementations only in the projects it has loaded: in a monorepo it
 * reported the class next to an interface and missed the two object literals typed as it in two
 * other packages, and the agent answered "1 implementation" (hotel benchmark, Q8). The index
 * lists, by name, the other files that type something as the interface, so the gap is visible.
 */
async function unseenImplementations(host: ICodeIntelHost, root: URI, position: IResolvedPosition, found: readonly ICodeLocation[], nav: ICodeNavIndex | undefined): Promise<string> {
	if (!nav) {
		return '';
	}
	// A member (`query` of `StateReader`) is implemented where its interface is.
	const outline = await host.symbols(position.uri).catch(() => []);
	const owner = outline.filter(symbol => symbol.line <= position.line && symbol.endLine >= position.line && (symbol.kind === 'interface' || symbol.kind === 'class')).sort((a, b) => b.depth - a.depth)[0];
	const name = owner?.name ?? position.name;
	if (!name || !/^[\w$]+$/.test(name)) {
		return '';
	}
	const files = new Set(found.map(location => location.uri.toString()));
	files.add(position.uri.toString());
	const typed = TYPED_AS(name);
	const unseen = (await nav.references(root, name).catch(() => undefined) ?? []).filter(location => !files.has(location.uri.toString()) && location.preview && typed.test(location.preview) && !/^import\b/.test(location.preview));
	if (!unseen.length) {
		return '';
	}
	const lines = unseen.slice(0, 15).map(location => `${displayPath(root, location.uri)}:${location.line}  ${location.preview}`);
	return `\n\nThe language server only searches the projects it has loaded. These ${unseen.length === 1 ? 'place types' : `${unseen.length} places type`} something as ${name} in files it did not report (matched by name, not type-checked):\n${lines.join('\n')}${unseen.length > 15 ? `\n[${unseen.length - 15} more]` : ''}`;
}

/**
 * The questions an agent asks about an unfamiliar symbol, answered in one call: what it is (hover),
 * where it lives and what it says (definition + body), who uses it (references grouped by file)
 * and what implements it. Each part degrades on its own, so a missing provider costs one line.
 */
async function inspect(host: ICodeIntelHost, root: URI, position: IResolvedPosition, nav: ICodeNavIndex | undefined, lsp: boolean): Promise<IToolResult> {
	const { uri, line, column, name } = position;
	const [hover, definitions, references, implementations] = await Promise.all([
		column && host.hover ? host.hover(uri, line, column).catch(() => undefined) : undefined,
		(column ? host.definitions(uri, line, column).catch(() => []) : Promise.resolve([])).then(async found => found.length || !nav || !name ? { found, note: '' } : { found: await nav.definitions(root, name) ?? [], note: FROM_INDEX }),
		(column ? host.references(uri, line, column).catch(() => []) : Promise.resolve([])).then(async found => found.length || !nav || !name ? { found, note: '' } : { found: await nav.references(root, name) ?? [], note: FROM_INDEX }),
		(column && host.implementations ? host.implementations(uri, line, column).catch(() => []) : Promise.resolve([])).then(async found => found.length || !nav?.implementations || !name ? found : await nav.implementations(root, name).catch(() => undefined) ?? []),
	]);
	const out: string[] = [`${name ? `\`${name}\` at ` : ''}${where(root, position)}${noLspNote(lsp)}`];
	if (hover) {
		out.push(`Type:\n${hover}`);
	}
	const definition = definitions.found[0];
	if (definition) {
		const body = await definitionBody(host, definition, lsp);
		out.push(`Defined at ${displayPath(root, definition.uri)}:${definition.line}${definitions.note}${definitions.found.length > 1 ? ` (+${definitions.found.length - 1} more)` : ''}${body ? `:\n${body}` : ''}`);
	} else {
		out.push('Definition: not found.');
	}
	if (references.found.length) {
		const byFile = new Map<string, ICodeLocation[]>();
		for (const ref of references.found) {
			const key = displayPath(root, ref.uri);
			byFile.set(key, [...(byFile.get(key) ?? []), ref]);
		}
		const files = [...byFile].sort((a, b) => b[1].length - a[1].length);
		const lines = files.slice(0, 12).map(([file, refs]) => `  ${file} \u00d7${refs.length}: ${refs.slice(0, 4).map(ref => ref.line).join(', ')}${refs[0].preview ? `  ${refs[0].preview}` : ''}`);
		out.push(`${references.found.length} reference${references.found.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${references.note}:\n${lines.join('\n')}${files.length > 12 ? `\n  [${files.length - 12} more files]` : ''}`);
	} else {
		out.push('References: none found.');
	}
	// The language server may not see other projects (see withUnseenUses): say what the index sees.
	const referenceFiles = new Set(references.found.map(ref => ref.uri.toString()));
	if (!references.note && referenceFiles.size <= NARROW_REFERENCE_FILES && nav && name) {
		const unseen = (await nav.references(root, name).catch(() => undefined) ?? []).filter(ref => !referenceFiles.has(ref.uri.toString()));
		if (unseen.length) {
			const byFile = groupByFile(root, unseen);
			out.push(`Also by name (not type-checked) in ${byFile.length} other file${byFile.length === 1 ? '' : 's'}: ${byFile.slice(0, MAX_UNSEEN_FILES).map(([file, refs]) => `${file} \u00d7${refs.length}`).join(', ')}${byFile.length > MAX_UNSEEN_FILES ? ', \u2026' : ''}`);
		}
	}
	if (implementations.length) {
		out.push(`Implementations:\n${implementations.slice(0, 10).map(item => `  ${displayPath(root, item.uri)}:${item.line}${item.preview ? `  ${item.preview}` : ''}`).join('\n')}`);
	}
	return text(out.join('\n\n'));
}

/** The definition's source: the symbol's whole range from the file outline, capped. */
async function definitionBody(host: ICodeIntelHost, definition: ICodeLocation, lsp: boolean): Promise<string | undefined> {
	const symbols = lsp ? await host.symbols(definition.uri).catch(() => []) : [];
	const symbol = symbols.filter(item => item.line <= definition.line && item.endLine >= definition.line).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
	const start = symbol?.line ?? definition.line;
	const end = Math.min(symbol?.endLine ?? definition.line + 10, start + MAX_BODY_LINES - 1);
	const fileText = await host.fileText?.(definition.uri).catch(() => undefined);
	if (!fileText) {
		return definition.preview;
	}
	const lines = fileText.split('\n');
	const body = lines.slice(start - 1, end).map((content, index) => `${String(start + index).padStart(5)}  ${content}`);
	const cut = symbol && symbol.endLine > end ? `\n      [${symbol.endLine - end} more lines]` : '';
	return body.join('\n') + cut;
}

async function workspaceSymbols(host: ICodeIntelHost, root: URI, query: string | undefined, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	if (!query?.trim()) {
		return fail('code_nav', 'workspace_symbols needs query.');
	}
	const found = host.workspaceSymbols ? await host.workspaceSymbols(query.trim(), MAX_SYMBOLS).catch(() => []) : [];
	if (found.length) {
		const lines = found.slice(0, MAX_SYMBOLS).map(symbol => `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}  ${displayPath(root, symbol.uri)}:${symbol.line}`);
		return text(`${found.length} symbol${found.length === 1 ? '' : 's'} matching "${query}":\n${lines.join('\n')}`);
	}
	const indexed = nav && /^[\w$]+$/.test(query.trim()) ? declarationsOnly(await nav.definitions(root, query.trim())) : undefined;
	if (indexed?.length) {
		return locations(root, 'definition', indexed, FROM_INDEX);
	}
	return text(`No symbols matching "${query}". Try grep or find_symbol with part of the name.`);
}

async function callHierarchy(host: ICodeIntelHost, root: URI, position: IResolvedPosition, op: 'callers' | 'callees', lsp: boolean, depth: number | undefined): Promise<IToolResult> {
	const edges = position.column && host.calls ? await host.calls(position.uri, position.line, position.column, op === 'callers' ? 'incoming' : 'outgoing') : undefined;
	if (!edges) {
		return text(`No call hierarchy for ${where(root, position)}${noLspNote(lsp)}. ${op === 'callers' ? 'Use op references' : 'Read the function body'} instead.`);
	}
	if (!edges.length) {
		return text(op === 'callers' ? `Nothing calls ${where(root, position)}.` : `${where(root, position)} calls nothing the language server can resolve.`);
	}
	const levels = Math.max(1, Math.min(MAX_CALL_DEPTH, Math.floor(depth ?? 1)));
	if (levels > 1) {
		return callTree(host, root, position, op, edges, levels);
	}
	const named = op === 'callers' ? await Promise.all(edges.slice(0, MAX_LOCATIONS).map(edge => namedSites(host, edge))) : [];
	const lines = edges.slice(0, MAX_LOCATIONS).map((edge, index) => named[index]
		? `${displayPath(root, edge.uri)}: calls in ${named[index]}`
		: `${edge.kind} ${edge.container ? `${edge.container}.` : ''}${edge.name}  ${displayPath(root, edge.uri)}:${edge.line}${edge.sites.length ? `  (${op === 'callers' ? 'calls at' : 'called at'} line${edge.sites.length === 1 ? '' : 's'} ${edge.sites.slice(0, 6).join(', ')})` : ''}`);
	return text(`${edges.length} ${op === 'callers' ? 'caller' : 'callee'}${edges.length === 1 ? '' : 's'} of ${position.name ?? where(root, position)}:\n${lines.join('\n')}${edges.length > MAX_LOCATIONS ? `\n[${edges.length - MAX_LOCATIONS} more]` : ''}`);
}

/**
 * Callers of callers (or callees of callees) as an indented tree, so "which entry points reach X"
 * is one call instead of one per level. Each function is expanded once; the walk stops at the
 * depth, the node budget or the deadline, and says so.
 */
async function callTree(host: ICodeIntelHost, root: URI, position: IResolvedPosition, op: 'callers' | 'callees', first: readonly ICallEdge[], levels: number): Promise<IToolResult> {
	const direction = op === 'callers' ? 'incoming' : 'outgoing';
	const deadline = Date.now() + CALL_TREE_DEADLINE_MS;
	const seen = new Set<string>([`${position.uri.toString()}:${position.line}`]);
	const lines: string[] = [];
	const tops: string[] = [];
	let nodes = 0;
	let cut = false;
	const label = (edge: ICallEdge) => `${edge.kind} ${edge.container ? `${edge.container}.` : ''}${edge.name}  ${displayPath(root, edge.uri)}:${edge.line}${edge.sites.length ? ` (${op === 'callers' ? 'calls at' : 'called at'} ${edge.sites.slice(0, 4).join(', ')})` : ''}`;
	const walk = async (edges: readonly ICallEdge[], level: number): Promise<void> => {
		for (const edge of edges) {
			if (nodes >= MAX_CALL_TREE_NODES || Date.now() > deadline) {
				cut = true;
				return;
			}
			nodes++;
			const key = `${edge.uri.toString()}:${edge.line}`;
			const indent = '  '.repeat(level - 1);
			// A module "caller" is the code at the top of a file: calls from object members (route
			// handlers), which nothing calls by name. Each one names its own sites, so it is never "repeated".
			const named = op === 'callers' ? await namedSites(host, edge) : undefined;
			if (named) {
				lines.push(`${indent}${displayPath(root, edge.uri)}: calls in ${named}`);
				continue;
			}
			if (seen.has(key)) {
				lines.push(`${indent}${label(edge)}  [repeated above]`);
				continue;
			}
			seen.add(key);
			lines.push(`${indent}${label(edge)}`);
			if (level >= levels) {
				continue;
			}
			const next = await host.calls!(edge.uri, edge.line, edge.column, direction).catch(() => undefined);
			if (next && !next.length && op === 'callers') {
				tops.push(`${edge.container ? `${edge.container}.` : ''}${edge.name} (${displayPath(root, edge.uri)}:${edge.line})`);
				lines[lines.length - 1] += '  [no callers]';
			} else if (next?.length) {
				await walk(next, level + 1);
			}
		}
	};
	await walk(first, 1);
	const head = `${op === 'callers' ? 'Callers' : 'Callees'} of ${position.name ?? where(root, position)} (${where(root, position)}), ${levels} levels, ${nodes} functions:`;
	const notes = [
		...(tops.length ? [`Nothing calls these (entry points such as route handlers, exports used by name, or tests): ${tops.join(', ')}.`] : []),
		...(cut ? [`Stopped early (${nodes >= MAX_CALL_TREE_NODES ? `${MAX_CALL_TREE_NODES} functions` : 'time limit'}); ask again from a deeper function for the rest.`] : []),
		'Calls through dynamic dispatch, callbacks passed as values and string-keyed routes do not show; check those with references.',
	];
	return text(`${head}\n${lines.join('\n')}\n${notes.join('\n')}`);
}

async function typeHierarchy(host: ICodeIntelHost, root: URI, position: IResolvedPosition, op: 'supertypes' | 'subtypes', lsp: boolean): Promise<IToolResult> {
	const types = position.column && host.typeHierarchy ? await host.typeHierarchy(position.uri, position.line, position.column, op) : undefined;
	if (!types) {
		return text(`No type hierarchy for ${where(root, position)}${noLspNote(lsp)}.${op === 'subtypes' ? ' Try op implementations.' : ''}`);
	}
	if (!types.length) {
		return text(`${position.name ?? where(root, position)} has no ${op}.`);
	}
	const lines = types.slice(0, MAX_LOCATIONS).map(type => `${type.kind} ${type.name}${type.detail ? ` ${type.detail}` : ''}  ${displayPath(root, type.uri)}:${type.line}`);
	return text(`${types.length} ${op === 'supertypes' ? 'supertype' : 'subtype'}${types.length === 1 ? '' : 's'} of ${position.name ?? where(root, position)}:\n${lines.join('\n')}`);
}

//#region body, impact, structural

/** `path#symbol`, in path or symbol, as path and symbol. */
export function splitPathSymbol(args: unknown): unknown {
	const record = asRecord(args);
	for (const key of ['path', 'file', 'symbol', 'name']) {
		const value = record[key];
		const at = typeof value === 'string' ? value.indexOf('#') : -1;
		if (typeof value === 'string' && at > 0) {
			const path = value.slice(0, at).trim();
			const symbol = value.slice(at + 1).trim();
			if (path && symbol && /[./]/.test(path)) {
				const rest = { ...record };
				delete rest.file;
				delete rest.name;
				return { ...rest, path, symbol };
			}
		}
	}
	return args;
}

/** Test files by the usual conventions of JS/TS, Python, Go, Rust, Java and Ruby. */
export function isTestPath(path: string): boolean {
	return /(^|\/)(__tests__|tests?|spec|specs|e2e)\//.test(path) || /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(path) || /(_test\.(go|py|rb)|_spec\.rb|Tests?\.(java|kt|cs))$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
}

/** body shows at most this many lines of one declaration; a longer class shows its head and members. */
const MAX_BODY_READ_LINES = 250;
const MAX_BODIES = 8;
/** Comment lines right above a declaration (its doc comment) come with its body, up to this many. */
const MAX_DOC_LINES = 20;

interface ISymbolSpan {
	readonly start: number;
	readonly end: number;
	readonly kind?: string;
	readonly name?: string;
	/** Members inside it (for an outline of a long class). */
	readonly members: readonly { readonly name: string; readonly kind: string; readonly line: number; readonly endLine: number }[];
	readonly source: 'lsp' | 'tree' | 'text';
}

/**
 * The whole declaration around `line`: the smallest symbol from the language server's outline
 * (else the syntax tree's) that contains the line and has the name, else the smallest that starts
 * on it. Without either, the lines until the indentation comes back to the declaration's.
 */
async function symbolSpan(host: ICodeIntelHost, root: URI, uri: URI, line: number, name: string | undefined, nav: ICodeNavIndex | undefined, lsp: boolean, text: string): Promise<ISymbolSpan> {
	const choose = (symbols: readonly { name: string; kind: string; line: number; endLine: number }[], source: 'lsp' | 'tree'): ISymbolSpan | undefined => {
		const containing = symbols.filter(symbol => symbol.line <= line && symbol.endLine >= line);
		const bySize = (a: { line: number; endLine: number }, b: { line: number; endLine: number }) => (a.endLine - a.line) - (b.endLine - b.line);
		const named = containing.filter(symbol => name && (symbol.name === name || symbol.name.startsWith(`${name}(`) || symbol.name.endsWith(`.${name}`))).sort(bySize)[0];
		const chosen = named ?? containing.filter(symbol => Math.abs(symbol.line - line) <= 3).sort(bySize)[0];
		if (!chosen) {
			return undefined;
		}
		const members = symbols.filter(symbol => symbol !== chosen && symbol.line > chosen.line && symbol.endLine <= chosen.endLine);
		return { start: chosen.line, end: chosen.endLine, kind: chosen.kind, name: chosen.name, members, source };
	};
	const fromLsp = lsp ? choose(await host.symbols(uri).catch(() => []), 'lsp') : undefined;
	if (fromLsp) {
		return fromLsp;
	}
	const parsed = await nav?.structure?.(root, uri).catch(() => undefined);
	const fromTree = parsed ? choose(parsed.symbols, 'tree') : undefined;
	if (fromTree) {
		return fromTree;
	}
	// By indentation: up to the first later line indented no deeper that closes or starts something.
	const lines = text.split('\n');
	const indent = (value: string) => /^\s*/.exec(value)![0].replace(/\t/g, '    ').length;
	const own = indent(lines[line - 1] ?? '');
	let end = line;
	for (let index = line; index < Math.min(lines.length, line + MAX_BODY_READ_LINES); index++) {
		const value = lines[index];
		if (!value.trim()) {
			continue;
		}
		if (indent(value) <= own) {
			end = /^\s*[}\])]/.test(value) || /^\s*end\b/.test(value) ? index + 1 : index;
			break;
		}
		end = index + 1;
	}
	return { start: line, end: Math.max(line, end), members: [], source: 'text' };
}

/** The comment block right above `start` (a doc comment, decorators), as the first line to show. */
function docStart(lines: readonly string[], start: number): number {
	let first = start;
	for (let index = start - 2; index >= 0 && start - index <= MAX_DOC_LINES; index--) {
		const value = lines[index].trim();
		if (/^(\/\/|\/\*|\*|#(?!include)|@[\w.]+)/.test(value) && value !== '') {
			first = index + 1;
		} else {
			break;
		}
	}
	return first;
}

async function bodies(host: ICodeIntelHost, root: URI, args: unknown, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const raw = pickString(args, 'symbol', 'name');
	if (!raw) {
		return fail('code_nav', 'body needs symbol (path narrows it; path#symbol works too).');
	}
	const path = pickString(args, 'path', 'file');
	const given = resolveWorkspaceUri(root, path);
	if (path && !given) {
		return fail('code_nav', 'path is missing or outside the workspace.');
	}
	const names = raw.split(',').map(name => name.trim()).filter(Boolean).slice(0, MAX_BODIES);
	const line = names.length === 1 ? pickNumber(args, 'line') : undefined;
	const parts = await Promise.all(names.map(name => oneBody(host, root, given, name, line, nav).catch(err => `${name}: ${errorText(err)}`)));
	const failed = parts.every(part => !part.includes('\n'));
	return failed ? fail('code_nav', parts.join('\n')) : text(parts.join('\n\n'));
}

async function oneBody(host: ICodeIntelHost, root: URI, given: URI | undefined, qualified: string, line: number | undefined, nav: ICodeNavIndex | undefined): Promise<string> {
	let uri = given;
	let at = line;
	if (!uri) {
		const found = await locateDeclaration(host, root, qualified, nav);
		if (typeof found === 'string') {
			return found;
		}
		uri = found.uri;
		at = found.line;
	}
	const content = await host.fileText?.(uri).catch(() => undefined);
	if (content === undefined) {
		return `${displayPath(root, uri)} could not be read.`;
	}
	at ??= declarationLineIn(content, qualified);
	if (!at) {
		return `"${qualified}" is not declared in ${displayPath(root, uri)}. Leave out path to look for it everywhere.`;
	}
	const name = qualified.split('.').filter(Boolean).at(-1);
	const span = await symbolSpan(host, root, uri, at, name, nav, host.lspAllowed(uri), content);
	const lines = content.split('\n');
	const first = docStart(lines, span.start);
	const numbered = (from: number, to: number) => lines.slice(from - 1, to).map((value, index) => `${String(from + index).padStart(5)}  ${value}`).join('\n');
	const head = `${displayPath(root, uri)}:${span.start}-${span.end}${span.kind ? ` ${span.kind}` : ''} ${span.name ?? qualified}`;
	if (span.end - first + 1 <= MAX_BODY_READ_LINES) {
		return `${head}\n${numbered(first, span.end)}`;
	}
	// A long class or module: its head, then its members by line, so the next body call can pick one.
	const shownTo = Math.min(span.end, first + 40);
	const members = span.members.slice(0, 80).map(member => `  ${member.kind} ${member.name} [${member.line}-${member.endLine}]`);
	return `${head} (${span.end - span.start + 1} lines; the first ${shownTo - first + 1}, then its members; ask body for ${span.name ?? qualified}.<member>)\n${numbered(first, shownTo)}${members.length ? `\nMembers:\n${members.join('\n')}` : `\n[${span.end - shownTo} more lines]`}`;
}

/** impact stops looking (and says so) after this long; callers stop earlier so the rest still runs. */
const IMPACT_DEADLINE_MS = 20_000;
const IMPACT_CALLERS_MS = 12_000;
const MAX_IMPACT_CALLERS = 40;
const MAX_IMPACT_FILES = 40;
/** Files whose importers are searched for tests. */
const MAX_TEST_SOURCES = 10;
const MAX_DIAGNOSED_FILES = 8;
const IMPACT_DIAGNOSTICS_MS = 5_000;

interface IAffected {
	readonly uri: URI;
	readonly reasons: Set<string>;
	readonly lines: Set<number>;
	/** 0: the definition's own file; 1: uses or imports it; 2+: calls something that does. */
	level: number;
}

interface ICallerNode {
	readonly level: number;
	readonly label: string;
	readonly uri: URI;
	readonly sites: readonly number[];
	top?: boolean;
}

async function collectCallers(host: ICodeIntelHost, root: URI, position: IResolvedPosition, levels: number, deadline: number): Promise<{ nodes: ICallerNode[]; cut: boolean } | undefined> {
	if (!position.column || !host.calls) {
		return undefined;
	}
	const first = await host.calls(position.uri, position.line, position.column, 'incoming').catch(() => undefined);
	if (!first) {
		return undefined;
	}
	const seen = new Set<string>([`${position.uri.toString()}:${position.line}`]);
	const nodes: ICallerNode[] = [];
	let cut = false;
	const walk = async (edges: readonly ICallEdge[], level: number): Promise<void> => {
		for (const edge of edges) {
			if (nodes.length >= MAX_IMPACT_CALLERS || Date.now() > deadline) {
				cut = true;
				return;
			}
			const named = await namedSites(host, edge);
			if (named) {
				nodes.push({ level, label: `${displayPath(root, edge.uri)}: calls in ${named}`, uri: edge.uri, sites: edge.sites });
				continue;
			}
			const key = `${edge.uri.toString()}:${edge.line}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const node: ICallerNode = { level, label: `${edge.container ? `${edge.container}.` : ''}${edge.name}  ${displayPath(root, edge.uri)}:${edge.line}${edge.sites.length ? ` (calls at ${edge.sites.slice(0, 4).join(', ')})` : ''}`, uri: edge.uri, sites: edge.sites };
			nodes.push(node);
			if (level < levels) {
				const next = await host.calls!(edge.uri, edge.line, edge.column, 'incoming').catch(() => undefined);
				if (next && !next.length) {
					node.top = true;
				} else if (next?.length) {
					await walk(next, level + 1);
				}
			}
		}
	};
	await walk(first, 1);
	return { nodes, cut };
}

const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\}|type\s+\{)[^;]*\bfrom\b|(?:const|let|var)\s+[\w${},\s]+=\s*require\(|from\s+[\w.]+\s+import\b|use\s)/;

/**
 * What a change to a symbol reaches, in one answer: its callers up to `levels` (the route or
 * procedure each chain ends in), every file that uses or imports it (type-checked references,
 * with the index's name matches for projects the language server did not load), the tests that
 * cover those files (by the import graph), and the errors those files have now. Agents otherwise
 * piece this together from 4-6 grep and read rounds before a refactor.
 */
async function impact(host: ICodeIntelHost, root: URI, position: IResolvedPosition, nav: ICodeNavIndex | undefined, lsp: boolean, depth: number | undefined): Promise<IToolResult> {
	const started = Date.now();
	const levels = Math.max(1, Math.min(MAX_CALL_DEPTH, Math.floor(depth ?? 3)));
	const name = position.name;
	const content = await host.fileText?.(position.uri).catch(() => undefined) ?? '';
	const [span, lspReferences, callers, moduleImporters] = await Promise.all([
		symbolSpan(host, root, position.uri, position.line, name, nav, lsp, content),
		position.column ? host.references(position.uri, position.line, position.column).catch(() => []) : Promise.resolve([]),
		collectCallers(host, root, position, levels, started + IMPACT_CALLERS_MS),
		nav?.importers?.(root, position.uri, 1).catch(() => undefined),
	]);
	let references: readonly ICodeLocation[] = lspReferences;
	let byName = '';
	// No language server answer, or one that stays in this file while the name is used elsewhere: the index's matches by name.
	const lspFiles = new Set(lspReferences.map(ref => ref.uri.toString()));
	if (nav && name && /^[\w$]+$/.test(name) && lspFiles.size <= NARROW_REFERENCE_FILES) {
		const indexed = await nav.references(root, name).catch(() => undefined) ?? [];
		const extra = indexed.filter(ref => !lspFiles.has(ref.uri.toString()));
		if (extra.length) {
			references = [...lspReferences, ...extra];
			byName = lspReferences.length ? ' (files past the first matched by name, not type-checked)' : FROM_INDEX;
		}
	}
	const affected = new Map<string, IAffected>();
	const note = (uri: URI, reason: string, lines: readonly number[], level: number) => {
		const key = uri.toString();
		let entry = affected.get(key);
		if (!entry) {
			entry = { uri, reasons: new Set(), lines: new Set(), level };
			affected.set(key, entry);
		}
		entry.reasons.add(reason);
		lines.forEach(line => entry!.lines.add(line));
		entry.level = Math.min(entry.level, level);
	};
	const ownKey = position.uri.toString();
	for (const ref of references) {
		if (ref.uri.toString() === ownKey && ref.line >= span.start && ref.line <= span.end) {
			continue; // the declaration itself, and recursion
		}
		const isImport = !!ref.preview && IMPORT_LINE.test(ref.preview);
		note(ref.uri, isImport ? 'imports' : 'uses', isImport ? [] : [ref.line], ref.uri.toString() === ownKey ? 0 : 1);
	}
	for (const node of callers?.nodes ?? []) {
		if (node.level > 1) {
			// Its call sites are in the Callers list; here only the file counts.
			note(node.uri, 'calls it indirectly', [], node.level);
		}
	}
	for (const importer of moduleImporters ?? []) {
		if (!affected.has(importer.uri.toString())) {
			note(importer.uri, 'imports the file', [], 2);
		}
	}
	// Tests: affected test files, then tests that import an affected file or the definition's file.
	const tests = new Map<string, string>();
	for (const entry of affected.values()) {
		const path = displayPath(root, entry.uri);
		if (isTestPath(path)) {
			tests.set(path, entry.reasons.has('uses') ? 'uses it' : [...entry.reasons][0]);
		}
	}
	if (nav?.importers) {
		const sources = [position.uri, ...[...affected.values()].filter(entry => entry.level <= 1 && !isTestPath(displayPath(root, entry.uri))).sort((a, b) => a.level - b.level).map(entry => entry.uri)].slice(0, MAX_TEST_SOURCES);
		const found = await raceTimeout(Promise.all(sources.map(async source => ({ source, importers: await nav.importers!(root, source, 1).catch(() => undefined) ?? [] }))), Math.max(1_000, started + IMPACT_DEADLINE_MS - Date.now()));
		for (const { source, importers } of found ?? []) {
			for (const importer of importers) {
				if (isTestPath(importer.path) && !tests.has(importer.path)) {
					tests.set(importer.path, `imports ${displayPath(root, source)}`);
				}
			}
		}
	}
	// Errors the affected files have now (the language server's markers).
	const diagnosed = lsp ? [position.uri, ...[...affected.values()].filter(entry => entry.uri.toString() !== ownKey).sort((a, b) => a.level - b.level).map(entry => entry.uri)].slice(0, MAX_DIAGNOSED_FILES) : [];
	const errors = diagnosed.length ? await raceTimeout(host.diagnostics(diagnosed, 'error').catch(() => undefined), IMPACT_DIAGNOSTICS_MS) : undefined;

	const out: string[] = [];
	const where = `${displayPath(root, position.uri)}:${span.start}${span.end > span.start ? `-${span.end}` : ''}`;
	out.push(`Impact of ${name ? `\`${name}\`` : 'the symbol'} (${span.kind ? `${span.kind}, ` : ''}${where})${noLspNote(lsp)}:`);
	if (callers?.nodes.length) {
		const tops = callers.nodes.filter(node => node.top).length;
		out.push(`Callers, ${levels} level${levels === 1 ? '' : 's'}${tops ? ` (${tops} with no callers: entry points or used by name)` : ''}:\n${callers.nodes.map(node => `${'  '.repeat(node.level)}${node.label}${node.top ? '  [no callers]' : ''}`).join('\n')}${callers.cut ? '\n  [stopped early; ask callers from a deeper function for the rest]' : ''}`);
	} else if (callers) {
		out.push('Callers: none found by the language server.');
	}
	const imports = [...affected.values()].filter(entry => entry.reasons.has('imports')).length;
	const files = [...affected.values()].sort((a, b) => a.level - b.level || displayPath(root, a.uri).localeCompare(displayPath(root, b.uri)));
	const shownFiles = files.slice(0, MAX_IMPACT_FILES).map(entry => {
		const path = displayPath(root, entry.uri);
		const lines = [...entry.lines].sort((a, b) => a - b);
		const reasons = [...entry.reasons].filter(reason => reason !== 'uses' || !lines.length).join(', ');
		const uses = lines.length ? `uses ${lines.slice(0, 6).join(', ')}${lines.length > 6 ? ` (+${lines.length - 6})` : ''}` : '';
		return `  ${path}${isTestPath(path) ? ' [test]' : ''}  ${[reasons, uses].filter(Boolean).join('; ')}`;
	});
	out.push(`${references.length} reference${references.length === 1 ? '' : 's'}${byName}; ${affected.size} file${affected.size === 1 ? '' : 's'} affected${imports ? ` (${imports} import it)` : ''}${moduleImporters?.length ? `, ${moduleImporters.length} import its file` : ''}:${shownFiles.length ? `\n${shownFiles.join('\n')}` : ' none outside the declaration.'}${files.length > MAX_IMPACT_FILES ? `\n  [${files.length - MAX_IMPACT_FILES} more files]` : ''}`);
	out.push(tests.size ? `Tests to run (${tests.size}):\n${[...tests].slice(0, 25).map(([path, why]) => `  ${path}  (${why})`).join('\n')}` : 'Tests to run: none found that use it or import the affected files.');
	if (errors?.length) {
		out.push(`Errors now (${errors.length}):\n${errors.slice(0, 10).map(item => `  ${displayPath(root, item.uri)}:${item.line} ${item.message.split('\n')[0]}`).join('\n')}`);
	} else if (errors) {
		out.push(`Errors now: none in ${diagnosed.length} file${diagnosed.length === 1 ? '' : 's'} checked.`);
	}
	return text(out.join('\n\n'));
}

/** impact with a path and no symbol: who imports the file (and who imports those), the tests among them, its errors. */
async function moduleImpact(host: ICodeIntelHost, root: URI, uri: URI, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	if (!nav?.importers) {
		return fail('code_nav', 'impact of a whole file needs Volt\'s code index (Settings > Code Intelligence); name a symbol in it instead.');
	}
	const [importers, errors] = await Promise.all([
		nav.importers(root, uri, 2).catch(() => undefined),
		host.lspAllowed(uri) ? raceTimeout(host.diagnostics([uri], 'error').catch(() => undefined), IMPACT_DIAGNOSTICS_MS) : Promise.resolve(undefined),
	]);
	if (!importers) {
		return fail('code_nav', 'The code index could not answer (still indexing, or off). Try again shortly, or name a symbol in the file.');
	}
	const path = displayPath(root, uri);
	const direct = importers.filter(item => item.depth === 1);
	const indirect = importers.filter(item => item.depth === 2);
	const tests = importers.filter(item => isTestPath(item.path));
	const out = [`Impact of ${path} (by the import graph):`];
	out.push(direct.length ? `Imported by ${direct.length} file${direct.length === 1 ? '' : 's'}:\n${direct.slice(0, MAX_IMPACT_FILES).map(item => `  ${item.path}:${item.line}${item.names.length ? `  ${item.names.slice(0, 6).join(', ')}${item.names.length > 6 ? ', ...' : ''}` : ''}`).join('\n')}${direct.length > MAX_IMPACT_FILES ? `\n  [${direct.length - MAX_IMPACT_FILES} more]` : ''}` : 'Imported by no file in this project.');
	if (indirect.length) {
		out.push(`Through those, ${indirect.length} more: ${indirect.slice(0, 30).map(item => item.path).join(', ')}${indirect.length > 30 ? ', ...' : ''}`);
	}
	out.push(tests.length ? `Tests to run (${tests.length}): ${tests.slice(0, 25).map(item => item.path).join(', ')}` : 'Tests to run: none import it within two steps.');
	if (errors?.length) {
		out.push(`Errors now in ${path}:\n${errors.slice(0, 10).map(item => `  ${item.line}: ${item.message.split('\n')[0]}`).join('\n')}`);
	} else if (errors) {
		out.push(`Errors now: none in ${path}.`);
	}
	return text(out.join('\n\n'));
}

const MAX_STRUCTURAL_MATCHES = 60;

async function structuralSearch(root: URI, args: unknown, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const pattern = pickString(args, 'pattern', 'query');
	if (!pattern?.trim()) {
		return fail('code_nav', 'structural needs pattern: code with $X for one node and $$$ for any number, e.g. fetchUser($ID, $$$).');
	}
	if (!nav?.structural) {
		return fail('code_nav', 'Structural search runs in Volt\'s code index, which this window does not have.');
	}
	const path = pickString(args, 'path', 'file');
	const folder = path ? resolveWorkspaceUri(root, path) : undefined;
	if (path && !folder) {
		return fail('code_nav', 'path is outside the workspace.');
	}
	// glob: comma-separated; a leading ! skips files (`!**/*.test.*`).
	const globs = (pickString(args, 'glob') ?? '').split(',').map(glob => glob.trim()).filter(Boolean);
	const includes = globs.filter(glob => !glob.startsWith('!'));
	const excludes = globs.filter(glob => glob.startsWith('!')).map(glob => glob.slice(1));
	const rawWhere = (args as { where?: unknown } | undefined)?.where;
	const where = rawWhere && typeof rawWhere === 'object' ? Object.fromEntries(Object.entries(rawWhere).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
	const result = await nav.structural(root, {
		pattern,
		...(folder ? { folder } : {}),
		...(pickString(args, 'language', 'lang') ? { language: pickString(args, 'language', 'lang')! } : {}),
		...(includes.length ? { includes } : {}),
		...(excludes.length ? { excludes } : {}),
		...(where && Object.keys(where).length ? { where } : {}),
		maxMatches: Math.max(1, Math.min(200, pickNumber(args, 'limit', 'head_limit') ?? MAX_STRUCTURAL_MATCHES)),
	});
	if (typeof result === 'string') {
		return fail('code_nav', result);
	}
	if (!result.matches.length) {
		return text(`No code matches ${JSON.stringify(pattern)} (${result.scanned} file${result.scanned === 1 ? '' : 's'} parsed).`);
	}
	const byFile = new Map<string, IVoltCodeStructuralMatch[]>();
	for (const match of result.matches) {
		byFile.set(match.path, [...(byFile.get(match.path) ?? []), match]);
	}
	const lines = [...byFile].flatMap(([file, matches]) => [`${file}:`, ...matches.map(match => `  ${match.line}${match.endLine > match.line ? `-${match.endLine}` : ''}: ${match.text}${match.vars ? `  {${Object.entries(match.vars).map(([key, value]) => `${key}=${value}`).join(', ')}}` : ''}`)]);
	return text(`${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}${result.limitHit ? ' (more exist: narrow path or the pattern)' : ''}:\n${lines.join('\n')}`);
}

//#endregion

export async function runCodeAction(host: ICodeIntelHost, root: URI | undefined, args: unknown, write: CodeEditWriter, ctx: IToolContext): Promise<IToolResult> {
	const op = pickString(args, 'op', 'operation') ?? '';
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file'));
	if (!uri || !root) {
		return fail('code_action', 'path is missing or outside the workspace.');
	}
	if (!host.lspAllowed(uri)) {
		return fail('code_action', 'Language servers are off for this checkout (Settings > Code Intelligence). Edit the files directly.');
	}
	const line = pickNumber(args, 'line');
	const range: ICodeRange | undefined = line ? { startLine: line, endLine: pickNumber(args, 'end_line') ?? line } : undefined;
	const kind = normalizeKind(pickString(args, 'kind'));
	try {
		switch (op) {
			case 'rename': {
				const newName = pickString(args, 'new_name', 'newName', 'to');
				if (!newName) {
					return fail('code_action', 'rename needs new_name.');
				}
				const position = await resolvePosition(host, root, uri, args, true);
				if (typeof position === 'string' || !position.column) {
					return fail('code_action', typeof position === 'string' ? position : 'Pass column or symbol.');
				}
				const changes = await host.rename!(uri, position.line, position.column, newName);
				return applyChanges(root, `Renamed ${position.name ?? where(root, position)} to ${newName}`, changes, write, ctx);
			}
			case 'format': {
				const changes = host.format ? await host.format(uri) : 'No formatter for this file.';
				return applyChanges(root, `Formatted ${displayPath(root, uri)}`, changes, write, ctx, `${displayPath(root, uri)} is already formatted.`);
			}
			case 'organize_imports': {
				const changes = host.applyCodeAction ? await host.applyCodeAction(uri, wholeFile(range), 'source.organizeImports', undefined) : 'No organize-imports action for this file.';
				return applyChanges(root, `Organized imports in ${displayPath(root, uri)}`, changes, write, ctx, `Imports in ${displayPath(root, uri)} are already organized.`);
			}
			case 'fixes': {
				const fixes = host.codeActions ? await host.codeActions(uri, wholeFile(range), kind) : [];
				if (!fixes.length) {
					return text(`No ${kind ?? 'quick fixes or refactors'} offered at ${displayPath(root, uri)}${range ? `:${range.startLine}` : ''}.`, 'code_action');
				}
				const lines = fixes.slice(0, 40).map((fix, index) => `${index + 1}. ${fix.title}${fix.kind ? ` [${fix.kind}]` : ''}${fix.preferred ? ' (preferred)' : ''}${fix.fixes ? ` - fixes: ${fix.fixes}` : ''}${fix.disabled ? ` - unavailable: ${fix.disabled}` : ''}`);
				return text(`${fixes.length} action${fixes.length === 1 ? '' : 's'} at ${displayPath(root, uri)}${range ? `:${range.startLine}` : ''}:\n${lines.join('\n')}\nApply one with op fix and part of its title.`, 'code_action');
			}
			case 'fix': {
				if (!range) {
					return fail('code_action', 'fix needs line (the line of the problem).');
				}
				const changes = host.applyCodeAction ? await host.applyCodeAction(uri, range, kind ?? 'quickfix', pickString(args, 'title')) : 'No code actions for this file.';
				return applyChanges(root, `Applied the fix at ${displayPath(root, uri)}:${range.startLine}`, changes, write, ctx);
			}
		}
		return fail('code_action', `op must be one of ${CODE_ACTION_OPS.join(', ')}.`);
	} catch (err) {
		return fail('code_action', errorText(err));
	}
}

async function applyChanges(root: URI, title: string, changes: readonly ITextFileChange[] | string, write: CodeEditWriter, ctx: IToolContext, unchanged?: string): Promise<IToolResult> {
	if (typeof changes === 'string') {
		return fail('code_action', changes);
	}
	const real = changes.filter(change => change.before !== change.after);
	if (!real.length) {
		return text(unchanged ?? 'The language server returned no changes.', 'code_action');
	}
	// All or nothing inside the project: a rename reached through a symlinked package (node_modules
	// linked to another checkout) would edit that checkout, and a sandboxed chat may write only here.
	const outside = real.filter(change => !insideRoot(change.uri, root));
	if (outside.length) {
		return fail('code_action', `${title} was not applied: it would also change ${outside.length} file${outside.length === 1 ? '' : 's'} outside this project (${outside.slice(0, 5).map(change => change.uri.fsPath).join(', ')}${outside.length > 5 ? ', ...' : ''}). Nothing was changed. Rename the declaration in this project only, or edit the files directly.`);
	}
	const parts: string[] = [];
	let added = 0;
	let removed = 0;
	for (const change of real) {
		const hunk = await write(change, ctx);
		added += hunk.added;
		removed += hunk.removed;
		parts.push(`${displayPath(root, change.uri)} +${hunk.added} -${hunk.removed}${real.length <= 4 ? `\n${hunk.text}` : ''}`);
	}
	return { callId: '', name: 'code_action', kind: 'edit', text: `${title}: ${real.length} file${real.length === 1 ? '' : 's'}, +${added} -${removed} lines.\n${parts.join('\n')}` };
}

/** Inside `root`, also when one of them is named through macOS's `/tmp` or `/var` link (language servers report real paths). */
function insideRoot(uri: URI, root: URI): boolean {
	const alias = (path: string) => path.startsWith('/private/') ? path.slice('/private'.length) : /^\/(?:tmp|var|etc)\//.test(path) ? `/private${path}` : path;
	return isEqualOrParent(uri, root) || isEqualOrParent(uri.with({ path: alias(uri.path) }), root);
}

function wholeFile(range: ICodeRange | undefined): ICodeRange {
	return range ?? { startLine: 1, endLine: Number.MAX_SAFE_INTEGER };
}

function normalizeKind(kind: string | undefined): string | undefined {
	const value = kind?.trim().toLowerCase().replace(/_/g, '');
	if (!value) {
		return undefined;
	}
	return value === 'quickfix' || value === 'fix' ? 'quickfix' : value === 'organizeimports' ? 'source.organizeImports' : kind!.trim();
}

function where(root: URI, position: IResolvedPosition): string {
	return `${displayPath(root, position.uri)}:${position.line}${position.column ? `:${position.column}` : ''}`;
}

function noLspNote(lsp: boolean): string {
	return lsp ? '' : ' (language servers are off for this checkout)';
}

/**
 * Locations grouped by file, like grep's output: the path once, then `line: text` per location.
 * One `path:line:col` line per location repeated a 60-character path per reference.
 */
function locations(root: URI, label: string, found: readonly ICodeLocation[], note: string): IToolResult {
	const shown = found.slice(0, MAX_LOCATIONS);
	const groups = groupByFile(root, shown);
	const lines = groups.length === shown.length
		? shown.map(location => `${displayPath(root, location.uri)}:${location.line}${location.preview ? `  ${location.preview}` : ''}`)
		: groups.flatMap(([file, refs]) => [`${file}:`, ...refs.map(location => `  ${location.line}${location.preview ? `: ${location.preview}` : ''}`)]);
	const more = found.length > MAX_LOCATIONS ? `\n[${found.length - MAX_LOCATIONS} more]` : '';
	const noun = label === 'references' ? 'reference' : label;
	return text(`${found.length} ${noun}${found.length === 1 ? '' : 's'}${groups.length > 1 ? ` in ${new Set(found.map(location => location.uri.toString())).size} files` : ''}${note}:\n${lines.join('\n')}${more}`);
}

function text(value: string, name = 'code_nav'): IToolResult {
	return { callId: '', name, kind: name === 'code_action' ? 'edit' : 'search', text: value };
}

function fail(name: string, value: string): IToolResult {
	return { callId: '', name, kind: name === 'diagnostics' ? 'read' : name === 'code_action' ? 'edit' : 'search', text: value, isError: true };
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
