/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWorkflowNodeType } from './workflowNodes.js';
import { IWorkflowDefinition, IWorkflowScope, WorkflowRecord, WorkflowValue } from './workflowTypes.js';

/**
 * Safe expressions and `{{ … }}` templates: a small hand-written language (paths over the scope,
 * literals, comparisons, arithmetic, `&& || ! ?:`, `in`, a whitelisted set of pure functions)
 * evaluated against an IWorkflowScope. Never eval, never Function, no globals.
 *
 * Paths read only own enumerable keys of plain data (`__proto__`, `prototype` and `constructor`
 * are always undefined), so nothing can reach a prototype or a host object. Sources, evaluation
 * steps, result sizes and nesting are capped so a workflow file cannot hang or bloat a run.
 *
 * Names: `inputs`, `input` (the upstream output), `trigger`, `nodes`, `vars`, `item`, `loop`, `run`. Member names may contain `-`
 * (node ids like `run-tests`): write `vars.n - 1` with spaces for a subtraction.
 */

export const EXPRESSION_MAX_SOURCE = 4000;
export const EXPRESSION_MAX_STEPS = 20_000;
export const EXPRESSION_MAX_RESULT_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_REGEX_SOURCE = 200;
const MAX_REGEX_TEXT = 100_000;
const MAX_SPLIT_PARTS = 10_000;

export class WorkflowExpressionError extends Error {
	constructor(message: string, readonly offset?: number) {
		super(message);
		this.name = 'WorkflowExpressionError';
	}
}

export interface IParsedExpression {
	readonly source: string;
}

export interface IExpressionOptions {
	/** Clock for `now()` and `date()`; `Date.now` when absent. */
	now?(): number;
}

/** Root names an expression may read. */
export const EXPRESSION_ROOTS: readonly string[] = ['inputs', 'input', 'trigger', 'nodes', 'vars', 'item', 'loop', 'run'];

/** The whitelisted functions, for autocomplete and docs. */
export const EXPRESSION_FUNCTIONS: readonly { readonly name: string; readonly signature: string; readonly description: string }[] = [
	{ name: 'len', signature: 'len(value)', description: 'Length of a string or list, key count of a map.' },
	{ name: 'lower', signature: 'lower(text)', description: 'Lower-case text.' },
	{ name: 'upper', signature: 'upper(text)', description: 'Upper-case text.' },
	{ name: 'trim', signature: 'trim(text)', description: 'Text without surrounding whitespace.' },
	{ name: 'contains', signature: 'contains(haystack, needle)', description: 'Substring, list item or map key.' },
	{ name: 'startsWith', signature: 'startsWith(text, prefix)', description: 'Text starts with prefix.' },
	{ name: 'endsWith', signature: 'endsWith(text, suffix)', description: 'Text ends with suffix.' },
	{ name: 'matches', signature: 'matches(text, pattern, flags?)', description: 'Regular expression test (simple patterns only).' },
	{ name: 'replace', signature: 'replace(text, search, replacement)', description: 'Replaces every occurrence of search (plain text).' },
	{ name: 'split', signature: 'split(text, separator?)', description: 'Splits text into a list (comma by default).' },
	{ name: 'join', signature: 'join(list, separator?)', description: 'Joins a list into text (comma by default).' },
	{ name: 'json', signature: 'json(value, indent?)', description: 'Value as JSON text.' },
	{ name: 'parseJson', signature: 'parseJson(text)', description: 'Value from JSON text.' },
	{ name: 'number', signature: 'number(value)', description: 'A number, or null when it is not one.' },
	{ name: 'string', signature: 'string(value)', description: 'Value as text (maps and lists as JSON).' },
	{ name: 'bool', signature: 'bool(value)', description: 'Truthiness; "false", "0", "no" and "off" are false.' },
	{ name: 'default', signature: 'default(value, fallback, …)', description: 'The first value that is not null or empty text.' },
	{ name: 'coalesce', signature: 'coalesce(a, b, …)', description: 'The first value that is not null.' },
	{ name: 'keys', signature: 'keys(map)', description: 'A map\'s keys.' },
	{ name: 'values', signature: 'values(map)', description: 'A map\'s values.' },
	{ name: 'first', signature: 'first(list)', description: 'First item (or character).' },
	{ name: 'last', signature: 'last(list)', description: 'Last item (or character).' },
	{ name: 'slice', signature: 'slice(list, start, end?)', description: 'Part of a list or text; negative indexes count from the end.' },
	{ name: 'round', signature: 'round(number, digits?)', description: 'Rounds to digits after the point.' },
	{ name: 'floor', signature: 'floor(number)', description: 'Rounds down.' },
	{ name: 'ceil', signature: 'ceil(number)', description: 'Rounds up.' },
	{ name: 'min', signature: 'min(a, b, …)', description: 'Smallest number (of the arguments or one list).' },
	{ name: 'max', signature: 'max(a, b, …)', description: 'Largest number (of the arguments or one list).' },
	{ name: 'abs', signature: 'abs(number)', description: 'Absolute value.' },
	{ name: 'now', signature: 'now()', description: 'The current time in epoch milliseconds.' },
	{ name: 'date', signature: 'date(value?, format?)', description: 'ISO date of a time (now when absent); format with YYYY MM DD HH mm ss.' },
];

//#region Tokens

type TokenKind = 'num' | 'str' | 'name' | 'op' | 'eof';

interface IToken {
	readonly kind: TokenKind;
	readonly value: string;
	readonly num?: number;
	readonly at: number;
}

const OPERATORS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '<', '>', '!', '+', '-', '*', '/', '%', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}'];

function isNameStart(ch: string): boolean {
	return /[A-Za-z_$]/.test(ch);
}

function isNamePart(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch);
}

