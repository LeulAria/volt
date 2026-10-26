/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPty } from 'node-pty';
import { homedir } from 'os';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename, delimiter, join } from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { sanitizeProcessEnvironment } from '../../../base/common/processes.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ReplicatedCollection } from '../../../platform/voltAgentServer/common/collections.js';
import { AgentServerProtocol, IAgentServerCallContext } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IVoltStdioService } from '../../../platform/voltStdio/common/voltStdio.js';
import { ChildLedger } from '../../../platform/voltStdio/node/childLedger.js';
import { IAgentWorkspaceService } from '../../../workbench/contrib/voltAgent/browser/workspace/agentWorkspace.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { isTerminalLive, TERMINAL_TOOLS, VoltTerminalToolName } from '../../../workbench/services/voltRuntime/common/terminalTools.js';
import {
	IAgentTerminalStart, IManagedTerminalBackend, IManagedTerminalExit, IManagedTerminalLaunch, IManagedTerminalProcess, ManagedTerminal, ManagedTerminals, ManagedTerminalTools,
} from '../../../workbench/services/voltRuntime/common/terminals/managedTerminals.js';

/** Raw output kept per terminal for windows that open it later (escape sequences and all). */
const MAX_RAW_CHARS = 1_000_000;
/** Output is sent to the windows showing a terminal at most this often. */
const STREAM_MS = 16;
/** A window that takes longer than this to take a chunk is not waited for (the chunk is not resent). */
const STREAM_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_COLS = 120;
/** How long after a process exits its last output may still arrive. */
const EXIT_FLUSH_MS = 100;
const DEFAULT_ROWS = 30;

/** Everything a terminal wrote, its start whole and the rest rolling; offsets count every character ever written. */
class RawLog {
	private readonly chunks: string[] = [];
	private size = 0;
	total = 0;

	append(data: string): void {
		this.chunks.push(data);
		this.size += data.length;
		this.total += data.length;
		while (this.size > MAX_RAW_CHARS && this.chunks.length > 1) {
			this.size -= this.chunks.shift()!.length;
		}
	}

	/** What was written after `offset`, or all that is still kept when part of it rolled off. */
	since(offset: number): { readonly from: number; readonly data: string } {
		const kept = this.total - this.size;
		const from = Math.max(kept, Math.min(offset, this.total));
		const data = this.chunks.join('');
		return { from, data: data.slice(from - kept) };
	}
}

interface IPtyModule {
	readonly spawn: typeof import('node-pty').spawn;
}

/** A terminal process in the agent server's own pty: it lives as long as the server, whatever windows do. */
class PtyTerminalProcess implements IManagedTerminalProcess {

	private readonly _onData = new Emitter<string>();
	readonly onData: Event<string> = this._onData.event;
	private readonly _onExit = new Emitter<IManagedTerminalExit>();
	readonly onExit: Event<IManagedTerminalExit> = this._onExit.event;
	readonly onClosed: Event<void> = Event.None;
	readonly ready = Promise.resolve();
	readonly viewable = true;
	private exited = false;

	constructor(readonly pty: IPty, private readonly onEnd: () => void) {
		pty.onData(data => this._onData.fire(data));
		pty.onExit(({ exitCode, signal }) => {
			this.exited = true;
			this.onEnd();
			// node-pty can report the exit before the last output: that output comes first.
			setTimeout(() => {
				this._onExit.fire({ code: signal && !exitCode ? 128 + signal : exitCode });
				this._onData.dispose();
				this._onExit.dispose();
			}, EXIT_FLUSH_MS);
		});
	}

	async sendText(text: string, enter: boolean): Promise<void> {
		if (!this.exited) {
			this.pty.write(enter ? `${text}\r` : text);
		}
	}

	write(data: string): void {
		if (!this.exited) {
			this.pty.write(data);
		}
	}

	resize(cols: number, rows: number): void {
		if (!this.exited) {
			try {
				this.pty.resize(cols, rows);
			} catch {
				// Exited in between.
			}
		}
	}

