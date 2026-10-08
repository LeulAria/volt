/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_EXTERNAL_MCP_SCOPES, EXTERNAL_MCP_SCOPES, ExternalMcpScope } from './voltExternalMcp.js';

/**
 * The pure rules of Volt's external MCP authorization server: scopes, redirect URIs, PKCE
 * shapes, which hosts and origins may talk to it, and the metadata documents. The HTTP server
 * and the token store (hashing, persistence) build on these.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTH_CODE_TTL_MS = 60_000;
export const CONSENT_TTL_MS = 10 * 60_000;
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

/** Token prefixes: a leaked string says what it is, and secret scanners can match it. */
export const ACCESS_TOKEN_PREFIX = 'volt_at_';
export const REFRESH_TOKEN_PREFIX = 'volt_rt_';
export const AUTH_CODE_PREFIX = 'volt_ac_';

//#region Scopes

export interface IParsedScopes {
	readonly scopes: readonly ExternalMcpScope[];
	readonly unknown: readonly string[];
}

/** `"read send"` → known scopes in canonical order, and the ones Volt does not have. Empty → the defaults. */
export function parseScopes(value: string | undefined | null, fallback: readonly ExternalMcpScope[] = DEFAULT_EXTERNAL_MCP_SCOPES): IParsedScopes {
	const words = (value ?? '').split(/\s+/).map(word => word.trim()).filter(Boolean);
	if (!words.length) {
		return { scopes: [...fallback], unknown: [] };
	}
	const known = new Set<ExternalMcpScope>();
	const unknown: string[] = [];
	for (const word of words) {
		// Some clients namespace scopes (`volt:read`, `mcp:read`); the part after the colon counts.
		const bare = word.includes(':') ? word.slice(word.lastIndexOf(':') + 1) : word;
		if ((EXTERNAL_MCP_SCOPES as readonly string[]).includes(bare)) {
			known.add(bare as ExternalMcpScope);
		} else {
			unknown.push(word);
		}
	}
	return { scopes: EXTERNAL_MCP_SCOPES.filter(scope => known.has(scope)), unknown };
}

/** Only scopes in `allowed` survive (a refresh or a consent can narrow, never widen). */
export function narrowScopes(wanted: readonly ExternalMcpScope[], allowed: readonly ExternalMcpScope[]): ExternalMcpScope[] {
	return EXTERNAL_MCP_SCOPES.filter(scope => wanted.includes(scope) && allowed.includes(scope));
}

export function formatScopes(scopes: readonly ExternalMcpScope[]): string {
	return EXTERNAL_MCP_SCOPES.filter(scope => scopes.includes(scope)).join(' ');
}

/**
 * The scope each orchestrator tool needs. Tools not listed are never served to outside agents:
 * they need a calling chat (delegate_task), act on the user's screen (browser, devices) or ask
 * the user questions on an agent's behalf.
 */
const TOOL_SCOPES: Readonly<Record<string, ExternalMcpScope>> = {
	orchestrator_capabilities: 'read',
	thread_list: 'read',
	thread_search: 'read',
	thread_read: 'read',
	thread_wait: 'read',
	queue_list: 'read',
	worktree_status: 'read',
	worktree_list: 'read',
	thread_send: 'send',
	thread_interrupt: 'send',
	queue_edit: 'send',
	queue_cancel: 'send',
	queue_reorder: 'send',
	queue_send_now: 'send',
	queue_resume: 'send',
	thread_launch: 'launch',
	thread_fork: 'launch',
	thread_update: 'admin',
	thread_configure: 'admin',
};

export function externalToolScope(name: string): ExternalMcpScope | undefined {
	return Object.prototype.hasOwnProperty.call(TOOL_SCOPES, name) ? TOOL_SCOPES[name] : undefined;
}

//#endregion

//#region Redirect URIs

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Custom schemes that would run code or read files instead of handing a code to an app. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'filesystem:', 'ftp:', 'ws:', 'wss:']);

