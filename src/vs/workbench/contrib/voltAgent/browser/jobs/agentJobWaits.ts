/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import {
	CHECK_TIMEOUT_MS, IJobCheckOutcome, IJobCheckRun, IJobWatchSpec, JOB_WATCH_TOOLS, JobEnd, jobWakeMessage, judgeJobCheck, latestOutputLine, MAX_BROKEN_CHECKS, parseJobWatchArgs,
	UNWATCH_JOB_TOOL_NAME, WATCH_JOB_TOOL_NAME,
} from '../../../../services/voltRuntime/common/jobs/jobWatch.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IAgentTerminalInfo, IAgentTerminalsService } from '../terminals/agentTerminals.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

/** Live watches a chat may have at once. */
const MAX_WATCHES_PER_CHAT = 5;
/** Output of an agent's background command read for its row and its wake message. */
const TAIL_CHARS = 4_000;
const STORAGE_KEY = 'volt.agent.jobWatches';
const SAVE_MS = 1_000;

/**
 * - `running`: Volt still checks it.
 * - `done` / `failed` / `timedOut` / `broken`: how it ended (see {@link JobEnd}).
 * - `stopped`: the user or the agent stopped watching it.
 */
export type AgentJobWaitState = 'running' | JobEnd | 'stopped';

/** One job the chat waits on, as its row draws it. */
export interface IAgentJobWait {
	readonly id: string;
	readonly chatId: string;
	readonly title: string;
	/** `watch`: the agent told Volt how to check it (watch_job). `agent-task`: the agent's own background command, which Volt sees start and end. */
	readonly source: 'watch' | 'agent-task';
	readonly state: AgentJobWaitState;
	readonly startedAt: number;
	readonly endedAt?: number;
	/** The latest line it printed (or its check printed). */
	readonly line?: string;
	/** 0 to 1, when it said how far along it is. */
	readonly progress?: number;
	/** `watch`: the command Volt runs to check it. */
	readonly check?: string;
	readonly everyMs?: number;
	/** `agent-task`: its terminal, to open its output. */
	readonly terminalId?: string;
	/** The agent was told it ended (its reply follows). */
	readonly reported?: boolean;
}

export const IAgentJobWaitsService = createDecorator<IAgentJobWaitsService>('agentJobWaitsService');

/**
 * Jobs a chat's agent left running past its turn while the user waits for the result: ones the
 * agent told Volt how to check (watch_job), and its own background commands (Claude's
 * `run_in_background` Bash), which Volt sees start and end. While the agent is idle the chat shows
 * them under its last reply; when one ends, Volt wakes the agent to report the result.
 */
export interface IAgentJobWaitsService {
	readonly _serviceBrand: undefined;
	/** A chat's jobs changed (fires with the chat id). */
	readonly onDidChange: Event<string>;
	/** What the chat shows under its last reply now. */
	visible(chatId: string): readonly IAgentJobWait[];
	/** Stops waiting on it: no more checks, and the agent is not woken for it. The job itself keeps running. */
	stop(id: string): void;
	/** Opens what it printed (an agent's background command). */
	reveal(id: string): void;
}

/** What a watch starts from (and what is written down to start it again after a reload). */
interface IWatchInit {
	readonly id: string;
	readonly chatId: string;
	readonly spec: IJobWatchSpec;
	readonly cwd: string | undefined;
	readonly startedAt: number;
	readonly line?: string;
	readonly progress?: number;
	readonly output?: string;
}

function isWatchInit(value: unknown): value is IWatchInit {
	const item = value as Partial<IWatchInit> | undefined;
	const spec = item?.spec as Partial<IJobWatchSpec> | undefined;
	return !!item && typeof item.id === 'string' && typeof item.chatId === 'string' && typeof item.startedAt === 'number'
		&& !!spec && typeof spec.title === 'string' && typeof spec.everyMs === 'number' && typeof spec.timeoutMs === 'number'
		&& (typeof spec.check === 'string' || typeof spec.pid === 'number');
}

