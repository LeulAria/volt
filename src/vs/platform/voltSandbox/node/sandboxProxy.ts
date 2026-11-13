/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns';
import * as http from 'http';
import * as net from 'net';
import { splitAllowEntry } from '../common/sandboxSchema.js';

export const PROXY_BLOCK_MESSAGE = (host: string) => `Blocked by Volt sandbox: network access to ${host} is off for this chat. Ask the user to allow it.`;

/** A tunnel with no traffic either way for this long is closed (I.4 limits). */
export const PROXY_TUNNEL_IDLE_MS = 120_000;
/** A client must finish its request headers within this (I.4 limits; slowloris). */
export const PROXY_HEADER_TIMEOUT_MS = 15_000;

export interface IResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export type SandboxProxyLookup = (host: string) => Promise<readonly IResolvedAddress[]>;

export interface ISandboxProxyOptions {
	/** Name resolution; tests replace it. */
	readonly lookup?: SandboxProxyLookup;
	/** Opens the upstream connection to a checked address; tests replace it. */
	readonly connect?: (address: IResolvedAddress, port: number) => net.Socket;
	/**
	 * The run's route token: every request must carry `Proxy-Authorization: Basic volt:<token>`,
	 * else 407. Absent: no client authentication (tests of the address rules only).
	 */
	readonly token?: string;
	/** Tunnel idle timeout; tests shorten it. */
	readonly tunnelIdleMs?: number;
}

/** Why the proxy refused a destination, for the 403 and the transcript. */
export type ProxyRefusal = 'not-allowed' | 'private-address' | 'unresolvable' | 'bad-request' | 'auth';

/**
 * Volt's filtering HTTP/HTTPS proxy for one sandboxed run. The OS sandbox lets the workload reach
 * this proxy and nothing else; the proxy lets through only allowed hosts, and only to public
 * addresses:
 * - it resolves names itself and connects to the address it checked (no second lookup, so DNS
 *   rebinding cannot swap in `127.0.0.1` between check and connect);
 * - loopback, private, link-local (cloud metadata), CGNAT, multicast, reserved and unique-local
 *   addresses are refused, including IPv4-mapped and NAT64 forms, whatever the allow list says;
 * - an entry without a port allows ports 80 and 443 only;
 * - with a token, only the run it was made for may use it (`Proxy-Authorization`, else 407);
 * - "Allow host" applies to the running process's next connection (`allow`), no restart.
 * It does not inspect TLS: a client can still front a request through an allowed CDN.
 */
export class SandboxNetworkProxy {

	private readonly sockets = new Set<net.Socket>();
	private allowed: string[];
	private readonly expectedAuth: Buffer | undefined;

	private constructor(
		private readonly server: http.Server,
		allowed: readonly string[],
		private readonly onBlocked: (host: string, reason: ProxyRefusal) => void,
		private readonly options: ISandboxProxyOptions,
	) {
		this.allowed = [...allowed];
		this.expectedAuth = options.token ? Buffer.from(`Basic ${Buffer.from(`volt:${options.token}`).toString('base64')}`) : undefined;
	}

	static async start(allowed: readonly string[], onBlocked: (host: string, reason: ProxyRefusal) => void, options: ISandboxProxyOptions = {}): Promise<SandboxNetworkProxy> {
		const server = http.createServer({ maxHeaderSize: 16 * 1024 });
		const proxy = new SandboxNetworkProxy(server, allowed, onBlocked, options);
		server.on('connect', (req, socket, head) => void proxy.tunnel(req, socket as net.Socket, head));
		server.on('request', (req, res) => void proxy.forward(req, res));
		server.on('connection', socket => {
			proxy.sockets.add(socket);
			socket.on('close', () => proxy.sockets.delete(socket));
		});
		server.headersTimeout = PROXY_HEADER_TIMEOUT_MS;
		server.requestTimeout = PROXY_HEADER_TIMEOUT_MS * 4;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
		return proxy;
	}

