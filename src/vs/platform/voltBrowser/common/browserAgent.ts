/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What agents ask of the in-app browser beyond driving the page: fake network responses, emulated
 * conditions, and throwaway playground pages served over loopback HTTP. Pure parsing and matching
 * live here so both processes (and tests) share them.
 */

/** A fake response for requests whose URL matches `url` (substring, or a glob with `*`). */
export interface IVoltMockRoute {
	readonly url: string;
	/** Only this HTTP method (any when unset). */
	readonly method?: string;
	readonly status: number;
	readonly body: string;
	readonly contentType: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly delayMs: number;
	/** Fail the request at the network level (connection error) instead of answering. */
	readonly abort: boolean;
	/** Answer this many times, then let requests through. Unset: every time. */
	readonly times?: number;
}

export interface IVoltMockHit {
	readonly url: string;
	readonly method: string;
	/** Index into the route list, or -1 when it went through to the network. */
	readonly route: number;
	readonly status?: number;
}

export type VoltNetworkPreset = 'none' | 'offline' | 'slow-3g' | 'fast-3g' | 'slow-4g';

export interface IVoltEmulation {
	readonly colorScheme?: 'light' | 'dark' | 'system';
	readonly reducedMotion?: boolean;
	readonly network?: VoltNetworkPreset;
	/** CPU slowdown factor, 1 = none. */
	readonly cpuSlowdown?: number;
	/** IANA zone, e.g. "Asia/Tokyo"; '' resets. */
	readonly timezone?: string;
	/** BCP 47 locale, e.g. "de-DE"; '' resets. */
	readonly locale?: string;
}

/** Download/upload throughput (bytes/s) and latency (ms) per preset, the values Chrome DevTools uses. */
export const NETWORK_PRESETS: Readonly<Record<Exclude<VoltNetworkPreset, 'none'>, { offline: boolean; latency: number; download: number; upload: number }>> = {
	'offline': { offline: true, latency: 0, download: 0, upload: 0 },
	'slow-3g': { offline: false, latency: 2000, download: 50 * 1024, upload: 50 * 1024 },
	'fast-3g': { offline: false, latency: 563, download: 180 * 1024, upload: 84 * 1024 },
	'slow-4g': { offline: false, latency: 150, download: 1.6 * 1024 * 1024 / 8, upload: 750 * 1024 / 8 },
};

export interface IVoltPlaygroundMock {
	/** Path on the playground's own origin, e.g. "/api/stats" (query ignored). */
	readonly path: string;
	readonly method?: string;
	readonly status: number;
	readonly body: string;
	readonly contentType: string;
	readonly delayMs: number;
}

export interface IVoltPlaygroundRequest {
	readonly sessionId: string;
	readonly title?: string;
	/** Relative path → file content. */
	readonly files: Readonly<Record<string, string>>;
	readonly mocks?: readonly IVoltPlaygroundMock[];
}

export interface IVoltPlaygroundUpdate {
	readonly id: string;
	readonly files?: Readonly<Record<string, string>>;
	readonly remove?: readonly string[];
	readonly mocks?: readonly IVoltPlaygroundMock[];
}

export interface IVoltPlayground {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly url: string;
	/** Folder holding its files (outside every workspace). */
	readonly dir: string;
	readonly files: readonly string[];
	readonly mocks: number;
	readonly createdAt: number;
	/** Requests served so far (files and mocks). */
	readonly requests: number;
}

/** A process listening on a TCP port of this machine, for "which dev servers are running". */
export interface IVoltLocalServer {
	readonly port: number;
	readonly pid: number;
	readonly command: string;
	readonly cwd?: string;
	/** `127.0.0.1`, `*`, `::1`… */
	readonly address: string;
}

/** A dev server Volt started for an agent (the project's own start command), with its recent output. */
export interface IVoltDevServer {
	readonly pid: number;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: number;
	/** The port it listens on, once known. */
	readonly port?: number;
	/** Set once the process ended. */
	readonly exitCode?: number | null;
	/** The end of what it printed (stdout and stderr). */
	readonly log: string;
}

