/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodeFs from 'fs';
import { existsSync, promises as fs, readFileSync } from 'fs';
import * as nodeUrl from 'url';
import { FileAccess, nodeModulesAsarPath, nodeModulesAsarUnpackedPath, nodeModulesPath } from '../../../base/common/network.js';
import * as paths from '../../../base/common/path.js';
import { join } from '../../../base/common/path.js';
import type { IVoltCodeOutlineSymbol, VoltCodeSymbolKind } from '../common/voltCodeIndex.js';

/**
 * Syntax trees for the code index, from the tree-sitter grammars VS Code already ships
 * (`@vscode/tree-sitter-wasm`): exact declaration ranges, import statements and structural
 * matches without a language server. Parsing is a few milliseconds per file, so it runs on demand
 * for the files a question needs, never over the whole repository.
 */

/** The parts of web-tree-sitter (`@vscode/tree-sitter-wasm`, loaded at runtime) used here. */
interface IPoint {
	readonly row: number;
	readonly column: number;
}

interface SyntaxNode {
	readonly type: string;
	readonly text: string;
	readonly isNamed: boolean;
	readonly hasError: boolean;
	readonly startPosition: IPoint;
	readonly endPosition: IPoint;
	readonly parent: SyntaxNode | null;
	readonly firstChild: SyntaxNode | null;
	readonly children: (SyntaxNode | null)[];
	readonly namedChildren: (SyntaxNode | null)[];
	readonly namedChildCount: number;
	childForFieldName(name: string): SyntaxNode | null;
	childrenForFieldName(name: string): (SyntaxNode | null)[];
	descendantsOfType(types: string | string[]): (SyntaxNode | null)[];
	walk(): ITreeCursor;
}

interface ITreeCursor {
	readonly currentNode: SyntaxNode;
	gotoFirstChild(): boolean;
	gotoNextSibling(): boolean;
	gotoParent(): boolean;
	delete(): void;
}

interface ITree {
	readonly rootNode: SyntaxNode;
	delete(): void;
}

type ILanguage = object;

interface IQuery {
	matches(node: SyntaxNode): { readonly captures: { readonly name: string; readonly node: SyntaxNode }[] }[];
}

interface IParser {
	setLanguage(language: ILanguage): void;
	parse(text: string): ITree | null;
}

interface TS {
	readonly Parser: { init(options: { locateFile: (file: string, folder: string) => string }): Promise<void>; new(): IParser };
	readonly Language: { load(bytes: Uint8Array): Promise<ILanguage> };
	readonly Query: new (language: ILanguage, source: string) => IQuery;
}

export interface IParsedImport {
	readonly specifier: string;
	/** 1-based. */
	readonly line: number;
	readonly names: readonly string[];
}

export interface IParsedFile {
	readonly language: string;
	readonly symbols: readonly IVoltCodeOutlineSymbol[];
	readonly imports: readonly IParsedImport[];
}

export interface IStructuralHit {
	/** 1-based. */
	readonly line: number;
	readonly endLine: number;
	readonly text: string;
	readonly vars?: Record<string, string>;
}

const GRAMMAR_BY_EXTENSION: Record<string, string> = {
	ts: 'typescript', mts: 'typescript', cts: 'typescript',
	tsx: 'tsx',
	js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
	py: 'python', pyi: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	cs: 'c-sharp',
	c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp',
	rb: 'ruby',
};

export const STRUCTURE_LANGUAGES: readonly string[] = [...new Set(Object.values(GRAMMAR_BY_EXTENSION))];

/** The grammar for a path, by extension; undefined when there is none. */
export function grammarFor(path: string): string | undefined {
	const dot = path.lastIndexOf('.');
	return dot >= 0 ? GRAMMAR_BY_EXTENSION[path.slice(dot + 1).toLowerCase()] : undefined;
}

/** Extensions whose files a grammar parses (`javascript` also matches TypeScript files' JS siblings). */
export function extensionsOf(grammar: string): string[] {
	return Object.entries(GRAMMAR_BY_EXTENSION).filter(([, value]) => value === grammar || (grammar === 'typescript' && value === 'tsx') || (grammar === 'tsx' && value === 'typescript')).map(([extension]) => extension);
}