	get port(): number {
		const address = this.server.address();
		return typeof address === 'object' && address ? address.port : 0;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** The run's route token (see `ISandboxProxyOptions.token`). */
	get token(): string | undefined {
		return this.options.token;
	}

	/** Live: the running process's next connection to these hosts goes through (F.9). */
	allow(entries: readonly string[]): void {
		this.allowed = [...new Set([...this.allowed, ...entries.map(entry => entry.trim().toLowerCase()).filter(Boolean)])];
	}

	/** Whether the request carries this run's token. Constant time; a missing token is a mismatch. */
	private authorized(req: http.IncomingMessage): boolean {
		if (!this.expectedAuth) {
			return true;
		}
		const given = Buffer.from(String(req.headers['proxy-authorization'] ?? ''));
		return given.length === this.expectedAuth.length && timingSafeEqual(given, this.expectedAuth);
	}

	/** Whether `host:port` is on the allow list (before resolution). */
	isAllowed(host: string, port: number): boolean {
		return proxyAllowListMatches(normalizeHost(host), port, this.allowed);
	}

	/** The address to connect to, or why not. */
	async destination(host: string, port: number): Promise<IResolvedAddress | ProxyRefusal> {
		const name = normalizeHost(host);
		if (!name || !Number.isInteger(port) || port < 1 || port > 65535) {
			return 'bad-request';
		}
		if (!proxyAllowListMatches(name, port, this.allowed)) {
			return 'not-allowed';
		}
		let addresses: readonly IResolvedAddress[];
		if (net.isIP(name)) {
			addresses = [{ address: name, family: net.isIP(name) as 4 | 6 }];
		} else {
			try {
				addresses = await (this.options.lookup ?? defaultLookup)(name);
			} catch {
				return 'unresolvable';
			}
		}
		if (!addresses.length) {
			return 'unresolvable';
		}
		// Every address must be public: a name that also resolves privately is a rebinding attempt.
		if (addresses.some(a => !isPublicAddress(a.address))) {
			return 'private-address';
		}
		return addresses[0];
	}

	private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
		client.on('error', () => undefined);
		if (!this.authorized(req)) {
			this.block(req.url ?? '', 'auth');
			client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="volt-sandbox"\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${refusalText(req.url ?? '', 'auth')}\r\n`);
			return;
		}
		const { host, port } = splitHostPort(req.url ?? '', 443);
		const target = await this.destination(host, port);
		if (typeof target === 'string') {
			this.block(host || (req.url ?? ''), target);
			client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${refusalText(host, target)}\r\n`);
			return;
		}
		const upstream = this.open(target, port);
		upstream.once('connect', () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) {
				upstream.write(head);
			}
			upstream.pipe(client);
			client.pipe(upstream);
		});
		// A tunnel nobody uses is closed: slow or abandoned tunnels must not pile up.
		const idle = this.options.tunnelIdleMs ?? PROXY_TUNNEL_IDLE_MS;
		for (const socket of [client, upstream]) {
			socket.setTimeout(idle, () => {
				client.destroy();
				upstream.destroy();
			});
		}
		client.on('close', () => upstream.destroy());
		this.sockets.add(upstream);
		upstream.on('close', () => this.sockets.delete(upstream));
		upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
	}

	private open(target: IResolvedAddress, port: number): net.Socket {
		return this.options.connect ? this.options.connect(target, port) : net.connect({ host: target.address, port, family: target.family });
	}

	private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!this.authorized(req)) {
			this.block(req.url ?? '', 'auth');
			res.writeHead(407, { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic realm="volt-sandbox"' }).end(`${refusalText(req.url ?? '', 'auth')}\n`);
			return;
		}
		let url: URL;
		try {
			url = new URL(req.url ?? '');
		} catch {
			res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Volt sandbox proxy: absolute URL expected\n');
			return;
		}
		if (url.protocol !== 'http:') {
			this.block(url.hostname, 'bad-request');
			res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`${refusalText(url.hostname, 'bad-request')}\n`);
			return;
		}
		const port = url.port ? Number(url.port) : 80;
		const target = await this.destination(url.hostname, port);
		if (typeof target === 'string') {
			this.block(url.hostname, target);
			res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`${refusalText(url.hostname, target)}\n`);
			return;
		}
		const headers = { ...req.headers };
		delete headers['proxy-authorization'];
		delete headers['proxy-connection'];
		const upstream = http.request({
			host: target.address,
			family: target.family,
			port,
			method: req.method,
			path: `${url.pathname}${url.search}`,
			headers: { ...headers, host: url.host },
			...(this.options.connect ? { createConnection: () => this.open(target, port) } : {}),
		}, reply => {
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
		});
		upstream.setTimeout(this.options.tunnelIdleMs ?? PROXY_TUNNEL_IDLE_MS, () => upstream.destroy(new Error('idle')));
		upstream.on('error', () => {
			if (!res.headersSent) {
				res.writeHead(502).end();
			} else {
				res.destroy();
			}
		});
		req.pipe(upstream);
	}

	private block(host: string, reason: ProxyRefusal): void {
		try {
			this.onBlocked(host, reason);
		} catch {
			// The listener is the transcript; a failure there must not break the request.
		}
	}

	dispose(): void {
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
		this.server.close();
	}
}

