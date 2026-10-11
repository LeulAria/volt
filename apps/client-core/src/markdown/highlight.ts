/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A compact syntax highlighter for code in replies: line-based tokenizers with a little state
 * (block comments, multi-line strings), so a streaming code block re-tokenizes only its new
 * lines. Lines are cached by (language, state, text). Accurate enough to read like an editor,
 * small enough for a phone (no grammars, no WASM).
 */

export type TokenKind =
	| 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'function' | 'type' | 'constant' | 'operator' | 'punct'
	| 'tag' | 'attr' | 'property' | 'variable' | 'inserted' | 'deleted' | 'meta' | 'regex';

export interface IToken {
	readonly k: TokenKind;
	readonly v: string;
}

export type HighlightedLine = readonly IToken[];

interface ILangDef {
	readonly keywords: ReadonlySet<string>;
	readonly constants?: ReadonlySet<string>;
	readonly types?: ReadonlySet<string>;
	readonly builtins?: ReadonlySet<string>;
	readonly lineComments: readonly string[];
	readonly blockComment?: readonly [string, string];
	readonly quotes: readonly string[];
	/** Quotes whose strings may span lines (` in JS, """ in Python). */
	readonly multiline?: readonly string[];
	readonly caseInsensitive?: boolean;
	/** `$name` / `${name}` are variables (shell, PHP). */
	readonly dollarVars?: boolean;
	/** `@name` is an annotation or decorator. */
	readonly decorators?: boolean;
	/** A string or identifier followed by `:` is a key (JSON, YAML, CSS). */
	readonly keysBeforeColon?: boolean;
	/** `#` starts a comment only at the start of a word (shell). */
	readonly hashNeedsSpace?: boolean;
	/** The first word of a line is a command (shell, Dockerfile). */
	readonly commandFirst?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch throw try typeof var void while with yield let static enum await async implements package protected interface private public type namespace declare abstract readonly keyof infer satisfies as from of get set override');
const JS_CONSTANTS = words('true false null undefined NaN Infinity this');
const TS_TYPES = words('string number boolean any unknown never void object symbol bigint Record Partial Required Readonly Pick Omit Promise Array Map Set ReadonlyArray ReadonlyMap Date Error RegExp');
const C_FAMILY = words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while fun val var when object data sealed override open internal companion lateinit init is in out typealias func let guard struct protocol extension inout mutating operator rethrows defer repeat where Self some any async await namespace using virtual template typename auto unsigned signed sizeof union typedef extern register inline constexpr nullptr friend explicit mutable echo function fn match readonly yield include define pragma ifdef ifndef endif elif');
const C_CONSTANTS = words('true false null nil NULL nullptr self this super');
const C_TYPES = words('int long short char float double void bool boolean byte string String Int Long Double Float Bool Boolean Char Unit Any Object List Map Set Array size_t uint8_t uint32_t int32_t int64_t uint64_t');
const PY_KEYWORDS = words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case');
const PY_CONSTANTS = words('True False None self cls');
const PY_BUILTINS = words('print len range dict list set tuple str int float bool open isinstance super enumerate zip map filter sorted min max sum any all type object');
const GO_KEYWORDS = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var');
const GO_CONSTANTS = words('true false nil iota');
const GO_TYPES = words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any');
const RUST_KEYWORDS = words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while');
const RUST_CONSTANTS = words('true false None Some Ok Err self Self');
const RUST_TYPES = words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet');
const RUBY_KEYWORDS = words('def end if elsif else unless while until for in do return class module begin rescue ensure raise require include extend attr_accessor attr_reader puts lambda proc then case when and or not yield alias');
const SHELL_KEYWORDS = words('if then else elif fi for do done case esac while until function in return export local readonly set unset shift break continue select time');
const SQL_KEYWORDS = words('select from where insert update delete join left right inner outer full cross on group by order having limit offset create table alter drop index primary key foreign references not null default values into set as and or in is like ilike between exists union all distinct case when then else end returning with begin commit rollback transaction view trigger function procedure if replace unique check constraint cascade asc desc count sum avg min max coalesce grant revoke');
const DOCKER_KEYWORDS = words('from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as');
const LUA_KEYWORDS = words('and break do else elseif end for function goto if in local not or repeat return then until while');

const LANGS: Record<string, ILangDef> = {
	js: { keywords: JS_KEYWORDS, constants: JS_CONSTANTS, lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"', '\'', '`'], multiline: ['`'], decorators: true },
	ts: { keywords: JS_KEYWORDS, constants: JS_CONSTANTS, types: TS_TYPES, lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"', '\'', '`'], multiline: ['`'], decorators: true },
	json: { keywords: words(''), constants: words('true false null'), lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"'], keysBeforeColon: true },
	python: { keywords: PY_KEYWORDS, constants: PY_CONSTANTS, builtins: PY_BUILTINS, lineComments: ['#'], quotes: ['"""', '\'\'\'', '"', '\''], multiline: ['"""', '\'\'\''], decorators: true },
	go: { keywords: GO_KEYWORDS, constants: GO_CONSTANTS, types: GO_TYPES, lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"', '\'', '`'], multiline: ['`'] },
	rust: { keywords: RUST_KEYWORDS, constants: RUST_CONSTANTS, types: RUST_TYPES, lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"'], decorators: false },
	c: { keywords: C_FAMILY, constants: C_CONSTANTS, types: C_TYPES, lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"""', '"', '\''], multiline: ['"""'], decorators: true },
	ruby: { keywords: RUBY_KEYWORDS, constants: words('true false nil self'), lineComments: ['#'], quotes: ['"', '\''], dollarVars: false },
	shell: { keywords: SHELL_KEYWORDS, constants: words('true false'), lineComments: ['#'], quotes: ['"', '\''], dollarVars: true, hashNeedsSpace: true, commandFirst: true },
	sql: { keywords: SQL_KEYWORDS, constants: words('true false null'), lineComments: ['--'], blockComment: ['/*', '*/'], quotes: ['\'', '"'], caseInsensitive: true },
	css: { keywords: words('important media supports keyframes import font-face from to'), lineComments: ['//'], blockComment: ['/*', '*/'], quotes: ['"', '\''], keysBeforeColon: true },
	yaml: { keywords: words(''), constants: words('true false null yes no on off ~'), lineComments: ['#'], quotes: ['"', '\''], keysBeforeColon: true, hashNeedsSpace: true },
	toml: { keywords: words(''), constants: words('true false'), lineComments: ['#', ';'], quotes: ['"""', '"', '\''], multiline: ['"""'] },
	docker: { keywords: DOCKER_KEYWORDS, lineComments: ['#'], quotes: ['"', '\''], caseInsensitive: true, dollarVars: true },
	lua: { keywords: LUA_KEYWORDS, constants: words('true false nil self'), lineComments: ['--'], quotes: ['"', '\''] },
	graphql: { keywords: words('query mutation subscription fragment on type input enum interface union scalar schema extend implements directive'), constants: words('true false null'), lineComments: ['#'], quotes: ['"""', '"'], multiline: ['"""'] },
	plain: { keywords: words(''), lineComments: [], quotes: [] },
};

const ALIASES: Record<string, string> = {
	javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
	typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
	jsonc: 'json', json5: 'json', webmanifest: 'json',
	py: 'python', python3: 'python', py3: 'python',
	golang: 'go',
	rs: 'rust',
	java: 'c', kotlin: 'c', kt: 'c', kts: 'c', swift: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cxx: 'c', h: 'c', hpp: 'c', objc: 'c', 'objective-c': 'c', cs: 'c', csharp: 'c', 'c#': 'c', php: 'c', scala: 'c', dart: 'c', groovy: 'c', gradle: 'c', zig: 'c', proto: 'c', protobuf: 'c', solidity: 'c',
	rb: 'ruby',
	sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', console: 'shell', shellscript: 'shell', terminal: 'shell', ps1: 'shell', powershell: 'shell', makefile: 'shell', make: 'shell', env: 'shell', dotenv: 'shell',
	postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql',
	scss: 'css', less: 'css', sass: 'css', postcss: 'css',
	yml: 'yaml',
	ini: 'toml', conf: 'toml', cfg: 'toml', properties: 'toml',
	dockerfile: 'docker', containerfile: 'docker',
	gql: 'graphql',
	html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', plist: 'markup', xhtml: 'markup', astro: 'markup',
	patch: 'diff', udiff: 'diff',
	md: 'markdown', mdx: 'markdown',
	txt: 'plain', text: 'plain', plaintext: 'plain', output: 'plain', log: 'plain',
};

/** The tokenizer a fence's info string (`ts`, `tsx`, `bash`...) maps to. */
export function resolveLanguage(lang: string | undefined): string {
	const id = (lang ?? '').trim().toLowerCase().replace(/^\{?\.?/, '').replace(/\}$/, '');
	if (!id) {
		return 'plain';
	}
	if (LANGS[id] || id === 'markup' || id === 'diff' || id === 'markdown') {
		return id;
	}
	return ALIASES[id] ?? 'plain';
}

/** A short label for a code card's header (`TS`, `BASH`, `JSON`). */
export function languageLabel(lang: string | undefined): string {
	const id = (lang ?? '').trim();
	return id ? id.toUpperCase() : 'TEXT';
}

//#region Tokenizers

type LineState = string;

interface ILineResult {
	readonly tokens: IToken[];
	readonly state: LineState;
}

function push(tokens: IToken[], k: TokenKind, v: string): void {
	if (!v) {
		return;
	}
	const last = tokens[tokens.length - 1];
	if (last && last.k === k) {
		tokens[tokens.length - 1] = { k, v: last.v + v };
	} else {
		tokens.push({ k, v });
	}
}

/** Index of the closing `quote` from `from` (escapes skipped), or -1. */
function closingQuote(line: string, from: number, quote: string): number {
	for (let j = from; j < line.length; j++) {
		if (line[j] === '\\' && quote !== '\'\'\'' && quote !== '"""') {
			j++;
			continue;
		}
		if (line.startsWith(quote, j)) {
			return j;
		}
	}
	return -1;
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;
const IDENT = /^[A-Za-z_$À-￿][\w$À-￿-]*/;
const IDENT_STRICT = /^[A-Za-z_$À-￿][\w$À-￿]*/;
const OPERATOR = /^(?:=>|->|::|\.\.\.|[+\-*/%=!<>&|^~?:]+)/;

function tokenizeGeneric(line: string, lang: ILangDef, state: LineState): ILineResult {
	const tokens: IToken[] = [];
	let i = 0;
	let next: LineState = '';

	if (state.startsWith('c:') && lang.blockComment) {
		const end = line.indexOf(lang.blockComment[1]);
		if (end < 0) {
			push(tokens, 'comment', line);
			return { tokens, state };
		}
		push(tokens, 'comment', line.slice(0, end + lang.blockComment[1].length));
		i = end + lang.blockComment[1].length;
	} else if (state.startsWith('s:')) {
		const quote = state.slice(2);
		const end = closingQuote(line, 0, quote);
		if (end < 0) {
			push(tokens, 'string', line);
			return { tokens, state };
		}
		push(tokens, 'string', line.slice(0, end + quote.length));
		i = end + quote.length;
	}

	let sawWord = false;
	while (i < line.length) {
		const rest = line.slice(i);
		const ch = line[i];

		const ws = /^\s+/.exec(rest);
		if (ws) {
			push(tokens, 'plain', ws[0]);
			i += ws[0].length;
			continue;
		}

		const lineComment = lang.lineComments.find(c => rest.startsWith(c) && (!lang.hashNeedsSpace || c !== '#' || i === 0 || /\s/.test(line[i - 1])));
		if (lineComment) {
			push(tokens, 'comment', rest);
			break;
		}

		if (lang.blockComment && rest.startsWith(lang.blockComment[0])) {
			const end = line.indexOf(lang.blockComment[1], i + lang.blockComment[0].length);
			if (end < 0) {
				push(tokens, 'comment', rest);
				next = 'c:';
				break;
			}
			push(tokens, 'comment', line.slice(i, end + lang.blockComment[1].length));
			i = end + lang.blockComment[1].length;
			continue;
		}

		const quote = lang.quotes.find(q => rest.startsWith(q));
		if (quote) {
			const end = closingQuote(line, i + quote.length, quote);
			if (end < 0) {
				push(tokens, 'string', rest);
				if (lang.multiline?.includes(quote)) {
					next = `s:${quote}`;
				}
				break;
			}
			const value = line.slice(i, end + quote.length);
			i = end + quote.length;
			const isKey = lang.keysBeforeColon && /^\s*:/.test(line.slice(i)) && !/^\s*::/.test(line.slice(i));
			push(tokens, isKey ? 'property' : 'string', value);
			sawWord = true;
			continue;
		}

		if (lang.dollarVars && ch === '$') {
			const v = /^\$(?:\{[^}]*\}|[A-Za-z_][\w]*|[0-9@#?*!$-])/.exec(rest);
			if (v) {
				push(tokens, 'variable', v[0]);
				i += v[0].length;
				continue;
			}
		}

		if (lang.decorators && ch === '@') {
			const d = /^@[A-Za-z_][\w.]*/.exec(rest);
			if (d) {
				push(tokens, 'meta', d[0]);
				i += d[0].length;
				continue;
			}
		}

		if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
			const prev = line[i - 1];
			if (!prev || !/[\w$]/.test(prev)) {
				const n = NUMBER.exec(rest);
				if (n) {
					push(tokens, 'number', n[0]);
					i += n[0].length;
					continue;
				}
			}
		}

		if (ch === '#' && lang === LANGS.css) {
			const hex = /^#[\da-fA-F]{3,8}\b/.exec(rest);
			if (hex) {
				push(tokens, 'number', hex[0]);
				i += hex[0].length;
				continue;
			}
		}

		const ident = (lang === LANGS.css || lang === LANGS.yaml ? IDENT : IDENT_STRICT).exec(rest);
		if (ident) {
			const word = ident[0];
			const lookup = lang.caseInsensitive ? word.toLowerCase() : word;
			const after = line.slice(i + word.length);
			let kind: TokenKind;
			if (lang.keysBeforeColon && /^\s*:(?!:)/.test(after) && (lang !== LANGS.css || !/^\s*:\s*(hover|focus|active|before|after|root|not|is|where|nth)/.test(after))) {
				kind = 'property';
			} else if (lang.keywords.has(lookup)) {
				kind = 'keyword';
			} else if (lang.constants?.has(lookup)) {
				kind = 'constant';
			} else if (lang.types?.has(word)) {
				kind = 'type';
			} else if (lang.commandFirst && !sawWord) {
				kind = 'function';
			} else if (/^\s*\(/.test(after) || lang.builtins?.has(word)) {
				kind = 'function';
			} else if (/^[A-Z][a-z0-9]/.test(word) && lang !== LANGS.yaml && lang !== LANGS.toml) {
				kind = 'type';
			} else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) {
				kind = 'constant';
			} else {
				kind = 'plain';
			}
			push(tokens, kind, word);
			i += word.length;
			sawWord = true;
			continue;
		}

		const op = OPERATOR.exec(rest);
		if (op) {
			push(tokens, 'operator', op[0]);
			i += op[0].length;
			if (lang.commandFirst && /[|;&]/.test(op[0])) {
				sawWord = false;
			}
			continue;
		}

		push(tokens, /[{}()[\];,.]/.test(ch) ? 'punct' : 'plain', ch);
		i++;
	}
	return { tokens, state: next };
}

function tokenizeMarkup(line: string, state: LineState): ILineResult {
	const tokens: IToken[] = [];
	let i = 0;
	if (state === 'comment') {
		const end = line.indexOf('-->');
		if (end < 0) {
			push(tokens, 'comment', line);
			return { tokens, state };
		}
		push(tokens, 'comment', line.slice(0, end + 3));
		i = end + 3;
	}
	let inTag = state === 'tag';
	while (i < line.length) {
		const rest = line.slice(i);
		if (!inTag) {
			if (rest.startsWith('<!--')) {
				const end = line.indexOf('-->', i + 4);
				if (end < 0) {
					push(tokens, 'comment', rest);
					return { tokens, state: 'comment' };
				}
				push(tokens, 'comment', line.slice(i, end + 3));
				i = end + 3;
				continue;
			}
			const open = /^<\/?[A-Za-z][\w:.-]*/.exec(rest);
			if (open) {
				push(tokens, 'punct', open[0].startsWith('</') ? '</' : '<');
				push(tokens, 'tag', open[0].replace(/^<\/?/, ''));
				i += open[0].length;
				inTag = true;
				continue;
			}
			const text = /^[^<]+/.exec(rest);
			const chunk = text ? text[0] : rest[0];
			push(tokens, 'plain', chunk);
			i += chunk.length;
			continue;
		}
		const ws = /^\s+/.exec(rest);
		if (ws) {
			push(tokens, 'plain', ws[0]);
			i += ws[0].length;
			continue;
		}
		if (rest.startsWith('/>') || rest.startsWith('>')) {
			const close = rest.startsWith('/>') ? '/>' : '>';
			push(tokens, 'punct', close);
			i += close.length;
			inTag = false;
			continue;
		}
		const quote = rest[0] === '"' || rest[0] === '\'' ? rest[0] : undefined;
		if (quote) {
			const end = line.indexOf(quote, i + 1);
			const value = end < 0 ? rest : line.slice(i, end + 1);
			push(tokens, 'string', value);
			i += value.length;
			continue;
		}
		const attr = /^[^\s=>/"']+/.exec(rest);
		if (attr) {
			push(tokens, 'attr', attr[0]);
			i += attr[0].length;
			continue;
		}
		push(tokens, 'operator', rest[0]);
		i++;
	}
	return { tokens, state: inTag ? 'tag' : '' };
}

function tokenizeDiff(line: string): ILineResult {
	if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
		return { tokens: [{ k: 'meta', v: line }], state: '' };
	}
	if (line.startsWith('@@')) {
		return { tokens: [{ k: 'meta', v: line }], state: '' };
	}
	if (line.startsWith('+')) {
		return { tokens: [{ k: 'inserted', v: line }], state: '' };
	}
	if (line.startsWith('-')) {
		return { tokens: [{ k: 'deleted', v: line }], state: '' };
	}
	return { tokens: line ? [{ k: 'plain', v: line }] : [], state: '' };
}

function tokenizeMarkdown(line: string, state: LineState): ILineResult {
	if (state === 'fence') {
		return { tokens: [{ k: 'string', v: line }], state: /^\s*(```|~~~)/.test(line) ? '' : 'fence' };
	}
	if (/^\s*(```|~~~)/.test(line)) {
		return { tokens: [{ k: 'meta', v: line }], state: 'fence' };
	}
	if (/^#{1,6}\s/.test(line)) {
		return { tokens: [{ k: 'keyword', v: line }], state: '' };
	}
	const m = /^(\s*(?:[-*+]|\d+[.)])\s+|\s*>\s?)/.exec(line);
	const tokens: IToken[] = [];
	let rest = line;
	if (m) {
		push(tokens, 'punct', m[0]);
		rest = line.slice(m[0].length);
	}
	const parts = rest.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/);
	for (const part of parts) {
		if (!part) {
			continue;
		}
		push(tokens, part.startsWith('`') ? 'string' : part.startsWith('**') ? 'type' : part.startsWith('[') ? 'function' : 'plain', part);
	}
	return { tokens, state: '' };
}

function tokenizeLine(line: string, lang: string, state: LineState): ILineResult {
	switch (lang) {
		case 'markup': return tokenizeMarkup(line, state);
		case 'diff': return tokenizeDiff(line);
		case 'markdown': return tokenizeMarkdown(line, state);
		case 'plain': return { tokens: line ? [{ k: 'plain', v: line }] : [], state: '' };
		default: return tokenizeGeneric(line, LANGS[lang] ?? LANGS.plain, state);
	}
}

//#endregion

const MAX_LINE_CACHE = 6000;
const lineCache = new Map<string, ILineResult>();
const MAX_LINE_LENGTH = 2000;

/**
 * Tokens per line of `code`. Lines longer than 2000 characters (minified files) are left plain.
 */
export function highlight(code: string, lang: string | undefined): HighlightedLine[] {
	const id = resolveLanguage(lang);
	const lines = code.split('\n');
	const out: HighlightedLine[] = [];
	let state: LineState = '';
	for (const line of lines) {
		if (line.length > MAX_LINE_LENGTH || id === 'plain') {
			out.push(line ? [{ k: 'plain', v: line }] : []);
			continue;
		}
		const key = `${id}\u0000${state}\u0000${line}`;
		let result = lineCache.get(key);
		if (!result) {
			result = tokenizeLine(line, id, state);
			lineCache.set(key, result);
			if (lineCache.size > MAX_LINE_CACHE) {
				const oldest = lineCache.keys().next().value;
				if (oldest !== undefined) {
					lineCache.delete(oldest);
				}
			}
		}
		out.push(result.tokens);
		state = result.state;
	}
	return out;
}