/** Files over this size are not parsed (generated bundles, data). */
export const MAX_PARSE_BYTES = 1024 * 1024;

//#region Loading

const MODULE_SUBPATH = '@vscode/tree-sitter-wasm/wasm';

/** The grammar folder: unpacked next to the asar in a built app, `node_modules` in a dev build. */
function wasmFolder(): string | undefined {
	for (const base of [nodeModulesAsarUnpackedPath, nodeModulesPath, nodeModulesAsarPath]) {
		const folder = FileAccess.asFileUri(`${base}/${MODULE_SUBPATH}`).fsPath;
		if (existsSync(join(folder, 'tree-sitter.wasm'))) {
			return folder;
		}
	}
	return undefined;
}

/** The Node modules `tree-sitter.js` asks for (it reads its wasm files with them). */
function requireForTreeSitter(id: string): unknown {
	switch (id) {
		case 'fs': return nodeFs;
		case 'fs/promises': return nodeFs.promises;
		case 'url': return nodeUrl;
		case 'path': return paths;
	}
	throw new Error(`tree-sitter asked for ${id}`);
}

/**
 * `tree-sitter.js` is a UMD bundle whose CommonJS branch drops its exports (VS Code loads it as
 * AMD), so it is run here with an AMD `define` that keeps them.
 */
function loadBindings(folder: string): TS {
	const file = join(folder, 'tree-sitter.js');
	let exports: TS | undefined;
	const define = Object.assign((_deps: unknown, factory: () => TS) => { exports = factory(); }, { amd: true });
	// Not `vm`: the code index also loads in Electron renderers (unit tests), where `vm` crashes.
	const wrapper = new Function('define', 'exports', 'module', 'require', '__filename', `${readFileSync(file, 'utf8')}\n//# sourceURL=${file}`) as (define: unknown, exports: undefined, module: undefined, require: NodeJS.Require, filename: string) => void;
	wrapper(define, undefined, undefined, requireForTreeSitter as NodeJS.Require, file);
	if (!exports) {
		throw new Error('tree-sitter did not load');
	}
	return exports;
}

export class TreeSitterParsers {

	private bindings: Promise<{ ts: TS; folder: string } | undefined> | undefined;
	private readonly languages = new Map<string, Promise<ILanguage | undefined>>();
	private parser: IParser | undefined;
	private readonly queries = new Map<string, IQuery | null>();

	constructor(private readonly folder: string | undefined = wasmFolder()) { }

	private load(): Promise<{ ts: TS; folder: string } | undefined> {
		this.bindings ??= (async () => {
			const folder = this.folder;
			if (!folder) {
				return undefined;
			}
			const ts = loadBindings(folder);
			await ts.Parser.init({ locateFile: () => join(folder, 'tree-sitter.wasm') });
			return { ts, folder };
		})().catch(() => undefined);
		return this.bindings;
	}

	async language(grammar: string): Promise<ILanguage | undefined> {
		let language = this.languages.get(grammar);
		if (!language) {
			language = this.load().then(async loaded => loaded ? loaded.ts.Language.load(await fs.readFile(join(loaded.folder, `tree-sitter-${grammar}.wasm`))) : undefined).catch(() => undefined);
			this.languages.set(grammar, language);
		}
		return language;
	}

	/** Parses `text` and hands the tree to `use`; the tree is freed afterwards. */
	async withTree<T>(grammar: string, text: string, use: (root: SyntaxNode, language: ILanguage) => T): Promise<T | undefined> {
		const [loaded, language] = await Promise.all([this.load(), this.language(grammar)]);
		if (!loaded || !language || text.length > MAX_PARSE_BYTES) {
			return undefined;
		}
		this.parser ??= new loaded.ts.Parser();
		this.parser.setLanguage(language);
		const tree = this.parser.parse(text);
		if (!tree) {
			return undefined;
		}
		try {
			return use(tree.rootNode, language);
		} finally {
			tree.delete();
		}
	}

