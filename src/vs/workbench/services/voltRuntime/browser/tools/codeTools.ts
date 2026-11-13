/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
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
}

/** Writes a computed edit into the workspace like edit_file does (buffers, ledger, change set). */
export type CodeEditWriter = (change: ITextFileChange, ctx: IToolContext) => Promise<{ readonly added: number; readonly removed: number; readonly text: string }>;

const MAX_DIAGNOSTICS = 100;
const MAX_LOCATIONS = 60;
const MAX_SYMBOLS = 80;
/** inspect shows a definition's body up to this many lines. */
const MAX_BODY_LINES = 40;

export const CODE_NAV_OPS = ['definition', 'references', 'implementations', 'type_definition', 'hover', 'inspect', 'symbols', 'workspace_symbols', 'callers', 'callees', 'supertypes', 'subtypes'] as const;
export type CodeNavOp = typeof CODE_NAV_OPS[number];

export const CODE_ACTION_OPS = ['rename', 'format', 'organize_imports', 'fixes', 'fix'] as const;

/** Positional ops: they need a line plus a column or the symbol's name. */
const POSITIONAL: ReadonlySet<string> = new Set(['definition', 'references', 'implementations', 'type_definition', 'hover', 'inspect', 'callers', 'callees', 'supertypes', 'subtypes']);

export const CODE_NAV_DESCRIPTION = [
	'Precise navigation from the language servers the editor runs (live, unsaved buffers included), with Volt\'s code index as fallback.',
	'Positional ops take path + line + symbol (the name as written on that line) or column:',
	'definition, references, implementations, type_definition, hover (type, signature, docs),',
	'inspect (hover + definition with its body + references by file + implementations, in one call: start here for an unfamiliar symbol),',
	'callers / callees (call hierarchy), supertypes / subtypes (type hierarchy).',
	'symbols: the outline of path. workspace_symbols: find symbols by name across the workspace (query).',
	'Use grep for text and strings, find_symbol for a name you know, this for meaning (who calls X, what implements Y, what type is Z).',
].join(' ');