	kill(): void {
		if (this.exited) {
			return;
		}
		try {
			// The whole group: a dev server's children (watchers, workers) go with it.
			process.kill(-this.pty.pid, 'SIGKILL');
		} catch {
			try {
				this.pty.kill('SIGKILL');
			} catch {
				// Already gone.
			}
		}
	}
}

/** Starts managed terminals in node-pty, with the user's shell environment (Volt's GUI launch lacks it). */
class PtyTerminalBackend implements IManagedTerminalBackend {

	readonly processes = new Map<string, PtyTerminalProcess>();
	private ptyModule: Promise<IPtyModule> | undefined;

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly ledger: ChildLedger,
		private readonly logService: ILogService,
	) { }

	async spawn(launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		const pty = await this.loadPty();
		const shell = this.shell();
		const env = await this.env(launch.env);
		let child: IPty;
		try {
			child = pty.spawn(shell, isWindows ? ['/d', '/s', '/c', launch.command] : ['-c', launch.command], {
				name: 'xterm-256color',
				cols: DEFAULT_COLS,
				rows: DEFAULT_ROWS,
				...(launch.cwd ? { cwd: launch.cwd } : {}),
				env: env as Record<string, string>,
			});
		} catch (err) {
			throw new Error(`Could not start ${launch.label}: ${err instanceof Error ? err.message : String(err)}`);
		}
		// Recorded so a server that is killed outright does not leave the process running unowned.
		this.ledger.add(child.pid, shell);
		const running = new PtyTerminalProcess(child, () => {
			this.ledger.delete(child.pid);
			this.processes.delete(launch.id);
		});
		this.processes.set(launch.id, running);
		this.logService.trace(`[volt agent server] terminal ${launch.id} started (pid ${child.pid}): ${launch.command}`);
		return running;
	}

	/** Loaded on the first terminal: a node-pty that fails to load costs terminals, never the server. */
	private loadPty(): Promise<IPtyModule> {
		this.ptyModule ??= import('node-pty').then(module => {
			const loaded = module as unknown as Partial<IPtyModule> & { readonly default?: Partial<IPtyModule> };
			const spawn = loaded.spawn ?? loaded.default?.spawn;
			if (typeof spawn !== 'function') {
				throw new Error('it has no spawn function');
			}
			return { spawn };
		}).catch(err => {
			this.ptyModule = undefined;
			throw new Error(`Terminals are not available in the agent server (node-pty did not load: ${err instanceof Error ? err.message : String(err)}).`);
		});
		return this.ptyModule;
	}

	/** A POSIX shell for the agent's command lines: the user's when it is one, else zsh or bash. */
	private shell(): string {
		if (isWindows) {
			return 'cmd.exe';
		}
		const user = process.env['SHELL'];
		return user && /^(zsh|bash|sh|dash|ksh)$/.test(basename(user)) ? user : isMacintosh ? '/bin/zsh' : '/bin/bash';
	}

	private async env(extra: Readonly<Record<string, string>>): Promise<NodeJS.ProcessEnv> {
		const resolved = await this.resolveEnv().catch(() => process.env);
		const env: NodeJS.ProcessEnv = { ...process.env, ...resolved };
		// The server runs as Electron in Node mode: none of that reaches the user's commands.
		sanitizeProcessEnvironment(env);
		const home = homedir();
		const paths = isWindows ? [] : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.docker', 'bin'), join(home, '.orbstack', 'bin')];
		const current = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
		env['PATH'] = [...current, ...paths].filter((entry, index, all) => all.indexOf(entry) === index).join(delimiter);
		env['COLORTERM'] = 'truecolor';
		if (isMacintosh && !env['LANG']) {
			env['LANG'] = 'en_US.UTF-8';
		}
		return { ...env, ...extra };
	}
}

interface IViewer {
	/** Raw offset the window has. */
	sent: number;
}

/**
 * The agents' terminals (terminal_*, docker_ensure, app_open) in the agent server: dev servers and
 * watchers keep running when every window closes or reloads. The chat's chips read the `terminals`
 * collection; a window that shows one attaches to its output and types into it.
 */
