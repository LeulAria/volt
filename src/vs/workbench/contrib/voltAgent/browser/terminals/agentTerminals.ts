/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { projectRunEnv } from '../../../../services/voltRuntime/common/projectRunEnv.js';
import { IAgentRuntimeService, IVoltAgentBackgroundTask } from '../../../../services/voltRuntime/common/runtime.js';
import {
	agentPattern, AgentTerminalStatus, APP_OPEN_TOOL_NAME, DOCKER_ENSURE_TOOL_NAME, isTerminalLive, lastErrorLine, localUrlsIn, looksLikePrompt, looksReady, plainTerminalText,
	TERMINAL_LIST_TOOL_NAME, TERMINAL_OUTPUT_TOOL_NAME, TERMINAL_SEND_TOOL_NAME, TERMINAL_START_TOOL_NAME, TERMINAL_STOP_TOOL_NAME, TERMINAL_TOOLS, TERMINAL_WAIT_TOOL_NAME,
	terminalLabelFor, VoltTerminalToolName,
} from '../../../../services/voltRuntime/common/terminalTools.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { ITerminalProfileService } from '../../../terminal/common/terminal.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

/** A managed terminal as the chat's chips and the tools see it. */
export interface IAgentTerminalInfo {
	readonly id: string;
	/** The chat that owns it (a subagent's terminals belong to its parent chat). */
	readonly chatId: string;
	readonly command: string;
	readonly label: string;
	readonly cwd: string | undefined;
	readonly status: AgentTerminalStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly lastActivity: number;
	readonly exitCode?: number;
	readonly urls: readonly string[];
	/** Why it failed, or the last error-looking line while it runs. */
	readonly error?: string;
	/** The terminal tab can still be shown (it closes when the user dismisses a finished one). */
	readonly viewable: boolean;
	/** `agent-task`: a command a CLI agent runs in the background itself; Volt only watches it. */
	readonly kind: 'terminal' | 'agent-task';
}

export interface IAgentTerminalStart {
	readonly command: string;
	readonly label?: string;
	readonly cwd?: string;
	readonly readyPattern?: string;
}

export interface IAgentTerminalRevealRequest {
	readonly chatId: string;
	/** A Volt terminal. */
	readonly instance?: ITerminalInstance;
	/** An agent's background task: the file it writes its output to. */
	readonly file?: URI;
	readonly preserveFocus: boolean;
}

export const IAgentTerminalsService = createDecorator<IAgentTerminalsService>('agentTerminalsService');

/**
 * Long-running commands of a chat (dev servers, watchers, `docker compose up`) in real terminals.
 * The pty host runs the process; this service watches its output, readiness and exit whether or
 * not its tab is open, so the agent keeps working and the chat shows it as a chip. The tab opens
 * in the chat's tools only when the user asks (a chip click), never on start.
 */
export interface IAgentTerminalsService {
	readonly _serviceBrand: undefined;
	/** A chat's terminals changed (fires with the chat id). */
	readonly onDidChange: Event<string>;
	/** Someone asked to see a terminal; the chat's editor opens it in its tools. */
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest>;
	list(chatId: string): readonly IAgentTerminalInfo[];
	get(id: string): IAgentTerminalInfo | undefined;
	start(chatId: string, options: IAgentTerminalStart): Promise<IAgentTerminalInfo>;
	stop(id: string): Promise<void>;
	restart(id: string): Promise<IAgentTerminalInfo | undefined>;
	/** Forgets a finished terminal (its chip goes away). */
	dismiss(id: string): void;
	reveal(id: string, preserveFocus?: boolean): void;
	/** Plain-text output after `offset` (all of it kept when omitted). */
	output(id: string, offset?: number): { readonly text: string; readonly offset: number } | undefined;
}

/** Output kept per terminal: the head whole, then a rolling tail. */
const MAX_LOG_CHARS = 2_000_000;
const HEAD_CHARS = 8_000;
/** What a tool result shows of a terminal's output at most. */
const RESULT_CHARS = 12_000;
/** Starting with output, then this long quiet: it is up even without a ready line. */
const SETTLE_QUIET_MS = 2_500;
/** Starting this long without a ready signal: show it as running, not as pending. */
const SETTLE_MAX_MS = 20_000;
const DEFAULT_START_WAIT_MS = 8_000;
const MAX_START_WAIT_MS = 60_000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 600_000;
/** After Ctrl+C, how long a process gets before it is killed. */
const STOP_GRACE_MS = 2_500;
/** Live terminals a chat may have at once. */
const MAX_LIVE_PER_CHAT = 12;
/** Finished terminals a chat keeps listed. */
const MAX_FINISHED_PER_CHAT = 8;
/** Finished without error: the chip stays this long, then goes. Failures stay until dismissed. */
const FINISHED_CHIP_MS = 60_000;
/** An agent's background task: its output file is read at most this often. */
const TASK_READ_MS = 1_000;
/** Most of a task's output file read in one go. */
const TASK_READ_CHUNK = 256 * 1024;

