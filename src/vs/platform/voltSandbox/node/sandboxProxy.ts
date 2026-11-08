/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lookup as dnsLookup } from 'dns';
import * as http from 'http';
import * as net from 'net';
import { splitAllowEntry } from '../common/sandboxSchema.js';

export const PROXY_BLOCK_MESSAGE = (host: string) => `Blocked by Volt sandbox: network access to ${host} is off for this chat. Ask the user to allow it.`;

export interface IResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export type SandboxProxyLookup = (host: string) => Promise<readonly IResolvedAddress[]>;

export interface ISandboxProxyOptions {
	/** Name resolution; tests replace it. */
	readonly lookup?: SandboxProxyLookup;
}

/** Why the proxy refused a destination, for the 403 and the transcript. */
export type ProxyRefusal = 'not-allowed' | 'private-address' | 'unresolvable' | 'bad-request';

/**
 * Volt's filtering HTTP/HTTPS proxy for one sandboxed run. The OS sandbox lets the workload reach
 * this proxy and nothing else; the proxy lets through only allowed hosts, and only to public
 * addresses:
 * - it resolves names itself and connects to the address it checked (no second lookup, so DNS
 *   rebinding cannot swap in `127.0.0.1` between check and connect);
 * - loopback, private, link-local (cloud metadata), CGNAT, multicast, reserved and unique-local
 *   addresses are refused, including IPv4-mapped and NAT64 forms, whatever the allow list says;
 * - an entry without a port allows ports 80 and 443 only.
 * It does not inspect TLS: a client can still front a request through an allowed CDN.
 */
export class SandboxNetworkProxy {

	private readonly sockets = new Set<net.Socket>();
	private allowed: string[];

	private constructor(
		private readonly server: http.Server,
		allowed: readonly string[],
		private readonly onBlocked: (host: string, reason: ProxyRefusal) => void,
		private readonly lookup: SandboxProxyLookup,
	) {
		this.allowed = [...allowed];
	}

	static async start(allowed: readonly string[], onBlocked: (host: string, reason: ProxyRefusal) => void, options: ISandboxProxyOptions = {}): Promise<SandboxNetworkProxy> {
		const server = http.createServer({ maxHeaderSize: 16 * 1024 });
		const proxy = new SandboxNetworkProxy(server, allowed, onBlocked, options.lookup ?? defaultLookup);
		server.on('connect', (req, socket, head) => void proxy.tunnel(req, socket as net.Socket, head));
		server.on('request', (req, res) => void proxy.forward(req, res));
		server.on('connection', socket => {
			proxy.sockets.add(socket);
			socket.on('close', () => proxy.sockets.delete(socket));
		});
		server.headersTimeout = 15_000;
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

	allow(entries: readonly string[]): void {
		this.allowed = [...new Set([...this.allowed, ...entries.map(entry => entry.trim().toLowerCase()).filter(Boolean)])];
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
				addresses = await this.lookup(name);
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
		const { host, port } = splitHostPort(req.url ?? '', 443);
		const target = await this.destination(host, port);
		if (typeof target === 'string') {
			this.block(host || (req.url ?? ''), target);
			client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${refusalText(host, target)}\r\n`);
			return;
		}
		const upstream = net.connect({ host: target.address, port, family: target.family }, () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) {
				upstream.write(head);
			}
			upstream.pipe(client);
			client.pipe(upstream);
		});
		this.sockets.add(upstream);
		upstream.on('close', () => this.sockets.delete(upstream));
		upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
	}

	private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
		}, reply => {
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
		});
		upstream.on('error', () => {
			if (!res.headersSent) {
				res.writeHead(502).end();
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

/** The IPv4 address inside `::ffff:a.b.c.d`, `::a.b.c.d`, `64:ff9b::/96` or `2002::/16`; null if malformed; undefined if none. */
function embeddedIPv4(v6: string): string | null | undefined {
	const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
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
	if (groups.slice(0, 6).every(g => g === 0) && (groups[6] !== 0 || groups[7] > 1)) {
		return fromHex(groups[6], groups[7]);
	}
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
		return fromHex(groups[6], groups[7]);
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
