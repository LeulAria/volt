/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { hostMcpInstructions, IVoltHostMcpCall, IVoltHostMcpEndpoint, IVoltHostMcpResult, IVoltHostMcpService, IVoltHostMcpToolInfo } from '../common/voltHostMcp.js';
import { formatHostMcpSessionToken, HOST_MCP_TOKEN_TTL_MS, hostMcpSessionMessage, IHostMcpLease, normalizeHostMcpGroups, parseHostMcpSessionToken } from '../common/voltHostMcpAuth.js';

interface IJsonRpc {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
}

interface IServer {
	readonly http: http.Server;
	readonly endpoint: Promise<IVoltHostMcpEndpoint>;
	readonly token: string;
	port: number;
	tools: readonly IVoltHostMcpToolInfo[];
	/** Per chat, the key epoch it was last revoked at. */
	readonly revoked: Map<string, number>;
}

/** A question can wait on the user for a long time; past this the call answers with an error. */
const CALL_TIMEOUT_MS = 30 * 60_000;
/** JSON-RPC requests are small; anything bigger is not an agent. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type HostMcpRequestVerdict =
	/** `sessionId` and `groups` are the ones the token was issued for; the URL alone never sets them. */
	| { readonly ok: true; readonly sessionId?: string; readonly groups?: ReadonlySet<string> }
	| { readonly ok: false; readonly status: 401 | 403 | 404; readonly message: string };

