/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Browsers whose cookies Volt can read. Every Chromium-based one shares one reader. */
export type VoltCookieBrowser = 'chrome' | 'chromium' | 'edge' | 'brave' | 'arc' | 'vivaldi' | 'opera' | 'operaGx' | 'safari' | 'firefox' | 'zen';

/** One browser profile's cookie store. */
export interface IVoltCookieSource {
	/** `<browser>:<profile folder>`, stable across runs. */
	readonly id: string;
	readonly browser: VoltCookieBrowser;
	readonly browserLabel: string;
	/** The profile's folder name ("Default", "Profile 1", "abcd.default-release"). */
	readonly profile: string;
	/** The name the user gave the profile, if the browser keeps one. */
	readonly profileLabel: string;
	readonly path: string;
	/** Reading needs the OS keychain (macOS asks the user once), DPAPI (Windows) or the Secret Service (Linux). */
	readonly encrypted: boolean;
}

export interface IVoltCookieImportRequest {
	readonly sourceId: string;
	/** Only cookies for these sites (and their subdomains). Empty: every cookie. */
	readonly domains?: readonly string[];
	/** The preview browser profile (session partition) to import into. Default: the in-app browser's. */
	readonly partition?: string;
}

export interface IVoltCookieImportResult {
	readonly imported: number;
	/** Expired, partitioned, or outside the domain filter. */
	readonly skipped: number;
	/** Could not be decrypted or were refused by the session. */
	readonly failed: number;
	/** Sites (registrable hosts) that got cookies. */
	readonly sites: number;
	readonly warnings: readonly string[];
}

export type CookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict';

/** A cookie read from another browser, before it goes into Electron's session. */
export interface IReadCookie {
	/** As the browser stores it: `.example.com` for domain cookies, `example.com` for host-only ones. */
	readonly host: string;
	readonly name: string;
	readonly value: string;
	readonly path: string;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	/** Unix seconds; undefined for session cookies. */
	readonly expires?: number;
	readonly sameSite: CookieSameSite;
}

/** Electron's `CookiesSetDetails`. */
export interface IElectronCookie {
	readonly url: string;
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path: string;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	readonly expirationDate?: number;
	readonly sameSite: CookieSameSite;
}

/** Microseconds since 1601-01-01 (Chromium's `expires_utc`) to Unix seconds; 0 means a session cookie. */
export function chromiumTimeToUnix(value: number | bigint | string | undefined): number | undefined {
	const micros = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
	if (!Number.isFinite(micros) || micros <= 0) {
		return undefined;
	}
	return Math.floor(micros / 1_000_000 - 11_644_473_600);
}

/** Seconds since 2001-01-01 (Safari, Core Foundation) to Unix seconds. */
export function macTimeToUnix(seconds: number): number | undefined {
	return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds + 978_307_200) : undefined;
}

/** Firefox's `expiry` was seconds and is milliseconds since Firefox 137. */
export function firefoxExpiryToUnix(value: number | undefined): number | undefined {
	if (!value || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.floor(value > 100_000_000_000 ? value / 1000 : value);
}

/** Chromium's `samesite` column: -1 unspecified, 0 none, 1 lax, 2 strict. */
export function chromiumSameSite(value: number): CookieSameSite {
	switch (value) {
		case 0: return 'no_restriction';
		case 1: return 'lax';
		case 2: return 'strict';
		default: return 'unspecified';
	}
}

/** Firefox's `sameSite` column: 0 none, 1 lax, 2 strict (256 and others: not set). */
export function firefoxSameSite(value: number): CookieSameSite {
	switch (value) {
		case 0: return 'no_restriction';
		case 1: return 'lax';
		case 2: return 'strict';
		default: return 'unspecified';
	}
}

/** "github.com, https://vercel.app/x  .example.org" → `['github.com', 'vercel.app', 'example.org']`. */
export function parseDomainFilter(value: string | readonly string[] | undefined): string[] {
	const parts = typeof value === 'string' ? value.split(/[\s,;]+/) : [...(value ?? [])];
	const out: string[] = [];
	for (const part of parts) {
		const host = part.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*?\.+/, '');
		if (host && /^[a-z0-9.-]+$/.test(host) && !out.includes(host)) {
			out.push(host);
		}
	}
	return out;
}

/** Whether a cookie for `host` belongs to one of the sites in `filter` (or there is no filter). */
export function matchesDomainFilter(host: string, filter: readonly string[]): boolean {
	if (!filter.length) {
		return true;
	}
	const bare = host.toLowerCase().replace(/^\./, '');
	return filter.some(site => bare === site || bare.endsWith(`.${site}`) || (host.startsWith('.') && site.endsWith(`.${bare}`)));
}

/**
 * The details for `session.cookies.set`, or why it cannot be set: expired, or a cookie Chromium
 * would reject (a `__Host-` cookie that is not host-only, SameSite=None without Secure is kept
 * as unspecified, which Chromium treats as Lax).
 */