/** A CLI agent's own background command, followed through the file it writes its output to. */
interface IAgentTask {
	readonly taskId: string;
	file: URI | undefined;
	/** Bytes of the file already read. */
	offset: number;
	reading: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** Head kept whole, the rest rolling; offsets are absolute positions in everything ever written. */
class TerminalLog {
	private head = '';
	private readonly chunks: string[] = [];
	private size = 0;
	total = 0;

	append(text: string): void {
		if (!text) {
			return;
		}
		this.total += text.length;
		if (this.head.length < HEAD_CHARS) {
			const room = HEAD_CHARS - this.head.length;
			this.head += text.slice(0, room);
			text = text.slice(room);
			if (!text) {
				return;
			}
		}
		this.chunks.push(text);
		this.size += text.length;
		while (this.size > MAX_LOG_CHARS && this.chunks.length > 1) {
			this.size -= this.chunks.shift()!.length;
		}
	}

	since(offset: number): string {
		const tailStart = this.total - this.size;
		const from = Math.max(0, Math.min(offset, this.total));
		if (from >= tailStart) {
			// Walk back from the end: only the chunks after `from` are joined, however long the log.
			const parts: string[] = [];
			let position = this.total;
			for (let i = this.chunks.length - 1; i >= 0 && position > from; i--) {
				const chunk = this.chunks[i];
				const chunkStart = position - chunk.length;
				parts.push(chunkStart >= from ? chunk : chunk.slice(from - chunkStart));
				position = chunkStart;
			}
			return parts.reverse().join('');
		}
		const tail = this.chunks.join('');
		if (from < this.head.length) {
			const gap = tailStart > this.head.length ? `\n[... ${tailStart - this.head.length} characters dropped ...]\n` : '';
			return this.head.slice(from) + gap + tail;
		}
		return `[... ${tailStart - from} characters dropped ...]\n${tail}`;
	}

	/** About the last `chars` characters written. */
	tail(chars: number): string {
		return this.since(Math.max(0, this.total - chars));
	}
}

class ManagedTerminal {
	status: AgentTerminalStatus = 'starting';
	exitCode: number | undefined;
	endedAt: number | undefined;
	lastActivity = Date.now();
	readonly startedAt = Date.now();
	readonly urls = new Set<string>();
	error: string | undefined;
	instance: ITerminalInstance | undefined;
	readonly log = new TerminalLog();
	/** Where the agent's last read ended; waits look only at what came after. */
	agentOffset = 0;
	stopRequested = false;
	readonly listeners = new Set<() => void>();
	readonly store = new DisposableStore();
	settleTimer: ReturnType<typeof setTimeout> | undefined;
	hideTimer: ReturnType<typeof setTimeout> | undefined;
	/** Set for a CLI agent's background task instead of a Volt terminal. */
	task: IAgentTask | undefined;

	constructor(
		readonly id: string,
		readonly chatId: string,
		readonly command: string,
		readonly label: string,
		readonly cwd: string | undefined,
		readonly readyPattern: RegExp | undefined,
		readonly readySource: string | undefined,
	) { }

	info(): IAgentTerminalInfo {
		return {
			id: this.id,
			chatId: this.chatId,
			command: this.command,
			label: this.label,
			cwd: this.cwd,
			status: this.status,
			startedAt: this.startedAt,
			...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
			lastActivity: this.lastActivity,
			...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
			urls: [...this.urls],
			...(this.error ? { error: this.error } : {}),
			viewable: this.task ? !!this.task.file : !!this.instance && !this.instance.isDisposed,
			kind: this.task ? 'agent-task' : 'terminal',
		};
	}

	notify(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	dispose(): void {
		clearTimeout(this.settleTimer);
		clearTimeout(this.hideTimer);
		clearTimeout(this.task?.timer);
		this.store.dispose();
		this.listeners.clear();
	}
}

export class AgentTerminalsService extends Disposable implements IAgentTerminalsService {

	declare readonly _serviceBrand: undefined;

	private readonly terminals = new Map<string, ManagedTerminal>();
	/** CLI agents' background tasks, by chat and task id. */
	private readonly tasks = new Map<string, ManagedTerminal>();
	private nextId = 1;
	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	private readonly _onDidRequestReveal = this._register(new Emitter<IAgentTerminalRevealRequest>());
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest> = this._onDidRequestReveal.event;
	/** Change events of one tick go out once per chat. */
	private readonly dirtyChats = new Set<string>();
	private changeScheduled = false;

