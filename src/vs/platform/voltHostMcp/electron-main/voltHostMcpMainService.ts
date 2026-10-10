/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltHostMcpCall, IVoltHostMcpEndpoint, IVoltHostMcpResult, IVoltHostMcpService, IVoltHostMcpToolInfo } from '../common/voltHostMcp.js';

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
}

/** A question can wait on the user for a long time; past this the call answers with an error. */
const CALL_TIMEOUT_MS = 30 * 60_000;
/** JSON-RPC requests are small; anything bigger is not an agent. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type HostMcpRequestVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: 401 | 403 | 404; readonly message: string };

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
 * - The bearer token Volt handed the agent in its MCP server config.
 */
export function checkHostMcpRequest(method: string | undefined, path: string | undefined, headers: http.IncomingHttpHeaders, port: number, token: string): HostMcpRequestVerdict {
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
	if (!match || !sameSecret(match[1], token)) {
		return { ok: false, status: 401, message: 'Missing or wrong bearer token' };
	}
	return { ok: true };
}

export class VoltHostMcpMainService extends Disposable implements IVoltHostMcpService {

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
		this.servers.set(serverId, { http: server, endpoint, token, port: 0, tools });
		return endpoint;
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
			? checkHostMcpRequest(req.method, req.url, req.headers, server.port, server.token)
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
		const sessionId = sessionFromPath(req.url);
		const groups = groupsFromPath(req.url);
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
					instructions: 'Volt tools: ask_question asks the user multiple-choice questions in Volt. browser_* tools drive the in-app browser beside this chat (navigate, snapshot, act, click by ref, type, resize, screenshot, console, network) to preview and test web pages. For anything past a single click, use browser_act: it runs a whole flow (type, click, select, check, wait) in one call with elements targeted by role/name/label/text, verifies each step with expect, and reports only what changed on the page. On iOS simulators and Android emulators, device_snapshot reads the screen\'s accessibility tree and device_act taps, types, scrolls and verifies by visible text instead of screenshot coordinates. On the user\'s Mac, desktop_snapshot and desktop_act read and drive native apps the same way (buttons, fields, menus by name, through accessibility); the user approves desktop control once per chat. Every *_act tool takes a short step script (one step per line) and can save a passing run as a flow to re-run with one call. To build a page from a design image: image_inspect reads exact colours, block bounds and text bands from the image; browser_compare_image renders the page at the image size and returns the mismatch and the regions to fix. Use them instead of writing image-decoding or headless-Chrome scripts. Pull requests: when you create or work on a pull request, call link_pull_request so it shows on this chat (for a stack, every layer). Stacked pull requests: stack_branch makes a layer on the checked out branch, stack_status shows the stack, and restack_stack moves the layers above a changed or merged parent and pushes them (follow its prompt when it stops on a conflict). When asked to monitor, watch or babysit a pull request, call watch_pull_request and end your turn: Volt wakes you when checks fail or pass, a review or comment comes in, or the branch conflicts. Visual replies: when a chart, dashboard, table, diagram or mockup would say more than prose, show it in the reply. For data, call render_chart with a JSON spec: Volt draws it natively in the user\'s theme with hover, tooltips and keyboard reading, and it takes seconds. Every data chart (bar, line, pie, scatter, ...) goes through render_chart (or, in plain markdown, a ```volt-chart fence holding the same JSON spec); never draw data with mermaid xychart-beta or pie, or with ASCII bars. Mermaid fences are for diagrams only (flowcharts, sequence, state). For anything else (dashboards, mockups, reports, diagrams, interactive explainers), write a self-contained HTML page, check it with html_preview, then publish it with html_render. Call these before your final text; the reader already sees the visual, so do not describe or restate it. Orchestration: you can run other Volt chats. orchestrator_capabilities lists models and what you may do; thread_list / thread_search / thread_read read any chat; thread_send messages one (wait=true returns its reply); thread_wait waits for chats to finish; thread_launch starts a new top-level chat (any model, its own worktree with workspace.type=worktree, several models at once with models); thread_fork copies a chat\'s conversation into a new chat to try another direction or model; queue_* manage a chat\'s queued messages; delegate_task runs a subagent whose report comes back to you. Link chats you mention as [title](volt://session/<id>).',
				});
			case 'ping':
				return ok(id, {});
			case 'tools/list':
				return ok(id, { tools: this.toolsFor(serverId, groups).map(({ group: _group, aliases: _aliases, ...tool }) => tool) });
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

function sessionFromPath(url: string | undefined): string | undefined {
	const match = /^\/mcp\/([^/?#]+)/.exec(url ?? '');
	if (!match) {
		return undefined;
	}
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}

/** `?groups=core,image` limits the listed tools; absent means all. */
function groupsFromPath(url: string | undefined): ReadonlySet<string> | undefined {
	const query = (url ?? '').split('?')[1]?.split('#')[0];
	if (!query) {
		return undefined;
	}
	const value = new URLSearchParams(query).get('groups');
	return value === null ? undefined : new Set(value.split(',').map(group => group.trim()).filter(Boolean));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		req.on('data', chunk => {
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
