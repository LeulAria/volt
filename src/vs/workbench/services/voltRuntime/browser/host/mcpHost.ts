/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isAbsolute, join } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltMcpApprovalRecord, IVoltMcpApprovals, IVoltMcpServerSpec, mcpConfigDigest, mcpEffectiveConfig, mcpServerSpec } from '../../common/harness/mcpApprovals.js';
import { IMcpToolInfo, mcpResultContent, McpServerConfig, mcpToolName, mergeMcpServerEntries, normalizeMcpSchema, parseMcpConfig } from '../../common/harness/mcpConfig.js';
import { IVoltMcpApprovalRequest, IVoltMcpServerStatus, VoltMcpApprovalState } from '../../common/runtime.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { AcpJsonRpcClient } from '../agents/acpJsonRpc.js';

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 60;
const RETRY_FAILED_AFTER_MS = 60_000;
/** How long a project server's resolved binary is reused before `which` runs again. */
const BINARY_CACHE_MS = 30_000;

/** A repository's own MCP files: started only in a trusted folder and once approved (see {@link IMcpProjectGate}). */
const WORKSPACE_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.volt/mcp.json'];
const HOME_CONFIGS = ['.cursor/mcp.json', '.volt/mcp.json'];

/** What a project's own MCP server must pass before Volt starts it (B-02, INV-21, INV-22). */
export interface IMcpProjectGate {
	readonly approvals: IVoltMcpApprovals;
	/** The folder's Workspace Trust. */
	trusted(root: URI): Promise<boolean>;
}

interface IConfigEntry {
	readonly config: McpServerConfig;
	readonly scope: 'project' | 'user';
	/** The file it came from, relative to the project or home folder. */
	readonly file: string;
}