export function toElectronCookie(cookie: IReadCookie, now = Date.now() / 1000): IElectronCookie | { readonly skip: string } {
	if (!cookie.name && !cookie.value) {
		return { skip: 'empty' };
	}
	if (cookie.expires !== undefined && cookie.expires <= now) {
		return { skip: 'expired' };
	}
	const domainCookie = cookie.host.startsWith('.');
	const bareHost = cookie.host.replace(/^\./, '');
	if (!bareHost || /\s/.test(bareHost)) {
		return { skip: 'invalid host' };
	}
	const path = cookie.path?.startsWith('/') ? cookie.path : '/';
	let secure = cookie.secure;
	if (cookie.name.startsWith('__Host-')) {
		if (domainCookie || path !== '/' || !secure) {
			return { skip: 'invalid __Host- cookie' };
		}
	}
	if (cookie.name.startsWith('__Secure-')) {
		secure = true;
	}
	const sameSite = cookie.sameSite === 'no_restriction' && !secure ? 'unspecified' : cookie.sameSite;
	return {
		url: `${secure ? 'https' : 'http'}://${bareHost}${path}`,
		name: cookie.name,
		value: cookie.value,
		// Host-only cookies are set without a domain; Chromium then keeps them host-only.
		domain: domainCookie ? cookie.host : undefined,
		path,
		secure,
		httpOnly: cookie.httpOnly,
		expirationDate: cookie.expires,
		sameSite,
	};
}

/** The site a host belongs to, roughly (last two labels), to count sites in the result. */
export function siteOf(host: string): string {
	const labels = host.replace(/^\./, '').split('.');
	return labels.slice(-2).join('.');
}

/** `Local State`'s profile names: folder → the name the user sees. */
export function parseChromiumProfileNames(localState: string): Map<string, string> {
	const names = new Map<string, string>();
	try {
		const cache = (JSON.parse(localState) as { profile?: { info_cache?: Record<string, { name?: string }> } }).profile?.info_cache ?? {};
		for (const [folder, info] of Object.entries(cache)) {
			if (info?.name) {
				names.set(folder, info.name);
			}
		}
	} catch {
		// unreadable: folder names only
	}
	return names;
}

export interface IFirefoxProfile {
	readonly name: string;
	readonly path: string;
	readonly relative: boolean;
	readonly isDefault: boolean;
}

/** Firefox's `profiles.ini`: `[ProfileN]` sections with Name, Path, IsRelative, Default. */
export function parseFirefoxProfilesIni(ini: string): IFirefoxProfile[] {
	const profiles: IFirefoxProfile[] = [];
	let current: Record<string, string> | undefined;
	const flush = () => {
		if (current?.Path) {
			profiles.push({ name: current.Name || current.Path, path: current.Path, relative: current.IsRelative !== '0', isDefault: current.Default === '1' });
		}
	};
	for (const raw of ini.split(/\r?\n/)) {
		const line = raw.trim();
		const section = /^\[(.+)\]$/.exec(line);
		if (section) {
			flush();
			current = /^Profile\d+$/.test(section[1]) ? {} : undefined;
			continue;
		}
		const pair = /^([^=]+)=(.*)$/.exec(line);
		if (pair && current) {
			current[pair[1].trim()] = pair[2].trim();
		}
	}
	flush();
	return profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * Safari's `Cookies.binarycookies`: `cook`, a big-endian page count and page sizes, then pages
 * of little-endian cookie records (flags, string offsets, expiry as seconds since 2001).
 */
export function parseBinaryCookies(bytes: Uint8Array): IReadCookie[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'cook') {
		throw new Error('Not a Safari cookie file.');
	}
	const pageCount = view.getUint32(4);
	const sizes: number[] = [];
	let at = 8;
	for (let i = 0; i < pageCount; i++) {
		sizes.push(view.getUint32(at));
		at += 4;
	}
	const cookies: IReadCookie[] = [];
	for (const size of sizes) {
		const page = at;
		at += size;
		if (page + 8 > bytes.length || view.getUint32(page) !== 0x00000100) {
			continue;
		}
		const count = view.getUint32(page + 4, true);
		for (let i = 0; i < count; i++) {
			const start = page + view.getUint32(page + 8 + i * 4, true);
			if (start + 56 > bytes.length) {
				continue;
			}
			const cookieSize = view.getUint32(start, true);
			const end = Math.min(bytes.length, start + cookieSize);
			const flags = view.getUint32(start + 8, true);
			const read = (offsetAt: number) => {
				const offset = view.getUint32(start + offsetAt, true);
				let stop = start + offset;
				while (stop < end && bytes[stop] !== 0) {
					stop++;
				}
				return new TextDecoder().decode(bytes.subarray(start + offset, stop));
			};
			cookies.push({
				host: read(16),
				name: read(20),
				path: read(24) || '/',
				value: read(28),
				secure: (flags & 1) !== 0,
				httpOnly: (flags & 4) !== 0,
				expires: macTimeToUnix(view.getFloat64(start + 40, true)),
				sameSite: 'unspecified',
			});
		}
	}
	return cookies;
}

/** Only the in-app browser's own sessions take imported cookies, never the workbench's. */
export function isPreviewPartition(partition: string): boolean {
	return /^persist:volt-browser(?:-[A-Za-z0-9_-]{1,64})?$/.test(partition);
}
