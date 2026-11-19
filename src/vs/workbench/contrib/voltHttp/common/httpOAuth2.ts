/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OAuth 2.0's "Configure New Token": the requests that get a token (RFC 6749, PKCE RFC 7636) and
 * what the server answers. Nothing is sent here: the editor posts the request it is given.
 */

import { localize } from '../../../../nls.js';
import { httpBase64, httpBase64Url, httpRandomHex, httpSha, httpUtf8 } from './httpCrypto.js';

export type HttpOAuth2Grant = 'authorization_code' | 'authorization_code_with_pkce' | 'client_credentials' | 'password_credentials' | 'refresh_token';

export const HTTP_OAUTH2_GRANTS: readonly HttpOAuth2Grant[] = ['authorization_code', 'authorization_code_with_pkce', 'client_credentials', 'password_credentials', 'refresh_token'];

export function httpOAuth2GrantOf(value: string): HttpOAuth2Grant {
	return (HTTP_OAUTH2_GRANTS as readonly string[]).includes(value) ? value as HttpOAuth2Grant : 'authorization_code';
}

/** A form-encoded POST to a token endpoint. */
export interface IHttpTokenRequest {
	url: string;
	headers: [string, string][];
	body: string;
}

export interface IHttpOAuth2Token {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly tokenType?: string;
	/** Seconds. */
	readonly expiresIn?: number;
	readonly scope?: string;
}

