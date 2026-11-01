/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { isTerminalLive, plainTerminalText, terminalLabelFor } from '../../../../services/voltRuntime/common/terminalTools.js';
import {
	failureSignature,
	fixPrompt,
	formatDuration,
	isWatchLive,
	IWatchedAttempt,
	IWatchedTaskSpec,
	judgeAttempt,
	nextStepAfterFailure,
	outputSnapshot,
	parseWatchArgs,
	stopPrompt,
	TASK_WATCH_STATUS_TOOL_NAME,
	TASK_WATCH_STOP_TOOL_NAME,
	TASK_WATCH_TOOL_NAME,
	WATCHED_TASK_TOOLS,
	WatchedTaskState,
} from '../../../../services/voltRuntime/common/terminals/watchedTasks.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { IAgentTerminalsService } from './agentTerminals.js';

/** A watched task as the chat's card shows it. */
export interface IWatchedTaskView {
	readonly id: string;
	readonly chatId: string;
	readonly title: string;
	readonly command: string;
	readonly state: WatchedTaskState;
	readonly attempts: readonly IWatchedAttempt[];
	readonly maxAttempts: number;
	readonly startedAt: number;
	readonly endedAt?: number;
	/** When the timer checks the running attempt next. */
	readonly nextCheckAt?: number;
	readonly checkEveryMs: number;
	/** The last lines of the current attempt's output. */
	readonly snapshot: readonly string[];
	/** One sentence on where it stands ("Asked the agent to fix it", "Same error 3 times"). */
	readonly note?: string;
	/** The running attempt's terminal, to open. */
	readonly terminalId?: string;
}

export const IAgentWatchedTasksService = createDecorator<IAgentWatchedTasksService>('agentWatchedTasksService');

export interface IAgentWatchedTasksService {
	readonly _serviceBrand: undefined;
	/** A chat's watched tasks changed (fires with the chat id). */
	readonly onDidChange: Event<string>;
	list(chatId: string): readonly IWatchedTaskView[];
	/** Runs it again now (a new attempt), whatever state it is in. */
	rerun(id: string): Promise<void>;
	/** Stops its run; nothing re-runs it. */
	stop(id: string): Promise<void>;
	/** Forgets a finished watch (its card goes). */
	dismiss(id: string): void;
	/** Shows the current attempt's terminal. */
	reveal(id: string): void;
}

/** Between output snapshots while an attempt runs (the check itself runs on the task's own timer). */
const SNAPSHOT_MS = 1_500;
/** Most output read for a check. */
const CHECK_CHARS = 64_000;
/** Watches a chat keeps listed once they ended. */
const MAX_ENDED_PER_CHAT = 4;

interface IWatchedTask {
	readonly id: string;
	readonly chatId: string;
	/** The chat whose agent asked: it is the one woken to fix (a subagent's own chat). */
	readonly sessionId: string;
	readonly spec: IWatchedTaskSpec;
	readonly title: string;
	state: WatchedTaskState;
	readonly attempts: IWatchedAttempt[];
	readonly startedAt: number;
	endedAt?: number;
	nextCheckAt?: number;
	snapshot: string[];
	note?: string;
	/** The notification turn that asked for a fix; its end starts the next attempt. */
	fixTurnId?: string;
	checkTimer?: ReturnType<typeof setTimeout>;
	snapshotTimer?: number;
}