function refusalText(host: string, reason: ProxyRefusal): string {
	switch (reason) {
		case 'private-address': return `Blocked by Volt sandbox: ${host} resolves to a local or private address.`;
		case 'unresolvable': return `Volt sandbox proxy could not resolve ${host}.`;
		case 'bad-request': return `Blocked by Volt sandbox: unsupported request for ${host}.`;
		case 'auth': return 'Volt sandbox proxy: this proxy serves only the sandboxed run it was started for.';
		default: return PROXY_BLOCK_MESSAGE(host);
	}
}

function defaultLookup(host: string): Promise<IResolvedAddress[]> {
	return new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
		if (err) {
			reject(err);
		} else {
			resolve(addresses.map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
		}
	}));
}

/** Lower case, no trailing dot, no IPv6 brackets. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** The allow-list check: `*`, exact names, `*.example.com` (also matching `example.com`), optional `:port`. */
export function proxyAllowListMatches(host: string, port: number, allowed: readonly string[]): boolean {
	if (!host) {
		return false;
	}
	return allowed.some(raw => {
		const entry = raw.trim().toLowerCase();
		if (entry === '*') {
			return port === 80 || port === 443;
		}
		const { host: pattern, port: entryPort } = splitAllowEntry(entry);
		if (entryPort !== undefined ? entryPort !== port : port !== 80 && port !== 443) {
			return false;
		}
		if (pattern.startsWith('*.')) {
			const base = pattern.slice(2);
			return host === base || host.endsWith(`.${base}`);
		}
		return host === pattern;
	});
}

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
	['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
	['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
	BLOCKED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
	['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
	BLOCKED.addSubnet(address, prefix, 'ipv6');
}

/** True only for globally routable unicast addresses. IPv4 inside IPv6 (mapped, NAT64, 6to4) is judged as IPv4. */
export function isPublicAddress(address: string): boolean {
	const kind = net.isIP(address);
	if (kind === 4) {
		return !BLOCKED.check(address, 'ipv4');
	}
	if (kind !== 6) {
		return false;
	}
	const lower = address.toLowerCase();
	const embedded = embeddedIPv4(lower);
	if (embedded !== undefined) {
		return embedded !== null && isPublicAddress(embedded);
	}
	return !BLOCKED.check(lower, 'ipv6');
}

/**
 * The IPv4 address inside `::ffff:a.b.c.d`, `::a.b.c.d`, `64:ff9b::/96`, `64:ff9b:1::/48` or
 * `2002::/16`; null if malformed or if the forms disagree; undefined if none.
 */
function embeddedIPv4(v6: string): string | null | undefined {
	const dotted = /^(?:::ffff:|::ffff:0:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
	if (dotted) {
		return net.isIP(dotted[1]) === 4 ? dotted[1] : null;
	}
	const groups = expandIPv6(v6);
	if (!groups) {
		return null;
	}
	const fromHex = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
		return fromHex(groups[6], groups[7]);
	}
	// SIIT (RFC 2765): `::ffff:0:a.b.c.d`.
	if (groups.slice(0, 4).every(g => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
		return fromHex(groups[6], groups[7]);
	}
	if (groups.slice(0, 6).every(g => g === 0) && (groups[6] !== 0 || groups[7] > 1)) {
		return fromHex(groups[6], groups[7]);
	}
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
		return fromHex(groups[6], groups[7]);
	}
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0x0001) {
		// RFC 8215's local-use NAT64 prefix. A network may put the IPv4 address at any RFC 6052
		// position inside it (/48, /56, /64, /96): it is public only if every reading is.
		const bytes = groups.flatMap(g => [g >> 8, g & 0xff]);
		const readings = [[6, 7, 9, 10], [7, 9, 10, 11], [9, 10, 11, 12], [12, 13, 14, 15]].map(at => at.map(i => bytes[i]).join('.'));
		return readings.every(isPublicAddress) ? readings[readings.length - 1] : null;
	}
	if (groups[0] === 0x2002) {
		return fromHex(groups[1], groups[2]);
	}
	return undefined;
}

function expandIPv6(v6: string): number[] | undefined {
	if (v6.includes('.')) {
		return undefined;
	}
	const [head, tail] = v6.split('::');
	const parts = (s: string | undefined) => s ? s.split(':').map(g => parseInt(g, 16)) : [];
	const left = parts(head);
	const right = parts(tail);
	if (v6.includes('::')) {
		const fill = 8 - left.length - right.length;
		return fill < 0 ? undefined : [...left, ...new Array(fill).fill(0), ...right];
	}
	return left.length === 8 ? left : undefined;
}

/** `host:port`, `[::1]:443` or a bare host. */
export function splitHostPort(value: string, defaultPort: number): { host: string; port: number } {
	const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
	if (v6) {
		return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
	}
	const colon = value.lastIndexOf(':');
	if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
		return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
	}
	return { host: value, port: defaultPort };
}