	constructor(
		@ITerminalInstanceService private readonly instanceService: ITerminalInstanceService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@ITerminalProfileService private readonly profileService: ITerminalProfileService,
		@IAgentWorkspaceService workspaceService: IAgentWorkspaceService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(this.runtime.onDidChangeAgentBackgroundTask(task => this.onAgentTask(task)));
		// A deleted chat takes its terminals with it.
		this._register(workspaceService.onDidChange(e => {
			if (e.slot === undefined && !workspaceService.get(e.sessionId)) {
				for (const terminal of [...this.terminals.values()].filter(candidate => candidate.chatId === e.sessionId)) {
					this.forget(terminal, true);
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const terminal of this.terminals.values()) {
				terminal.dispose();
			}
			this.terminals.clear();
		}));
	}

	list(chatId: string): readonly IAgentTerminalInfo[] {
		return [...this.terminals.values()].filter(terminal => terminal.chatId === chatId).map(terminal => terminal.info());
	}

	get(id: string): IAgentTerminalInfo | undefined {
		return this.terminals.get(id)?.info();
	}

	output(id: string, offset?: number): { readonly text: string; readonly offset: number } | undefined {
		const terminal = this.terminals.get(id);
		return terminal ? { text: terminal.log.since(offset ?? 0), offset: terminal.log.total } : undefined;
	}

	async start(chatId: string, options: IAgentTerminalStart): Promise<IAgentTerminalInfo> {
		const live = [...this.terminals.values()].filter(terminal => terminal.chatId === chatId && isTerminalLive(terminal.status));
		if (live.length >= MAX_LIVE_PER_CHAT) {
			throw new Error(`This chat already runs ${live.length} terminals. Stop one with terminal_stop first (terminal_list shows them).`);
		}
		const command = options.command.trim();
		const terminal = new ManagedTerminal(
			`term-${this.nextId++}`,
			chatId,
			command,
			options.label?.trim() || terminalLabelFor(command),
			options.cwd ?? this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath,
			agentPattern(options.readyPattern),
			options.readyPattern,
		);
		this.terminals.set(terminal.id, terminal);
		this.pruneFinished(chatId);
		await this.launch(terminal);
		this.changed(terminal);
		return terminal.info();
	}

	async stop(id: string): Promise<void> {
		const terminal = this.terminals.get(id);
		if (!terminal || !isTerminalLive(terminal.status)) {
			return;
		}
		terminal.stopRequested = true;
		this.setStatus(terminal, 'stopping');
		if (terminal.task) {
			// The agent owns the process: ask it to stop; its state update ends the chip.
			await this.runtime.stopAgentBackgroundTask(terminal.chatId, terminal.task.taskId).catch(() => this.finish(terminal, undefined));
			return;
		}
		const instance = terminal.instance;
		if (!instance || instance.isDisposed) {
			this.finish(terminal, undefined);
			return;
		}
		// Ctrl+C first, as a person would: servers shut down cleanly and print why.
		await instance.sendText('\u0003', false).catch(() => undefined);
		const exited = await new Promise<boolean>(resolve => {
			const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
			terminal.listeners.add(function check() {
				if (!isTerminalLive(terminal.status) || terminal.status !== 'stopping') {
					clearTimeout(timer);
					terminal.listeners.delete(check);
					resolve(true);
				}
			});
		});
		if (!exited && terminal.instance && !terminal.instance.isDisposed) {
			terminal.instance.dispose(TerminalExitReason.Extension);
		}
	}

	async restart(id: string): Promise<IAgentTerminalInfo | undefined> {
		const terminal = this.terminals.get(id);
		if (!terminal || terminal.task) {
			return undefined;
		}
		await this.stop(id);
		this.forget(terminal, true);
		return this.start(terminal.chatId, { command: terminal.command, label: terminal.label, cwd: terminal.cwd, readyPattern: terminal.readySource });
	}

	dismiss(id: string): void {
		const terminal = this.terminals.get(id);
		if (terminal && !isTerminalLive(terminal.status)) {
			this.forget(terminal, true);
		}
	}

	reveal(id: string, preserveFocus = true): void {
		const terminal = this.terminals.get(id);
		if (terminal?.task?.file) {
			this._onDidRequestReveal.fire({ chatId: terminal.chatId, file: terminal.task.file, preserveFocus });
			return;
		}
		const instance = terminal?.instance;
		if (terminal && instance && !instance.isDisposed) {
			this._onDidRequestReveal.fire({ chatId: terminal.chatId, instance, preserveFocus });
		}
	}

	// --- Lifecycle -------------------------------------------------------------------------------

	private async launch(terminal: ManagedTerminal): Promise<void> {
		const shell = await this.shell();
		const env: Record<string, string> = {
			...projectRunEnv(terminal.cwd),
			VOLT_AGENT_TERMINAL: '1',
			GIT_PAGER: 'cat',
			PAGER: 'cat',
		};
		const launch: IShellLaunchConfig = {
			name: terminal.label,
			executable: shell.file,
			args: shell.args(terminal.command),
			cwd: terminal.cwd,
			env,
			// The tab keeps the last screen and exit status until the user closes it.
			waitOnExit: code => code
				? `\r\n\u001b[2m${localize('voltAgent.terminal.exitedCode', "{0} exited with code {1}", terminal.label, code)}\u001b[0m`
				: `\r\n\u001b[2m${localize('voltAgent.terminal.finished', "{0} finished", terminal.label)}\u001b[0m`,
			// Never revived on reload: that would run the command again.
			isTransient: true,
		};
		let instance: ITerminalInstance;
		try {
			instance = this.instanceService.createInstance(launch, TerminalLocation.Editor);
			// Known to the terminal editors, so a chip click can open it, but not opened: no tab, no panel.
			this.terminalEditorService.resolveResource(instance);
		} catch (err) {
			terminal.error = err instanceof Error ? err.message : String(err);
			this.finish(terminal, 1);
			return;
		}
		terminal.instance = instance;
		// As data arrives from the process, before xterm parses it: no lag behind the pty, view or no view.
		terminal.store.add(instance.onWillData(data => this.onData(terminal, data)));
		terminal.store.add(instance.onExit(code => {
			if (typeof code === 'object' && code) {
				terminal.error = code.message;
				this.finish(terminal, code.code ?? 1);
				return;
			}
			this.finish(terminal, typeof code === 'number' ? code : instance.exitCode);
		}));
		terminal.store.add(instance.onDisposed(() => {
			terminal.instance = undefined;
			if (isTerminalLive(terminal.status)) {
				// The user closed the tab of a running process: it is gone.
				terminal.stopRequested = true;
				this.finish(terminal, undefined);
			} else {
				this.changed(terminal);
			}
		}));
		terminal.settleTimer = setTimeout(() => this.settle(terminal), SETTLE_MAX_MS);
		void instance.processReady.catch(err => {
			terminal.error = err instanceof Error ? err.message : String(err);
			this.finish(terminal, 1);
		});
	}

	private onData(terminal: ManagedTerminal, data: string): void {
		const text = plainTerminalText(data);
		if (!text) {
			return;
		}
		// The window a signal can straddle: the end of what came before plus this chunk.
		const recent = terminal.log.tail(400) + text;
		terminal.log.append(text);
		terminal.lastActivity = Date.now();
		for (const url of localUrlsIn(text)) {
			terminal.urls.add(url);
		}
		const error = lastErrorLine(text);
		if (error) {
			terminal.error = error;
		}
		if (terminal.status === 'starting' || terminal.status === 'running' || terminal.status === 'attention') {
			if (terminal.readyPattern ? terminal.readyPattern.test(recent) : looksReady(recent)) {
				this.setStatus(terminal, 'ready');
			} else if (looksLikePrompt(recent)) {
				this.setStatus(terminal, 'attention');
			} else if (terminal.status === 'attention') {
				this.setStatus(terminal, 'running');
			} else if (terminal.status === 'starting') {
				clearTimeout(terminal.settleTimer);
				terminal.settleTimer = setTimeout(() => this.settle(terminal), SETTLE_QUIET_MS);
			}
		} else if (terminal.status === 'ready' && looksLikePrompt(recent)) {
			this.setStatus(terminal, 'attention');
		}
		terminal.notify();
		this.changed(terminal);
	}

	/** Started, printed something, then went quiet (or took too long): running, not pending. */
	private settle(terminal: ManagedTerminal): void {
		if (terminal.status === 'starting') {
			this.setStatus(terminal, 'running');
		}
	}

	private finish(terminal: ManagedTerminal, exitCode: number | undefined): void {
		if (!isTerminalLive(terminal.status)) {
			return;
		}
		clearTimeout(terminal.settleTimer);
		terminal.exitCode = exitCode;
		terminal.endedAt = Date.now();
		if (terminal.stopRequested) {
			terminal.status = 'stopped';
		} else if (exitCode === 0) {
			terminal.status = 'completed';
		} else {
			terminal.status = 'failed';
			terminal.error = terminal.error ?? lastErrorLine(terminal.log.tail(4_000)) ?? (exitCode !== undefined ? `Exited with code ${exitCode}` : 'The process ended');
		}
		if (terminal.status !== 'failed') {
			terminal.hideTimer = setTimeout(() => this.forget(terminal, false), FINISHED_CHIP_MS);
		}
		terminal.notify();
		this.changed(terminal);
	}

	private setStatus(terminal: ManagedTerminal, status: AgentTerminalStatus): void {
		if (terminal.status === status) {
			return;
		}
		if (status !== 'starting') {
			clearTimeout(terminal.settleTimer);
		}
		terminal.status = status;
		terminal.notify();
		this.changed(terminal);
	}

	/** Drops a terminal from the chat; `kill` also ends its process and closes its tab. */
	private forget(terminal: ManagedTerminal, kill: boolean): void {
		if (this.terminals.get(terminal.id) !== terminal) {
			return;
		}
		if (!kill && terminal.instance && !terminal.instance.isDisposed && isTerminalLive(terminal.status)) {
			return;
		}
		this.terminals.delete(terminal.id);
		if (terminal.task) {
			this.tasks.delete(`${terminal.chatId}\0${terminal.task.taskId}`);
		}
		const instance = terminal.instance;
		terminal.dispose();
		if (kill && instance && !instance.isDisposed) {
			instance.dispose(TerminalExitReason.Extension);
		}
		this.markDirty(terminal.chatId);
	}

	private pruneFinished(chatId: string): void {
		const finished = [...this.terminals.values()]
			.filter(terminal => terminal.chatId === chatId && !isTerminalLive(terminal.status))
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		for (const terminal of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_PER_CHAT))) {
			this.forget(terminal, true);
		}
	}