/** The port a server announced ("http://localhost:5173", "listening on port 4400"), the latest one. */
export function portFromLog(text: string): number | undefined {
	const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
	const urls = [...clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local):(\d{2,5})/gi)];
	const said = urls.length ? urls : [...clean.matchAll(/\b(?:port|listening on|running on|started on|serving on)\D{0,24}?(\d{4,5})\b/gi)];
	const port = said.length ? Number(said[said.length - 1][1]) : undefined;
	return port && port >= 1024 && port <= 65535 ? port : undefined;
}

const MAX_FILES = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bodyOf(item: Record<string, unknown>): { body: string; contentType: string } {
	if (item.json !== undefined) {
		return { body: typeof item.json === 'string' ? item.json : JSON.stringify(item.json), contentType: str(item.content_type) ?? 'application/json' };
	}
	const body = typeof item.body === 'string' ? item.body : item.body === undefined ? '' : JSON.stringify(item.body);
	const looksJson = /^\s*[[{]/.test(body);
	return { body, contentType: str(item.content_type) ?? (looksJson ? 'application/json' : 'text/plain; charset=utf-8') };
}

function clampDelay(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(30000, Math.round(value))) : 0;
}

function statusOf(value: unknown, fallback: number): number {
	return typeof value === 'number' && value >= 100 && value <= 599 ? Math.round(value) : fallback;
}

/** Agent input → mock routes; invalid items are reported, not silently dropped. */
export function parseMockRoutes(input: unknown): { routes: IVoltMockRoute[]; errors: string[] } {
	const routes: IVoltMockRoute[] = [];
	const errors: string[] = [];
	const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : [];
	list.slice(0, 50).forEach((raw, index) => {
		const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		const url = str(item.url) ?? str(item.path) ?? str(item.pattern);
		if (!url) {
			errors.push(`route ${index + 1}: needs a \`url\` (substring or glob such as "*/api/stats*")`);
			return;
		}
		const { body, contentType } = bodyOf(item);
		const headers: Record<string, string> = {};
		if (item.headers && typeof item.headers === 'object') {
			for (const [key, value] of Object.entries(item.headers as Record<string, unknown>)) {
				if (typeof value === 'string' || typeof value === 'number') {
					headers[key] = String(value);
				}
			}
		}
		routes.push({
			url,
			method: str(item.method)?.toUpperCase(),
			status: statusOf(item.status, 200),
			body,
			contentType,
			headers,
			delayMs: clampDelay(item.delay_ms ?? item.delayMs),
			abort: item.abort === true || item.fail === true,
			times: typeof item.times === 'number' && item.times > 0 ? Math.round(item.times) : undefined,
		});
	});
	return { routes, errors };
}

/**
 * `*` matches any run of characters and the glob covers the whole URL; a glob without a scheme
 * may match anywhere after it ("/api/*" matches "http://host/api/x"). Without `*` the pattern is a
 * substring.
 */
export function urlPatternMatches(pattern: string, url: string): boolean {
	if (!pattern.includes('*')) {
		return url.includes(pattern);
	}
	const anchored = pattern.includes('://') || pattern.startsWith('*') ? pattern : `*${pattern}`;
	const source = anchored.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${source}$`).test(url);
}

/** The first route that answers `method url`, honouring `times` against how often each route answered. */
export function matchMockRoute(routes: readonly IVoltMockRoute[], url: string, method: string, used: readonly number[] = []): number {
	for (let i = 0; i < routes.length; i++) {
		const route = routes[i];
		if (route.method && route.method !== method.toUpperCase()) {
			continue;
		}
		if (route.times !== undefined && (used[i] ?? 0) >= route.times) {
			continue;
		}
		if (urlPatternMatches(route.url, url)) {
			return i;
		}
	}
	return -1;
}

export function describeMockRoute(route: IVoltMockRoute): string {
	const what = route.abort ? 'network error' : `${route.status}${route.body ? ` ${route.contentType.split(';')[0]} (${route.body.length} B)` : ''}`;
	return `${route.method ?? 'ANY'} ${route.url} → ${what}${route.delayMs ? ` after ${route.delayMs} ms` : ''}${route.times ? `, ${route.times}×` : ''}`;
}

export function parseEmulation(input: Record<string, unknown>): { emulation: IVoltEmulation; errors: string[] } {
	const errors: string[] = [];
	const out: { -readonly [K in keyof IVoltEmulation]: IVoltEmulation[K] } = {};
	const scheme = str(input.color_scheme ?? input.colorScheme);
	if (scheme) {
		if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
			out.colorScheme = scheme;
		} else {
			errors.push('color_scheme must be light, dark or system');
		}
	}
	const motion = input.reduced_motion ?? input.reducedMotion;
	if (typeof motion === 'boolean') {
		out.reducedMotion = motion;
	}
	const network = str(input.network);
	if (network) {
		if (network === 'none' || network in NETWORK_PRESETS) {
			out.network = network as VoltNetworkPreset;
		} else {
			errors.push('network must be none, offline, slow-3g, fast-3g or slow-4g');
		}
	}
	const cpu = input.cpu_slowdown ?? input.cpuSlowdown;
	if (typeof cpu === 'number' && Number.isFinite(cpu)) {
		out.cpuSlowdown = Math.max(1, Math.min(20, cpu));
	}
	if (typeof input.timezone === 'string') {
		out.timezone = input.timezone.trim();
	}
	if (typeof input.locale === 'string') {
		out.locale = input.locale.trim();
	}
	return { emulation: out, errors };
}

/** `a/b.css` stays; `../x`, absolute paths, and `.git` parts are refused. */
export function safePlaygroundPath(path: string): string | undefined {
	const clean = path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
	if (!clean || clean.length > 200) {
		return undefined;
	}
	const parts = clean.split('/');
	if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.git') || /[\0:]/.test(part))) {
		return undefined;
	}
	return parts.join('/');
}

export function parsePlaygroundFiles(input: unknown, html?: unknown): { files: Record<string, string>; errors: string[] } {
	const files: Record<string, string> = {};
	const errors: string[] = [];
	if (typeof html === 'string' && html.trim()) {
		files['index.html'] = html;
	}
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		for (const [path, content] of Object.entries(input as Record<string, unknown>).slice(0, MAX_FILES)) {
			const safe = safePlaygroundPath(path);
			if (!safe) {
				errors.push(`${path}: use a relative path inside the playground`);
				continue;
			}
			const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
			if (text.length > MAX_FILE_BYTES) {
				errors.push(`${path}: larger than 2 MB`);
				continue;
			}
			files[safe] = text;
		}
	} else if (Array.isArray(input)) {
		for (const item of input.slice(0, MAX_FILES)) {
			const entry = item as Record<string, unknown> | undefined;
			const safe = typeof entry?.path === 'string' ? safePlaygroundPath(entry.path) : undefined;
			if (!safe || typeof entry?.content !== 'string') {
				errors.push('each file needs a relative `path` and string `content`');
				continue;
			}
			files[safe] = entry.content;
		}
	}
	return { files, errors };
}

export function parsePlaygroundMocks(input: unknown): { mocks: IVoltPlaygroundMock[]; errors: string[] } {
	const mocks: IVoltPlaygroundMock[] = [];
	const errors: string[] = [];
	const list = Array.isArray(input) ? input : [];
	list.slice(0, 50).forEach((raw, index) => {
		const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		const path = str(item.path) ?? str(item.url);
		if (!path || !path.startsWith('/')) {
			errors.push(`mock ${index + 1}: needs a \`path\` starting with "/", e.g. "/api/stats"`);
			return;
		}
		const { body, contentType } = bodyOf(item);
		mocks.push({ path: path.split('?')[0], method: str(item.method)?.toUpperCase(), status: statusOf(item.status, 200), body, contentType, delayMs: clampDelay(item.delay_ms ?? item.delayMs) });
	});
	return { mocks, errors };
}

export function matchPlaygroundMock(mocks: readonly IVoltPlaygroundMock[], path: string, method: string): IVoltPlaygroundMock | undefined {
	const clean = path.split('?')[0];
	return mocks.find(mock => (!mock.method || mock.method === method.toUpperCase()) && (mock.path === clean || (mock.path.endsWith('*') && clean.startsWith(mock.path.slice(0, -1)))));
}

export const PLAYGROUND_CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.wasm': 'application/wasm',
};
