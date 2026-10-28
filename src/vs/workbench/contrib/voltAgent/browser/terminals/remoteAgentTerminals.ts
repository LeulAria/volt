/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IProcessDataEvent, IProcessProperty, IProcessPropertyMap, IProcessReadyEvent, IShellLaunchConfig, ITerminalChildProcess, ITerminalLaunchError, ProcessPropertyType, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { isTerminalLive } from '../../../../services/voltRuntime/common/terminalTools.js';
import { AGENT_TERMINAL_ENV, IAgentTerminalInfo, IAgentTerminalStart } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { IAgentTerminalRevealRequest, IAgentTerminalsService } from './agentTerminals.js';

/** The agent server's terminals collection (see ServerTerminals). */
const COLLECTION = 'terminals';

interface IAttachReply {
	readonly gone?: boolean;
	readonly from?: number;
	readonly data?: string;
	/** Set when the process already ended (`null`: no code). */
	readonly exitCode?: number | null;
}

/**
 * A terminal tab showing a process that runs in the agent server: its output so far, then its
 * output as it comes, and what the user types goes to it. Closing the tab detaches; the service
 * decides whether that also stops the process.
 */
class ServerTerminalProcess extends Disposable implements ITerminalChildProcess {

	readonly id = 0;
	readonly shouldPersist = false;

	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty<never>>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	/** Raw offset of everything shown here. */
	private received = 0;
	private started = false;
	private exited = false;
	private readonly resizeSoon: RunOnceScheduler;

	constructor(
		readonly terminalId: string,
		private cols: number,
		private rows: number,
		private readonly cwd: string | undefined,
		private readonly client: IAgentServerClientService,
		private readonly onShutdown: () => void,
	) {
		super();
		this.resizeSoon = this._register(new RunOnceScheduler(() => this.client.send('terminals.resize', this.terminalId, this.cols, this.rows), 50));
	}

	async start(): Promise<ITerminalLaunchError | undefined> {
		this.started = true;
		this._onProcessReady.fire({ pid: -1, cwd: this.cwd ?? '', windowsPty: undefined });
		await this.attach();
		return undefined;
	}

	/** (Re)attaches from what this tab already shows: after a reconnect nothing is shown twice. */
	async attach(): Promise<boolean> {
		if (this.exited) {
			return false;
		}
		let reply: IAttachReply;
		try {
			reply = await this.client.call<IAttachReply>('terminals.attach', this.terminalId, this.received, this.cols, this.rows);
		} catch (err) {
			this.write(`\r\n\u001b[2m${localize('voltAgent.terminal.attachFailed', "Could not reach this terminal in the agent server: {0}", err instanceof Error ? err.message : String(err))}\u001b[0m\r\n`);
			return false;
		}
		if (reply.gone) {
			this.write(`\r\n\u001b[2m${localize('voltAgent.terminal.gone', "This terminal no longer runs in the agent server.")}\u001b[0m\r\n`);
			this.exit(undefined);
			return false;
		}
		this.accept(reply.from ?? 0, reply.data ?? '');
		if (reply.exitCode !== undefined) {
			this.exit(reply.exitCode ?? undefined);
		}
		return true;
	}

	/** Output from `from` on; what this tab already has is skipped. */
	accept(from: number, data: string): void {
		if (this.exited || !data) {
			return;
		}
		const end = from + data.length;
		if (end <= this.received) {
			return;
		}
		this.write(from >= this.received ? data : data.slice(this.received - from));
		this.received = end;
	}

