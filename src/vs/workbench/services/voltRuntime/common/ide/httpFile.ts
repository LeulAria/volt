/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `.http` / `.rest` files, the format REST Client and JetBrains HTTP Client share: requests split
 * by `###`, named with `# @name`, file variables (`@host = ...`), `{{variables}}` from the file,
 * an environment (`http-client.env.json`) and earlier responses (`{{login.response.body.$.token}}`).
 * Used by the HTTP client view and the agents' `ide http` capability alike.
 */

import { generateUuid } from '../../../../../base/common/uuid.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'] as const;

/**
 * What a request line may start with instead of an HTTP method: the kind of request it is
 * (`WS wss://...`, `GRAPHQL https://...`, `MCP https://...`). `WEBSOCKET` is JetBrains' spelling.
 */
export const HTTP_PROTOCOL_KEYWORDS: Readonly<Record<string, string>> = {
	GRAPHQL: 'graphql', SOAP: 'soap', AI: 'ai', MCP: 'mcp', GRPC: 'grpc',
	WS: 'ws', WEBSOCKET: 'ws', SOCKETIO: 'socketio', SSE: 'sse', MQTT: 'mqtt',
};

/** The keyword a kind of request is written with. */
export function httpProtocolKeyword(protocol: string): string | undefined {
	return Object.keys(HTTP_PROTOCOL_KEYWORDS).find(keyword => HTTP_PROTOCOL_KEYWORDS[keyword] === protocol);
}

/** The HTTP method a kind of request goes out with, as far as it has one. */
export function httpProtocolMethod(protocol: string): string {
	return protocol === 'ws' || protocol === 'sse' || protocol === 'socketio' || protocol === 'mqtt' ? 'GET' : 'POST';
}

export interface IHttpRequestSpec {
	readonly name?: string;
	readonly method: string;
	/** The kind of request when it is not plain HTTP (`HTTP_PROTOCOL_KEYWORDS`' values). */
	readonly protocol?: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
	/** 1-based line of the request line. */
	readonly line: number;
	/** The comment lines above the request line. */
	readonly description?: string;
	/** Headers commented out in the block (`# Accept: text/plain`): kept, not sent. */
	readonly disabledHeaders?: readonly (readonly [string, string])[];
	/** `< {% ... %}` above the request line: runs before the send. */
	readonly preScript?: string;
	/** `> {% ... %}` after the body: runs on the response. */
	readonly postScript?: string;
}

export interface IHttpFile {
	readonly variables: Readonly<Record<string, string>>;
	readonly requests: readonly IHttpRequestSpec[];
}

/** A response kept for chaining (`{{name.response.body.$.id}}`) and for the history. */
export interface IHttpResponseRecord {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly durationMs: number;
	readonly size: number;
	/** The redirects followed to get here, in order: each hop's status and the URL that answered with it. */
	readonly redirects?: readonly { readonly status: number; readonly url: string }[];
	/** The negotiated protocol version when the network stack told it: `1.1`, `2`. */
	readonly httpVersion?: string;
	/** Each `Set-Cookie` line of the response on its own (`headers` joins them with ", "). */
	readonly setCookies?: readonly string[];
}

export function parseHttpFile(text: string): IHttpFile {
	const variables: Record<string, string> = {};
	const requests: IHttpRequestSpec[] = [];
	const lines = text.split(/\r?\n/);
	let block: { start: number; lines: string[]; name?: string } = { start: 0, lines: [] };
	const flush = () => {
		const request = parseBlock(block.lines, block.start, block.name);
		if (request) {
			requests.push(request);
		}
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const separator = /^###\s*(.*)$/.exec(line);
		if (separator) {
			flush();
			block = { start: index + 1, lines: [], ...(separator[1].trim() ? { name: separator[1].trim() } : {}) };
			continue;
		}
		const variable = /^@([\w.-]+)\s*=\s*(.*)$/.exec(line);
		if (variable && !block.lines.some(item => item.trim() && !isComment(item))) {
			variables[variable[1]] = variable[2].trim();
			continue;
		}
		block.lines.push(line);
	}
	flush();
	return { variables, requests };
}