	/** A compiled query, or null when this grammar has no such node types. */
	async query(grammar: string, source: string): Promise<IQuery | null> {
		const key = `${grammar}\0${source}`;
		if (!this.queries.has(key)) {
			const [loaded, language] = await Promise.all([this.load(), this.language(grammar)]);
			let query: IQuery | null = null;
			try {
				query = loaded && language ? new loaded.ts.Query(language, source) : null;
			} catch {
				query = null;
			}
			this.queries.set(key, query);
		}
		return this.queries.get(key) ?? null;
	}

	/** Declarations and imports of a file; undefined when it has no grammar or cannot be parsed. */
	async parse(path: string, text: string): Promise<IParsedFile | undefined> {
		const grammar = grammarFor(path);
		if (!grammar) {
			return undefined;
		}
		const queries = await Promise.all((IMPORT_QUERIES[grammar] ?? []).map(source => this.query(grammar, source)));
		return this.withTree(grammar, text, root => ({
			language: grammar,
			symbols: outlineOf(grammar, root),
			imports: importsOf(grammar, root, queries.filter((query): query is IQuery => !!query)),
		}));
	}

	/** Places in `text` shaped like `pattern` (see {@link IVoltCodeStructuralRequest.pattern}). */
	async match(grammar: string, pattern: string, text: string, max: number): Promise<IStructuralHit[] | string> {
		// The pattern's tree must outlive the search: its nodes point into it.
		const [loaded, language] = await Promise.all([this.load(), this.language(grammar)]);
		if (!loaded || !language || text.length > MAX_PARSE_BYTES) {
			return [];
		}
		this.parser ??= new loaded.ts.Parser();
		this.parser.setLanguage(language);
		const patternTree = this.parser.parse(metaToIdentifiers(grammar, pattern));
		if (!patternTree) {
			return `The pattern is not valid ${grammar}.`;
		}
		try {
			const compiled = patternRoot(patternTree.rootNode);
			if (typeof compiled === 'string') {
				return compiled;
			}
			const tree = this.parser.parse(text);
			if (!tree) {
				return [];
			}
			try {
				return findMatches(compiled, tree.rootNode, max);
			} finally {
				tree.delete();
			}
		} finally {
			patternTree.delete();
		}
	}
}

//#endregion

//#region Outline

type KindOf = VoltCodeSymbolKind | ((node: SyntaxNode) => VoltCodeSymbolKind | undefined);

/** Node types that declare something, per grammar, and the kind they declare. */
const DECLARATIONS: Record<string, Record<string, KindOf>> = {
	typescript: {
		function_declaration: 'function', generator_function_declaration: 'function', function_signature: 'function',
		class_declaration: 'class', abstract_class_declaration: 'class', interface_declaration: 'interface',
		type_alias_declaration: 'type', enum_declaration: 'enum', internal_module: 'module', module: 'module',
		method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method',
		public_field_definition: fieldKind, property_signature: 'field', variable_declarator: variableKind, pair: pairKind,
	},
	python: { function_definition: inClass(/^class_definition$/), class_definition: 'class', assignment: pythonConstant },
	go: { function_declaration: 'function', method_declaration: 'method', type_spec: goType, const_spec: 'constant', var_spec: 'variable' },
	rust: {
		function_item: inClass(/^(impl_item|trait_item)$/), function_signature_item: 'method', struct_item: 'struct', enum_item: 'enum', union_item: 'struct', trait_item: 'trait',
		impl_item: 'trait', mod_item: 'module', type_item: 'type', const_item: 'constant', static_item: 'constant', macro_definition: 'macro',
	},
	java: {
		class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', record_declaration: 'class', annotation_type_declaration: 'interface',
		method_declaration: 'method', constructor_declaration: 'method', field_declaration: 'field',
	},
	'c-sharp': {
		class_declaration: 'class', interface_declaration: 'interface', struct_declaration: 'struct', enum_declaration: 'enum', record_declaration: 'class',
		method_declaration: 'method', constructor_declaration: 'method', property_declaration: 'field', namespace_declaration: 'module', file_scoped_namespace_declaration: 'module',
	},
	cpp: { function_definition: 'function', class_specifier: 'class', struct_specifier: 'struct', enum_specifier: 'enum', namespace_definition: 'module', union_specifier: 'struct' },
	ruby: { method: inClass(/^(class|module)$/), singleton_method: 'method', class: 'class', module: 'module' },
};
DECLARATIONS.tsx = DECLARATIONS.typescript;
DECLARATIONS.javascript = DECLARATIONS.typescript;

