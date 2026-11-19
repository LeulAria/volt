/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Breakpoints for request scripts. A script runs in one go inside a worker and cannot be paused,
 * so a breakpoint is a recording: `instrumentHttpScript` puts a call in front of the statement on
 * each breakpoint line, and that call hands the runtime the variables in reach at that moment
 * (`__voltBreak` in `httpScriptRuntime`). Nothing here runs the script: the text is tokenized and
 * walked statement by statement. No line is added or removed, so every line number stays true.
 */

/** The function an instrumented script calls at a breakpoint: `(line, "a,b", [() => a, () => b])`. */
export const HTTP_SCRIPT_BREAK_NAME = '__voltBreak';

/** The most names one breakpoint reads. */
const MAX_NAMES = 80;

interface IToken {
	readonly kind: 'word' | 'number' | 'string' | 'template' | 'regex' | 'punct';
	readonly text: string;
	readonly start: number;
	readonly end: number;
	/** 1-based line the token starts on. */
	readonly line: number;
	/** A line break sits between the token before and this one. */
	readonly nl: boolean;
}

interface IScope {
	readonly parent: IScope | undefined;
	/** The nearest function's scope (itself for one): where `var` lands. */
	fn: IScope;
	readonly names: string[];
}

interface ISite {
	readonly line: number;
	/** Offset of the statement's first character. */
	readonly at: number;
	/** The lone body of a brace-less `if`/`else`/loop: where it ends, so it can be put in braces. */
	wrapEnd?: number;
	readonly scope: IScope;
}

