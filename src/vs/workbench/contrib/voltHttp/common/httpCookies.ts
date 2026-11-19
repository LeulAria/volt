/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The HTTP client's cookie jar, after RFC 6265: what a `Set-Cookie` line means for the URL that
 * answered with it, which cookies a URL gets back, and when one is gone. A jar is a plain array
 * of cookies so it can be stored as JSON; the functions here return new arrays.
 *
 * Not done: the public suffix list (a response from `a.co.uk` may set a cookie for `co.uk`), and
 * SameSite, which is kept and shown but not enforced: the client has no "site" a request comes from.
 */

export type HttpCookieSameSite = 'Strict' | 'Lax' | 'None';

export interface IHttpCookie {
	readonly name: string;
	readonly value: string;
	/** Lower case, without a leading dot. */
	readonly domain: string;
	readonly path: string;
	/** Sent to `domain` alone, not to its subdomains (the cookie had no Domain attribute). */
	readonly hostOnly: boolean;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	readonly sameSite?: HttpCookieSameSite;
	/** When it ends, ms since the epoch; a session cookie when absent. */
	readonly expires?: number;
	readonly created: number;
}

/** The most cookies one jar keeps; the oldest go first. */
export const MAX_HTTP_COOKIES = 600;
const MAX_COOKIE_BYTES = 8192;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A cookie date (RFC 6265 5.1.1) as ms since the epoch, or undefined when it is not one. */
export function parseHttpCookieDate(text: string): number | undefined {
	let time: [number, number, number] | undefined;
	let day: number | undefined;
	let month: number | undefined;
	let year: number | undefined;
	for (const token of text.split(/[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/)) {
		if (!token) {
			continue;
		}
		const clock = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/.exec(token);
		if (!time && clock) {
			time = [Number(clock[1]), Number(clock[2]), Number(clock[3])];
			continue;
		}
		const dayOf = /^(\d{1,2})(?:\D|$)/.exec(token);
		if (day === undefined && dayOf) {
			day = Number(dayOf[1]);
			continue;
		}
		const monthOf = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
		if (month === undefined && monthOf >= 0) {
			month = monthOf;
			continue;
		}
		const yearOf = /^(\d{2,4})(?:\D|$)/.exec(token);
		if (year === undefined && yearOf) {
			year = Number(yearOf[1]);
			year += year >= 70 && year <= 99 ? 1900 : year >= 0 && year <= 69 ? 2000 : 0;
		}
	}
	if (!time || day === undefined || month === undefined || year === undefined || day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59) {
		return undefined;
	}
	return Date.UTC(year, month, day, time[0], time[1], time[2]);
}

/** Several `Set-Cookie` headers joined with ", " (how most stacks hand them over) as their lines again. */
export function splitHttpSetCookie(joined: string): string[] {
	// A comma also sits inside `Expires=Wed, 21 Oct ...`: split only where a new `name=` starts.
	return joined.split(/,\s*(?=[^;,=\s]+=)/).map(line => line.trim()).filter(Boolean);
}

/** The `Set-Cookie` lines of a response's headers, whether they came as a list or joined. */
export function httpSetCookieLines(headers: Readonly<Record<string, string | readonly string[] | undefined>>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === 'set-cookie' && value !== undefined) {
			lines.push(...(typeof value === 'string' ? splitHttpSetCookie(value) : value.map(line => line.trim()).filter(Boolean)));
		}
	}
	return lines;
}

interface IUrlParts {
	readonly secure: boolean;
	readonly host: string;
	readonly path: string;
}

