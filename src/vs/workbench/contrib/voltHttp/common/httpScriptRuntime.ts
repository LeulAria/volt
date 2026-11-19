/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs a request's script (Postman's pre-request and test scripts, an `.http` file's `> {% %}`
 * handler) and returns its tests, logs and what it changed. `httpScriptRun` is one function
 * with nothing outside it in scope: its text is the body of the worker the scripts run in
 * (`httpScriptWorkerSource`), so a collection's code never runs in the window.
 * `httpScriptRuntime` is that function, after the script got its breakpoints.
 */

import { instrumentHttpScript } from './httpScriptBreakpoints.js';

export interface IHttpScriptRequest {
	name: string;
	method: string;
	url: string;
	headers: [string, string][];
	body?: string;
}

export interface IHttpScriptResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	durationMs: number;
	size: number;
}

export interface IHttpScriptVariables {
	environment: Record<string, string>;
	collection: Record<string, string>;
	globals: Record<string, string>;
	local: Record<string, string>;
}

export interface IHttpScriptInput {
	script: string;
	phase: 'preRequest' | 'test';
	request: IHttpScriptRequest;
	response?: IHttpScriptResponse;
	variables: IHttpScriptVariables;
	iteration?: number;
	environmentName?: string;
	/**
	 * The script already compiled, taking the names `httpScriptNames()` lists: where a page's
	 * Trusted Types forbid `new Function` (Volt's window, and the workers it starts), the worker's
	 * own source carries the script as a function instead.
	 */
	compiled?: (...args: unknown[]) => unknown;
	/** Answers with the names a compiled script takes (as its logs) and runs nothing. */
	namesOnly?: boolean;
	/**
	 * Run only the tests with these names: the script itself still runs from the top (its variables
	 * and helpers are there), but any other test's body is not called and it is not reported.
	 */
	onlyTests?: readonly string[];
	/**
	 * Report what each test did: its duration, its assertions, the expected and actual values and
	 * the script line of a failure, and which test a console line came from. Without it the tests
	 * and logs carry only their name, outcome and text.
	 */
	detail?: boolean;
	/**
	 * 1-based lines to record the variables at, every time one is about to run (a script cannot be
	 * paused: see `httpScriptBreakpoints.ts`). Each snaps to the nearest line a statement begins on.
	 */
	breakpoints?: number[];
	/** The lines `breakpoints` landed on. Set by whoever put the breakpoints in the script, not by the caller. */
	breakpointLines?: number[];
	/** How many lines sit above the script's first line in the source it was compiled in. Set by the worker. */
	scriptLine?: number;
}

/** One `pm.expect(...)` check (or `client.assert`) made inside a test. */
export interface IHttpScriptAssertion {
	passed: boolean;
	/** What was checked, as a failure would word it: "expected 7 to equal 8". */
	message: string;
	/** Readable previews (JSON for objects), when the check compares values. */
	expected?: string;
	actual?: string;
	/** `equal`, `deep equal`, `above`, `not include`... */
	operator?: string;
}

export interface IHttpScriptTest {
	name: string;
	passed: boolean;
	skipped?: boolean;
	error?: string;
	/** The rest is there with `detail`. */
	durationMs?: number;
	/** The first 50 assertions the test made, in order. */
	assertions?: IHttpScriptAssertion[];
	/** How many it made, when more than `assertions` holds. */
	assertionCount?: number;
	/** Of the assertion that failed, when it compares values. */
	expected?: string;
	actual?: string;
	/** The 1-based line of the script the failure was thrown from, when the engine tells. */
	errorLine?: number;
}

export interface IHttpScriptLog {
	level: 'log' | 'info' | 'warn' | 'error';
	text: string;
	/** The test that was running (with `detail`). */
	test?: string;
}

/** A value at a breakpoint: a line of the variables tree. */
export interface IHttpScriptValue {
	name: string;
	/** `string`, `number`, `array`, `object`, a class's name, `uninitialised` for a `let` not reached yet. */
	type: string;
	preview: string;
	children?: IHttpScriptValue[];
}

/** What was in reach when a breakpoint's line was about to run. */
export interface IHttpScriptBreak {
	line: number;
	/** 1 for the first stop of the run, 2 for the next... */
	order: number;
	/** The nth time this line stopped. */
	hit: number;
	/** The test that was running. */
	test?: string;
	/** "Local", "Response" (test phase), "Request", "Variables". */
	scopes: { name: string; variables: IHttpScriptValue[] }[];
}

export interface IHttpScriptOutput {
	tests: IHttpScriptTest[];
	logs: IHttpScriptLog[];
	/** What the script threw outside a test (a syntax error too). */
	error?: string;
	/** The 1-based line of the script `error` was thrown from, when the engine tells (with `detail`). */
	errorLine?: number;
	/** The stops, in the order they happened, when the script had breakpoints (200 at most). */
	breaks?: IHttpScriptBreak[];
	/** The lines the breakpoints were on. */
	breakpointLines?: number[];
	/** More than 200 stops happened: the rest were not recorded. */
	breaksCapped?: boolean;
	variables: IHttpScriptVariables;
	/** The request after a pre-request script changed it. */
	request: IHttpScriptRequest;
	/** `setNextRequest`: a request's name, null to stop the run, undefined when not called. */
	nextRequest?: string | null;
}

/**
 * Self-contained on purpose: no imports, module constants or helpers are used inside, so
 * `toString()` of it runs anywhere (see `httpScriptWorkerSource`). Synchronous: a script's
 * promises and timers are not awaited. Never throws.
 */
