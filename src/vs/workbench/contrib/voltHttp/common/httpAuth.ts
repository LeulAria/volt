/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HTTP_AUTH_DEFAULTS, IHttpAuth } from './httpCollection.js';
import { httpBase64, httpBase64Url, httpFromBase64, httpHex, HttpHashName, httpHmac, HttpKeyScheme, httpMd5, httpRandomHex, httpSha, httpSha512_256, httpSignWithKey, httpUtf8 } from './httpCrypto.js';

/** A request as it is about to go out: every `{{variable}}` already filled in. */
export interface IHttpSignable {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
}

export interface IHttpSignedRequest {
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
}

export interface IHttpSigned extends IHttpSignedRequest {
	/** NTLM: the name and password the network stack answers the server's challenge with. */
	readonly credentials?: { readonly username: string; readonly password: string; readonly domain?: string };
	/**
	 * Digest: called when the answer is a 401 that carries a challenge. Returns the request to send
	 * instead (once), or undefined to keep the 401.
	 */
	readonly challenge?: (status: number, headers: Readonly<Record<string, string>>) => Promise<IHttpSignedRequest | undefined>;
}

/** The clock and the random values a signature uses; given by tests so a signature can be compared. */
export interface IHttpSignEnvironment {
	/** Milliseconds since the epoch. */
	readonly now?: () => number;
	readonly nonce?: () => string;
}

interface ISignContext {
	readonly request: IHttpSignable;
	/** The field with its `{{variables}}` filled in, or its default. */
	readonly param: (key: string) => string;
	readonly flag: (key: string) => boolean;
	readonly now: () => number;
	readonly nonce: () => string;
}

/**
 * Adds what an authorization type computes from the request itself (a signature, a signed token,
 * a nonce) to a request about to go out. `resolve` fills the `{{variables}}` of the auth's own
 * fields. Bearer, Basic, API key and OAuth 2.0 are not handled here: `httpWireRequest` writes
 * those. A request that carries its own Authorization header keeps it. Throws when a field
 * cannot be used (a payload that is not JSON, a key that is not a key): the message is for the user.
 */
export async function signHttpRequest(auth: IHttpAuth, request: IHttpSignable, resolve: (text: string) => string, environment?: IHttpSignEnvironment): Promise<IHttpSigned> {
	const plain: IHttpSigned = { url: request.url, headers: request.headers };
	const context: ISignContext = {
		request,
		param: key => resolve(auth.params?.[key] ?? HTTP_AUTH_DEFAULTS[auth.type]?.[key] ?? ''),
		flag: key => resolve(auth.params?.[key] ?? HTTP_AUTH_DEFAULTS[auth.type]?.[key] ?? '').trim() === 'true',
		now: environment?.now ?? (() => Date.now()),
		nonce: environment?.nonce ?? (() => httpRandomHex(16)),
	};
	if (auth.type === 'ntlm') {
		let username = context.param('username');
		let domain = context.param('domain');
		const slash = username.indexOf('\\');
		if (!domain && slash > 0) {
			domain = username.slice(0, slash);
			username = username.slice(slash + 1);
		}
		return username ? { ...plain, credentials: { username, password: context.param('password'), ...(domain ? { domain } : {}) } } : plain;
	}
	if (headerOf(request.headers, 'authorization') !== undefined) {
		return plain;
	}
	switch (auth.type) {
		case 'jwt': return signJwtAuth(context);
		case 'digest': return signDigest(context);
		case 'oauth1': return signOAuth1(context);
		case 'hawk': return signHawk(context);
		case 'awsv4': return signAws(context);
		case 'edgegrid': return signEdgeGrid(context);
		case 'asap': return signAsap(context);
		default: return plain;
	}
}

// --- Shared ----------------------------------------------------------------------------------