export class ServerTerminals extends Disposable {

	readonly core: ManagedTerminals;
	private readonly backend: PtyTerminalBackend;
	private readonly raw = new Map<string, RawLog>();
	/** Terminal id -> the connections showing it. */
	private readonly viewers = new Map<string, Map<number, IViewer>>();
	private readonly pendingStreams = new Set<string>();
	private streamTimer: ReturnType<typeof setTimeout> | undefined;
	/** Chat -> the ids last published for it, so ones that went away are deleted. */
	private readonly published = new Map<string, Set<string>>();

	constructor(
		private readonly protocol: AgentServerProtocol,
		private readonly collection: ReplicatedCollection,
		resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		ledger: ChildLedger,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IFileService fileService: IFileService,
		@IVoltStdioService stdio: IVoltStdioService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IAgentWorkspaceService workspaceService: IAgentWorkspaceService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.backend = new PtyTerminalBackend(resolveEnv, ledger, logService);
		// Ids carry this server's mark: a window still showing a terminal of a server that restarted never mixes them up.
		this.core = this._register(new ManagedTerminals(this.backend, runtime, fileService, () => undefined, `term-${generateUuid().slice(0, 4)}-`));
		const tools = new ManagedTerminalTools(this.core, stdio, fileService);
		this._register(hostTools.registerToolProvider({
			tools: TERMINAL_TOOLS,
			invoke: (name, args, call) => tools.invoke(name as VoltTerminalToolName, args, call),
		}));
		this._register(this.core.onDidChange(chatId => this.publish(chatId)));
		this._register(this.core.onDidWriteData(({ terminal, data }) => this.onData(terminal, data)));
		this._register(this.core.onDidEnd(terminal => this.onEnd(terminal)));
		this._register(this.core.onDidForget(terminal => {
			this.raw.delete(terminal.id);
			this.viewers.delete(terminal.id);
		}));
		this._register(workspaceService.onDidChange(e => {
			if (e.slot === undefined && !workspaceService.get(e.sessionId)) {
				this.core.forgetChat(e.sessionId);
			}
		}));
		this._register(protocol.onDidChangeClients(() => {
			const live = new Set(protocol.listClients().map(client => client.connectionId));
			for (const viewers of this.viewers.values()) {
				for (const connectionId of [...viewers.keys()]) {
					if (!live.has(connectionId)) {
						viewers.delete(connectionId);
					}
				}
			}
		}));
		this.registerMethods();
		this._register(toDisposable(() => {
			clearTimeout(this.streamTimer);
			this.core.killAll();
		}));
	}

	/** Whether a terminal the agent started still runs (the server stays up for it). */
	hasLive(): boolean {
		return this.core.hasLive();
	}

	private registerMethods(): void {
		const ownerOnly = (ctx: IAgentServerCallContext) => {
			if (ctx.client.role !== 'owner') {
				throw Object.assign(new Error('Only Volt on this computer can type into a terminal.'), { code: 'Forbidden' });
			}
		};
		this._register(this.protocol.registerMethods('terminals', {
			start: (_ctx, chatId, options) => this.core.start(String(chatId), parseStart(options)).then(toWire),
			stop: (_ctx, id) => this.core.stop(String(id)),
			restart: (_ctx, id) => this.core.restart(String(id)).then(info => toWire(info)),
			dismiss: (_ctx, id) => {
				this.core.dismiss(String(id));
				return true;
			},
			/** A window shows a terminal: what it wrote from `offset` on, and its output from now on. */
			attach: (ctx, id, offset, cols, rows) => {
				const key = String(id);
				const terminal = this.core.managed(key);
				if (!terminal || terminal.task) {
					return { gone: true };
				}
				const log = this.raw.get(key) ?? new RawLog();
				const { from, data } = log.since(typeof offset === 'number' && offset >= 0 ? offset : 0);
				let viewers = this.viewers.get(key);
				if (!viewers) {
					viewers = new Map();
					this.viewers.set(key, viewers);
				}
				viewers.set(ctx.client.connectionId, { sent: log.total });
				if (ctx.client.role === 'owner' && typeof cols === 'number' && typeof rows === 'number') {
					this.backend.processes.get(key)?.resize(clampSize(cols, DEFAULT_COLS), clampSize(rows, DEFAULT_ROWS));
				}
				return {
					from,
					data,
					...(isTerminalLive(terminal.status) ? {} : { exitCode: terminal.exitCode ?? null }),
				};
			},
			detach: (ctx, id) => {
				this.viewers.get(String(id))?.delete(ctx.client.connectionId);
				return true;
			},
			input: (ctx, id, data) => {
				ownerOnly(ctx);
				if (typeof data === 'string' && data) {
					this.backend.processes.get(String(id))?.write(data);
				}
				return true;
			},
			resize: (ctx, id, cols, rows) => {
				ownerOnly(ctx);
				if (typeof cols === 'number' && typeof rows === 'number') {
					this.backend.processes.get(String(id))?.resize(clampSize(cols, DEFAULT_COLS), clampSize(rows, DEFAULT_ROWS));
				}
				return true;
			},
		}));
	}