function tokenize(source: string, base: number): IToken[] {
	const tokens: IToken[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const at = base + i;
		if (/[0-9]/.test(ch)) {
			const match = /^(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i))!;
			tokens.push({ kind: 'num', value: match[0], num: Number(match[0]), at });
			i += match[0].length;
			if (i < source.length && isNamePart(source[i])) {
				throw new WorkflowExpressionError(`Unexpected '${source[i]}' after a number`, base + i);
			}
			continue;
		}
		if (ch === '\'' || ch === '"') {
			let value = '';
			let j = i + 1;
			for (; j < source.length && source[j] !== ch; j++) {
				if (source[j] === '\\') {
					const next = source[++j];
					switch (next) {
						case 'n': value += '\n'; break;
						case 't': value += '\t'; break;
						case 'r': value += '\r'; break;
						case '0': value += '\0'; break;
						case 'u': {
							const hex = source.slice(j + 1, j + 5);
							if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
								throw new WorkflowExpressionError('Invalid \\u escape', base + j - 1);
							}
							value += String.fromCharCode(parseInt(hex, 16));
							j += 4;
							break;
						}
						case undefined: throw new WorkflowExpressionError('Unterminated string', at);
						default: value += next;
					}
				} else {
					value += source[j];
				}
			}
			if (j >= source.length) {
				throw new WorkflowExpressionError('Unterminated string', at);
			}
			tokens.push({ kind: 'str', value, at });
			i = j + 1;
			continue;
		}
		if (isNameStart(ch)) {
			// After a dot, names may hold dashes (node ids like `run-tests`), as GitHub's `steps.my-step` does.
			const member = tokens.length > 0 && tokens[tokens.length - 1].kind === 'op' && tokens[tokens.length - 1].value === '.';
			let j = i + 1;
			while (j < source.length && (isNamePart(source[j]) || (member && source[j] === '-' && j + 1 < source.length && isNamePart(source[j + 1])))) {
				j++;
			}
			tokens.push({ kind: 'name', value: source.slice(i, j), at });
			i = j;
			continue;
		}
		const op = OPERATORS.find(candidate => source.startsWith(candidate, i));
		if (!op) {
			throw new WorkflowExpressionError(`Unexpected '${ch}'`, at);
		}
		tokens.push({ kind: 'op', value: op === '===' ? '==' : op === '!==' ? '!=' : op, at });
		i += op.length;
	}
	tokens.push({ kind: 'eof', value: '', at: base + source.length });
	return tokens;
}

//#endregion

//#region Parser

type Ast =
	| { readonly k: 'lit'; readonly v: WorkflowValue; readonly at: number }
	| { readonly k: 'name'; readonly name: string; readonly at: number }
	| { readonly k: 'get'; readonly obj: Ast; readonly key: string; readonly at: number }
	| { readonly k: 'index'; readonly obj: Ast; readonly index: Ast; readonly at: number }
	| { readonly k: 'call'; readonly name: string; readonly args: readonly Ast[]; readonly at: number }
	| { readonly k: 'unary'; readonly op: string; readonly arg: Ast; readonly at: number }
	| { readonly k: 'binary'; readonly op: string; readonly left: Ast; readonly right: Ast; readonly at: number }
	| { readonly k: 'cond'; readonly test: Ast; readonly then: Ast; readonly else: Ast; readonly at: number }
	| { readonly k: 'list'; readonly items: readonly Ast[]; readonly at: number }
	| { readonly k: 'map'; readonly entries: readonly (readonly [string, Ast])[]; readonly at: number };