/** Bodies whose declarations are locals, not part of the outline. */
const FUNCTION_LIKE = new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'arrow_function', 'function_expression', 'function', 'generator_function',
	'function_definition', 'method_declaration', 'function_item', 'constructor_declaration', 'method', 'singleton_method', 'lambda']);

function fieldKind(node: SyntaxNode): VoltCodeSymbolKind {
	const value = node.childForFieldName('value');
	return value && /^(arrow_function|function_expression|function)$/.test(value.type) ? 'method' : 'field';
}

function variableKind(node: SyntaxNode): VoltCodeSymbolKind | undefined {
	const declaration = node.parent;
	// Only top-level (or exported) variables; a destructuring pattern declares no single name.
	if (!declaration || node.childForFieldName('name')?.type !== 'identifier') {
		return undefined;
	}
	const value = node.childForFieldName('value');
	if (value && /^(arrow_function|function_expression|function|generator_function)$/.test(value.type)) {
		return 'function';
	}
	if (value?.type === 'class') {
		return 'class';
	}
	return declaration.firstChild?.text === 'const' ? 'constant' : 'variable';
}

/** A property of an object literal declared at the top: a router's procedures, a table of handlers. */
function pairKind(node: SyntaxNode): VoltCodeSymbolKind | undefined {
	const key = node.childForFieldName('key');
	if (!key || !/^(property_identifier|string|identifier)$/.test(key.type)) {
		return undefined;
	}
	const value = node.childForFieldName('value');
	return value && /^(arrow_function|function_expression|function|call_expression)$/.test(value.type) ? 'method' : 'field';
}

/** A function declared in a class (by the grammar's container types) is a method; nested in a function, a function. */
function inClass(containers: RegExp): (node: SyntaxNode) => VoltCodeSymbolKind {
	return node => {
		for (let parent = node.parent; parent; parent = parent.parent) {
			if (containers.test(parent.type)) {
				return 'method';
			}
			if (FUNCTION_LIKE.has(parent.type)) {
				return 'function';
			}
		}
		return 'function';
	};
}

function pythonConstant(node: SyntaxNode): VoltCodeSymbolKind | undefined {
	const left = node.childForFieldName('left');
	// Module-level UPPER_CASE names only.
	return node.parent?.type === 'expression_statement' && node.parent.parent?.type === 'module' && left?.type === 'identifier' && /^[A-Z_][A-Z0-9_]*$/.test(left.text) ? 'constant' : undefined;
}

function goType(node: SyntaxNode): VoltCodeSymbolKind {
	const type = node.childForFieldName('type')?.type;
	return type === 'struct_type' ? 'struct' : type === 'interface_type' ? 'interface' : 'type';
}

/** The declared name: the `name` field, else the declarator's (C/C++), else the first identifier. */
function nameOf(node: SyntaxNode): SyntaxNode | undefined {
	switch (node.type) {
		case 'assignment':
			return node.childForFieldName('left') ?? undefined;
		case 'pair':
			return node.childForFieldName('key') ?? undefined;
		case 'impl_item':
			return node.childForFieldName('type') ?? undefined;
		case 'field_declaration':
			return node.descendantsOfType('variable_declarator')[0]?.childForFieldName('name') ?? undefined;
	}
	const named = node.childForFieldName('name');
	if (named) {
		return named;
	}
	let declarator = node.childForFieldName('declarator');
	while (declarator && declarator.childForFieldName('declarator')) {
		declarator = declarator.childForFieldName('declarator');
	}
	if (declarator) {
		return declarator;
	}
	return node.namedChildren.find(child => child && /identifier|^constant$|^name$/.test(child.type)) ?? undefined;
}