	private changed(terminal: ManagedTerminal): void {
		this.markDirty(terminal.chatId);
	}

	/** Output arrives in bursts; the chips redraw once per burst, not per chunk. */
	private markDirty(chatId: string): void {
		this.dirtyChats.add(chatId);
		if (this.changeScheduled) {
			return;
		}
		this.changeScheduled = true;
		queueMicrotask(() => {
			this.changeScheduled = false;
			const chats = [...this.dirtyChats];
			this.dirtyChats.clear();
			for (const chat of chats) {
				this._onDidChange.fire(chat);
			}
		});
	}

	// --- CLI agents' own background tasks ---------------------------------------------------------

	private onAgentTask(task: IVoltAgentBackgroundTask): void {
		const key = `${task.chatId}\0${task.taskId}`;
		let terminal = this.tasks.get(key);
		if (!terminal) {
			if (task.state !== 'running') {
				return;
			}
			const label = task.label.length > 28 ? `${task.label.slice(0, 27)}\u2026` : task.label;
			terminal = new ManagedTerminal(`term-${this.nextId++}`, task.chatId, task.label, label, undefined, undefined, undefined);
			terminal.task = { taskId: task.taskId, file: undefined, offset: 0, reading: false, timer: undefined };
			this.terminals.set(terminal.id, terminal);
			this.tasks.set(key, terminal);
			terminal.settleTimer = setTimeout(() => this.settle(terminal!), SETTLE_MAX_MS);
			this.pruneFinished(task.chatId);
		}
		const managed = terminal;
		const agentTask = managed.task!;
		if (task.outputFilePath && !agentTask.file) {
			agentTask.file = URI.file(task.outputFilePath);
		}
		if (task.state === 'running') {
			this.scheduleTaskRead(managed);
			this.changed(managed);
			return;
		}
		if (task.state === 'stopped') {
			managed.stopRequested = true;
		}
		if (task.summary && task.state === 'failed') {
			managed.error = task.summary;
		}
		// The last output first, then the end, so a failure's reason is in the log.
		clearTimeout(agentTask.timer);
		agentTask.timer = undefined;
		void this.readTask(managed).finally(() => this.finish(managed, task.state === 'completed' ? 0 : task.state === 'failed' ? 1 : undefined));
	}