export const CODE_NAV_SCHEMA = objectSchema({
	op: { type: 'string', enum: [...CODE_NAV_OPS] },
	path: { type: 'string' },
	line: { type: 'integer', description: '1-based line' },
	column: { type: 'integer', description: '1-based column' },
	symbol: { type: 'string', description: 'Symbol name on that line, instead of a column' },
	query: { type: 'string', description: 'workspace_symbols: the name to look for' },
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
}

async function resolvePosition(host: ICodeIntelHost, root: URI, uri: URI, args: unknown, lsp: boolean): Promise<IResolvedPosition | string> {
	const line = pickNumber(args, 'line');
	if (!line) {
		return 'This op needs line (and column or symbol).';
	}
	const symbol = pickString(args, 'symbol', 'name');
	const givenColumn = pickNumber(args, 'column', 'character');
	const name = symbol ?? (givenColumn ? await host.wordAt(uri, line, givenColumn) : undefined);
	const column = lsp ? givenColumn ?? (symbol ? await host.columnOf(uri, line, symbol) : undefined) : undefined;
	if (lsp && symbol && !column && !givenColumn) {
		return `"${symbol}" does not appear on line ${line} of ${displayPath(root, uri)}.`;
	}
	if (!column && !name) {
		return 'Pass column or symbol.';
	}
	return { uri, line, ...(column ? { column } : {}), ...(name ? { name } : {}) };
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
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file'));
	if (!uri) {
		return fail('code_nav', 'path is missing or outside the workspace.');
	}
	const lsp = host.lspAllowed(uri);
	try {
		if (op === 'symbols') {
			return outline(host, root, uri, lsp, nav);
		}
		if (!POSITIONAL.has(op)) {
			return fail('code_nav', `Unknown op ${op}.`);
		}
		const position = await resolvePosition(host, root, uri, args, lsp);
		if (typeof position === 'string') {
			return fail('code_nav', position);
		}
		switch (op) {
			case 'definition':
			case 'references':
				return navigate(host, root, op, position, nav, lsp);
			case 'implementations':
			case 'type_definition': {
				const ask = op === 'implementations' ? host.implementations : host.typeDefinitions;
				const found = position.column && ask ? await ask.call(host, uri, position.line, position.column) : [];
				if (found.length) {
					return locations(root, op === 'implementations' ? 'implementation' : 'type definition', found, '');
				}
				return text(`No ${op === 'implementations' ? 'implementations' : 'type definition'} reported for ${where(root, position)}${noLspNote(lsp)}.`);
			}
			case 'hover': {
				const hover = position.column && host.hover ? await host.hover(uri, position.line, position.column) : undefined;
				return text(hover ? `${where(root, position)}:\n${hover}` : `No type information at ${where(root, position)}${noLspNote(lsp)}.`);
			}
			case 'inspect':
				return inspect(host, root, position, nav, lsp);
			case 'callers':
			case 'callees':
				return callHierarchy(host, root, position, op, lsp);
			case 'supertypes':
			case 'subtypes':
				return typeHierarchy(host, root, position, op, lsp);
		}
	} catch (err) {
		return fail('code_nav', errorText(err));
	}
}

async function outline(host: ICodeIntelHost, root: URI, uri: URI, lsp: boolean, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const symbols = lsp ? await host.symbols(uri) : [];
	if (symbols.length) {
		const lines = symbols.slice(0, 300).map(symbol => `${'  '.repeat(symbol.depth)}${symbol.kind} ${symbol.name} [${symbol.line}-${symbol.endLine}]${symbol.detail ? ` ${symbol.detail}` : ''}`);
		return text(`${displayPath(root, uri)} outline:\n${lines.join('\n')}`);
	}
	const indexed = await nav?.outline(root, uri);
	if (indexed?.length) {
		const lines = indexed.slice(0, 300).map(symbol => `${symbol.kind} ${symbol.name} [${symbol.line}]`);
		return text(`${displayPath(root, uri)} outline${FROM_INDEX}:\n${lines.join('\n')}`);
	}
	return text(`No symbols reported for ${displayPath(root, uri)} (no language server, or an empty file).`);
}

const FROM_INDEX = ' (from the code index: matched by name, not type-checked)';

async function navigate(host: ICodeIntelHost, root: URI, op: 'definition' | 'references', position: IResolvedPosition, nav: ICodeNavIndex | undefined, lsp: boolean): Promise<IToolResult> {
	if (position.column) {
		const found = op === 'definition' ? await host.definitions(position.uri, position.line, position.column) : await host.references(position.uri, position.line, position.column);
		if (found.length) {
			return locations(root, op, found, '');
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
		column && host.implementations ? host.implementations(uri, line, column).catch(() => []) : [],
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
	const indexed = nav && /^[\w$]+$/.test(query.trim()) ? await nav.definitions(root, query.trim()) : undefined;
	if (indexed?.length) {
		return locations(root, 'definition', indexed, FROM_INDEX);
	}
	return text(`No symbols matching "${query}". Try grep or find_symbol with part of the name.`);
}

async function callHierarchy(host: ICodeIntelHost, root: URI, position: IResolvedPosition, op: 'callers' | 'callees', lsp: boolean): Promise<IToolResult> {
	const edges = position.column && host.calls ? await host.calls(position.uri, position.line, position.column, op === 'callers' ? 'incoming' : 'outgoing') : undefined;
	if (!edges) {
		return text(`No call hierarchy for ${where(root, position)}${noLspNote(lsp)}. ${op === 'callers' ? 'Use op references' : 'Read the function body'} instead.`);
	}
	if (!edges.length) {
		return text(op === 'callers' ? `Nothing calls ${where(root, position)}.` : `${where(root, position)} calls nothing the language server can resolve.`);
	}
	const lines = edges.slice(0, MAX_LOCATIONS).map(edge => `${edge.kind} ${edge.container ? `${edge.container}.` : ''}${edge.name}  ${displayPath(root, edge.uri)}:${edge.line}${edge.sites.length ? `  (${op === 'callers' ? 'calls at' : 'called at'} line${edge.sites.length === 1 ? '' : 's'} ${edge.sites.slice(0, 6).join(', ')})` : ''}`);
	return text(`${edges.length} ${op === 'callers' ? 'caller' : 'callee'}${edges.length === 1 ? '' : 's'} of ${position.name ?? where(root, position)}:\n${lines.join('\n')}${edges.length > MAX_LOCATIONS ? `\n[${edges.length - MAX_LOCATIONS} more]` : ''}`);
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

function locations(root: URI, label: string, found: readonly ICodeLocation[], note: string): IToolResult {
	const lines = found.slice(0, MAX_LOCATIONS).map(location => `${displayPath(root, location.uri)}:${location.line}:${location.column}${location.preview ? `  ${location.preview}` : ''}`);
	const more = found.length > MAX_LOCATIONS ? `\n[${found.length - MAX_LOCATIONS} more]` : '';
	const noun = label === 'references' ? 'reference' : label;
	return text(`${found.length} ${noun}${found.length === 1 ? '' : 's'}${note}:\n${lines.join('\n')}${more}`);
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