interface IWatch {
	readonly id: string;
	readonly chatId: string;
	readonly spec: IJobWatchSpec;
	readonly cwd: string | undefined;
	readonly startedAt: number;
	state: AgentJobWaitState;
	endedAt?: number;
	line?: string;
	progress?: number;
	output: string;
	reason?: string;
	broken: number;
	checks: number;
	reported: boolean;
	readonly timer: RunOnceScheduler;
}

/** An agent's background command Volt watches for the chat. */
interface ITaskSeen {
	/** It ran while the agent was idle, so the user was shown it waiting: its end wakes the agent. */
	waited: boolean;
	/** The user closed its row, or the agent took it over with watch_job. */
	ignored: boolean;
	line?: string;
	progress?: number;
	reading: boolean;
	/** Output arrived while it was being read. */
	again: boolean;
	ended: boolean;
}

const TASK_PREFIX = 'task:';

export class AgentJobWaitsService extends Disposable implements IAgentJobWaitsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;
	private readonly watches = new Map<string, IWatch>();
	/** Agent background commands by terminal id. */
	private readonly tasks = new Map<string, ITaskSeen>();
	/** Whether each chat was idle when last looked at, so only a turn starting or ending redraws. */
	private readonly idle = new Map<string, boolean>();
	private readonly saver: RunOnceScheduler;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentTerminalsService private readonly terminals: IAgentTerminalsService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorkspaceService workspace: IAgentWorkspaceService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storage: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: JOB_WATCH_TOOLS,
			invoke: (name, args, call) => this.invoke(name, args, call),
		}));
		// Running watches are written down, so a reloaded window keeps checking them.
		this.saver = this._register(new RunOnceScheduler(() => this.save(), SAVE_MS));
		this._register(this.onDidChange(() => {
			if (!this.saver.isScheduled()) {
				this.saver.schedule();
			}
		}));
		this._register(storage.onWillSaveState(() => this.save()));
		void this.restore();
		this._register(terminals.onDidChange(chatId => this.onTerminals(chatId)));
		this._register(orchestrator.onDidChange(change => {
			for (const chatId of change.threads) {
				const idle = this.isIdle(chatId);
				if (this.idle.get(chatId) !== idle) {
					this.idle.set(chatId, idle);
					if (this.hasJobs(chatId)) {
						this.onTurns(chatId, idle);
					}
				}
			}
		}));
		// The user's Stop: what the chat was waiting on for itself ends too (like pull request watches).
		this._register(orchestrator.onDidStop(chatId => {
			for (const watch of this.watchesOf(chatId)) {
				this.end(watch, 'stopped');
			}
		}));
		// A deleted chat takes its watches with it.
		this._register(workspace.onDidChange(e => {
			if (e.slot === undefined && !workspace.get(e.sessionId)) {
				for (const watch of this.watchesOf(e.sessionId, true)) {
					watch.timer.dispose();
					this.watches.delete(watch.id);
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const watch of this.watches.values()) {
				watch.timer.dispose();
			}
			this.watches.clear();
		}));
	}

	//#region What the chat shows

	visible(chatId: string): readonly IAgentJobWait[] {
		const idle = this.isIdle(chatId);
		const rows: IAgentJobWait[] = [];
		for (const watch of this.watchesOf(chatId, true)) {
			// Live ones under the idle agent's reply; one that ended without the agent hearing of it stays until the next turn.
			if (watch.state === 'running' ? idle : watch.state !== 'stopped' && !watch.reported) {
				rows.push(this.viewOf(watch));
			}
		}
		if (idle) {
			for (const info of this.terminals.list(chatId)) {
				const seen = this.tasks.get(info.id);
				if (isWaitableTask(info) && !seen?.ignored) {
					rows.push(this.taskView(info, seen));
				}
			}
		}
		return rows;
	}

	stop(id: string): void {
		if (id.startsWith(TASK_PREFIX)) {
			const terminalId = id.slice(TASK_PREFIX.length);
			const info = this.terminals.get(terminalId);
			this.seen(terminalId).ignored = true;
			if (info) {
				this._onDidChange.fire(info.chatId);
			}
			return;
		}
		const watch = this.watches.get(id);
		if (watch?.state === 'running') {
			this.end(watch, 'stopped');
		} else if (watch) {
			// An ended one the agent did not hear about: closing it is all that is left.
			this.watches.delete(id);
			this._onDidChange.fire(watch.chatId);
		}
	}

	reveal(id: string): void {
		if (id.startsWith(TASK_PREFIX)) {
			this.terminals.reveal(id.slice(TASK_PREFIX.length), false);
		}
	}

	private viewOf(watch: IWatch): IAgentJobWait {
		return {
			id: watch.id,
			chatId: watch.chatId,
			title: watch.spec.title,
			source: 'watch',
			state: watch.state,
			startedAt: watch.startedAt,
			...(watch.endedAt !== undefined ? { endedAt: watch.endedAt } : {}),
			...(watch.line ? { line: watch.line } : {}),
			...(watch.progress !== undefined ? { progress: watch.progress } : {}),
			...(watch.spec.check ? { check: watch.spec.check } : {}),
			everyMs: watch.spec.everyMs,
			reported: watch.reported,
		};
	}

	private taskView(info: IAgentTerminalInfo, seen: ITaskSeen | undefined): IAgentJobWait {
		return {
			id: `${TASK_PREFIX}${info.id}`,
			chatId: info.chatId,
			title: info.command || info.label,
			source: 'agent-task',
			state: 'running',
			startedAt: info.startedAt,
			...(seen?.line ? { line: seen.line } : {}),
			...(seen?.progress !== undefined ? { progress: seen.progress } : {}),
			terminalId: info.id,
		};
	}

	private isIdle(chatId: string): boolean {
		return !this.orchestrator.getThread(chatId)?.active;
	}

	private hasJobs(chatId: string): boolean {
		return this.watchesOf(chatId, true).length > 0 || this.terminals.list(chatId).some(info => info.kind === 'agent-task');
	}

	private watchesOf(chatId: string, all = false): IWatch[] {
		return [...this.watches.values()].filter(watch => watch.chatId === chatId && (all || watch.state === 'running'));
	}

	//#endregion

	//#region The tools

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const chatId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!chatId) {
			return { error: `${name} only works from a Volt chat.` };
		}
		try {
			switch (name) {
				case WATCH_JOB_TOOL_NAME: return await this.watch(chatId, args, call);
				case UNWATCH_JOB_TOOL_NAME: return this.unwatch(chatId, args);
			}
		} catch (err) {
			this.logService.warn(`[volt jobs] ${name} failed`, err);
			return { error: err instanceof Error ? err.message : String(err) };
		}
		return { error: `Unknown tool ${name}` };
	}

	private async watch(chatId: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const spec = parseJobWatchArgs(args);
		if ('error' in spec) {
			return { error: spec.error };
		}
		if (this.watchesOf(chatId).length >= MAX_WATCHES_PER_CHAT) {
			return { error: `This chat already watches ${MAX_WATCHES_PER_CHAT} jobs. Stop one with ${UNWATCH_JOB_TOOL_NAME} first.` };
		}
		const cwd = resolveCwd(spec.cwd, call?.cwd);
		// Unique across windows and reloads: the id also keys the wake, which is never sent twice.
		const id = `job-${generateUuid().slice(0, 6)}`;
		const first = await this.check(spec, cwd, `${id}-1`);
		const outcome = first.outcome;
		if (outcome.state === 'broken') {
			return { error: `The check did not work: ${outcome.reason}. Fix it (it runs in ${cwd ?? 'the project'}) and call ${WATCH_JOB_TOOL_NAME} again.` };
		}
		if (outcome.state === 'done' || outcome.state === 'failed') {
			const said = outcome.state === 'done' ? 'is already done' : `already failed${outcome.reason ? `: ${outcome.reason}` : ''}`;
			return { text: `The first check says "${spec.title}" ${said}${outcome.line && outcome.state === 'done' ? ` (${outcome.line})` : ''}. Report the result to the user now; Volt is not watching it.` };
		}
		this.add({ id, chatId, spec, cwd, startedAt: Date.now(), line: outcome.line, progress: outcome.progress, output: first.output });
		// The agent took charge of reporting: its own background commands running now are what it waits on.
		for (const info of this.terminals.list(chatId)) {
			if (info.kind === 'agent-task') {
				this.seen(info.id).ignored = true;
			}
		}
		this._onDidChange.fire(chatId);
		const progress = outcome.progress !== undefined ? ` (${Math.round(outcome.progress * 100)}%)` : '';
		return {
			text: [
				`Watching "${spec.title}" as ${id}: Volt checks it every ${Math.round(spec.everyMs / 1000)}s and shows the user its progress under your reply${spec.wake ? ', then sends you a message when it ends' : ''}.`,
				`First check: still running${outcome.line ? ` (${outcome.line})` : ''}${progress}.`,
				'End your turn now; do not sleep, poll or re-run it.',
			].join(' '),
		};
	}

	private add(init: IWatchInit): IWatch {
		const watch: IWatch = {
			...init,
			state: 'running',
			output: init.output ?? '',
			broken: 0,
			checks: 1,
			reported: false,
			timer: new RunOnceScheduler(() => void this.tick(watch), init.spec.everyMs),
		};
		this.watches.set(watch.id, watch);
		watch.timer.schedule();
		return watch;
	}

	private save(): void {
		this.saver.cancel();
		const running = [...this.watches.values()].filter(watch => watch.state === 'running').map((watch): IWatchInit => ({
			id: watch.id,
			chatId: watch.chatId,
			spec: watch.spec,
			cwd: watch.cwd,
			startedAt: watch.startedAt,
			line: watch.line,
			progress: watch.progress,
		}));
		if (running.length) {
			this.storage.store(STORAGE_KEY, JSON.stringify(running), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storage.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	/** Watches the window ran before it reloaded: checked again from where they were. */
	private async restore(): Promise<void> {
		const raw = this.storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let stored: unknown;
		try {
			stored = JSON.parse(raw);
		} catch {
			return;
		}
		await Promise.all([this.history.whenReady, this.orchestrator.whenReady]);
		const restored = new Set<string>();
		for (const item of Array.isArray(stored) ? stored : []) {
			if (isWatchInit(item) && !this.watches.has(item.id) && this.history.get(item.chatId)) {
				this.add(item);
				restored.add(item.chatId);
			}
		}
		for (const chatId of restored) {
			this._onDidChange.fire(chatId);
		}
	}

	private unwatch(chatId: string, args: Record<string, unknown>): IVoltHostToolResult {
		const id = typeof args.id === 'string' ? args.id.trim() : '';
		const targets = id ? this.watchesOf(chatId).filter(watch => watch.id === id) : this.watchesOf(chatId);
		if (!targets.length) {
			return { error: id ? `No job ${id} is being watched in this chat.` : 'This chat watches no jobs.' };
		}
		for (const watch of targets) {
			this.end(watch, 'stopped');
		}
		return { text: `Stopped watching ${targets.map(watch => `${watch.id} ("${watch.spec.title}")`).join(', ')}. The job itself keeps running.` };
	}

	//#endregion

	//#region Checking

	private async tick(watch: IWatch): Promise<void> {
		if (watch.state !== 'running' || this.watches.get(watch.id) !== watch) {
			return;
		}
		watch.checks++;
		const { outcome, output } = await this.check(watch.spec, watch.cwd, `${watch.id}-${watch.checks}`);
		if (watch.state !== 'running') {
			return;
		}
		if (outcome.line) {
			watch.line = outcome.line;
		}
		if (outcome.progress !== undefined) {
			watch.progress = outcome.progress;
		}
		if (output.trim()) {
			watch.output = output;
		}
		if (outcome.state === 'broken') {
			watch.broken++;
			watch.reason = outcome.reason;
			if (watch.broken >= MAX_BROKEN_CHECKS) {
				this.end(watch, 'broken');
				return;
			}
		} else {
			watch.broken = 0;
		}
		if (outcome.state === 'done' || outcome.state === 'failed') {
			watch.reason = outcome.reason;
			this.end(watch, outcome.state);
			return;
		}
		if (Date.now() - watch.startedAt >= watch.spec.timeoutMs) {
			this.end(watch, 'timedOut');
			return;
		}
		watch.timer.schedule();
		this._onDidChange.fire(watch.chatId);
	}

	/** Runs the check (and the pid probe) once. A check that throws counts as one that did not work. */
	private async check(spec: IJobWatchSpec, cwd: string | undefined, runId: string): Promise<{ readonly outcome: IJobCheckOutcome; readonly output: string }> {
		let run: IJobCheckRun;
		try {
			const alive = spec.pid !== undefined ? await this.isAlive(spec.pid, `${runId}-pid`) : undefined;
			if (spec.check) {
				const result = await this.stdio.exec({ id: runId, command: spec.check, cwd, timeoutMs: CHECK_TIMEOUT_MS, inlineChars: TAIL_CHARS });
				run = { exitCode: result.exitCode, output: result.combined, timedOut: result.timedOut, ...(alive !== undefined ? { alive } : {}) };
			} else {
				run = { exitCode: 0, output: '', timedOut: false, ...(alive !== undefined ? { alive } : {}) };
			}
		} catch (err) {
			return { outcome: { state: 'broken', reason: err instanceof Error ? err.message : String(err) }, output: '' };
		}
		return { outcome: judgeJobCheck(spec, run), output: run.output };
	}

	private async isAlive(pid: number, runId: string): Promise<boolean> {
		const command = isWindows ? `tasklist /FI "PID eq ${pid}" /NH` : `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`;
		const result = await this.stdio.exec({ id: runId, command, timeoutMs: CHECK_TIMEOUT_MS, inlineChars: 2_000 });
		return isWindows ? new RegExp(`\\b${pid}\\b`).test(result.stdout) : result.stdout.trim() === 'alive';
	}

	private end(watch: IWatch, state: JobEnd | 'stopped'): void {
		if (watch.state !== 'running') {
			return;
		}
		watch.state = state;
		watch.endedAt = Date.now();
		watch.timer.dispose();
		if (state === 'stopped') {
			this.watches.delete(watch.id);
		} else if (watch.spec.wake) {
			void this.wake(watch.chatId, `${watch.id}-end`, {
				id: watch.id,
				title: watch.spec.title,
				end: state,
				durationMs: watch.endedAt - watch.startedAt,
				check: watch.spec.check,
				output: watch.output,
				reason: watch.reason,
			}).then(woke => {
				watch.reported = woke;
				this._onDidChange.fire(watch.chatId);
			});
		}
		this._onDidChange.fire(watch.chatId);
	}

	/** Wakes the chat's agent with how the job ended (`turnId` is never sent twice). False when the chat would not take it. */
	private async wake(chatId: string, turnId: string, input: Parameters<typeof jobWakeMessage>[0]): Promise<boolean> {
		const { text, summary } = jobWakeMessage(input);
		try {
			// News for a snoozed chat brings it back to the inbox, where the user sees it working.
			if (this.history.get(chatId)?.snoozed) {
				await this.history.setSnoozed(chatId, false);
			}
			const result = await this.orchestrator.notify(chatId, { text, display: { text: summary, notification: true } }, turnId);
			if (result.outcome === 'rejected') {
				this.logService.info(`[volt jobs] ${chatId} did not take the news of ${input.id}: ${result.reason ?? ''}`);
				return false;
			}
			return true;
		} catch (err) {
			this.logService.warn('[volt jobs] could not wake the chat', err);
			return false;
		}
	}

	//#endregion

	//#region The agent's own background commands

	private seen(terminalId: string): ITaskSeen {
		let seen = this.tasks.get(terminalId);
		if (!seen) {
			seen = { waited: false, ignored: false, reading: false, again: false, ended: false };
			this.tasks.set(terminalId, seen);
		}
		return seen;
	}

	private onTerminals(chatId: string): void {
		const infos = this.terminals.list(chatId).filter(info => info.kind === 'agent-task');
		const idle = this.isIdle(chatId);
		let changed = false;
		for (const info of infos) {
			const seen = this.seen(info.id);
			if (isWaitableTask(info)) {
				if (idle && !seen.ignored) {
					seen.waited = true;
					changed = true;
					this.readTail(info, seen);
				}
				continue;
			}
			if (seen.ended || (info.status !== 'completed' && info.status !== 'failed' && info.status !== 'stopped')) {
				continue;
			}
			seen.ended = true;
			changed = true;
			// Ended while the agent was idle and the user waited on it: tell the agent, as Claude Code
			// itself does. A busy agent sees its command end within its turn.
			if (seen.waited && !seen.ignored && idle && info.status !== 'stopped') {
				void this.wakeForTask(info);
			}
		}
		// Forgotten terminals take their bookkeeping with them.
		for (const [terminalId] of this.tasks) {
			if (!this.terminals.get(terminalId)) {
				this.tasks.delete(terminalId);
			}
		}
		if (changed) {
			this._onDidChange.fire(chatId);
		}
	}

	/** A turn started or ended: rows show only while the agent is idle, and finished watches go once a new turn starts. */
	private onTurns(chatId: string, idle: boolean): void {
		if (!idle) {
			for (const watch of this.watchesOf(chatId, true)) {
				if (watch.state !== 'running') {
					this.watches.delete(watch.id);
				}
			}
		} else {
			this.onTerminals(chatId);
		}
		this._onDidChange.fire(chatId);
	}

	/** The last line the command printed, for its row. A read asked for while one runs follows it. */
	private readTail(info: IAgentTerminalInfo, seen: ITaskSeen): void {
		if (seen.reading) {
			seen.again = true;
			return;
		}
		seen.reading = true;
		void this.taskOutput(info).then(output => {
			const latest = latestOutputLine(output);
			if (latest.line !== seen.line || latest.progress !== seen.progress) {
				seen.line = latest.line;
				seen.progress = latest.progress;
				this._onDidChange.fire(info.chatId);
			}
		}).finally(() => {
			seen.reading = false;
			if (seen.again) {
				seen.again = false;
				const now = this.terminals.get(info.id);
				if (now && isWaitableTask(now)) {
					this.readTail(now, seen);
				}
			}
		});
	}

	/** About the last {@link TAIL_CHARS} characters it printed: from the window's log, else from its output file. */
	private async taskOutput(info: IAgentTerminalInfo): Promise<string> {
		const end = this.terminals.output(info.id, Number.MAX_SAFE_INTEGER);
		if (end) {
			return this.terminals.output(info.id, Math.max(0, end.offset - TAIL_CHARS))?.text ?? '';
		}
		if (!info.outputFile) {
			return '';
		}
		try {
			const file = URI.file(info.outputFile);
			const stat = await this.fileService.stat(file);
			const position = Math.max(0, (stat.size ?? 0) - TAIL_CHARS);
			return (await this.fileService.readFile(file, { position })).value.toString();
		} catch {
			return '';
		}
	}

	private async wakeForTask(info: IAgentTerminalInfo): Promise<void> {
		const output = await this.taskOutput(info);
		await this.wake(info.chatId, `task-${info.id}-${info.startedAt}-end`, {
			id: info.id,
			title: info.command || info.label,
			end: info.status === 'completed' ? 'done' : 'failed',
			durationMs: (info.endedAt ?? Date.now()) - info.startedAt,
			agentTask: true,
			output,
			outputFile: info.outputFile,
			exitCode: info.exitCode,
			reason: info.status === 'failed' ? info.error : undefined,
		});
	}

	//#endregion
}

/**
 * An agent's background command the user may be waiting on: still running, and not a server or
 * watcher (those print a URL or a ready line, and the terminal chip covers them), nor one asking
 * for input.
 */
function isWaitableTask(info: IAgentTerminalInfo): boolean {
	return info.kind === 'agent-task' && (info.status === 'starting' || info.status === 'running') && !info.urls.length;
}

function resolveCwd(requested: string | undefined, base: string | undefined): string | undefined {
	if (!requested) {
		return base;
	}
	if (requested.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(requested)) {
		return requested;
	}
	return base ? URI.joinPath(URI.file(base), requested).fsPath : requested;
}

registerSingleton(IAgentJobWaitsService, AgentJobWaitsService, InstantiationType.Delayed);

/** Serves watch_job from the start, before any chat shows a row. */
class AgentJobWaitsContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentJobWaits';
	constructor(@IAgentJobWaitsService _service: IAgentJobWaitsService) { }
}

registerWorkbenchContribution2(AgentJobWaitsContribution.ID, AgentJobWaitsContribution, WorkbenchPhase.AfterRestored);