	private scheduleTaskRead(terminal: ManagedTerminal): void {
		const task = terminal.task;
		if (!task?.file || task.timer) {
			return;
		}
		task.timer = setTimeout(() => {
			task.timer = undefined;
			void this.readTask(terminal).then(() => {
				if (isTerminalLive(terminal.status) && this.terminals.get(terminal.id) === terminal) {
					this.scheduleTaskRead(terminal);
				}
			});
		}, TASK_READ_MS);
	}

	/** Reads what the task wrote since the last read and feeds it through the usual signals. */
	private async readTask(terminal: ManagedTerminal): Promise<void> {
		const task = terminal.task;
		if (!task?.file || task.reading) {
			return;
		}
		task.reading = true;
		try {
			const stat = await this.fileService.stat(task.file);
			if (stat.size <= task.offset) {
				return;
			}
			const content = await this.fileService.readFile(task.file, { position: task.offset, length: Math.min(TASK_READ_CHUNK, stat.size - task.offset) });
			task.offset += content.value.byteLength;
			this.onData(terminal, content.value.toString());
		} catch {
			// Not written yet, or already cleaned up.
		} finally {
			task.reading = false;
		}
	}

	/** A POSIX shell for the agent's command lines; fish and friends fall back to zsh or bash. */
	private async shell(): Promise<{ file: string; args: (command: string) => string[] }> {
		if (isWindows) {
			return { file: 'cmd.exe', args: command => ['/d', '/s', '/c', command] };
		}
		if (this.profileService.availableProfiles.length === 0) {
			await Promise.race([this.profileService.profilesReady, new Promise(resolve => setTimeout(resolve, 500))]);
		}
		let path: string | undefined;
		try {
			path = this.profileService.getDefaultProfile()?.path;
		} catch {
			path = undefined;
		}
		const posix = path && /^(zsh|bash|sh|dash|ksh)$/.test(basename(path)) ? path : undefined;
		return { file: posix ?? (isMacintosh ? '/bin/zsh' : '/bin/bash'), args: command => ['-c', command] };
	}

