/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The HTTP client's one model of a collection: folders of requests with params, headers, a body,
 * authorization and scripts. A Postman collection file and an `.http` file both load into it and
 * save from it (`httpPostman.ts`, `httpDotHttp.ts`), so the window, the agents' tools, import and
 * export all work on the same shape whatever the file is.
 */

import { generateUuid } from '../../../../base/common/uuid.js';
import { httpProtocolMethod, IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { graphqlOperationName, HTTP_AI_PROVIDERS, HTTP_SOAP_ENVELOPE, httpAiBodyOf, httpAiProviderOf, httpMcpMessage, httpMessagesFromBody, HttpProtocol, IHttpMessage, isHttpProtocol } from './httpProtocols.js';

export interface IHttpKeyValue {
	key: string;
	value: string;
	enabled: boolean;
	description?: string;
	/** A form-data row that sends a file: `value` is its path. */
	type?: 'text' | 'file';
	/** An environment value shown masked. */
	secret?: boolean;
}

export type HttpBodyMode = 'none' | 'formdata' | 'urlencoded' | 'raw' | 'binary' | 'graphql';
export type HttpRawLanguage = 'json' | 'text' | 'xml' | 'html' | 'javascript';

export interface IHttpBody {
	mode: HttpBodyMode;
	raw: string;
	language: HttpRawLanguage;
	urlencoded: IHttpKeyValue[];
	formdata: IHttpKeyValue[];
	graphqlQuery: string;
	graphqlVariables: string;
	/** The file a binary body sends. */
	binaryPath: string;
}

/**
 * `inherit` takes the parent folder's (then the collection's); `other` is a type the editor does
 * not know: its file form is kept in `raw` and written back untouched.
 */
export type HttpAuthType = 'inherit' | 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'jwt' | 'digest' | 'oauth1' | 'hawk' | 'awsv4' | 'ntlm' | 'edgegrid' | 'asap' | 'other';

export interface IHttpAuth {
	type: HttpAuthType;
	/** Bearer's token, OAuth 2.0's access token. */
	token: string;
	/** Basic's. The other types' names and passwords are in `params`. */
	username: string;
	password: string;
	keyName: string;
	keyValue: string;
	keyIn: 'header' | 'query';
	/**
	 * The fields of JWT, Digest, OAuth 1.0, Hawk, AWS, NTLM, EdgeGrid and ASAP, and OAuth 2.0's
	 * beyond the access token, under Postman's own key names (booleans as 'true' / 'false').
	 * Read one with `httpAuthParam`, which knows the defaults.
	 */
	params?: Record<string, string>;
	/** The file's own form, for what the model does not hold (a value's type, keys beside the settings). */
	raw?: unknown;
}

/** What a field is when the auth does not say, as Postman starts it. */
export const HTTP_AUTH_DEFAULTS: Readonly<Partial<Record<HttpAuthType, Readonly<Record<string, string>>>>> = {
	oauth2: { headerPrefix: 'Bearer', addTokenTo: 'header', grant_type: 'authorization_code', client_authentication: 'header', challengeAlgorithm: 'S256' },
	jwt: { algorithm: 'HS256', isSecretBase64Encoded: 'false', payload: '{}', addTokenTo: 'header', headerPrefix: 'Bearer', queryParamKey: 'token', header: '{}' },
	digest: { algorithm: 'MD5', disableRetryRequest: 'false' },
	oauth1: { signatureMethod: 'HMAC-SHA1', version: '1.0', addParamsToHeader: 'false', addEmptyParamsToSign: 'false', includeBodyHash: 'false', disableHeaderEncoding: 'false' },
	hawk: { algorithm: 'sha256', includePayloadHash: 'false' },
	awsv4: { addAuthDataToQuery: 'false' },
	ntlm: { disableRetryRequest: 'false' },
	edgegrid: {},
	asap: { alg: 'RS256' },
};

/** A field of `auth.params`, or its default. */
export function httpAuthParam(auth: IHttpAuth, key: string): string {
	return auth.params?.[key] ?? HTTP_AUTH_DEFAULTS[auth.type]?.[key] ?? '';
}

/** In the Headers tab's "auto" Authorization row for a type whose header is worked out from the request as it goes. */
export const HTTP_AUTH_COMPUTED = '<computed when sent>';

/** Whether the type writes an Authorization header that `signHttpRequest` computes at send time. */
export function httpAuthSignsHeader(auth: IHttpAuth): boolean {
	switch (auth.type) {
		case 'jwt': return httpAuthParam(auth, 'addTokenTo') !== 'queryParam';
		case 'oauth1': return httpAuthParam(auth, 'addParamsToHeader') === 'true';
		case 'awsv4': return httpAuthParam(auth, 'addAuthDataToQuery') !== 'true';
		case 'digest': case 'hawk': case 'edgegrid': case 'asap': return true;
		default: return false;
	}
}

export interface IHttpScripts {
	/** Runs before the request goes out. */
	preRequest: string;
	/** Runs on the response (Postman's Tests / Post-response). */
	test: string;
}

export interface IHttpRequest {
	kind: 'request';
	/** Stable while the collection is loaded; a reload keeps it for the item at the same name path. */
	id: string;
	name: string;
	description: string;
	method: string;
	/** As typed: the enabled query params are part of it. */
	url: string;
	/** Every query param row, the unchecked ones too. The checked ones mirror `url`'s query. */
	params: IHttpKeyValue[];
	/** Values for `:name` path segments. */
	pathVariables: IHttpKeyValue[];
	headers: IHttpKeyValue[];
	body: IHttpBody;
	auth: IHttpAuth;
	scripts: IHttpScripts;
	/** The kind of request; plain HTTP when absent. */
	protocol?: HttpProtocol;
	/** WebSocket, Socket.IO, MQTT: what is sent, in order, once the connection opens. */
	messages?: IHttpMessage[];
	/**
	 * What a kind needs beyond the URL and headers: `proto` (gRPC: the .proto file's path),
	 * `subscribe` (MQTT: topic filters, one per line), `clientId`, `qos`, `path` and `auth`
	 * (Socket.IO: the engine path and the connect payload).
	 */
	options?: Record<string, string>;
	/** How the request goes out (TLS, redirects, cookies); only what differs from the defaults. */
	settings?: IHttpRequestSettings;
	/** The request line in an `.http` file (1-based). */
	line?: number;
	/** What the file had that the model does not hold (saved examples, settings); written back untouched. */
	extra?: unknown;
}

export type HttpVersionSetting = 'auto' | 'http1' | 'http2';

export const HTTP_TLS_PROTOCOLS = ['TLSv1', 'TLSv1_1', 'TLSv1_2', 'TLSv1_3'] as const;
export type HttpTlsProtocol = typeof HTTP_TLS_PROTOCOLS[number];

/**
 * A request's Settings tab, with the meaning of Postman's `protocolProfileBehavior` so a Postman
 * file round-trips. A field is present only while it differs from `HTTP_SETTINGS_DEFAULTS`.
 */
export interface IHttpRequestSettings {
	httpVersion?: HttpVersionSetting;
	/** Verify the server's certificate. */
	strictSSL?: boolean;
	followRedirects?: boolean;
	/** Redirect with the original method instead of GET (301, 302, 303). */
	followOriginalHttpMethod?: boolean;
	/** Keep the Authorization header when a redirect goes to another host. */
	followAuthorizationHeader?: boolean;
	removeRefererHeaderOnRedirect?: boolean;
	/** Refuse responses with invalid HTTP headers (Postman's `insecureHTTPParser`, inverted). */
	strictHttpParser?: boolean;
	/** Percent-encode the URL's path and query (Postman's `disableUrlEncoding`, inverted). */
	encodeUrl?: boolean;
	/** The cookie jar's cookies are not added to this request. */
	disableCookies?: boolean;
	tlsPreferServerCiphers?: boolean;
	maxRedirects?: number;
	tlsDisabledProtocols?: HttpTlsProtocol[];
	/** Cipher suites in order, OpenSSL names. */
	tlsCipherSuites?: string[];
	/** How long to wait for the response; the client's default when absent. */
	timeoutMs?: number;
}

export type HttpRequestSettingKey = keyof IHttpRequestSettings;

export const HTTP_SETTINGS_DEFAULTS: Readonly<Required<Omit<IHttpRequestSettings, 'timeoutMs'>>> = {
	httpVersion: 'auto',
	strictSSL: true,
	followRedirects: true,
	followOriginalHttpMethod: false,
	followAuthorizationHeader: false,
	removeRefererHeaderOnRedirect: false,
	strictHttpParser: false,
	encodeUrl: true,
	disableCookies: false,
	tlsPreferServerCiphers: false,
	maxRedirects: 10,
	tlsDisabledProtocols: [],
	tlsCipherSuites: [],
};

/** Whether a setting holds its default (and so is not stored). */
export function isHttpSettingDefault(settings: IHttpRequestSettings | undefined, key: HttpRequestSettingKey): boolean {
	const value = settings?.[key];
	if (value === undefined) {
		return true;
	}
	if (key === 'timeoutMs') {
		return !(typeof value === 'number' && value > 0);
	}
	const standard = HTTP_SETTINGS_DEFAULTS[key];
	return Array.isArray(value) ? value.length === 0 : value === standard;
}

/** The settings with every default dropped and every value of the right type; undefined when nothing is left. */
export function compactHttpSettings(settings: IHttpRequestSettings | undefined): IHttpRequestSettings | undefined {
	if (!settings) {
		return undefined;
	}
	const out: IHttpRequestSettings = {};
	if (settings.httpVersion === 'http1' || settings.httpVersion === 'http2') {
		out.httpVersion = settings.httpVersion;
	}
	for (const key of ['strictSSL', 'followRedirects', 'followOriginalHttpMethod', 'followAuthorizationHeader', 'removeRefererHeaderOnRedirect', 'strictHttpParser', 'encodeUrl', 'disableCookies', 'tlsPreferServerCiphers'] as const) {
		const value = settings[key];
		if (typeof value === 'boolean' && value !== HTTP_SETTINGS_DEFAULTS[key]) {
			out[key] = value;
		}
	}
	if (typeof settings.maxRedirects === 'number' && Number.isInteger(settings.maxRedirects) && settings.maxRedirects >= 0 && settings.maxRedirects !== HTTP_SETTINGS_DEFAULTS.maxRedirects) {
		out.maxRedirects = Math.min(settings.maxRedirects, 100);
	}
	const protocols = Array.isArray(settings.tlsDisabledProtocols) ? HTTP_TLS_PROTOCOLS.filter(protocol => settings.tlsDisabledProtocols?.includes(protocol)) : [];
	if (protocols.length) {
		out.tlsDisabledProtocols = protocols;
	}
	const ciphers = Array.isArray(settings.tlsCipherSuites) ? settings.tlsCipherSuites.filter(cipher => typeof cipher === 'string').map(cipher => cipher.trim()).filter(Boolean) : [];
	if (ciphers.length) {
		out.tlsCipherSuites = ciphers;
	}
	if (typeof settings.timeoutMs === 'number' && Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0) {
		out.timeoutMs = Math.round(settings.timeoutMs);
	}
	return Object.keys(out).length ? out : undefined;
}

/** Every setting with its value: the stored one, else the default (`timeoutMs` stays absent). */
export function httpSettingsWithDefaults(settings: IHttpRequestSettings | undefined): Required<Omit<IHttpRequestSettings, 'timeoutMs'>> & { readonly timeoutMs?: number } {
	return { ...HTTP_SETTINGS_DEFAULTS, ...compactHttpSettings(settings) };
}

/**
 * The URL with the characters that may not appear in a path or query percent-encoded. `%XX`
 * already written stays as it is, and so do the scheme, host and port; a name and password in the
 * URL are encoded too.
 */
export function encodeHttpUrl(url: string): string {
	const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
	if (!match) {
		return url;
	}
	const escape = (char: string) => {
		try {
			return encodeURIComponent(char);
		} catch {
			// Half of a surrogate pair has no encoding.
			return char;
		}
	};
	// As a browser encodes: spaces, quotes, angle brackets, control and non-ASCII characters; in the path braces and backticks too.
	const encode = (part: string, unsafe: RegExp) => part.replace(/%(?![0-9a-fA-F]{2})|[^%]/gu, char => char === '%' ? '%25' : unsafe.test(char) ? escape(char) : char);
	// The authentication fields (`user:password@`): each part with what may not stand in it, `@` and `:` included.
	let authority = match[1] ?? '';
	const at = authority.lastIndexOf('@');
	if (at >= 0) {
		const start = authority.indexOf('://') + 3;
		const userinfo = authority.slice(start, at);
		const colon = userinfo.indexOf(':');
		const field = (part: string) => encode(part, /[^A-Za-z0-9\-._~!$&'()*+,;=]/u);
		authority = `${authority.slice(0, start)}${colon < 0 ? field(userinfo) : `${field(userinfo.slice(0, colon))}:${field(userinfo.slice(colon + 1))}`}${authority.slice(at)}`;
	}
	return `${authority}${encode(match[2], /[^\x21-\x7E]|["<>`{}]/u)}${match[3] ? encode(match[3], /[^\x21-\x7E]|["<>]/u) : ''}${match[4] ?? ''}`;
}

export interface IHttpFolder {
	kind: 'folder';
	id: string;
	name: string;
	description: string;
	auth: IHttpAuth;
	scripts: IHttpScripts;
	items: IHttpItem[];
	extra?: unknown;
}

export type IHttpItem = IHttpRequest | IHttpFolder;

export type HttpCollectionFormat = 'postman' | 'http';

export interface IHttpCollection {
	format: HttpCollectionFormat;
	name: string;
	description: string;
	variables: IHttpKeyValue[];
	auth: IHttpAuth;
	scripts: IHttpScripts;
	items: IHttpItem[];
	extra?: unknown;
}

export type HttpEnvironmentFormat = 'postman' | 'http-client';

export interface IHttpEnvironment {
	format: HttpEnvironmentFormat;
	name: string;
	variables: IHttpKeyValue[];
	extra?: unknown;
}

export const HTTP_RAW_CONTENT_TYPES: Readonly<Record<HttpRawLanguage, string>> = {
	json: 'application/json',
	text: 'text/plain',
	xml: 'application/xml',
	html: 'text/html',
	javascript: 'application/javascript',
};

export function newHttpId(): string {
	return generateUuid();
}

export function emptyHttpAuth(type: HttpAuthType = 'inherit'): IHttpAuth {
	return { type, token: '', username: '', password: '', keyName: 'X-API-Key', keyValue: '', keyIn: 'header' };
}

export function emptyHttpBody(): IHttpBody {
	return { mode: 'none', raw: '', language: 'json', urlencoded: [], formdata: [], graphqlQuery: '', graphqlVariables: '', binaryPath: '' };
}

export function emptyHttpScripts(): IHttpScripts {
	return { preRequest: '', test: '' };
}

export function emptyHttpRequest(name = '', auth: HttpAuthType = 'inherit'): IHttpRequest {
	return { kind: 'request', id: newHttpId(), name, description: '', method: 'GET', url: '', params: [], pathVariables: [], headers: [], body: emptyHttpBody(), auth: emptyHttpAuth(auth), scripts: emptyHttpScripts() };
}

/** A new request of a kind, with what that kind starts from (its method, body form and headers). */
export function newHttpRequest(protocol: HttpProtocol, name = '', auth: HttpAuthType = 'inherit'): IHttpRequest {
	const request = emptyHttpRequest(name, auth);
	if (protocol === 'http') {
		return request;
	}
	request.protocol = protocol;
	request.method = httpProtocolMethod(protocol);
	switch (protocol) {
		case 'graphql':
			request.body.mode = 'graphql';
			request.body.graphqlQuery = 'query {\n  \n}';
			break;
		case 'soap':
			request.body.mode = 'raw';
			request.body.language = 'xml';
			request.body.raw = HTTP_SOAP_ENVELOPE;
			request.headers.push({ key: 'SOAPAction', value: '', enabled: true });
			break;
		case 'ai': {
			const provider = HTTP_AI_PROVIDERS[0];
			request.url = provider.url;
			syncParams(request);
			request.body.mode = 'raw';
			request.body.raw = httpAiBodyOf({ provider: provider.id, model: provider.model, system: '', prompt: '' });
			request.auth = { ...emptyHttpAuth('bearer'), token: `{{${provider.keyVariable}}}` };
			break;
		}
		case 'mcp':
			request.body.mode = 'raw';
			request.body.raw = httpMcpMessage('tools/list');
			break;
		case 'grpc':
			request.body.mode = 'raw';
			request.body.raw = '{}';
			break;
		case 'ws':
		case 'socketio':
		case 'mqtt':
			request.messages = [];
			break;
	}
	return request;
}

/** Turns a request into another kind, keeping what carries over: its name, URL, headers, auth and docs. */
export function convertHttpRequest(request: IHttpRequest, protocol: HttpProtocol): void {
	const before = request.protocol ?? 'http';
	if (before === protocol) {
		return;
	}
	const fresh = newHttpRequest(protocol, request.name, request.auth.type);
	if (protocol === 'http') {
		delete request.protocol;
		request.method = before === 'graphql' || before === 'soap' || before === 'ai' || before === 'mcp' ? 'POST' : 'GET';
		// A body that is plain HTTP anyway (GraphQL, an XML envelope, JSON) stays.
		if (before !== 'graphql' && before !== 'soap' && before !== 'ai' && before !== 'mcp') {
			request.body = fresh.body;
		}
	} else {
		request.protocol = protocol;
		request.method = fresh.method;
		request.body = fresh.body;
	}
	request.messages = fresh.messages;
	delete request.options;
	if (!fresh.messages) {
		delete request.messages;
	}
	if (protocol === 'ai' || before === 'ai' || !request.url.trim()) {
		request.url = fresh.url;
		syncParams(request);
	}
	if (protocol === 'ai' && (request.auth.type === 'none' || request.auth.type === 'inherit')) {
		request.auth = fresh.auth;
	}
	if (protocol === 'soap' && !request.headers.some(row => row.key.toLowerCase() === 'soapaction')) {
		request.headers.push({ key: 'SOAPAction', value: '', enabled: true });
	}
}

function syncParams(request: IHttpRequest): void {
	request.params = httpParamsFromUrl(request.url, request.params);
	request.pathVariables = httpPathVariablesFor(request.url, request.pathVariables);
}

export function emptyHttpFolder(name: string): IHttpFolder {
	return { kind: 'folder', id: newHttpId(), name, description: '', auth: emptyHttpAuth('inherit'), scripts: emptyHttpScripts(), items: [] };
}

export function emptyHttpCollection(name: string, format: HttpCollectionFormat): IHttpCollection {
	return { format, name, description: '', variables: [], auth: emptyHttpAuth('none'), scripts: emptyHttpScripts(), items: [] };
}

export function cloneHttp<T>(value: T): T {
	return structuredClone(value);
}

/** A copy with new ids all the way down (Duplicate, and a move between files). */
export function withNewHttpIds<T extends IHttpItem>(item: T): T {
	const copy = cloneHttp(item);
	const visit = (node: IHttpItem) => {
		node.id = newHttpId();
		if (node.kind === 'folder') {
			node.items.forEach(visit);
		}
	};
	visit(copy);
	return copy;
}

export interface IHttpItemLocation {
	readonly item: IHttpItem;
	/** The list the item is in: its folder's, or the collection's. */
	readonly siblings: IHttpItem[];
	readonly index: number;
	/** The folders above it, outermost first. */
	readonly ancestors: readonly IHttpFolder[];
}

export function findHttpItem(collection: IHttpCollection, id: string): IHttpItemLocation | undefined {
	const search = (items: IHttpItem[], ancestors: readonly IHttpFolder[]): IHttpItemLocation | undefined => {
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (item.id === id) {
				return { item, siblings: items, index, ancestors };
			}
			if (item.kind === 'folder') {
				const found = search(item.items, [...ancestors, item]);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	};
	return search(collection.items, []);
}

/** Every request, depth first, with the folders above it. */
export function httpRequestsOf(items: readonly IHttpItem[], ancestors: readonly IHttpFolder[] = []): { readonly request: IHttpRequest; readonly ancestors: readonly IHttpFolder[] }[] {
	const out: { request: IHttpRequest; ancestors: readonly IHttpFolder[] }[] = [];
	for (const item of items) {
		if (item.kind === 'request') {
			out.push({ request: item, ancestors });
		} else {
			out.push(...httpRequestsOf(item.items, [...ancestors, item]));
		}
	}
	return out;
}

/** The names from the collection down to the item: what a saved tab and an agent name it by. */
export function httpItemPath(collection: IHttpCollection, id: string): string[] | undefined {
	const found = findHttpItem(collection, id);
	return found ? [...found.ancestors.map(folder => folder.name), found.item.name] : undefined;
}

/** The item at a name path (`Users/Create user`); the first of several with the same names. */
export function findHttpItemByPath(collection: IHttpCollection, path: readonly string[]): IHttpItem | undefined {
	let items: readonly IHttpItem[] = collection.items;
	let found: IHttpItem | undefined;
	for (const [at, name] of path.entries()) {
		found = items.find(item => item.name === name && (at === path.length - 1 || item.kind === 'folder')) ?? items.find(item => item.name === name);
		if (!found) {
			return undefined;
		}
		items = found.kind === 'folder' ? found.items : [];
	}
	return found;
}

/**
 * Gives a freshly parsed collection the ids its earlier load had, matched by name path (and the
 * position among same-named siblings), so open tabs keep pointing at their request after the file
 * changes on disk.
 */
export function keepHttpIds(next: IHttpCollection, previous: IHttpCollection | undefined): void {
	if (!previous) {
		return;
	}
	const match = (items: IHttpItem[], before: readonly IHttpItem[]) => {
		const used = new Set<IHttpItem>();
		for (const item of items) {
			const old = before.find(candidate => !used.has(candidate) && candidate.kind === item.kind && candidate.name === item.name);
			if (old) {
				used.add(old);
				item.id = old.id;
				if (item.kind === 'folder' && old.kind === 'folder') {
					match(item.items, old.items);
				}
			}
		}
	};
	match(next.items, previous.items);
}

// --- URL and query params -------------------------------------------------------------------

/** Splits `url` into what is before `?`, the query and the `#fragment` (with its `#`). */
function splitUrl(url: string): { base: string; query: string | undefined; hash: string } {
	const hashAt = url.indexOf('#');
	const hash = hashAt < 0 ? '' : url.slice(hashAt);
	const rest = hashAt < 0 ? url : url.slice(0, hashAt);
	const queryAt = rest.indexOf('?');
	return queryAt < 0 ? { base: rest, query: undefined, hash } : { base: rest.slice(0, queryAt), query: rest.slice(queryAt + 1), hash };
}

/** The URL's query as rows, exactly as written (no decoding: the table shows what goes out). */
export function httpQueryOf(url: string): { key: string; value: string }[] {
	const { query } = splitUrl(url);
	if (!query) {
		return [];
	}
	return query.split('&').filter(pair => pair !== '').map(pair => {
		const at = pair.indexOf('=');
		return at < 0 ? { key: pair, value: '' } : { key: pair.slice(0, at), value: pair.slice(at + 1) };
	});
}

/** `url` with its query replaced by the checked rows. */
export function httpUrlWithQuery(url: string, params: readonly IHttpKeyValue[]): string {
	const { base, hash } = splitUrl(url);
	const query = params.filter(row => row.enabled && (row.key || row.value)).map(row => row.value !== '' ? `${row.key}=${row.value}` : row.key).join('&');
	return `${base}${query ? `?${query}` : ''}${hash}`;
}

/**
 * The params table after the URL was typed in: the URL's query becomes the checked rows (a row
 * that was already there keeps its description), the unchecked rows stay where they were.
 */
export function httpParamsFromUrl(url: string, params: readonly IHttpKeyValue[]): IHttpKeyValue[] {
	const typed = httpQueryOf(url);
	const before = params.filter(row => row.enabled);
	const out: IHttpKeyValue[] = [];
	let next = 0;
	for (const row of params) {
		if (!row.enabled) {
			out.push({ ...row });
			continue;
		}
		const pair = typed[next];
		if (pair) {
			out.push({ ...row, key: pair.key, value: pair.value });
			next++;
		}
	}
	for (; next < typed.length; next++) {
		const pair = typed[next];
		const known = before.find(row => row.key === pair.key && row.description);
		out.push({ key: pair.key, value: pair.value, enabled: true, ...(known?.description ? { description: known.description } : {}) });
	}
	return out;
}

/** The `:name` path segments of a URL, in order, once each. */
export function httpPathVariableNames(url: string): string[] {
	const { base } = splitUrl(url);
	const path = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
	return [...new Set([...path.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map(match => match[1]))];
}

/** The path variables table for a URL: a row per `:name`, keeping the values already given. */
export function httpPathVariablesFor(url: string, current: readonly IHttpKeyValue[]): IHttpKeyValue[] {
	return httpPathVariableNames(url).map(name => {
		const known = current.find(row => row.key === name);
		return known ? { ...known } : { key: name, value: '', enabled: true };
	});
}

// --- What goes out ----------------------------------------------------------------------------

/** The auth a request sends: its own, or the nearest folder's (then the collection's) that is not `inherit`. */
export function effectiveHttpAuth(request: IHttpRequest, ancestors: readonly IHttpFolder[], collection: IHttpCollection | undefined): { readonly auth: IHttpAuth; readonly from?: string } {
	if (request.auth.type !== 'inherit') {
		return { auth: request.auth };
	}
	for (let index = ancestors.length - 1; index >= 0; index--) {
		if (ancestors[index].auth.type !== 'inherit') {
			return { auth: ancestors[index].auth, from: ancestors[index].name };
		}
	}
	if (collection && collection.auth.type !== 'inherit') {
		return { auth: collection.auth, from: collection.name };
	}
	return { auth: emptyHttpAuth('none') };
}

export interface IHttpWireRequest {
	readonly spec: IHttpRequestSpec;
	/** A multipart body's parts: the sender reads the files and writes the body. */
	readonly formdata?: readonly IHttpKeyValue[];
	/** A binary body's file. */
	readonly binaryPath?: string;
}

/** The headers Volt adds on its own (auth, content type), for the Headers tab's "auto" rows. */
export function httpAutoHeaders(request: IHttpRequest, auth: IHttpAuth): [string, string][] {
	return autoHeaders(request, auth, true);
}

/** `computed`: with the row that stands for a header `signHttpRequest` writes (never part of what is sent). */
function autoHeaders(request: IHttpRequest, auth: IHttpAuth, computed: boolean): [string, string][] {
	const own = new Set(request.headers.filter(row => row.enabled && row.key.trim()).map(row => row.key.trim().toLowerCase()));
	const out: [string, string][] = [];
	if (!own.has('authorization')) {
		if (auth.type === 'bearer' && auth.token) {
			out.push(['Authorization', `Bearer ${auth.token}`]);
		} else if (auth.type === 'oauth2' && auth.token && httpAuthParam(auth, 'addTokenTo') !== 'queryParams') {
			out.push(['Authorization', `${httpAuthParam(auth, 'headerPrefix').trim()} ${auth.token}`.trim()]);
		} else if (auth.type === 'basic') {
			out.push(['Authorization', `Basic ${auth.username}:${auth.password}`]);
		} else if (computed && httpAuthSignsHeader(auth)) {
			out.push(['Authorization', HTTP_AUTH_COMPUTED]);
		}
	}
	if (auth.type === 'apikey' && auth.keyIn === 'header' && auth.keyName.trim() && !own.has(auth.keyName.trim().toLowerCase())) {
		out.push([auth.keyName.trim(), auth.keyValue]);
	}
	const protocol = request.protocol ?? 'http';
	if (protocol === 'ws' || protocol === 'sse' || protocol === 'socketio' || protocol === 'mqtt' || protocol === 'grpc') {
		// A connection has no body to describe.
		return out;
	}
	if (protocol === 'mcp' && !own.has('accept')) {
		out.push(['Accept', 'application/json, text/event-stream']);
	}
	if (protocol === 'ai' && httpAiProviderOf(request.url, request.body.raw) === 'anthropic' && !own.has('anthropic-version')) {
		out.push(['anthropic-version', '2023-06-01']);
	}
	if (!own.has('content-type')) {
		const body = request.body;
		switch (body.mode) {
			case 'raw': out.push(['Content-Type', protocol === 'soap' ? 'text/xml; charset=utf-8' : protocol === 'mcp' || protocol === 'ai' ? 'application/json' : HTTP_RAW_CONTENT_TYPES[body.language]]); break;
			case 'urlencoded': out.push(['Content-Type', 'application/x-www-form-urlencoded']); break;
			case 'graphql': out.push(['Content-Type', 'application/json']); break;
			case 'binary': out.push(['Content-Type', 'application/octet-stream']); break;
			// multipart's content type carries the boundary: the sender sets it.
		}
	}
	return out;
}

/**
 * The request as it is sent: path variables filled in, the auth's header or query param added, the
 * body encoded and its content type set. `{{variables}}` are left for the sender to fill in.
 */
export function httpWireRequest(request: IHttpRequest, ancestors: readonly IHttpFolder[] = [], collection?: IHttpCollection): IHttpWireRequest {
	const { auth } = effectiveHttpAuth(request, ancestors, collection);
	let url = request.url.trim();
	for (const row of request.pathVariables) {
		if (row.key) {
			url = url.replace(new RegExp(`/:${row.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/?#]|$)`, 'g'), `/${row.value}`);
		}
	}
	if (auth.type === 'apikey' && auth.keyIn === 'query' && auth.keyName.trim()) {
		const { base, query, hash } = splitUrl(url);
		url = `${base}?${query ? `${query}&` : ''}${auth.keyName.trim()}=${auth.keyValue}${hash}`;
	}
	if (auth.type === 'oauth2' && auth.token && httpAuthParam(auth, 'addTokenTo') === 'queryParams') {
		const { base, query, hash } = splitUrl(url);
		url = `${base}?${query ? `${query}&` : ''}access_token=${auth.token}${hash}`;
	}
	const headers: [string, string][] = [
		...request.headers.filter(row => row.enabled && row.key.trim()).map(row => [row.key.trim(), row.value] as [string, string]),
		// The signed types' Authorization is `signHttpRequest`'s to add, once the variables are filled in.
		...autoHeaders(request, auth, false),
	];
	const body = request.body;
	let text: string | undefined;
	let formdata: IHttpKeyValue[] | undefined;
	let binaryPath: string | undefined;
	switch (body.mode) {
		case 'raw': text = body.raw; break;
		case 'urlencoded':
			text = body.urlencoded.filter(row => row.enabled && row.key).map(row => `${encodeFormPart(row.key)}=${encodeFormPart(row.value)}`).join('&');
			break;
		case 'graphql': {
			let variables: unknown;
			try {
				variables = body.graphqlVariables.trim() ? JSON.parse(body.graphqlVariables) : undefined;
			} catch {
				variables = undefined;
			}
			const operationName = graphqlOperationName(body.graphqlQuery);
			text = JSON.stringify({ query: body.graphqlQuery, ...(variables !== undefined ? { variables } : {}), ...(operationName ? { operationName } : {}) });
			break;
		}
		case 'formdata': formdata = body.formdata.filter(row => row.enabled && row.key); break;
		case 'binary': binaryPath = body.binaryPath || undefined; break;
	}
	return {
		spec: { ...(request.name ? { name: request.name } : {}), method: request.method, ...(request.protocol && request.protocol !== 'http' ? { protocol: request.protocol } : {}), url, headers, ...(text !== undefined && text !== '' ? { body: text } : {}), line: request.line ?? 0 },
		...(formdata ? { formdata } : {}),
		...(binaryPath ? { binaryPath } : {}),
	};
}

/** Form encoding that leaves `{{variables}}` readable for the sender to fill in. */
function encodeFormPart(value: string): string {
	return value.split(/(\{\{[^}]*\}\})/).map(part => part.startsWith('{{') ? part : encodeURIComponent(part).replace(/%20/g, '+')).join('');
}

function decodeFormPart(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, ' '));
	} catch {
		return value;
	}
}

/**
 * A plain request (an `.http` block, a history entry, an agent's ad hoc send) as a request to
 * edit: the body's kind and the auth are read back from its headers.
 */
export function httpRequestFromSpec(spec: IHttpRequestSpec): IHttpRequest {
	const request = emptyHttpRequest(spec.name ?? '', 'none');
	request.method = spec.method;
	request.url = spec.url;
	request.params = httpParamsFromUrl(spec.url, []);
	request.pathVariables = httpPathVariablesFor(spec.url, []);
	if (spec.line) {
		request.line = spec.line;
	}
	const type = spec.headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
	const protocol = isHttpProtocol(spec.protocol) && spec.protocol !== 'http' ? spec.protocol : undefined;
	const graphql = protocol === 'graphql' || /graphql/i.test(type) || spec.headers.some(([key, value]) => key.toLowerCase() === 'x-request-type' && /graphql/i.test(value));
	if (protocol) {
		request.protocol = protocol;
	}
	const messaging = protocol === 'ws' || protocol === 'socketio' || protocol === 'mqtt';
	if (messaging) {
		request.messages = spec.body ? httpMessagesFromBody(spec.body) : [];
	}
	for (const [key, value] of spec.headers) {
		const lower = key.toLowerCase();
		if (lower === 'authorization' && /^bearer\s+/i.test(value)) {
			request.auth = { ...emptyHttpAuth('bearer'), token: value.replace(/^bearer\s+/i, '') };
		} else if (lower === 'authorization' && /^basic\s+\S+[:\s]/i.test(value)) {
			const rest = value.replace(/^basic\s+/i, '');
			const at = rest.search(/[:\s]/);
			request.auth = { ...emptyHttpAuth('basic'), username: rest.slice(0, at), password: rest.slice(at + 1) };
		} else if (lower === 'x-request-type' && graphql) {
			continue;
		} else if (lower === 'content-type' && spec.body && (graphql || protocol === 'mcp' || protocol === 'ai' || protocol === 'soap' || /^(application\/(json|xml|x-www-form-urlencoded|javascript)|text\/(plain|html))\s*$/i.test(value))) {
			// The body's kind says it again on send.
			continue;
		} else {
			request.headers.push({ key, value, enabled: true });
		}
	}
	if (spec.body && !messaging) {
		const body = request.body;
		if (graphql) {
			body.mode = 'graphql';
			const [query, variables] = spec.body.split(/\n\s*\n(?=\s*\{)/);
			body.graphqlQuery = query;
			body.graphqlVariables = variables ?? '';
		} else if (/x-www-form-urlencoded/i.test(type)) {
			body.mode = 'urlencoded';
			body.urlencoded = spec.body.split('&').filter(Boolean).map(pair => {
				const at = pair.indexOf('=');
				return { key: decodeFormPart(at < 0 ? pair : pair.slice(0, at)), value: at < 0 ? '' : decodeFormPart(pair.slice(at + 1)), enabled: true };
			});
		} else {
			body.mode = 'raw';
			body.raw = spec.body;
			body.language = protocol === 'soap' ? 'xml' : /json/i.test(type) || (!type && /^\s*[[{]/.test(spec.body)) ? 'json' : /xml/i.test(type) ? 'xml' : /html/i.test(type) ? 'html' : /javascript/i.test(type) ? 'javascript' : 'text';
		}
	}
	return request;
}

/** What a tab or a tree row calls a request without a name: `GET /users`. */
export function httpRequestLabel(request: { readonly name: string; readonly method: string; readonly url: string }): string {
	if (request.name.trim()) {
		return request.name.trim();
	}
	if (!request.url.trim()) {
		return 'New Request';
	}
	return request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/^\{\{[^}]+\}\}/, '').split('?')[0] || request.url;
}

/** The variables a request sees from its collection: enabled rows, later rows winning. */
export function httpVariableRecord(rows: readonly IHttpKeyValue[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows) {
		if (row.enabled && row.key) {
			out[row.key] = row.value;
		}
	}
	return out;
}

/** A file name for a collection or environment: its name without what a path cannot hold. */
export function httpFileNameFor(name: string): string {
	return name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'collection';
}