const PUNCTUATORS = [
	'>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
	'=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
];
/** Words a regex literal (not a division) follows. */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** Words an expression goes on after, whatever the next line starts with. */
const CONTINUES_AFTER = new Set(['typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'return', 'async', 'extends', 'function', 'class', 'var', 'let', 'const', 'get', 'set', 'static']);
const RESERVED = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
	'let', 'yield', 'await', 'enum', 'arguments', 'eval', 'undefined', HTTP_SCRIPT_BREAK_NAME,
]);
const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The tokens of a script; `broken` when a string, template or comment never ends. */
function tokenize(text: string): { tokens: IToken[]; broken: boolean } {
	const tokens: IToken[] = [];
	const length = text.length;
	let at = 0;
	let line = 1;
	let nl = false;
	let broken = false;
	const word = /[A-Za-z_$#\u0080-\uffff][\w$\u0080-\uffff]*/y;
	const number = /(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;

	const stringEnd = (from: number): number => {
		const quote = text[from];
		for (let i = from + 1; i < length; i++) {
			const ch = text[i];
			if (ch === '\\') {
				i++;
			} else if (ch === quote) {
				return i + 1;
			} else if (ch === '\n') {
				return -1;
			}
		}
		return -1;
	};
	const templateEnd = (from: number): number => {
		let i = from + 1;
		while (i < length) {
			const ch = text[i];
			if (ch === '\\') {
				i += 2;
			} else if (ch === '`') {
				return i + 1;
			} else if (ch === '$' && text[i + 1] === '{') {
				i = codeEnd(i + 2);
				if (i < 0) {
					return -1;
				}
			} else {
				i++;
			}
		}
		return -1;
	};
	/** After the `}` that closes a template's `${`. */
	const codeEnd = (from: number): number => {
		let depth = 0;
		let i = from;
		while (i < length) {
			const ch = text[i];
			if (ch === '"' || ch === '\'') {
				i = stringEnd(i);
			} else if (ch === '`') {
				i = templateEnd(i);
			} else if (ch === '/' && text[i + 1] === '/') {
				const end = text.indexOf('\n', i);
				i = end < 0 ? length : end;
			} else if (ch === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2);
				i = end < 0 ? -1 : end + 2;
			} else if (ch === '{') {
				depth++;
				i++;
			} else if (ch === '}') {
				if (depth === 0) {
					return i + 1;
				}
				depth--;
				i++;
			} else {
				i++;
			}
			if (i < 0) {
				return -1;
			}
		}
		return -1;
	};
	const regexEnd = (from: number): number => {
		let inClass = false;
		for (let i = from + 1; i < length; i++) {
			const ch = text[i];
			if (ch === '\\') {
				i++;
			} else if (ch === '\n') {
				return -1;
			} else if (ch === '[') {
				inClass = true;
			} else if (ch === ']') {
				inClass = false;
			} else if (ch === '/' && !inClass) {
				let end = i + 1;
				while (end < length && /[a-z]/i.test(text[end])) {
					end++;
				}
				return end;
			}
		}
		return -1;
	};
	const regexAllowed = (): boolean => {
		const prev = tokens[tokens.length - 1];
		if (!prev) {
			return true;
		}
		if (prev.kind === 'punct') {
			return prev.text !== ')' && prev.text !== ']' && prev.text !== '++' && prev.text !== '--';
		}
		return prev.kind === 'word' && REGEX_AFTER.has(prev.text);
	};
	const push = (kind: IToken['kind'], end: number): void => {
		tokens.push({ kind, text: text.slice(at, end), start: at, end, line, nl });
		nl = false;
		for (let i = at; i < end; i++) {
			if (text.charCodeAt(i) === 10) {
				line++;
			}
		}
		at = end;
	};

	while (at < length) {
		const ch = text[at];
		if (ch === '\n') {
			line++;
			nl = true;
			at++;
		} else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\u00a0' || ch === '\ufeff' || ch === '\v' || ch === '\f') {
			at++;
		} else if (ch === '\u2028' || ch === '\u2029') {
			// Line breaks to the language, not to an editor's line count.
			nl = true;
			at++;
		} else if (ch === '/' && text[at + 1] === '/') {
			const end = text.indexOf('\n', at);
			at = end < 0 ? length : end;
		} else if (ch === '/' && text[at + 1] === '*') {
			const end = text.indexOf('*/', at + 2);
			if (end < 0) {
				broken = true;
				break;
			}
			for (let i = at; i < end; i++) {
				if (text.charCodeAt(i) === 10) {
					line++;
					nl = true;
				}
			}
			at = end + 2;
		} else if (ch === '"' || ch === '\'') {
			const end = stringEnd(at);
			if (end < 0) {
				broken = true;
				break;
			}
			push('string', end);
		} else if (ch === '`') {
			const end = templateEnd(at);
			if (end < 0) {
				broken = true;
				break;
			}
			push('template', end);
		} else if (ch === '/' && regexAllowed() && regexEnd(at) > 0) {
			push('regex', regexEnd(at));
		} else if ((ch >= '0' && ch <= '9') || (ch === '.' && text[at + 1] >= '0' && text[at + 1] <= '9')) {
			number.lastIndex = at;
			const found = number.exec(text);
			push('number', found && found[0] ? at + found[0].length : at + 1);
		} else {
			word.lastIndex = at;
			const found = word.exec(text);
			if (found) {
				push('word', at + found[0].length);
			} else {
				const long = PUNCTUATORS.find(item => text.startsWith(item, at));
				push('punct', at + (long ? long.length : 1));
			}
		}
	}
	return { tokens, broken };
}

/**
 * Where a statement begins, one per line (the first on it), with the scope it sits in. Empty for a
 * script whose brackets do not match: it does not run anyway, and nothing may be put into it.
 */