export interface IHostMcpCheckOptions {
	/** The time to judge expiry by (default: now). */
	readonly now?: number;
	/** The key epoch a chat was last revoked at: its tokens with that epoch or a lower one are refused. */
	readonly revokedThrough?: (sessionId: string) => number | undefined;
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
	if (!host) {
		return false;
	}
	const value = host.trim().toLowerCase();
	return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`;
}

function sameSecret(given: string, expected: string): boolean {
	const a = Buffer.from(given, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who may talk to a host MCP server: only local agent processes Volt launched.
 * - Host must be loopback with the server's port (DNS rebinding sends a foreign Host).
 * - No browser: a web page's request (including the in-app browser's own page) always carries
 *   Origin or Sec-Fetch-Site / Sec-Fetch-Dest. Node's fetch (undici), which agents such as
 *   cursor-agent use, sends Sec-Fetch-Mode alone on every request, so that one header is not a
 *   browser. No CORS headers are ever sent, so a preflight fails too.
 * - The bearer token Volt handed the agent in its MCP server config. On `/mcp/<sessionId>` that is
 *   the session's own token (`hostMcpSessionToken`), which also covers `?groups=`: another chat's
 *   token, or the right one with other groups, is refused, and so is one past its expiry or from
 *   before the chat was revoked. A request without a session needs `secret` itself, which only
 *   Volt holds.
 */
export function checkHostMcpRequest(method: string | undefined, path: string | undefined, headers: http.IncomingHttpHeaders, port: number, secret: string, options: IHostMcpCheckOptions = {}): HostMcpRequestVerdict {
	if (!isLoopbackHost(headers.host, port)) {
		return { ok: false, status: 403, message: 'Host not allowed' };
	}
	if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined || headers['sec-fetch-dest'] !== undefined) {
		return { ok: false, status: 403, message: 'Browser requests are not allowed' };
	}
	if (method === 'OPTIONS') {
		return { ok: false, status: 403, message: 'CORS is not supported' };
	}
	if (!/^\/mcp(?:[/?#]|$)/.test(path ?? '')) {
		return { ok: false, status: 404, message: 'Not found' };
	}
	const auth = headers.authorization;
	const match = typeof auth === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
	if (!match) {
		return { ok: false, status: 401, message: 'Missing or wrong bearer token' };
	}
	const session = sessionFromPath(path);
	if (session === null) {
		return { ok: false, status: 401, message: 'Missing or wrong bearer token' };
	}
	const groups = groupsFromPath(path);
	if (session === undefined) {
		return sameSecret(match[1], secret) ? { ok: true, ...(groups ? { groups } : {}) } : { ok: false, status: 401, message: 'Missing or wrong bearer token' };
	}
	const lease = parseHostMcpSessionToken(match[1]);
	if (!lease || !sameSecret(match[1], sessionToken(secret, session, groups, lease))) {
		return { ok: false, status: 401, message: 'Missing or wrong bearer token' };
	}
	// Signed by Volt, so the lease is the one it issued: judge its age and the chat's revocations.
	const now = options.now ?? Date.now();
	const revoked = options.revokedThrough?.(session);
	if (lease.expiry <= now || lease.expiry - lease.epoch > HOST_MCP_TOKEN_TTL_MS || (revoked !== undefined && lease.epoch <= revoked)) {
		return { ok: false, status: 401, message: 'Expired or revoked bearer token' };
	}
	return { ok: true, sessionId: session, ...(groups ? { groups } : {}) };
}

/** Node's HMAC of the same message `hostMcpSessionToken` signs in the window, as a token string. */
function sessionToken(secret: string, sessionId: string, groups: ReadonlySet<string> | undefined, lease: IHostMcpLease): string {
	return formatHostMcpSessionToken(lease, createHmac('sha256', secret).update(hostMcpSessionMessage(sessionId, groups, lease)).digest('hex'));
}

export class VoltHostMcpService extends Disposable implements IVoltHostMcpService {

	declare readonly _serviceBrand: undefined;

	private readonly servers = new Map<string, IServer>();
	private readonly pending = new Map<string, { resolve: (result: IVoltHostMcpResult) => void; serverId: string }>();
	private readonly _onDidCall = this._register(new Emitter<IVoltHostMcpCall>());
	readonly onDidCall: Event<IVoltHostMcpCall> = this._onDidCall.event;
	private readonly _onDidCancel = this._register(new Emitter<{ id: string; serverId: string }>());
	readonly onDidCancel: Event<{ id: string; serverId: string }> = this._onDidCancel.event;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			for (const server of this.servers.values()) {
				server.http.close();
			}
			this.servers.clear();
		}));
	}

	start(serverId: string, tools: readonly IVoltHostMcpToolInfo[]): Promise<IVoltHostMcpEndpoint> {
		const existing = this.servers.get(serverId);
		if (existing) {
			existing.tools = tools;
			return existing.endpoint;
		}
		// The server secret: only Volt holds it. Agents get per-session tokens derived from it.
		const token = randomBytes(32).toString('base64url');
		const server = http.createServer((req, res) => void this.handle(serverId, req, res));
		const endpoint = new Promise<IVoltHostMcpEndpoint>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('Volt host MCP has no port'));
					return;
				}
				const entry = this.servers.get(serverId);
				if (entry) {
					entry.port = address.port;
				}
				const url = `http://127.0.0.1:${address.port}/mcp`;
				this.logService.info('[volt] host MCP listening', url);
				resolve({ url, token });
			});
		});
		this.servers.set(serverId, { http: server, endpoint, token, port: 0, tools, revoked: new Map() });
		return endpoint;
	}

	async revokeSession(serverId: string, sessionId: string, epoch: number): Promise<void> {
		const server = this.servers.get(serverId);
		if (!server || !Number.isSafeInteger(epoch)) {
			return;
		}
		server.revoked.set(sessionId, Math.max(epoch, server.revoked.get(sessionId) ?? 0));
		// A revocation older than a token's lifetime outlived every token it could refuse.
		const stale = Date.now() - HOST_MCP_TOKEN_TTL_MS;
		for (const [id, at] of server.revoked) {
			if (at < stale) {
				server.revoked.delete(id);
			}
		}
	}

	async respond(id: string, result: IVoltHostMcpResult): Promise<void> {
		const pending = this.pending.get(id);
		if (pending) {
			this.pending.delete(id);
			pending.resolve(result);
		}
	}

	async stop(serverId: string): Promise<void> {
		const server = this.servers.get(serverId);
		this.servers.delete(serverId);
		server?.http.close();
		for (const [id, pending] of this.pending) {
			if (pending.serverId === serverId) {
				this.pending.delete(id);
				pending.resolve({ content: [{ type: 'text', text: 'Volt closed this window.' }], isError: true });
			}
		}
	}

	private async handle(serverId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const server = this.servers.get(serverId);
		const verdict = server
			? checkHostMcpRequest(req.method, req.url, req.headers, server.port, server.token, { revokedThrough: sessionId => server.revoked.get(sessionId) })
			: { ok: false as const, status: 404 as const, message: 'Not found' };
		if (!verdict.ok) {
			req.resume();
			res.writeHead(verdict.status, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(verdict.message);
			return;
		}
		if (req.method !== 'POST') {
			// No server-to-client stream: tools answer in the POST response.
			req.resume();
			res.writeHead(405, { Allow: 'POST' });
			res.end();
			return;
		}
		// Verified against the token: an agent cannot name another chat or widen its groups.
		const { sessionId, groups } = verdict;
		let body: string;
		try {
			body = await readBody(req, MAX_BODY_BYTES);
		} catch {
			if (!res.writableEnded && !res.destroyed) {
				res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
				res.end('Request too large');
			}
			return;
		}
		try {
			const message = body ? JSON.parse(body) as IJsonRpc | IJsonRpc[] : {};
			const batch = Array.isArray(message) ? message : [message];
			const results = (await Promise.all(batch.map(item => this.dispatch(serverId, sessionId, groups, item, res)))).filter(result => result !== undefined);
			if (!results.length) {
				res.writeHead(202);
				res.end();
				return;
			}
			if (res.writableEnded || res.destroyed) {
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(Array.isArray(message) ? results : results[0]));
		} catch (err) {
			if (res.writableEnded || res.destroyed) {
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err instanceof Error ? err.message : String(err) } }));
		}
	}

	private toolsFor(serverId: string, groups: ReadonlySet<string> | undefined): readonly IVoltHostMcpToolInfo[] {
		const tools = this.servers.get(serverId)?.tools ?? [];
		return groups ? tools.filter(tool => tool.group !== undefined && groups.has(tool.group)) : tools;
	}

	private async dispatch(serverId: string, sessionId: string | undefined, groups: ReadonlySet<string> | undefined, message: IJsonRpc, res: http.ServerResponse): Promise<unknown> {
		const id = message.id ?? null;
		if (message.id === undefined || message.method?.startsWith('notifications/')) {
			return undefined;
		}
		switch (message.method) {
			case 'initialize':
				return ok(id, {
					protocolVersion: (message.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2025-03-26',
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'volt', title: 'Volt', version: '0.1.0' },
					instructions: hostMcpInstructions(groups),
				});
			case 'ping':
				return ok(id, {});
			case 'tools/list':
				return ok(id, {
					tools: this.toolsFor(serverId, groups).map(({ group: _group, aliases: _aliases, metaInFullListOnly, ...tool }) => {
						if (groups && metaInFullListOnly) {
							const { _meta: _dropped, ...rest } = tool;
							return rest;
						}
						return tool;
					}),
				});
			case 'tools/call': {
				const params = (message.params ?? {}) as { name?: string; arguments?: unknown };
				const name = params.name ?? '';
				// An agent that listed tools before a rename may call the earlier name; the window maps it.
				if (!this.toolsFor(serverId, groups).some(tool => tool.name === name || tool.aliases?.includes(name))) {
					return ok(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
				}
				const result = await this.call(serverId, sessionId, name, params.arguments ?? {}, res);
				return ok(id, result);
			}
		}
		return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${message.method ?? ''}` } };
	}

	private call(serverId: string, sessionId: string | undefined, name: string, args: unknown, res: http.ServerResponse): Promise<IVoltHostMcpResult> {
		const id = generateUuid();
		return new Promise<IVoltHostMcpResult>(resolve => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					this._onDidCancel.fire({ id, serverId });
					resolve({ content: [{ type: 'text', text: 'Volt did not answer in time.' }], isError: true });
				}
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, {
				serverId,
				resolve: result => {
					clearTimeout(timer);
					resolve(result);
				},
			});
			res.on('close', () => {
				if (!res.writableEnded && this.pending.delete(id)) {
					clearTimeout(timer);
					this._onDidCancel.fire({ id, serverId });
					resolve({ content: [], isError: true });
				}
			});
			this._onDidCall.fire({ id, serverId, sessionId, name, args });
		});
	}
}

function ok(id: string | number | null, result: unknown): unknown {
	return { jsonrpc: '2.0', id, result };
}

/** The chat in `/mcp/<sessionId>`; undefined without one, null when it does not decode (never read as "no session"). */
function sessionFromPath(url: string | undefined): string | undefined | null {
	const match = /^\/mcp\/([^/?#]+)/.exec(url ?? '');
	if (!match) {
		return undefined;
	}
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

/** `?groups=core,image` limits the listed tools; absent means all. The session token covers it. */
function groupsFromPath(url: string | undefined): ReadonlySet<string> | undefined {
	const query = (url ?? '').split('?')[1]?.split('#')[0];
	if (!query) {
		return undefined;
	}
	const value = new URLSearchParams(query).get('groups');
	return value === null ? undefined : new Set(normalizeHostMcpGroups(value.split(',')));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		req.on('data', (chunk: Buffer | string) => {
			if (tooLarge) {
				return; // drain the rest, so the client finishes writing and can read the 413
			}
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > limit) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			chunks.push(buffer);
		});
		req.on('end', () => tooLarge ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
