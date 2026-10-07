/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltEventEnvelope } from '../../common/events.js';
import { IAgentWorktreeService } from '../../common/git/agentWorktree.js';
import { IAgentWorktreeSetupService } from '../../common/git/worktreeSetupPlan.js';
import { IAgentHistoryService } from '../../common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { normalizeVoltMode } from '../../common/modes.js';
import { AGENT_TASK_TOOLS, bareTaskToolName, buildTaskFollowUp, buildTaskPrompt, CANCEL_TASK_TOOL_NAME, DELEGATE_TASK_TOOL_NAME, describeTask, HANDOFF_TOOL_NAME, isLiveTaskState, isTerminalTaskState, LIST_MODELS_TOOL_NAME, MESSAGE_TASK_TOOL_NAME, modeForTaskRole, newTaskId, normalizeTaskRole, TASK_STATUS_TOOL_NAME, TASK_WAIT_MS, titleFromBrief, WAIT_TASKS_TOOL_NAME } from '../../common/orchestration/agentTasks.js';
import { harnessFailure, harnessSubagentCall, isAsyncLaunchResult } from '../../common/orchestration/harnessSubagents.js';
import { DEFAULT_ORCH_LIMITS, emptyOrchState, IAgentOrchestratorService, IOrchChange, IOrchEventEnvelope, IOrchLimits, IOrchPrompt, IOrchState, IOrchSubmitResult, IOrchTask, IOrchThread, IOrchTurnHost, ORCH_RESUME_AFTER_RESTART_SETTING, OrchCommandBody, OrchDelivery, OrchEffect, OrchEvent, OrchOutcome, OrchRestartResume } from '../../common/orchestration/orchestrator.js';
import { extractRoot, IOrchIndex, isRootLive, mergeRoot, rootIdsOf } from '../../common/orchestration/orchestratorCodec.js';
import { harnessTaskId, IOrchStep, runOrchCommand } from '../../common/orchestration/orchestratorDecider.js';
import { IAgentRuntimeService } from '../../common/runtime.js';
import { IVoltSessionContextService } from '../../common/sessionContext.js';
import { OrchestratorStore } from './orchestratorStore.js';

/** Models one delegate_task call may run the same brief on. */
const MAX_FAN_OUT = 4;
/** A cancelled run that does not report its end within this long is settled by Volt. */
const CANCEL_SETTLE_MS = 15_000;
/** A Volt chat id for a subagent's chat; the agent editor reads session ids from this shape. */
const CHILD_ID_PREFIX = 'agent-';

export class AgentOrchestratorService extends Disposable implements IAgentOrchestratorService {

	declare readonly _serviceBrand: undefined;

	private state: IOrchState = emptyOrchState();
	private readonly limits: IOrchLimits = DEFAULT_ORCH_LIMITS;
	private readonly store: OrchestratorStore;
	/** Newest events per root, persisted with the root as its audit trail. */
	private readonly rootEvents = new Map<string, IOrchEventEnvelope[]>();
	private readonly dirtyRoots = new Set<string>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private persisting: Promise<void> = Promise.resolve();
	private knownRoots = new Set<string>();
	private lastIndex = '';
	private host: IOrchTurnHost | undefined;
	private readonly waitingForHost: Extract<OrchEffect, { kind: 'startTurn' }>[] = [];
	/** The turn whose start is in flight per chat: a `run.start` seen now belongs to it. */
	private readonly dispatching = new Map<string, string>();
	private readonly cancelWatch = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly lastError = new Map<string, string>();
	private readonly worktreesInFlight = new Set<string>();
	/** `delegate_task` calls seen in a chat's stream, oldest first, waiting for the MCP call that matches. */
	private readonly delegateCalls = new Map<string, string[]>();
	/** Harness Task calls that launched asynchronously: their "completed" was the launch, not the end. */
	private readonly asyncHarness = new Set<string>();
	private readonly loading = new Map<string, Promise<void>>();
	private readonly ready = new DeferredPromise<void>();
	readonly whenReady: Promise<void> = this.ready.p;

	private readonly _onDidChange = this._register(new Emitter<IOrchChange>());
	readonly onDidChange: Event<IOrchChange> = this._onDidChange.event;
	private readonly _onDidChangeTasks = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeTasks: Event<readonly string[]> = this._onDidChangeTasks.event;
	private readonly _onDidStop = this._register(new Emitter<string>());
	readonly onDidStop: Event<string> = this._onDidStop.event;

	constructor(
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentWorktreeSetupService private readonly worktreeSetup: IAgentWorktreeSetupService,
	) {
		super();
		this.store = new OrchestratorStore(joinPath(environmentService.userRoamingDataHome, 'voltOrchestrator'), fileService, logService);
		this._register(runtime.onDidEmit(envelope => this.observe(envelope)));
		this._register(hostTools.registerToolProvider({
			tools: AGENT_TASK_TOOLS.map(tool => ({ ...tool, group: 'tasks' as const })),
			invoke: (name, args, call) => this.invokeTaskTool(name, args, call),
		}));
		this._register(toDisposable(() => {
			if (this.persistTimer !== undefined) {
				clearTimeout(this.persistTimer);
			}
			for (const timer of this.cancelWatch.values()) {
				clearTimeout(timer);
			}
		}));
		void this.restore();
	}

	//#region State and commands

	getState(): IOrchState {
		return this.state;
	}

	getThread(threadId: string): IOrchThread | undefined {
		return this.state.threads[threadId];
	}

	getTask(taskId: string): IOrchTask | undefined {
		return this.state.tasks[taskId];
	}

	tasksOf(threadId: string): readonly IOrchTask[] {
		return Object.values(this.state.tasks).filter(task => task.parentId === threadId).sort((a, b) => a.createdAt - b.createdAt);
	}