export function outlineOf(grammar: string, root: SyntaxNode): IVoltCodeOutlineSymbol[] {
	const table = DECLARATIONS[grammar];
	const out: IVoltCodeOutlineSymbol[] = [];
	if (!table) {
		return out;
	}
	const walk = (node: SyntaxNode, depth: number, container: string | undefined, inFunction: boolean, inObject: boolean) => {
		for (const child of node.namedChildren) {
			if (!child || out.length >= 5_000) {
				continue;
			}
			const declares = table[child.type];
			let kind: VoltCodeSymbolKind | undefined;
			if (declares && !(inFunction && child.type !== 'class_declaration' && child.type !== 'class_definition')) {
				// Pairs only count inside an object literal declared at the top (see pairKind).
				kind = child.type === 'pair' && !inObject ? undefined : typeof declares === 'function' ? declares(child) : declares;
			}
			const name = kind ? nameOf(child) : undefined;
			const text = name?.text.replace(/^['"`]|['"`]$/g, '');
			const functionLike = FUNCTION_LIKE.has(child.type);
			if (kind && name && text && text.length <= 120) {
				// A `const x = ...` spans its whole statement; doc comments are not part of the range.
				const range = child.type === 'variable_declarator' && child.parent ? child.parent : child;
				out.push({ name: text, kind, line: range.startPosition.row + 1, endLine: range.endPosition.row + 1, column: name.startPosition.column + 1, depth, ...(container ? { container } : {}) });
				const value = child.childForFieldName('value');
				// Members of a declared object literal (`export const router = { list: ..., get: ... }`).
				const object = value && (value.type === 'object' ? value : value.type === 'call_expression' || value.type === 'satisfies_expression' || value.type === 'as_expression' ? value.descendantsOfType('object')[0] : undefined);
				if ((child.type === 'variable_declarator' || child.type === 'pair') && object && depth < 2) {
					walk(object, depth + 1, text, false, true);
					continue;
				}
				walk(child, depth + 1, text, inFunction || functionLike, false);
				continue;
			}
			walk(child, depth, container, inFunction || functionLike, inObject && child.type === 'object');
		}
	};
	walk(root, 0, undefined, false, false);
	return out;
}

//#endregion

//#region Imports

/** Queries capturing an import's module (`@s`) on its statement (`@i`). */
const IMPORT_QUERIES: Record<string, readonly string[]> = {
	typescript: [
		'(import_statement source: (string (string_fragment) @s)) @i',
		'(export_statement source: (string (string_fragment) @s)) @i',
		'(call_expression function: (identifier) @f arguments: (arguments . (string (string_fragment) @s)) (#eq? @f "require")) @i',
		'(call_expression function: (import) arguments: (arguments . (string (string_fragment) @s))) @i',
	],
	python: [
		'(import_statement name: (dotted_name) @s) @i',
		'(import_statement name: (aliased_import name: (dotted_name) @s)) @i',
		'(import_from_statement module_name: (_) @s) @i',
	],
	go: ['(import_spec path: (interpreted_string_literal) @s) @i'],
	rust: ['(use_declaration argument: (_) @s) @i', '(mod_item name: (identifier) @s !body) @i'],
	java: ['(import_declaration (_) @s) @i'],
	'c-sharp': ['(using_directive (_) @s) @i'],
	cpp: ['(preproc_include path: (_) @s) @i'],
	ruby: ['(call method: (identifier) @f arguments: (argument_list . (string (string_content) @s)) (#match? @f "^(require|require_relative|load)$")) @i'],
};
IMPORT_QUERIES.tsx = IMPORT_QUERIES.typescript;
IMPORT_QUERIES.javascript = IMPORT_QUERIES.typescript;

function importedNames(grammar: string, statement: SyntaxNode): string[] {
	const names: string[] = [];
	if (grammar === 'typescript' || grammar === 'tsx' || grammar === 'javascript') {
		for (const node of statement.descendantsOfType(['import_specifier', 'export_specifier', 'namespace_import', 'namespace_export', 'import_clause'])) {
			if (!node) {
				continue;
			}
			if (node.type === 'import_clause') {
				const first = node.namedChildren[0];
				if (first?.type === 'identifier') {
					names.push('default');
				}
			} else if (node.type === 'namespace_import' || node.type === 'namespace_export') {
				names.push('*');
			} else {
				const name = node.childForFieldName('name')?.text;
				if (name) {
					names.push(name);
				}
			}
		}
		if (statement.type === 'export_statement' && !names.length) {
			names.push('*');
		}
	} else if (grammar === 'python' && statement.type === 'import_from_statement') {
		for (const child of statement.childrenForFieldName('name')) {
			const name = child?.type === 'aliased_import' ? child.childForFieldName('name')?.text : child?.text;
			if (name) {
				names.push(name);
			}
		}
		if (statement.descendantsOfType('wildcard_import').length) {
			names.push('*');
		}
	}
	return names;
}

export function importsOf(grammar: string, root: SyntaxNode, queries: readonly IQuery[]): IParsedImport[] {
	const out: IParsedImport[] = [];
	const seen = new Set<string>();
	for (const query of queries) {
		for (const match of query.matches(root)) {
			const source = match.captures.find(capture => capture.name === 's')?.node;
			const statement = match.captures.find(capture => capture.name === 'i')?.node ?? source;
			if (!source || !statement) {
				continue;
			}
			const specifier = source.text.replace(/^["'<`]|["'>`]$/g, '');
			const line = statement.startPosition.row + 1;
			const key = `${specifier}\0${line}`;
			if (!specifier || seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push({ specifier, line, names: importedNames(grammar, statement) });
		}
	}
	return out.sort((a, b) => a.line - b.line);
}

//#endregion

//#region Structural search

/** Grammars whose identifiers may not contain `$`: metavariables are spelled with a letter they allow. */
const DOLLAR_IDENTIFIERS = new Set(['typescript', 'tsx', 'javascript']);
const META_LETTER = '\u00b5';

/** `$X` as an identifier the grammar accepts, so the pattern parses as code. */
export function metaToIdentifiers(grammar: string, pattern: string): string {
	return DOLLAR_IDENTIFIERS.has(grammar) ? pattern : pattern.replace(/\$\$\$([A-Z_][A-Z0-9_]*)?|\$([A-Z_][A-Z0-9_]*)/g, (_all, many: string | undefined, one: string | undefined) => many !== undefined || one === undefined ? `${META_LETTER}${META_LETTER}${META_LETTER}${many ?? ''}` : `${META_LETTER}${one}`);
}

interface IMeta {
	readonly name: string;
	readonly many: boolean;
}

function metaOf(node: SyntaxNode): IMeta | undefined {
	const text = node.text;
	if (text.length > 64 || /\s/.test(text)) {
		return undefined;
	}
	const found = /^(?:\$|\u00b5)(?:(?:\$|\u00b5)(?:\$|\u00b5)([A-Z_][A-Z0-9_]*)?|([A-Z_][A-Z0-9_]*))$/.exec(text);
	if (!found) {
		return undefined;
	}
	return found[2] !== undefined ? { name: found[2], many: false } : { name: found[1] ?? '', many: true };
}

/** The node a pattern stands for: its single statement, or that statement's expression. */
function patternRoot(root: SyntaxNode): SyntaxNode | string {
	if (root.hasError) {
		return 'The pattern does not parse as code; write it as a complete expression or statement (e.g. foo($A, $$$) or if ($C) { $$$ }).';
	}
	let node: SyntaxNode = root;
	while (node.namedChildCount === 1 && /^(program|module|source_file|translation_unit|compilation_unit|expression_statement|global_statement)$/.test(node.type)) {
		node = node.namedChildren[0]!;
	}
	if (/^(program|module|source_file|translation_unit|compilation_unit)$/.test(node.type)) {
		return 'Write the pattern as one expression or statement.';
	}
	return node;
}

function significant(node: SyntaxNode): SyntaxNode[] {
	return node.children.filter((child): child is SyntaxNode => !!child && child.type !== 'comment' && !(child.type === ';' && !child.isNamed) && !(child.type === ',' && !child.isNamed));
}

function matchNode(pattern: SyntaxNode, node: SyntaxNode, vars: Map<string, string>): boolean {
	const meta = metaOf(pattern);
	if (meta && !meta.many) {
		const bound = vars.get(meta.name);
		if (meta.name !== '_' && bound !== undefined) {
			return bound === node.text;
		}
		vars.set(meta.name, node.text);
		return true;
	}
	// `foo($A)` written as a statement still matches the call inside a statement.
	if (pattern.type === 'expression_statement' && node.type !== 'expression_statement' && pattern.namedChildCount === 1) {
		return matchNode(pattern.namedChildren[0]!, node, vars);
	}
	if (pattern.type !== node.type) {
		return false;
	}
	const patternChildren = significant(pattern);
	if (!patternChildren.length) {
		return pattern.text === node.text;
	}
	return matchSequence(patternChildren, 0, significant(node), 0, vars);
}

function matchSequence(patterns: readonly SyntaxNode[], p: number, nodes: readonly SyntaxNode[], n: number, vars: Map<string, string>): boolean {
	if (p === patterns.length) {
		return n === nodes.length;
	}
	const meta = metaOf(patterns[p]);
	if (meta?.many) {
		for (let end = n; end <= nodes.length; end++) {
			const tried = new Map(vars);
			if (matchSequence(patterns, p + 1, nodes, end, tried)) {
				if (meta.name) {
					tried.set(meta.name, nodes.slice(n, end).map(node => node.text).join(', '));
				}
				copyInto(vars, tried);
				return true;
			}
		}
		return false;
	}
	if (n >= nodes.length) {
		return false;
	}
	const tried = new Map(vars);
	if (matchNode(patterns[p], nodes[n], tried) && matchSequence(patterns, p + 1, nodes, n + 1, tried)) {
		copyInto(vars, tried);
		return true;
	}
	return false;
}

function copyInto(target: Map<string, string>, source: Map<string, string>): void {
	for (const [key, value] of source) {
		target.set(key, value);
	}
}

export function findMatches(pattern: SyntaxNode, root: SyntaxNode, max: number): IStructuralHit[] {
	const out: IStructuralHit[] = [];
	const anyType = !!metaOf(pattern);
	const target = pattern.type === 'expression_statement' && pattern.namedChildCount === 1 ? pattern.namedChildren[0]!.type : pattern.type;
	const cursor = root.walk();
	let done = false;
	while (!done && out.length < max) {
		const node = cursor.currentNode;
		if (anyType || node.type === target || node.type === pattern.type) {
			const vars = new Map<string, string>();
			if (matchNode(pattern, node, vars)) {
				const named = [...vars].filter(([name]) => name && name !== '_');
				out.push({
					line: node.startPosition.row + 1,
					endLine: node.endPosition.row + 1,
					text: node.text.split('\n')[0].trim().slice(0, 160),
					...(named.length ? { vars: Object.fromEntries(named.map(([name, value]) => [name, value.length > 80 ? `${value.slice(0, 80)}\u2026` : value])) } : {}),
				});
				// Not inside a match: nested matches of the same pattern would repeat it.
				if (cursor.gotoNextSibling()) {
					continue;
				}
				while (true) {
					if (!cursor.gotoParent()) {
						done = true;
						break;
					}
					if (cursor.gotoNextSibling()) {
						break;
					}
				}
				continue;
			}
		}
		if (cursor.gotoFirstChild() || cursor.gotoNextSibling()) {
			continue;
		}
		while (true) {
			if (!cursor.gotoParent()) {
				done = true;
				break;
			}
			if (cursor.gotoNextSibling()) {
				break;
			}
		}
	}
	cursor.delete();
	return out;
}

//#endregion