function urlParts(url: string): IUrlParts | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::\d*)?([^?#]*)/i.exec(url);
	if (!match || !match[2]) {
		return undefined;
	}
	const scheme = match[1].toLowerCase();
	const host = match[2].toLowerCase().replace(/\.$/, '');
	// A local server counts as secure, as browsers have it: a Secure cookie set on https://localhost goes to http://localhost too.
	return { secure: scheme === 'https' || scheme === 'wss' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]', host, path: match[3] || '/' };
}

function isIpAddress(host: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/** The host a cookie domain typed or stored stands for: lower case, no scheme, port, path or leading dot. */
export function normalizeHttpCookieDomain(text: string): string {
	return text.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^[^@]*@/, '').replace(/:\d*$/, '').replace(/^\.+/, '').replace(/\.$/, '');
}

/** RFC 6265 5.1.3: `host` is `domain`, or ends with `.domain` and is not an IP address. */
export function httpCookieDomainMatches(host: string, domain: string): boolean {
	return host === domain || (host.endsWith(`.${domain}`) && !isIpAddress(host));
}

/** RFC 6265 5.1.4: the directory of the request's path. */
export function defaultHttpCookiePath(requestPath: string): string {
	if (!requestPath.startsWith('/')) {
		return '/';
	}
	const last = requestPath.lastIndexOf('/');
	return last <= 0 ? '/' : requestPath.slice(0, last);
}

/** RFC 6265 5.1.4: the cookie's path is the request's, or a directory above it. */
export function httpCookiePathMatches(requestPath: string, cookiePath: string): boolean {
	return requestPath === cookiePath || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
}

/**
 * One `Set-Cookie` line as the cookie it sets for the URL that sent it. Undefined when the line is
 * not a cookie or names a domain the URL's host does not belong to. A cookie already expired comes
 * back with its `expires` in the past: storing it removes the one it names.
 */
export function parseHttpSetCookie(line: string, url: string, now: number): IHttpCookie | undefined {
	const from = urlParts(url);
	if (!from || line.length > MAX_COOKIE_BYTES) {
		return undefined;
	}
	const [pair, ...attributes] = line.split(';');
	const at = pair.indexOf('=');
	if (at < 0) {
		return undefined;
	}
	const name = pair.slice(0, at).trim();
	const value = pair.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
	if (!name || /[\x00-\x1F\x7F]/.test(name + value)) {
		return undefined;
	}
	let domain: string | undefined;
	let path: string | undefined;
	let expires: number | undefined;
	let maxAge: number | undefined;
	let secure = false;
	let httpOnly = false;
	let sameSite: HttpCookieSameSite | undefined;
	for (const attribute of attributes) {
		const split = attribute.indexOf('=');
		const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
		const text = split < 0 ? '' : attribute.slice(split + 1).trim();
		switch (key) {
			case 'expires': expires = parseHttpCookieDate(text) ?? expires; break;
			case 'max-age':
				if (/^-?\d+$/.test(text)) {
					maxAge = Number(text);
				}
				break;
			case 'domain':
				// An empty Domain is ignored; the last one given wins.
				domain = normalizeHttpCookieDomain(text) || domain;
				break;
			case 'path': path = text.startsWith('/') ? text : undefined; break;
			case 'secure': secure = true; break;
			case 'httponly': httpOnly = true; break;
			case 'samesite': sameSite = (['Strict', 'Lax', 'None'] as const).find(item => item.toLowerCase() === text.toLowerCase()); break;
		}
	}
	if (domain !== undefined && !httpCookieDomainMatches(from.host, domain)) {
		return undefined;
	}
	// `__Secure-` and `__Host-` names promise what their attributes must then say.
	if ((name.startsWith('__Secure-') && !secure) || (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/'))) {
		return undefined;
	}
	// Max-Age wins over Expires; zero or less ends the cookie at once.
	const ends = maxAge !== undefined ? (maxAge <= 0 ? 0 : now + maxAge * 1000) : expires;
	return {
		name,
		value,
		domain: domain ?? from.host,
		path: path ?? defaultHttpCookiePath(from.path),
		hostOnly: domain === undefined,
		secure,
		httpOnly,
		...(sameSite ? { sameSite } : {}),
		...(ends !== undefined ? { expires: ends } : {}),
		created: now,
	};
}

function sameCookie(a: IHttpCookie, b: IHttpCookie): boolean {
	return a.name === b.name && a.domain === b.domain && a.path === b.path;
}

/** The jar without the cookies whose time has passed. */
export function liveHttpCookies(jar: readonly IHttpCookie[], now: number): IHttpCookie[] {
	return jar.filter(cookie => cookie.expires === undefined || cookie.expires > now);
}

/** The jar with `cookie` in it: it replaces the one of the same name, domain and path (keeping that one's age), or removes it when it has expired. */
export function setHttpCookie(jar: readonly IHttpCookie[], cookie: IHttpCookie, now: number): IHttpCookie[] {
	const before = jar.find(item => sameCookie(item, cookie));
	const rest = liveHttpCookies(jar.filter(item => !sameCookie(item, cookie)), now);
	if (cookie.expires !== undefined && cookie.expires <= now) {
		return rest;
	}
	const next = [...rest, before ? { ...cookie, created: before.created } : cookie];
	return next.length > MAX_HTTP_COOKIES ? [...next].sort((a, b) => a.created - b.created).slice(next.length - MAX_HTTP_COOKIES) : next;
}

/** The jar after a response from `url` with these `Set-Cookie` lines. */
export function storeHttpCookies(jar: readonly IHttpCookie[], lines: readonly string[], url: string, now: number): IHttpCookie[] {
	let next = [...jar];
	for (const line of lines) {
		const cookie = parseHttpSetCookie(line, url, now);
		if (cookie) {
			next = setHttpCookie(next, cookie, now);
		}
	}
	return next;
}

/** The cookies a request to `url` carries: longest path first, then the oldest (RFC 6265 5.4). */
export function httpCookiesFor(jar: readonly IHttpCookie[], url: string, now: number): IHttpCookie[] {
	const to = urlParts(url);
	if (!to) {
		return [];
	}
	return liveHttpCookies(jar, now)
		.filter(cookie => (cookie.hostOnly ? to.host === cookie.domain : httpCookieDomainMatches(to.host, cookie.domain)) && httpCookiePathMatches(to.path, cookie.path) && (!cookie.secure || to.secure))
		.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
}

/**
 * The `Cookie` header for a request to `url`: the jar's cookies for it, after the ones the user
 * wrote in a Cookie header of their own (`own`), which win over the jar's of the same name.
 * Undefined when there is nothing to send.
 */
export function httpCookieHeader(jar: readonly IHttpCookie[], url: string, now: number, own?: string): string | undefined {
	const written = (own ?? '').split(';').map(part => part.trim()).filter(Boolean);
	const names = new Set(written.map(part => part.split('=')[0].trim()));
	const parts = [...written, ...httpCookiesFor(jar, url, now).filter(cookie => !names.has(cookie.name)).map(cookie => `${cookie.name}=${cookie.value}`)];
	return parts.length ? parts.join('; ') : undefined;
}

/** A cookie as the text it is edited as, in `Set-Cookie`'s form. */
export function serializeHttpCookie(cookie: IHttpCookie): string {
	return [
		`${cookie.name}=${cookie.value}`,
		`Path=${cookie.path}`,
		...(cookie.hostOnly ? [] : [`Domain=${cookie.domain}`]),
		...(cookie.expires !== undefined ? [`Expires=${new Date(cookie.expires).toUTCString()}`] : []),
		...(cookie.secure ? ['Secure'] : []),
		...(cookie.httpOnly ? ['HttpOnly'] : []),
		...(cookie.sameSite ? [`SameSite=${cookie.sameSite}`] : []),
	].join('; ');
}

/** A cookie's attributes as one muted line: where it applies and until when. */
export function httpCookieAttributes(cookie: IHttpCookie): string {
	return serializeHttpCookie(cookie).split('; ').slice(1).join('; ');
}

/** Cookie text typed for a domain (the manager's editor) as a cookie; a path of `/` when none is given. */
export function parseHttpCookieText(text: string, domain: string, now: number): IHttpCookie | undefined {
	const host = normalizeHttpCookieDomain(domain);
	return host ? parseHttpSetCookie(text.trim().replace(/;\s*$/, ''), `https://${host}/`, now) : undefined;
}

/** The domains of a jar with how many cookies each holds, by name. */
export function httpCookieDomains(jar: readonly IHttpCookie[]): { readonly domain: string; readonly count: number }[] {
	const counts = new Map<string, number>();
	for (const cookie of jar) {
		counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
	}
	return [...counts].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
}

/** What storage held as a jar again: only well-formed cookies. */
export function reviveHttpCookies(value: unknown): IHttpCookie[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: IHttpCookie[] = [];
	for (const item of value as unknown[]) {
		const cookie = item as Partial<IHttpCookie> | null;
		if (cookie && typeof cookie === 'object' && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string' && typeof cookie.path === 'string') {
			out.push({
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path,
				hostOnly: cookie.hostOnly === true,
				secure: cookie.secure === true,
				httpOnly: cookie.httpOnly === true,
				...(cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None' ? { sameSite: cookie.sameSite } : {}),
				...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
				created: typeof cookie.created === 'number' ? cookie.created : 0,
			});
		}
	}
	return out;
}