	taskForToolCall(threadId: string, toolCallId: string): IOrchTask | undefined {
		return this.state.tasks[harnessTaskId(toolCallId)]
			?? Object.values(this.state.tasks).find(task => task.parentId === threadId && task.toolCallId === toolCallId);
	}

	async dispatch(command: OrchCommandBody & { readonly id?: string }): Promise<readonly OrchEvent[]> {
		return this.apply(command, command.id).decision.events;
	}

	async submit(threadId: string, prompt: IOrchPrompt, delivery: OrchDelivery, turnId = generateUuid()): Promise<IOrchSubmitResult> {
		await this.ensureThreadLoaded(threadId);
		this.describeThread(threadId, prompt.modelRef);
		const thread = this.state.threads[threadId];
		const canSteer = !!thread?.active?.steerable || this.runtime.canSteer(threadId);
		const step = this.apply({ type: 'thread.submit', threadId, turnId, prompt, delivery, canSteer });
		const outcome = step.decision.outcome;
		return outcome ? { outcome } : { outcome: 'rejected', ...(step.decision.rejected ? { reason: step.decision.rejected } : {}) };
	}

	async notify(threadId: string, prompt: IOrchPrompt, turnId: string, options?: { readonly interrupt?: boolean }): Promise<IOrchSubmitResult> {
		await this.ensureThreadLoaded(threadId);
		this.describeThread(threadId, undefined);
		// The turn id doubles as the command id, so a retried wake-up is acknowledged, not sent twice.
		const step = this.apply({ type: 'thread.notify', threadId, turnId, prompt, ...(options?.interrupt ? { interrupt: true } : {}) }, `notify:${turnId}`);
		const outcome = step.decision.outcome;
		return outcome ? { outcome } : { outcome: 'rejected', ...(step.decision.rejected ? { reason: step.decision.rejected } : {}) };
	}

	async cancel(threadId: string, options?: { readonly cascade?: 'turn' | 'all' }): Promise<void> {
		this.apply({ type: 'turn.cancel', threadId, ...(options?.cascade ? { cascade: options.cascade } : {}) });
		this._onDidStop.fire(threadId);
	}

	isTurnCurrent(threadId: string, turnId: string): boolean {
		const active = this.state.threads[threadId]?.active;
		return active?.id === turnId && active.phase !== 'cancelling';
	}

	setTurnHost(host: IOrchTurnHost): IDisposable {
		this.host = host;
		const waiting = this.waitingForHost.splice(0);
		for (const effect of waiting) {
			void this.startTurn(effect);
		}
		return toDisposable(() => {
			if (this.host === host) {
				this.host = undefined;
			}
		});
	}

	/** Title and model labels for lists and briefs. */
	private describeThread(threadId: string, modelRef: string | undefined): void {
		const thread = this.state.threads[threadId];
		const title = this.history.get(threadId)?.title;
		const ref = modelRef ?? thread?.modelRef;
		const label = ref ? this.runtime.listCatalog().find(item => item.ref === ref)?.label : undefined;
		if (thread && thread.turns > 0 && thread.modelRef && modelRef && modelRef !== thread.modelRef && thread.pendingHandoff?.to !== modelRef) {
			// The user moved a running conversation to another model: a handoff, shown as such.
			this.apply({ type: 'thread.handoff', threadId, to: modelRef, toLabel: label ?? modelRef, by: 'user' });
			if (title && title !== thread.title) {
				this.apply({ type: 'thread.upsert', threadId, title });
			}
			return;
		}
		if (!thread || (title && title !== thread.title) || (ref && ref !== thread.modelRef) || (label && label !== thread.modelLabel)) {
			this.apply({
				type: 'thread.upsert',
				threadId,
				...(title ? { title } : {}),
				...(ref ? { modelRef: ref } : {}),
				...(label ? { modelLabel: label } : {}),
			});
		}
	}

	private apply(body: OrchCommandBody, id?: string): IOrchStep {
		const command = { ...body, id: id ?? generateUuid(), at: Date.now() };
		const before = this.state;
		let step: IOrchStep;
		try {
			step = runOrchCommand(before, command, this.limits);
		} catch (err) {
			// The core is pure and total; a throw is a bug. Keep the old state and say so.
			this.logService.error('[volt orchestrator] command failed', command.type, err);
			return { state: before, envelopes: [], effects: [], decision: { events: [], rejected: 'Internal orchestrator error.' } };
		}
		this.state = step.state;
		if (step.envelopes.length) {
			const threads = new Set<string>();
			const tasks = new Set<string>();
			for (const envelope of step.envelopes) {
				const { threadIds, taskIds } = touched(envelope.event);
				threadIds.forEach(threadId => threads.add(threadId));
				taskIds.forEach(taskId => tasks.add(taskId));
				for (const rootId of this.rootsFor(envelope.event, before)) {
					const list = this.rootEvents.get(rootId) ?? [];
					list.push(envelope);
					if (list.length > 400) {
						list.splice(0, list.length - 200);
					}
					this.rootEvents.set(rootId, list);
					this.dirtyRoots.add(rootId);
				}
			}
			// A task's row lives in its parent's chat and its own: both redraw.
			for (const taskId of tasks) {
				const task = this.state.tasks[taskId] ?? before.tasks[taskId];
				if (task) {
					threads.add(task.parentId);
					if (task.childId) {
						threads.add(task.childId);
					}
				}
			}
			this._onDidChange.fire({ threads: [...threads], tasks: [...tasks] });
		}
		if (step.effects.length) {
			// Outbox: the events that asked for these effects are on disk before the effects run.
			const persisted = this.persistNow();
			void persisted.then(() => {
				for (const effect of step.effects) {
					this.runEffect(effect);
				}
			});
		} else if (step.envelopes.length) {
			this.schedulePersist();
		}
		return step;
	}

