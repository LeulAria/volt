/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { httpCookieDomains, httpCookieHeader, IHttpCookie, liveHttpCookies, normalizeHttpCookieDomain, parseHttpCookieText, reviveHttpCookies, setHttpCookie, storeHttpCookies } from '../common/httpCookies.js';

export const IVoltHttpCookies = createDecorator<IVoltHttpCookies>('voltHttpCookies');

const COOKIES_KEY = 'volt.http.cookies';
/** Sandboxed chats' jars are kept for the session only, and only the latest few. */
const MAX_CONFINED_JARS = 24;
const CONFINED_PREFIX = 'confined:';

/** The jar of a project's client: its folder, or '' for the window's own. */
export function httpCookieJarKey(root: URI | undefined): string {
	return root?.toString() ?? '';
}

/** The jar of a sandboxed chat's sends (`IHttpConfinement.key`): its own, never the user's, and not stored. */
export function httpConfinedCookieJarKey(key: string): string {
	return `${CONFINED_PREFIX}${key}`;
}

/**
 * The HTTP client's cookie jars: one per project folder ('' for the window's), stored with the
 * workspace like the client's history. Every send stores what its responses set and gets the
 * matching cookies back; the Cookies dialog lists and edits them.
 */
export interface IVoltHttpCookies {
	readonly _serviceBrand: undefined;
	/** Fires with the jar's key. */
	readonly onDidChange: Event<string>;
	/** The jar's domains with how many cookies each holds. */
	domains(jar: string): readonly { readonly domain: string; readonly count: number }[];
	/** The jar's cookies, of one domain when given. */
	cookies(jar: string, domain?: string): readonly IHttpCookie[];
	/** Sets a cookie from its text (`name=value; Path=/; Expires=...`) for a domain. Returns it, or undefined when the text is not a cookie the domain may hold. */
	set(jar: string, domain: string, text: string): IHttpCookie | undefined;
	/** Removes one cookie (every path of the name when `path` is absent), or all of a domain's (no `name`). */
	remove(jar: string, domain: string, name?: string, path?: string): void;
	clear(jar: string): void;
	/** The `Cookie` header for a request to `url`: the jar's cookies after those the user wrote (`own`). */
	header(jar: string, url: string, own?: string): string | undefined;
	/** Stores what a response from `url` set. */
	store(jar: string, url: string, setCookieLines: readonly string[]): void;
	/** The domains whose cookies scripts may read and write. */
	allowlist(jar: string): readonly string[];
	setAllowlist(jar: string, domains: readonly string[]): void;
}

interface IStoredCookies {
	readonly jars?: Record<string, unknown>;
	readonly allow?: Record<string, unknown>;
}

/** The jars themselves (a test makes one over its own storage). */
export class HttpCookieJars extends Disposable implements IVoltHttpCookies {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly jars = new Map<string, IHttpCookie[]>();
	private readonly allow = new Map<string, string[]>();

	constructor(private readonly storage: IStorageService, private readonly now: () => number = Date.now) {
		super();
		try {
			const stored = JSON.parse(storage.get(COOKIES_KEY, StorageScope.WORKSPACE) ?? '{}') as IStoredCookies | null;
			for (const [key, value] of Object.entries(stored?.jars ?? {})) {
				const cookies = liveHttpCookies(reviveHttpCookies(value), this.now());
				if (cookies.length) {
					this.jars.set(key, cookies);
				}
			}
			for (const [key, value] of Object.entries(stored?.allow ?? {})) {
				if (Array.isArray(value)) {
					this.allow.set(key, value.filter((item): item is string => typeof item === 'string'));
				}
			}
		} catch { /* a broken store starts empty */ }
	}

	private read(jar: string): IHttpCookie[] {
		return this.jars.get(jar) ?? [];
	}

	private write(jar: string, cookies: IHttpCookie[]): void {
		if (cookies.length) {
			// Set again so the jar is the newest: the oldest sandboxed chat's is the one dropped.
			this.jars.delete(jar);
			this.jars.set(jar, cookies);
		} else {
			this.jars.delete(jar);
		}
		const confined = [...this.jars.keys()].filter(key => key.startsWith(CONFINED_PREFIX));
		for (const key of confined.slice(0, Math.max(0, confined.length - MAX_CONFINED_JARS))) {
			this.jars.delete(key);
		}
		this.persist();
		this._onDidChange.fire(jar);
	}

	private persist(): void {
		const stored: IStoredCookies = {
			jars: Object.fromEntries([...this.jars].filter(([key]) => !key.startsWith(CONFINED_PREFIX))),
			allow: Object.fromEntries([...this.allow].filter(([, domains]) => domains.length)),
		};
		this.storage.store(COOKIES_KEY, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	domains(jar: string): readonly { readonly domain: string; readonly count: number }[] {
		return httpCookieDomains(liveHttpCookies(this.read(jar), this.now()));
	}

	cookies(jar: string, domain?: string): readonly IHttpCookie[] {
		const host = domain !== undefined ? normalizeHttpCookieDomain(domain) : undefined;
		return liveHttpCookies(this.read(jar), this.now()).filter(cookie => host === undefined || cookie.domain === host).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	}

	set(jar: string, domain: string, text: string): IHttpCookie | undefined {
		const now = this.now();
		const cookie = parseHttpCookieText(text, domain, now);
		if (!cookie) {
			return undefined;
		}
		this.write(jar, setHttpCookie(this.read(jar), cookie, now));
		return cookie;
	}

	remove(jar: string, domain: string, name?: string, path?: string): void {
		const host = normalizeHttpCookieDomain(domain);
		const before = this.read(jar);
		const next = before.filter(cookie => cookie.domain !== host || (name !== undefined && (cookie.name !== name || (path !== undefined && cookie.path !== path))));
		if (next.length !== before.length) {
			this.write(jar, next);
		}
	}

	clear(jar: string): void {
		if (this.read(jar).length) {
			this.write(jar, []);
		}
	}

	header(jar: string, url: string, own?: string): string | undefined {
		return httpCookieHeader(this.read(jar), url, this.now(), own);
	}

	store(jar: string, url: string, setCookieLines: readonly string[]): void {
		if (!setCookieLines.length) {
			return;
		}
		const before = this.read(jar);
		const next = storeHttpCookies(before, setCookieLines, url, this.now());
		if (JSON.stringify(next) !== JSON.stringify(before)) {
			this.write(jar, next);
		}
	}

	allowlist(jar: string): readonly string[] {
		return this.allow.get(jar) ?? [];
	}

	setAllowlist(jar: string, domains: readonly string[]): void {
		const next = [...new Set(domains.map(normalizeHttpCookieDomain).filter(Boolean))].sort();
		if (next.length) {
			this.allow.set(jar, next);
		} else {
			this.allow.delete(jar);
		}
		this.persist();
		this._onDidChange.fire(jar);
	}
}

class VoltHttpCookies extends HttpCookieJars {
	constructor(@IStorageService storage: IStorageService) {
		super(storage);
	}
}

registerSingleton(IVoltHttpCookies, VoltHttpCookies, InstantiationType.Delayed);