export function isLoopbackHostname(hostname: string): boolean {
	return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Which redirect URIs a client may register (RFC 8252, OAuth 2.1 section 2.3.1): http only on loopback,
 * https anywhere, and app schemes (`cursor://`, `vscode://`, `com.example.app:/cb`). No fragment,
 * no userinfo, nothing that runs code.
 */
export function checkRedirectUri(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value || value.length > 1024) {
		return 'redirect_uri must be a URI up to 1024 characters';
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return `redirect_uri ${value} is not a URI`;
	}
	if (value.includes('#')) {
		return 'redirect_uri must not have a fragment';
	}
	if (url.username || url.password) {
		return 'redirect_uri must not carry credentials';
	}
	if (FORBIDDEN_SCHEMES.has(url.protocol)) {
		return `redirect_uri scheme ${url.protocol} is not allowed`;
	}
	if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
		return 'http redirect URIs must point to the loopback interface (127.0.0.1, [::1] or localhost)';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:' && !/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol)) {
		return `redirect_uri scheme ${url.protocol} is not allowed`;
	}
	return undefined;
}

/**
 * Whether `requested` is one of the client's registered URIs. A loopback http URI matches with
 * any port (RFC 8252 section 7.3: native apps pick a free port per sign-in); everything else is exact.
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
	if (registered.includes(requested)) {
		return true;
	}
	let wanted: URL;
	try {
		wanted = new URL(requested);
	} catch {
		return false;
	}
	if (wanted.protocol !== 'http:' || !isLoopbackHostname(wanted.hostname) || requested.includes('#')) {
		return false;
	}
	return registered.some(candidate => {
		try {
			const url = new URL(candidate);
			return url.protocol === 'http:' && url.hostname === wanted.hostname && url.pathname === wanted.pathname && url.search === wanted.search;
		} catch {
			return false;
		}
	});
}

/** Where the consent screen says the code goes: "this computer (port 53682)" or the host. */
export function describeRedirect(uri: string): { readonly local: boolean; readonly label: string } {
	try {
		const url = new URL(uri);
		if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
			return { local: true, label: `an app on this computer (port ${url.port || '80'})` };
		}
		if (url.protocol === 'https:') {
			return { local: false, label: url.host };
		}
		return { local: true, label: `the ${url.protocol.slice(0, -1)} app` };
	} catch {
		return { local: false, label: uri };
	}
}

//#endregion

//#region PKCE

/** S256 challenge: base64url of a SHA-256 digest, 43 characters. */
export function isPkceChallenge(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** RFC 7636 section 4.1: 43-128 unreserved characters. */
export function isPkceVerifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

//#endregion

//#region Hosts, origins and URLs

export interface IServerOrigins {
	readonly port: number;
	/** https origin of a tunnel, or '' */
	readonly publicUrl: string;
}

/** `https://abc.trycloudflare.com/` → `https://abc.trycloudflare.com`; invalid or non-https → ''. */
export function normalizePublicUrl(value: string | undefined): string {
	const raw = (value ?? '').trim();
	if (!raw) {
		return '';
	}
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' || url.username || url.password) {
			return '';
		}
		return url.origin;
	} catch {
		return '';
	}
}

/**
 * The base URL a request reached the server through, or undefined when its Host is not one the
 * server answers to (DNS rebinding sends a foreign Host). Loopback names keep the form the client
 * used, so the issuer it discovers matches the URL it fetched (RFC 8414 section 3.3).
 */
export function baseUrlFor(host: string | undefined, origins: IServerOrigins): string | undefined {
	const value = (host ?? '').trim().toLowerCase();
	if (!value) {
		return undefined;
	}
	for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
		if (value === `${name}:${origins.port}`) {
			return `http://${name}:${origins.port}`;
		}
	}
	if (origins.publicUrl) {
		const url = new URL(origins.publicUrl);
		if (value === url.host.toLowerCase()) {
			return url.origin;
		}
	}
	return undefined;
}