	private rootsFor(event: OrchEvent, before: IOrchState): string[] {
		const rootOfThread = (threadId: string) => this.state.threads[threadId]?.rootId ?? before.threads[threadId]?.rootId;
		const rootOfTask = (taskId: string) => this.state.tasks[taskId]?.rootId ?? before.tasks[taskId]?.rootId;
		switch (event.type) {
			case 'thread.created':
				return [event.thread.rootId];
			case 'task.created':
				return [event.task.rootId];
			case 'conflict.detected':
			case 'conflict.cleared':
				return [event.rootId];
			case 'task.delivery':
			case 'task.pruned':
				return [...new Set(event.taskIds.map(rootOfTask).filter((id): id is string => !!id))];
			default: {
				const { threadIds, taskIds } = touched(event);
				return [...new Set([...threadIds.map(rootOfThread), ...taskIds.map(rootOfTask)].filter((id): id is string => !!id))];
			}
		}
	}

	//#endregion

	//#region Persistence and recovery

	private schedulePersist(): void {
		if (this.persistTimer !== undefined) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.persistNow();
		}, 250);
	}

	private persistNow(): Promise<void> {
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		const roots = [...this.dirtyRoots];
		this.dirtyRoots.clear();
		const state = this.state;
		const now = Date.now();
		const writes: Promise<void>[] = [];
		for (const rootId of roots) {
			const hasThreads = Object.values(state.threads).some(thread => thread.rootId === rootId);
			if (!hasThreads) {
				this.knownRoots.delete(rootId);
				this.rootEvents.delete(rootId);
				writes.push(this.store.deleteRoot(rootId));
				continue;
			}
			this.knownRoots.add(rootId);
			writes.push(this.store.saveRoot(extractRoot(state, rootId, this.rootEvents.get(rootId) ?? [], now)));
		}
		const index: Omit<IOrchIndex, 'version'> = {
			seq: state.seq,
			live: rootIdsOf(state).filter(rootId => isRootLive(state, rootId)).sort(),
			roots: [...this.knownRoots].sort(),
		};
		const signature = JSON.stringify([index.live, index.roots]);
		if (signature !== this.lastIndex) {
			this.lastIndex = signature;
			writes.push(this.store.saveIndex(index));
		}
		this.persisting = Promise.all([this.persisting, ...writes]).then(() => undefined);
		return this.persisting;
	}

	/** Loads the roots a restart must reconcile, then marks everything that was running as interrupted. */
	private async restore(): Promise<void> {
		try {
			await this.history.whenReady;
			const index = await this.store.loadIndex();
			this.knownRoots = new Set(index.roots);
			let state = this.state;
			for (const rootId of index.live) {
				const snapshot = await this.store.loadRoot(rootId);
				if (snapshot) {
					state = mergeRoot(state, snapshot);
					this.rootEvents.set(rootId, [...snapshot.events]);
				}
			}
			this.state = { ...state, seq: Math.max(state.seq, index.seq) };
			const step = this.apply({ type: 'recover', resume: this.restartResume() }, `recover:${generateUuid()}`);
			if (step.envelopes.length) {
				const continued = step.envelopes.filter(envelope => envelope.event.type === 'turn.dispatched').length;
				this.logService.info(`[volt orchestrator] recovered ${index.live.length} live chat tree(s); ${step.envelopes.length} change(s) after the restart, ${continued} turn(s) continued`);
			}
			if (this.state.threads && Object.keys(this.state.threads).length) {
				this._onDidChange.fire({ threads: Object.keys(this.state.threads), tasks: Object.keys(this.state.tasks) });
			}
		} catch (err) {
			this.logService.error('[volt orchestrator] restore failed', err);
		} finally {
			this.ready.complete();
		}
	}

	private restartResume(): OrchRestartResume {
		const value = this.configurationService.getValue<string>(ORCH_RESUME_AFTER_RESTART_SETTING);
		return value === 'off' || value === 'all' ? value : 'subagents';
	}

	async ensureThreadLoaded(threadId: string): Promise<void> {
		await this.whenReady;
		if (this.state.threads[threadId]) {
			return;
		}
		const rootId = this.rootIdFromHistory(threadId);
		if (!this.knownRoots.has(rootId) || Object.values(this.state.threads).some(thread => thread.rootId === rootId)) {
			return;
		}
		let loading = this.loading.get(rootId);
		if (!loading) {
			loading = this.store.loadRoot(rootId).then(snapshot => {
				if (snapshot && !Object.values(this.state.threads).some(thread => thread.rootId === rootId)) {
					this.state = mergeRoot(this.state, snapshot);
					this.rootEvents.set(rootId, [...snapshot.events]);
					this._onDidChange.fire({ threads: snapshot.threads.map(thread => thread.id), tasks: snapshot.tasks.map(task => task.id) });
				}
			}).finally(() => this.loading.delete(rootId));
			this.loading.set(rootId, loading);
		}
		await loading;
	}

	private rootIdFromHistory(threadId: string): string {
		let id = threadId;
		for (let depth = 0; depth < 6; depth++) {
			const parent = this.history.sessionParent(id);
			if (!parent) {
				break;
			}
			id = parent;
		}
		return id;
	}

	//#endregion

	//#region Effects

	private runEffect(effect: OrchEffect): void {
		switch (effect.kind) {
			case 'startTurn':
				void this.startTurn(effect);
				return;
			case 'steer':
				void this.steer(effect);
				return;
			case 'cancelTurn':
				this.cancelTurn(effect);
				return;
			case 'prepareWorktree':
				void this.prepareWorktree(effect.taskId);
				return;
			case 'tasksChanged':
				this._onDidChangeTasks.fire(effect.taskIds);
				return;
		}
	}

	private async startTurn(effect: Extract<OrchEffect, { kind: 'startTurn' }>): Promise<void> {
		const { threadId, turn } = effect;
		if (!this.isTurnCurrent(threadId, turn.id)) {
			return;
		}
		const host = this.host;
		if (!host) {
			this.waitingForHost.push(effect);
			return;
		}
		this.dispatching.set(threadId, turn.id);
		try {
			const thread = this.state.threads[threadId];
			if (thread?.taskId && thread.parentId && turn.kind === 'brief') {
				await host.prepareChild?.(threadId, thread.parentId);
			}
			const runId = await host.startTurn({ threadId, turn, thread: this.state.threads[threadId] ?? thread, isCurrent: () => this.isTurnCurrent(threadId, turn.id) });
			if (runId) {
				this.apply({ type: 'run.started', threadId, runId, turnId: turn.id, steerable: this.runtime.canSteer(threadId) });
			} else {
				const active = this.state.threads[threadId]?.active;
				if (active?.id === turn.id && !active.runId) {
					// The host did not send it: it was stopped while starting, or it could not run.
					this.apply(active.phase === 'cancelling'
						? { type: 'run.settled', threadId, turnId: turn.id, outcome: 'cancelled' }
						: { type: 'dispatch.failed', threadId, turnId: turn.id, error: 'The prompt could not be sent.' });
				}
			}
		} catch (err) {
			this.apply({ type: 'dispatch.failed', threadId, turnId: turn.id, error: err instanceof Error ? err.message : String(err) });
		} finally {
			if (this.dispatching.get(threadId) === turn.id) {
				this.dispatching.delete(threadId);
			}
		}
	}

	private async steer(effect: Extract<OrchEffect, { kind: 'steer' }>): Promise<void> {
		let delivered = false;
		try {
			delivered = await (this.host?.steer ? this.host.steer(effect.threadId, effect.prompt, effect.steerId) : this.runtime.steerAsync(effect.threadId, effect.prompt.text));
		} catch (err) {
			this.logService.warn('[volt orchestrator] steer failed', err);
		}
		if (!delivered) {
			// The run ended first or the agent refused: the message is not lost, it goes first in the queue.
			this.apply({ type: 'steer.failed', threadId: effect.threadId, steerId: effect.steerId, prompt: effect.prompt, ...(effect.taskIds ? { taskIds: effect.taskIds } : {}) });
		}
	}

	private cancelTurn(effect: Extract<OrchEffect, { kind: 'cancelTurn' }>): void {
		const { threadId, turnId } = effect;
		const active = this.state.threads[threadId]?.active;
		if (active?.id !== turnId) {
			return;
		}
		if (!active.runId && this.dispatching.get(threadId) !== turnId) {
			// Nothing reached the runtime: the turn simply ends.
			this.apply({ type: 'run.settled', threadId, turnId, outcome: 'cancelled' });
			return;
		}
		if (active.runId) {
			void this.runtime.cancel(threadId).catch(err => this.logService.warn('[volt orchestrator] cancel failed', err));
		}
		// The start in flight sees the turn is no longer current and does not send it. Either way,
		// a stop that never reports back is settled here so the chat cannot stay "Stopping".
		const key = `${threadId}\0${turnId}`;
		if (!this.cancelWatch.has(key)) {
			this.cancelWatch.set(key, setTimeout(() => {
				this.cancelWatch.delete(key);
				if (this.state.threads[threadId]?.active?.id === turnId) {
					this.logService.warn(`[volt orchestrator] ${threadId}: the stopped turn did not end; settling it`);
					this.apply({ type: 'run.settled', threadId, turnId, outcome: 'cancelled' });
				}
			}, CANCEL_SETTLE_MS));
		}
	}

	private async prepareWorktree(taskId: string): Promise<void> {
		if (this.worktreesInFlight.has(taskId)) {
			return;
		}
		const task = this.state.tasks[taskId];
		if (!task?.childId) {
			return;
		}
		this.worktreesInFlight.add(taskId);
		try {
			if (task.worktreePath && task.worktreeBranch) {
				const root = this.sessionContext.rootFor(task.parentId);
				if (root) {
					await this.worktrees.ensure(root.fsPath, task.worktreePath, task.worktreeBranch);
				}
				this.runtime.rememberWorktree(task.childId, task.worktreePath, task.worktreeBranch);
				this.apply({ type: 'task.worktree', taskId, path: task.worktreePath, branch: task.worktreeBranch });
				return;
			}
			const root = this.sessionContext.rootFor(task.parentId);
			if (!root) {
				throw new Error('The parent chat has no project folder to branch from.');
			}
			const created = await this.worktrees.create(root.fsPath);
			this.runtime.rememberWorktree(task.childId, created.path, created.branch);
			this.history.open(task.childId).setMeta({ worktreePath: created.path, worktreeBranch: created.branch });
			// The subagent's chat stays blocked until its worktree is set up (the card shows each step).
			await this.worktreeSetup.run(task.childId, {
				repoRoot: root.fsPath,
				worktreePath: created.path,
				branch: created.branch,
				isCancelled: () => isTerminalTaskState(this.state.tasks[taskId]?.state ?? 'cancelled'),
			});
			this.apply({ type: 'task.worktree', taskId, path: created.path, branch: created.branch });
		} catch (err) {
			this.apply({ type: 'task.error', taskId, error: `Could not create its worktree: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			this.worktreesInFlight.delete(taskId);
		}
	}

	//#endregion

	//#region Runtime observer

	/** Every runtime event of a chat the orchestrator knows becomes a command (most are no-ops). */
	private observe(envelope: IVoltEventEnvelope): void {
		const threadId = envelope.sessionId;
		const thread = this.state.threads[threadId];
		if (!thread) {
			return;
		}
		const event = envelope.event;
		switch (event.type) {
			case 'run.start': {
				const turnId = this.dispatching.get(threadId);
				this.apply({ type: 'run.started', threadId, runId: envelope.runId, ...(turnId ? { turnId } : {}), steerable: this.runtime.canSteer(threadId) });
				return;
			}
			case 'error':
				this.lastError.set(envelope.runId, event.message);
				return;
			case 'run.end': {
				const outcome: OrchOutcome = event.reason === 'done' ? 'done' : event.reason === 'abort' ? 'cancelled' : 'failed';
				const error = this.lastError.get(envelope.runId);
				this.lastError.delete(envelope.runId);
				const reply = outcome === 'done' ? this.lastReply(threadId) : undefined;
				this.clearCancelWatch(threadId);
				this.apply({ type: 'run.settled', threadId, runId: envelope.runId, outcome, ...(error && outcome === 'failed' ? { error } : {}), ...(reply !== undefined ? { reply } : {}) });
				return;
			}
			case 'question.ask':
				this.apply({ type: 'input.opened', threadId, inputId: event.request.id, kind: 'question' });
				return;
			case 'question.resolved':
				this.apply({ type: 'input.closed', threadId, inputId: event.requestId });
				return;
			case 'access.ask':
				this.apply({ type: 'input.opened', threadId, inputId: event.request.id, kind: 'approval' });
				return;
			case 'access.resolved':
				this.apply({ type: 'input.closed', threadId, inputId: event.requestId });
				return;
			case 'tool.start': {
				if (thread.taskId) {
					// A Volt subagent's step is its row's live line in the parent ("Read home.html").
					const task = this.state.tasks[thread.taskId];
					const activity = (event.title || event.name || '').replace(/\s+/g, ' ').trim();
					if (task && activity) {
						this.apply({ type: 'task.progress', taskId: task.id, activity: activity.length > 80 ? `${activity.slice(0, 79)}…` : activity, steps: task.steps + 1 });
					}
				}
				if (bareTaskToolName(event.name) === DELEGATE_TASK_TOOL_NAME || bareTaskToolName(event.title) === DELEGATE_TASK_TOOL_NAME) {
					const calls = this.delegateCalls.get(threadId) ?? [];
					calls.push(event.callId);
					this.delegateCalls.set(threadId, calls.slice(-16));
					return;
				}
				this.observeHarnessCall(threadId, event.callId, event.name, event.title, event.input);
				return;
			}
			case 'tool.update':
				if (this.state.tasks[harnessTaskId(event.callId)] && event.title) {
					const call = harnessSubagentCall(undefined, event.title, undefined);
					this.apply({ type: 'harness.progress', threadId, toolCallId: event.callId, ...(call?.title && call.title !== 'Subagent' ? { title: call.title } : {}) });
				}
				return;
			case 'tool.input.delta':
				if (this.state.tasks[harnessTaskId(event.callId)] && !event.append) {
					const call = harnessSubagentCall('task', undefined, event.delta);
					if (call && call.title !== 'Subagent') {
						this.apply({ type: 'harness.progress', threadId, toolCallId: event.callId, title: call.title, ...(call.kind ? { kind: call.kind } : {}) });
					}
				}
				return;
			case 'tool.progress':
				if (this.state.tasks[harnessTaskId(event.callId)]) {
					this.apply({ type: 'harness.progress', threadId, toolCallId: event.callId, activity: event.status });
				}
				return;
			case 'tool.end': {
				const task = this.state.tasks[harnessTaskId(event.callId)];
				if (!task || isTerminalTaskState(task.state)) {
					return;
				}
				if (isAsyncLaunchResult(event.result ?? event.output)) {
					// Claude launched the child in the background; it ends with the parent's turn.
					this.asyncHarness.add(task.id);
					this.apply({ type: 'harness.progress', threadId, toolCallId: event.callId, activity: 'Working in the background' });
					return;
				}
				const failure = event.error ?? harnessFailure(event.result);
				this.apply({ type: 'harness.ended', threadId, toolCallId: event.callId, ok: !failure, ...(failure ? { error: failure } : {}), ...(event.output ? { result: event.output } : {}) });
				return;
			}
			case 'file.change':
				this.apply({ type: 'file.changed', threadId, path: event.uri.fsPath });
				return;
			case 'subagent.spawned':
				this.apply({
					type: 'harness.started',
					threadId,
					toolCallId: event.childId,
					title: event.title,
					...(event.kind ? { kind: event.kind } : {}),
					...(event.prompt ? { brief: event.prompt } : {}),
					...(event.model ? { modelLabel: event.model } : {}),
				});
				return;
			case 'subagent.update':
				if (this.state.tasks[harnessTaskId(event.childId)]) {
					this.apply({
						type: 'harness.progress',
						threadId,
						toolCallId: event.childId,
						...(event.activity ? { activity: event.activity } : {}),
						...(event.title ? { title: event.title } : {}),
						...(event.model ? { modelLabel: event.model } : {}),
					});
				}
				return;
			case 'subagent.completed':
				this.asyncHarness.delete(harnessTaskId(event.childId));
				this.apply({
					type: 'harness.ended',
					threadId,
					toolCallId: event.childId,
					ok: event.status === 'completed',
					...(event.result ? { result: event.result } : {}),
					...(event.error ? { error: event.error } : event.status === 'cancelled' ? { error: 'Stopped.' } : {}),
				});
				return;
		}
	}

	private observeHarnessCall(threadId: string, callId: string, name: string | undefined, title: string | undefined, input: string | undefined): void {
		const call = harnessSubagentCall(name, title, input);
		if (!call) {
			return;
		}
		if (call.phase === 'end') {
			// Codex's completion bookend names the subagent by its thread id.
			const task = call.key ? Object.values(this.state.tasks).find(candidate => candidate.parentId === threadId && candidate.source === 'harness' && candidate.kind === `codex:${call.key}` && !isTerminalTaskState(candidate.state)) : undefined;
			if (task?.toolCallId) {
				this.apply({ type: 'harness.ended', threadId, toolCallId: task.toolCallId, ok: true });
			}
			return;
		}
		this.apply({
			type: 'harness.started',
			threadId,
			toolCallId: callId,
			title: call.title,
			...(call.key ? { kind: `codex:${call.key}` } : call.kind ? { kind: call.kind } : {}),
			...(call.brief ? { brief: call.brief } : {}),
			...(call.model ? { modelLabel: call.model } : {}),
		});
	}

	private clearCancelWatch(threadId: string): void {
		for (const [key, timer] of this.cancelWatch) {
			if (key.startsWith(`${threadId}\0`)) {
				clearTimeout(timer);
				this.cancelWatch.delete(key);
			}
		}
	}

	private lastReply(threadId: string): string | undefined {
		const last = this.runtime.getOrCreateSession(threadId).messages.at(-1);
		return last?.role === 'assistant' ? last.content : undefined;
	}

	//#endregion

	//#region MCP task tools

	private async invokeTaskTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const threadId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		if (!threadId) {
			return { error: `${name} only works from a Volt chat.` };
		}
		await this.whenReady;
		const token = call?.token ?? CancellationToken.None;
		try {
			switch (name) {
				case LIST_MODELS_TOOL_NAME:
					return { text: this.listModels(threadId) };
				case DELEGATE_TASK_TOOL_NAME:
					return await this.delegate(threadId, args, token);
				case TASK_STATUS_TOOL_NAME:
					return { text: this.taskStatus(threadId, typeof args.task_id === 'string' ? args.task_id : undefined) };
				case WAIT_TASKS_TOOL_NAME:
					return { text: await this.waitTasks(threadId, Array.isArray(args.task_ids) ? args.task_ids.filter((id): id is string => typeof id === 'string') : undefined, args.any === true, token) };
				case CANCEL_TASK_TOOL_NAME:
					return this.cancelTask(threadId, String(args.task_id ?? ''), typeof args.reason === 'string' ? args.reason : undefined);
				case MESSAGE_TASK_TOOL_NAME:
					return await this.messageTask(threadId, String(args.task_id ?? ''), String(args.message ?? ''), args.wait === true, token);
				case HANDOFF_TOOL_NAME:
					return this.handoff(threadId, args);
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
		return { error: `Unknown tool ${name}` };
	}

	private listModels(threadId: string): string {
		const current = this.state.threads[threadId]?.modelRef ?? this.runtime.getOrCreateSession(threadId).providerRef;
		const items = this.runtime.listCatalog().filter(item => item.enabled);
		const lines = items.map(item => `- model: ${item.ref} · ${item.label}${item.qualifier ? ` (${item.qualifier})` : ''} · ${item.kind === 'agent' ? `agent harness ${item.providerId}` : `model via ${item.providerId}`}${item.ref === current ? ' · this chat' : ''}`);
		return lines.length ? ['Models Volt can run a task on (pass the `model` value):', ...lines].join('\n') : 'No models are connected.';
	}

	private resolveModel(value: unknown): { readonly ref: string; readonly label: string } | undefined {
		if (typeof value !== 'string' || !value.trim()) {
			return undefined;
		}
		const wanted = value.trim().toLowerCase();
		const items = this.runtime.listCatalog().filter(item => item.enabled);
		const match = items.find(item => item.ref.toLowerCase() === wanted)
			?? items.find(item => item.id.toLowerCase() === wanted)
			?? items.find(item => item.label.toLowerCase() === wanted)
			?? items.find(item => `${item.label} ${item.qualifier ?? ''}`.trim().toLowerCase() === wanted)
			?? items.find(item => item.label.toLowerCase().includes(wanted) || item.ref.toLowerCase().includes(wanted));
		if (!match) {
			throw new Error(`No connected model matches "${value}". Call list_models for the exact values.`);
		}
		return { ref: match.ref, label: match.label };
	}

	private async delegate(parentId: string, args: Record<string, unknown>, token: CancellationToken, binding?: { readonly toolCallId: string | undefined }): Promise<IVoltHostToolResult> {
		const brief = typeof args.task === 'string' ? args.task.trim() : '';
		if (!brief) {
			return { error: 'delegate_task needs a `task`: the complete brief for the subagent.' };
		}
		const fanOut = Array.isArray(args.models) ? [...new Set(args.models.filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()))] : [];
		if (fanOut.length > 1 && !binding) {
			return this.delegateToModels(parentId, args, fanOut, token);
		}
		const parent = this.state.threads[parentId];
		const previousId = typeof args.previous_task_id === 'string' && args.previous_task_id.trim() ? args.previous_task_id.trim() : undefined;
		const previous = previousId ? this.state.tasks[previousId] : undefined;
		if (previousId && (!previous || previous.rootId !== parent?.rootId)) {
			return { error: `No task ${previousId} in this chat to continue from. Call task_status to list this chat's tasks.` };
		}
		// A new round keeps the previous round's reviewer and role unless the agent picks others.
		const model = this.resolveModel(args.model)
			?? (previous?.modelRef ? { ref: previous.modelRef, label: previous.modelLabel ?? previous.modelRef } : undefined)
			?? (parent?.modelRef ? { ref: parent.modelRef, label: parent.modelLabel ?? parent.modelRef } : undefined);
		const role = typeof args.role === 'string' || !previous ? normalizeTaskRole(args.role) : previous.role;
		const isolation = args.isolation === 'worktree' ? 'worktree' : 'shared';
		const parentMode = parent?.active?.prompt.mode ? normalizeVoltMode(parent.active.prompt.mode) : 'agent';
		// A child never gets more than its parent: a read-only chat delegates read-only work.
		const mode = parentMode === 'ask' || parentMode === 'plan' ? 'ask' : modeForTaskRole(role, undefined);
		const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 80) : previous?.title ?? titleFromBrief(brief);
		const taskId = newTaskId(id => !!this.state.tasks[id]);
		const depth = (parent?.depth ?? 0) + 1;
		const toolCallId = binding ? binding.toolCallId : this.delegateCalls.get(parentId)?.shift();
		const step = this.apply({
			type: 'task.spawn',
			spawn: {
				parentId,
				brief,
				title,
				role,
				origin: 'agent',
				isolation,
				taskId,
				childId: `${CHILD_ID_PREFIX}${generateUuid()}`,
				mode,
				...(model ? { modelRef: model.ref, modelLabel: model.label } : {}),
				...(typeof args.client_request_id === 'string' && args.client_request_id.trim() ? { clientRequestId: args.client_request_id.trim() } : {}),
				...(toolCallId ? { toolCallId } : {}),
				...(Array.isArray(args.scope) ? { scope: args.scope.filter((path): path is string => typeof path === 'string') } : {}),
				...(previous ? { previousTaskId: previous.id } : {}),
				childPrompt: {
					text: buildTaskPrompt(brief, {
						parentTitle: parent?.title,
						role,
						depth,
						isolation,
						...(previous ? { previous: { id: previous.id, iteration: previous.iteration ?? 1, brief: previous.brief, result: previous.result, state: previous.state } } : {}),
					}),
					display: { text: brief, brief: true },
					mode,
					...(model ? { modelRef: model.ref } : {}),
				},
			},
		});
		if (step.decision.rejected) {
			return { error: step.decision.rejected };
		}
		const id = step.decision.taskId!;
		if (args.wait === true) {
			await this.waitFor([id], false, TASK_WAIT_MS, token);
		}
		const task = this.state.tasks[id];
		const lines = [
			step.decision.reused ? `This task is already running (task_id: ${id}); it was not started again.` : `Started task ${id}.`,
			describeTask(task, Date.now(), { includeResult: true }),
		];
		if (isTerminalTaskState(task.state)) {
			this.apply({ type: 'task.ack', taskIds: [id] });
		} else {
			lines.push('Its report is delivered to this chat as a new message when it finishes; you may end your turn. Call wait_tasks only if you need the result before you can continue.');
		}
		return { text: lines.join('\n') };
	}

	/**
	 * One brief, several models: a task each (independent reviews, competing designs). The parent's
	 * delegate_task row belongs to the first; every report comes back like any task's.
	 */
	private async delegateToModels(parentId: string, args: Record<string, unknown>, names: readonly string[], token: CancellationToken): Promise<IVoltHostToolResult> {
		if (names.length > MAX_FAN_OUT) {
			return { error: `delegate_task runs one brief on at most ${MAX_FAN_OUT} models at once.` };
		}
		// Resolve every model first: an unknown one starts nothing.
		const models = names.map(name => this.resolveModel(name)!);
		const toolCallId = this.delegateCalls.get(parentId)?.shift();
		const key = typeof args.client_request_id === 'string' && args.client_request_id.trim() ? args.client_request_id.trim() : undefined;
		const baseTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : titleFromBrief(String(args.task));
		const ids: string[] = [];
		const lines: string[] = [];
		for (const [index, model] of models.entries()) {
			const result = await this.delegate(parentId, {
				...args,
				models: undefined,
				model: model.ref,
				wait: false,
				title: `${baseTitle} · ${model.label}`,
				...(key ? { client_request_id: `${key}:${model.ref}` } : {}),
			}, token, { toolCallId: index === 0 ? toolCallId : undefined });
			const id = /\b(t-[0-9a-f]{6})\b/.exec(result.text ?? '')?.[1];
			if (id) {
				ids.push(id);
			}
			lines.push(`${model.label}: ${result.error ?? result.text?.split('\n')[0] ?? ''}`);
		}
		if (args.wait === true && ids.length) {
			await this.waitFor(ids, false, TASK_WAIT_MS, token);
		}
		const now = Date.now();
		const tasks = ids.map(id => this.state.tasks[id]).filter((task): task is IOrchTask => !!task);
		const finished = tasks.filter(task => isTerminalTaskState(task.state));
		if (finished.length) {
			this.apply({ type: 'task.ack', taskIds: finished.map(task => task.id) });
		}
		return {
			text: [
				`Started the same brief on ${ids.length} models:`,
				...lines,
				...tasks.map(task => describeTask(task, now, { includeResult: isTerminalTaskState(task.state) })),
				finished.length === tasks.length ? '' : 'Their reports are delivered to this chat as they finish; you may end your turn. wait_tasks returns them sooner if you need them now.',
			].filter(Boolean).join('\n'),
		};
	}

	private visibleTasks(threadId: string): IOrchTask[] {
		return Object.values(this.state.tasks).filter(task => task.parentId === threadId && task.source === 'volt').sort((a, b) => a.createdAt - b.createdAt);
	}

	private taskStatus(threadId: string, taskId: string | undefined): string {
		const now = Date.now();
		if (taskId) {
			const task = this.state.tasks[taskId];
			if (!task) {
				return `No task ${taskId}.`;
			}
			if (isTerminalTaskState(task.state)) {
				this.apply({ type: 'task.ack', taskIds: [task.id] });
			}
			return describeTask(task, now, { includeResult: true });
		}
		const tasks = this.visibleTasks(threadId);
		if (!tasks.length) {
			return 'This chat has not delegated any tasks.';
		}
		const finished = tasks.filter(task => isTerminalTaskState(task.state)).map(task => task.id);
		if (finished.length) {
			this.apply({ type: 'task.ack', taskIds: finished });
		}
		return tasks.map(task => describeTask(task, now, { includeResult: true })).join('\n\n');
	}

	private async waitTasks(threadId: string, ids: readonly string[] | undefined, any: boolean, token: CancellationToken): Promise<string> {
		const wanted = ids?.length ? ids : this.visibleTasks(threadId).filter(task => isLiveTaskState(task.state) || task.delivery === 'pending').map(task => task.id);
		if (!wanted.length) {
			return 'No delegated tasks to wait for.';
		}
		await this.waitFor(wanted, any, TASK_WAIT_MS, token);
		const now = Date.now();
		const tasks = wanted.map(id => this.state.tasks[id]).filter((task): task is IOrchTask => !!task);
		const finished = tasks.filter(task => isTerminalTaskState(task.state));
		if (finished.length) {
			this.apply({ type: 'task.ack', taskIds: finished.map(task => task.id) });
		}
		const waiting = tasks.filter(task => task.state === 'waiting');
		const running = tasks.filter(task => task.state === 'running' || task.state === 'queued');
		const parts = finished.map(task => describeTask(task, now, { includeResult: true }));
		if (waiting.length) {
			parts.push(`Waiting for the user: ${waiting.map(task => `${task.id} "${task.title}"`).join(', ')}. The user answers in that subagent's chat; do not wait on it.`);
		}
		if (running.length) {
			parts.push(`Still running (the wait only bounds this call; they are fine): ${running.map(task => `${task.id} "${task.title}"${task.activity ? ` (now: ${task.activity})` : ''}`).join('; ')}. Call wait_tasks again, or end your turn and their reports arrive as a message.`);
		}
		return parts.join('\n\n');
	}

	/** Resolves when every task (or one, with `any`) finished or waits for the user, or after `ms`. */
	private async waitFor(ids: readonly string[], any: boolean, ms: number, token: CancellationToken): Promise<void> {
		const done = () => {
			const tasks = ids.map(id => this.state.tasks[id]).filter((task): task is IOrchTask => !!task);
			const settled = tasks.filter(task => isTerminalTaskState(task.state) || task.state === 'waiting');
			return !tasks.length || (any ? settled.length > 0 : settled.length === tasks.length);
		};
		if (done()) {
			return;
		}
		await new Promise<void>(resolve => {
			const listener = this.onDidChangeTasks(() => {
				if (done()) {
					finish();
				}
			});
			const cancel = token.onCancellationRequested(() => finish());
			const timer = setTimeout(() => finish(), ms);
			const finish = () => {
				listener.dispose();
				cancel.dispose();
				clearTimeout(timer);
				resolve();
			};
		});
	}

	private cancelTask(threadId: string, taskId: string, reason: string | undefined): IVoltHostToolResult {
		const task = this.state.tasks[taskId];
		if (!task || task.rootId !== this.state.threads[threadId]?.rootId) {
			return { error: `No task ${taskId} in this chat.` };
		}
		const step = this.apply({ type: 'task.cancel', taskId, ...(reason ? { reason } : {}) });
		if (step.decision.rejected) {
			return { error: step.decision.rejected };
		}
		return { text: `Cancelled ${taskId} "${task.title}". Its partial work stays in its chat.` };
	}

	private async messageTask(threadId: string, taskId: string, message: string, wait: boolean, token: CancellationToken): Promise<IVoltHostToolResult> {
		const task = this.state.tasks[taskId];
		if (!task || task.rootId !== this.state.threads[threadId]?.rootId) {
			return { error: `No task ${taskId} in this chat.` };
		}
		if (!message.trim()) {
			return { error: 'message_task needs a `message`.' };
		}
		const step = this.apply({ type: 'task.message', taskId, turnId: generateUuid(), prompt: { text: buildTaskFollowUp(message), display: { text: message.trim() }, ...(task.mode ? { mode: task.mode } : {}), ...(task.modelRef ? { modelRef: task.modelRef } : {}) } });
		if (step.decision.rejected) {
			return { error: step.decision.rejected };
		}
		if (wait) {
			await timeout(50);
			await this.waitFor([taskId], false, TASK_WAIT_MS, token);
		}
		const current = this.state.tasks[taskId];
		if (isTerminalTaskState(current.state)) {
			this.apply({ type: 'task.ack', taskIds: [taskId] });
		}
		return { text: `Sent the follow-up to ${taskId}.\n${describeTask(current, Date.now(), { includeResult: true })}` };
	}

	private handoff(threadId: string, args: Record<string, unknown>): IVoltHostToolResult {
		const model = this.resolveModel(args.model);
		if (!model) {
			return { error: 'handoff needs a `model` from list_models.' };
		}
		const brief = typeof args.brief === 'string' ? args.brief.trim() : '';
		const step = this.apply({ type: 'thread.handoff', threadId, to: model.ref, toLabel: model.label, by: 'agent', ...(brief ? { brief } : {}), ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}) });
		if (step.decision.rejected) {
			return { error: step.decision.rejected };
		}
		return { text: `When this turn ends, the chat continues on ${model.label} with your brief. Finish with a short note to the user.` };
	}

	//#endregion
}

function touched(event: OrchEvent): { threadIds: string[]; taskIds: string[] } {
	switch (event.type) {
		case 'thread.created':
			return { threadIds: [event.thread.id, ...(event.thread.parentId ? [event.thread.parentId] : [])], taskIds: event.thread.taskId ? [event.thread.taskId] : [] };
		case 'task.created':
			return { threadIds: [event.task.parentId, ...(event.task.childId ? [event.task.childId] : [])], taskIds: [event.task.id] };
		case 'task.started':
		case 'task.updated':
		case 'task.waiting':
		case 'task.settled':
		case 'task.resumed':
		case 'task.restarted':
			return { threadIds: [], taskIds: [event.taskId] };
		case 'task.delivery':
		case 'task.pruned':
			return { threadIds: [], taskIds: [...event.taskIds] };
		case 'conflict.detected':
		case 'conflict.cleared':
			return { threadIds: [event.rootId], taskIds: [] };
		default:
			return { threadIds: 'threadId' in event ? [event.threadId] : [], taskIds: [] };
	}
}

registerSingleton(IAgentOrchestratorService, AgentOrchestratorService, InstantiationType.Delayed);