function analyze(script: string): ISite[] {
	const { tokens, broken } = tokenize(script);
	if (broken) {
		return [];
	}
	const TOP = 1; // ends where a statement ends without a `;`
	const COMMA = 2; // ends at a `,`
	const COLON = 4; // ends at a `:` that is not a `?:`'s
	const count = tokens.length;
	const sites = new Map<number, ISite>();
	let pos = 0;
	let bad = false;

	const is = (text: string, offset = 0): boolean => pos + offset < count && tokens[pos + offset].text === text;
	const isPunct = (text: string): boolean => pos < count && tokens[pos].kind === 'punct' && tokens[pos].text === text;
	const scopeOf = (parent: IScope | undefined, fn: boolean): IScope => {
		const scope: IScope = { parent, names: [], fn: undefined as unknown as IScope };
		scope.fn = fn || !parent ? scope : parent.fn;
		return scope;
	};
	const declare = (scope: IScope, token: IToken | undefined): void => {
		if (token && token.kind === 'word' && !RESERVED.has(token.text) && token.text[0] !== '#' && !scope.names.includes(token.text)) {
			scope.names.push(token.text);
		}
	};
	const expect = (text: string): void => {
		if (isPunct(text)) {
			pos++;
		} else {
			bad = true;
		}
	};
	/** The names a pattern binds (parameters, a destructuring target): tokens `from` to `to`. */
	const bind = (from: number, to: number, scope: IScope): void => {
		for (let i = from; i < to; i++) {
			const token = tokens[i];
			if (token.kind === 'punct' && token.text === '=') {
				// A default value: not names.
				let depth = 0;
				for (i++; i < to; i++) {
					const inner = tokens[i];
					if (inner.kind !== 'punct') {
						continue;
					}
					if (CLOSER[inner.text]) {
						depth++;
					} else if (inner.text === ')' || inner.text === ']' || inner.text === '}') {
						if (depth === 0) {
							break;
						}
						depth--;
					} else if (inner.text === ',' && depth === 0) {
						break;
					}
				}
			} else if (token.kind === 'word' && !(i + 1 < to && tokens[i + 1].text === ':')) {
				declare(scope, token);
			}
		}
	};
	/** Whether a statement ends between `prev` and `next`, which starts a new line. */
	const endsStatement = (prev: IToken, next: IToken): boolean => {
		const prevEnds = prev.kind === 'word' ? !CONTINUES_AFTER.has(prev.text)
			: prev.kind !== 'punct' ? true
				: prev.text === ')' || prev.text === ']' || prev.text === '}' || prev.text === '++' || prev.text === '--';
		if (!prevEnds) {
			return false;
		}
		if (next.kind === 'word') {
			return next.text !== 'in' && next.text !== 'instanceof';
		}
		if (next.kind === 'number' || next.kind === 'string') {
			return true;
		}
		return next.kind === 'punct' && (next.text === '{' || next.text === '!' || next.text === '~' || next.text === '++' || next.text === '--');
	};

	/** Walks `( ... )`, `[ ... ]` or an object literal; answers the range of tokens inside. */
	const group = (scope: IScope): [number, number] => {
		const closer = CLOSER[tokens[pos].text];
		const from = ++pos;
		expression(scope, 0);
		const to = pos;
		expect(closer);
		return [from, to];
	};
	const functionBody = (scope: IScope): void => {
		if (!isPunct('{')) {
			bad = true;
			return;
		}
		pos++;
		statements(scope, true, false);
		expect('}');
	};
	const block = (scope: IScope): void => {
		if (!isPunct('{')) {
			bad = true;
			return;
		}
		pos++;
		statements(scope, false, false);
		expect('}');
	};
	const functionAt = (scope: IScope, declaration: boolean): void => {
		pos++; // function
		if (isPunct('*')) {
			pos++;
		}
		const inner = scopeOf(scope, true);
		if (pos < count && tokens[pos].kind === 'word') {
			declare(declaration ? scope : inner, tokens[pos]);
			pos++;
		}
		if (!isPunct('(')) {
			bad = true;
			return;
		}
		const [from, to] = group(inner);
		bind(from, to, inner);
		functionBody(inner);
	};
	const arrow = (scope: IScope, from: number, to: number, mode: number): void => {
		pos++; // =>
		const inner = scopeOf(scope, true);
		bind(from, to, inner);
		if (isPunct('{')) {
			functionBody(inner);
		} else {
			expression(inner, (mode & TOP) | COMMA);
		}
	};
	const classAt = (scope: IScope, declaration: boolean): void => {
		pos++; // class
		if (pos < count && tokens[pos].kind === 'word' && tokens[pos].text !== 'extends') {
			if (declaration) {
				declare(scope, tokens[pos]);
			}
			pos++;
		}
		if (is('extends')) {
			pos++;
			while (pos < count && !isPunct('{') && !bad) {
				const token = tokens[pos];
				if (token.kind === 'punct' && (token.text === '(' || token.text === '[')) {
					group(scope);
				} else if (token.kind === 'punct' && (token.text === ')' || token.text === ']' || token.text === '}' || token.text === ';')) {
					bad = true;
				} else {
					pos++;
				}
			}
		}
		if (!isPunct('{')) {
			bad = true;
			return;
		}
		pos++;
		while (pos < count && !isPunct('}') && !bad) {
			const token = tokens[pos];
			if (token.kind === 'word' && token.text === 'static' && is('{', 1)) {
				pos++;
				block(scopeOf(scope, true));
			} else if (token.kind !== 'punct') {
				pos++;
			} else if (token.text === '(') {
				const inner = scopeOf(scope, true);
				const [from, to] = group(inner);
				bind(from, to, inner);
				functionBody(inner);
			} else if (token.text === '=') {
				pos++;
				expression(scope, TOP);
			} else if (token.text === '[') {
				group(scope);
			} else if (token.text === '{' || token.text === ')' || token.text === ']') {
				bad = true;
			} else {
				pos++;
			}
		}
		expect('}');
	};

	/** Steps over an expression, going into the functions written inside it. */
	const expression = (scope: IScope, mode: number): void => {
		let started = false;
		let ternary = 0;
		while (pos < count && !bad) {
			const token = tokens[pos];
			if (token.kind === 'punct') {
				if (token.text === ')' || token.text === ']' || token.text === '}') {
					return;
				}
				if (token.text === ';' && mode) {
					return;
				}
				if (token.text === ',' && (mode & COMMA)) {
					return;
				}
				if (token.text === '?') {
					ternary++;
				} else if (token.text === ':') {
					if ((mode & COLON) && ternary === 0) {
						return;
					}
					ternary = Math.max(0, ternary - 1);
				}
			}
			if ((mode & TOP) && started && token.nl && endsStatement(tokens[pos - 1], token)) {
				return;
			}
			started = true;
			if (token.kind === 'word') {
				if (token.text === 'function') {
					functionAt(scope, false);
				} else if (token.text === 'class') {
					classAt(scope, false);
				} else {
					pos++;
					if (isPunct('=>')) {
						arrow(scope, pos - 1, pos, mode);
					}
				}
			} else if (token.kind !== 'punct') {
				pos++;
			} else if (token.text === '(') {
				const [from, to] = group(scope);
				if (isPunct('=>')) {
					arrow(scope, from, to, mode);
				} else if (isPunct('{')) {
					if (mode === 0) {
						// `name(a, b) { ... }` in an object literal.
						const inner = scopeOf(scope, true);
						bind(from, to, inner);
						functionBody(inner);
					} else if ((mode & TOP) && tokens[pos].nl) {
						return;
					} else {
						bad = true;
					}
				}
			} else if (token.text === '[' || token.text === '{') {
				group(scope);
			} else {
				pos++;
			}
		}
	};

	/** `a = 1, { b, c: [d] } = value`: after `var`, `let` or `const`. */
	const declarations = (target: IScope, scope: IScope, mode: number): void => {
		while (pos < count && !bad) {
			const token = tokens[pos];
			if (token.kind === 'word') {
				declare(target, token);
				pos++;
			} else if (token.kind === 'punct' && (token.text === '[' || token.text === '{')) {
				const [from, to] = group(scope);
				bind(from, to, target);
			} else {
				bad = true;
				return;
			}
			if (isPunct('=')) {
				pos++;
				expression(scope, mode | COMMA);
			}
			if (isPunct(',')) {
				pos++;
				continue;
			}
			return;
		}
	};
	const condition = (scope: IScope): void => {
		if (isPunct('(')) {
			group(scope);
		} else {
			bad = true;
		}
	};
	const startsDeclaration = (): boolean => {
		const next = tokens[pos + 1];
		return !!next && (next.kind === 'word' ? next.text !== 'in' && next.text !== 'of' && next.text !== 'instanceof' : next.kind === 'punct' && (next.text === '[' || next.text === '{'));
	};

	const statements = (scope: IScope, prologue: boolean, inSwitch: boolean): void => {
		while (pos < count && !bad && !isPunct('}')) {
			if (inSwitch && (is('case') || (is('default') && is(':', 1)))) {
				return;
			}
			const token = tokens[pos];
			if (prologue && token.kind === 'string') {
				// 'use strict' must stay the first thing in its function: nothing goes in front of it.
				const next = tokens[pos + 1];
				if (!next || (next.kind === 'punct' && (next.text === ';' || next.text === '}')) || (next.nl && endsStatement(token, next))) {
					pos++;
					if (isPunct(';')) {
						pos++;
					}
					continue;
				}
			}
			prologue = false;
			const before = pos;
			statement(scope, false);
			if (pos === before) {
				bad = true;
			}
		}
	};

	/** `lone`: the body of an `if`, `else` or loop written without braces. */
	const statement = (scope: IScope, lone: boolean): void => {
		const first = tokens[pos];
		if (!first) {
			bad = true;
			return;
		}
		if (first.kind === 'punct' && first.text === ';') {
			pos++;
			return;
		}
		if (first.kind === 'punct' && first.text === '{') {
			block(scopeOf(scope, false));
			return;
		}
		const word = first.kind === 'word' ? first.text : '';
		const isFunction = word === 'function' || (word === 'async' && is('function', 1) && !tokens[pos + 1].nl);
		const isLexical = word === 'class' || ((word === 'const' || word === 'let') && startsDeclaration());
		let site: ISite | undefined;
		if (!isFunction && !(lone && isLexical) && !sites.has(first.line)) {
			site = { line: first.line, at: first.start, scope };
			sites.set(first.line, site);
		}
		statementBody(scope);
		if (site && lone && pos > 0) {
			site.wrapEnd = tokens[pos - 1].end;
		}
	};

	const statementBody = (scope: IScope): void => {
		const first = tokens[pos];
		const word = first.kind === 'word' ? first.text : '';
		switch (word) {
			case 'var':
			case 'const':
			case 'let':
				if (word !== 'let' || startsDeclaration()) {
					pos++;
					declarations(word === 'var' ? scope.fn : scope, scope, TOP);
					if (isPunct(';')) {
						pos++;
					}
					return;
				}
				break;
			case 'function':
				functionAt(scope, true);
				return;
			case 'async':
				if (is('function', 1) && !tokens[pos + 1].nl) {
					pos++;
					functionAt(scope, true);
					return;
				}
				break;
			case 'class':
				classAt(scope, true);
				return;
			case 'if':
				pos++;
				condition(scope);
				statement(scope, true);
				if (is('else')) {
					pos++;
					statement(scope, true);
				}
				return;
			case 'for': {
				pos++;
				if (is('await')) {
					pos++;
				}
				if (!isPunct('(')) {
					bad = true;
					return;
				}
				pos++;
				const inner = scopeOf(scope, false);
				if (is('var') || is('const') || (is('let') && startsDeclaration())) {
					const target = is('var') ? scope.fn : inner;
					pos++;
					declarations(target, inner, COMMA);
				}
				expression(inner, 0);
				expect(')');
				statement(inner, true);
				return;
			}
			case 'while':
				pos++;
				condition(scope);
				statement(scope, true);
				return;
			case 'do':
				pos++;
				statement(scope, true);
				if (is('while')) {
					pos++;
					condition(scope);
				} else {
					bad = true;
				}
				if (isPunct(';')) {
					pos++;
				}
				return;
			case 'switch': {
				pos++;
				condition(scope);
				if (!isPunct('{')) {
					bad = true;
					return;
				}
				pos++;
				const inner = scopeOf(scope, false);
				while (pos < count && !bad && !isPunct('}')) {
					if (is('case')) {
						pos++;
						expression(inner, COLON);
						expect(':');
					} else if (is('default') && is(':', 1)) {
						pos += 2;
					} else {
						const before = pos;
						statements(inner, false, true);
						if (pos === before) {
							bad = true;
						}
					}
				}
				expect('}');
				return;
			}
			case 'try':
				pos++;
				block(scopeOf(scope, false));
				if (is('catch')) {
					pos++;
					const inner = scopeOf(scope, false);
					if (isPunct('(')) {
						const [from, to] = group(scope);
						bind(from, to, inner);
					}
					block(inner);
				}
				if (is('finally')) {
					pos++;
					block(scopeOf(scope, false));
				}
				return;
			case 'return':
			case 'throw': {
				pos++;
				const next = tokens[pos];
				if (next && !next.nl) {
					expression(scope, TOP);
				}
				if (isPunct(';')) {
					pos++;
				}
				return;
			}
			case 'break':
			case 'continue':
				pos++;
				if (pos < count && tokens[pos].kind === 'word' && !tokens[pos].nl) {
					pos++;
				}
				if (isPunct(';')) {
					pos++;
				}
				return;
			case 'else':
			case 'case':
			case 'catch':
			case 'finally':
				bad = true;
				return;
		}
		if (word && !RESERVED.has(word) && is(':', 1)) {
			// A label.
			pos += 2;
			if (pos < count && !isPunct('}')) {
				statementBody(scope);
			}
			return;
		}
		const before = pos;
		expression(scope, TOP);
		if (pos === before) {
			bad = true;
			return;
		}
		if (isPunct(';')) {
			pos++;
		}
	};

	try {
		statements(scopeOf(undefined, true), true, false);
	} catch {
		// Deeper than the stack goes: nothing is breakable rather than something wrong.
		return [];
	}
	if (bad || pos < count) {
		return [];
	}
	return [...sites.values()].sort((a, b) => a.line - b.line);
}