	// --- Waiting, for the tools ------------------------------------------------------------------

	/** Resolves when `done` holds, the terminal ends, `timeoutMs` passes or `token` is cancelled. */
	waitFor(id: string, done: (terminal: ManagedTerminal) => boolean, timeoutMs: number, token: CancellationToken): Promise<void> {
		const terminal = this.terminals.get(id);
		if (!terminal || done(terminal) || !isTerminalLive(terminal.status)) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const finish = () => {
				clearTimeout(timer);
				terminal.listeners.delete(check);
				cancel.dispose();
				resolve();
			};
			const check = () => {
				if (done(terminal) || !isTerminalLive(terminal.status)) {
					finish();
				}
			};
			const timer = setTimeout(finish, timeoutMs);
			const cancel = token.onCancellationRequested(finish);
			terminal.listeners.add(check);
		});
	}

	managed(id: string): ManagedTerminal | undefined {
		return this.terminals.get(id);
	}

	/** The chat a tool call belongs to: a subagent's terminals are its parent chat's. */
	chatOf(call: IVoltHostToolCall | undefined): string | undefined {
		return call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
	}
}

registerSingleton(IAgentTerminalsService, AgentTerminalsService, InstantiationType.Delayed);

// --- Host tools ------------------------------------------------------------------------------------

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function int(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value ?? fallback));
}

