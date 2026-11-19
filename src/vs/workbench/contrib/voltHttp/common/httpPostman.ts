/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Postman's files: collections (v2.1, and v2.0 on the way in) and environments, to and from the
 * HTTP client's model. What the model does not hold (saved examples, ids, request settings) rides
 * along in `extra` and is written back, so a file opened and saved here still opens in Postman
 * with everything it had.
 */

import { isHttpProtocol } from './httpProtocols.js';
import { compactHttpSettings, HTTP_TLS_PROTOCOLS, IHttpRequestSettings, emptyHttpAuth, emptyHttpBody, emptyHttpScripts, httpParamsFromUrl, httpPathVariablesFor, httpQueryOf, httpUrlWithQuery, HttpRawLanguage, IHttpAuth, IHttpBody, IHttpCollection, IHttpEnvironment, IHttpFolder, IHttpItem, IHttpKeyValue, IHttpRequest, IHttpScripts, newHttpId } from './httpCollection.js';

export const POSTMAN_SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

type Json = Record<string, unknown>;

function rec(value: unknown): Json | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** `rest` of an object without the keys the model owns. */
function without(value: Json, keys: readonly string[]): Json {
	const out: Json = {};
	for (const [key, item] of Object.entries(value)) {
		if (!keys.includes(key)) {
			out[key] = item;
		}
	}
	return out;
}

function descriptionOf(value: unknown): string {
	return typeof value === 'string' ? value : text(rec(value)?.content);
}

export function isPostmanCollection(json: unknown): boolean {
	const root = rec(json);
	const info = rec(root?.info);
	if (!root || !info) {
		return false;
	}
	return /getpostman\.com\/json\/collection|schema\.postman\.com\/json\/collection/.test(text(info.schema)) || (Array.isArray(root.item) && typeof info.name === 'string');
}

export function isPostmanEnvironment(json: unknown): boolean {
	const root = rec(json);
	return !!root && !root.info && Array.isArray(root.values) && (typeof root.name === 'string' || typeof root._postman_variable_scope === 'string');
}

// --- reading ----------------------------------------------------------------------------------

function keyValues(value: unknown): IHttpKeyValue[] {
	return list(value).map(rec).filter((row): row is Json => !!row).map(row => {
		const description = descriptionOf(row.description);
		return { key: text(row.key), value: text(row.value), enabled: row.disabled !== true, ...(description ? { description } : {}) };
	});
}

/** An auth's settings: a list of `{ key, value }` in v2.1, a plain object in v2.0. */
function authSettings(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (Array.isArray(value)) {
		for (const row of value.map(rec)) {
			if (row && typeof row.key === 'string') {
				out[row.key] = text(row.value);
			}
		}
	} else {
		for (const [key, item] of Object.entries(rec(value) ?? {})) {
			out[key] = text(item);
		}
	}
	return out;
}

function readAuth(value: unknown, absent: 'inherit' | 'none'): IHttpAuth {
	const auth = rec(value);
	const type = text(auth?.type);
	if (!auth || !type) {
		return emptyHttpAuth(absent);
	}
	const settings = authSettings(auth[type]);
	switch (type) {
		case 'noauth': return emptyHttpAuth('none');
		case 'bearer': return { ...emptyHttpAuth('bearer'), token: settings.token ?? '' };
		case 'basic': return { ...emptyHttpAuth('basic'), username: settings.username ?? '', password: settings.password ?? '' };
		case 'apikey': return { ...emptyHttpAuth('apikey'), keyName: settings.key ?? '', keyValue: settings.value ?? '', keyIn: settings.in === 'query' ? 'query' : 'header' };
		case 'oauth2': {
			const { accessToken, ...params } = settings;
			return { ...emptyHttpAuth('oauth2'), token: accessToken ?? '', params, raw: auth };
		}
		case 'jwt': case 'digest': case 'oauth1': case 'hawk': case 'awsv4': case 'ntlm': case 'edgegrid': case 'asap':
			return { ...emptyHttpAuth(type), params: settings, raw: auth };
	}
	return { ...emptyHttpAuth('other'), raw: auth };
}

function readScripts(events: unknown): IHttpScripts {
	const scripts = emptyHttpScripts();
	for (const event of list(events).map(rec)) {
		const exec = rec(event?.script)?.exec;
		const code = Array.isArray(exec) ? exec.map(text).join('\n') : text(exec);
		if (event?.listen === 'prerequest') {
			scripts.preRequest = code;
		} else if (event?.listen === 'test') {
			scripts.test = code;
		}
	}
	return scripts;
}