export class AgentWatchedTasksService extends Disposable implements IAgentWatchedTasksService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly tasks = new Map<string, IWatchedTask>();
	private nextId = 1;

	constructor(
		@IAgentTerminalsService private readonly terminals: IAgentTerminalsService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@ILogService private readonly logService: ILogService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: WATCHED_TASK_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name, args, call),
		}));
		// An attempt that ended is judged at once, not at the next tick.
		this._register(this.terminals.onDidChange(chatId => {
			for (const task of this.tasks.values()) {
				const terminalId = task.attempts.at(-1)?.terminalId;
				if (task.chatId === chatId && task.state === 'running' && terminalId) {
					const info = this.terminals.get(terminalId);
					if (!info || !isTerminalLive(info.status)) {
						this.check(task);
					}
				}
			}
		}));
		// The agent's fix turn ended: run it again, unless the turn was stopped.
		this._register(this.orchestrator.onDidChange(change => {
			for (const task of this.tasks.values()) {
				if (task.state === 'fixing' && task.fixTurnId && change.threads.includes(task.sessionId)) {
					this.onFixTurn(task);
				}
			}
		}));
		this._register(this.orchestrator.onDidStop(threadId => {
			for (const task of this.tasks.values()) {
				if (task.state === 'fixing' && (task.sessionId === threadId || task.chatId === threadId)) {
					this.end(task, 'stopped', localize('voltWatch.chatStopped', "You stopped the chat, so it is not run again."));
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const task of this.tasks.values()) {
				this.clearTimers(task);
			}
		}));
	}

	list(chatId: string): readonly IWatchedTaskView[] {
		return [...this.tasks.values()].filter(task => task.chatId === chatId).map(task => this.view(task));
	}

	private view(task: IWatchedTask): IWatchedTaskView {
		const terminalId = task.attempts.at(-1)?.terminalId;
		return {
			id: task.id,
			chatId: task.chatId,
			title: task.title,
			command: task.spec.command,
			state: task.state,
			attempts: task.attempts.map(attempt => ({ ...attempt })),
			maxAttempts: task.spec.maxAttempts,
			startedAt: task.startedAt,
			...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
			...(task.state === 'running' && task.nextCheckAt !== undefined ? { nextCheckAt: task.nextCheckAt } : {}),
			checkEveryMs: task.spec.checkEveryMs,
			snapshot: task.snapshot,
			...(task.note ? { note: task.note } : {}),
			...(terminalId && this.terminals.get(terminalId) ? { terminalId } : {}),
		};
	}

	async rerun(id: string): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) {
			return;
		}
		const running = task.attempts.at(-1);
		if (task.state === 'running' && running?.terminalId) {
			running.result = 'stopped';
			running.endedAt = Date.now();
			running.reason = localize('voltWatch.rerunByUser', "Run again by you.");
			await this.terminals.stop(running.terminalId).catch(() => undefined);
		}
		task.fixTurnId = undefined;
		task.endedAt = undefined;
		await this.launch(task);
	}

	async stop(id: string): Promise<void> {
		const task = this.tasks.get(id);
		if (!task || !isWatchLive(task.state)) {
			return;
		}
		const attempt = task.attempts.at(-1);
		if (task.state === 'running' && attempt && !attempt.result) {
			attempt.result = 'stopped';
			attempt.endedAt = Date.now();
			if (attempt.terminalId) {
				await this.terminals.stop(attempt.terminalId).catch(() => undefined);
			}
		}
		this.end(task, 'stopped', localize('voltWatch.stopped', "Stopped. It is not run again."));
	}

	dismiss(id: string): void {
		const task = this.tasks.get(id);
		if (task && !isWatchLive(task.state)) {
			this.clearTimers(task);
			this.tasks.delete(id);
			this._onDidChange.fire(task.chatId);
		}
	}

	reveal(id: string): void {
		const terminalId = this.tasks.get(id)?.attempts.at(-1)?.terminalId;
		if (terminalId) {
			this.terminals.reveal(terminalId, false);
		}
	}

	//#region The loop

	private async start(sessionId: string, spec: IWatchedTaskSpec): Promise<IWatchedTask> {
		const chatId = this.runtime.chatFor(sessionId);
		const task: IWatchedTask = {
			id: `watch-${this.nextId++}`,
			chatId,
			sessionId,
			spec,
			title: spec.label ?? terminalLabelFor(spec.command),
			state: 'running',
			attempts: [],
			startedAt: Date.now(),
			snapshot: [],
		};
		this.tasks.set(task.id, task);
		this.pruneEnded(chatId);
		await this.launch(task);
		return task;
	}

	/** Starts the next attempt in a new terminal and arms the timer. */
	private async launch(task: IWatchedTask): Promise<void> {
		this.clearTimers(task);
		task.state = 'running';
		task.note = undefined;
		task.snapshot = [];
		const number = task.attempts.length + 1;
		try {
			const info = await this.terminals.start(task.chatId, {
				command: task.spec.command,
				label: task.spec.maxAttempts > 1 && number > 1 ? `${task.title} #${number}` : task.title,
				...(task.spec.cwd ? { cwd: task.spec.cwd } : {}),
			});
			task.attempts.push({ number, terminalId: info.id, startedAt: Date.now() });
		} catch (err) {
			task.attempts.push({ number, terminalId: undefined, startedAt: Date.now(), endedAt: Date.now(), result: 'failed', reason: err instanceof Error ? err.message : String(err) });
			this.end(task, 'failed', localize('voltWatch.couldNotStart', "It could not start: {0}", err instanceof Error ? err.message : String(err)));
			return;
		}
		task.snapshotTimer = mainWindow.setInterval(() => this.refreshSnapshot(task), SNAPSHOT_MS);
		this.schedule(task);
		this._onDidChange.fire(task.chatId);
	}

	private schedule(task: IWatchedTask): void {
		clearTimeout(task.checkTimer);
		task.nextCheckAt = Date.now() + task.spec.checkEveryMs;
		task.checkTimer = setTimeout(() => this.check(task), task.spec.checkEveryMs);
	}

	/** The timer's ping: is the attempt done, and did it pass? */
	private check(task: IWatchedTask): void {
		const attempt = task.attempts.at(-1);
		if (task.state !== 'running' || !attempt || attempt.result) {
			return;
		}
		const output = this.outputOf(attempt.terminalId);
		task.snapshot = outputSnapshot(output);
		const info = attempt.terminalId ? this.terminals.get(attempt.terminalId) : undefined;
		const verdict = judgeAttempt(info, output, task.spec, Date.now() - attempt.startedAt);
		if (verdict.verdict === 'running') {
			this.schedule(task);
			this._onDidChange.fire(task.chatId);
			return;
		}
		attempt.result = verdict.verdict;
		attempt.endedAt = Date.now();
		if (verdict.reason) {
			attempt.reason = verdict.reason;
		}
		if (verdict.verdict === 'passed') {
			this.end(task, 'passed', attempt.number === 1
				? localize('voltWatch.passedFirst', "Passed in {0}.", formatDuration(attempt.endedAt - attempt.startedAt))
				: localize('voltWatch.passedAfter', "Passed on attempt {0}, {1} in all.", attempt.number, formatDuration(attempt.endedAt - task.startedAt)));
			return;
		}
		if (verdict.verdict === 'timedOut' && attempt.terminalId) {
			void this.terminals.stop(attempt.terminalId).catch(() => undefined);
		}
		attempt.signature = failureSignature(output, attempt.reason);
		const step = nextStepAfterFailure(task.attempts, task.spec, task.startedAt, Date.now());
		if (step.next === 'stop') {
			this.end(task, step.state, step.why);
			void this.wake(task, `watch-${task.id}-end-${attempt.number}`, stopPrompt(task.id, task.title, task.attempts.length, step.why, attempt.reason),
				localize('voltWatch.endedSummary', "{0}: stopped watching after {1} attempts", task.title, task.attempts.length));
			return;
		}
		const previous = task.attempts.at(-2);
		const repeated = !!previous?.signature && previous.signature === attempt.signature;
		this.clearTimers(task);
		task.state = 'fixing';
		task.fixTurnId = `watch-${task.id}-fix-${attempt.number}-${Date.now().toString(36)}`;
		task.note = localize('voltWatch.fixing', "Attempt {0} failed. The agent is fixing it; Volt runs it again when it is done.", attempt.number);
		this._onDidChange.fire(task.chatId);
		void this.wake(task, task.fixTurnId, fixPrompt(task.id, task.title, task.spec, attempt, output, repeated),
			localize('voltWatch.fixSummary', "{0} failed (attempt {1} of {2}): fix it", task.title, attempt.number, task.spec.maxAttempts)).then(woken => {
				if (!woken && task.state === 'fixing') {
					this.end(task, 'failed', localize('voltWatch.noAgent', "The agent could not be asked to fix it."));
				}
			});
	}

	private onFixTurn(task: IWatchedTask): void {
		const thread = this.orchestrator.getThread(task.sessionId);
		const last = thread?.last;
		if (!last || last.turnId !== task.fixTurnId || thread?.active?.id === task.fixTurnId) {
			return;
		}
		task.fixTurnId = undefined;
		if (last.outcome === 'cancelled') {
			this.end(task, 'stopped', localize('voltWatch.fixCancelled', "The fix was stopped, so it is not run again."));
			return;
		}
		void this.launch(task);
	}

	private async wake(task: IWatchedTask, turnId: string, text: string, summary: string): Promise<boolean> {
		try {
			const result = await this.orchestrator.notify(task.sessionId, { text, display: { text: summary, notification: true } }, turnId);
			return result.outcome !== 'rejected';
		} catch (err) {
			this.logService.warn('[volt-watch] could not wake the chat', err);
			return false;
		}
	}

	private end(task: IWatchedTask, state: WatchedTaskState, note: string): void {
		this.clearTimers(task);
		task.state = state;
		task.note = note;
		task.endedAt = Date.now();
		task.fixTurnId = undefined;
		const attempt = task.attempts.at(-1);
		if (attempt) {
			task.snapshot = outputSnapshot(this.outputOf(attempt.terminalId));
		}
		this._onDidChange.fire(task.chatId);
	}

	private refreshSnapshot(task: IWatchedTask): void {
		const snapshot = outputSnapshot(this.outputOf(task.attempts.at(-1)?.terminalId));
		if (snapshot.join('\n') !== task.snapshot.join('\n')) {
			task.snapshot = snapshot;
			this._onDidChange.fire(task.chatId);
		}
	}

	/** The end of an attempt's output: from the terminal's log, or (agent server) its screen. */
	private outputOf(terminalId: string | undefined): string {
		if (!terminalId) {
			return '';
		}
		const info = this.terminals.get(terminalId);
		// Only the end of the log: a read past the end costs nothing and says how long it is.
		const end = info && this.terminals.output(terminalId, Number.MAX_SAFE_INTEGER);
		const log = end && this.terminals.output(terminalId, Math.max(0, end.offset - CHECK_CHARS));
		if (log) {
			return plainTerminalText(log.text);
		}
		const instance = this.terminals.instanceOf(terminalId);
		return (instance && screenText(instance)) ?? info?.error ?? '';
	}

	private clearTimers(task: IWatchedTask): void {
		clearTimeout(task.checkTimer);
		mainWindow.clearInterval(task.snapshotTimer);
		task.checkTimer = undefined;
		task.snapshotTimer = undefined;
		task.nextCheckAt = undefined;
	}

	private pruneEnded(chatId: string): void {
		const ended = [...this.tasks.values()].filter(task => task.chatId === chatId && !isWatchLive(task.state));
		for (const task of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PER_CHAT))) {
			this.tasks.delete(task.id);
		}
	}

	//#endregion

	//#region Tools

	private async invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const sessionId = call?.sessionId;
		if (!sessionId) {
			return { error: 'This tool needs a Volt chat.' };
		}
		const chatId = this.runtime.chatFor(sessionId);
		switch (name) {
			case TASK_WATCH_TOOL_NAME: {
				const spec = parseWatchArgs(args);
				if ('error' in spec) {
					return { error: spec.error };
				}
				const same = [...this.tasks.values()].find(task => task.chatId === chatId && isWatchLive(task.state) && task.spec.command === spec.command);
				if (same) {
					return { text: `${same.id} already watches this command (${describe(this.view(same))}). Volt tells you if it fails; do not start it again.` };
				}
				const task = await this.start(sessionId, spec);
				if (task.state === 'failed') {
					return { error: task.note ?? 'It could not start.' };
				}
				return {
					text: [
						`Watching ${task.id} "${task.title}" in terminal ${task.attempts.at(-1)?.terminalId}. Volt checks it every ${formatDuration(spec.checkEveryMs)} and shows it in the chat.`,
						spec.autoFix
							? `If it fails Volt sends you the error to fix and runs it again (at most ${spec.maxAttempts} attempts). Do not poll, wait for or re-run it; carry on with other work or end your turn.`
							: 'Volt reports the result in the chat. Do not poll or re-run it.',
					].join(' '),
				};
			}
			case TASK_WATCH_STATUS_TOOL_NAME: {
				const id = typeof args.id === 'string' ? args.id : undefined;
				const views = this.list(chatId).filter(view => !id || view.id === id);
				if (!views.length) {
					return { text: id ? `No watched task ${id} in this chat.` : 'This chat watches no tasks.' };
				}
				return { text: views.map(view => `${describe(view)}${view.snapshot.length ? `\nLatest output:\n${view.snapshot.join('\n')}` : ''}`).join('\n\n') };
			}
			case TASK_WATCH_STOP_TOOL_NAME: {
				const id = typeof args.id === 'string' ? args.id : '';
				const task = this.tasks.get(id);
				if (!task || task.chatId !== chatId) {
					return { error: `No watched task ${id} in this chat.` };
				}
				await this.stop(id);
				return { text: `Stopped watching ${id}.` };
			}
		}
		return { error: `Unknown tool ${name}` };
	}

	//#endregion
}

