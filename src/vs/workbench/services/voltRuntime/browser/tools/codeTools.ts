/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { asRecord, pickNumber, pickString } from '../../common/tools/args.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

/**
 * The editor's own language intelligence as tools. Diagnostics are the same errors the user sees
 * in the Problems view; navigation goes through the language servers the editor already runs.
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

const MAX_DIAGNOSTICS = 100;
const MAX_LOCATIONS = 60;

export function createCodeTools(host: ICodeIntelHost, root: () => URI | undefined, nav?: ICodeNavIndex): IVoltTool[] {
	return [
		{
			name: 'diagnostics',
			group: 'read',
			kind: 'read',
			parallelSafe: true,
			idempotent: true,
			snippet: 'diagnostics - compiler and linter errors from the editor',
			description: [
				'Errors and warnings from the editor\'s language services (type checker, linter) for the given files, or the whole workspace.',
				'Use right after editing to confirm the change type-checks; it is much faster than a full build.',
				'Only files the language service knows about are covered; a build or test run is still the final word.',
			].join(' '),
			schema: objectSchema({
				paths: { type: 'array', items: { type: 'string' }, description: 'Files to check (default: all open problems)' },
				severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Default error' },
			}, []),
			timeoutMs: 20_000,
			execute: async args => runDiagnostics(host, root(), args),
		},
		{
			name: 'code_nav',
			group: 'read',
			kind: 'search',
			parallelSafe: true,
			idempotent: true,
			snippet: 'code_nav - definition, references, or outline via the language server',
			description: [
				'Precise code navigation from the language server. op "definition": where a symbol is defined. op "references": every use of it.',
				'op "symbols": the outline of a file (classes, functions, methods with line ranges).',
				'Give the position as line plus either column or symbol (the name as written on that line).',
				'Prefer this over grep for "who calls X" and "where is X defined" in languages the editor understands.',
			].join(' '),
			schema: objectSchema({
				op: { type: 'string', enum: ['definition', 'references', 'symbols'] },
				path: { type: 'string' },
				line: { type: 'integer', description: '1-based line' },
				column: { type: 'integer', description: '1-based column' },
				symbol: { type: 'string', description: 'Symbol name on that line, instead of a column' },
			}, ['op', 'path']),
			timeoutMs: 30_000,
			execute: async args => runCodeNav(host, root(), args, nav),
		},
	];
}

async function runDiagnostics(host: ICodeIntelHost, root: URI | undefined, args: unknown): Promise<IToolResult> {
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
		return fail('diagnostics', err instanceof Error ? err.message : String(err));
	}
}

async function runCodeNav(host: ICodeIntelHost, root: URI | undefined, args: unknown, nav: ICodeNavIndex | undefined): Promise<IToolResult> {
	const op = pickString(args, 'op', 'operation');
	const uri = resolveWorkspaceUri(root, pickString(args, 'path', 'file'));
	if (!uri || !root) {
		return fail('code_nav', 'path is missing or outside the workspace.');
	}
	const lsp = host.lspAllowed(uri);
	const fromIndex = ' (from the code index: matched by name, not type-checked)';
	try {
		if (op === 'symbols') {
			const symbols = lsp ? await host.symbols(uri) : [];
			if (symbols.length) {
				const lines = symbols.slice(0, 300).map(symbol => `${'  '.repeat(symbol.depth)}${symbol.kind} ${symbol.name} [${symbol.line}-${symbol.endLine}]${symbol.detail ? ` ${symbol.detail}` : ''}`);
				return { callId: '', name: 'code_nav', kind: 'search', text: `${displayPath(root, uri)} outline:\n${lines.join('\n')}` };
			}
			const indexed = await nav?.outline(root, uri);
			if (indexed?.length) {
				const lines = indexed.slice(0, 300).map(symbol => `${symbol.kind} ${symbol.name} [${symbol.line}]`);
				return { callId: '', name: 'code_nav', kind: 'search', text: `${displayPath(root, uri)} outline${fromIndex}:\n${lines.join('\n')}` };
			}
			return { callId: '', name: 'code_nav', kind: 'search', text: `No symbols reported for ${displayPath(root, uri)} (no language server, or an empty file).` };
		}
		if (op !== 'definition' && op !== 'references') {
			return fail('code_nav', 'op must be definition, references, or symbols.');
		}
		const line = pickNumber(args, 'line');
		if (!line) {
			return fail('code_nav', `${op} needs line (and column or symbol).`);
		}
		const symbol = pickString(args, 'symbol', 'name');
		const givenColumn = pickNumber(args, 'column', 'character');
		const name = symbol ?? (givenColumn ? await host.wordAt(uri, line, givenColumn) : undefined);
		if (lsp) {
			const column = givenColumn ?? (symbol ? await host.columnOf(uri, line, symbol) : undefined);
			if (!column && !(nav && name)) {
				return fail('code_nav', symbol ? `"${symbol}" does not appear on line ${line} of ${displayPath(root, uri)}.` : 'Pass column or symbol.');
			}
			if (column) {
				const found = op === 'definition' ? await host.definitions(uri, line, column) : await host.references(uri, line, column);
				if (found.length) {
					return locations(root, op, found, '');
				}
			}
		}
		if (nav && name) {
			const found = op === 'definition' ? await nav.definitions(root, name) : await nav.references(root, name);
			if (found?.length) {
				return locations(root, op, found, fromIndex);
			}
		}
		return { callId: '', name: 'code_nav', kind: 'search', text: lsp ? `No ${op} found (the language server returned nothing for ${displayPath(root, uri)}:${line}${givenColumn ? `:${givenColumn}` : ''}).` : `No ${op} found for ${name ? JSON.stringify(name) : `${displayPath(root, uri)}:${line}`} (language servers are off for this checkout; pass symbol to look it up by name).` };
	} catch (err) {
		return fail('code_nav', err instanceof Error ? err.message : String(err));
	}
}

function locations(root: URI, op: 'definition' | 'references', found: readonly ICodeLocation[], note: string): IToolResult {
	const lines = found.slice(0, MAX_LOCATIONS).map(location => `${displayPath(root, location.uri)}:${location.line}:${location.column}${location.preview ? `  ${location.preview}` : ''}`);
	const more = found.length > MAX_LOCATIONS ? `\n[${found.length - MAX_LOCATIONS} more]` : '';
	return { callId: '', name: 'code_nav', kind: 'search', text: `${found.length} ${op === 'definition' ? 'definition' : 'reference'}${found.length === 1 ? '' : 's'}${note}:\n${lines.join('\n')}${more}` };
}

function fail(name: string, text: string): IToolResult {
	return { callId: '', name, kind: name === 'diagnostics' ? 'read' : 'search', text, isError: true };
}