const BINARY_POWER: { readonly [op: string]: number } = {
	'??': 20, '||': 30, '&&': 40,
	'==': 50, '!=': 50,
	'<': 60, '<=': 60, '>': 60, '>=': 60, 'in': 60,
	'+': 70, '-': 70,
	'*': 80, '/': 80, '%': 80,
};
const TERNARY_POWER = 10;
const PREFIX_POWER = 90;
const POSTFIX_POWER = 100;

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class Parser {
	private pos = 0;
	private depth = 0;

	constructor(private readonly tokens: readonly IToken[]) { }

	parseAll(): Ast {
		const ast = this.parse(0);
		const rest = this.peek();
		if (rest.kind !== 'eof') {
			throw new WorkflowExpressionError(`Unexpected '${rest.value}'`, rest.at);
		}
		return ast;
	}

	private peek(): IToken {
		return this.tokens[this.pos];
	}

	private next(): IToken {
		return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1];
	}

	private isOp(value: string): boolean {
		const token = this.peek();
		return token.kind === 'op' && token.value === value;
	}

	private expect(value: string): IToken {
		const token = this.next();
		if (token.kind !== 'op' || token.value !== value) {
			throw new WorkflowExpressionError(token.kind === 'eof' ? `Expected '${value}' before the end` : `Expected '${value}' but found '${token.value}'`, token.at);
		}
		return token;
	}

	private parse(power: number): Ast {
		if (++this.depth > MAX_DEPTH) {
			throw new WorkflowExpressionError('Expression is nested too deeply', this.peek().at);
		}
		let left = this.prefix(this.next());
		for (; ;) {
			const token = this.peek();
			const lbp = this.leftPower(token);
			if (lbp <= power) {
				break;
			}
			this.next();
			left = this.infix(token, left);
		}
		this.depth--;
		return left;
	}

	private leftPower(token: IToken): number {
		if (token.kind === 'op') {
			if (token.value === '.' || token.value === '[' || token.value === '(') {
				return POSTFIX_POWER;
			}
			if (token.value === '?') {
				return TERNARY_POWER;
			}
			return BINARY_POWER[token.value] ?? 0;
		}
		return token.kind === 'name' && token.value === 'in' ? BINARY_POWER.in : 0;
	}

	private prefix(token: IToken): Ast {
		switch (token.kind) {
			case 'num': return { k: 'lit', v: token.num!, at: token.at };
			case 'str': return { k: 'lit', v: token.value, at: token.at };
			case 'eof': throw new WorkflowExpressionError('Expected a value', token.at);
			case 'name':
				switch (token.value) {
					case 'true': return { k: 'lit', v: true, at: token.at };
					case 'false': return { k: 'lit', v: false, at: token.at };
					case 'null': case 'undefined': return { k: 'lit', v: null, at: token.at };
					case 'in': throw new WorkflowExpressionError('Unexpected \'in\'', token.at);
				}
				return { k: 'name', name: token.value, at: token.at };
		}
		switch (token.value) {
			case '!': case '-': case '+':
				return { k: 'unary', op: token.value, arg: this.parse(PREFIX_POWER), at: token.at };
			case '(': {
				const inner = this.parse(0);
				this.expect(')');
				return inner;
			}
			case '[': {
				const items: Ast[] = [];
				while (!this.isOp(']')) {
					items.push(this.parse(0));
					if (!this.isOp(']')) {
						this.expect(',');
					}
				}
				this.expect(']');
				return { k: 'list', items, at: token.at };
			}
			case '{': {
				const entries: [string, Ast][] = [];
				while (!this.isOp('}')) {
					const key = this.next();
					if (key.kind !== 'name' && key.kind !== 'str' && key.kind !== 'num') {
						throw new WorkflowExpressionError('Expected a key', key.at);
					}
					if (BLOCKED_KEYS.has(key.value)) {
						throw new WorkflowExpressionError(`Key '${key.value}' is not allowed`, key.at);
					}
					this.expect(':');
					entries.push([key.value, this.parse(0)]);
					if (!this.isOp('}')) {
						this.expect(',');
					}
				}
				this.expect('}');
				return { k: 'map', entries, at: token.at };
			}
		}
		throw new WorkflowExpressionError(`Unexpected '${token.value}'`, token.at);
	}

	private infix(token: IToken, left: Ast): Ast {
		switch (token.value) {
			case '.': {
				const name = this.next();
				// `items.0` reads like `items[0]`.
				if (name.kind === 'num' && Number.isInteger(name.num)) {
					return { k: 'get', obj: left, key: name.value, at: name.at };
				}
				if (name.kind !== 'name') {
					throw new WorkflowExpressionError('Expected a name after \'.\'', name.at);
				}
				return { k: 'get', obj: left, key: name.value, at: name.at };
			}
			case '[': {
				const index = this.parse(0);
				this.expect(']');
				return { k: 'index', obj: left, index, at: token.at };
			}
			case '(': {
				if (left.k !== 'name') {
					throw new WorkflowExpressionError('Only functions can be called, like len(x)', token.at);
				}
				if (!FUNCTIONS.has(left.name)) {
					throw new WorkflowExpressionError(`Unknown function '${left.name}'`, left.at);
				}
				const args: Ast[] = [];
				while (!this.isOp(')')) {
					args.push(this.parse(0));
					if (!this.isOp(')')) {
						this.expect(',');
					}
				}
				this.expect(')');
				return { k: 'call', name: left.name, args, at: left.at };
			}
			case '?': {
				const then = this.parse(0);
				this.expect(':');
				return { k: 'cond', test: left, then, else: this.parse(TERNARY_POWER - 1), at: token.at };
			}
		}
		return { k: 'binary', op: token.value, left, right: this.parse(BINARY_POWER[token.value]), at: token.at };
	}
}

class ParsedExpression implements IParsedExpression {
	constructor(readonly source: string, readonly ast: Ast) { }
}

/** Parsed sources, so loops and repeated runs do not re-parse. */
const cache = new Map<string, ParsedExpression>();
const CACHE_SIZE = 500;

function parseOrThrow(source: string, base = 0): ParsedExpression {
	const cached = base === 0 ? cache.get(source) : undefined;
	if (cached) {
		return cached;
	}
	if (source.length > EXPRESSION_MAX_SOURCE) {
		throw new WorkflowExpressionError(`Expression is longer than ${EXPRESSION_MAX_SOURCE} characters`, base);
	}
	const tokens = tokenize(source, base);
	if (tokens.length === 1) {
		throw new WorkflowExpressionError('Empty expression', base);
	}
	const parsed = new ParsedExpression(source, new Parser(tokens).parseAll());
	if (base === 0) {
		if (cache.size >= CACHE_SIZE) {
			cache.delete(cache.keys().next().value!);
		}
		cache.set(source, parsed);
	}
	return parsed;
}

/** Parses an expression (`nodes.check.exitCode == 0 && vars.retries < 3`); an error message instead when it does not parse. */
export function parseExpression(source: string): { readonly expression?: IParsedExpression; readonly error?: string; readonly offset?: number } {
	try {
		return { expression: parseOrThrow(source) };
	} catch (error) {
		if (error instanceof WorkflowExpressionError) {
			return { error: error.message, offset: error.offset };
		}
		throw error;
	}
}

//#endregion

//#region Values

type Value = WorkflowValue | undefined;

function isRecord(value: unknown): value is WorkflowRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function ownKeys(record: WorkflowRecord): string[] {
	return Object.keys(record).filter(key => !BLOCKED_KEYS.has(key));
}

/** Own enumerable data only; blocked names are always undefined. */
function member(obj: Value, key: string | number): Value {
	if (typeof key === 'string' && BLOCKED_KEYS.has(key)) {
		return undefined;
	}
	if (Array.isArray(obj) || typeof obj === 'string') {
		if (key === 'length') {
			return obj.length;
		}
		const index = typeof key === 'number' ? key : /^-?\d+$/.test(key) ? Number(key) : NaN;
		if (!Number.isInteger(index)) {
			return undefined;
		}
		const at = index < 0 ? obj.length + index : index;
		return at >= 0 && at < obj.length ? obj[at] : undefined;
	}
	if (isRecord(obj)) {
		const name = String(key);
		return Object.prototype.hasOwnProperty.call(obj, name) && Object.prototype.propertyIsEnumerable.call(obj, name) ? obj[name] : undefined;
	}
	return undefined;
}

function typeName(value: Value): string {
	if (value === undefined || value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'list';
	}
	return typeof value === 'object' ? 'map' : typeof value;
}