function describe(view: IWatchedTaskView): string {
	const last = view.attempts.at(-1);
	const attempt = last ? `attempt ${last.number} of ${view.maxAttempts}` : 'not started';
	const reason = last?.reason ? `; last error: ${last.reason}` : '';
	return `${view.id} "${view.title}": ${view.state}, ${attempt}${reason}${view.note ? `. ${view.note}` : ''}`;
}

/** The last lines on a terminal's screen and scrollback (agent server terminals keep no log here). */
function screenText(instance: ITerminalInstance): string | undefined {
	const buffer = instance.xterm?.raw.buffer.active;
	if (!buffer) {
		return undefined;
	}
	const end = buffer.baseY + buffer.cursorY;
	const lines: string[] = [];
	for (let y = Math.max(0, end - 200); y <= end; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

registerSingleton(IAgentWatchedTasksService, AgentWatchedTasksService, InstantiationType.Delayed);

/** Makes the service (and so its tools) exist from the start, before any chat shows a card. */
class AgentWatchedTasksContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentWatchedTasks';
	constructor(@IAgentWatchedTasksService _service: IAgentWatchedTasksService) { }
}

registerWorkbenchContribution2(AgentWatchedTasksContribution.ID, AgentWatchedTasksContribution, WorkbenchPhase.AfterRestored);
