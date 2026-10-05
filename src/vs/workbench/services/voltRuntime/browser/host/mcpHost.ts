/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IMcpToolInfo, mcpResultContent, McpServerConfig, mcpToolName, normalizeMcpSchema, parseMcpConfig } from '../../common/harness/mcpConfig.js';
import { IVoltMcpServerStatus } from '../../common/runtime.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { AcpJsonRpcClient } from '../agents/acpJsonRpc.js';

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 60;
const RETRY_FAILED_AFTER_MS = 60_000;

const WORKSPACE_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.volt/mcp.json'];
const HOME_CONFIGS = ['.cursor/mcp.json', '.volt/mcp.json'];

interface IMcpConnection {
	readonly tools: readonly IMcpToolInfo[];
	readonly alive: boolean;
	call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
	dispose(): void;
}

/**
 * MCP servers as native tools. Connections are started once and reused across runs; a run waits
 * a bounded time for them, so a slow or broken server never holds a turn hostage. The tool list
 * is sorted and stable, because it is part of the cached prompt prefix.
 */
export class McpHost extends Disposable {

	private readonly connections = new Map<string, { readonly started: number; readonly value: Promise<IMcpConnection | undefined> }>();
	/** Settled connection attempts, by the same key as {@link connections}. */
	private readonly settled = new Map<string, IMcpConnection | undefined>();