	exit(code: number | undefined): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this._onProcessExit.fire(code);
	}

	get isExited(): boolean {
		return this.exited;
	}

	get isStarted(): boolean {
		return this.started;
	}

	private write(data: string): void {
		this._onProcessData.fire(data);
	}

	shutdown(_immediate: boolean): void {
		this.client.send('terminals.detach', this.terminalId);
		this.onShutdown();
	}

	input(data: string): void {
		if (!this.exited) {
			this.client.send('terminals.input', this.terminalId, data);
		}
	}

	sendSignal(_signal: string): void {
		// The server owns the process; Ctrl+C arrives as input.
	}

	async processBinary(data: string): Promise<void> {
		this.input(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		if (!this.exited) {
			this.resizeSoon.schedule();
		}
	}

	clearBuffer(): void { }

	acknowledgeDataEvent(_charCount: number): void {
		// The server streams in small batches; no flow control.
	}

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> { }

	async getInitialCwd(): Promise<string> {
		return this.cwd ?? '';
	}

	async getCwd(): Promise<string> {
		return this.cwd ?? '';
	}

	async refreshProperty<T extends ProcessPropertyType>(_property: T): Promise<IProcessPropertyMap[T]> {
		return undefined as unknown as IProcessPropertyMap[T];
	}

	async updateProperty<T extends ProcessPropertyType>(_property: T, _value: IProcessPropertyMap[T]): Promise<void> { }
}

/**
 * {@link IAgentTerminalsService} for a window whose agents run in the agent server: the server runs
 * the terminals (they outlive this window), this window lists them from the server's collection
 * and shows one in a terminal tab attached to the server when the user opens it.
 */