function deepEqual(a: Value, b: Value): boolean {
	if (a === undefined || a === null || b === undefined || b === null) {
		return (a ?? null) === (b ?? null);
	}
	if (typeof a !== 'object' || typeof b !== 'object') {
		return a === b;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
	}
	const ak = ownKeys(a as WorkflowRecord);
	const bk = ownKeys(b as WorkflowRecord);
	return ak.length === bk.length && ak.every(key => deepEqual((a as WorkflowRecord)[key], member(b, key)));
}

/** Truthiness the way If nodes read it (empty string, 0, null, false, empty list are false). */
export function isTruthy(value: WorkflowValue | undefined): boolean {
	return !!value && !(Array.isArray(value) && value.length === 0);
}

/** Text for templates and string(): null is empty, maps and lists are compact JSON. */
export function stringifyValue(value: WorkflowValue | undefined): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

/** Rough JSON size of a value; stops counting once past `limit`. */
export function approximateSize(value: WorkflowValue | undefined, limit = Number.MAX_SAFE_INTEGER): number {
	let size = 0;
	const stack: Value[] = [value];
	while (stack.length && size <= limit) {
		const current = stack.pop();
		if (typeof current === 'string') {
			size += current.length + 2;
		} else if (Array.isArray(current)) {
			size += 2 + current.length;
			for (const entry of current) {
				stack.push(entry);
			}
		} else if (current && typeof current === 'object') {
			for (const key of Object.keys(current)) {
				size += key.length + 4;
				stack.push((current as WorkflowRecord)[key]);
			}
			size += 2;
		} else {
			size += 5;
		}
	}
	return size;
}

//#endregion

//#region Evaluation

interface IEvaluation {
	readonly scope: IWorkflowScope;
	readonly now: () => number;
	steps: number;
}

function fail(message: string, at: number): never {
	throw new WorkflowExpressionError(message, at);
}

/** Work proportional to data size (scanning a list) counts against the step cap too. */
function spend(ev: IEvaluation, steps: number, at: number): void {
	ev.steps += steps;
	if (ev.steps > EXPRESSION_MAX_STEPS) {
		fail('Expression took too many steps', at);
	}
}

function checkSize(value: Value, at: number): Value {
	if (typeof value === 'string' ? value.length > EXPRESSION_MAX_RESULT_BYTES : approximateSize(value, EXPRESSION_MAX_RESULT_BYTES) > EXPRESSION_MAX_RESULT_BYTES) {
		fail('Result is larger than 1 MB', at);
	}
	return value;
}

function root(name: string, scope: IWorkflowScope, at: number): Value {
	switch (name) {
		case 'inputs': return scope.inputs;
		case 'trigger': return scope.trigger;
		case 'nodes': return scope.nodes as WorkflowRecord;
		case 'vars': return scope.vars;
		case 'item': return scope.item;
		case 'loop': return scope.loop;
		case 'run': return scope.run as unknown as WorkflowRecord;
		case 'input': return scope.input;
	}
	return fail(`Unknown name '${name}' (use ${EXPRESSION_ROOTS.join(', ')})`, at);
}