	constructor(
		private readonly fileService: IFileService,
		private readonly stdio: IVoltStdioService,
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.closeAll() });
	}

	async tools(root: URI | undefined, home: URI | undefined, waitMs: number): Promise<IVoltTool[]> {
		const configs = await this.configs(root, home);
		if (!configs.length) {
			return [];
		}
		const deadline = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), waitMs));
		const connected = await Promise.all(configs.map(async config => ({ config, connection: await Promise.race([this.connection(config, root), deadline]) })));
		const tools: IVoltTool[] = [];
		for (const { config, connection } of connected) {
			if (!connection?.alive) {
				continue;
			}
			for (const info of connection.tools) {
				tools.push(this.toTool(config, info, connection));
			}
		}
		return tools.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_TOOLS);
	}

	/** Every configured server and its connection state. Starts nothing. */
	async servers(root: URI | undefined, home: URI | undefined): Promise<IVoltMcpServerStatus[]> {
		const entries = await this.configEntries(root, home);
		return entries.map(({ config, scope }) => {
			const key = JSON.stringify(config);
			if (!this.connections.has(key)) {
				return { name: config.name, scope, state: 'idle' as const };
			}
			if (!this.settled.has(key)) {
				return { name: config.name, scope, state: 'connecting' as const };
			}
			return { name: config.name, scope, state: this.settled.get(key)?.alive ? 'ready' as const : 'error' as const };
		});
	}

	private async configs(root: URI | undefined, home: URI | undefined): Promise<McpServerConfig[]> {
		return (await this.configEntries(root, home)).map(entry => entry.config);
	}

	private async configEntries(root: URI | undefined, home: URI | undefined): Promise<{ readonly config: McpServerConfig; readonly scope: 'project' | 'user' }[]> {
		const variables: Record<string, string> = {
			...(root ? { workspaceFolder: root.fsPath, workspaceRoot: root.fsPath } : {}),
			...(home ? { userHome: home.fsPath, HOME: home.fsPath } : {}),
		};
		const files = [
			...(root ? WORKSPACE_CONFIGS.map(path => ({ file: joinPath(root, path), scope: 'project' as const })) : []),
			...(home ? HOME_CONFIGS.map(path => ({ file: joinPath(home, path), scope: 'user' as const })) : []),
		];
		const texts = await Promise.all(files.map(({ file }) => this.fileService.readFile(file).then(content => content.value.toString(), () => undefined)));
		const byName = new Map<string, { readonly config: McpServerConfig; readonly scope: 'project' | 'user' }>();
		texts.forEach((text, index) => {
			for (const server of text ? parseMcpConfig(text, variables) : []) {
				// Volt's own host server is already a native tool.
				if (!byName.has(server.name) && server.name !== 'volt') {
					byName.set(server.name, { config: server, scope: files[index].scope });
				}
			}
		});
		return [...byName.values()];
	}

	private connection(config: McpServerConfig, root: URI | undefined): Promise<IMcpConnection | undefined> {
		const key = JSON.stringify(config);
		const cached = this.connections.get(key);
		if (cached) {
			return cached.value.then(connection => {
				if (connection?.alive) {
					return connection;
				}
				if (Date.now() - cached.started < RETRY_FAILED_AFTER_MS) {
					return undefined;
				}
				this.connections.delete(key);
				this.settled.delete(key);
				return this.connection(config, root);
			});
		}
		const value = withTimeout(config.kind === 'stdio' ? this.connectStdio(config, root) : this.connectHttp(config), CONNECT_TIMEOUT_MS)
			.catch(err => {
				this.logService.warn(`[volt mcp] ${config.name} is unavailable`, err);
				return undefined;
			})
			.then(connection => {
				this.settled.set(key, connection);
				return connection;
			});
		this.connections.set(key, { started: Date.now(), value });
		return value;
	}

	private async connectStdio(config: Extract<McpServerConfig, { kind: 'stdio' }>, root: URI | undefined): Promise<IMcpConnection> {
		const processId = await this.stdio.spawn({ command: config.command, args: [...config.args], cwd: config.cwd ?? root?.fsPath, env: config.env });
		const client = new AcpJsonRpcClient(this.stdio, processId);
		client.handleRequests(request => {
			if (request.method === 'roots/list') {
				void client.respond(request.id, { roots: root ? [{ uri: root.toString(), name: root.path.split('/').pop() }] : [] });
			} else if (request.method === 'ping') {
				void client.respond(request.id, {});
			} else {
				void client.respondError(request.id, `Unsupported request ${request.method}`);
			}
		});
		const dispose = () => {
			client.dispose();
			void this.stdio.kill(processId);
		};
		try {
			await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: {} }, clientInfo: { name: 'Volt', version: '1.0.0' } });
			await client.notify('notifications/initialized');
			const tools = await listTools(cursor => client.request('tools/list', cursor ? { cursor } : {}));
			return {
				tools,
				get alive() { return !client.isDead; },
				call: (name, args, signal) => withAbort(client.request('tools/call', { name, arguments: args ?? {} }), signal),
				dispose,
			};
		} catch (err) {
			dispose();
			throw err;
		}
	}

	private async connectHttp(config: Extract<McpServerConfig, { kind: 'http' }>): Promise<IMcpConnection> {
		let session: string | undefined;
		let nextId = 1;
		let closed = false;
		const rpc = async (method: string, params: unknown, notify = false, token = CancellationToken.None): Promise<unknown> => {
			const id = notify ? undefined : nextId++;
			const ctx = await this.requestService.request({
				type: 'POST',
				url: config.url,
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json, text/event-stream',
					'MCP-Protocol-Version': PROTOCOL_VERSION,
					...(session ? { 'Mcp-Session-Id': session } : {}),
					...config.headers,
				},
				data: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
			}, token);
			const header = ctx.res.headers['mcp-session-id'];
			if (typeof header === 'string') {
				session = header;
			}
			const body = (await streamToBuffer(ctx.stream)).toString();
			const status = ctx.res.statusCode ?? 0;
			if (status >= 400) {
				throw new Error(`HTTP ${status}: ${body.slice(0, 300)}`);
			}
			if (notify) {
				return undefined;
			}
			const messages = /^\s*[{[]/.test(body)
				? [JSON.parse(body)].flat()
				: body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()));
			const reply = messages.find(message => message && message.id === id) as { result?: unknown; error?: { message?: string } } | undefined;
			if (!reply) {
				throw new Error(`No response to ${method}.`);
			}
			if (reply.error) {
				throw new Error(reply.error.message ?? `${method} failed`);
			}
			return reply.result;
		};
		await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Volt', version: '1.0.0' } });
		await rpc('notifications/initialized', {}, true);
		const tools = await listTools(cursor => rpc('tools/list', cursor ? { cursor } : {}));
		return {
			tools,
			get alive() { return !closed; },
			call: (name, args, signal) => {
				const source = new CancellationTokenSource();
				signal.addEventListener('abort', () => source.cancel(), { once: true });
				return rpc('tools/call', { name, arguments: args ?? {} }, false, source.token).finally(() => source.dispose());
			},
			dispose: () => { closed = true; },
		};
	}

	private toTool(config: McpServerConfig, info: IMcpToolInfo, connection: IMcpConnection): IVoltTool {
		const name = mcpToolName(config.name, info.name);
		const readOnly = info.annotations?.readOnlyHint === true;
		const description = `[MCP ${config.name}] ${(info.description ?? info.annotations?.title ?? info.name).trim()}`.slice(0, 1_024);
		return {
			name,
			group: 'mcp',
			kind: 'other',
			description,
			schema: normalizeMcpSchema(info.inputSchema),
			parallelSafe: readOnly,
			idempotent: readOnly,
			snippet: `${name} - ${description.slice(0, 80)}`,
			timeoutMs: CALL_TIMEOUT_MS,
			execute: async (args, ctx): Promise<IToolResult> => {
				if (!connection.alive) {
					return { callId: '', name, kind: 'other', text: `The ${config.name} MCP server is no longer running.`, isError: true };
				}
				try {
					const content = mcpResultContent(await connection.call(info.name, args, ctx.signal));
					return { callId: '', name, kind: 'other', text: content.text, ...(content.image ? { image: content.image } : {}), ...(content.isError ? { isError: true } : {}) };
				} catch (err) {
					return { callId: '', name, kind: 'other', text: err instanceof Error ? err.message : String(err), isError: true };
				}
			},
		};
	}

	private closeAll(): void {
		for (const entry of this.connections.values()) {
			void entry.value.then(connection => connection?.dispose());
		}
		this.connections.clear();
		this.settled.clear();
	}
}

async function listTools(request: (cursor: string | undefined) => Promise<unknown>): Promise<IMcpToolInfo[]> {
	const tools: IMcpToolInfo[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page++) {
		const result = await request(cursor) as { tools?: IMcpToolInfo[]; nextCursor?: string } | undefined;
		tools.push(...(result?.tools ?? []).filter(tool => typeof tool?.name === 'string'));
		cursor = result?.nextCursor;
		if (!cursor) {
			break;
		}
	}
	return tools;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(value => {
			clearTimeout(timer);
			resolve(value);
		}, err => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new Error('Cancelled.'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('Cancelled.'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}
