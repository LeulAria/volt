/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `.http` / `.rest` files as collections. A file is a flat collection: its `@variables` are the
 * collection's, each `###` block is a request. Saving writes a block again only when its request
 * changed, so the comments and layout of the blocks nobody touched stay as they were written.
 *
 * What an `.http` block has no syntax for is kept in comment directives other tools skip:
 * `# @path-variable id 42` and `# @disabled-param page=2`.
 */

import { IHttpRequestSpec, parseHttpFile, serializeHttpRequest } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { httpMessagesToBody } from './httpProtocols.js';
import { compactHttpSettings, HTTP_TLS_PROTOCOLS, IHttpRequestSettings, effectiveHttpAuth, emptyHttpCollection, HTTP_AUTH_COMPUTED, httpAuthParam, httpAutoHeaders, httpParamsFromUrl, httpPathVariablesFor, httpRequestFromSpec, httpRequestsOf, IHttpCollection, IHttpKeyValue, IHttpRequest } from './httpCollection.js';

const MULTIPART_BOUNDARY = '----VoltFormBoundary';

/** `# @proto ./users.proto` and its like above a request line: what a kind needs beyond URL and headers. */
const OPTION_DIRECTIVES: Readonly<Record<string, string>> = { 'proto': 'proto', 'subscribe': 'subscribe', 'client-id': 'clientId', 'qos': 'qos', 'engine-path': 'path', 'connect-auth': 'auth' };

/** What a block's request keeps from the file, to write the block back as it was while unchanged. */
interface IHttpBlockExtra {
	readonly block: string;
	readonly title: string;
	readonly signature: string;
}

interface IHttpFileExtra {
	/** The comment lines above the first request. */
	readonly preamble: string;
	/** Everything above the first request as it was written (comments and `@variables`), and the variables it holds: written back as is while they are unchanged. */
	readonly head: string;
	readonly variables: string;
}

function signatureOf(request: IHttpRequest): string {
	const { id: _id, line: _line, extra: _extra, ...rest } = request;
	return JSON.stringify(rest);
}

function isVariableLine(line: string): boolean {
	return /^@[\w.-]+\s*=/.test(line);
}

function trimBlankEnds(lines: string[]): string[] {
	const out = [...lines];
	while (out.length && !out[0].trim()) {
		out.shift();
	}
	while (out.length && !out[out.length - 1].trim()) {
		out.pop();
	}
	return out;
}

/** A multipart body written out in a block, read back into form-data rows. */
function parseMultipart(body: string, boundary: string): IHttpKeyValue[] | undefined {
	const parts = body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*$`, 'm')).map(part => part.replace(/^\r?\n/, '')).filter(part => part.trim());
	const rows: IHttpKeyValue[] = [];
	for (const part of parts) {
		const split = part.search(/\r?\n\r?\n/);
		const head = split < 0 ? part : part.slice(0, split);
		const content = split < 0 ? '' : part.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
		const name = /name="([^"]*)"/i.exec(head)?.[1];
		if (name === undefined) {
			return undefined;
		}
		const file = /^<\s+(.+)$/.exec(content.trim());
		rows.push(file || /filename="/i.test(head) ? { key: name, value: file ? file[1].trim() : (/filename="([^"]*)"/i.exec(head)?.[1] ?? ''), enabled: true, type: 'file' } : { key: name, value: content, enabled: true });
	}
	return rows;
}

function requestFromBlock(spec: IHttpRequestSpec, blockLines: readonly string[]): IHttpRequest {
	const request = httpRequestFromSpec(spec);
	request.description = spec.description ?? '';
	request.scripts = { preRequest: spec.preScript ?? '', test: spec.postScript ?? '' };
	for (const [key, value] of spec.disabledHeaders ?? []) {
		request.headers.push({ key, value, enabled: false });
	}
	const type = spec.headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
	const boundary = /multipart\/form-data;\s*boundary=("?)([^";]+)\1/i.exec(type)?.[2];
	if (boundary && spec.body) {
		const rows = parseMultipart(spec.body, boundary);
		if (rows) {
			request.body.mode = 'formdata';
			request.body.formdata = rows;
			request.body.raw = '';
			request.headers = request.headers.filter(row => row.key.toLowerCase() !== 'content-type');
		}
	}
	for (const line of blockLines) {
		const pathVariable = /^\s*(?:#|\/\/)\s*@path-variable\s+(\S+)\s?(.*)$/.exec(line);
		if (pathVariable) {
			const row = request.pathVariables.find(item => item.key === pathVariable[1]);
			if (row) {
				row.value = pathVariable[2];
			}
		}
		const disabledParam = /^\s*(?:#|\/\/)\s*@disabled-param\s+([^=]*)=?(.*)$/.exec(line);
		if (disabledParam) {
			request.params.push({ key: disabledParam[1].trim(), value: disabledParam[2], enabled: false });
		}
		const option = /^\s*(?:#|\/\/)\s*@([a-z-]+)\s+(.+)$/.exec(line);
		const key = option ? OPTION_DIRECTIVES[option[1]] : undefined;
		if (option && key) {
			const options = request.options ??= {};
			// Several `# @subscribe` lines are several topics.
			options[key] = key === 'subscribe' && options[key] ? `${options[key]}\n${option[2].trim()}` : option[2].trim();
		}
	}
	const settings = compactHttpSettings(settingsFromDirectives(blockLines));
	if (settings) {
		request.settings = settings;
	}
	return request;
}