function evaluate(ast: Ast, ev: IEvaluation): Value {
	if (++ev.steps > EXPRESSION_MAX_STEPS) {
		fail('Expression took too many steps', ast.at);
	}
	switch (ast.k) {
		case 'lit': return ast.v;
		case 'name': return root(ast.name, ev.scope, ast.at);
		case 'get': return member(evaluate(ast.obj, ev), ast.key);
		case 'index': {
			const obj = evaluate(ast.obj, ev);
			const key = evaluate(ast.index, ev);
			return typeof key === 'string' || typeof key === 'number' ? member(obj, key) : undefined;
		}
		case 'list': return checkSize(ast.items.map(item => evaluate(item, ev) ?? null), ast.at);
		case 'map': {
			const record: Record<string, WorkflowValue> = {};
			for (const [key, value] of ast.entries) {
				record[key] = evaluate(value, ev) ?? null;
			}
			return checkSize(record, ast.at);
		}
		case 'cond': return isTruthy(evaluate(ast.test, ev)) ? evaluate(ast.then, ev) : evaluate(ast.else, ev);
		case 'unary': {
			const value = evaluate(ast.arg, ev);
			if (ast.op === '!') {
				return !isTruthy(value);
			}
			if (typeof value !== 'number') {
				fail(`'${ast.op}' needs a number, not ${typeName(value)}`, ast.at);
			}
			return ast.op === '-' ? -value : value;
		}
		case 'binary': return binary(ast.op, ast.left, ast.right, ev, ast.at);
		case 'call': {
			const fn = FUNCTIONS.get(ast.name)!;
			const args = ast.args.map(arg => evaluate(arg, ev));
			if (args.length < fn.min || args.length > fn.max) {
				const count = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min} to ${fn.max}`;
				fail(`${ast.name}() takes ${count} argument${fn.max === 1 && fn.min === 1 ? '' : 's'}`, ast.at);
			}
			return checkSize(fn.call(args, ev, ast.at), ast.at);
		}
	}
}

function binary(op: string, leftAst: Ast, rightAst: Ast, ev: IEvaluation, at: number): Value {
	const left = evaluate(leftAst, ev);
	// Short-circuit operators return an operand (`a || 'fallback'`), like JS and GitHub expressions.
	switch (op) {
		case '&&': return isTruthy(left) ? evaluate(rightAst, ev) : left;
		case '||': return isTruthy(left) ? left : evaluate(rightAst, ev);
		case '??': return left === undefined || left === null ? evaluate(rightAst, ev) : left;
	}
	const right = evaluate(rightAst, ev);
	switch (op) {
		case '==': return deepEqual(left, right);
		case '!=': return !deepEqual(left, right);
		case '<': case '<=': case '>': case '>=': {
			// Mismatched types compare false instead of throwing: conditions over missing outputs stay usable.
			if (!((typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string'))) {
				return false;
			}
			return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
		}
		case 'in': {
			if (Array.isArray(right)) {
				spend(ev, right.length, at);
				return right.some(entry => deepEqual(left, entry));
			}
			if (typeof right === 'string') {
				return right.includes(stringifyValue(left));
			}
			if (isRecord(right)) {
				return (typeof left === 'string' || typeof left === 'number') && member(right, left) !== undefined;
			}
			if (right === undefined || right === null) {
				return false;
			}
			return fail(`'in' needs a list, text or map on the right, not ${typeName(right)}`, at);
		}
		case '+': {
			if (typeof left === 'number' && typeof right === 'number') {
				return finite(left + right, at);
			}
			if (typeof left === 'string' || typeof right === 'string') {
				const text = stringifyValue(left) + stringifyValue(right);
				return checkSize(text, at);
			}
			if (Array.isArray(left) && Array.isArray(right)) {
				return checkSize([...left, ...right], at);
			}
			return fail(`Cannot add ${typeName(left)} and ${typeName(right)}`, at);
		}
		case '-': case '*': case '/': case '%': {
			if (typeof left !== 'number' || typeof right !== 'number') {
				return fail(`'${op}' needs numbers, not ${typeName(left)} and ${typeName(right)}`, at);
			}
			if ((op === '/' || op === '%') && right === 0) {
				return fail('Division by zero', at);
			}
			return finite(op === '-' ? left - right : op === '*' ? left * right : op === '/' ? left / right : left % right, at);
		}
	}
	return fail(`Unknown operator '${op}'`, at);
}

function finite(value: number, at: number): number {
	return Number.isFinite(value) ? value : fail('Number out of range', at);
}

//#endregion

//#region Functions

interface IFunction {
	readonly min: number;
	readonly max: number;
	call(args: readonly Value[], ev: IEvaluation, at: number): Value;
}

function text(value: Value): string {
	return stringifyValue(value);
}

function num(value: Value, name: string, at: number): number {
	return typeof value === 'number' ? value : fail(`${name}() needs a number, not ${typeName(value)}`, at);
}

function numbersOf(args: readonly Value[], name: string, at: number): number[] {
	const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
	return list.map(value => num(value, name, at));
}

/**
 * Patterns that can backtrack exponentially are rejected: a repeated group whose body repeats too
 * (`(a+)+`, `(\w*\s?)*`), and back-references. Character classes and escapes are skipped over.
 */
function unsafePattern(source: string): string | undefined {
	if (/\\[1-9]|\\k</.test(source)) {
		return 'Back-references are not allowed';
	}
	const groups: boolean[] = [false];
	const repeats = (at: number) => source[at] === '*' || source[at] === '+' || source[at] === '{';
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === '\\') {
			i++;
		} else if (ch === '[') {
			for (i++; i < source.length && source[i] !== ']'; i++) {
				if (source[i] === '\\') {
					i++;
				}
			}
		} else if (ch === '(') {
			groups.push(false);
		} else if (ch === ')') {
			const inner = groups.length > 1 ? groups.pop()! : false;
			if (repeats(i + 1) && inner) {
				return 'Nested repetition like (a+)+ can hang; simplify the pattern';
			}
			groups[groups.length - 1] ||= inner || repeats(i + 1);
		} else if (repeats(i)) {
			groups[groups.length - 1] = true;
		}
	}
	return undefined;
}

function regex(pattern: Value, flags: Value, at: number): RegExp {
	const source = text(pattern);
	if (source.length > MAX_REGEX_SOURCE) {
		fail(`Pattern is longer than ${MAX_REGEX_SOURCE} characters`, at);
	}
	const flagText = flags === undefined || flags === null ? '' : text(flags);
	if (!/^[imsu]*$/.test(flagText)) {
		fail('Pattern flags may only be i, m, s and u', at);
	}
	const unsafe = unsafePattern(source);
	if (unsafe) {
		fail(unsafe, at);
	}
	try {
		return new RegExp(source, flagText);
	} catch (error) {
		return fail(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, at);
	}
}

function toTime(value: Value, ev: IEvaluation, at: number): number {
	if (value === undefined || value === null) {
		return ev.now();
	}
	const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(time) ? time : fail(`Not a date: ${text(value)}`, at);
}

function formatDate(time: number, format: string): string {
	const date = new Date(time);
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	const parts: { readonly [token: string]: string } = {
		YYYY: String(date.getUTCFullYear()), MM: pad(date.getUTCMonth() + 1), DD: pad(date.getUTCDate()),
		HH: pad(date.getUTCHours()), mm: pad(date.getUTCMinutes()), ss: pad(date.getUTCSeconds()), SSS: pad(date.getUTCMilliseconds(), 3),
	};
	return format.replace(/YYYY|MM|DD|HH|mm|SSS|ss/g, token => parts[token]);
}

const FUNCTIONS = new Map<string, IFunction>([
	['len', {
		min: 1, max: 1, call: ([value], _ev, at) => {
			if (value === undefined || value === null) {
				return 0;
			}
			if (typeof value === 'string' || Array.isArray(value)) {
				return value.length;
			}
			return isRecord(value) ? ownKeys(value).length : fail(`len() needs text, a list or a map, not ${typeName(value)}`, at);
		}
	}],
	['lower', { min: 1, max: 1, call: ([value]) => text(value).toLowerCase() }],
	['upper', { min: 1, max: 1, call: ([value]) => text(value).toUpperCase() }],
	['trim', { min: 1, max: 1, call: ([value]) => text(value).trim() }],
	['contains', {
		min: 2, max: 2, call: ([haystack, needle], ev, at) => {
			if (Array.isArray(haystack)) {
				spend(ev, haystack.length, at);
				return haystack.some(entry => deepEqual(entry, needle));
			}
			if (isRecord(haystack)) {
				return (typeof needle === 'string' || typeof needle === 'number') && member(haystack, needle) !== undefined;
			}
			return haystack !== undefined && haystack !== null && text(haystack).includes(text(needle));
		}
	}],
	['startsWith', { min: 2, max: 2, call: ([value, prefix]) => text(value).startsWith(text(prefix)) }],
	['endsWith', { min: 2, max: 2, call: ([value, suffix]) => text(value).endsWith(text(suffix)) }],
	['matches', {
		min: 2, max: 3, call: ([value, pattern, flags], ev, at) => {
			const subject = text(value);
			if (subject.length > MAX_REGEX_TEXT) {
				fail(`Text is too long to match (over ${MAX_REGEX_TEXT} characters)`, at);
			}
			spend(ev, Math.ceil(subject.length / 100), at);
			return regex(pattern, flags, at).test(subject);
		}
	}],
	['replace', {
		min: 3, max: 3, call: ([value, search, replacement], _ev, at) => {
			const subject = text(value);
			const find = text(search);
			return find ? checkSize(subject.split(find).join(text(replacement)), at) : subject;
		}
	}],
	['split', {
		min: 1, max: 2, call: ([value, separator], ev, at) => {
			const parts = text(value).split(separator === undefined || separator === null ? ',' : text(separator), MAX_SPLIT_PARTS);
			spend(ev, parts.length, at);
			return parts;
		}
	}],
	['join', {
		min: 1, max: 2, call: ([value, separator], ev, at) => {
			if (!Array.isArray(value)) {
				return value === undefined || value === null ? '' : fail(`join() needs a list, not ${typeName(value)}`, at);
			}
			spend(ev, value.length, at);
			return checkSize(value.map(entry => text(entry)).join(separator === undefined || separator === null ? ',' : text(separator)), at);
		}
	}],
	['json', { min: 1, max: 2, call: ([value, indent]) => JSON.stringify(value ?? null, undefined, typeof indent === 'number' ? Math.max(0, Math.min(8, indent)) : undefined) }],
	['parseJson', {
		min: 1, max: 1, call: ([value], _ev, at) => {
			if (typeof value !== 'string') {
				return value ?? null;
			}
			try {
				return JSON.parse(value) as WorkflowValue;
			} catch (error) {
				return fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, at);
			}
		}
	}],
	['number', {
		min: 1, max: 1, call: ([value]) => {
			if (typeof value === 'number') {
				return value;
			}
			if (typeof value === 'boolean') {
				return value ? 1 : 0;
			}
			if (typeof value === 'string' && value.trim()) {
				const parsed = Number(value.trim());
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		}
	}],
	['string', { min: 1, max: 1, call: ([value]) => text(value) }],
	['bool', { min: 1, max: 1, call: ([value]) => typeof value === 'string' ? !/^\s*(false|0|no|off|)\s*$/i.test(value) : isTruthy(value) }],
	['default', { min: 2, max: Infinity, call: args => args.find(value => value !== undefined && value !== null && value !== '') ?? args[args.length - 1] ?? null }],
	['coalesce', { min: 1, max: Infinity, call: args => args.find(value => value !== undefined && value !== null) ?? null }],
	['keys', {
		min: 1, max: 1, call: ([value]) => isRecord(value) ? ownKeys(value) : Array.isArray(value) ? value.map((_, i) => i) : []
	}],
	['values', {
		min: 1, max: 1, call: ([value]) => isRecord(value) ? ownKeys(value).map(key => value[key]) : Array.isArray(value) ? value : []
	}],
	['first', { min: 1, max: 1, call: ([value]) => member(value, 0) ?? null }],
	['last', { min: 1, max: 1, call: ([value]) => member(value, -1) ?? null }],
	['slice', {
		min: 2, max: 3, call: ([value, start, end], _ev, at) => {
			const from = num(start, 'slice', at);
			const to = end === undefined || end === null ? undefined : num(end, 'slice', at);
			if (typeof value === 'string' || Array.isArray(value)) {
				return value.slice(from, to);
			}
			return value === undefined || value === null ? null : fail(`slice() needs text or a list, not ${typeName(value)}`, at);
		}
	}],
	['round', {
		min: 1, max: 2, call: ([value, digits], _ev, at) => {
			const places = digits === undefined || digits === null ? 0 : Math.max(0, Math.min(10, Math.trunc(num(digits, 'round', at))));
			const factor = 10 ** places;
			return Math.round(num(value, 'round', at) * factor) / factor;
		}
	}],
	['floor', { min: 1, max: 1, call: ([value], _ev, at) => Math.floor(num(value, 'floor', at)) }],
	['ceil', { min: 1, max: 1, call: ([value], _ev, at) => Math.ceil(num(value, 'ceil', at)) }],
	['abs', { min: 1, max: 1, call: ([value], _ev, at) => Math.abs(num(value, 'abs', at)) }],
	['min', { min: 1, max: Infinity, call: (args, _ev, at) => { const list = numbersOf(args, 'min', at); return list.length ? Math.min(...list) : null; } }],
	['max', { min: 1, max: Infinity, call: (args, _ev, at) => { const list = numbersOf(args, 'max', at); return list.length ? Math.max(...list) : null; } }],
	['now', { min: 0, max: 0, call: (_args, ev) => ev.now() }],
	['date', {
		min: 0, max: 2, call: ([value, format], ev, at) => {
			const time = toTime(value, ev, at);
			return format === undefined || format === null ? new Date(time).toISOString() : formatDate(time, text(format));
		}
	}],
]);

//#endregion

/** Evaluates an expression against the scope. Throws WorkflowExpressionError. */
export function evaluateExpression(expression: string | IParsedExpression, scope: IWorkflowScope, options?: IExpressionOptions): WorkflowValue {
	const parsed = expression instanceof ParsedExpression ? expression : parseOrThrow(typeof expression === 'string' ? expression : expression.source);
	return run(parsed.ast, scope, options);
}

function run(ast: Ast, scope: IWorkflowScope, options: IExpressionOptions | undefined): WorkflowValue {
	const ev: IEvaluation = { scope, now: options?.now ?? Date.now, steps: 0 };
	return checkSize(evaluate(ast, ev), ast.at) ?? null;
}

//#region Templates

interface ITemplatePart {
	readonly text?: string;
	readonly ast?: Ast;
}

interface IParsedTemplate {
	readonly parts: readonly ITemplatePart[];
	/** The text is one template and nothing else (whitespace aside). */
	readonly single: boolean;
}

const templateCache = new Map<string, IParsedTemplate>();

/** Splits `a {{ x }} b` into text and expressions; the `}}` is found outside strings and maps. */
function parseTemplate(source: string): IParsedTemplate {
	const cached = templateCache.get(source);
	if (cached) {
		return cached;
	}
	const parts: ITemplatePart[] = [];
	let i = 0;
	while (i < source.length) {
		const open = source.indexOf('{{', i);
		if (open < 0) {
			parts.push({ text: source.slice(i) });
			break;
		}
		if (open > i) {
			parts.push({ text: source.slice(i, open) });
		}
		const start = open + 2;
		let depth = 0;
		let quote: string | undefined;
		let close = -1;
		for (let j = start; j < source.length; j++) {
			const ch = source[j];
			if (quote) {
				if (ch === '\\') {
					j++;
				} else if (ch === quote) {
					quote = undefined;
				}
			} else if (ch === '\'' || ch === '"') {
				quote = ch;
			} else if (ch === '{') {
				depth++;
			} else if (ch === '}') {
				if (depth === 0 && source[j + 1] === '}') {
					close = j;
					break;
				}
				depth--;
			}
		}
		if (close < 0) {
			throw new WorkflowExpressionError('Unclosed {{', open);
		}
		const inner = source.slice(start, close);
		if (!inner.trim()) {
			throw new WorkflowExpressionError('Empty {{ }}', open);
		}
		parts.push({ ast: parseOrThrow(inner, start).ast });
		i = close + 2;
	}
	const expressions = parts.filter(part => part.ast);
	const parsed: IParsedTemplate = { parts, single: expressions.length === 1 && parts.every(part => part.ast || !part.text!.trim()) };
	if (templateCache.size >= CACHE_SIZE) {
		templateCache.delete(templateCache.keys().next().value!);
	}
	templateCache.set(source, parsed);
	return parsed;
}

export function hasTemplates(text: string): boolean {
	return text.includes('{{');
}

/** The first problem in a template string, or undefined when every `{{ }}` parses. */
export function checkTemplate(text: string): WorkflowExpressionError | undefined {
	if (!hasTemplates(text)) {
		return undefined;
	}
	try {
		parseTemplate(text);
		return undefined;
	} catch (error) {
		if (error instanceof WorkflowExpressionError) {
			return error;
		}
		throw error;
	}
}

/**
 * Resolves `{{ expr }}` templates inside a value, deeply (strings in lists and maps too). A string
 * that is exactly one template keeps the value's type (`"{{ nodes.a.count }}"` → 3).
 */
export function resolveTemplates(value: WorkflowValue, scope: IWorkflowScope, options?: IExpressionOptions): WorkflowValue {
	if (typeof value === 'string') {
		if (!hasTemplates(value)) {
			return value;
		}
		const template = parseTemplate(value);
		if (template.single) {
			return run(template.parts.find(part => part.ast)!.ast!, scope, options);
		}
		return renderParts(template, scope, options);
	}
	if (Array.isArray(value)) {
		return value.map(entry => resolveTemplates(entry, scope, options));
	}
	if (isRecord(value)) {
		const record: Record<string, WorkflowValue> = {};
		for (const key of ownKeys(value)) {
			record[key] = resolveTemplates(value[key], scope, options);
		}
		return record;
	}
	return value;
}

/** Renders a template string to text (values are stringified; objects as compact JSON). */
export function renderTemplate(text: string, scope: IWorkflowScope, options?: IExpressionOptions): string {
	return hasTemplates(text) ? renderParts(parseTemplate(text), scope, options) : text;
}

function renderParts(template: IParsedTemplate, scope: IWorkflowScope, options: IExpressionOptions | undefined): string {
	let out = '';
	for (const part of template.parts) {
		out += part.ast ? stringifyValue(run(part.ast, scope, options)) : part.text;
		if (out.length > EXPRESSION_MAX_RESULT_BYTES) {
			throw new WorkflowExpressionError('Result is larger than 1 MB', 0);
		}
	}
	return out;
}

/** A static path (`nodes.work.summary`, `a['b']`, `a[0]`), or undefined when computed. */
function pathOf(ast: Ast): string[] | undefined {
	if (ast.k === 'name') {
		return [ast.name];
	}
	if (ast.k === 'get') {
		const base = pathOf(ast.obj);
		return base && [...base, ast.key];
	}
	if (ast.k === 'index' && ast.index.k === 'lit' && (typeof ast.index.v === 'string' || typeof ast.index.v === 'number')) {
		const base = pathOf(ast.obj);
		return base && [...base, String(ast.index.v)];
	}
	return undefined;
}

function collectReferences(ast: Ast, into: Set<string>): void {
	switch (ast.k) {
		case 'name': case 'get': case 'index': {
			const path = pathOf(ast);
			if (path) {
				into.add(path.join('.'));
			} else if (ast.k !== 'name') {
				collectReferences(ast.obj, into);
				if (ast.k === 'index') {
					collectReferences(ast.index, into);
				}
			}
			return;
		}
		case 'call': ast.args.forEach(arg => collectReferences(arg, into)); return;
		case 'unary': collectReferences(ast.arg, into); return;
		case 'binary': collectReferences(ast.left, into); collectReferences(ast.right, into); return;
		case 'cond': collectReferences(ast.test, into); collectReferences(ast.then, into); collectReferences(ast.else, into); return;
		case 'list': ast.items.forEach(item => collectReferences(item, into)); return;
		case 'map': ast.entries.forEach(([, value]) => collectReferences(value, into)); return;
	}
}

/** The scope paths a template string refers to (`nodes.work.summary`), for validation and autocomplete. */
export function templateReferences(text: string): readonly string[] {
	if (!hasTemplates(text)) {
		return [];
	}
	const into = new Set<string>();
	try {
		for (const part of parseTemplate(text).parts) {
			if (part.ast) {
				collectReferences(part.ast, into);
			}
		}
	} catch {
		// Unparsable templates have no references; validation reports the syntax error.
	}
	return [...into];
}

/** The scope paths a bare expression refers to (If conditions, loop `while`). */
export function expressionReferences(source: string): readonly string[] {
	const into = new Set<string>();
	try {
		collectReferences(parseOrThrow(source).ast, into);
	} catch {
		// As above.
	}
	return [...into];
}

//#endregion

//#region Suggestions

export type WorkflowScopeSuggestionKind = 'input' | 'trigger' | 'node' | 'variable' | 'loop' | 'run' | 'function';

export interface IWorkflowScopeSuggestion {
	/** What to insert inside `{{ }}` (`nodes.check.exitCode`). */
	readonly path: string;
	readonly kind: WorkflowScopeSuggestionKind;
	readonly description?: string;
	/** The upstream node a `node` suggestion reads. */
	readonly nodeId?: string;
}

const LOOP_CONTROLS = new Set(['loop', 'forEach']);

/** Keys of a sample payload, flattened a few levels deep (`trigger.payload.pull_request.title`). */
function payloadPaths(value: WorkflowValue | undefined, prefix: string, depth: number, into: IWorkflowScopeSuggestion[]): void {
	if (!isRecord(value) || depth > 3 || into.length > 200) {
		return;
	}
	for (const key of ownKeys(value).slice(0, 40)) {
		const path = /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${prefix}.${key}` : `${prefix}['${key.replace(/'/g, '\\\'')}']`;
		const entry = value[key];
		into.push({ path, kind: 'trigger', description: Array.isArray(entry) ? 'list' : isRecord(entry) ? 'map' : typeof entry === 'string' ? entry.slice(0, 60) : stringifyValue(entry) });
		payloadPaths(entry, path, depth + 1, into);
	}
}