export class RemoteAgentTerminalsService extends Disposable implements IAgentTerminalsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	private readonly _onDidRequestReveal = this._register(new Emitter<IAgentTerminalRevealRequest>());
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest> = this._onDidRequestReveal.event;

	/** Terminal id -> its chat, to say which chat changed when one goes away. */
	private readonly chats = new Map<string, string>();
	private readonly instances = new Map<string, ITerminalInstance>();
	private readonly processes = new Map<string, ServerTerminalProcess>();
	/** Tabs this service closes itself: closing them must not stop their process. */
	private readonly closing = new Set<ITerminalInstance>();

	constructor(
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@ITerminalInstanceService private readonly instanceService: ITerminalInstanceService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(client.onDidChangeCollection(e => {
			if (e.col === COLLECTION) {
				this.onCollection(e.reset ? undefined : e.keys);
			}
		}));
		this._register(client.registerHandler('terminals.data', (id, from, data) => {
			if (typeof id === 'string' && typeof from === 'number' && typeof data === 'string') {
				this.processes.get(id)?.accept(from, data);
			}
			return true;
		}));
		this._register(client.registerHandler('terminals.exit', (id, code) => {
			if (typeof id === 'string') {
				this.processes.get(id)?.exit(typeof code === 'number' ? code : undefined);
			}
			return true;
		}));
		// The server forgot this window's viewers when the socket dropped: attach again from where each tab is.
		this._register(client.onDidResync(() => {
			for (const attached of this.processes.values()) {
				if (attached.isStarted && !attached.isExited) {
					void attached.attach();
				}
			}
		}));
		if (client.isReady) {
			this.onCollection(undefined);
		}
	}

	list(chatId: string): readonly IAgentTerminalInfo[] {
		return this.client.mirror.values<IAgentTerminalInfo>(COLLECTION).filter(info => info.chatId === chatId);
	}

	get(id: string): IAgentTerminalInfo | undefined {
		return this.client.mirror.get<IAgentTerminalInfo>(COLLECTION, id);
	}

	start(chatId: string, options: IAgentTerminalStart): Promise<IAgentTerminalInfo> {
		return this.client.call<IAgentTerminalInfo>('terminals.start', chatId, options);
	}

	async stop(id: string): Promise<void> {
		await this.client.call('terminals.stop', id);
	}

	restart(id: string): Promise<IAgentTerminalInfo | undefined> {
		return this.client.call<IAgentTerminalInfo | undefined>('terminals.restart', id);
	}

	dismiss(id: string): void {
		this.client.send('terminals.dismiss', id);
	}

	/** The agent server keeps the output; tools read it there. */
	output(_id: string, _offset?: number): { readonly text: string; readonly offset: number } | undefined {
		return undefined;
	}

	reveal(id: string, preserveFocus = true): void {
		const info = this.get(id);
		if (!info) {
			return;
		}
		if (info.kind === 'agent-task') {
			if (info.outputFile) {
				this._onDidRequestReveal.fire({ chatId: info.chatId, file: URI.file(info.outputFile), preserveFocus });
			}
			return;
		}
		const instance = this.ensureInstance(info);
		if (instance) {
			this._onDidRequestReveal.fire({ chatId: info.chatId, instance, preserveFocus });
		}
	}

	forInstance(instance: ITerminalInstance): IAgentTerminalInfo | undefined {
		for (const [id, candidate] of this.instances) {
			if (candidate === instance) {
				return this.get(id);
			}
		}
		return undefined;
	}

	/** A running terminal gets its tab here when first asked for (the chat's Terminals tab lists it). */
	instanceOf(id: string): ITerminalInstance | undefined {
		const existing = this.instances.get(id);
		if (existing && !existing.isDisposed) {
			return existing;
		}
		const info = this.get(id);
		return info && info.kind === 'terminal' && isTerminalLive(info.status) ? this.ensureInstance(info) : undefined;
	}

	private ensureInstance(info: IAgentTerminalInfo): ITerminalInstance | undefined {
		const existing = this.instances.get(info.id);
		if (existing && !existing.isDisposed) {
			return existing;
		}
		const id = info.id;
		const config: IShellLaunchConfig = {
			name: info.label,
			customPtyImplementation: (_instanceId, cols, rows) => {
				const attached = new ServerTerminalProcess(id, cols, rows, info.cwd, this.client, () => {
					if (this.processes.get(id) === attached) {
						this.processes.delete(id);
					}
				});
				this.processes.set(id, attached);
				return attached;
			},
			...(info.cwd ? { cwd: info.cwd } : {}),
			env: { [AGENT_TERMINAL_ENV]: '1' },
			// The tab keeps the last screen and exit status until the user closes it.
			waitOnExit: code => code
				? `\r\n\u001b[2m${localize('voltAgent.terminal.exitedCode', "{0} exited with code {1}", info.label, code)}\u001b[0m`
				: `\r\n\u001b[2m${localize('voltAgent.terminal.finished', "{0} finished", info.label)}\u001b[0m`,
			// Never revived on reload: the server still runs it, and this window attaches again on demand.
			isTransient: true,
		};
		let instance: ITerminalInstance;
		try {
			instance = this.instanceService.createInstance(config, TerminalLocation.Editor);
			this.terminalEditorService.resolveResource(instance);
		} catch (err) {
			this.logService.warn(`[volt agent server] could not open terminal ${id}`, err);
			return undefined;
		}
		this.instances.set(id, instance);
		Event.once(instance.onDisposed)(() => {
			if (this.instances.get(id) === instance) {
				this.instances.delete(id);
			}
			const ours = this.closing.delete(instance);
			const live = this.get(id);
			// The user closed the tab of a running process: it is gone, as with a terminal of this window.
			// A window that reloads or quits only lets go of it.
			if (!ours && !this.lifecycleService.willShutdown && live && isTerminalLive(live.status)) {
				this.client.send('terminals.stop', id);
			}
			if (live) {
				this._onDidChange.fire(live.chatId);
			}
		});
		return instance;
	}

	private onCollection(keys: readonly string[] | undefined): void {
		const changed = new Set<string>();
		const ids = keys ?? [...new Set([...this.chats.keys(), ...this.client.mirror.entries<IAgentTerminalInfo>(COLLECTION).map(([id]) => id)])];
		for (const id of ids) {
			const info = this.get(id);
			const chat = info?.chatId ?? this.chats.get(id);
			if (chat) {
				changed.add(chat);
			}
			if (info) {
				this.chats.set(id, info.chatId);
				if (!isTerminalLive(info.status)) {
					// Missed the server's end notice (a reconnect): the tab still learns it ended. The notice
					// and the last output come before this on the socket, so nothing is cut off.
					const attached = this.processes.get(id);
					if (attached?.isStarted) {
						attached.exit(info.exitCode);
					}
				}
				continue;
			}
			// Forgotten by the server: its tab goes too.
			this.chats.delete(id);
			this.processes.get(id)?.exit(undefined);
			const instance = this.instances.get(id);
			if (instance && !instance.isDisposed) {
				this.closing.add(instance);
				instance.dispose(TerminalExitReason.Extension);
			}
			this.instances.delete(id);
		}
		for (const chat of changed) {
			this._onDidChange.fire(chat);
		}
	}
}