const SETTING_SWITCHES = ['followOriginalHttpMethod', 'followAuthorizationHeader', 'removeRefererHeaderOnRedirect', 'strictHttpParser', 'encodeUrl', 'tlsPreferServerCiphers'] as const;

/**
 * A block's settings directives: JetBrains' `# @no-redirect` and `# @no-cookie-jar`, `# @insecure`
 * (the certificate is not verified), `# @timeout 5000` (ms), `# @http-version 1.1` or `2`, and
 * `# @setting <name> <value>` for the settings with no directive of their own.
 */
function settingsFromDirectives(lines: readonly string[]): IHttpRequestSettings {
	const settings: IHttpRequestSettings = {};
	for (const line of lines) {
		const directive = /^\s*(?:#|\/\/)\s*@([a-zA-Z-]+)(?:\s+(.*\S))?\s*$/.exec(line);
		if (!directive) {
			continue;
		}
		const value = directive[2] ?? '';
		switch (directive[1]) {
			case 'no-redirect': settings.followRedirects = false; break;
			case 'no-cookie-jar': settings.disableCookies = true; break;
			case 'insecure': settings.strictSSL = false; break;
			case 'timeout': settings.timeoutMs = Number(value); break;
			case 'http-version': settings.httpVersion = /^(?:2|2\.0|http\/?2)$/i.test(value) ? 'http2' : /^(?:1|1\.[01x]|http\/?1(?:\.[01x])?)$/i.test(value) ? 'http1' : 'auto'; break;
			case 'setting': {
				const [name, ...rest] = value.split(/\s+/);
				const text = rest.join(' ');
				const flag = SETTING_SWITCHES.find(key => key === name);
				if (flag) {
					settings[flag] = text !== 'false';
				} else if (name === 'maxRedirects') {
					settings.maxRedirects = Number(text);
				} else if (name === 'tlsDisabledProtocols') {
					settings.tlsDisabledProtocols = HTTP_TLS_PROTOCOLS.filter(protocol => text.split(/[\s,]+/).includes(protocol));
				} else if (name === 'tlsCipherSuites') {
					settings.tlsCipherSuites = text.split(/[\s,:]+/).filter(Boolean);
				}
				break;
			}
		}
	}
	return settings;
}

function settingsDirectives(settings: IHttpRequestSettings | undefined): string[] {
	const compact = compactHttpSettings(settings);
	if (!compact) {
		return [];
	}
	return [
		...(compact.httpVersion ? [`# @http-version ${compact.httpVersion === 'http2' ? '2' : '1.1'}`] : []),
		...(compact.strictSSL === false ? ['# @insecure'] : []),
		...(compact.followRedirects === false ? ['# @no-redirect'] : []),
		...(compact.disableCookies ? ['# @no-cookie-jar'] : []),
		...(compact.timeoutMs ? [`# @timeout ${compact.timeoutMs}`] : []),
		...SETTING_SWITCHES.filter(key => compact[key] !== undefined).map(key => `# @setting ${key} ${compact[key]}`),
		...(compact.maxRedirects !== undefined ? [`# @setting maxRedirects ${compact.maxRedirects}`] : []),
		...(compact.tlsDisabledProtocols ? [`# @setting tlsDisabledProtocols ${compact.tlsDisabledProtocols.join(',')}`] : []),
		...(compact.tlsCipherSuites ? [`# @setting tlsCipherSuites ${compact.tlsCipherSuites.join(':')}`] : []),
	];
}

/** Parses an `.http` file into a flat collection named `name`. */
export function httpFileToCollection(text: string, name: string): IHttpCollection {
	const collection = emptyHttpCollection(name, 'http');
	const lines = text.split(/\r?\n/);
	const chunks: { title: string; start: number; lines: string[] }[] = [{ title: '', start: 0, lines: [] }];
	for (let index = 0; index < lines.length; index++) {
		const separator = /^###\s*(.*)$/.exec(lines[index]);
		if (separator) {
			chunks.push({ title: separator[1].trim(), start: index + 1, lines: [] });
		} else {
			chunks[chunks.length - 1].lines.push(lines[index]);
		}
	}
	const preamble: string[] = [];
	// A variable counts while its chunk has no request content yet (the parser's own rule).
	const variables = parseHttpFile(text).variables;
	collection.variables = Object.entries(variables).map(([key, value]) => ({ key, value, enabled: true }));
	const head: string[] = [];
	let mcpUrl: string | undefined;
	for (const chunk of chunks) {
		const parsed = parseHttpFile(chunk.lines.join('\n')).requests[0];
		// A variable line counts while nothing of a request is above it in its chunk.
		const isVariable = (line: string, at: number) => isVariableLine(line) && !chunk.lines.slice(0, at).some(before => before.trim() && !/^\s*(#|\/\/)/.test(before) && !isVariableLine(before));
		if (!parsed) {
			// Comments and variables with no request under them: kept at the top of the file.
			head.push(...trimBlankEnds(chunk.lines));
			preamble.push(...trimBlankEnds(chunk.lines.filter((line, at) => !isVariable(line, at))));
			continue;
		}
		let lastVariable = -1;
		chunk.lines.forEach((line, at) => {
			if (isVariable(line, at)) {
				lastVariable = at;
			}
		});
		const lead = chunk.lines.slice(0, lastVariable + 1);
		head.push(...trimBlankEnds(lead));
		preamble.push(...trimBlankEnds(lead.filter((line, at) => !isVariable(line, at))));
		let spec: IHttpRequestSpec = { ...parsed, line: parsed.line + chunk.start, ...(parsed.name ? {} : chunk.title ? { name: chunk.title } : {}) };
		if (spec.protocol === 'mcp') {
			// `MCP SEND`: the next message to the server the block above talks to.
			if (/^send$/i.test(spec.url.trim()) && mcpUrl !== undefined) {
				spec = { ...spec, url: mcpUrl };
			} else {
				mcpUrl = spec.url;
			}
		}
		const request = requestFromBlock(spec, chunk.lines);
		const extra: IHttpBlockExtra = { block: trimBlankEnds(chunk.lines.slice(lastVariable + 1)).join('\n'), title: chunk.title, signature: signatureOf(request) };
		request.extra = extra;
		collection.items.push(request);
	}
	const fileExtra: IHttpFileExtra = { preamble: preamble.join('\n'), head: head.join('\n'), variables: JSON.stringify(collection.variables) };
	collection.extra = fileExtra;
	return collection;
}

/** The request as an `.http` block's spec: auth and content type as headers, the body in the file's own forms. */
export function httpFileSpecOf(request: IHttpRequest, collection?: IHttpCollection): IHttpRequestSpec {
	const { auth } = effectiveHttpAuth(request, [], collection);
	let url = request.url.trim();
	if (auth.type === 'apikey' && auth.keyIn === 'query' && auth.keyName.trim()) {
		url += `${url.includes('?') ? '&' : '?'}${auth.keyName.trim()}=${auth.keyValue}`;
	}
	const headers: [string, string][] = request.headers.filter(row => row.enabled && row.key.trim()).map(row => [row.key.trim(), row.value]);
	if (auth.type === 'oauth2' && auth.token && httpAuthParam(auth, 'addTokenTo') === 'queryParams') {
		url += `${url.includes('?') ? '&' : '?'}access_token=${auth.token}`;
	}
	// A signed type's header is computed for each send: a file cannot hold it.
	const auto = httpAutoHeaders(request, auth).filter(([, value]) => value !== HTTP_AUTH_COMPUTED);
	const body = request.body;
	let text: string | undefined;
	switch (body.mode) {
		case 'raw': text = body.raw; break;
		case 'urlencoded': text = body.urlencoded.filter(row => row.enabled && row.key).map(row => `${row.key}=${row.value}`).join('&'); break;
		case 'graphql':
			if (request.protocol !== 'graphql') {
				auto.unshift(['X-Request-Type', 'GraphQL']);
			}
			text = body.graphqlVariables.trim() ? `${body.graphqlQuery.trim()}\n\n${body.graphqlVariables.trim()}` : body.graphqlQuery;
			break;
		case 'formdata':
			auto.push(['Content-Type', `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`]);
			text = [
				...body.formdata.filter(row => row.enabled && row.key).flatMap(row => row.type === 'file'
					? [`--${MULTIPART_BOUNDARY}`, `Content-Disposition: form-data; name="${row.key}"; filename="${row.value.split(/[\\/]/).pop() ?? ''}"`, '', `< ${row.value}`]
					: [`--${MULTIPART_BOUNDARY}`, `Content-Disposition: form-data; name="${row.key}"`, '', row.value]),
				`--${MULTIPART_BOUNDARY}--`,
			].join('\n');
			break;
		case 'binary': text = body.binaryPath ? `< ${body.binaryPath}` : undefined; break;
	}
	const protocol = request.protocol && request.protocol !== 'http' ? request.protocol : undefined;
	if (protocol === 'ws' || protocol === 'socketio' || protocol === 'mqtt') {
		text = request.messages?.length ? httpMessagesToBody(request.messages) : undefined;
	} else if (protocol === 'sse') {
		text = undefined;
	}
	// What the kind's keyword already says is not written again as a header.
	const implied = new Set(protocol === 'graphql' || protocol === 'mcp' || protocol === 'ai' || protocol === 'soap' ? ['content-type'] : []);
	if (protocol === 'mcp') {
		implied.add('accept');
	}
	const written = auto.filter(([key]) => !implied.has(key.toLowerCase()));
	const named = /^[\w.-]+$/.test(request.name.trim());
	const disabledHeaders = request.headers.filter(row => !row.enabled && row.key.trim()).map(row => [row.key.trim(), row.value] as const);
	return {
		...(named ? { name: request.name.trim() } : {}),
		method: request.method,
		...(protocol ? { protocol } : {}),
		url,
		headers: [...headers, ...written],
		...(text !== undefined && text !== '' ? { body: text } : {}),
		line: request.line ?? 0,
		...(request.description.trim() ? { description: request.description.trim() } : {}),
		...(disabledHeaders.length ? { disabledHeaders } : {}),
		...(request.scripts.preRequest.trim() ? { preScript: request.scripts.preRequest.trim() } : {}),
		...(request.scripts.test.trim() ? { postScript: request.scripts.test.trim() } : {}),
	};
}

function blockOf(request: IHttpRequest, collection: IHttpCollection, mcpUrl?: string): { title: string; block: string } {
	const extra = request.extra as IHttpBlockExtra | undefined;
	if (extra && typeof extra.block === 'string' && extra.signature === signatureOf(request)) {
		return { title: extra.title, block: extra.block };
	}
	let spec = httpFileSpecOf(request, collection);
	if (spec.protocol === 'mcp' && mcpUrl !== undefined && spec.url === mcpUrl) {
		spec = { ...spec, url: 'SEND' };
	}
	const options = request.options ?? {};
	const directives = [
		...Object.entries(OPTION_DIRECTIVES).flatMap(([directive, key]) => (options[key] ?? '').split('\n').map(value => value.trim()).filter(Boolean).map(value => `# @${directive} ${value}`)),
		...request.pathVariables.filter(row => row.key && row.value).map(row => `# @path-variable ${row.key} ${row.value}`),
		...request.params.filter(row => !row.enabled && row.key).map(row => `# @disabled-param ${row.key}=${row.value}`),
		...settingsDirectives(request.settings),
	];
	// The description first, as a reader expects; then the directives, right above the request they belong to.
	const { description, ...rest } = spec;
	const block = [
		...(description ? description.split('\n').map(line => line ? `# ${line}` : '#') : []),
		...directives,
		serializeHttpRequest({ ...rest }),
	].join('\n');
	return { title: spec.name ? '' : request.name.trim(), block };
}

/**
 * The collection as `.http` text. Folders have no place in the format: their requests are written
 * in order, named `Folder / Request`. A collection loaded from an `.http` file writes its untouched
 * blocks back exactly as they were.
 */
export function collectionToHttpFile(collection: IHttpCollection): string {
	const out: string[] = [];
	const extra = collection.format === 'http' ? collection.extra as IHttpFileExtra | undefined : undefined;
	if (extra && typeof extra.head === 'string' && extra.variables === JSON.stringify(collection.variables)) {
		if (extra.head.trim()) {
			out.push(extra.head, '');
		}
	} else {
		if (extra && typeof extra.preamble === 'string' && extra.preamble.trim()) {
			out.push(extra.preamble, '');
		}
		const variables = collection.variables.filter(row => row.key);
		if (variables.length) {
			out.push(...variables.map(row => `${row.enabled ? '' : '# '}@${row.key} = ${row.value}`), '');
		}
	}
	const flat = collection.format === 'http'
		? collection.items.filter((item): item is IHttpRequest => item.kind === 'request')
		: httpRequestsOf(collection.items).map(({ request, ancestors }) => {
			// A Postman collection's request, flattened: its folders go into its name, its inherited auth into its headers.
			const { auth } = effectiveHttpAuth(request, ancestors, collection);
			return { ...request, name: [...ancestors.map(folder => folder.name), request.name].join(' / '), auth: request.auth.type === 'inherit' ? auth : request.auth, extra: undefined };
		});
	let mcpUrl: string | undefined;
	flat.forEach((request, index) => {
		const { title, block } = blockOf(request, collection, mcpUrl);
		if (request.protocol === 'mcp') {
			mcpUrl = request.url.trim();
		}
		if (index > 0 || title) {
			out.push(`###${title ? ` ${title}` : ''}`);
		}
		out.push(block, '');
	});
	return `${trimBlankEnds(out).join('\n')}\n`;
}

/** After a save: the requests take their new lines and block texts from the text just written. */
export function refreshHttpFileModel(collection: IHttpCollection, text: string): void {
	const fresh = httpFileToCollection(text, collection.name);
	const requests = collection.items.filter((item): item is IHttpRequest => item.kind === 'request');
	fresh.items.forEach((item, index) => {
		const target = requests[index];
		if (target && item.kind === 'request') {
			target.line = item.line;
			target.extra = { ...(item.extra as IHttpBlockExtra), signature: signatureOf(target) };
		}
	});
	collection.extra = fresh.extra;
}

/** `http-client.env.json`'s environments as rows; `$shared` stays its own entry. */
export function parseHttpClientEnvFile(text: string): { name: string; variables: IHttpKeyValue[] }[] {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	if (!json || typeof json !== 'object' || Array.isArray(json)) {
		return [];
	}
	return Object.entries(json as Record<string, unknown>).filter(([, vars]) => !!vars && typeof vars === 'object' && !Array.isArray(vars)).map(([name, vars]) => ({
		name,
		variables: Object.entries(vars as Record<string, unknown>).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value), enabled: true })),
	}));
}

/** `text` (an `http-client.env.json`) with one environment's variables replaced; the others stay as written. */
export function updateHttpClientEnvFile(text: string, name: string, variables: readonly IHttpKeyValue[] | undefined): string {
	let json: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			json = parsed as Record<string, unknown>;
		}
	} catch { /* a new or broken file starts over */ }
	if (variables) {
		json[name] = Object.fromEntries(variables.filter(row => row.enabled && row.key).map(row => [row.key, row.value]));
	} else {
		delete json[name];
	}
	return `${JSON.stringify(json, null, 2)}\n`;
}

/** The request tables after a URL edit: params and path variables follow the URL. */
export function syncHttpRequestUrl(request: IHttpRequest, url: string): void {
	request.url = url;
	request.params = httpParamsFromUrl(url, request.params);
	request.pathVariables = httpPathVariablesFor(url, request.pathVariables);
}