/**
 * Paths a node's templates can read: workflow inputs, nodes upstream of it (with their output
 * docs, nearest first), variables (initial and Set Variables upstream), `item` / `loop` inside
 * a loop or for-each body, the trigger payload and the run. For the inspector's autocomplete.
 */
export function scopeSuggestions(definition: IWorkflowDefinition, nodeId: string): readonly IWorkflowScopeSuggestion[] {
	const suggestions: IWorkflowScopeSuggestion[] = [{ path: 'input', kind: 'node', description: 'The previous node\'s output (a record by node id after a join)' }];
	for (const input of definition.inputs ?? []) {
		suggestions.push({ path: `inputs.${input.name}`, kind: 'input', description: input.description ?? input.type });
	}

	// Upstream nodes, breadth first from the node backwards, so the nearest come first.
	const incoming = new Map<string, string[]>();
	for (const edge of definition.edges) {
		incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
	}
	const byId = new Map(definition.nodes.map(node => [node.id, node]));
	const upstream: string[] = [];
	const seen = new Set<string>([nodeId]);
	const queue = [...(incoming.get(nodeId) ?? [])];
	while (queue.length) {
		const id = queue.shift()!;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		upstream.push(id);
		queue.push(...(incoming.get(id) ?? []));
	}

	const variables = new Set(Object.keys(definition.variables ?? {}));
	let inLoop = false;
	for (const id of upstream) {
		const node = byId.get(id);
		const type = node && getWorkflowNodeType(node.type);
		if (!node || !type) {
			continue;
		}
		if (LOOP_CONTROLS.has(type.control)) {
			inLoop = true;
		}
		if (type.control === 'setVariables' && isRecord(node.config.variables)) {
			ownKeys(node.config.variables).forEach(key => variables.add(key));
		}
		if (type.control === 'start') {
			continue;
		}
		const name = node.name?.trim() || type.label;
		suggestions.push({ path: `nodes.${id}`, kind: 'node', nodeId: id, description: `${name}: the whole output` });
		for (const doc of type.outputDocs) {
			suggestions.push({ path: `nodes.${id}.${doc.key}`, kind: 'node', nodeId: id, description: doc.description });
		}
		// Transform outputs exactly the fields it defines.
		if (node.type === 'transform' && isRecord(node.config.fields)) {
			for (const key of ownKeys(node.config.fields)) {
				suggestions.push({ path: `nodes.${id}.${key}`, kind: 'node', nodeId: id, description: `${name}: field` });
			}
		}
	}
	for (const name of variables) {
		suggestions.push({ path: `vars.${name}`, kind: 'variable', description: 'Run variable' });
	}
	if (inLoop) {
		suggestions.push(
			{ path: 'item', kind: 'loop', description: 'For each: the current item' },
			{ path: 'loop.index', kind: 'loop', description: 'The current pass, from 0' },
			{ path: 'loop.iteration', kind: 'loop', description: 'The current pass, from 1' },
			{ path: 'loop.max', kind: 'loop', description: 'The number of passes allowed' },
		);
	}
	suggestions.push({ path: 'trigger.payload', kind: 'trigger', description: 'The trigger payload' }, { path: 'trigger.kind', kind: 'trigger', description: 'manual, schedule, event, automation, subworkflow or agent' });
	payloadPaths(definition.trigger.samplePayload, 'trigger.payload', 0, suggestions);
	suggestions.push(
		{ path: 'run.id', kind: 'run', description: 'This run\'s id' },
		{ path: 'run.mode', kind: 'run', description: 'simulate or execute' },
		{ path: 'run.workflowId', kind: 'run', description: 'This workflow\'s id' },
	);
	return suggestions;
}

//#endregion