function headerOf(headers: readonly (readonly [string, string])[], name: string): string | undefined {
	return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

/** The headers with `name` set: in place of the one of that name, or at the end. */
function withHeader(headers: readonly (readonly [string, string])[], name: string, value: string): (readonly [string, string])[] {
	const lower = name.toLowerCase();
	const out = headers.filter(([key]) => key.toLowerCase() !== lower);
	out.push([name, value]);
	return out;
}

function parseUrl(url: string): URL {
	try {
		return new URL(url);
	} catch {
		try {
			return new URL(`http://${url}`);
		} catch {
			throw new Error(`The URL "${url}" cannot be signed: it is not a full URL.`);
		}
	}
}

/** Percent-encoding as the signature specs want it: everything but letters, digits and `-._~`. */
function strictEncode(text: string): string {
	return encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodePart(text: string): string {
	const spaced = text.replace(/\+/g, ' ');
	try {
		return decodeURIComponent(spaced);
	} catch {
		return spaced;
	}
}

/** `a=1&b=2` as decoded pairs, in order. */
function pairsOf(query: string): [string, string][] {
	return query.split('&').filter(pair => pair !== '').map(pair => {
		const at = pair.indexOf('=');
		return at < 0 ? [decodePart(pair), ''] : [decodePart(pair.slice(0, at)), decodePart(pair.slice(at + 1))];
	});
}

/** `url` with more query params, encoded, in front of its `#fragment`. */
function withQuery(url: string, pairs: readonly (readonly [string, string])[]): string {
	if (!pairs.length) {
		return url;
	}
	const hashAt = url.indexOf('#');
	const hash = hashAt < 0 ? '' : url.slice(hashAt);
	const rest = hashAt < 0 ? url : url.slice(0, hashAt);
	const added = pairs.map(([key, value]) => `${strictEncode(key)}=${strictEncode(value)}`).join('&');
	return `${rest}${rest.includes('?') ? (rest.endsWith('?') || rest.endsWith('&') ? '' : '&') : '?'}${added}${hash}`;
}

function isForm(request: IHttpSignable): boolean {
	return /^application\/x-www-form-urlencoded\b/i.test((headerOf(request.headers, 'content-type') ?? '').trim());
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

// --- JWT -------------------------------------------------------------------------------------

const JWT_ALGORITHMS: Readonly<Record<string, { readonly scheme: 'HMAC' | HttpKeyScheme; readonly hash: HttpHashName; readonly curve?: string }>> = {
	HS256: { scheme: 'HMAC', hash: 'SHA-256' },
	HS384: { scheme: 'HMAC', hash: 'SHA-384' },
	HS512: { scheme: 'HMAC', hash: 'SHA-512' },
	RS256: { scheme: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
	RS384: { scheme: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
	RS512: { scheme: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
	PS256: { scheme: 'RSA-PSS', hash: 'SHA-256' },
	PS384: { scheme: 'RSA-PSS', hash: 'SHA-384' },
	PS512: { scheme: 'RSA-PSS', hash: 'SHA-512' },
	ES256: { scheme: 'ECDSA', hash: 'SHA-256', curve: 'P-256' },
	ES384: { scheme: 'ECDSA', hash: 'SHA-384', curve: 'P-384' },
	ES512: { scheme: 'ECDSA', hash: 'SHA-512', curve: 'P-521' },
};

export const HTTP_JWT_ALGORITHMS: readonly string[] = Object.keys(JWT_ALGORITHMS);

/** Whether the algorithm signs with a shared secret (HS*) and not a private key. */
export function httpJwtUsesSecret(algorithm: string): boolean {
	return (JWT_ALGORITHMS[algorithm.trim().toUpperCase()] ?? JWT_ALGORITHMS.HS256).scheme === 'HMAC';
}

function parseObject(text: string, what: string): Record<string, unknown> {
	if (!text.trim()) {
		return {};
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw new Error(`${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${what} must be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

/** A compact JWS: `header.payload.signature`. `key` is the secret's bytes (HS*) or a PEM private key. */
export async function httpSignJwt(algorithm: string, header: Readonly<Record<string, unknown>>, payload: Readonly<Record<string, unknown>>, key: Uint8Array | string): Promise<string> {
	const name = algorithm.trim().toUpperCase();
	const spec = JWT_ALGORITHMS[name];
	if (!spec) {
		throw new Error(`"${algorithm}" is not a JWT algorithm Volt signs with (${HTTP_JWT_ALGORITHMS.join(', ')}).`);
	}
	const input = `${httpBase64Url(httpUtf8(JSON.stringify({ alg: name, typ: 'JWT', ...header })))}.${httpBase64Url(httpUtf8(JSON.stringify(payload)))}`;
	const data = httpUtf8(input);
	const signature = spec.scheme === 'HMAC'
		? await httpHmac(spec.hash, typeof key === 'string' ? httpUtf8(key) : key, data)
		: await httpSignWithKey(spec.scheme, spec.hash, typeof key === 'string' ? key : new TextDecoder().decode(key), data, spec.curve);
	return `${input}.${httpBase64Url(signature)}`;
}

async function signJwtAuth(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const algorithm = param('algorithm');
	const secret = param('secret');
	const key = httpJwtUsesSecret(algorithm) ? (context.flag('isSecretBase64Encoded') ? httpFromBase64(secret.replace(/-/g, '+').replace(/_/g, '/')) : httpUtf8(secret)) : param('privateKey');
	// What the payload says is what is signed: no claim is added for the user.
	const token = await httpSignJwt(algorithm, parseObject(param('header'), 'The JWT header'), parseObject(param('payload'), 'The JWT payload'), key);
	if (param('addTokenTo') === 'queryParam') {
		return { url: withQuery(request.url, [[param('queryParamKey') || 'token', token]]), headers: request.headers };
	}
	return { url: request.url, headers: withHeader(request.headers, 'Authorization', `${param('headerPrefix').trim()} ${token}`.trim()) };
}

// --- ASAP (Atlassian) ------------------------------------------------------------------------

/** "Expires in" as seconds: a number of seconds, or `30s`, `10m`, `1h`, `2d`. */
function lifetimeSeconds(text: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(text);
	if (!match) {
		return 3600;
	}
	const unit = (match[2] ?? 's').toLowerCase();
	return Math.round(Number(match[1]) * (unit === 'ms' ? 0.001 : unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1));
}

async function signAsap(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const issuedAt = Math.floor(context.now() / 1000);
	const life = lifetimeSeconds(param('exp'));
	const issuer = param('iss');
	const payload: Record<string, unknown> = {
		iss: issuer,
		sub: param('sub') || issuer,
		aud: param('aud'),
		iat: issuedAt,
		// A number as large as a date is the moment itself, not how long from now.
		exp: life > 1000000000 ? life : issuedAt + life,
		jti: context.nonce(),
		...parseObject(param('claims'), 'The additional claims'),
	};
	const token = await httpSignJwt(param('alg') || 'RS256', { kid: param('kid') }, payload, param('privateKey'));
	return { url: request.url, headers: withHeader(request.headers, 'Authorization', `Bearer ${token}`) };
}

// --- Digest (RFC 2617, RFC 7616) -------------------------------------------------------------

/** The challenges of a `WWW-Authenticate` value (several may be joined by commas), each with its scheme in lower case. */
export function parseHttpChallenges(header: string): { readonly scheme: string; readonly params: Readonly<Record<string, string>> }[] {
	// Split on the commas that are not inside a quoted value.
	const items: string[] = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < header.length; index++) {
		const char = header[index];
		if (quoted && char === '\\' && index + 1 < header.length) {
			current += char + header[++index];
		} else if (char === '"') {
			quoted = !quoted;
			current += char;
		} else if (!quoted && (char === ',' || char === '\n')) {
			items.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	items.push(current);
	const out: { scheme: string; params: Record<string, string> }[] = [];
	const add = (text: string) => {
		const at = text.indexOf('=');
		const last = out[out.length - 1];
		if (at < 0 || !last) {
			return;
		}
		let value = text.slice(at + 1).trim();
		if (value.startsWith('"')) {
			value = value.slice(1, value.endsWith('"') && value.length > 1 ? -1 : undefined).replace(/\\(.)/g, '$1');
		}
		last.params[text.slice(0, at).trim().toLowerCase()] = value;
	};
	for (const raw of items) {
		const item = raw.trim();
		if (!item) {
			continue;
		}
		const start = /^([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+(.*))?$/.exec(item);
		if (start && !/^[A-Za-z0-9_-]+\s*=/.test(item)) {
			out.push({ scheme: start[1].toLowerCase(), params: {} });
			if (start[2] && /^[A-Za-z0-9_-]+\s*=(?!=*$)/.test(start[2])) {
				add(start[2]);
			}
		} else {
			add(item);
		}
	}
	return out;
}

function digestHash(algorithm: string): ((text: string) => Promise<string>) | undefined {
	switch (algorithm.replace(/-sess$/i, '').toUpperCase()) {
		case '': case 'MD5': return async text => httpHex(httpMd5(httpUtf8(text)));
		case 'SHA-256': return async text => httpHex(await httpSha('SHA-256', httpUtf8(text)));
		case 'SHA-512-256': return async text => httpHex(httpSha512_256(httpUtf8(text)));
		default: return undefined;
	}
}

interface IDigestChallenge {
	readonly realm: string;
	readonly nonce: string;
	readonly algorithm: string;
	/** What the server offers: `auth`, `auth-int`, both, or nothing. */
	readonly qop: string;
	readonly opaque: string;
}

async function digestAuthorization(context: ISignContext, challenge: IDigestChallenge): Promise<string> {
	const { request, param } = context;
	const hash = digestHash(challenge.algorithm);
	if (!hash) {
		throw new Error(`Digest algorithm "${challenge.algorithm}" is not supported (MD5, SHA-256, SHA-512-256 and their -sess forms are).`);
	}
	const url = parseUrl(request.url);
	const uri = `${url.pathname}${url.search}`;
	const username = param('username');
	const offered = challenge.qop.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
	const wanted = param('qop').trim().toLowerCase();
	const qop = offered.includes(wanted) ? wanted : offered.includes('auth') ? 'auth' : offered.includes('auth-int') ? 'auth-int' : '';
	const session = /-sess$/i.test(challenge.algorithm);
	const cnonce = qop || session ? param('clientNonce') || context.nonce() : '';
	const count = (param('nonceCount') || '1').padStart(8, '0');
	let ha1 = await hash(`${username}:${challenge.realm}:${param('password')}`);
	if (session) {
		ha1 = await hash(`${ha1}:${challenge.nonce}:${cnonce}`);
	}
	const ha2 = await hash(qop === 'auth-int' ? `${request.method.toUpperCase()}:${uri}:${await hash(request.body ?? '')}` : `${request.method.toUpperCase()}:${uri}`);
	const response = await hash(qop ? `${ha1}:${challenge.nonce}:${count}:${cnonce}:${qop}:${ha2}` : `${ha1}:${challenge.nonce}:${ha2}`);
	const quote = (text: string) => `"${text.replace(/(["\\])/g, '\\$1')}"`;
	const parts = [`username=${quote(username)}`, `realm=${quote(challenge.realm)}`, `nonce=${quote(challenge.nonce)}`, `uri=${quote(uri)}`];
	if (challenge.algorithm) {
		parts.push(`algorithm=${challenge.algorithm}`);
	}
	if (qop) {
		parts.push(`qop=${qop}`, `nc=${count}`);
	}
	if (cnonce) {
		parts.push(`cnonce=${quote(cnonce)}`);
	}
	parts.push(`response=${quote(response)}`);
	if (challenge.opaque) {
		parts.push(`opaque=${quote(challenge.opaque)}`);
	}
	return `Digest ${parts.join(', ')}`;
}

async function signDigest(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const realm = param('realm');
	const nonce = param('nonce');
	// With the realm and the nonce already known, the answer goes out with the first request.
	const headers = realm && nonce
		? withHeader(request.headers, 'Authorization', await digestAuthorization(context, { realm, nonce, algorithm: param('algorithm').trim(), qop: param('qop'), opaque: param('opaque') }))
		: request.headers;
	if (context.flag('disableRetryRequest')) {
		return { url: request.url, headers };
	}
	return {
		url: request.url,
		headers,
		challenge: async (status, responseHeaders) => {
			if (status !== 401) {
				return undefined;
			}
			const value = Object.entries(responseHeaders).filter(([key]) => key.toLowerCase() === 'www-authenticate').map(([, text]) => text).join(', ');
			// The server lists what it prefers first: the first one that can be answered is.
			const offered = parseHttpChallenges(value).filter(challenge => challenge.scheme === 'digest' && challenge.params.nonce !== undefined).find(challenge => !!digestHash(challenge.params.algorithm ?? ''));
			if (!offered) {
				return undefined;
			}
			const authorization = await digestAuthorization(context, { realm: offered.params.realm ?? '', nonce: offered.params.nonce, algorithm: offered.params.algorithm ?? '', qop: offered.params.qop ?? '', opaque: offered.params.opaque ?? '' });
			return { url: request.url, headers: withHeader(request.headers, 'Authorization', authorization) };
		},
	};
}

// --- OAuth 1.0 (RFC 5849) --------------------------------------------------------------------

/** The signature base string: the method, the URL without its query, and every parameter, encoded and sorted. */
export function httpOAuth1BaseString(method: string, url: string, params: readonly (readonly [string, string])[]): string {
	const parsed = parseUrl(url);
	const encoded = params.map(([key, value]) => [strictEncode(key), strictEncode(value)] as const);
	encoded.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
	return `${method.toUpperCase()}&${strictEncode(`${parsed.protocol}//${parsed.host}${parsed.pathname}`)}&${strictEncode(encoded.map(([key, value]) => `${key}=${value}`).join('&'))}`;
}

async function signOAuth1(context: ISignContext): Promise<IHttpSigned> {
	const { request, param, flag } = context;
	const method = param('signatureMethod').trim().toUpperCase() || 'HMAC-SHA1';
	const hash: HttpHashName = method.endsWith('SHA256') ? 'SHA-256' : method.endsWith('SHA512') ? 'SHA-512' : 'SHA-1';
	const form = isForm(request);
	const oauth: [string, string][] = [
		['oauth_consumer_key', param('consumerKey')],
		['oauth_token', param('token')],
		['oauth_signature_method', method],
		['oauth_timestamp', param('timestamp') || String(Math.floor(context.now() / 1000))],
		['oauth_nonce', param('nonce') || context.nonce()],
		['oauth_version', param('version')],
		['oauth_callback', param('callback')],
		['oauth_verifier', param('verifier')],
	];
	if (flag('includeBodyHash') && !form) {
		oauth.push(['oauth_body_hash', httpBase64(await httpSha(hash, httpUtf8(request.body ?? '')))]);
	}
	const sent = oauth.filter(([, value]) => value !== '' || flag('addEmptyParamsToSign'));
	const url = parseUrl(request.url);
	const base = httpOAuth1BaseString(request.method, request.url, [...pairsOf(url.search.replace(/^\?/, '')), ...(form ? pairsOf(request.body ?? '') : []), ...sent]);
	const secret = `${strictEncode(param('consumerSecret'))}&${strictEncode(param('tokenSecret'))}`;
	const signature = method === 'PLAINTEXT'
		? secret
		: method.startsWith('RSA-')
			? httpBase64(await httpSignWithKey('RSASSA-PKCS1-v1_5', hash, param('privateKey'), httpUtf8(base)))
			: httpBase64(await httpHmac(hash, httpUtf8(secret), httpUtf8(base)));
	sent.push(['oauth_signature', signature]);
	if (!flag('addParamsToHeader')) {
		// Without the header they ride in the URL (a form body is not rewritten here).
		return { url: withQuery(request.url, sent), headers: request.headers };
	}
	const realm = param('realm');
	const encode = flag('disableHeaderEncoding') ? (text: string) => text : strictEncode;
	const parts = [...(realm ? [`realm="${realm}"`] : []), ...sent.map(([key, value]) => `${key}="${encode(value)}"`)];
	return { url: request.url, headers: withHeader(request.headers, 'Authorization', `OAuth ${parts.join(',')}`) };
}

// --- Hawk ------------------------------------------------------------------------------------

async function signHawk(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const hash: HttpHashName = param('algorithm').trim().toLowerCase() === 'sha1' ? 'SHA-1' : 'SHA-256';
	const url = parseUrl(request.url);
	const timestamp = param('timestamp') || String(Math.floor(context.now() / 1000));
	const nonce = param('nonce') || context.nonce().slice(0, 6);
	const ext = param('extraData');
	const app = param('app');
	const dlg = param('delegation');
	let payloadHash = '';
	if (context.flag('includePayloadHash')) {
		const contentType = (headerOf(request.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
		payloadHash = httpBase64(await httpSha(hash, httpUtf8(`hawk.1.payload\n${contentType}\n${request.body ?? ''}\n`)));
	}
	const port = url.port || (url.protocol === 'https:' ? '443' : '80');
	let normalized = `hawk.1.header\n${timestamp}\n${nonce}\n${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${url.hostname.toLowerCase()}\n${port}\n${payloadHash}\n${ext.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}\n`;
	if (app) {
		normalized += `${app}\n${dlg}\n`;
	}
	const mac = httpBase64(await httpHmac(hash, httpUtf8(param('authKey')), httpUtf8(normalized)));
	const parts = [`id="${param('authId')}"`, `ts="${timestamp}"`, `nonce="${nonce}"`];
	if (payloadHash) {
		parts.push(`hash="${payloadHash}"`);
	}
	if (ext) {
		parts.push(`ext="${ext.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
	}
	parts.push(`mac="${mac}"`);
	if (app) {
		parts.push(`app="${app}"`);
		if (dlg) {
			parts.push(`dlg="${dlg}"`);
		}
	}
	return { url: request.url, headers: withHeader(request.headers, 'Authorization', `Hawk ${parts.join(', ')}`) };
}

// --- AWS Signature Version 4 -----------------------------------------------------------------

async function signAws(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const accessKey = param('accessKey');
	const sessionToken = param('sessionToken');
	const region = param('region').trim() || 'us-east-1';
	const service = param('service').trim() || 'execute-api';
	const s3 = service === 's3';
	const inQuery = context.flag('addAuthDataToQuery');
	const url = parseUrl(request.url);
	const given = headerOf(request.headers, 'x-amz-date');
	const date = new Date(context.now());
	const amzDate = given && /^\d{8}T\d{6}Z$/.test(given.trim()) ? given.trim() : `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
	const day = amzDate.slice(0, 8);
	const scope = `${day}/${region}/${service}/aws4_request`;
	const sha256 = async (text: string) => httpHex(await httpSha('SHA-256', httpUtf8(text)));
	const payloadHash = inQuery && s3 ? 'UNSIGNED-PAYLOAD' : await sha256(request.body ?? '');

	// Each path segment encoded once as it travels, and once more for every service but S3.
	const canonicalPath = url.pathname.split('/').map(segment => {
		let plainSegment = segment;
		try {
			plainSegment = decodeURIComponent(segment);
		} catch {
			// Not percent-encoding: signed as it is written.
		}
		const once = strictEncode(plainSegment);
		return s3 ? once : strictEncode(once);
	}).join('/') || '/';

	let headers: (readonly [string, string])[] = [...request.headers];
	const query = pairsOf(url.search.replace(/^\?/, ''));
	const signed = new Map<string, string[]>();
	const sign = (name: string, value: string) => signed.set(name, [...(signed.get(name) ?? []), value.trim().replace(/\s+/g, ' ')]);
	sign('host', url.host);
	if (inQuery) {
		query.push(['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${accessKey}/${scope}`], ['X-Amz-Date', amzDate]);
		if (s3) {
			query.push(['X-Amz-Expires', '86400']);
		}
		query.push(['X-Amz-SignedHeaders', 'host']);
		if (sessionToken) {
			query.push(['X-Amz-Security-Token', sessionToken]);
		}
	} else {
		headers = withHeader(headers, 'X-Amz-Date', amzDate);
		if (sessionToken) {
			headers = withHeader(headers, 'X-Amz-Security-Token', sessionToken);
		}
		if (s3) {
			headers = withHeader(headers, 'X-Amz-Content-Sha256', payloadHash);
		}
		for (const [key, value] of headers) {
			const lower = key.toLowerCase();
			if (lower === 'content-type' || lower.startsWith('x-amz-')) {
				sign(lower, value);
			}
		}
	}
	const names = [...signed.keys()].sort();
	const encodedQuery = query.map(([key, value]) => [strictEncode(key), strictEncode(value)] as const);
	encodedQuery.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
	const canonical = [
		request.method.toUpperCase(),
		canonicalPath,
		encodedQuery.map(([key, value]) => `${key}=${value}`).join('&'),
		...names.map(name => `${name}:${signed.get(name)!.join(',')}`),
		'',
		names.join(';'),
		payloadHash,
	].join('\n');
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonical)}`;
	let key = httpUtf8(`AWS4${param('secretKey')}`);
	for (const part of [day, region, service, 'aws4_request']) {
		key = await httpHmac('SHA-256', key, httpUtf8(part));
	}
	const signature = httpHex(await httpHmac('SHA-256', key, httpUtf8(stringToSign)));
	if (inQuery) {
		const added = query.slice(pairsOf(url.search.replace(/^\?/, '')).length);
		return { url: withQuery(request.url, [...added, ['X-Amz-Signature', signature]]), headers: request.headers };
	}
	return { url: request.url, headers: withHeader(headers, 'Authorization', `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`) };
}

// --- Akamai EdgeGrid -------------------------------------------------------------------------

async function signEdgeGrid(context: ISignContext): Promise<IHttpSigned> {
	const { request, param } = context;
	const date = new Date(context.now());
	const timestamp = param('timestamp') || `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+0000`;
	const nonce = param('nonce') || context.nonce();
	const url = parseUrl(request.url);
	const baseUrl = param('baseURL').trim();
	const host = baseUrl ? parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).host : url.host;
	const method = request.method.toUpperCase();
	const maxBody = Number(param('maxBodySize')) > 0 ? Number(param('maxBodySize')) : 131072;
	let contentHash = '';
	if (method === 'POST' && request.body) {
		const body = httpUtf8(request.body);
		contentHash = httpBase64(await httpSha('SHA-256', body.byteLength > maxBody ? body.slice(0, maxBody) : body));
	}
	const canonicalHeaders = param('headersToSign').split(',').map(name => name.trim()).filter(Boolean).map(name => {
		const value = headerOf(request.headers, name.toLowerCase());
		return value === undefined ? undefined : `${name.toLowerCase()}:${value.trim().replace(/\s+/g, ' ')}`;
	}).filter((line): line is string => line !== undefined).join('\t');
	const unsigned = `EG1-HMAC-SHA256 client_token=${param('clientToken')};access_token=${param('accessToken')};timestamp=${timestamp};nonce=${nonce};`;
	const signingKey = httpBase64(await httpHmac('SHA-256', httpUtf8(param('clientSecret')), httpUtf8(timestamp)));
	const data = [method, url.protocol.replace(/:$/, ''), host, `${url.pathname}${url.search}`, canonicalHeaders, contentHash, unsigned].join('\t');
	const signature = httpBase64(await httpHmac('SHA-256', httpUtf8(signingKey), httpUtf8(data)));
	return { url: request.url, headers: withHeader(request.headers, 'Authorization', `${unsigned}signature=${signature}`) };
}