function isComment(line: string): boolean {
	return /^\s*(#|\/\/)/.test(line);
}

/** Reads a `{% ... %}` script that opens on `lines[index]` (after its `<` or `>`); returns it and the index after it. */
function readScript(lines: readonly string[], index: number): { script: string; next: number } {
	const first = lines[index].replace(/^\s*[<>]\s*\{%/, '');
	const collected: string[] = [];
	let current = first;
	let at = index;
	for (; ;) {
		const end = current.indexOf('%}');
		if (end >= 0) {
			collected.push(current.slice(0, end));
			break;
		}
		collected.push(current);
		at++;
		if (at >= lines.length) {
			break;
		}
		current = lines[at];
	}
	while (collected.length && !collected[0].trim()) {
		collected.shift();
	}
	while (collected.length && !collected[collected.length - 1].trim()) {
		collected.pop();
	}
	return { script: collected.join('\n'), next: at + 1 };
}

function parseBlock(lines: readonly string[], start: number, separatorName: string | undefined): IHttpRequestSpec | undefined {
	let name = separatorName;
	let index = 0;
	let preScript: string | undefined;
	const description: string[] = [];
	for (; index < lines.length; index++) {
		const line = lines[index];
		const named = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/.exec(line);
		if (named) {
			name = named[1];
			continue;
		}
		if (/^\s*<\s*\{%/.test(line)) {
			const read = readScript(lines, index);
			preScript = read.script;
			index = read.next - 1;
			continue;
		}
		if (isComment(line)) {
			// `# @directive` lines are not prose.
			if (!/^\s*(?:#|\/\/)\s*@/.test(line)) {
				description.push(line.replace(/^\s*(?:#|\/\/)\s?/, ''));
			}
			continue;
		}
		if (line.trim()) {
			break;
		}
	}
	if (index >= lines.length) {
		return undefined;
	}
	const requestLine = /^\s*(?:([A-Za-z]+)\s+)?(\S.*?)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(lines[index]);
	if (!requestLine) {
		return undefined;
	}
	const word = (requestLine[1] ?? 'GET').toUpperCase();
	const protocol = HTTP_PROTOCOL_KEYWORDS[word];
	const method = protocol ? httpProtocolMethod(protocol) : word;
	if (!(HTTP_METHODS as readonly string[]).includes(method)) {
		return undefined;
	}
	const line = start + index + 1;
	let url = requestLine[2];
	index++;
	// Query lines continue the URL: `    ?page=2` / `    &limit=10`.
	while (index < lines.length && /^\s+[?&]/.test(lines[index])) {
		url += lines[index].trim();
		index++;
	}
	const headers: [string, string][] = [];
	const disabledHeaders: [string, string][] = [];
	for (; index < lines.length && lines[index].trim(); index++) {
		if (isComment(lines[index])) {
			const off = /^\s*(?:#|\/\/)\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[index]);
			if (off) {
				disabledHeaders.push([off[1], off[2].trim()]);
			}
			continue;
		}
		if (/^\s*>\s*\{%/.test(lines[index])) {
			// A response handler right under the headers: the body loop below reads it.
			index--;
			break;
		}
		const header = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(lines[index]);
		if (header) {
			headers.push([header[1], header[2].trim()]);
		}
	}
	const bodyLines: string[] = [];
	let postScript: string | undefined;
	for (index++; index < lines.length; index++) {
		const item = lines[index];
		if (/^\s*>\s*\{%/.test(item)) {
			const read = readScript(lines, index);
			postScript = postScript ? `${postScript}\n${read.script}` : read.script;
			index = read.next - 1;
			continue;
		}
		if (/^\s*(?:#|\/\/)\s*@/.test(item)) {
			continue;
		}
		bodyLines.push(item);
	}
	while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) {
		bodyLines.pop();
	}
	const body = bodyLines.join('\n');
	while (description.length && !description[0].trim()) {
		description.shift();
	}
	while (description.length && !description[description.length - 1].trim()) {
		description.pop();
	}
	return {
		...(name ? { name } : {}), method, ...(protocol ? { protocol } : {}), url, headers, ...(body.trim() ? { body } : {}), line,
		...(description.length ? { description: description.join('\n') } : {}),
		...(disabledHeaders.length ? { disabledHeaders } : {}),
		...(preScript ? { preScript } : {}),
		...(postScript ? { postScript } : {}),
	};
}

/** Turns a request back into `.http` text (the HTTP client saves through this). */
export function serializeHttpRequest(request: IHttpRequestSpec): string {
	return [
		...(request.description ? request.description.split('\n').map(line => line ? `# ${line}` : '#') : []),
		...(request.name ? [`# @name ${request.name}`] : []),
		...(request.preScript ? ['< {%', request.preScript, '%}'] : []),
		`${(request.protocol && httpProtocolKeyword(request.protocol)) || request.method} ${request.url}`,
		...request.headers.map(([key, value]) => `${key}: ${value}`),
		...(request.disabledHeaders ?? []).map(([key, value]) => `# ${key}: ${value}`),
		...(request.body !== undefined && request.body !== '' ? ['', request.body] : []),
		...(request.postScript ? ['', '> {%', request.postScript, '%}'] : []),
	].join('\n');
}

export interface IHttpScope {
	readonly file: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	/** Responses of named requests, for `{{name.response...}}`. */
	readonly responses: ReadonlyMap<string, IHttpResponseRecord>;
}

/**
 * Replaces `{{...}}`: environment and file variables (file variables may use the environment),
 * dynamic values ($guid, $timestamp, $isoTimestamp, $randomInt a b, $processEnv is not offered)
 * and earlier responses. Unknown names stay as written so the caller can report them.
 */
export function resolveHttpVariables(template: string, scope: IHttpScope, depth = 0): string {
	return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expression: string) => {
		const value = resolveExpression(expression, scope);
		if (value === undefined) {
			return whole;
		}
		return depth < 5 ? resolveHttpVariables(value, scope, depth + 1) : value;
	});
}

function resolveExpression(expression: string, scope: IHttpScope): string | undefined {
	if (expression.startsWith('$')) {
		const [name, ...args] = expression.split(/\s+/);
		switch (name) {
			case '$guid':
			case '$uuid':
			case '$random.uuid':
				return generateUuid();
			case '$timestamp':
				return String(Math.floor(Date.now() / 1000));
			case '$isoTimestamp':
				return new Date().toISOString();
			case '$randomInt': {
				const min = Number(args[0] ?? 0);
				const max = Number(args[1] ?? 1000);
				return String(Math.floor(min + Math.random() * (max - min)));
			}
		}
		return undefined;
	}
	if (expression in scope.env) {
		return scope.env[expression];
	}
	if (expression in scope.file) {
		return scope.file[expression];
	}
	const chained = /^([\w-]+)\.response\.(body|headers)(?:\.(.+))?$/.exec(expression);
	if (chained) {
		const response = scope.responses.get(chained[1]);
		if (!response) {
			return undefined;
		}
		if (chained[2] === 'headers') {
			const header = chained[3]?.toLowerCase();
			return header ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === header)?.[1] : undefined;
		}
		const path = chained[3];
		if (!path || path === '*') {
			return response.body;
		}
		try {
			const found = jsonPath(JSON.parse(response.body), path);
			return found === undefined ? undefined : typeof found === 'string' ? found : JSON.stringify(found);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** `$.a.b[0].c` or `a.b.0.c`. */
export function jsonPath(value: unknown, path: string): unknown {
	const parts = path.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(part => part !== undefined && part !== '');
	let current = value;
	for (const part of parts) {
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Unresolved `{{names}}` left in a resolved text. */
export function missingVariables(text: string): string[] {
	return [...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]))];
}

/** Environments from `http-client.env.json` (and its private twin): `$shared` merges into each. */
export function parseHttpEnvironments(...texts: (string | undefined)[]): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const text of texts) {
		if (!text) {
			continue;
		}
		let json: Record<string, Record<string, unknown>>;
		try {
			json = JSON.parse(text) as Record<string, Record<string, unknown>>;
		} catch {
			continue;
		}
		for (const [env, vars] of Object.entries(json)) {
			if (vars && typeof vars === 'object') {
				out[env] = { ...out[env], ...Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])) };
			}
		}
	}
	const shared = out.$shared ?? {};
	delete out.$shared;
	return Object.fromEntries(Object.entries(out).map(([env, vars]) => [env, { ...shared, ...vars }]));
}

/** Masks values that look like secrets (keys named token, secret, password, key, auth). */
export function maskSecret(key: string, value: string): string {
	return /token|secret|passw|apikey|api_key|key$|auth|cookie|session/i.test(key) && value.length > 4 ? `${value.slice(0, 2)}\u2026(${value.length})` : value;
}