function httpScriptRun(input: IHttpScriptInput): IHttpScriptOutput {
	type Dyn = Record<string, unknown>;
	type Fn = (...args: unknown[]) => unknown;

	const MAX_LOGS = 200;
	const MAX_LOG_CHARS = 4000;
	const MAX_STOPS = 200;
	const MAX_ASSERTIONS = 50;
	const MAX_CHILDREN = 60;
	const MAX_DEPTH = 4;
	const tests: IHttpScriptTest[] = [];
	const logs: IHttpScriptLog[] = [];
	const breaks: IHttpScriptBreak[] = [];
	const breakLines = input && Array.isArray(input.breakpointLines) ? input.breakpointLines.map(Number) : undefined;
	let breaksCapped = false;
	let failure: string | undefined;
	let failureLine: number | undefined;
	let nextRequest: string | null | undefined;

	const record = (source: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		if (source && typeof source === 'object') {
			for (const key of Object.keys(source)) {
				out[key] = String((source as Dyn)[key]);
			}
		}
		return out;
	};
	const given = (input && input.variables ? input.variables : {}) as Partial<IHttpScriptVariables>;
	const variables: IHttpScriptVariables = {
		environment: record(given.environment),
		collection: record(given.collection),
		globals: record(given.globals),
		local: record(given.local),
	};
	const givenRequest = (input && input.request ? input.request : {}) as Partial<IHttpScriptRequest>;
	const request: IHttpScriptRequest = {
		name: String(givenRequest.name ?? ''),
		method: String(givenRequest.method ?? 'GET'),
		url: String(givenRequest.url ?? ''),
		headers: (Array.isArray(givenRequest.headers) ? givenRequest.headers : []).map(pair => [String(pair[0]), String(pair[1])] as [string, string]),
		...(givenRequest.body !== undefined ? { body: String(givenRequest.body) } : {}),
	};
	const phase = input && input.phase === 'preRequest' ? 'preRequest' : 'test';
	const response = phase === 'test' && input ? input.response : undefined;
	const output = (): IHttpScriptOutput => ({
		tests, logs, ...(failure !== undefined ? { error: failure } : {}), ...(failureLine !== undefined ? { errorLine: failureLine } : {}), variables, request, ...(nextRequest !== undefined ? { nextRequest } : {}),
		...(breakLines ? { breaks, breakpointLines: breakLines, ...(breaksCapped ? { breaksCapped: true } : {}) } : {}),
	});

	try {
		const messageOf = (err: unknown): string => err instanceof Error ? (err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message) : String(err);
		const typeOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : value instanceof RegExp ? 'regexp' : value instanceof Date ? 'date' : typeof value;
		const json = (value: unknown): string => {
			try {
				const text = JSON.stringify(value);
				return text === undefined ? String(value) : text;
			} catch {
				return String(value);
			}
		};
		/** A value in a failure message. */
		const show = (value: unknown): string => {
			const text = typeof value === 'string' ? `'${value}'` : typeof value === 'function' ? '[Function]' : value instanceof RegExp || value instanceof Error ? String(value) : value !== null && typeof value === 'object' ? json(value) : String(value);
			return text.length > 240 ? `${text.slice(0, 240)}...` : text;
		};
		/** A value in a log line or a variable. */
		const plain = (value: unknown): string => typeof value === 'string' ? value : value instanceof Error ? messageOf(value) : value !== null && typeof value === 'object' ? json(value) : String(value);
		const deepEqual = (a: unknown, b: unknown): boolean => {
			if (a === b) {
				return true;
			}
			if (typeof a === 'number' && typeof b === 'number') {
				return a !== a && b !== b;
			}
			if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
				return false;
			}
			if (a instanceof Date || b instanceof Date) {
				return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
			}
			if (a instanceof RegExp || b instanceof RegExp) {
				return String(a) === String(b);
			}
			if (Array.isArray(a) !== Array.isArray(b)) {
				return false;
			}
			const keysA = Object.keys(a);
			const keysB = Object.keys(b);
			if (keysA.length !== keysB.length) {
				return false;
			}
			for (const key of keysA) {
				if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual((a as Dyn)[key], (b as Dyn)[key])) {
					return false;
				}
			}
			return true;
		};
		const headerOf = (headers: readonly (readonly [string, string])[], name: unknown): string | undefined => {
			const lower = String(name).toLowerCase();
			const found = headers.find(pair => pair[0].toLowerCase() === lower);
			return found ? found[1] : undefined;
		};
		// --- What a test did (with `detail`) ---------------------------------------------------------

		const detailed = !!(input && input.detail);
		/** The test whose body is running. */
		let current: { name: string; assertions: IHttpScriptAssertion[]; count: number } | undefined;
		/** The assertion that threw last: a test that fails with this very error reports its values. */
		let lastFailure: { error: Error; expected?: string; actual?: string } | undefined;
		const now = (): number => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
		/** A value next to "Expected" or "Actual": JSON over several lines for objects. */
		const preview = (value: unknown): string => {
			let text: string;
			if (typeof value === 'string') {
				text = value.indexOf('\n') >= 0 ? value : JSON.stringify(value);
			} else if (typeof value === 'function') {
				text = `[Function${value.name ? ` ${value.name}` : ''}]`;
			} else if (value instanceof RegExp || value instanceof Error) {
				text = String(value);
			} else if (value instanceof Date) {
				text = value.getTime() !== value.getTime() ? 'Invalid Date' : value.toISOString();
			} else if (value !== null && typeof value === 'object') {
				try {
					const pretty = JSON.stringify(value, null, 2);
					text = pretty === undefined ? String(value) : pretty;
				} catch {
					text = String(value);
				}
			} else {
				text = String(value);
			}
			return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
		};
		const asserted = (passed: boolean, message: string, about: { expected?: string; actual?: string; operator?: string }): void => {
			if (detailed && current) {
				current.count++;
				if (current.assertions.length < MAX_ASSERTIONS) {
					current.assertions.push({ passed, message, ...about });
				}
			}
		};
		// A script's first line sits under two lines of `new Function`'s own, or under the worker's source.
		const compiledRun = !!input && typeof input.compiled === 'function';
		const lineBase = compiledRun ? Number(input.scriptLine) : 2;
		const lineCount = String((input && input.script) ?? '').split('\n').length;
		/** The line of the script an error was thrown from: the first frame of its stack that is inside the script. */
		const lineOf = (err: unknown): number | undefined => {
			const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
			if (!stack || lineBase !== lineBase) {
				return undefined;
			}
			for (const frame of stack.split('\n')) {
				const found = /:(\d+):\d+\)?\s*$/.exec(frame);
				if (!found || (!compiledRun && frame.indexOf('<anonymous>:') < 0)) {
					continue;
				}
				const line = Number(found[1]) - lineBase;
				if (line >= 1 && line <= lineCount) {
					return line;
				}
			}
			return undefined;
		};

		const log = (level: IHttpScriptLog['level'], args: readonly unknown[]): void => {
			if (logs.length < MAX_LOGS) {
				const text = args.map(plain).join(' ');
				logs.push({ level, text: text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}...` : text, ...(detailed && current ? { test: current.name } : {}) });
			}
		};

		// --- Variables ----------------------------------------------------------------------------

		const lookup = (name: string): string | undefined => {
			for (const store of [variables.local, variables.environment, variables.collection, variables.globals]) {
				if (Object.prototype.hasOwnProperty.call(store, name)) {
					return store[name];
				}
			}
			return undefined;
		};
		const replaceIn = (text: unknown): string => String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole: string, name: string) => {
			if (name === '$guid' || name === '$randomUUID') {
				return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
					const random = Math.floor(Math.random() * 16);
					return (char === 'x' ? random : (random % 4) + 8).toString(16);
				});
			}
			if (name === '$timestamp') {
				return String(Math.floor(Date.now() / 1000));
			}
			if (name === '$isoTimestamp') {
				return new Date().toISOString();
			}
			if (name === '$randomInt') {
				return String(Math.floor(Math.random() * 1000));
			}
			const value = lookup(name);
			return value === undefined ? whole : value;
		});
		const scope = (store: Record<string, string>, read: (name: string) => string | undefined, all: () => Record<string, string>) => ({
			get: (name: unknown) => read(String(name)),
			set: (name: unknown, value: unknown) => { store[String(name)] = plain(value); },
			unset: (name: unknown) => { delete store[String(name)]; },
			has: (name: unknown) => read(String(name)) !== undefined,
			clear: () => {
				for (const key of Object.keys(store)) {
					delete store[key];
				}
			},
			toObject: all,
			replaceIn,
		});
		const own = (store: Record<string, string>) => scope(store, name => Object.prototype.hasOwnProperty.call(store, name) ? store[name] : undefined, () => ({ ...store }));
		const environment = Object.assign(own(variables.environment), { name: String((input && input.environmentName) ?? '') });
		const collectionVariables = own(variables.collection);
		const globals = own(variables.globals);
		const local = scope(variables.local, lookup, () => ({ ...variables.globals, ...variables.collection, ...variables.environment, ...variables.local }));

		// --- The request ----------------------------------------------------------------------------

		const urlParts = () => /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(request.url) ?? [];
		const pmUrl = {
			toString: () => request.url,
			getRaw: () => request.url,
			getHost: () => String(urlParts()[2] ?? '').replace(/:\d+$/, ''),
			getPath: () => String(urlParts()[3] ?? '') || '/',
			getQueryString: () => String(urlParts()[4] ?? ''),
			addQueryParams: (params: unknown) => {
				for (const param of Array.isArray(params) ? params : [params]) {
					const pair = typeof param === 'string' ? param : param && typeof param === 'object' ? `${String((param as Dyn).key)}=${plain((param as Dyn).value ?? '')}` : '';
					if (pair) {
						const hashAt = request.url.indexOf('#');
						const head = hashAt < 0 ? request.url : request.url.slice(0, hashAt);
						request.url = `${head}${head.includes('?') ? '&' : '?'}${pair}${hashAt < 0 ? '' : request.url.slice(hashAt)}`;
					}
				}
			},
		};
		const removeHeader = (name: unknown): void => {
			const lower = String(name).toLowerCase();
			request.headers = request.headers.filter(pair => pair[0].toLowerCase() !== lower);
		};
		const headerArg = (header: unknown, value: unknown): [string, string] | undefined => {
			if (header && typeof header === 'object') {
				const key = (header as Dyn).key ?? (header as Dyn).name;
				return key === undefined ? undefined : [String(key), plain((header as Dyn).value ?? '')];
			}
			return header === undefined || header === null ? undefined : [String(header), plain(value ?? '')];
		};
		const requestHeaders = {
			get: (name: unknown) => headerOf(request.headers, name),
			has: (name: unknown) => headerOf(request.headers, name) !== undefined,
			add: (header: unknown, value?: unknown) => {
				const pair = headerArg(header, value);
				if (pair) {
					request.headers.push(pair);
				}
			},
			upsert: (header: unknown, value?: unknown) => {
				const pair = headerArg(header, value);
				if (pair) {
					const at = request.headers.findIndex(item => item[0].toLowerCase() === pair[0].toLowerCase());
					if (at < 0) {
						request.headers.push(pair);
					} else {
						request.headers[at] = pair;
					}
				}
			},
			remove: removeHeader,
			each: (visit: unknown) => {
				if (typeof visit === 'function') {
					request.headers.forEach(pair => (visit as Fn)({ key: pair[0], value: pair[1] }));
				}
			},
			toObject: () => {
				const out: Record<string, string> = {};
				for (const pair of request.headers) {
					out[pair[0]] = pair[1];
				}
				return out;
			},
		};
		const setBody = (value: unknown): void => {
			const text = value && typeof value === 'object' && !Array.isArray(value) && 'raw' in value ? (value as Dyn).raw : value;
			if (text === undefined || text === null) {
				delete request.body;
			} else {
				request.body = plain(text);
			}
		};
		const pmBody = Object.defineProperty({ mode: 'raw', toString: () => request.body ?? '', update: setBody, isEmpty: () => !request.body }, 'raw', {
			enumerable: true,
			get: () => request.body ?? '',
			set: setBody,
		});
		const pmRequest = Object.defineProperties({ name: request.name, headers: requestHeaders }, {
			method: { enumerable: true, get: () => request.method, set: (value: unknown) => { request.method = String(value).toUpperCase(); } },
			url: { enumerable: true, get: () => pmUrl, set: (value: unknown) => { request.url = String(value); } },
			body: { enumerable: true, get: () => pmBody, set: setBody },
		});

		// --- The response ---------------------------------------------------------------------------

		const responseHeaders: [string, string][] = response ? Object.keys(response.headers ?? {}).map(key => [key, String(response.headers[key])] as [string, string]) : [];
		const contentType = headerOf(responseHeaders, 'content-type') ?? '';
		const responseJson = (): unknown => {
			try {
				return JSON.parse(response ? response.body : '');
			} catch (err) {
				throw new Error(`The response body is not valid JSON: ${messageOf(err)}`);
			}
		};
		let pmResponse: Dyn | undefined;

		// --- expect ---------------------------------------------------------------------------------

		const CHAIN = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still', 'also', 'but'];
		const expect = (subject: unknown, note?: unknown): unknown => {
			const state = { value: subject, not: false, deep: false, any: false, contains: false };
			/** `got` (" but got 201") ends the message of a failure only: a passing assertion reads as what held. */
			const check = (passed: boolean, positive: string, negative: string, operator?: string, values?: { expected?: unknown; actual?: unknown }, got = ''): void => {
				const failed = state.not ? passed : !passed;
				if (!failed && !(detailed && current)) {
					return;
				}
				const message = `${note !== undefined ? `${plain(note)}: ` : ''}expected ${state.not ? negative : `${positive}${failed ? got : ''}`}`;
				const about = detailed ? {
					...(values && 'expected' in values ? { expected: preview(values.expected) } : {}),
					...(values && 'actual' in values ? { actual: preview(values.actual) } : {}),
					...(operator ? { operator: `${state.not ? 'not ' : ''}${operator}` } : {}),
				} : {};
				asserted(!failed, message, about);
				if (failed) {
					const error = new Error(message);
					lastFailure = { error, ...about };
					throw error;
				}
			};
			const same = (a: unknown, b: unknown): boolean => state.deep ? deepEqual(a, b) : a === b;
			const sizeOf = (value: unknown): number | undefined => typeof value === 'string' || Array.isArray(value) ? value.length : value && typeof value === 'object' ? (typeof (value as Dyn).length === 'number' ? (value as Dyn).length as number : typeof (value as Dyn).size === 'number' ? (value as Dyn).size as number : Object.keys(value).length) : undefined;
			const includes = (value: unknown, part: unknown): boolean => {
				if (typeof value === 'string') {
					return value.includes(String(part));
				}
				if (Array.isArray(value)) {
					return value.some(item => same(item, part));
				}
				if (value && typeof value === 'object' && part && typeof part === 'object') {
					return Object.keys(part).every(key => key in value && same((value as Dyn)[key], (part as Dyn)[key]));
				}
				return false;
			};
			const compare = (word: string, test: (value: number, limit: number) => boolean) => (limit: unknown) => {
				const value = state.value instanceof Date ? state.value.getTime() : state.value;
				const bound = limit instanceof Date ? limit.getTime() : limit;
				check(typeof value === 'number' && typeof bound === 'number' && test(value, bound), `${show(state.value)} to be ${word} ${show(limit)}`, `${show(state.value)} to not be ${word} ${show(limit)}`, word, { expected: limit, actual: state.value });
			};
			const code = (): number => Number((state.value as Dyn | undefined)?.code);
			const statusFlag = (word: string, test: (code: number) => boolean) => () => check(test(code()), `the response to be ${word} but its status is ${code()}`, `the response to not be ${word} but its status is ${code()}`, 'status', { expected: word, actual: code() });
			const jsonAt = (path: unknown): { found: boolean; parsed: boolean } => {
				let current: unknown;
				try {
					current = responseJson();
				} catch {
					return { found: false, parsed: false };
				}
				if (path === undefined) {
					return { found: true, parsed: true };
				}
				for (const part of String(path).replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(item => item !== undefined && item !== '')) {
					if (current === null || typeof current !== 'object' || !(part in current)) {
						return { found: false, parsed: true };
					}
					current = (current as Dyn)[part];
				}
				return { found: true, parsed: true };
			};

			const flags: Record<string, () => void> = {
				ok: () => state.value === pmResponse && pmResponse
					? check(code() === 200, 'the response to have status 200', 'the response to not have status 200', 'status', { expected: 200, actual: code() }, ` but got ${code()}`)
					: check(!!state.value, `${show(state.value)} to be truthy`, `${show(state.value)} to be falsy`),
				true: () => check(state.value === true, `${show(state.value)} to be true`, `${show(state.value)} to not be true`, 'equal', { expected: true, actual: state.value }),
				false: () => check(state.value === false, `${show(state.value)} to be false`, `${show(state.value)} to not be false`, 'equal', { expected: false, actual: state.value }),
				null: () => check(state.value === null, `${show(state.value)} to be null`, `${show(state.value)} to not be null`, 'equal', { expected: null, actual: state.value }),
				undefined: () => check(state.value === undefined, `${show(state.value)} to be undefined`, `${show(state.value)} to not be undefined`),
				NaN: () => check(typeof state.value === 'number' && state.value !== state.value, `${show(state.value)} to be NaN`, `${show(state.value)} to not be NaN`),
				exist: () => check(state.value !== null && state.value !== undefined, `${show(state.value)} to exist`, `${show(state.value)} to not exist`),
				empty: () => check(sizeOf(state.value) === 0, `${show(state.value)} to be empty`, `${show(state.value)} to not be empty`),
				success: statusFlag('a success (2xx)', status => status >= 200 && status < 300),
				info: statusFlag('informational (1xx)', status => status >= 100 && status < 200),
				redirection: statusFlag('a redirection (3xx)', status => status >= 300 && status < 400),
				clientError: statusFlag('a client error (4xx)', status => status >= 400 && status < 500),
				serverError: statusFlag('a server error (5xx)', status => status >= 500 && status < 600),
				error: statusFlag('an error (4xx or 5xx)', status => status >= 400 && status < 600),
				created: statusFlag('201 Created', status => status === 201),
				accepted: statusFlag('202 Accepted', status => status === 202),
				noContent: statusFlag('204 No Content', status => status === 204),
				badRequest: statusFlag('400 Bad Request', status => status === 400),
				unauthorized: statusFlag('401 Unauthorized', status => status === 401),
				unauthorised: statusFlag('401 Unauthorized', status => status === 401),
				forbidden: statusFlag('403 Forbidden', status => status === 403),
				notFound: statusFlag('404 Not Found', status => status === 404),
				rateLimited: statusFlag('429 Too Many Requests', status => status === 429),
				json: () => check(jsonAt(undefined).parsed, 'the response body to be JSON', 'the response body to not be JSON'),
				withBody: () => check(!!response && response.body !== '', 'the response to have a body', 'the response to not have a body'),
			};
			flags.exists = flags.exist;

			const methods: Record<string, Fn> = {
				equal: expected => check(same(state.value, expected), `${show(state.value)} to ${state.deep ? 'deeply ' : ''}equal ${show(expected)}`, `${show(state.value)} to not ${state.deep ? 'deeply ' : ''}equal ${show(expected)}`, state.deep ? 'deep equal' : 'equal', { expected, actual: state.value }),
				eql: expected => check(deepEqual(state.value, expected), `${show(state.value)} to deeply equal ${show(expected)}`, `${show(state.value)} to not deeply equal ${show(expected)}`, 'deep equal', { expected, actual: state.value }),
				a: type => {
					const wanted = String(type).toLowerCase();
					const article = /^[aeiou]/.test(wanted) ? 'an' : 'a';
					check(typeOf(state.value) === wanted, `${show(state.value)} to be ${article} ${wanted}`, `${show(state.value)} to not be ${article} ${wanted}`, 'type', { expected: wanted, actual: typeOf(state.value) });
				},
				instanceof: type => check(typeof type === 'function' && state.value instanceof type, `${show(state.value)} to be an instance of ${typeof type === 'function' ? type.name : show(type)}`, `${show(state.value)} to not be an instance of ${typeof type === 'function' ? type.name : show(type)}`),
				above: compare('above', (value, limit) => value > limit),
				least: compare('at least', (value, limit) => value >= limit),
				below: compare('below', (value, limit) => value < limit),
				most: compare('at most', (value, limit) => value <= limit),
				within: (low, high) => check(typeof state.value === 'number' && typeof low === 'number' && typeof high === 'number' && state.value >= low && state.value <= high, `${show(state.value)} to be within ${show(low)}..${show(high)}`, `${show(state.value)} to not be within ${show(low)}..${show(high)}`, 'within', { expected: [low, high], actual: state.value }),
				closeTo: (expected, delta) => check(typeof state.value === 'number' && typeof expected === 'number' && Math.abs(state.value - expected) <= Number(delta ?? 0), `${show(state.value)} to be close to ${show(expected)} +/- ${show(delta)}`, `${show(state.value)} to not be close to ${show(expected)} +/- ${show(delta)}`, 'close to', { expected, actual: state.value }),
				include: part => check(includes(state.value, part), `${show(state.value)} to include ${show(part)}`, `${show(state.value)} to not include ${show(part)}`, 'include', { expected: part, actual: state.value }),
				property: (...args) => {
					const name = String(args[0]);
					const holder = state.value;
					const has = holder !== null && holder !== undefined && name in Object(holder);
					const value = has ? (Object(holder) as Dyn)[name] : undefined;
					if (args.length > 1) {
						check(has && same(value, args[1]), `${show(holder)} to have property '${name}' of ${show(args[1])}`, `${show(holder)} to not have property '${name}' of ${show(args[1])}`, `property '${name}'`, { expected: args[1], actual: value }, has ? `, but got ${show(value)}` : '');
					} else {
						check(has, `${show(holder)} to have property '${name}'`, `${show(holder)} to not have property '${name}'`, `property '${name}'`);
					}
					if (!state.not) {
						state.value = value;
					}
				},
				keys: (...args) => {
					const first = args[0];
					const wanted = (Array.isArray(first) ? first : args.length === 1 && first && typeof first === 'object' ? Object.keys(first) : args).map(String);
					const actual = state.value !== null && state.value !== undefined ? Object.keys(Object(state.value)) : [];
					const passed = state.any ? wanted.some(key => actual.includes(key)) : wanted.every(key => actual.includes(key));
					check(passed, `${show(state.value)} to have ${state.any ? 'any of the keys' : 'keys'} ${show(wanted)}`, `${show(state.value)} to not have ${state.any ? 'any of the keys' : 'keys'} ${show(wanted)}`, state.any ? 'any keys' : 'keys', { expected: wanted, actual });
				},
				lengthOf: length => check(sizeOf(state.value) === length, `${show(state.value)} to have a length of ${show(length)}`, `${show(state.value)} to not have a length of ${show(length)}`, 'length', { expected: length, actual: sizeOf(state.value) }, ` but got ${show(sizeOf(state.value))}`),
				match: pattern => check(pattern instanceof RegExp && pattern.test(String(state.value)), `${show(state.value)} to match ${show(pattern)}`, `${show(state.value)} to not match ${show(pattern)}`, 'match', { expected: pattern, actual: state.value }),
				string: part => check(typeof state.value === 'string' && state.value.includes(String(part)), `${show(state.value)} to contain ${show(part)}`, `${show(state.value)} to not contain ${show(part)}`, 'contain', { expected: part, actual: state.value }),
				oneOf: list => check(Array.isArray(list) && list.some(item => same(state.value, item)), `${show(state.value)} to be one of ${show(list)}`, `${show(state.value)} to not be one of ${show(list)}`, 'one of', { expected: list, actual: state.value }),
				members: list => {
					const actual = Array.isArray(state.value) ? state.value : [];
					const wanted = Array.isArray(list) ? list : [];
					const subset = wanted.every(item => actual.some(candidate => same(candidate, item)));
					const passed = Array.isArray(state.value) && subset && (state.contains || (actual.length === wanted.length && actual.every(item => wanted.some(candidate => same(candidate, item)))));
					check(passed, `${show(state.value)} to ${state.contains ? 'include' : 'have the same'} members ${state.contains ? '' : 'as '}${show(list)}`, `${show(state.value)} to not ${state.contains ? 'include' : 'have the same'} members ${state.contains ? '' : 'as '}${show(list)}`, state.contains ? 'include members' : 'members', { expected: list, actual: state.value });
				},
				throw: expected => {
					let thrown: unknown;
					let threw = false;
					try {
						if (typeof state.value === 'function') {
							(state.value as Fn)();
						}
					} catch (err) {
						threw = true;
						thrown = err;
					}
					const text = threw ? messageOf(thrown) : '';
					const matches = threw && (expected === undefined || (typeof expected === 'string' ? text.includes(expected) : expected instanceof RegExp ? expected.test(text) : typeof expected === 'function' ? thrown instanceof expected : true));
					check(matches, `the function to throw${expected !== undefined ? ` ${show(expected)}` : ''}${threw ? ` but it threw '${text}'` : ''}`, `the function to not throw${threw ? ` but it threw '${text}'` : ''}`);
				},
				satisfy: test => check(typeof test === 'function' && !!(test as Fn)(state.value), `${show(state.value)} to satisfy the given function`, `${show(state.value)} to not satisfy the given function`),
				status: expected => {
					const holder = (state.value ?? {}) as Dyn;
					const passed = typeof expected === 'number' ? holder.code === expected : String(holder.status).toLowerCase() === String(expected).toLowerCase();
					check(passed, `the response to have status ${show(expected)}`, `the response to not have status ${show(expected)}`, 'status', { expected, actual: typeof expected === 'number' ? holder.code : holder.status }, ` but got ${typeof expected === 'number' ? show(holder.code) : show(holder.status)}`);
				},
				header: (...args) => {
					const value = headerOf(responseHeaders, args[0]);
					if (args.length > 1) {
						check(value === String(args[1]), `the response to have header '${String(args[0])}' of ${show(String(args[1]))}`, `the response to not have header '${String(args[0])}' of ${show(String(args[1]))}`, `header '${String(args[0])}'`, { expected: String(args[1]), actual: value }, value !== undefined ? ` but got ${show(value)}` : '');
					} else {
						check(value !== undefined, `the response to have header '${String(args[0])}'`, `the response to not have header '${String(args[0])}'`);
					}
				},
				body: (...args) => {
					const text = response ? response.body : '';
					const expected = args[0];
					if (!args.length) {
						check(text !== '', 'the response to have a body', 'the response to not have a body');
					} else if (expected instanceof RegExp) {
						check(expected.test(text), `the response body to match ${show(expected)}`, `the response body to not match ${show(expected)}`);
					} else {
						check(text === String(expected), `the response body to equal ${show(String(expected))}`, `the response body to not equal ${show(String(expected))}`, 'body', { expected: String(expected), actual: text });
					}
				},
				jsonBody: path => {
					const at = jsonAt(path);
					check(at.found, path === undefined ? 'the response body to be JSON' : at.parsed ? `the response JSON to have '${String(path)}'` : `the response body to be JSON with '${String(path)}'`, path === undefined ? 'the response body to not be JSON' : `the response JSON to not have '${String(path)}'`);
				},
			};
			const aliases: Record<string, string> = {
				equals: 'equal', eq: 'equal', eqls: 'eql', an: 'a', instanceOf: 'instanceof',
				gt: 'above', greaterThan: 'above', gte: 'least', greaterThanOrEqual: 'least', lt: 'below', lessThan: 'below', lte: 'most', lessThanOrEqual: 'most',
				includes: 'include', contain: 'include', contains: 'include', key: 'keys', length: 'lengthOf', matches: 'match', approximately: 'closeTo',
				throws: 'throw', Throw: 'throw', satisfies: 'satisfy',
			};

			const access = (key: string | symbol): unknown => {
				if (typeof key !== 'string' || key === 'then' || key === 'toJSON') {
					return undefined;
				}
				if (key === 'not') {
					state.not = !state.not;
					return chain;
				}
				if (key === 'deep') {
					state.deep = true;
					return chain;
				}
				if (key === 'any') {
					state.any = true;
					return chain;
				}
				if (key === 'all') {
					state.any = false;
					return chain;
				}
				if (CHAIN.includes(key)) {
					return chain;
				}
				if (Object.prototype.hasOwnProperty.call(flags, key)) {
					flags[key]();
					return chain;
				}
				const name = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
				if (!Object.prototype.hasOwnProperty.call(methods, name)) {
					throw new Error(`expect: '${key}' is not supported in Volt's HTTP client scripts`);
				}
				// A method that is also a chain word: `.an.instanceof(X)`, `.include.keys('a')`, `.length.above(2)`.
				return new Proxy(function () { } as Fn, {
					get: (_target, next) => {
						if (typeof next !== 'string' || next === 'then') {
							return undefined;
						}
						if (name === 'include') {
							state.contains = true;
						} else if (name === 'lengthOf') {
							state.value = sizeOf(state.value);
						}
						return access(next);
					},
					apply: (_target, _self, args: unknown[]) => {
						methods[name](...args);
						return chain;
					},
				});
			};
			const chain: unknown = new Proxy({}, { get: (_target, key) => access(key) });
			return chain;
		};

		if (response) {
			const responseApi: Dyn = {
				code: response.status,
				status: response.statusText,
				reason: () => response.statusText,
				responseTime: response.durationMs,
				responseSize: response.size,
				headers: {
					get: (name: unknown) => headerOf(responseHeaders, name),
					has: (name: unknown) => headerOf(responseHeaders, name) !== undefined,
					each: (visit: unknown) => {
						if (typeof visit === 'function') {
							responseHeaders.forEach(pair => (visit as Fn)({ key: pair[0], value: pair[1] }));
						}
					},
					toObject: () => ({ ...response.headers }),
				},
				text: () => response.body,
				json: responseJson,
			};
			pmResponse = Object.defineProperty(responseApi, 'to', { get: () => (expect(pmResponse) as Dyn).to });
		}

		// --- Tests ------------------------------------------------------------------------------------

		const onlyTests = input && Array.isArray(input.onlyTests) ? input.onlyTests.map(String) : undefined;
		const wanted = (title: string): boolean => !onlyTests || onlyTests.indexOf(title) >= 0;
		const runTest = (name: unknown, body: unknown): void => {
			const title = String(name);
			if (!wanted(title)) {
				return;
			}
			const outer = current;
			const mine = current = { name: title, assertions: [] as IHttpScriptAssertion[], count: 0 };
			const startedAt = now();
			const detailOf = (threw: boolean, err?: unknown): Partial<IHttpScriptTest> => {
				if (!detailed) {
					return {};
				}
				const cause = threw && lastFailure && lastFailure.error === err ? lastFailure : undefined;
				const line = threw ? lineOf(err) : undefined;
				return {
					durationMs: Math.max(0, Math.round((now() - startedAt) * 100) / 100),
					...(mine.assertions.length ? { assertions: mine.assertions } : {}),
					...(mine.count > mine.assertions.length ? { assertionCount: mine.count } : {}),
					...(cause && cause.expected !== undefined ? { expected: cause.expected } : {}),
					...(cause && cause.actual !== undefined ? { actual: cause.actual } : {}),
					...(line !== undefined ? { errorLine: line } : {}),
				};
			};
			try {
				const result = typeof body === 'function' ? (body as Fn)() : undefined;
				if (result && typeof (result as Dyn).then === 'function') {
					((result as Dyn).then as Fn)(undefined, () => { });
					tests.push({ name: title, passed: false, error: 'Asynchronous tests are not supported: the script is not awaited.', ...detailOf(false) });
				} else {
					tests.push({ name: title, passed: true, ...detailOf(false) });
				}
			} catch (err) {
				tests.push({ name: title, passed: false, error: messageOf(err), ...detailOf(true, err) });
			} finally {
				current = outer;
			}
		};
		const pmTest = Object.assign((name: unknown, body: unknown) => runTest(name, body), {
			skip: (name: unknown) => {
				if (wanted(String(name))) {
					tests.push({ name: String(name), passed: true, skipped: true });
				}
			},
		});
		const setNextRequest = (name: unknown): void => {
			nextRequest = name === null || name === undefined ? null : String(name);
		};
		const sendRequest = (_request: unknown, callback: unknown): void => {
			log('error', ['pm.sendRequest is not supported']);
			if (typeof callback === 'function') {
				try {
					(callback as Fn)(new Error('pm.sendRequest is not supported'), undefined);
				} catch (err) {
					log('error', [messageOf(err)]);
				}
			}
		};
		const iteration = Number((input && input.iteration) ?? 0);
		const pm = {
			test: pmTest,
			expect,
			response: pmResponse,
			request: pmRequest,
			environment,
			collectionVariables,
			globals,
			variables: local,
			info: { eventName: phase === 'preRequest' ? 'prerequest' : 'test', iteration, iterationCount: 1, requestName: request.name, requestId: '' },
			execution: { setNextRequest, skipRequest: () => { } },
			sendRequest,
			cookies: { get: () => undefined, has: () => false, toObject: () => ({}) },
		};

		// --- Postman's older API ----------------------------------------------------------------------

		const legacyTests: Record<string, unknown> = {};
		const postman = {
			setEnvironmentVariable: environment.set,
			getEnvironmentVariable: environment.get,
			clearEnvironmentVariable: environment.unset,
			clearEnvironmentVariables: environment.clear,
			setGlobalVariable: globals.set,
			getGlobalVariable: globals.get,
			clearGlobalVariable: globals.unset,
			clearGlobalVariables: globals.clear,
			getResponseHeader: (name: unknown) => headerOf(responseHeaders, name),
			setNextRequest,
		};

		// --- JetBrains HTTP Client handlers (`> {% %}` in .http files) ---------------------------------

		const client = {
			test: (name: unknown, body: unknown) => runTest(name, body),
			assert: (condition: unknown, message?: unknown) => {
				asserted(!!condition, message === undefined ? (condition ? 'Assertion passed' : 'Assertion failed') : plain(message), {});
				if (!condition) {
					throw new Error(message === undefined ? 'Assertion failed' : plain(message));
				}
			},
			log: (...args: unknown[]) => log('log', args),
			global: {
				set: environment.set,
				get: environment.get,
				clear: environment.unset,
				clearAll: environment.clear,
				isEmpty: () => Object.keys(variables.environment).length === 0,
			},
		};
		let handlerBody: unknown = response ? response.body : undefined;
		if (response && /json/i.test(contentType)) {
			try {
				handlerBody = JSON.parse(response.body);
			} catch { /* stays text */ }
		}
		const handlerResponse = response ? {
			status: response.status,
			body: handlerBody,
			headers: {
				valueOf: (name: unknown) => headerOf(responseHeaders, name) ?? null,
				valuesOf: (name: unknown) => {
					const lower = String(name).toLowerCase();
					return responseHeaders.filter(pair => pair[0].toLowerCase() === lower).map(pair => pair[1]);
				},
			},
			contentType: { mimeType: contentType.split(';')[0].trim(), charset: (/charset=([^;]+)/i.exec(contentType)?.[1] ?? '').trim() },
		} : undefined;
		const handlerUrl = Object.assign(() => request.url, { toString: () => request.url });
		const handlerRequest = Object.defineProperties({
			variables: { set: local.set, get: local.get },
			environment: { get: (name: unknown) => lookup(String(name)) },
			url: handlerUrl,
			body: Object.assign(() => request.body ?? '', { toString: () => request.body ?? '' }),
			headers: {
				findByName: (name: unknown) => {
					const value = headerOf(request.headers, name);
					return value === undefined ? null : { name: String(name), value: () => value, getRawValue: () => value };
				},
				all: () => request.headers.map(pair => ({ name: pair[0], value: () => pair[1], getRawValue: () => pair[1] })),
			},
		}, {
			method: { enumerable: true, get: () => request.method },
			data: { enumerable: true, get: () => request.body },
		});

		const scriptConsole = {
			log: (...args: unknown[]) => log('log', args),
			debug: (...args: unknown[]) => log('log', args),
			info: (...args: unknown[]) => log('info', args),
			warn: (...args: unknown[]) => log('warn', args),
			error: (...args: unknown[]) => log('error', args),
		};
		const scriptRequire = (name: unknown): never => {
			throw new Error(`require is not available in Volt's HTTP client scripts (${plain(name)})`);
		};

		// --- Breakpoints: what is in reach when a marked line is about to run ---------------------------

		const cut = (text: string): string => text.length > 300 ? `${text.slice(0, 297)}...` : text;
		const kindOf = (value: unknown): string => {
			if (value === null) {
				return 'null';
			}
			if (Array.isArray(value)) {
				return 'array';
			}
			if (typeof value !== 'object') {
				return typeof value;
			}
			let name = '';
			try {
				const maker = (value as Dyn).constructor;
				name = typeof maker === 'function' ? String(maker.name || '') : '';
			} catch { /* a getter that throws */ }
			return name && name !== 'Object' ? name : 'object';
		};
		/** A value inside its parent's preview. */
		const short = (value: unknown): string => {
			if (typeof value === 'string') {
				return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
			}
			if (typeof value === 'function') {
				return 'f()';
			}
			if (Array.isArray(value)) {
				return `Array(${value.length})`;
			}
			if (value instanceof RegExp) {
				return String(value);
			}
			return value !== null && typeof value === 'object' ? '{...}' : String(value);
		};
		/** A line of the variables tree: cycles end, four levels deep, sixty children a level, and `budget` values in all. */
		const valueOf = (name: string, value: unknown, depth: number, seen: unknown[], budget: { left: number }): IHttpScriptValue => {
			const type = kindOf(value);
			if (typeof value === 'string') {
				return { name, type, preview: cut(JSON.stringify(value.length > 300 ? value.slice(0, 300) : value)) };
			}
			if (typeof value === 'function') {
				return { name, type, preview: cut(`function ${value.name || ''}()`) };
			}
			if (value === null || typeof value !== 'object') {
				return { name, type, preview: cut(typeof value === 'bigint' ? `${String(value)}n` : String(value)) };
			}
			if (value instanceof Date) {
				return { name, type, preview: value.getTime() !== value.getTime() ? 'Invalid Date' : value.toISOString() };
			}
			if (value instanceof RegExp || value instanceof Error) {
				return { name, type, preview: cut(value instanceof Error ? messageOf(value) : String(value)) };
			}
			if (seen.indexOf(value) >= 0) {
				return { name, type, preview: '[Circular]' };
			}
			const pairs: [string, unknown][] = [];
			const listed = Array.isArray(value) || value instanceof Set;
			let total = 0;
			try {
				if (Array.isArray(value)) {
					total = value.length;
					for (let i = 0; i < total && i < MAX_CHILDREN; i++) {
						pairs.push([String(i), value[i]]);
					}
				} else if (value instanceof Map || value instanceof Set) {
					total = value.size;
					let index = 0;
					for (const entry of value instanceof Map ? value : value.entries()) {
						if (index >= MAX_CHILDREN) {
							break;
						}
						const key = entry[0];
						pairs.push([value instanceof Set || (key !== null && typeof key === 'object') ? String(index) : String(key), entry[1]]);
						index++;
					}
				} else {
					const keys = Object.keys(value);
					total = keys.length;
					for (const key of keys.slice(0, MAX_CHILDREN)) {
						let item: unknown;
						try {
							item = (value as Dyn)[key];
						} catch (err) {
							item = `[${messageOf(err)}]`;
						}
						pairs.push([key, item]);
					}
				}
			} catch { /* a proxy that refuses to be listed: shown empty */ }
			const inside = pairs.slice(0, 8).map(pair => listed ? short(pair[1]) : `${pair[0]}: ${short(pair[1])}`).join(', ') + (total > 8 ? ', ...' : '');
			const label = Array.isArray(value) ? `(${total}) ` : type !== 'object' ? `${type}(${total}) ` : '';
			const node: IHttpScriptValue = { name, type, preview: cut(listed ? `${label}[${inside}]` : `${label}{${inside}}`) };
			if (pairs.length && depth < MAX_DEPTH && budget.left > 0) {
				seen.push(value);
				const children: IHttpScriptValue[] = [];
				for (const pair of pairs) {
					if (budget.left <= 0) {
						break;
					}
					budget.left--;
					children.push(valueOf(pair[0], pair[1], depth + 1, seen, budget));
				}
				seen.pop();
				if (total > children.length) {
					children.push({ name: '...', type: 'more', preview: `${total - children.length} more` });
				}
				node.children = children;
			}
			return node;
		};
		const hits: Record<string, number> = {};
		let breakBody: { value: unknown } | undefined;
		const group = (name: string, source: Dyn, room: number): { name: string; variables: IHttpScriptValue[] } => {
			const budget = { left: room };
			return { name, variables: Object.keys(source).map(key => valueOf(key, source[key], 1, [], budget)) };
		};
		/** What an instrumented script calls in front of a breakpoint's statement: the names in reach and a reader for each. */
		const breakAt = (line: unknown, names: unknown, readers: unknown): void => {
			if (breaks.length >= MAX_STOPS) {
				if (!breaksCapped) {
					breaksCapped = true;
					log('warn', [`Breakpoints: only the first ${MAX_STOPS} stops were recorded.`]);
				}
				return;
			}
			const at = Number(line);
			hits[at] = (hits[at] ?? 0) + 1;
			const list = String(names ?? '').split(',').filter(name => !!name);
			const reads = Array.isArray(readers) ? readers : [];
			const budget = { left: 800 };
			const locals: IHttpScriptValue[] = [];
			for (let i = 0; i < list.length; i++) {
				try {
					locals.push(valueOf(list[i], typeof reads[i] === 'function' ? (reads[i] as Fn)() : undefined, 1, [], budget));
				} catch (err) {
					// A `let` or `const` further down its block; a name the scan got wrong is left out.
					if (err instanceof Error && err.name === 'ReferenceError' && /initiali[sz]/i.test(err.message)) {
						locals.push({ name: list[i], type: 'uninitialised', preview: 'not initialised' });
					}
				}
			}
			const scopes = [{ name: 'Local', variables: locals }];
			if (response) {
				if (!breakBody) {
					breakBody = { value: response.body };
					if (/json/i.test(contentType) || /^\s*[[{]/.test(String(response.body))) {
						try {
							breakBody.value = JSON.parse(response.body);
						} catch { /* stays text */ }
					}
				}
				scopes.push(group('Response', { status: response.status, statusText: response.statusText, time: response.durationMs, size: response.size, headers: { ...response.headers }, body: breakBody.value }, 400));
			}
			scopes.push(group('Request', { method: request.method, url: request.url, headers: requestHeaders.toObject(), ...(request.body !== undefined ? { body: request.body } : {}) }, 200));
			scopes.push(group('Variables', { environment: { ...variables.environment }, collection: { ...variables.collection }, globals: { ...variables.globals }, local: { ...variables.local } }, 400));
			breaks.push({ line: at, order: breaks.length + 1, hit: hits[at], ...(current ? { test: current.name } : {}), scopes });
		};

		const scopeOf: Record<string, unknown> = {
			__voltBreak: breakAt,
			pm,
			postman,
			tests: legacyTests,
			responseBody: response ? response.body : undefined,
			responseCode: response ? { code: response.status, name: response.statusText, detail: response.statusText } : undefined,
			responseTime: response ? response.durationMs : undefined,
			responseHeaders: response ? { ...response.headers } : undefined,
			environment: variables.environment,
			globals: variables.globals,
			data: {},
			iteration,
			client,
			response: handlerResponse,
			request: handlerRequest,
			console: scriptConsole,
			require: scriptRequire,
		};
		const names = Object.keys(scopeOf);
		try {
			if (input && input.namesOnly) {
				logs.push(...names.map(name => ({ level: 'log' as const, text: name })));
			} else {
				const run = (input && typeof input.compiled === 'function' ? input.compiled : new Function(...names, String((input && input.script) ?? ''))) as Fn;
				run(...names.map(name => scopeOf[name]));
			}
		} catch (err) {
			failure = messageOf(err);
			failureLine = detailed ? lineOf(err) : undefined;
		}
		for (const name of Object.keys(legacyTests).filter(wanted)) {
			tests.push(legacyTests[name] ? { name, passed: true } : { name, passed: false, error: 'tests[...] was set to a falsy value' });
		}
		// The older API writes straight into `environment` and `globals`: back to strings.
		variables.environment = record(variables.environment);
		variables.globals = record(variables.globals);
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	return output();
}

/**
 * Runs a script and answers with what it did. With `breakpoints` and a script given as text, the
 * breakpoints are put in first (a compiled script got them where it was compiled:
 * `httpScriptWorkerSource`). Never throws.
 */
export function httpScriptRuntime(input: IHttpScriptInput): IHttpScriptOutput {
	if (input && Array.isArray(input.breakpoints) && !input.breakpointLines && !input.namesOnly && typeof input.compiled !== 'function') {
		let done: { script: string; lines: number[] } | undefined;
		try {
			done = instrumentHttpScript(String(input.script ?? ''), input.breakpoints);
		} catch { /* runs without breakpoints */ }
		input = { ...input, ...(done ? { script: done.script } : {}), breakpointLines: done ? done.lines : [] };
	}
	return httpScriptRun(input);
}

/** The names in scope of a request script, in the order a compiled script takes them. */
export function httpScriptNames(): string[] {
	return httpScriptRuntime({ script: '', phase: 'test', request: { name: '', method: 'GET', url: '', headers: [] }, variables: { environment: {}, collection: {}, globals: {}, local: {} }, namesOnly: true }).logs.map(log => log.text);
}

/**
 * The script of the worker request scripts run in: the network and loading globals go first (a
 * script reaches the network only through the request it belongs to), then each message is one
 * `IHttpScriptInput` answered with its `IHttpScriptOutput`.
 *
 * With `script`, the worker's source holds that script as a function and every message runs it:
 * nothing is compiled from a string at run time, which Trusted Types would refuse. A script that
 * does not parse makes the worker fail to start; its `error` event carries the syntax error.
 *
 * With `breakpoints`, the script held is the instrumented one (same lines) and every answer names
 * the lines used. A worker built without a script puts no breakpoints in: it has no instrumenter.
 */
export function httpScriptWorkerSource(script?: string, breakpoints?: readonly number[]): string {
	const instrumented = script !== undefined && breakpoints ? instrumentHttpScript(script, breakpoints) : undefined;
	const blocked = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'RTCPeerConnection', 'Worker', 'SharedWorker'];
	return [
		`for (const name of ${JSON.stringify(blocked)}) {`,
		`	for (let scope = self; scope && scope !== Object.prototype; scope = Object.getPrototypeOf(scope)) {`,
		`		try { delete scope[name]; } catch (e) { }`,
		`	}`,
		`	try { self[name] = undefined; } catch (e) { }`,
		`	try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch (e) { }`,
		`}`,
		`try { Object.defineProperty(self.navigator, 'sendBeacon', { value: undefined }); } catch (e) { }`,
		`try { Object.defineProperty(Object.getPrototypeOf(self.navigator), 'sendBeacon', { value: undefined }); } catch (e) { }`,
		`const httpScriptRun = ${httpScriptRun.toString()};`,
		...(script === undefined
			? [`self.onmessage = e => self.postMessage(httpScriptRun(e.data));`]
			: [
				// Where this very line is, as the engine counts lines here (a blob, or a test's function): the script's
				// first line is two below it, so an error's stack frame maps back to a line of the script.
				`const httpScriptLine = (function () { try { throw new Error('at'); } catch (e) { const m = /:(\\d+):\\d+\\)?\\s*$/m.exec(String(e && e.stack)); return m ? Number(m[1]) + 1 : undefined; } })();`,
				// A line of its own for the last line of the script: a trailing `//` comment must not swallow the brace.
				`const httpUserScript = function (${httpScriptNames().join(', ')}) {`,
				instrumented ? instrumented.script : script,
				`};`,
				`self.onmessage = e => self.postMessage(httpScriptRun(Object.assign({}, e.data, { compiled: httpUserScript, scriptLine: httpScriptLine${instrumented ? `, breakpointLines: ${JSON.stringify(instrumented.lines)}` : ''} })));`,
			]),
	].join('\n');
}