	private publish(chatId: string): void {
		const infos = this.core.list(chatId);
		const ids = new Set(infos.map(info => info.id));
		const before = this.published.get(chatId) ?? new Set<string>();
		const delta: Record<string, unknown> = {};
		for (const info of infos) {
			delta[info.id] = toWire(info);
		}
		for (const id of before) {
			if (!ids.has(id)) {
				delta[id] = undefined;
			}
		}
		if (ids.size) {
			this.published.set(chatId, ids);
		} else {
			this.published.delete(chatId);
		}
		if (Object.keys(delta).length) {
			this.collection.update(delta);
		}
	}

	private onData(terminal: ManagedTerminal, data: string): void {
		let log = this.raw.get(terminal.id);
		if (!log) {
			log = new RawLog();
			this.raw.set(terminal.id, log);
		}
		log.append(data);
		if (this.viewers.get(terminal.id)?.size) {
			this.pendingStreams.add(terminal.id);
			this.streamTimer ??= setTimeout(() => this.stream(), STREAM_MS);
		}
	}

	/** Ended: what is left goes out, then the end (the window writes its own exit line), in that order on each socket. */
	private onEnd(terminal: ManagedTerminal): void {
		if (terminal.task) {
			return;
		}
		this.flush(terminal.id);
		for (const connectionId of this.viewers.get(terminal.id)?.keys() ?? []) {
			this.protocol.callConnection(connectionId, 'terminals.exit', [terminal.id, terminal.exitCode ?? null], STREAM_CALL_TIMEOUT_MS).catch(() => { /* gone */ });
		}
	}

	private stream(): void {
		this.streamTimer = undefined;
		const ids = [...this.pendingStreams];
		this.pendingStreams.clear();
		for (const id of ids) {
			this.flush(id);
		}
	}

	private flush(id: string): void {
		const log = this.raw.get(id);
		const viewers = this.viewers.get(id);
		if (!log || !viewers) {
			return;
		}
		for (const [connectionId, viewer] of viewers) {
			if (viewer.sent >= log.total) {
				continue;
			}
			const { from, data } = log.since(viewer.sent);
			viewer.sent = log.total;
			this.protocol.callConnection(connectionId, 'terminals.data', [id, from, data], STREAM_CALL_TIMEOUT_MS).catch(err => {
				this.logService.trace('[volt agent server] a window did not take terminal output', err);
			});
		}
	}
}

function clampSize(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 2 ? Math.min(1000, Math.round(value)) : fallback;
}

function parseStart(value: unknown): IAgentTerminalStart {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const text = (key: string) => typeof record[key] === 'string' && (record[key] as string).trim() ? record[key] as string : undefined;
	const command = text('command');
	if (!command) {
		throw new Error('command is required.');
	}
	return { command, label: text('label'), cwd: text('cwd'), readyPattern: text('readyPattern') };
}
