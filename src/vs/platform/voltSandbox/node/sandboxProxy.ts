/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as net from 'net';
import { domainAllowed } from '../common/sandboxPolicy.js';

export const PROXY_BLOCK_MESSAGE = (host: string) => `Blocked by Volt sandbox: network access to ${host} is off for this chat. Ask the user to allow it.`;

/**
 * Volt's filtering HTTP proxy for one sandboxed agent whose network is off. The OS sandbox lets
 * the agent reach loopback only; this lets the agent's own API (and hosts the user allowed)
 * through, and answers everything else with a 403 that names the host, so the agent and the
 * transcript both see why. srt and Gemini CLI route sandboxed traffic the same way.
 */
export class SandboxNetworkProxy {

	private readonly sockets = new Set<net.Socket>();
	private allowed: string[];

	private constructor(private readonly server: http.Server, allowed: readonly string[], private readonly onBlocked: (host: string) => void) {
		this.allowed = [...allowed];
	}

	static async start(allowed: readonly string[], onBlocked: (host: string) => void): Promise<SandboxNetworkProxy> {
		const server = http.createServer();
		const proxy = new SandboxNetworkProxy(server, allowed, onBlocked);
		server.on('connect', (req, socket, head) => proxy.tunnel(req, socket as net.Socket, head));
		server.on('request', (req, res) => proxy.forward(req, res));
		server.on('connection', socket => {
			proxy.sockets.add(socket);
			socket.on('close', () => proxy.sockets.delete(socket));
		});
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

	allow(domains: readonly string[]): void {
		this.allowed = [...new Set([...this.allowed, ...domains.map(domain => domain.trim().toLowerCase()).filter(Boolean)])];
	}

	isAllowed(host: string): boolean {
		return domainAllowed(host, this.allowed);
	}

	private tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
		const { host, port } = splitHostPort(req.url ?? '', 443);
		client.on('error', () => undefined);
		if (!host || !this.isAllowed(host)) {
			this.block(host || (req.url ?? ''));
			client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${PROXY_BLOCK_MESSAGE(host)}\r\n`);
			return;
		}
		const upstream = net.connect(port, host, () => {
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

	private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
		let target: URL;
		try {
			target = new URL(req.url ?? '');
		} catch {
			res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Volt sandbox proxy: absolute URL expected\n');
			return;
		}
		if (target.protocol !== 'http:' || !this.isAllowed(target.hostname)) {
			this.block(target.hostname);
			res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`${PROXY_BLOCK_MESSAGE(target.hostname)}\n`);
			return;
		}
		const upstream = http.request(target, { method: req.method, headers: req.headers }, reply => {
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

	private block(host: string): void {
		try {
			this.onBlocked(host);
		} catch {
			// The listener is the transcript; a failure there must not break the agent's request.
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