/** A configured server and whether it may run: user servers always; a project's own once `approved`. */
interface IGatedEntry {
	readonly config: McpServerConfig;
	readonly scope: 'project' | 'user';
	readonly approval?: VoltMcpApprovalState;
	readonly digest?: string;
	readonly request?: IVoltMcpApprovalRequest;
}

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
	/**
	 * Project servers that passed the gate, by the same key, with the approval they run under. A
	 * project server's connection starts only while its key is here (checked again at the spawn).
	 */
	private readonly approvedProject = new Map<string, { readonly realRoot: string; readonly name: string; readonly digest: string }>();
	private readonly binaries = new Map<string, { readonly at: number; readonly value: Promise<string | undefined> }>();

	constructor(
		private readonly fileService: IFileService,
		private readonly stdio: IVoltStdioService,
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
		private readonly gate: IMcpProjectGate,
	) {
		super();
		this._register({ dispose: () => this.closeAll() });
	}

	/**
	 * Starts connecting every server that may run without waiting for any, so a send finds them up.
	 * Cheap to call often (composer focus): connections are shared and started once. A project's own
	 * server is never started here before it is approved in a trusted folder.
	 */
	async prewarm(root: URI | undefined, home: URI | undefined): Promise<void> {
		for (const { config, scope } of await this.configs(root, home)) {
			void this.connection(config, root, scope);
		}
	}

	/**
	 * Tools of the servers that are up within `waitMs`. Servers still starting keep connecting in
	 * the background and are in the list of a later call.
	 */
	async tools(root: URI | undefined, home: URI | undefined, waitMs: number): Promise<IVoltTool[]> {
		const configs = await this.configs(root, home);
		if (!configs.length) {
			return [];
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); });
		const connected = await Promise.all(configs.map(async ({ config, scope }) => ({ config, connection: await Promise.race([this.connection(config, root, scope), deadline]) })));
		clearTimeout(timer);
		const tools: IVoltTool[] = [];
		const names = new Set<string>();
		for (const { config, connection } of connected) {
			if (!connection?.alive) {
				continue;
			}
			for (const info of connection.tools) {
				const tool = this.toTool(config, info, connection);
				// Names cut to 64 characters can meet: the first server's tool keeps the name (the user's
				// servers come first), so a project's tool never answers a call meant for another.
				if (names.has(tool.name)) {
					this.logService.warn(`[volt mcp] ${config.name}: tool ${info.name} is dropped, its name ${tool.name} is taken`);
					continue;
				}
				names.add(tool.name);
				tools.push(tool);
			}
		}
		return tools.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_TOOLS);
	}

	/** Every configured server, its connection state and, for a project's own, its approval. Starts nothing. */
	async servers(root: URI | undefined, home: URI | undefined): Promise<IVoltMcpServerStatus[]> {
		const entries = await this.gatedEntries(root, home);
		return entries.map(({ config, scope, approval }) => {
			const key = JSON.stringify(config);
			const extra = approval ? { approval } : {};
			if (!this.connections.has(key)) {
				return { name: config.name, scope, state: 'idle' as const, ...extra };
			}
			if (!this.settled.has(key)) {
				return { name: config.name, scope, state: 'connecting' as const, ...extra };
			}
			return { name: config.name, scope, state: this.settled.get(key)?.alive ? 'ready' as const : 'error' as const, ...extra };
		});
	}

	/** The project's own servers waiting for the user's decision. Starts nothing. */
	async approvalRequests(root: URI | undefined, home: URI | undefined): Promise<IVoltMcpApprovalRequest[]> {
		return (await this.gatedEntries(root, home)).flatMap(entry => entry.request ? [entry.request] : []);
	}

	/**
	 * Records the user's decision on a project server, for the configuration it has now. Refused when
	 * that no longer has `digest`: what the user saw is not what would run.
	 */
	async decide(root: URI, home: URI | undefined, name: string, digest: string, allow: boolean): Promise<void> {
		const entry = (await this.configEntries(root, home)).find(candidate => candidate.scope === 'project' && candidate.config.name === name);
		const pinned = entry && await this.pin(entry.config, root);
		if (!pinned || pinned.digest !== digest) {
			throw new Error(`The ${name} MCP server changed since it was shown. Review it again.`);
		}
		await this.gate.approvals.set({ root: await this.realRoot(root), folder: root.toString(), name, digest, decision: allow ? 'allow' : 'deny', spec: pinned.spec, at: Date.now() });
		await this.revalidate();
	}

	approvals(): Promise<readonly IVoltMcpApprovalRecord[]> {
		return this.gate.approvals.list();
	}

	/** Forgets the decision on a project server (every server of the folder without `name`) and stops what no longer passes. */
	async revoke(realRoot: string, name?: string): Promise<void> {
		await this.gate.approvals.remove(realRoot, name);
		await this.revalidate();
	}

	/** Stops project servers whose approval is gone or no longer matches (revoked, decided again). */
	async revalidate(): Promise<void> {
		for (const [key, { realRoot, name, digest }] of [...this.approvedProject]) {
			if ((await this.gate.approvals.decision(realRoot, name, digest))?.decision !== 'allow') {
				this.approvedProject.delete(key);
				this.close(key);
			}
		}
	}

	private async configs(root: URI | undefined, home: URI | undefined): Promise<IGatedEntry[]> {
		return (await this.gatedEntries(root, home)).filter(entry => entry.scope === 'user' || entry.approval === 'approved');
	}

	/**
	 * The configured servers with what may run: every user server; a project's own only when the
	 * folder is trusted and the user approved this exact server (its digest). A project entry's
	 * config carries its working folder, so its connection key is what was approved. Project
	 * servers of the folder that stopped passing (revoked, changed) are stopped here.
	 */
	private async gatedEntries(root: URI | undefined, home: URI | undefined): Promise<IGatedEntry[]> {
		const entries = await this.configEntries(root, home);
		if (!root) {
			return entries;
		}
		if (!entries.some(entry => entry.scope === 'project')) {
			// The project's file is gone: its servers stop.
			if (this.approvedProject.size) {
				this.stopProjectServers(await this.realRoot(root), new Set());
			}
			return entries;
		}
		const [realRoot, trusted] = await Promise.all([this.realRoot(root), this.gate.trusted(root).catch(() => false)]);
		const gated = await Promise.all(entries.map(async (entry): Promise<IGatedEntry> => {
			if (entry.scope === 'user') {
				return entry;
			}
			const { config, spec, digest } = await this.pin(entry.config, root);
			const decision = await this.gate.approvals.decision(realRoot, config.name, digest);
			if (decision?.decision === 'deny') {
				return { config, scope: 'project', approval: 'denied', digest };
			}
			if (decision && trusted) {
				return { config, scope: 'project', approval: 'approved', digest };
			}
			const previous = decision ? undefined : await this.gate.approvals.latest(realRoot, config.name);
			const approval = decision ? 'untrusted' : previous ? 'changed' : 'needed';
			return {
				config,
				scope: 'project',
				approval,
				digest,
				request: { root, realRoot, name: config.name, digest, approval, spec, file: entry.file, ...(previous ? { previous: previous.spec } : {}) },
			};
		}));
		const runnable = new Map(gated.filter(entry => entry.approval === 'approved').map(entry => [JSON.stringify(entry.config), entry] as const));
		this.stopProjectServers(realRoot, new Set(runnable.keys()));
		for (const [key, entry] of runnable) {
			if (entry.digest) {
				this.approvedProject.set(key, { realRoot, name: entry.config.name, digest: entry.digest });
			}
		}
		return gated;
	}

	/** Stops the folder's project servers other than `keep`, and lets none of them start again until they pass the gate. */
	private stopProjectServers(realRoot: string, keep: ReadonlySet<string>): void {
		for (const [key, approved] of [...this.approvedProject]) {
			if (approved.realRoot === realRoot && !keep.has(key)) {
				this.approvedProject.delete(key);
				this.close(key);
			}
		}
	}

	/** The project server as it would run (its working folder filled in), what the card shows of it, and its digest. */
	private async pin(config: McpServerConfig, root: URI): Promise<{ readonly config: McpServerConfig; readonly spec: IVoltMcpServerSpec; readonly digest: string }> {
		const effective = mcpEffectiveConfig(config, root);
		const binary = effective.kind === 'stdio' ? await this.resolveBinary(effective.command, effective.cwd ?? root.fsPath) : undefined;
		return { config: effective, spec: mcpServerSpec(effective, binary), digest: await mcpConfigDigest(effective, binary) };
	}

	/** The real file a command names: a path as is (relative to its working folder), a bare name from PATH. Never runs it. */
	private resolveBinary(command: string, cwd: string): Promise<string | undefined> {
		const key = JSON.stringify([cwd, command]);
		const cached = this.binaries.get(key);
		if (cached && Date.now() - cached.at < BINARY_CACHE_MS) {
			return cached.value;
		}
		const value = (async () => {
			const path = isAbsolute(command) ? command
				: /[\\/]/.test(command) ? join(cwd, command)
					: command.startsWith('-') ? undefined
						: await this.stdio.which(command).catch(() => undefined);
			if (!path) {
				return undefined;
			}
			return (await this.fileService.realpath(URI.file(path)).catch(() => undefined))?.fsPath ?? path;
		})();
		this.binaries.set(key, { at: Date.now(), value });
		return value;
	}

	private async realRoot(root: URI): Promise<string> {
		return (await this.fileService.realpath(root).catch(() => undefined))?.fsPath ?? root.fsPath;
	}

	/** Every configured server, one per name: the user's win over the project's (mergeMcpServerEntries). */
	private async configEntries(root: URI | undefined, home: URI | undefined): Promise<IConfigEntry[]> {
		const variables: Record<string, string> = {
			...(root ? { workspaceFolder: root.fsPath, workspaceRoot: root.fsPath } : {}),
			...(home ? { userHome: home.fsPath, HOME: home.fsPath } : {}),
		};
		const files = [
			...(home ? HOME_CONFIGS.map(path => ({ file: joinPath(home, path), path, scope: 'user' as const })) : []),
			...(root ? WORKSPACE_CONFIGS.map(path => ({ file: joinPath(root, path), path, scope: 'project' as const })) : []),
		];
		const texts = await Promise.all(files.map(({ file }) => this.fileService.readFile(file).then(content => content.value.toString(), () => undefined)));
		return mergeMcpServerEntries(texts.flatMap((text, index) => (text ? parseMcpConfig(text, variables) : []).map(config => ({ config, scope: files[index].scope, file: files[index].path }))));
	}

	private connection(config: McpServerConfig, root: URI | undefined, scope: 'project' | 'user'): Promise<IMcpConnection | undefined> {
		const key = JSON.stringify(config);
		// Checked here too, not only by the caller: an approval revoked while the caller awaited stops it.
		if (scope === 'project' && !this.approvedProject.has(key)) {
			return Promise.resolve(undefined);
		}
		const cached = this.connections.get(key);
		if (cached) {
			return cached.value.then(connection => {
				if (connection?.alive) {
					return connection;
				}
				if (Date.now() - cached.started < RETRY_FAILED_AFTER_MS) {
					return undefined;
				}
				// A dead connection still holds its client and listeners (and maybe a process): drop them first.
				connection?.dispose();
				this.connections.delete(key);
				this.settled.delete(key);
				return this.connection(config, root, scope);
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
			// Timed here, not only by the caller's race: a server waiting on a prompt (npx without -y)
			// would otherwise keep its process after the race gave up, and the next try spawns another.
			await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: {} }, clientInfo: { name: 'Volt', version: '1.0.0' } }, CONNECT_TIMEOUT_MS);
			await client.notify('notifications/initialized');
			const tools = await listTools(cursor => client.request('tools/list', cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS));
			return {
				tools,
				get alive() { return !client.isDead; },
				call: (name, args, signal) => {
					if (signal.aborted) {
						return Promise.reject(new Error('Cancelled.'));
					}
					// An abandoned call lets go of its pending request instead of waiting on the server forever.
					const cts = new CancellationTokenSource();
					const onAbort = () => cts.cancel();
					signal.addEventListener('abort', onAbort, { once: true });
					return withAbort(client.request('tools/call', { name, arguments: args ?? {} }, { token: cts.token }), signal)
						.finally(() => {
							signal.removeEventListener('abort', onAbort);
							cts.dispose();
						});
				},
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
			type RpcReply = { id?: unknown; result?: unknown; error?: { message?: string } } | null;
			const messages: RpcReply[] = /^\s*[{[]/.test(body)
				? [JSON.parse(body) as RpcReply | RpcReply[]].flat()
				: body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()) as RpcReply);
			const reply = messages.find(message => message && message.id === id);
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

	private close(key: string): void {
		const entry = this.connections.get(key);
		this.connections.delete(key);
		this.settled.delete(key);
		void entry?.value.then(connection => connection?.dispose());
	}

	private toTool(config: McpServerConfig, info: IMcpToolInfo, connection: IMcpConnection): IVoltTool {
		const name = mcpToolName(config.name, info.name);
		const readOnly = info.annotations?.readOnlyHint === true;
		// Safe to run again (a retry, a crash replay) only when it says so: a send or a payment
		// that declares nothing happens once, and a cut-off call is reported, never repeated.
		const idempotent = readOnly || (info.annotations?.idempotentHint === true && info.annotations.destructiveHint !== true);
		const description = `[MCP ${config.name}] ${(info.description ?? info.annotations?.title ?? info.name).trim()}`.slice(0, 1_024);
		return {
			name,
			group: 'mcp',
			kind: 'other',
			description,
			schema: normalizeMcpSchema(info.inputSchema),
			parallelSafe: readOnly,
			idempotent,
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

	/**
	 * Lets servers that failed to start be tried on the next run instead of after the retry delay
	 * (the user just fixed their config). Live connections stay: other chats may be using them.
	 */
	forgetFailed(): void {
		for (const [key, connection] of [...this.settled]) {
			if (!connection?.alive) {
				connection?.dispose();
				this.connections.delete(key);
				this.settled.delete(key);
			}
		}
	}

	private closeAll(): void {
		for (const entry of this.connections.values()) {
			void entry.value.then(connection => connection?.dispose());
		}
		this.connections.clear();
		this.settled.clear();
		this.approvedProject.clear();
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