/**
 * The 1-based lines a breakpoint can sit on: those where a statement begins, at the top level or
 * inside any function or block body (a callback's too). Lines in the middle of an expression, in
 * an object or array literal, in a class's member list, and blank or comment lines are not.
 * A function declaration's own line is not either (nothing runs there); the lines of its body are.
 */
export function httpScriptBreakableLines(script: string): number[] {
	return analyze(String(script ?? '')).map(site => site.line);
}

/** The line a breakpoint asked for `line` lands on: the nearest breakable one at or after it. */
export function snapHttpScriptBreakpoint(breakable: readonly number[], line: number): number | undefined {
	return breakable.find(candidate => candidate >= line);
}

/**
 * Puts a recording call in front of the statement on each asked line (snapped to the nearest
 * breakable line at or after it, dropped when there is none). The call goes on the line itself:
 * the result has the same lines as the script. `lines` are the ones used, ascending.
 *
 * The names read at a stop are those declared in reach of it by the text: `var`, `let`, `const`,
 * functions, classes and parameters of the functions around it and of the top level, destructured
 * names too. Each is read through its own function, so one not yet initialised does not throw.
 */
export function instrumentHttpScript(script: string, lines: readonly number[]): { script: string; lines: number[] } {
	const text = String(script ?? '');
	const sites = analyze(text);
	const chosen = new Map<number, ISite>();
	for (const asked of lines ?? []) {
		const line = Math.floor(Number(asked));
		const site = line >= 1 ? sites.find(candidate => candidate.line >= line) : undefined;
		if (site) {
			chosen.set(site.line, site);
		}
	}
	if (!chosen.size) {
		return { script: text, lines: [] };
	}
	// Closing braces first where an end and a start meet: the brace belongs to the statement before.
	const edits: { at: number; order: number; text: string }[] = [];
	for (const site of chosen.values()) {
		const names: string[] = [];
		for (let scope: IScope | undefined = site.scope; scope; scope = scope.parent) {
			for (const name of scope.names) {
				if (names.length < MAX_NAMES && !names.includes(name)) {
					names.push(name);
				}
			}
		}
		const call = `${HTTP_SCRIPT_BREAK_NAME}(${site.line},${JSON.stringify(names.join(','))},[${names.map(name => `()=>${name}`).join(',')}]);`;
		if (site.wrapEnd !== undefined) {
			edits.push({ at: site.at, order: 1, text: `{${call}` });
			edits.push({ at: site.wrapEnd, order: 0, text: '}' });
		} else {
			edits.push({ at: site.at, order: 1, text: call });
		}
	}
	edits.sort((a, b) => a.at - b.at || a.order - b.order);
	let out = '';
	let from = 0;
	for (const edit of edits) {
		out += text.slice(from, edit.at) + edit.text;
		from = edit.at;
	}
	return { script: out + text.slice(from), lines: [...chosen.keys()].sort((a, b) => a - b) };
}
