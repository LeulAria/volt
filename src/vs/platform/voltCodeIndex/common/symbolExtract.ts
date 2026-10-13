/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltCodeSymbolKind } from './voltCodeIndex.js';

/**
 * Declarations found with one regex pass per language, the way ctags and Aider's repo map
 * do it: no parser, no language server, a few milliseconds per file. Good enough to answer
 * "where is X defined" across a whole repo instantly; `code_nav` with a language server stays
 * the precise answer.
 */

export const SYMBOL_KINDS: readonly VoltCodeSymbolKind[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'constant', 'module', 'struct', 'trait', 'macro', 'field'];

const KIND_INDEX = new Map(SYMBOL_KINDS.map((kind, index) => [kind, index]));

export interface IExtractedSymbol {
	readonly name: string;
	readonly kind: number;
	/** 1-based. */
	readonly line: number;
}

interface IRule {
	readonly re: RegExp;
	/** The kind, or a function of the keyword captured in group 1. */
	readonly kind: VoltCodeSymbolKind | ((keyword: string) => VoltCodeSymbolKind | undefined);
	/** Capture group holding the name. */
	readonly name: number;
}

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'function', 'else', 'do', 'try', 'with', 'await', 'yield', 'typeof', 'delete', 'void', 'in', 'of', 'super', 'this', 'constructor', 'get', 'set', 'static', 'async']);

function keywordKind(keyword: string): VoltCodeSymbolKind | undefined {
	switch (keyword) {
		case 'function': case 'function*': case 'fn': case 'func': case 'def': case 'fun': case 'sub': return 'function';
		case 'class': case 'object': case 'record': return 'class';
		case 'interface': case 'protocol': return 'interface';
		case 'type': case 'typealias': return 'type';
		case 'enum': return 'enum';
		case 'struct': case 'union': return 'struct';
		case 'trait': case 'impl': case 'extension': return 'trait';
		case 'namespace': case 'module': case 'mod': case 'package': return 'module';
		case 'const': case 'static': case 'final': return 'constant';
		case 'let': case 'var': case 'val': return 'variable';
		case 'macro_rules!': case 'define': return 'macro';
		default: return undefined;
	}
}