function joined(value: unknown, separator: string): string {
	return Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : text(rec(part)?.value)).join(separator) : text(value);
}

function readUrl(value: unknown): { url: string; params: IHttpKeyValue[]; pathVariables: IHttpKeyValue[] } {
	const object = rec(value);
	let raw = typeof value === 'string' ? value : text(object?.raw);
	if (object && !raw) {
		const host = joined(object.host, '.');
		const path = joined(object.path, '/');
		raw = `${object.protocol ? `${text(object.protocol)}://` : ''}${host}${object.port ? `:${text(object.port)}` : ''}${path ? `/${path.replace(/^\//, '')}` : ''}`;
		const query = keyValues(object.query).filter(row => row.enabled);
		raw = httpUrlWithQuery(raw, query);
		if (object.hash) {
			raw += `#${text(object.hash)}`;
		}
	}
	let params: IHttpKeyValue[];
	if (object && Array.isArray(object.query)) {
		params = keyValues(object.query);
		// The URL holds exactly the checked rows; a raw that already does is kept as written.
		const typed = httpQueryOf(raw);
		const checked = params.filter(row => row.enabled && (row.key || row.value));
		if (typed.length !== checked.length || typed.some((pair, at) => pair.key !== checked[at].key || pair.value !== checked[at].value)) {
			raw = httpUrlWithQuery(raw, params);
		}
	} else {
		params = httpParamsFromUrl(raw, []);
	}
	return { url: raw, params, pathVariables: httpPathVariablesFor(raw, keyValues(object?.variable)) };
}

function readHeaders(value: unknown): IHttpKeyValue[] {
	if (typeof value === 'string') {
		return value.split(/\r?\n/).filter(line => line.trim()).map(line => {
			const disabled = line.startsWith('//');
			const body = disabled ? line.slice(2) : line;
			const at = body.indexOf(':');
			return { key: (at < 0 ? body : body.slice(0, at)).trim(), value: at < 0 ? '' : body.slice(at + 1).trim(), enabled: !disabled };
		});
	}
	return keyValues(value);
}

const RAW_LANGUAGES: readonly HttpRawLanguage[] = ['json', 'text', 'xml', 'html', 'javascript'];