function form(pairs: readonly (readonly [string, string])[]): string {
	return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value).replace(/%20/g, '+')}`).join('&');
}

/**
 * The token request of a grant. `get` reads a field of the auth with its `{{variables}}` filled
 * in. An authorization code grant needs the `code` the sign-in page ended on (and PKCE's verifier).
 */
export function httpOAuth2TokenRequest(get: (key: string) => string, grant: HttpOAuth2Grant, extra?: { readonly code?: string; readonly codeVerifier?: string }): IHttpTokenRequest | { readonly error: string } {
	const url = (grant === 'refresh_token' ? get('refreshTokenUrl').trim() || get('accessTokenUrl').trim() : get('accessTokenUrl').trim());
	if (!url) {
		return { error: localize('voltHttp.authTokenNoUrl', "Fill in the Access Token URL first.") };
	}
	const clientId = get('clientId');
	const clientSecret = get('clientSecret');
	const scope = get('scope').trim();
	const body: [string, string][] = [];
	switch (grant) {
		case 'authorization_code':
		case 'authorization_code_with_pkce': {
			if (!extra?.code) {
				return { error: localize('voltHttp.authTokenNoCode', "Paste the address the sign-in ended on, or its code, first.") };
			}
			body.push(['grant_type', 'authorization_code'], ['code', extra.code]);
			const redirect = get('redirect_uri').trim();
			if (redirect) {
				body.push(['redirect_uri', redirect]);
			}
			if (grant === 'authorization_code_with_pkce' && extra.codeVerifier) {
				body.push(['code_verifier', extra.codeVerifier]);
			}
			break;
		}
		case 'client_credentials':
			body.push(['grant_type', 'client_credentials']);
			break;
		case 'password_credentials':
			body.push(['grant_type', 'password'], ['username', get('username')], ['password', get('password')]);
			break;
		case 'refresh_token': {
			const refresh = get('refreshToken');
			if (!refresh) {
				return { error: localize('voltHttp.authTokenNoRefresh', "There is no refresh token to use yet.") };
			}
			body.push(['grant_type', 'refresh_token'], ['refresh_token', refresh]);
			break;
		}
	}
	if (scope && grant !== 'authorization_code' && grant !== 'authorization_code_with_pkce') {
		body.push(['scope', scope]);
	}
	for (const key of ['audience', 'resource']) {
		const value = get(key).trim();
		if (value) {
			body.push([key, value]);
		}
	}
	const headers: [string, string][] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
	if (get('client_authentication') === 'body' || !clientSecret) {
		// A public client (PKCE without a secret) names itself in the body.
		if (clientId) {
			body.push(['client_id', clientId]);
		}
		if (clientSecret) {
			body.push(['client_secret', clientSecret]);
		}
	} else {
		headers.push(['Authorization', `Basic ${httpBase64(httpUtf8(`${clientId}:${clientSecret}`))}`]);
	}
	return { url, headers, body: form(body) };
}

/** The sign-in page's address for an authorization code grant. */
export function httpOAuth2AuthorizeUrl(get: (key: string) => string, state: string, pkce?: { readonly challenge: string; readonly method: 'S256' | 'plain' }): string | { readonly error: string } {
	const base = get('authUrl').trim();
	if (!base) {
		return { error: localize('voltHttp.authTokenNoAuthUrl', "Fill in the Auth URL first.") };
	}
	const query: [string, string][] = [['response_type', 'code'], ['client_id', get('clientId')]];
	for (const key of ['redirect_uri', 'scope']) {
		const value = get(key).trim();
		if (value) {
			query.push([key, value]);
		}
	}
	query.push(['state', state]);
	if (pkce) {
		query.push(['code_challenge', pkce.challenge], ['code_challenge_method', pkce.method]);
	}
	for (const key of ['audience', 'resource']) {
		const value = get(key).trim();
		if (value) {
			query.push([key, value]);
		}
	}
	const hashAt = base.indexOf('#');
	const rest = hashAt < 0 ? base : base.slice(0, hashAt);
	return `${rest}${rest.includes('?') ? (rest.endsWith('?') || rest.endsWith('&') ? '' : '&') : '?'}${query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}${hashAt < 0 ? '' : base.slice(hashAt)}`;
}

/** A fresh PKCE code verifier: 64 characters of the unreserved set. */
export function httpPkceVerifier(): string {
	return httpRandomHex(32);
}

export async function httpPkceChallenge(verifier: string, method: 'S256' | 'plain'): Promise<string> {
	return method === 'plain' ? verifier : httpBase64Url(await httpSha('SHA-256', httpUtf8(verifier)));
}

function decode(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text;
	}
}

function pairs(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const pair of text.split('&')) {
		const at = pair.indexOf('=');
		if (pair && at !== 0) {
			out.set(decode(at < 0 ? pair : pair.slice(0, at)), at < 0 ? '' : decode(pair.slice(at + 1)));
		}
	}
	return out;
}

/** What the user pasted after signing in: the whole redirected address (its `code`, `state` or `error`), or the code alone. */
export function httpOAuth2CodeFrom(pasted: string): { readonly code?: string; readonly state?: string; readonly error?: string } {
	const text = pasted.trim();
	if (!text) {
		return {};
	}
	if (!/[?#&=]/.test(text)) {
		return { code: text };
	}
	const queryAt = text.indexOf('?');
	const hashAt = text.indexOf('#');
	const found = new Map<string, string>([
		...pairs(hashAt < 0 ? '' : text.slice(hashAt + 1)),
		...pairs(queryAt < 0 ? (hashAt < 0 ? text : '') : text.slice(queryAt + 1, hashAt > queryAt ? hashAt : undefined)),
	]);
	const error = found.get('error');
	if (error) {
		return { error: found.get('error_description') || error };
	}
	const code = found.get('code');
	const state = found.get('state');
	return { ...(code ? { code } : {}), ...(state !== undefined ? { state } : {}) };
}

/** A token endpoint's answer: JSON, or the form encoding some servers still use. */
export function parseHttpOAuth2Token(status: number, body: string): IHttpOAuth2Token | { readonly error: string } {
	let fields: Record<string, unknown> = {};
	try {
		const json: unknown = JSON.parse(body);
		if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
			fields = json as Record<string, unknown>;
		}
	} catch {
		if (/^[^<{\s][^\s]*=/.test(body.trim())) {
			fields = Object.fromEntries(pairs(body.trim()));
		}
	}
	const text = (key: string) => typeof fields[key] === 'string' ? fields[key] as string : typeof fields[key] === 'number' ? String(fields[key]) : '';
	const accessToken = text('access_token');
	if (status < 200 || status >= 300 || !accessToken) {
		const reason = text('error_description') || text('error') || (typeof fields.error === 'object' && fields.error !== null ? JSON.stringify(fields.error) : '') || text('message');
		return {
			error: reason
				? localize('voltHttp.authTokenRefused', "The token request was answered with {0}: {1}", status, reason)
				: accessToken || status < 200 || status >= 300
					? localize('voltHttp.authTokenStatus', "The token request was answered with {0}.", status)
					: localize('voltHttp.authTokenMissing', "The answer ({0}) has no access_token.", status),
		};
	}
	const expires = Number(text('expires_in'));
	return {
		accessToken,
		...(text('refresh_token') ? { refreshToken: text('refresh_token') } : {}),
		...(text('token_type') ? { tokenType: text('token_type') } : {}),
		...(text('expires_in') && Number.isFinite(expires) ? { expiresIn: expires } : {}),
		...(text('scope') ? { scope: text('scope') } : {}),
	};
}
