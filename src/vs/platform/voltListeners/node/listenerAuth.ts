/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { isIP, type Socket } from 'net';
import { dirname } from '../../../base/common/path.js';

/**
 * The one way a Volt process opens a network listener (INV-07). Every request is authenticated
 * with a secret the caller can't get from the network, the environment or another process: a
 * bearer from a 0600 file or a per-launch secret, compared in constant time. Host, Origin, the
 * peer address and loopback never authenticate anything; they only narrow what a request with
 * the secret may do:
 * - the Host header must be on the listener's allow list (a DNS-rebound name is refused);
 * - a state-changing request on a browser route must carry an allowed Origin (a missing Origin is
 *   never taken for "same origin": curl and Node send none);
 * - failures are counted per source and a source over its limit is refused for a while.
 *
 * `build/volt/ci/listenerLint.mjs` fails CI for `http.createServer`, `net.createServer`,
 * `WebSocketServer` or `.listen(` outside this folder, apart from reviewed sites.
 */

//#region Secrets

/** A fresh secret for one launch: 256 bits, URL-safe. */
export function newListenerSecret(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

/**
 * The bearer kept in `file` (created 0600 when missing). A file other users could read is
 * narrowed to 0600 first; one that can't be is refused rather than trusted.
 */
export async function loadOrCreateSecretFile(file: string): Promise<string> {
	try {
		const stat = await fs.stat(file);
		if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
			await fs.chmod(file, 0o600);
		}
		const secret = (await fs.readFile(file, 'utf8')).trim();
		if (secret.length >= 32) {
			return secret;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
	const secret = newListenerSecret();
	await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	await fs.writeFile(tmp, secret, { mode: 0o600 });
	await fs.rename(tmp, file);
	return secret;
}

/**
 * Compares a presented secret with the expected one in constant time. Both sides are hashed
 * first, so neither the length nor the first differing byte shows in the timing.
 */
export function secretsEqual(presented: string | undefined, expected: string): boolean {
	if (typeof presented !== 'string' || !presented || !expected || presented.length > 4096) {
		return false;
	}
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/** The `Authorization: Bearer <token>` value, or undefined. */
export function bearerToken(req: http.IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (typeof header !== 'string' || !/^Bearer /i.test(header)) {
		return undefined;
	}
	const token = header.slice('Bearer '.length).trim();
	return token || undefined;
}

//#endregion

//#region Request facts (never authentication on their own)

export function isLoopbackAddress(address: string | undefined): boolean {
	return !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));
}

/** The peer's address, without the IPv4-mapped prefix: the key per-source limits count under. */
export function requestSource(req: http.IncomingMessage): string {
	const address = req.socket.remoteAddress ?? 'unknown';
	return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export function isStateChanging(method: string | undefined): boolean {
	return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/** The names a loopback listener answers to on `port`. */
export function loopbackHostNames(port: number): string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export interface IHostRule {
	/** Exact `host:port` (or bare `host`, any port) values, compared case-insensitively. */
	readonly names: readonly string[];
	/** Any IP literal is accepted (a rebound DNS name never is). For listeners on the network. */
	readonly anyIpLiteral?: boolean;
	/** Host suffixes accepted on any port (`.ts.net`). */
	readonly suffixes?: readonly string[];
}

/** Splits `Host` into its name (brackets kept off IPv6) and port. */
export function parseHostHeader(host: string | undefined): { readonly name: string; readonly port?: number } | undefined {
	if (typeof host !== 'string' || !host || host.length > 255 || /[\s/@\\]/.test(host)) {
		return undefined;
	}
	const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(host);
	if (v6) {
		return { name: v6[1].toLowerCase(), ...(v6[2] ? { port: Number(v6[2]) } : {}) };
	}
	const plain = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);
	if (!plain) {
		return undefined;
	}
	return { name: plain[1].toLowerCase(), ...(plain[2] ? { port: Number(plain[2]) } : {}) };
}

export function hostAllowed(host: string | undefined, rule: IHostRule): boolean {
	const parsed = parseHostHeader(host);
	if (!parsed) {
		return false;
	}
	const lower = host!.toLowerCase();
	if (rule.names.some(name => name.toLowerCase() === lower || name.toLowerCase() === parsed.name)) {
		return true;
	}
	if (rule.anyIpLiteral && isIP(parsed.name)) {
		return true;
	}
	return !!rule.suffixes?.some(suffix => parsed.name.endsWith(suffix.toLowerCase()) && parsed.name.length > suffix.length);
}

/** `http://host` or `https://host` as this request reached the listener. */
export function ownOrigin(req: http.IncomingMessage): string {
	const secure = !!(req.socket as Socket & { encrypted?: boolean }).encrypted;
	return `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`;
}

/**
 * Whether the request's Origin is one of `allowed` (or the listener's own origin when `allowed`
 * includes `'self'`). A request without an Origin is refused: only browsers send one, and a
 * route that relies on it must not be reachable without it.
 */
export function originAllowed(req: http.IncomingMessage, allowed: readonly string[]): boolean {
	const origin = req.headers.origin;
	if (typeof origin !== 'string' || !origin || origin === 'null') {
		return false;
	}
	return allowed.some(entry => entry === 'self' ? origin === ownOrigin(req) : entry === origin);
}

//#endregion

//#region Rate limits

export interface ISourceRateLimitOptions {
	/** Failures allowed per source within `windowMs` before the source is refused. */
	readonly limit: number;
	readonly windowMs: number;
	/** Sources remembered at most; the oldest is forgotten first (an address flood can't grow memory). */
	readonly maxSources?: number;
	readonly now?: () => number;
}

/**
 * Failures counted per source (an address, a pairing code). A source over its limit is refused
 * until its oldest failure leaves the window; other sources are unaffected, so one address on the
 * network can't lock everyone else out.
 */
export class SourceRateLimiter {

	private readonly failures = new Map<string, number[]>();
	private readonly now: () => number;

	constructor(private readonly options: ISourceRateLimitOptions) {
		this.now = options.now ?? Date.now;
	}

	/** Whether `source` is over its limit now. */
	blocked(source: string): boolean {
		return this.recent(source).length >= this.options.limit;
	}

	/** Milliseconds until `source` may try again (0 when it may now). */
	retryAfter(source: string): number {
		const recent = this.recent(source);
		if (recent.length < this.options.limit) {
			return 0;
		}
		return Math.max(0, recent[recent.length - this.options.limit] + this.options.windowMs - this.now());
	}

	/** Counts one failure; returns whether the source is now over its limit. */
	fail(source: string): boolean {
		const recent = this.recent(source);
		recent.push(this.now());
		this.failures.delete(source);
		this.failures.set(source, recent);
		const max = this.options.maxSources ?? 4096;
		while (this.failures.size > max) {
			const oldest = this.failures.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.failures.delete(oldest);
		}
		return recent.length >= this.options.limit;
	}

	reset(source: string): void {
		this.failures.delete(source);
	}

	private recent(source: string): number[] {
		const now = this.now();
		const kept = (this.failures.get(source) ?? []).filter(at => now - at < this.options.windowMs);
		if (kept.length) {
			this.failures.set(source, kept);
		} else {
			this.failures.delete(source);
		}
		return kept;
	}
}

//#endregion

//#region Authentication

export type ListenerDecision<T> =
	| { readonly ok: true; readonly principal: T; readonly via: ListenerCredential }
	| { readonly ok: false; readonly status: 401 | 403 | 429; readonly error: string; readonly retryAfterMs?: number };

/** Where the credential came from (a `query` secret is usually traded for a `cookie` one). */
export type ListenerCredential = 'bearer' | 'path' | 'query' | 'cookie';

export interface IListenerAuthOptions<T> {
	/** The Host allow list (a function when it changes, e.g. with tunnel addresses). */
	readonly hosts: IHostRule | (() => IHostRule);
	/** The principal a presented secret belongs to, or undefined. Must compare in constant time. */
	readonly verify: (secret: string, req: http.IncomingMessage) => T | undefined;
	/** Where the secret may come from besides `Authorization: Bearer`. */
	readonly extract?: (req: http.IncomingMessage) => { readonly secret: string; readonly via: ListenerCredential } | undefined;
	/**
	 * A browser route: WebSocket upgrades, and state-changing requests whose secret came from a
	 * cookie or the URL, must carry one of these Origins (`'self'` = the listener's own). Reads
	 * (GET, HEAD) need only the secret.
	 */
	readonly browserOrigins?: readonly string[];
	/** Failed authentications per source; defaults to 30 a minute. */
	readonly limiter?: SourceRateLimiter;
}

/** Applies a listener's rules to each request; see {@link IListenerAuthOptions}. */
export class ListenerAuth<T> {

	readonly limiter: SourceRateLimiter;

	constructor(private readonly options: IListenerAuthOptions<T>) {
		this.limiter = options.limiter ?? new SourceRateLimiter({ limit: 30, windowMs: 60_000 });
	}

	check(req: http.IncomingMessage, upgrade = false): ListenerDecision<T> {
		const hosts = typeof this.options.hosts === 'function' ? this.options.hosts() : this.options.hosts;
		if (!hostAllowed(req.headers.host, hosts)) {
			return { ok: false, status: 403, error: 'host_not_allowed' };
		}
		const source = requestSource(req);
		if (this.limiter.blocked(source)) {
			return { ok: false, status: 429, error: 'rate_limited', retryAfterMs: this.limiter.retryAfter(source) };
		}
		const bearer = bearerToken(req);
		const found = bearer ? { secret: bearer, via: 'bearer' as const } : this.options.extract?.(req);
		const principal = found ? this.options.verify(found.secret, req) : undefined;
		if (!found || principal === undefined) {
			this.limiter.fail(source);
			return { ok: false, status: 401, error: 'unauthorized' };
		}
		const browser = this.options.browserOrigins;
		// An Authorization header can't be put on another site's request without a CORS preflight,
		// so only secrets a browser sends by itself (cookie, URL) need the Origin besides.
		if (browser && (upgrade || (isStateChanging(req.method) && found.via !== 'bearer')) && !originAllowed(req, browser)) {
			return { ok: false, status: 403, error: 'origin_not_allowed' };
		}
		return { ok: true, principal, via: found.via };
	}

	/** Answers a refused request. */
	static reject(res: http.ServerResponse, decision: Extract<ListenerDecision<unknown>, { ok: false }>): void {
		const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
		if (decision.retryAfterMs) {
			headers['Retry-After'] = String(Math.ceil(decision.retryAfterMs / 1000));
		}
		res.writeHead(decision.status, headers).end(JSON.stringify({ error: decision.error }));
	}

	/** Refuses an upgrade on its raw socket. */
	static rejectUpgrade(socket: Socket, decision: Extract<ListenerDecision<unknown>, { ok: false }>): void {
		const reason = decision.status === 401 ? 'Unauthorized' : decision.status === 429 ? 'Too Many Requests' : 'Forbidden';
		socket.end(`HTTP/1.1 ${decision.status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	}
}

//#endregion

//#region Servers

export type ListenerRequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * An HTTP server whose routes do their own authentication with this library (the agent server's
 * pairing, sign-in and socket routes differ per path). Prefer {@link createAuthenticatedServer}.
 */
export function createListenerServer(handler: ListenerRequestHandler, options: http.ServerOptions = {}): http.Server {
	return http.createServer(options, handler);
}

/** The same over TLS with the listener's own key (see listenerTls.ts). */
export function createTlsListenerServer(tls: { readonly key: string; readonly cert: string }, handler: ListenerRequestHandler): https.Server {
	return https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, handler);
}

/**
 * An HTTP server that answers only requests `auth` accepts; refused ones never reach `handler`.
 * Upgrades go to `onUpgrade` once accepted (with the Origin rule applied).
 */
export function createAuthenticatedServer<T>(auth: ListenerAuth<T>, handler: (req: http.IncomingMessage, res: http.ServerResponse, principal: T, via: ListenerCredential) => void, onUpgrade?: (req: http.IncomingMessage, socket: Socket, head: Buffer, principal: T) => void): http.Server {
	const server = http.createServer((req, res) => {
		const decision = auth.check(req);
		if (!decision.ok) {
			ListenerAuth.reject(res, decision);
			return;
		}
		handler(req, res, decision.principal, decision.via);
	});
	server.on('upgrade', (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
		const decision = auth.check(req, true);
		if (!decision.ok) {
			ListenerAuth.rejectUpgrade(socket, decision);
			return;
		}
		if (!onUpgrade) {
			socket.destroy();
			return;
		}
		onUpgrade(req, socket, head, decision.principal);
	});
	return server;
}

/** A loopback port free right now (for a child that must be told its port up front). */
export function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => port ? resolve(port) : reject(new Error('No free loopback port')));
		});
	});
}

/** Listens on loopback (port 0 = any free one) and resolves the port. */
export function listenOn(server: http.Server | https.Server, port: number, host = '127.0.0.1'): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.removeListener('error', reject);
			const address = server.address();
			resolve(typeof address === 'object' && address ? address.port : 0);
		});
	});
}

/**
 * Listens on `preferred`, or on any free port when it is taken and `fallback` allows.
 */
export function listenPreferred(server: http.Server | https.Server, host: string, preferred: number, fallback: boolean): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			if (fallback && err.code === 'EADDRINUSE') {
				server.removeListener('error', onError);
				server.once('error', reject);
				server.listen(0, host, () => {
					const address = server.address();
					resolve(typeof address === 'object' && address ? address.port : 0);
				});
				return;
			}
			reject(err);
		};
		server.on('error', onError);
		server.listen(preferred, host, () => {
			server.removeListener('error', onError);
			const address = server.address();
			resolve(typeof address === 'object' && address ? address.port : 0);
		});
	});
}

//#endregion