/** Long output: a little of the start, most of the end (failures are at the end). */
function shape(text: string, limit = RESULT_CHARS): string {
	if (text.length <= limit) {
		return text;
	}
	const head = Math.floor(limit * 0.2);
	const tail = limit - head;
	return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters omitted ...]\n${text.slice(-tail)}`;
}

function describeStatus(info: IAgentTerminalInfo): string {
	switch (info.status) {
		case 'starting': return 'starting';
		case 'running': return 'running';
		case 'ready': return 'ready';
		case 'attention': return 'waiting for input';
		case 'stopping': return 'stopping';
		case 'completed': return 'exited 0';
		case 'failed': return info.exitCode !== undefined ? `exited ${info.exitCode}` : 'failed';
		case 'stopped': return 'stopped';
	}
}

function header(info: IAgentTerminalInfo, offset: number): string {
	const parts = [`${info.id}`, info.label, describeStatus(info)];
	if (info.urls.length) {
		parts.push(info.urls.slice(0, 3).join(' '));
	}
	parts.push(`offset ${offset}`);
	return `[${parts.join(' \u00b7 ')}]`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DOCKER_POLL_MS = 1_000;

/**
 * The terminal_* tools plus docker_ensure and app_open, for every agent of the window: CLI agents
 * get them over Volt's MCP server, Volt's own loop through its tool list.
 */
class AgentTerminalTools extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentTerminals';

	private readonly service: AgentTerminalsService;

	constructor(
		@IAgentTerminalsService service: IAgentTerminalsService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this.service = service as AgentTerminalsService;
		this._register(hostTools.registerToolProvider({
			tools: TERMINAL_TOOLS,
			invoke: (name, args, call) => this.invoke(name as VoltTerminalToolName, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: VoltTerminalToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const token = call?.token ?? CancellationToken.None;
		if (name === DOCKER_ENSURE_TOOL_NAME) {
			return this.dockerEnsure(args, call, token);
		}
		if (name === APP_OPEN_TOOL_NAME) {
			return this.appOpen(args, call);
		}
		const chatId = this.service.chatOf(call);
		if (!chatId) {
			return { error: `${name} needs a Volt chat.` };
		}
		if (name === TERMINAL_LIST_TOOL_NAME) {
			const terminals = this.service.list(chatId);
			if (!terminals.length) {
				return { text: 'No terminals in this chat. Start one with terminal_start.' };
			}
			return {
				text: terminals.map(info => `- ${info.id} \u00b7 ${info.label} \u00b7 ${describeStatus(info)}${info.urls.length ? ` \u00b7 ${info.urls.join(' ')}` : ''}\n  $ ${info.command}${info.error && info.status === 'failed' ? `\n  ${info.error}` : ''}`).join('\n'),
			};
		}
		if (name === TERMINAL_START_TOOL_NAME) {
			return this.startTool(chatId, args, call, token);
		}
		const id = str(args.id)?.trim() ?? '';
		const terminal = this.service.managed(id);
		if (!terminal || terminal.chatId !== chatId) {
			return { error: `No terminal ${id || '(missing id)'} in this chat. terminal_list shows them.` };
		}
		switch (name) {
			case TERMINAL_OUTPUT_TOOL_NAME: {
				const offset = int(args.offset);
				const text = offset === undefined ? terminal.log.tail(RESULT_CHARS) : terminal.log.since(offset);
				terminal.agentOffset = terminal.log.total;
				return { text: `${header(terminal.info(), terminal.log.total)}\n${shape(text).trim() || '(no new output)'}` };
			}
			case TERMINAL_WAIT_TOOL_NAME: {
				const from = terminal.agentOffset;
				const until = agentPattern(str(args.until));
				const wasReady = terminal.status === 'ready';
				await this.service.waitFor(id, managed => {
					const fresh = managed.log.since(from);
					return until ? until.test(fresh) : (!wasReady && managed.status === 'ready') || managed.status === 'attention';
				}, clamp(int(args.timeout_ms), DEFAULT_WAIT_MS, 100, MAX_WAIT_MS), token);
				const fresh = terminal.log.since(from);
				terminal.agentOffset = terminal.log.total;
				const matched = until ? (until.test(fresh) ? ' \u00b7 pattern matched' : ' \u00b7 pattern not seen yet') : '';
				return { text: `${header(terminal.info(), terminal.log.total)}${matched}\n${shape(fresh).trim() || '(no new output)'}` };
			}
			case TERMINAL_SEND_TOOL_NAME: {
				const instance = terminal.instance;
				if (!instance || instance.isDisposed || !isTerminalLive(terminal.status)) {
					return { error: `${id} is not running (${describeStatus(terminal.info())}).` };
				}
				const text = (typeof args.text === 'string' ? args.text : '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
				await instance.sendText(text, args.enter !== false);
				return { text: `Sent to ${id}. Read the reply with terminal_wait.` };
			}
			case TERMINAL_STOP_TOOL_NAME: {
				await this.service.stop(id);
				const info = terminal.info();
				return { text: `${header(info, terminal.log.total)}\n${shape(terminal.log.tail(2_000)).trim()}` };
			}
		}
	}

	private async startTool(chatId: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined, token: CancellationToken): Promise<IVoltHostToolResult> {
		const command = str(args.command);
		if (!command) {
			return { error: 'command is required.' };
		}
		const cwd = this.resolveCwd(str(args.cwd), call);
		const info = await this.service.start(chatId, { command, label: str(args.title)?.trim(), cwd, readyPattern: str(args.ready_pattern) });
		const waitMs = clamp(int(args.wait_ms), DEFAULT_START_WAIT_MS, 0, MAX_START_WAIT_MS);
		if (waitMs > 0) {
			await this.service.waitFor(info.id, managed => managed.status !== 'starting', waitMs, token);
		}
		const terminal = this.service.managed(info.id);
		if (!terminal) {
			return { error: `${info.id} ended before it could be read.` };
		}
		terminal.agentOffset = terminal.log.total;
		const now = terminal.info();
		const output = shape(terminal.log.since(0), 6_000).trim() || '(no output yet)';
		const body = `${header(now, terminal.log.total)}\n$ ${command}${cwd ? `   (in ${cwd})` : ''}\n${output}`;
		if (now.status === 'failed') {
			return { error: `${body}\n[${now.id} failed${now.error ? `: ${now.error}` : ''}. Fix the cause and start it again.]` };
		}
		const next = isTerminalLive(now.status)
			? `[${now.id} keeps running; the user sees it as a chip in the chat. Keep working: terminal_output / terminal_wait read it, terminal_stop stops it.]`
			: `[${now.id} already finished. If it should keep running, it probably needs a different command.]`;
		return { text: `${body}\n${next}` };
	}

	private resolveCwd(requested: string | undefined, call: IVoltHostToolCall | undefined): string | undefined {
		const base = call?.cwd;
		if (!requested) {
			return base;
		}
		if (requested.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(requested)) {
			return requested;
		}
		return base ? URI.joinPath(URI.file(base), requested).fsPath : requested;
	}

	// --- Docker and apps -------------------------------------------------------------------------

	private async run(command: string, cwd: string | undefined, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
		const result = await this.stdio.exec({ id: `docker-${Math.random().toString(36).slice(2, 10)}`, command, cwd, timeoutMs, inlineChars: 4_000 });
		return { ok: result.exitCode === 0 && !result.timedOut, out: result.combined.trim() };
	}

	private async dockerEnsure(args: Record<string, unknown>, call: IVoltHostToolCall | undefined, token: CancellationToken): Promise<IVoltHostToolResult> {
		const started = Date.now();
		const cwd = call?.cwd;
		const docker = await this.stdio.which('docker');
		if (!docker) {
			const app = isMacintosh && await this.fileService.exists(URI.file('/Applications/Docker.app')).catch(() => false);
			return {
				error: app
					? 'Docker Desktop is installed but its `docker` CLI is not on PATH. In Docker Desktop: Settings > Advanced > "System" CLI tools, or use /Applications/Docker.app/Contents/Resources/bin/docker.'
					: 'Docker is not installed (no `docker` on PATH). Ask the user to install Docker Desktop or OrbStack (`brew install --cask orbstack`).',
			};
		}
		const probe = () => this.run('docker info --format "{{.ServerVersion}}"', cwd, 8_000);
		let status = await probe();
		if (status.ok) {
			return { text: `Docker is running (server ${status.out.split('\n').pop()}, CLI ${docker}). Checked in ${((Date.now() - started) / 1000).toFixed(1)}s.` };
		}
		if (/permission denied/i.test(status.out)) {
			return { error: `The Docker daemon is running but this user may not use it: ${status.out.split('\n')[0]}. On Linux, add the user to the docker group (then log in again).` };
		}
		if (args.start === false) {
			return { error: `The Docker daemon is not running: ${status.out.split('\n')[0] || 'no answer'}` };
		}
		const how = await this.startDocker(cwd);
		if (!how) {
			return { error: `The Docker daemon is not running and Volt does not know how to start it on this machine: ${status.out.split('\n')[0] || 'no answer'}. Ask the user to start Docker.` };
		}
		const deadline = Date.now() + clamp(int(args.timeout_ms), 90_000, 5_000, 300_000);
		while (Date.now() < deadline && !token.isCancellationRequested) {
			await new Promise(resolve => setTimeout(resolve, DOCKER_POLL_MS));
			status = await probe();
			if (status.ok) {
				return { text: `Docker is running (server ${status.out.split('\n').pop()}). Started ${how} and it answered after ${((Date.now() - started) / 1000).toFixed(1)}s.` };
			}
		}
		return { error: token.isCancellationRequested ? 'Cancelled while waiting for Docker.' : `Started ${how}, but the daemon did not answer in time: ${status.out.split('\n')[0] || 'no answer'}. It may still be starting; call docker_ensure again.` };
	}

	/** Starts whichever Docker this machine has; returns its name, or undefined when there is none to start. */
	private async startDocker(cwd: string | undefined): Promise<string | undefined> {
		if (await this.stdio.which('orb')) {
			void this.run('orb start', cwd, 60_000);
			return 'OrbStack';
		}
		if (isMacintosh && await this.fileService.exists(URI.file('/Applications/Docker.app')).catch(() => false)) {
			// -g: in the background, so Volt keeps focus.
			const opened = await this.run('open -g -a Docker', cwd, 10_000);
			return opened.ok ? 'Docker Desktop' : undefined;
		}
		if (await this.stdio.which('colima')) {
			void this.run('colima start', cwd, 300_000);
			return 'Colima';
		}
		if (!isMacintosh && !isWindows && await this.stdio.which('systemctl')) {
			const user = await this.run('systemctl --user start docker-desktop', cwd, 15_000);
			return user.ok ? 'Docker Desktop' : undefined;
		}
		return undefined;
	}

	private async appOpen(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const target = str(args.target)?.trim();
		if (!target) {
			return { error: 'target is required.' };
		}
		const focus = args.focus === true;
		let command: string;
		if (isMacintosh) {
			const flags = focus ? '' : '-g ';
			const isPath = /^(?:\/|~\/|\.{1,2}\/)/.test(target);
			const isUrl = /^[a-z][\w+.-]*:\/\//i.test(target);
			const isBundle = !isPath && !isUrl && /^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/i.test(target);
			command = isPath || isUrl ? `open ${flags}${shellQuote(target)}` : isBundle ? `open ${flags}-b ${shellQuote(target)}` : `open ${flags}-a ${shellQuote(target)}`;
		} else if (isWindows) {
			command = `start "" ${JSON.stringify(target)}`;
		} else {
			command = `xdg-open ${shellQuote(target)} >/dev/null 2>&1 &`;
		}
		const result = await this.run(command, call?.cwd, 15_000);
		return result.ok ? { text: `Opened ${target}${focus ? '' : ' in the background'}.` } : { error: `Could not open ${target}: ${result.out || 'the system refused'}` };
	}
}

registerWorkbenchContribution2(AgentTerminalTools.ID, AgentTerminalTools, WorkbenchPhase.AfterRestored);