/** A test a script declares with a literal name: where it starts, for a "Run Test" link above it. */
export interface IHttpScriptTestSite {
	readonly name: string;
	/** 1-based line of the `pm.test(` (or `client.test(`, `tests[...]`) that declares it. */
	readonly line: number;
}

/**
 * The tests a script declares by a literal name, in source order. A name built at run time (a
 * variable, a template with `${}`) is not listed: only a run tells what it is called. Text inside
 * comments and other strings is not mistaken for a test.
 */
export function httpScriptTestSites(script: string): IHttpScriptTestSite[] {
	const sites: IHttpScriptTestSite[] = [];
	const text = String(script ?? '');
	let line = 1;
	let at = 0;
	const literalAt = (from: number): { value: string; end: number } | undefined => {
		const quote = text[from];
		if (quote !== '"' && quote !== '\'' && quote !== '`') {
			return undefined;
		}
		let value = '';
		for (let i = from + 1; i < text.length; i++) {
			const ch = text[i];
			if (ch === '\\') {
				const next = text[++i];
				value += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
			} else if (ch === quote) {
				return { value, end: i + 1 };
			} else if (ch === '\n' && quote !== '`') {
				return undefined;
			} else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
				return undefined;
			} else {
				value += ch;
			}
		}
		return undefined;
	};
	const skipSpace = (from: number): number => {
		while (from < text.length && /\s/.test(text[from])) {
			from++;
		}
		return from;
	};
	while (at < text.length) {
		const ch = text[at];
		if (ch === '\n') {
			line++;
			at++;
		} else if (ch === '/' && text[at + 1] === '/') {
			const end = text.indexOf('\n', at);
			at = end < 0 ? text.length : end;
		} else if (ch === '/' && text[at + 1] === '*') {
			const end = text.indexOf('*/', at + 2);
			const stop = end < 0 ? text.length : end + 2;
			line += text.slice(at, stop).split('\n').length - 1;
			at = stop;
		} else if (ch === '"' || ch === '\'' || ch === '`') {
			// A string that is not a test's name: step over it (a template with `${}` is walked as code).
			const literal = literalAt(at);
			if (literal) {
				line += text.slice(at, literal.end).split('\n').length - 1;
				at = literal.end;
			} else {
				at++;
			}
		} else {
			const rest = text.slice(at, at + 40);
			const call = /^(?:pm\.test(?:\.skip)?|client\.test)\s*\(/.exec(rest) ?? /^tests\s*\[/.exec(rest);
			const boundary = at === 0 || !/[\w$.]/.test(text[at - 1]);
			if (call && boundary) {
				const nameAt = skipSpace(at + call[0].length);
				const literal = literalAt(nameAt);
				const after = literal ? text[skipSpace(literal.end)] : undefined;
				if (literal && (after === ',' || after === ')' || after === ']')) {
					sites.push({ name: literal.value, line });
				}
				at += call[0].length;
			} else {
				at++;
			}
		}
	}
	return sites;
}