function readBody(value: unknown, headers: readonly IHttpKeyValue[]): IHttpBody {
	const body = emptyHttpBody();
	const source = rec(value);
	if (!source) {
		return body;
	}
	switch (text(source.mode)) {
		case 'raw': {
			body.mode = 'raw';
			body.raw = text(source.raw);
			const language = text(rec(rec(source.options)?.raw)?.language) as HttpRawLanguage;
			if (RAW_LANGUAGES.includes(language)) {
				body.language = language;
			} else {
				const type = headers.find(row => row.key.toLowerCase() === 'content-type')?.value ?? '';
				body.language = /json/i.test(type) || (!type && /^\s*[[{]/.test(body.raw)) ? 'json' : /xml/i.test(type) ? 'xml' : /html/i.test(type) ? 'html' : /javascript/i.test(type) ? 'javascript' : 'text';
			}
			break;
		}
		case 'urlencoded':
			body.mode = 'urlencoded';
			body.urlencoded = keyValues(source.urlencoded);
			break;
		case 'formdata':
			body.mode = 'formdata';
			body.formdata = list(source.formdata).map(rec).filter((row): row is Json => !!row).map(row => {
				const description = descriptionOf(row.description);
				const file = row.type === 'file';
				const src = Array.isArray(row.src) ? text(row.src[0]) : text(row.src);
				return { key: text(row.key), value: file ? src : text(row.value), enabled: row.disabled !== true, type: file ? 'file' as const : 'text' as const, ...(description ? { description } : {}) };
			});
			break;
		case 'file':
			body.mode = 'binary';
			body.binaryPath = text(rec(source.file)?.src);
			break;
		case 'graphql': {
			const graphql = rec(source.graphql);
			body.mode = 'graphql';
			body.graphqlQuery = text(graphql?.query);
			body.graphqlVariables = text(graphql?.variables);
			break;
		}
	}
	return body;
}

/** `protocolProfileBehavior` keys that are a plain switch with the same meaning as the setting of the same name. */
const BEHAVIOR_SWITCHES = ['strictSSL', 'followRedirects', 'followOriginalHttpMethod', 'followAuthorizationHeader', 'removeRefererHeaderOnRedirect', 'disableCookies', 'tlsPreferServerCiphers'] as const;
/** Every `protocolProfileBehavior` key the settings own; the others (`disableBodyPruning`, `disabledSystemHeaders`) stay as the file had them. */
const BEHAVIOR_KEYS: readonly string[] = [...BEHAVIOR_SWITCHES, 'insecureHTTPParser', 'disableUrlEncoding', 'maxRedirects', 'tlsDisabledProtocols', 'tlsCipherSelection', 'protocolVersion', 'voltTimeoutMs'];

/** An item's `protocolProfileBehavior` as the request's settings. */
function readSettings(value: unknown): IHttpRequestSettings | undefined {
	const behavior = rec(value);
	if (!behavior) {
		return undefined;
	}
	const settings: IHttpRequestSettings = {};
	for (const key of BEHAVIOR_SWITCHES) {
		if (typeof behavior[key] === 'boolean') {
			settings[key] = behavior[key];
		}
	}
	// Postman names these two by what they switch off.
	if (typeof behavior.insecureHTTPParser === 'boolean') {
		settings.strictHttpParser = !behavior.insecureHTTPParser;
	}
	if (typeof behavior.disableUrlEncoding === 'boolean') {
		settings.encodeUrl = !behavior.disableUrlEncoding;
	}
	if (typeof behavior.maxRedirects === 'number') {
		settings.maxRedirects = behavior.maxRedirects;
	}
	if (Array.isArray(behavior.tlsDisabledProtocols)) {
		settings.tlsDisabledProtocols = HTTP_TLS_PROTOCOLS.filter(protocol => list(behavior.tlsDisabledProtocols).includes(protocol));
	}
	if (Array.isArray(behavior.tlsCipherSelection)) {
		settings.tlsCipherSuites = behavior.tlsCipherSelection.filter((cipher): cipher is string => typeof cipher === 'string');
	}
	if (behavior.protocolVersion === 'http1' || behavior.protocolVersion === 'http2') {
		settings.httpVersion = behavior.protocolVersion;
	}
	if (typeof behavior.voltTimeoutMs === 'number') {
		settings.timeoutMs = behavior.voltTimeoutMs;
	}
	return compactHttpSettings(settings);
}

/**
 * The settings as `protocolProfileBehavior`: only what differs from the defaults, over the keys
 * of the file's own that the settings do not hold. The timeout has no Postman key: `voltTimeoutMs`.
 */
function writeSettings(settings: IHttpRequestSettings | undefined, before: unknown): Json | undefined {
	const out: Json = without(rec(before) ?? {}, BEHAVIOR_KEYS);
	const compact = compactHttpSettings(settings) ?? {};
	for (const key of BEHAVIOR_SWITCHES) {
		if (compact[key] !== undefined) {
			out[key] = compact[key];
		}
	}
	if (compact.strictHttpParser !== undefined) {
		out.insecureHTTPParser = !compact.strictHttpParser;
	}
	if (compact.encodeUrl !== undefined) {
		out.disableUrlEncoding = !compact.encodeUrl;
	}
	if (compact.maxRedirects !== undefined) {
		out.maxRedirects = compact.maxRedirects;
	}
	if (compact.tlsDisabledProtocols) {
		out.tlsDisabledProtocols = compact.tlsDisabledProtocols;
	}
	if (compact.tlsCipherSuites) {
		out.tlsCipherSelection = compact.tlsCipherSuites;
	}
	if (compact.httpVersion) {
		out.protocolVersion = compact.httpVersion;
	}
	if (compact.timeoutMs !== undefined) {
		out.voltTimeoutMs = compact.timeoutMs;
	}
	return Object.keys(out).length ? out : undefined;
}

const ITEM_KEYS = ['name', 'request', 'item', 'description', 'auth', 'volt'];
const REQUEST_KEYS = ['method', 'header', 'body', 'url', 'auth', 'description'];

function readItem(value: unknown): IHttpItem | undefined {
	const item = rec(value);
	if (!item) {
		return undefined;
	}
	if (Array.isArray(item.item)) {
		const folder: IHttpFolder = {
			kind: 'folder',
			id: newHttpId(),
			name: text(item.name),
			description: descriptionOf(item.description),
			auth: readAuth(item.auth, 'inherit'),
			scripts: readScripts(item.event),
			items: item.item.map(readItem).filter((child): child is IHttpItem => !!child),
		};
		const rest = without(item, ITEM_KEYS);
		if (Object.keys(rest).length) {
			folder.extra = rest;
		}
		return folder;
	}
	const source = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : rec(item.request) ?? {};
	const headers = readHeaders(source.header);
	const { url, params, pathVariables } = readUrl(source.url);
	const request: IHttpRequest = {
		kind: 'request',
		id: newHttpId(),
		name: text(item.name),
		description: descriptionOf(source.description) || descriptionOf(item.description),
		method: (text(source.method) || 'GET').toUpperCase(),
		url,
		params,
		pathVariables,
		headers,
		body: readBody(source.body, headers),
		auth: readAuth(source.auth, 'inherit'),
		scripts: readScripts(item.event),
	};
	// What Postman's format has no place for (the kind of request, its messages) rides in the item's `volt` key.
	const volt = rec(item.volt);
	if (volt && isHttpProtocol(volt.protocol) && volt.protocol !== 'http') {
		request.protocol = volt.protocol;
		if (Array.isArray(volt.messages)) {
			request.messages = volt.messages.map(rec).filter((message): message is Json => !!message).map(message => ({ ...(text(message.target) ? { target: text(message.target) } : {}), body: text(message.body) }));
		}
		const options = rec(volt.options);
		if (options) {
			request.options = Object.fromEntries(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
		}
	}
	const settings = readSettings(item.protocolProfileBehavior);
	if (settings) {
		request.settings = settings;
	}
	const restItem = without(item, ITEM_KEYS);
	const restRequest = without(source, REQUEST_KEYS);
	if (Object.keys(restItem).length || Object.keys(restRequest).length) {
		request.extra = { item: restItem, ...(Object.keys(restRequest).length ? { request: restRequest } : {}) };
	}
	return request;
}

/** A Postman collection file (v2.1 or v2.0) as a collection. Throws when the JSON is not one. */
export function postmanToCollection(json: unknown): IHttpCollection {
	const root = rec(json);
	const info = rec(root?.info);
	if (!root || !info || !Array.isArray(root.item)) {
		throw new Error('Not a Postman collection: it needs "info" and an "item" list (Collection v2.0 or v2.1).');
	}
	const collection: IHttpCollection = {
		format: 'postman',
		name: text(info.name) || 'Collection',
		description: descriptionOf(info.description),
		variables: keyValues(root.variable),
		auth: readAuth(root.auth, 'none'),
		scripts: readScripts(root.event),
		items: root.item.map(readItem).filter((item): item is IHttpItem => !!item),
	};
	collection.extra = { ...without(root, ['info', 'item', 'variable', 'auth']), info: without(info, ['name', 'description', 'schema']) };
	return collection;
}

// --- writing ----------------------------------------------------------------------------------

function writeKeyValues(rows: readonly IHttpKeyValue[]): Json[] {
	return rows.filter(row => row.key || row.value).map(row => ({ key: row.key, value: row.value, ...(row.description ? { description: row.description } : {}), ...(row.enabled ? {} : { disabled: true }) }));
}

function setting(key: string, value: string): Json {
	return { key, value, type: 'string' };
}

function writeAuth(auth: IHttpAuth): Json | undefined {
	switch (auth.type) {
		case 'inherit': return undefined;
		case 'none': return { type: 'noauth' };
		case 'bearer': return { type: 'bearer', bearer: [setting('token', auth.token)] };
		case 'basic': return { type: 'basic', basic: [setting('username', auth.username), setting('password', auth.password)] };
		case 'apikey': return { type: 'apikey', apikey: [setting('key', auth.keyName), setting('value', auth.keyValue), setting('in', auth.keyIn)] };
		case 'oauth2': {
			const others = writeAuthParams('oauth2', auth);
			return { type: 'oauth2', oauth2: [setting('accessToken', auth.token), ...(others.length ? others : [setting('addTokenTo', 'header')])] };
		}
		case 'jwt': case 'digest': case 'oauth1': case 'hawk': case 'awsv4': case 'ntlm': case 'edgegrid': case 'asap':
			return { type: auth.type, [auth.type]: writeAuthParams(auth.type, auth) };
		case 'other': return rec(auth.raw) ?? { type: 'noauth' };
	}
}

/** The settings Postman writes as booleans. */
const AUTH_BOOLEANS: ReadonlySet<string> = new Set(['isSecretBase64Encoded', 'disableRetryRequest', 'addParamsToHeader', 'addEmptyParamsToSign', 'includeBodyHash', 'disableHeaderEncoding', 'includePayloadHash', 'addAuthDataToQuery', 'useBrowser']);

/**
 * `auth.params` as Postman's setting rows. A row the file had and that still says the same is
 * written as it was (its value's type, its own extra keys); keys the editor does not show are in
 * `params` like any other, so they are written too.
 */
function writeAuthParams(type: string, auth: IHttpAuth): Json[] {
	const before = new Map<string, Json>();
	for (const row of list(rec(auth.raw)?.[type]).map(rec)) {
		if (row && typeof row.key === 'string') {
			before.set(row.key, row);
		}
	}
	return Object.entries(auth.params ?? {}).map(([key, value]) => {
		const was = before.get(key);
		if (was && text(was.value) === value) {
			return was;
		}
		return AUTH_BOOLEANS.has(key) && (value === 'true' || value === 'false') ? { key, value: value === 'true', type: 'boolean' } : setting(key, value);
	});
}

/** The `event` list: the file's own entries (ids, packages) with the scripts as they are now. */
function writeEvents(scripts: IHttpScripts, before: unknown): Json[] | undefined {
	const events: Json[] = [];
	const known = list(before).map(rec).filter((event): event is Json => !!event);
	for (const [listen, code] of [['prerequest', scripts.preRequest], ['test', scripts.test]] as const) {
		const old = known.find(event => event.listen === listen);
		if (code.trim()) {
			events.push({ ...old, listen, script: { type: 'text/javascript', ...rec(old?.script), exec: code.split('\n') } });
		}
	}
	events.push(...known.filter(event => event.listen !== 'prerequest' && event.listen !== 'test'));
	return events.length ? events : undefined;
}

/** `a.b.{{c.d}}` split on the dots outside `{{}}`. */
function splitOutsideVariables(value: string, separator: string): string[] {
	const parts: string[] = [];
	let current = '';
	for (let index = 0; index < value.length; index++) {
		if (value.startsWith('{{', index)) {
			const end = value.indexOf('}}', index);
			if (end >= 0) {
				current += value.slice(index, end + 2);
				index = end + 1;
				continue;
			}
		}
		if (value[index] === separator) {
			parts.push(current);
			current = '';
		} else {
			current += value[index];
		}
	}
	parts.push(current);
	return parts;
}

function writeUrl(request: IHttpRequest): Json {
	const url: Json = { raw: request.url };
	const hashAt = request.url.indexOf('#');
	const beforeHash = hashAt < 0 ? request.url : request.url.slice(0, hashAt);
	const base = beforeHash.split('?')[0];
	const parsed = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]*)(\/.*)?$/i.exec(base);
	if (parsed && parsed[2]) {
		if (parsed[1]) {
			url.protocol = parsed[1];
		}
		let host = parsed[2];
		const port = /^(.*):(\d+|\{\{[^{}]+\}\})$/.exec(host);
		if (port && port[1]) {
			host = port[1];
		}
		url.host = splitOutsideVariables(host, '.');
		if (port && port[1]) {
			url.port = port[2];
		}
		if (parsed[3] && parsed[3] !== '/') {
			url.path = parsed[3].slice(1).split('/');
		} else if (parsed[3] === '/') {
			url.path = [''];
		}
	}
	const query = writeKeyValues(request.params);
	if (query.length) {
		url.query = query;
	}
	if (hashAt >= 0) {
		url.hash = request.url.slice(hashAt + 1);
	}
	const variables = request.pathVariables.filter(row => row.key).map(row => ({ key: row.key, value: row.value, ...(row.description ? { description: row.description } : {}) }));
	if (variables.length) {
		url.variable = variables;
	}
	return url;
}

function writeBody(body: IHttpBody): Json | undefined {
	switch (body.mode) {
		case 'none': return undefined;
		case 'raw': return { mode: 'raw', raw: body.raw, options: { raw: { language: body.language } } };
		case 'urlencoded': return { mode: 'urlencoded', urlencoded: writeKeyValues(body.urlencoded).map(row => ({ ...row, type: 'text' })) };
		case 'formdata': return {
			mode: 'formdata',
			formdata: body.formdata.filter(row => row.key || row.value).map(row => ({
				key: row.key,
				...(row.type === 'file' ? { type: 'file', src: row.value } : { value: row.value, type: 'text' }),
				...(row.description ? { description: row.description } : {}),
				...(row.enabled ? {} : { disabled: true }),
			})),
		};
		case 'binary': return { mode: 'file', file: { src: body.binaryPath } };
		case 'graphql': return { mode: 'graphql', graphql: { query: body.graphqlQuery, variables: body.graphqlVariables } };
	}
}

function writeItem(item: IHttpItem): Json {
	if (item.kind === 'folder') {
		const rest = rec(item.extra) ?? {};
		const auth = writeAuth(item.auth);
		const event = writeEvents(item.scripts, rest.event);
		return {
			name: item.name,
			...(item.description ? { description: item.description } : {}),
			item: item.items.map(writeItem),
			...(auth ? { auth } : {}),
			...(event ? { event } : {}),
			...without(rest, ['event']),
		};
	}
	const extra = rec(item.extra);
	const restItem = rec(extra?.item) ?? {};
	const restRequest = rec(extra?.request) ?? {};
	const auth = writeAuth(item.auth);
	const event = writeEvents(item.scripts, restItem.event);
	const body = writeBody(item.body);
	const behavior = writeSettings(item.settings, restItem.protocolProfileBehavior);
	return {
		name: item.name,
		...(event ? { event } : {}),
		...(behavior ? { protocolProfileBehavior: behavior } : {}),
		request: {
			...(auth ? { auth } : {}),
			method: item.method,
			header: writeKeyValues(item.headers),
			...(body ? { body } : {}),
			url: writeUrl(item),
			...(item.description ? { description: item.description } : {}),
			...restRequest,
		},
		response: [],
		...(item.protocol && item.protocol !== 'http' ? { volt: { protocol: item.protocol, ...(item.messages?.length ? { messages: item.messages } : {}), ...(item.options && Object.keys(item.options).length ? { options: item.options } : {}) } } : {}),
		...without(restItem, ['event', 'protocolProfileBehavior']),
	};
}

/** The collection as a Postman Collection v2.1 file; `JSON.stringify(it, null, '\t')` is the file. */
export function collectionToPostman(collection: IHttpCollection): Record<string, unknown> {
	const extra = rec(collection.extra) ?? {};
	const info = rec(extra.info) ?? {};
	const auth = writeAuth(collection.auth);
	const event = writeEvents(collection.scripts, extra.event);
	const variable = writeKeyValues(collection.variables);
	return {
		info: {
			...(info._postman_id !== undefined ? { _postman_id: info._postman_id } : {}),
			name: collection.name,
			...(collection.description ? { description: collection.description } : {}),
			schema: POSTMAN_SCHEMA_V21,
			...without(info, ['_postman_id']),
		},
		item: collection.items.map(writeItem),
		...(auth ? { auth } : {}),
		...(event ? { event } : {}),
		...(variable.length ? { variable } : {}),
		...without(extra, ['info', 'event']),
	};
}

// --- environments -----------------------------------------------------------------------------

/** A Postman environment (or globals) file. Throws when the JSON is not one. */
export function postmanToEnvironment(json: unknown): IHttpEnvironment {
	const root = rec(json);
	if (!root || !Array.isArray(root.values)) {
		throw new Error('Not a Postman environment: it needs a "values" list.');
	}
	return {
		format: 'postman',
		name: text(root.name) || (root._postman_variable_scope === 'globals' ? 'Globals' : 'Environment'),
		variables: root.values.map(rec).filter((row): row is Json => !!row).map(row => ({
			key: text(row.key),
			value: text(row.value),
			enabled: row.enabled !== false,
			...(row.type === 'secret' ? { secret: true } : {}),
			...(descriptionOf(row.description) ? { description: descriptionOf(row.description) } : {}),
		})),
		extra: without(root, ['name', 'values']),
	};
}

export function environmentToPostman(environment: IHttpEnvironment): Record<string, unknown> {
	const extra = rec(environment.extra) ?? {};
	return {
		...(extra.id !== undefined ? { id: extra.id } : {}),
		name: environment.name,
		values: environment.variables.filter(row => row.key || row.value).map(row => ({
			key: row.key,
			value: row.value,
			type: row.secret ? 'secret' : 'default',
			enabled: row.enabled,
			...(row.description ? { description: row.description } : {}),
		})),
		_postman_variable_scope: typeof extra._postman_variable_scope === 'string' ? extra._postman_variable_scope : 'environment',
		...without(extra, ['id', '_postman_variable_scope']),
	};
}