const TS: IRule[] = [
	{ re: /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(function\*?|class|interface|type|enum|namespace|module)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: keywordKind, name: 2 },
	{ re: /^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm, kind: keyword => keyword === 'const' ? 'constant' : 'variable', name: 2 },
	// Class members: `  async foo(`, `  private readonly bar = `, `  static baz<T>(`.
	{ re: /^[ \t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|get|set|accessor)[ \t]+)*([A-Za-z_$#][\w$]*)[ \t]*(?:<[^>\n]*>)?[ \t]*\([^)\n]*\)?[ \t]*(?::[^{;\n=]+)?[ \t]*\{[ \t]*$/gm, kind: 'method', name: 1 },
];

const PY: IRule[] = [
	{ re: /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/gm, kind: keyword => keyword === 'class' ? 'class' : 'function', name: 2 },
	{ re: /^([A-Z_][A-Z0-9_]*)[ \t]*(?::[^=\n]+)?=[^=]/gm, kind: 'constant', name: 1 },
];

const GO: IRule[] = [
	{ re: /^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/gm, kind: 'function', name: 1 },
	{ re: /^type[ \t]+([A-Za-z_]\w*)[ \t]+(struct|interface)?/gm, kind: 'type', name: 1 },
	{ re: /^[ \t]*(?:const|var)[ \t]+([A-Za-z_]\w*)/gm, kind: 'variable', name: 1 },
];

const RUST: IRule[] = [
	{ re: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:(?:async|unsafe|const|extern(?:[ \t]+"[^"]*")?|default)[ \t]+)*(fn|struct|enum|trait|type|mod|union|const|static|macro_rules!)[ \t]*([A-Za-z_]\w*)/gm, kind: keywordKind, name: 2 },
	{ re: /^[ \t]*impl(?:<[^>\n]*>)?[ \t]+(?:[\w:<>, ]+[ \t]+for[ \t]+)?([A-Za-z_]\w*)/gm, kind: 'trait', name: 1 },
];

const JVM: IRule[] = [
	{ re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|inline|value|enum|annotation|companion|partial|readonly|ref|unsafe|new|override|virtual|async|export|expect|actual)[ \t]+)*(class|interface|enum|record|struct|object|protocol|extension|typealias|fun|func|def|val|var|let|namespace)[ \t]+([A-Za-z_]\w*)/gm, kind: keywordKind, name: 2 },
	{ re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|unsafe|extern|new|sealed|default)[ \t]+)+[\w<>[\],.? ]+?[ \t]+([A-Za-z_]\w*)[ \t]*\([^;]*$/gm, kind: 'method', name: 1 },
];

const C: IRule[] = [
	{ re: /^[ \t]*(?:typedef[ \t]+)?(class|struct|enum|union|namespace)[ \t]+([A-Za-z_]\w*)[^;]*$/gm, kind: keywordKind, name: 2 },
	{ re: /^#[ \t]*(define)[ \t]+([A-Za-z_]\w*)/gm, kind: keywordKind, name: 2 },
	{ re: /^(?:[A-Za-z_][\w:<>*&, ]*[ \t*&]+)([A-Za-z_][\w:~]*)[ \t]*\([^;]*$/gm, kind: 'function', name: 1 },
];

const RUBY: IRule[] = [
	{ re: /^[ \t]*(def)[ \t]+(?:self\.)?([A-Za-z_][\w?!=]*)/gm, kind: 'function', name: 2 },
	{ re: /^[ \t]*(class|module)[ \t]+([A-Z][\w:]*)/gm, kind: keywordKind, name: 2 },
];

const PHP: IRule[] = [
	{ re: /^[ \t]*(?:(?:public|private|protected|static|final|abstract)[ \t]+)*(function|class|interface|trait|enum)[ \t]+&?([A-Za-z_]\w*)/gm, kind: keywordKind, name: 2 },
];

const LUA: IRule[] = [
	{ re: /^[ \t]*(?:local[ \t]+)?function[ \t]+([A-Za-z_][\w.:]*)/gm, kind: 'function', name: 1 },
];

const SHELL: IRule[] = [
	{ re: /^[ \t]*(?:function[ \t]+)?([A-Za-z_][\w-]*)[ \t]*\(\)[ \t]*\{/gm, kind: 'function', name: 1 },
];

const ELIXIR: IRule[] = [
	{ re: /^[ \t]*(defmodule|defp?|defmacrop?)[ \t]+([A-Za-z_][\w.?!]*)/gm, kind: keyword => keyword === 'defmodule' ? 'module' : keyword.startsWith('defmacro') ? 'macro' : 'function', name: 2 },
];

const BY_EXTENSION: Record<string, IRule[]> = {
	ts: TS, tsx: TS, mts: TS, cts: TS, js: TS, jsx: TS, mjs: TS, cjs: TS, vue: TS, svelte: TS, astro: TS,
	py: PY, pyi: PY,
	go: GO,
	rs: RUST,
	java: JVM, kt: JVM, kts: JVM, scala: JVM, cs: JVM, swift: JVM, dart: JVM, groovy: JVM,
	c: C, h: C, cc: C, cpp: C, cxx: C, hh: C, hpp: C, hxx: C, m: C, mm: C,
	rb: RUBY,
	php: PHP,
	lua: LUA,
	sh: SHELL, bash: SHELL, zsh: SHELL,
	ex: ELIXIR, exs: ELIXIR,
};

export function hasSymbolRules(path: string): boolean {
	return !!rulesFor(path);
}

function rulesFor(path: string): IRule[] | undefined {
	const dot = path.lastIndexOf('.');
	return dot >= 0 ? BY_EXTENSION[path.slice(dot + 1).toLowerCase()] : undefined;
}

/** Declarations in `text`, one per name and line. Lines over 1,000 chars (minified code) are skipped. */
export function extractSymbols(path: string, text: string, max = 2_000): IExtractedSymbol[] {
	const rules = rulesFor(path);
	if (!rules || text.length > 512 * 1024) {
		return [];
	}
	const out: IExtractedSymbol[] = [];
	const seen = new Set<string>();
	// Line numbers by offset, computed once. Generated or minified files (very long lines)
	// are skipped: they declare nothing worth finding and make the line rules slow.
	const starts: number[] = [0];
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
		if (i + 1 - starts[starts.length - 1] > 4_000) {
			return [];
		}
		starts.push(i + 1);
	}
	if (text.length - starts[starts.length - 1] > 4_000) {
		return [];
	}
	const lineOf = (offset: number) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (starts[mid] <= offset) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return lo + 1;
	};
	for (const rule of rules) {
		rule.re.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = rule.re.exec(text)) && out.length < max) {
			if (match[0].length === 0) {
				rule.re.lastIndex++;
				continue;
			}
			const name = match[rule.name];
			if (!name || NOT_NAMES.has(name) || name.length > 120) {
				continue;
			}
			const line = lineOf(match.index + (match[0].length - match[0].trimStart().length));
			const lineEnd = starts[line] ?? text.length;
			if (lineEnd - starts[line - 1] > 1_000) {
				continue;
			}
			const kind = typeof rule.kind === 'function' ? rule.kind(match[1] ?? '') : rule.kind;
			if (!kind) {
				continue;
			}
			const key = `${name}:${line}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			out.push({ name, kind: KIND_INDEX.get(kind) ?? 0, line });
		}
	}
	return out;
}