/** Tokens are bound to the resource they were issued for; the loopback names count as one. */
export function sameResource(a: string, b: string): boolean {
	const key = (value: string) => {
		try {
			const url = new URL(value);
			const host = isLoopbackHostname(url.hostname) ? 'loopback' : url.hostname.toLowerCase();
			return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, '')}`;
		} catch {
			return value;
		}
	};
	return key(a) === key(b);
}

/**
 * Whether a request's Origin may use the MCP endpoint. Agent HTTP clients send none. Browsers
 * always do; only Volt's own origins are allowed (no CORS is offered to other sites).
 */
export function isAllowedOrigin(origin: string | undefined, base: string): boolean {
	if (origin === undefined) {
		return true;
	}
	try {
		return new URL(origin).origin === new URL(base).origin;
	} catch {
		return false;
	}
}

//#endregion

//#region Metadata documents

export function protectedResourceMetadata(base: string): object {
	return {
		resource: `${base}/mcp`,
		authorization_servers: [base],
		scopes_supported: [...EXTERNAL_MCP_SCOPES],
		bearer_methods_supported: ['header'],
		resource_name: 'Volt',
	};
}

export function authorizationServerMetadata(base: string): object {
	return {
		issuer: base,
		authorization_endpoint: `${base}/oauth/authorize`,
		token_endpoint: `${base}/oauth/token`,
		registration_endpoint: `${base}/oauth/register`,
		revocation_endpoint: `${base}/oauth/revoke`,
		scopes_supported: [...EXTERNAL_MCP_SCOPES],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		revocation_endpoint_auth_methods_supported: ['none'],
		code_challenge_methods_supported: ['S256'],
		authorization_response_iss_parameter_supported: true,
	};
}

/** RFC 6750 section 3 / MCP authorization: where to find the metadata, and why the token did not do. */
export function wwwAuthenticate(base: string, options: { readonly error?: 'invalid_token' | 'insufficient_scope'; readonly scope?: readonly ExternalMcpScope[]; readonly description?: string } = {}): string {
	const parts = [`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`];
	if (options.error) {
		parts.push(`error="${options.error}"`);
	}
	if (options.scope?.length) {
		parts.push(`scope="${formatScopes(options.scope)}"`);
	}
	if (options.description) {
		parts.push(`error_description="${options.description.replace(/["\\]/g, '')}"`);
	}
	return `Bearer ${parts.join(', ')}`;
}

//#endregion

//#region Client registration

export interface IClientMetadataInput {
	readonly client_name?: unknown;
	readonly redirect_uris?: unknown;
	readonly client_uri?: unknown;
	readonly software_id?: unknown;
	readonly software_version?: unknown;
	readonly scope?: unknown;
}

export interface IValidClientMetadata {
	readonly name: string;
	readonly redirectUris: readonly string[];
	readonly clientUri?: string;
	readonly softwareId?: string;
	readonly softwareVersion?: string;
}

/** RFC 7591 registration body → what Volt keeps, or the `invalid_*` error to return. */
export function checkClientMetadata(body: IClientMetadataInput): IValidClientMetadata | { readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata'; readonly description: string } {
	const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
	if (!uris.length || uris.length > 10) {
		return { error: 'invalid_redirect_uri', description: 'Register 1 to 10 redirect_uris.' };
	}
	for (const uri of uris) {
		const problem = checkRedirectUri(uri);
		if (problem) {
			return { error: 'invalid_redirect_uri', description: problem };
		}
	}
	const rawName = typeof body.client_name === 'string' ? body.client_name : '';
	// Control and bidi characters could make one app's name read as another's on the consent screen.
	const name = rawName.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
	let clientUri: string | undefined;
	if (typeof body.client_uri === 'string' && body.client_uri) {
		try {
			const url = new URL(body.client_uri);
			clientUri = url.protocol === 'https:' ? url.toString() : undefined;
		} catch {
			clientUri = undefined;
		}
	}
	const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined;
	return {
		name: name || 'Unnamed agent',
		redirectUris: uris as string[],
		...(clientUri ? { clientUri } : {}),
		...(text(body.software_id) ? { softwareId: text(body.software_id) } : {}),
		...(text(body.software_version) ? { softwareVersion: text(body.software_version) } : {}),
	};
}

//#endregion

/** A redirect back to the client with `params` (and `iss`, RFC 9207) added to its query. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

/** Negotiated protocol version: the client's when Volt speaks it, else the newest. */
export function negotiateProtocolVersion(requested: unknown): string {
	return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}
