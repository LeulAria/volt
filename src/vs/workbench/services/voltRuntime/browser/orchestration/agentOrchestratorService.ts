/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, IntervalTimer, raceTimeout, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILifecycleService } from '../../../lifecycle/common/lifecycle.js';
import { IVoltEventEnvelope } from '../../common/events.js';
import { IAgentWorktreeService } from '../../common/git/agentWorktree.js';
import { IWorkspaceMoveSpec, workspaceTargetLabel } from '../../common/git/workspaceMove.js';
import { IAgentWorktreeSetupService } from '../../common/git/worktreeSetupPlan.js';
import { IAgentHistoryService } from '../../common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { retryDelay, RUN_START_RETRY } from '../../common/jobs/retryPolicy.js';
import { normalizeVoltMode } from '../../common/modes.js';
import { agentTaskTools, bareTaskToolName, buildTaskFollowUp, buildTaskPrompt, CANCEL_TASK_TOOL_NAME, DELEGATE_TASK_TOOL_NAME, describeTask, HANDOFF_TOOL_NAME, isLiveTaskState, isTerminalTaskState, LIST_MODELS_TOOL_NAME, MESSAGE_TASK_TOOL_NAME, modeForTaskRole, newTaskId, normalizeTaskRole, TASK_STATUS_TOOL_NAME, TASK_WAIT_MS, titleFromBrief, WAIT_TASKS_TOOL_NAME } from '../../common/orchestration/agentTasks.js';
import { harnessFailure, harnessSubagentCall, isAsyncLaunchResult } from '../../common/orchestration/harnessSubagents.js';
import { DEFAULT_ORCH_LIMITS, emptyOrchState, IAgentOrchestratorService, IOrchChange, IOrchEventEnvelope, IOrchLimitAccount, IOrchLimits, IOrchMove, IOrchTurn, IOrchPrompt, IOrchState, IOrchSubmitResult, IOrchTask, IOrchThread, IOrchTurnHost, IOrchWorkspaceMover, ORCH_KEEP_WORKING_SETTING, ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_PER_CALL_SETTING, ORCH_RESUME_AFTER_RESTART_SETTING, ORCHESTRATOR_STATE_VERSION, orchHoldReason, OrchCommandBody, OrchDelivery, OrchEffect, OrchEvent, OrchOutcome, OrchRestartResume, readOrchLimits } from '../../common/orchestration/orchestrator.js';
import { ILimitSignal, isClaudeProvider, isRealAnswer, LIMIT_AUTO_RESUME_SETTING, LIMIT_STOP_CLAUDE_SETTING, limitDueAt, limitFromError, limitFromNotice, limitFromReply, mergeLimitSignals } from '../../common/orchestration/limitRecovery.js';
import { extractRoot, IOrchIndex, IOrchRootSnapshot, isRootLive, mergeRoot, rootIdsOf } from '../../common/orchestration/orchestratorCodec.js';
import { isRescueTurnId, rescueDueAt, rescueWaits } from '../../common/orchestration/rescue.js';
import { failureRetryCount, harnessTaskId, IOrchStep, isFailureRetryTurn, limitTickWaits, runOrchCommand } from '../../common/orchestration/orchestratorDecider.js';
import { IAgentRuntimeService } from '../../common/runtime.js';
import { IVoltSessionContextService } from '../../common/sessionContext.js';
import { DeadlineTimer } from '../jobs/deadlineTimer.js';
import { DurableClaims } from '../jobs/durableClaims.js';
import { BEACON_TTL_MS, WorkbenchBeacons } from '../jobs/workbenchBeacons.js';
import { OrchestratorStore } from './orchestratorStore.js';
import { orchIsTurnCurrent, orchTaskForToolCall, orchTasksOf } from '../../common/orchestration/orchestratorQueries.js';

/** Models one delegate_task call may run the same brief on. */
const MAX_FAN_OUT = 4;
/** A cancelled run that does not report its end within this long is settled by Volt. */
const CANCEL_SETTLE_MS = 6_000;
/** A Volt chat id for a subagent's chat; the agent editor reads session ids from this shape. */
const CHILD_ID_PREFIX = 'agent-';
/** How often Volt checks that what it believes is running really is (lost run ends, stuck starts and stops). */
const WATCHDOG_MS = 20_000;
/** Watchdog ticks in a row a turn must look stuck before Volt acts on it (an event may be on its way). */
const WATCHDOG_STRIKES = 2;
/** A turn whose start has not reached the runtime after this long fails (and is tried again), so its chat does not hang on "Starting". */
const START_STALL_MS = 180_000;
/**
 * A live run that has sent nothing for this long (no text, reasoning or tool event) and is not
 * waiting on the user is taken as hung: its agent is restarted and the turn continues.
 */
const SILENT_RUN_MS = 10 * 60_000;
/** The same while one of its tool calls is open: builds, test suites and installs may run quietly. */
const SILENT_TOOL_RUN_MS = 30 * 60_000;
/** A gap this much longer than the watchdog's tick means the machine slept: silence over it is not the agent's. */
const SLEEP_GAP_MS = WATCHDOG_MS * 3;
/** A message put into a running agent that is not taken within this long goes back to the queue instead. */
const STEER_TIMEOUT_MS = 60_000;
/** Failed writes are tried again after 1 s, doubling up to this. */
const PERSIST_RETRY_MAX_MS = 30_000;
/** How soon a change to a chat tree is written. */
const PERSIST_MS = 250;
/** How soon a change that is only subagent progress (activity text, step counts) is written. */
const PROGRESS_PERSIST_MS = 5_000;
/** A usage-limit tick that resumed nothing looks again after this, at the soonest. */
const LIMIT_TICK_RECHECK_MS = 30_000;

export class AgentOrchestratorService extends Disposable implements IAgentOrchestratorService {

	declare readonly _serviceBrand: undefined;

	private state: IOrchState = emptyOrchState();
	/** Concurrency from Settings (multitask agents and subagents at once), the rest the defaults. */
	private limits: IOrchLimits = DEFAULT_ORCH_LIMITS;
	private readonly taskTools = this._register(new MutableDisposable());
	private readonly store: OrchestratorStore;
	/** Newest events per root, persisted with the root as its audit trail. */
	private readonly rootEvents = new Map<string, IOrchEventEnvelope[]>();
	private readonly dirtyRoots = new Set<string>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the waiting write fires. */
	private persistDue = 0;
	private persisting: Promise<void> = Promise.resolve();
	private persistRetry: ReturnType<typeof setTimeout> | undefined;
	private persistFailures = 0;
	private knownRoots = new Set<string>();
	private lastIndex = '';
	private host: IOrchTurnHost | undefined;
	private readonly waitingForHost: Extract<OrchEffect, { kind: 'startTurn' }>[] = [];
	/** The turn whose start is in flight per chat: a `run.start` seen now belongs to it. */
	private readonly dispatching = new Map<string, string>();
	/** When each in-flight start began, by turn: a start that never reaches the runtime is failed. */
	private readonly startingSince = new Map<string, number>();
	/** Turns whose start effect is decided but not begun (waiting for the write, or for a host). */
	private readonly owedStarts = new Set<string>();
	/** Watchdog ticks in a row each suspect looked stuck. */
	private suspects = new Map<string, number>();
	/** The last sign of life of each live run, and its tool calls still open (see `silence`). */
	private readonly pulses = new Map<string, { at: number; readonly tools: Set<string> }>();
	/** Runs the watchdog restarted for going silent: their end settles as a transient failure. */
	private readonly silentRuns = new Set<string>();
	private lastWatchdogTick = Date.now();
	private readonly cancelWatch = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly lastError = new Map<string, string>();
	private readonly worktreesInFlight = new Set<string>();
	/** Runs a provider's usage limit stopped, with what it said. */
	private readonly limitedRuns = new Map<string, ILimitSignal>();
	/** Wakes parked chats at their resume time, also after the machine slept (see DeadlineTimer). */
	private readonly limitTimer: DeadlineTimer;
	/** Exactly-once gates shared with the other Volt workbenches (each project runs one). */
	private readonly claims: DurableClaims;
	/** Restarts chats whose work stopped before it was done, at their back-off (see `IOrchRescue`). */
	private readonly rescueTimer: DeadlineTimer;
	/** The chats each other live workbench is running, so this one never runs them twice. */
	private readonly beacons: WorkbenchBeacons;
	/** Chat trees another Volt window ran at startup, taken over once that window is gone (`adoptLater`). */
	private readonly adopting = new Set<string>();
	private adoptTimer: ReturnType<typeof setTimeout> | undefined;
	/** Each live run's latest plan (to-do list): a turn that ends with items open continues. */
	private readonly plans = new Map<string, readonly { readonly content: string; readonly status: string }[]>();
	/** Runs that changed files: a plan round that closed no item still got somewhere. */
	private readonly changedRuns = new Set<string>();
	/** Assistant text of resumes that have not heard back from the provider yet, by run. */
	private readonly probeText = new Map<string, string>();
	private mover: IOrchWorkspaceMover | undefined;
	private readonly waitingForMover: Extract<OrchEffect, { kind: 'moveWorkspace' }>[] = [];
	private readonly movesInFlight = new Set<string>();
	/** `delegate_task` calls seen in a chat's stream, oldest first, waiting for the MCP call that matches. */
	private readonly delegateCalls = new Map<string, { readonly callId: string; readonly turnId: string | undefined }[]>();
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
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentWorktreeSetupService private readonly worktreeSetup: IAgentWorktreeSetupService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.store = new OrchestratorStore(joinPath(environmentService.userRoamingDataHome, 'voltOrchestrator'), fileService, logService);
		this.claims = new DurableClaims(joinPath(environmentService.userRoamingDataHome, 'voltJobs', 'claims'), fileService, logService);
		this.limitTimer = this._register(new DeadlineTimer(() => this.limitTick()));
		this.rescueTimer = this._register(new DeadlineTimer(() => this.rescueTick()));
		this.beacons = new WorkbenchBeacons(joinPath(environmentService.userRoamingDataHome, 'voltJobs', 'workbenches'), fileService, logService);
		this._register(runtime.onDidEmit(envelope => this.observe(envelope)));
		this.limits = this.readLimits();
		this.registerTaskTools();
		// Changes from the last quarter second (and writes still retrying) reach the disk before the window closes.
		this._register(lifecycleService.onWillShutdown(e => e.join(Promise.all([this.flush(), this.beacons.clear()]).then(() => undefined), { id: 'volt.agentOrchestrator', label: 'Saving agent orchestration' })));
		this._register(new IntervalTimer()).cancelAndSet(() => this.checkLiveness(), WATCHDOG_MS);
		this._register(toDisposable(() => {
			if (this.persistTimer !== undefined) {
				clearTimeout(this.persistTimer);
			}
			if (this.persistRetry !== undefined) {
				clearTimeout(this.persistRetry);
			}
			if (this.adoptTimer !== undefined) {
				clearTimeout(this.adoptTimer);
			}
			for (const timer of this.cancelWatch.values()) {
				clearTimeout(timer);
			}
		}));
		// Parked chats wake at their reset, stopped work at its back-off: the timers follow the state.
		this._register(this.onDidChange(() => {
			this.scheduleLimitTick();
			this.scheduleRescueTick();
		}));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ORCH_KEEP_WORKING_SETTING)) {
				this.limits = this.readLimits();
				if (!this.limits.supervise) {
					// Turned off: chats waiting to be restarted wait for the user instead.
					for (const thread of Object.values(this.state.threads)) {
						if (thread.rescue) {
							this.apply({ type: 'rescue.stop', threadId: thread.id });
						}
					}
				}
				this.scheduleRescueTick();
			}
			if (e.affectsConfiguration(ORCH_MAX_PARALLEL_SETTING) || e.affectsConfiguration(ORCH_MAX_PARALLEL_TOTAL_SETTING) || e.affectsConfiguration(ORCH_MAX_PER_CALL_SETTING)) {
				const perCall = this.limits.spawnsPerCall;
				this.limits = this.readLimits();
				if (this.limits.spawnsPerCall !== perCall) {
					this.registerTaskTools();
				}
				// A no-op command runs the scheduler: queued agents start at once when there is more room.
				this.apply({ type: 'task.ack', taskIds: [] });
			}
			if (e.affectsConfiguration(LIMIT_AUTO_RESUME_SETTING)) {
				this.scheduleLimitTick();
				this._onDidChange.fire({ threads: Object.values(this.state.threads).filter(thread => thread.limit).map(thread => thread.id), tasks: [] });
			}
		}));
		void this.restore();
	}

	private readLimits(): IOrchLimits {
		return readOrchLimits(key => this.configurationService.getValue<unknown>(key));
	}

	/** Serves the task tools; registering again (a new per-call limit) has MCP clients re-read the list. */
	private registerTaskTools(): void {
		this.taskTools.value = this.hostTools.registerToolProvider({
			tools: agentTaskTools(this.limits.spawnsPerCall).map(tool => ({ ...tool, group: 'tasks' as const })),
			invoke: (name, args, call) => this.invokeTaskTool(name, args, call),
		});
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
		return orchTasksOf(this.state, threadId);
	}

	taskForToolCall(threadId: string, toolCallId: string): IOrchTask | undefined {
		return orchTaskForToolCall(this.state, threadId, toolCallId);
	}

	async dispatch(command: OrchCommandBody & { readonly id?: string }): Promise<readonly OrchEvent[]> {
		const loading = this.loadedFor(commandThreadId(command));
		if (loading) {
			await loading;
		}
		return this.apply(command, command.id).decision.events;
	}

	/**
	 * What a command must wait for: the restore (a command applied before it would be dropped when
	 * the saved state lands) and the chat's saved tree (a command creating the chat would otherwise
	 * replace that tree on the next write). Undefined when both are there, so the command applies at once.
	 */
	private loadedFor(threadId: string | undefined): Promise<void> | undefined {
		if (this.ready.isSettled && (threadId === undefined || this.state.threads[threadId])) {
			return undefined;
		}
		return threadId === undefined ? this.whenReady : this.ensureThreadLoaded(threadId);
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

	async move(threadId: string, spec: IWorkspaceMoveSpec, options: { readonly by: 'user' | 'agent'; readonly stop?: boolean }): Promise<IOrchSubmitResult> {
		await this.ensureThreadLoaded(threadId);
		const move: IOrchMove = { id: generateUuid(), target: spec, label: workspaceTargetLabel(spec.target), by: options.by, at: Date.now() };
		const step = this.apply({ type: 'thread.move', threadId, move, ...(options.stop ? { stop: true } : {}) });
		const outcome = step.decision.outcome;
		return outcome ? { outcome } : { outcome: 'rejected', ...(step.decision.rejected ? { reason: step.decision.rejected } : {}) };
	}

	async resumeLimit(threadId: string): Promise<IOrchSubmitResult> {
		await this.ensureThreadLoaded(threadId);
		const step = this.apply({ type: 'limit.resume', threadId });
		const outcome = step.decision.outcome;
		return outcome ? { outcome } : { outcome: 'rejected', ...(step.decision.rejected ? { reason: step.decision.rejected } : {}) };
	}

	async configureLimit(threadId: string, auto: boolean | undefined): Promise<void> {
		const loading = this.loadedFor(threadId);
		if (loading) {
			await loading;
		}
		this.apply({ type: 'limit.configure', threadId, auto });
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
		const loading = this.loadedFor(threadId);
		if (loading) {
			await loading;
		}
		this.apply({ type: 'turn.cancel', threadId, ...(options?.cascade ? { cascade: options.cascade } : {}) });
		// A run the orchestrator does not know as this chat's turn (it lost track, or never had it)
		// would ignore the stop above: the runtime stops whatever still runs there.
		if (!this.state.threads[threadId]?.active) {
			void this.runtime.cancel(threadId).catch(err => this.logService.warn('[volt orchestrator] cancel failed', err));
		}
		this._onDidStop.fire(threadId);
	}

	isTurnCurrent(threadId: string, turnId: string): boolean {
		return orchIsTurnCurrent(this.state, threadId, turnId);
	}

	setWorkspaceMover(mover: IOrchWorkspaceMover): IDisposable {
		this.mover = mover;
		for (const effect of this.waitingForMover.splice(0)) {
			void this.moveWorkspace(effect);
		}
		return toDisposable(() => {
			if (this.mover === mover) {
				this.mover = undefined;
			}
		});
	}

	autoResumeDefault(): boolean {
		return this.configurationService.getValue<boolean>(LIMIT_AUTO_RESUME_SETTING) !== false;
	}

	/**
	 * Arms one timer for the earliest parked chat that resumes on its own. When it fires, the
	 * decider resumes what is due (and staggers the rest), and the next change re-arms it. The
	 * timer reads the wall clock, so a reset that passed while the machine slept is not missed.
	 */
	/** `notBefore`: a tick that found nothing due looks again no sooner than this (never a spin). */
	private scheduleLimitTick(notBefore = 0): void {
		const auto = this.autoResumeDefault();
		let next = Number.POSITIVE_INFINITY;
		for (const thread of Object.values(this.state.threads)) {
			if (limitTickWaits(thread, auto)) {
				next = Math.min(next, limitDueAt(thread.limit!));
			}
		}
		this.limitTimer.schedule(Number.isFinite(next) ? Math.max(next, notBefore) : undefined);
	}

	private limitTick(): void {
		const step = this.apply({ type: 'limit.tick', autoResume: this.autoResumeDefault() });
		const resumed = step.envelopes.filter(envelope => envelope.event.type === 'turn.dispatched').map(envelope => (envelope.event as Extract<OrchEvent, { type: 'turn.dispatched' }>).threadId);
		if (resumed.length) {
			this.logService.info(`[volt orchestrator] usage limit: resuming ${resumed.join(', ')}`);
		}
		// Nothing changed (a stagger slot not reached yet): look again, but not in a loop. A change
		// in the meantime (a move ends, a block clears) re-arms through onDidChange.
		if (!step.envelopes.length) {
			this.scheduleLimitTick(Date.now() + LIMIT_TICK_RECHECK_MS);
		}
	}

	keepsWorking(): boolean {
		return this.limits.supervise;
	}

	/** Arms one timer for the earliest chat waiting to be restarted; it reads the wall clock, so sleep does not lose it. */
	/** `notBefore`: as for {@link scheduleLimitTick}, a tick that restarted nothing never loops. */
	private scheduleRescueTick(notBefore = 0): void {
		let next = Number.POSITIVE_INFINITY;
		if (this.limits.supervise) {
			for (const thread of Object.values(this.state.threads)) {
				if (rescueWaits(thread)) {
					next = Math.min(next, rescueDueAt(thread.rescue!, thread.id));
				}
			}
		}
		this.rescueTimer.schedule(Number.isFinite(next) ? Math.max(next, notBefore) : undefined);
	}

	private rescueTick(): void {
		const step = this.apply({ type: 'rescue.tick' });
		for (const envelope of step.envelopes) {
			const event = envelope.event;
			if (event.type === 'rescue.armed') {
				this.logService.info(`[volt orchestrator] ${event.threadId}: restarting its stopped work (attempt ${event.rescue.attempts}${event.rescue.error ? `, after: ${event.rescue.error.slice(0, 120)}` : ''})`);
			}
		}
		if (!step.envelopes.length) {
			this.scheduleRescueTick(Date.now() + LIMIT_TICK_RECHECK_MS);
		}
	}

	/**
	 * Another Volt workbench claimed this chat's resume and runs it. This one lets go of the chat
	 * tree in memory only (the other one writes it from now on) and reads it from disk again when
	 * the chat is opened here, so the two never send the same turn.
	 */
	private releaseRoot(threadId: string, why: string): void {
		const rootId = this.state.threads[threadId]?.rootId;
		if (!rootId) {
			return;
		}
		const threads: Record<string, IOrchThread> = {};
		const gone: string[] = [];
		for (const [id, thread] of Object.entries(this.state.threads)) {
			if (thread.rootId === rootId) {
				gone.push(id);
			} else {
				threads[id] = thread;
			}
		}
		const tasks: Record<string, IOrchTask> = {};
		const goneTasks: string[] = [];
		for (const [id, task] of Object.entries(this.state.tasks)) {
			if (task.rootId === rootId) {
				goneTasks.push(id);
			} else {
				tasks[id] = task;
			}
		}
		const { [rootId]: _conflicts, ...conflicts } = this.state.conflicts;
		this.state = { ...this.state, threads, tasks, conflicts };
		this.rootEvents.delete(rootId);
		this.dirtyRoots.delete(rootId);
		this.knownRoots.add(rootId);
		this.logService.info(`[volt orchestrator] ${threadId}: ${why}; this window lets go of its chat tree`);
		this._onDidChange.fire({ threads: gone, tasks: goneTasks });
		// If that window goes away before the work is done, this one takes the tree back (its beacon goes stale).
		this.adoptLater([rootId]);
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
		if (thread?.pendingHandoff?.by === 'user' && modelRef && modelRef === thread.modelRef) {
			// The user switched back before their switch applied: it does not happen when the turn ends.
			this.apply({ type: 'thread.handoff', threadId, to: modelRef, toLabel: label ?? modelRef, by: 'user' });
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
			// A forgotten chat (a finished subagent pruned from its tree) frees its runtime state: over a
			// days-long run thousands of them would otherwise keep their transcripts in memory.
			for (const envelope of step.envelopes) {
				if (envelope.event.type === 'thread.forgotten') {
					this.runtime.releaseSession(envelope.event.threadId);
				}
			}
		}
		if (step.effects.length) {
			for (const effect of step.effects) {
				if (effect.kind === 'startTurn') {
					this.owedStarts.add(effect.turn.id);
				}
			}
			// Outbox: the events that asked for these effects are on disk before the effects run.
			const persisted = this.persistNow();
			void persisted.then(() => {
				for (const effect of step.effects) {
					try {
						this.runEffect(effect);
					} catch (err) {
						// One effect failing must not drop the others; the watchdog picks up a turn left behind.
						this.logService.error('[volt orchestrator] effect failed', effect.kind, err);
					}
				}
			});
		} else if (step.envelopes.length) {
			// A subagent's progress line (activity, step count) is cosmetic: batch those writes.
			this.schedulePersist(step.envelopes.every(envelope => envelope.event.type === 'task.updated') ? PROGRESS_PERSIST_MS : PERSIST_MS);
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

	/** Writes the changed roots within `delay`; a sooner request pulls a waiting write forward. */
	private schedulePersist(delay = PERSIST_MS): void {
		const due = Date.now() + delay;
		if (this.persistTimer !== undefined) {
			if (this.persistDue <= due) {
				return;
			}
			clearTimeout(this.persistTimer);
		}
		this.persistDue = due;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.persistNow();
		}, delay);
	}

	/**
	 * Writes the roots changed so far. Resolves when this round's files are on disk (the store orders
	 * writes per file, so an earlier write of the same root lands first); `persisting` follows every
	 * round, for `flush`. An effect waits only for its own events, not for other chats' writes.
	 */
	private persistNow(): Promise<void> {
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		const roots = [...this.dirtyRoots];
		this.dirtyRoots.clear();
		const state = this.state;
		const now = Date.now();
		const writes: Promise<boolean>[] = [];
		// A write that did not land is written again (with what the state holds then), not forgotten.
		const track = (write: Promise<boolean>, onFailure: () => void) => writes.push(write.then(ok => {
			if (!ok) {
				onFailure();
			}
			return ok;
		}));
		for (const rootId of roots) {
			const hasThreads = Object.values(state.threads).some(thread => thread.rootId === rootId);
			if (!hasThreads) {
				this.knownRoots.delete(rootId);
				this.rootEvents.delete(rootId);
				track(this.store.deleteRoot(rootId), () => this.dirtyRoots.add(rootId));
				continue;
			}
			this.knownRoots.add(rootId);
			track(this.store.saveRoot(extractRoot(state, rootId, this.rootEvents.get(rootId) ?? [], now)), () => this.dirtyRoots.add(rootId));
		}
		const index: Omit<IOrchIndex, 'version'> = {
			seq: state.seq,
			live: rootIdsOf(state).filter(rootId => isRootLive(state, rootId)).sort(),
			roots: [...this.knownRoots].sort(),
		};
		const signature = JSON.stringify([index.live, index.roots]);
		if (signature !== this.lastIndex) {
			this.lastIndex = signature;
			track(this.store.saveIndex(index), () => {
				if (this.lastIndex === signature) {
					this.lastIndex = '';
				}
			});
		}
		const round = Promise.all(writes).then(results => {
			if (results.every(ok => ok)) {
				this.persistFailures = 0;
			} else {
				this.retryPersist();
			}
		});
		this.persisting = Promise.all([this.persisting, round]).then(() => undefined);
		return round;
	}

	private retryPersist(): void {
		if (this.persistRetry !== undefined || this._store.isDisposed) {
			return;
		}
		const delay = Math.min(1000 * 2 ** Math.min(this.persistFailures, 5), PERSIST_RETRY_MAX_MS);
		this.persistFailures++;
		this.logService.warn(`[volt orchestrator] saving failed; trying again in ${Math.round(delay / 1000)} s`);
		this.persistRetry = setTimeout(() => {
			this.persistRetry = undefined;
			void this.persistNow();
		}, delay);
	}

	/** Everything changed so far is written (one retry for what fails now). */
	private async flush(): Promise<void> {
		if (this.persistRetry !== undefined) {
			clearTimeout(this.persistRetry);
			this.persistRetry = undefined;
		}
		void this.persistNow();
		await this.persisting;
		if (this.dirtyRoots.size || !this.lastIndex) {
			await this.persistNow();
		}
		await this.store.flush();
	}

	/**
	 * Settled and archived chats do not run: their trees are held the moment they are in memory, before
	 * a restart or a wake-up could start them (the guard in the agent window keeps the hold in step after).
	 */
	private holdSettled(threadIds: readonly string[]): void {
		for (const id of threadIds) {
			const thread = this.state.threads[id];
			const hold = thread && !thread.taskId && !thread.blocked ? orchHoldReason(this.history.get(id)) : undefined;
			if (hold) {
				this.apply({ type: 'thread.block', threadId: id, reason: hold });
			}
		}
	}

	/** Loads the roots a restart must reconcile, then marks everything that was running as interrupted. */
	private async restore(): Promise<void> {
		try {
			await this.history.whenReady;
			const { index, loaded, rebuilt } = await this.loadIndex();
			this.knownRoots = new Set(index.roots);
			const snapshots: IOrchRootSnapshot[] = [];
			// Trees another Volt window is running stay its own: settling them here would run them twice.
			const elsewhere = await this.beacons.elsewhere();
			const theirs: string[] = [];
			for (const rootId of index.live) {
				const snapshot = loaded.get(rootId) ?? await this.store.loadRoot(rootId);
				if (snapshot && snapshot.threads.some(thread => elsewhere.has(thread.id))) {
					theirs.push(rootId);
				} else if (snapshot) {
					snapshots.push(snapshot);
				}
			}
			if (theirs.length) {
				this.logService.info(`[volt orchestrator] ${theirs.length} chat tree(s) are running in another Volt window; leaving them to it`);
				this.adoptLater(theirs);
			}
			// Folded into the state as it is after the reads, so nothing applied meanwhile is dropped.
			let state = this.state;
			for (const snapshot of snapshots) {
				state = mergeRoot(state, snapshot);
				this.rootEvents.set(snapshot.rootId, [...snapshot.events]);
			}
			this.state = { ...state, seq: Math.max(state.seq, index.seq) };
			if (rebuilt) {
				// Write the rebuilt index now, not with the next change.
				this.schedulePersist();
			}
			this.holdSettled(Object.keys(this.state.threads));
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

	/**
	 * The index, or one rebuilt from the root files when it is missing or unreadable (a crash before
	 * its first write, a damaged file): without it every running chat would stay "running" forever.
	 */
	private async loadIndex(): Promise<{ readonly index: IOrchIndex; readonly loaded: ReadonlyMap<string, IOrchRootSnapshot>; readonly rebuilt: boolean }> {
		const loaded = new Map<string, IOrchRootSnapshot>();
		const saved = await this.store.loadIndex();
		if (saved) {
			return { index: saved, loaded, rebuilt: false };
		}
		const ids = await this.store.listRootIds();
		if (!ids.length) {
			return { index: { version: ORCHESTRATOR_STATE_VERSION, seq: 0, live: [], roots: [] }, loaded, rebuilt: false };
		}
		let seq = 0;
		const live: string[] = [];
		for (const rootId of ids) {
			const snapshot = await this.store.loadRoot(rootId);
			if (!snapshot) {
				continue;
			}
			seq = Math.max(seq, snapshot.seq);
			if (isRootLive(mergeRoot(emptyOrchState(), snapshot), rootId)) {
				live.push(rootId);
				loaded.set(rootId, snapshot);
			}
		}
		this.logService.warn(`[volt orchestrator] the index was missing or unreadable; rebuilt it from ${ids.length} saved chat tree(s), ${live.length} with work`);
		return { index: { version: ORCHESTRATOR_STATE_VERSION, seq, live, roots: ids }, loaded, rebuilt: true };
	}

	private restartResume(): OrchRestartResume {
		const value = this.configurationService.getValue<string>(ORCH_RESUME_AFTER_RESTART_SETTING);
		return value === 'off' || value === 'subagents' ? value : 'all';
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
			loading = Promise.all([this.store.loadRoot(rootId), this.beacons.elsewhere()]).then(([snapshot, elsewhere]) => {
				if (snapshot?.threads.some(thread => elsewhere.has(thread.id))) {
					// Another Volt window runs this chat: its tree stays there (the chat shows from its history).
					return;
				}
				if (snapshot && !Object.values(this.state.threads).some(thread => thread.rootId === rootId)) {
					this.state = mergeRoot(this.state, snapshot);
					this.rootEvents.set(rootId, [...snapshot.events]);
					this._onDidChange.fire({ threads: snapshot.threads.map(thread => thread.id), tasks: snapshot.tasks.map(task => task.id) });
					this.holdSettled(snapshot.threads.map(thread => thread.id));
					if (isRootLive(this.state, rootId)) {
						// The index missed this tree, so the restart never reconciled it: whatever it was running
						// died with an earlier window. Settle that now (nothing resumes on its own) instead of
						// showing a chat that runs forever.
						const step = this.apply({ type: 'recover', resume: 'off', rootId }, `recover:${rootId}:${generateUuid()}`);
						if (step.envelopes.length) {
							this.logService.info(`[volt orchestrator] reconciled ${rootId} on load: ${step.envelopes.length} change(s)`);
						}
					}
				}
			}, err => this.logService.warn(`[volt orchestrator] could not load ${rootId}`, err)).finally(() => this.loading.delete(rootId));
			this.loading.set(rootId, loading);
		}
		await loading;
	}

	/**
	 * Chat trees left to another Volt window at startup. Once that window stops vouching for them
	 * (it closed or crashed, and its beacon went stale), this one takes them over and reconciles
	 * them like its own, so a crashed window's work is restarted too. Looks again while they are live elsewhere.
	 */
	private adoptLater(rootIds: readonly string[]): void {
		rootIds.forEach(rootId => this.adopting.add(rootId));
		if (this.adoptTimer === undefined) {
			this.adoptTimer = setTimeout(() => {
				this.adoptTimer = undefined;
				if (!this._store.isDisposed) {
					void this.adopt();
				}
			}, BEACON_TTL_MS + WATCHDOG_MS);
		}
	}

	private async adopt(): Promise<void> {
		const rootIds = [...this.adopting];
		this.adopting.clear();
		try {
			const elsewhere = await this.beacons.elsewhere();
			const still: string[] = [];
			for (const rootId of rootIds) {
				if (Object.values(this.state.threads).some(thread => thread.rootId === rootId)) {
					continue;
				}
				const snapshot = await this.store.loadRoot(rootId);
				if (!snapshot || Object.values(this.state.threads).some(thread => thread.rootId === rootId)) {
					continue;
				}
				if (snapshot.threads.some(thread => elsewhere.has(thread.id))) {
					still.push(rootId);
					continue;
				}
				if (!isRootLive(mergeRoot(emptyOrchState(), snapshot), rootId)) {
					continue;
				}
				this.state = mergeRoot(this.state, snapshot);
				this.rootEvents.set(rootId, [...snapshot.events]);
				this._onDidChange.fire({ threads: snapshot.threads.map(thread => thread.id), tasks: snapshot.tasks.map(task => task.id) });
				this.holdSettled(snapshot.threads.map(thread => thread.id));
				const step = this.apply({ type: 'recover', resume: this.restartResume(), rootId }, `recover:${rootId}:${generateUuid()}`);
				this.logService.info(`[volt orchestrator] took over ${rootId} from a Volt window that is gone: ${step.envelopes.length} change(s)`);
			}
			if (still.length) {
				this.adoptLater(still);
			}
		} catch (err) {
			this.logService.warn('[volt orchestrator] taking over chat trees from a closed window failed; trying again', err);
			this.adoptLater(rootIds);
		}
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
			case 'startTurn': {
				// A turn continuing a transient failure waits out a short back-off, so a provider having a
				// bad minute is not hit again at once. It stays owed meanwhile: the watchdog leaves it be.
				const retry = failureRetryCount(effect.turn.id);
				if (retry && isFailureRetryTurn(effect.turn.id)) {
					void timeout(retryDelay(RUN_START_RETRY, retry, { key: effect.turn.id })).then(() => this._store.isDisposed ? undefined : this.startTurn(effect));
				} else {
					void this.startTurn(effect);
				}
				return;
			}
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
			case 'moveWorkspace':
				void this.moveWorkspace(effect);
				return;
		}
	}

	/** Runs the mover for a started move and reports how it went; a missing mover waits for one. */
	private async moveWorkspace(effect: Extract<OrchEffect, { kind: 'moveWorkspace' }>): Promise<void> {
		const { threadId, move } = effect;
		const thread = this.state.threads[threadId];
		if (thread?.moving?.id !== move.id || this.movesInFlight.has(move.id)) {
			return;
		}
		const mover = this.mover;
		if (!mover) {
			this.waitingForMover.push(effect);
			return;
		}
		this.movesInFlight.add(move.id);
		try {
			const result = await mover.move({ threadId, move, thread });
			this.apply({ type: 'move.finished', threadId, result: { ...result, id: move.id, at: Date.now(), label: result.label ?? move.label, by: move.by } });
		} catch (err) {
			this.logService.warn('[volt orchestrator] moving the chat failed', err);
			this.apply({ type: 'move.finished', threadId, result: { id: move.id, at: Date.now(), ok: false, label: move.label, by: move.by, error: err instanceof Error ? err.message : String(err) } });
		} finally {
			this.movesInFlight.delete(move.id);
		}
	}

	private async startTurn(effect: Extract<OrchEffect, { kind: 'startTurn' }>): Promise<void> {
		const { threadId, turn } = effect;
		if (!this.isTurnCurrent(threadId, turn.id)) {
			this.owedStarts.delete(turn.id);
			return;
		}
		const host = this.host;
		if (!host) {
			this.waitingForHost.push(effect);
			return;
		}
		if (this.dispatching.get(threadId) === turn.id) {
			// Already being started (the watchdog and a late effect can both ask): never send a turn twice.
			this.owedStarts.delete(turn.id);
			return;
		}
		this.owedStarts.delete(turn.id);
		this.dispatching.set(threadId, turn.id);
		this.startingSince.set(turn.id, Date.now());
		try {
			// Every Volt workbench loads the same parked chats: only the one that claims this resume sends it.
			if (isAutoLimitResume(turn) && !await this.claims.claim(`limit:${turn.id}`)) {
				this.releaseRoot(threadId, 'another Volt window took its usage-limit resume');
				return;
			}
			// The same for a turn Volt restarts on its own (after a restart, or stopped work): one window sends it,
			// and none while another live window runs the chat.
			if (isAutomaticRestart(turn)) {
				if ((await this.beacons.elsewhere()).has(threadId)) {
					this.releaseRoot(threadId, 'another Volt window is running it');
					return;
				}
				if (!await this.claims.claim(`restart:${turn.id}`)) {
					this.releaseRoot(threadId, 'another Volt window took its restart');
					return;
				}
			}
			const thread = this.state.threads[threadId];
			if (thread?.taskId && thread.parentId && turn.kind === 'brief') {
				await host.prepareChild?.(threadId, thread.parentId);
			}
			const runId = await host.startTurn({ threadId, turn, thread: this.state.threads[threadId] ?? thread, isCurrent: () => this.isTurnCurrent(threadId, turn.id) });
			if (runId) {
				this.apply({ type: 'run.started', threadId, runId, turnId: turn.id, steerable: this.runtime.canSteer(threadId) });
				this.stopStrayRun(threadId, runId);
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
			this.startingSince.delete(turn.id);
			if (this.dispatching.get(threadId) === turn.id) {
				this.dispatching.delete(threadId);
			}
		}
	}

	/**
	 * A run started for a turn that is already over (stopped, or failed as stuck, while it was being
	 * sent). Nobody waits for it and the chat may start its next turn: stop it, but only while it is
	 * still the chat's current run.
	 */
	private stopStrayRun(threadId: string, runId: string): void {
		if (this.state.threads[threadId]?.active?.runId === runId) {
			return;
		}
		const run = this.runtime.getOrCreateSession(threadId).activeRun;
		if (run?.runId !== runId || !isRunLive(run.status)) {
			return;
		}
		this.logService.info(`[volt orchestrator] ${threadId}: run ${runId} started for a turn that already ended; stopping it`);
		void this.runtime.cancel(threadId).catch(err => this.logService.warn('[volt orchestrator] stopping a stray run failed', err));
	}

	private async steer(effect: Extract<OrchEffect, { kind: 'steer' }>): Promise<void> {
		let delivered = false;
		try {
			const sending = Promise.resolve(this.host?.steer ? this.host.steer(effect.threadId, effect.prompt, effect.steerId) : this.runtime.steerAsync(effect.threadId, effect.prompt.text));
			// An agent that never answers must not swallow the message (or a subagent's report): it goes
			// back to the queue, where a second copy is better than none.
			delivered = await raceTimeout(sending, STEER_TIMEOUT_MS, () => this.logService.warn(`[volt orchestrator] ${effect.threadId}: the agent did not take a message within ${STEER_TIMEOUT_MS / 1000} s; queueing it`)) ?? false;
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
			// Stop means now: a run the runtime no longer has live (it ended, or another replaced it)
			// leaves nothing to wait for, so the turn ends here instead of after the grace period.
			const run = this.runtime.getOrCreateSession(threadId).activeRun;
			if (this.state.threads[threadId]?.active?.id === turnId && (!run || run.runId !== active.runId || !isRunLive(run.status))) {
				this.apply({ type: 'run.settled', threadId, turnId, outcome: 'cancelled' });
				return;
			}
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
		try {
			this.observeEvent(envelope);
		} catch (err) {
			// A throw here would lose the event for good (a run's end, a question); the watchdog
			// reconciles what it can, and the log says what happened.
			this.logService.error('[volt orchestrator] could not apply a runtime event', envelope.event.type, err);
		}
	}

	private observeEvent(envelope: IVoltEventEnvelope): void {
		const threadId = envelope.sessionId;
		const thread = this.state.threads[threadId];
		if (!thread) {
			return;
		}
		const event = envelope.event;
		this.recordPulse(envelope);
		switch (event.type) {
			case 'run.start': {
				const turnId = this.dispatching.get(threadId);
				this.apply({ type: 'run.started', threadId, runId: envelope.runId, ...(turnId ? { turnId } : {}), steerable: this.runtime.canSteer(threadId) });
				this.stopStrayRun(threadId, envelope.runId);
				return;
			}
			case 'error': {
				// A run the watchdog stopped for silence keeps that as its reason, not the stop's echo.
				if (!this.silentRuns.has(envelope.runId)) {
					this.lastError.set(envelope.runId, event.message);
				}
				const limit = limitFromError(event.message, Date.now());
				if (limit) {
					this.limitedRuns.set(envelope.runId, mergeLimitSignals(this.limitedRuns.get(envelope.runId), limit));
				}
				return;
			}
			case 'notice': {
				const limit = limitFromNotice(event, Date.now());
				if (limit) {
					this.limitedRuns.set(envelope.runId, mergeLimitSignals(this.limitedRuns.get(envelope.runId), limit));
				}
				return;
			}
			case 'text.delta':
				if (event.delta && this.isLimitResume(thread)) {
					const text = (this.probeText.get(envelope.runId) ?? '') + event.delta;
					this.probeText.set(envelope.runId, text.slice(0, 600));
					if (isRealAnswer(text)) {
						this.limitAnswered(threadId);
					}
				}
				return;
			case 'reasoning.start':
				this.limitAnswered(threadId);
				return;
			case 'plan':
				this.plans.set(envelope.runId, event.entries);
				return;
			case 'run.end':
				this.settleRun(threadId, envelope.runId, event.reason, undefined, event.incomplete === 'steps');
				return;
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
				this.limitAnswered(threadId);
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
					if (!calls.some(call => call.callId === event.callId)) {
						calls.push({ callId: event.callId, turnId: thread.active?.id });
					}
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
				this.changedRuns.add(envelope.runId);
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

	/** Any event is a sign of life of its run; tool calls are tracked so a quiet build is not taken for a hang. */
	private recordPulse(envelope: IVoltEventEnvelope): void {
		const event = envelope.event;
		if (event.type === 'run.end') {
			this.pulses.delete(envelope.runId);
			return;
		}
		let pulse = this.pulses.get(envelope.runId);
		if (!pulse) {
			this.pulses.set(envelope.runId, pulse = { at: 0, tools: new Set() });
		}
		pulse.at = Date.now();
		if (event.type === 'tool.start') {
			pulse.tools.add(event.callId);
		} else if (event.type === 'tool.end') {
			pulse.tools.delete(event.callId);
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

	/** A run ended (its `run.end`, or the watchdog saw the runtime finish it): settle its turn. */
	private settleRun(threadId: string, runId: string, reason: 'done' | 'abort' | 'fail', fallbackError?: string, stepLimit = false): void {
		this.pulses.delete(runId);
		// The watchdog stopped it for going silent: that stop is a failure to recover from, unless the user stopped it too.
		if (this.silentRuns.delete(runId) && this.state.threads[threadId]?.active?.phase !== 'cancelling') {
			reason = 'fail';
		}
		let outcome: OrchOutcome = reason === 'done' ? 'done' : reason === 'abort' ? 'cancelled' : 'failed';
		const error = this.lastError.get(runId) ?? fallbackError;
		this.lastError.delete(runId);
		let reply = outcome === 'done' ? this.lastReply(threadId) : undefined;
		// Some CLIs end the turn normally with the limit sentence as the whole reply.
		let limit = this.limitedRuns.get(runId);
		this.limitedRuns.delete(runId);
		const replyLimit = outcome === 'done' ? limitFromReply(reply, Date.now()) : undefined;
		if (replyLimit) {
			limit = mergeLimitSignals(limit, replyLimit);
		}
		if (limit && outcome !== 'cancelled') {
			// Stopped by the provider's usage limit: the chat parks until the reset.
			outcome = 'failed';
			reply = undefined;
		}
		const message = limit && outcome === 'failed' ? limit.message : error;
		// Claude's limit stops the chat where it is: nothing more is sent on the account by itself.
		const stop = !!limit && outcome === 'failed' && this.stopsAtClaudeLimit() && isClaudeProvider(this.providerOf(this.runtime.getOrCreateSession(threadId).providerRef ?? this.state.threads[threadId]?.modelRef));
		this.probeText.delete(runId);
		const account = outcome === 'failed' ? this.limitAccount(threadId) : undefined;
		// The run ended "done" with to-dos still open: the decider continues it while it makes progress.
		const plan = this.plans.get(runId);
		this.plans.delete(runId);
		const worked = this.changedRuns.delete(runId);
		const openPlan = outcome === 'done' ? plan?.filter(entry => entry.status !== 'completed').map(entry => entry.content).filter(Boolean) : undefined;
		this.apply({
			type: 'run.settled',
			threadId,
			runId,
			outcome,
			...(message && outcome === 'failed' ? { error: message } : {}),
			...(reply !== undefined ? { reply } : {}),
			...(limit && outcome === 'failed' ? { limit: { ...limit, ...(stop ? { stop: true } : {}) } } : {}),
			...(account ? { account } : {}),
			...(openPlan?.length ? { openPlan, ...(worked ? { worked: true } : {}) } : {}),
			...(stepLimit && outcome === 'done' ? { stepLimit: true } : {}),
		});
		this.clearCancelWatch(threadId);
		if (stop) {
			this.stopClaudeWork(threadId);
		}
	}

	/** The chat's active turn resumes a usage-limit park that has not heard back from the provider. */
	private isLimitResume(thread: IOrchThread | undefined): boolean {
		return !!thread?.limit && thread.active?.limitProbe !== undefined;
	}

	/** A resume of a parked chat heard back from the provider: the account works again, and its other parked chats follow. */
	private limitAnswered(threadId: string): void {
		const thread = this.state.threads[threadId];
		if (!this.isLimitResume(thread)) {
			return;
		}
		const step = this.apply({ type: 'limit.recovered', threadId, turnId: thread!.active!.id });
		const woken = step.envelopes.filter(envelope => envelope.event.type === 'limit.woken').length;
		this.logService.info(`[volt orchestrator] ${threadId}: ${thread!.limit!.providerLabel ?? 'the provider'} answered after the usage limit${woken ? `; waking ${woken} other parked chat(s) on the account` : ''}`);
	}

	/** The provider account behind a chat's model: chats parked on one account share one check. */
	private limitAccount(threadId: string): IOrchLimitAccount | undefined {
		const ref = this.runtime.getOrCreateSession(threadId).providerRef ?? this.state.threads[threadId]?.modelRef;
		const item = ref ? this.runtime.listCatalog().find(entry => entry.ref === ref) : undefined;
		if (!item) {
			return undefined;
		}
		const label = this.runtime.listProviderStatuses().find(status => status.profileId === item.profileId)?.label ?? item.label;
		return { provider: `${item.providerId}:${item.profileId}`, ...(label ? { providerLabel: label } : {}) };
	}

	private stopsAtClaudeLimit(): boolean {
		return this.configurationService.getValue<boolean>(LIMIT_STOP_CLAUDE_SETTING) !== false;
	}

	private providerOf(ref: string | undefined): string | undefined {
		return ref ? this.runtime.listCatalog().find(item => item.ref === ref)?.providerId : undefined;
	}

	/**
	 * Claude's usage limit stopped a chat: the Claude subagents still working anywhere in its tree
	 * would only spend more on the same account (or be refused), so they stop too. Subagents on other
	 * providers keep working.
	 */
	private stopClaudeWork(threadId: string): void {
		const rootId = this.state.threads[threadId]?.rootId;
		if (!rootId) {
			return;
		}
		const stopped: string[] = [];
		for (const task of Object.values(this.state.tasks)) {
			if (task.rootId !== rootId || task.source !== 'volt' || !isLiveTaskState(task.state) || task.childId === threadId) {
				continue;
			}
			const ref = task.modelRef ?? this.state.threads[task.parentId]?.modelRef;
			if (!isClaudeProvider(this.providerOf(ref))) {
				continue;
			}
			// A task stopped by an ancestor earlier in this loop is already settled; the decider skips it.
			const step = this.apply({ type: 'task.cancel', taskId: task.id, reason: 'Claude\'s usage limit was reached, so Volt stopped it instead of spending more.' });
			if (step.envelopes.length) {
				stopped.push(task.id);
			}
		}
		if (stopped.length) {
			this.logService.info(`[volt orchestrator] Claude's usage limit stopped ${threadId}; stopped its Claude subagents ${stopped.join(', ')}`);
		}
	}

	/** Stop timers for turns of this chat that are over (an earlier run's end must not disarm the current stop). */
	private clearCancelWatch(threadId: string): void {
		const current = this.state.threads[threadId]?.active?.id;
		for (const [key, timer] of this.cancelWatch) {
			if (key.startsWith(`${threadId}\0`) && key !== `${threadId}\0${current}`) {
				clearTimeout(timer);
				this.cancelWatch.delete(key);
			}
		}
	}

	/**
	 * The watchdog: compares what the orchestrator believes with what the runtime knows, so no chat
	 * hangs on a lost event. Each finding must hold for `WATCHDOG_STRIKES` ticks before Volt acts.
	 * - A running turn whose run the runtime already finished (its `run.end` was lost) is settled.
	 * - A turn stopped without a stop timer (it was disarmed) gets one again.
	 * - A start that never reached the runtime fails after `START_STALL_MS`.
	 * - A turn waiting to start with no start owed or in flight (its effect was lost) is started.
	 */
	private checkLiveness(): void {
		const now = Date.now();
		// The machine slept: every run looks silent for as long as it was off, so their clocks start again.
		if (now - this.lastWatchdogTick > SLEEP_GAP_MS) {
			for (const pulse of this.pulses.values()) {
				pulse.at = now;
			}
		}
		this.lastWatchdogTick = now;
		const previous = this.suspects;
		const suspects = new Map<string, number>();
		const strike = (key: string): boolean => {
			const count = (previous.get(key) ?? 0) + 1;
			suspects.set(key, count);
			return count >= WATCHDOG_STRIKES;
		};
		// Read each chat afresh: settling one can start or stop turns in others.
		for (const threadId of Object.keys(this.state.threads)) {
			const thread = this.state.threads[threadId];
			const active = thread?.active;
			if (!active) {
				continue;
			}
			const key = `${thread.id}\0${active.id}`;
			if (active.runId) {
				const run = this.runtime.getOrCreateSession(thread.id).activeRun;
				if (run?.runId === active.runId && !isRunLive(run.status) && strike(`ended\0${key}`)) {
					this.logService.warn(`[volt orchestrator] ${thread.id}: run ${active.runId} ended (${run.status}) without Volt hearing of it; settling its turn`);
					this.settleRun(thread.id, active.runId, run.status === 'completed' ? 'done' : run.status === 'cancelled' ? 'abort' : 'fail', 'The run ended without reporting why.');
					continue;
				}
				const silent = run?.runId === active.runId && run.status === 'running' && active.phase === 'running' && !thread.inputs.length
					? this.silence(thread.id, active.runId, run.startedAt, now)
					: undefined;
				if (silent !== undefined && strike(`silent\0${key}`)) {
					this.reviveSilentRun(thread.id, active.runId, silent);
					continue;
				}
			}
			if (active.phase === 'cancelling') {
				if (!this.cancelWatch.has(key) && strike(`stop\0${key}`)) {
					this.cancelTurn({ kind: 'cancelTurn', threadId: thread.id, turnId: active.id, ...(active.runId ? { runId: active.runId } : {}) });
				}
				continue;
			}
			if (active.phase !== 'dispatching' || active.runId) {
				continue;
			}
			if (this.dispatching.get(thread.id) === active.id) {
				const since = this.startingSince.get(active.id) ?? now;
				if (now - since >= START_STALL_MS) {
					this.logService.warn(`[volt orchestrator] ${thread.id}: turn ${active.id} did not start within ${START_STALL_MS / 1000} s; failing it`);
					this.apply({ type: 'dispatch.failed', threadId: thread.id, turnId: active.id, error: `The agent did not start within ${Math.round(START_STALL_MS / 60_000)} minutes.` });
				}
				continue;
			}
			if (!this.owedStarts.has(active.id) && this.host && strike(`orphan\0${key}`)) {
				this.logService.warn(`[volt orchestrator] ${thread.id}: turn ${active.id} was waiting to start with nothing starting it; starting it`);
				void this.startTurn({ kind: 'startTurn', threadId: thread.id, turn: active });
			}
		}
		this.suspects = suspects;
		// Tell the other Volt windows which chats this one is responsible for (running, or to restart).
		void this.beacons.beat(Object.values(this.state.threads).filter(thread => thread.active || thread.rescue).map(thread => thread.id), now);
		// A backstop for the restart timer (a lost timer must not leave stopped work waiting forever).
		if (this.limits.supervise && this.rescueTimer.deadline === undefined && Object.values(this.state.threads).some(rescueWaits)) {
			this.scheduleRescueTick();
		}
	}

	/**
	 * How long a live run has been silent past its allowance (`SILENT_RUN_MS`, or `SILENT_TOOL_RUN_MS`
	 * while a tool call or a harness subagent of its turn is open), or undefined while it is not.
	 */
	private silence(threadId: string, runId: string, startedAt: number, now: number): number | undefined {
		const pulse = this.pulses.get(runId);
		const quiet = now - Math.max(pulse?.at ?? 0, startedAt);
		const working = !!pulse?.tools.size || Object.values(this.state.tasks).some(task => task.source === 'harness' && task.parentId === threadId && !isTerminalTaskState(task.state));
		return quiet >= (working ? SILENT_TOOL_RUN_MS : SILENT_RUN_MS) ? quiet : undefined;
	}

	/**
	 * A live run went silent. A hung agent process does not answer a stop, so its agent is restarted
	 * (the next turn starts a fresh one, briefed from the transcript) and the run settles as a
	 * transient failure, which the decider continues (see `MAX_FAILURE_RETRIES`).
	 */
	private reviveSilentRun(threadId: string, runId: string, silentMs: number): void {
		const minutes = Math.max(1, Math.round(silentMs / 60_000));
		this.logService.warn(`[volt orchestrator] ${threadId}: run ${runId} sent nothing for ${minutes} min; restarting its agent`);
		this.silentRuns.add(runId);
		this.lastError.set(runId, `The agent stopped responding (nothing for ${minutes} minute${minutes === 1 ? '' : 's'}).`);
		this.runtime.restartAgent(threadId, { cancel: true }).catch(err => this.logService.warn('[volt orchestrator] restarting a silent agent failed', err));
		// A hung agent may never report its end: the run settles here once the stop had time to land.
		setTimeout(() => {
			if (!this._store.isDisposed && this.silentRuns.has(runId) && this.state.threads[threadId]?.active?.runId === runId) {
				this.settleRun(threadId, runId, 'fail');
			}
			this.silentRuns.delete(runId);
		}, CANCEL_SETTLE_MS);
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
		await this.ensureThreadLoaded(threadId);
		const token = call?.token ?? CancellationToken.None;
		try {
			switch (name) {
				case LIST_MODELS_TOOL_NAME:
					return { text: this.listModels(threadId) };
				case DELEGATE_TASK_TOOL_NAME:
					// Taken first: a call refused below must not leave its id for the next call's row.
					return await this.delegate(threadId, args, token, this.takeDelegateCall(threadId));
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

	/** The parent's `delegate_task` row this MCP call belongs to: the oldest one seen in the chat's current turn. */
	private takeDelegateCall(threadId: string): string | undefined {
		const turnId = this.state.threads[threadId]?.active?.id;
		// Rows from earlier turns never got their call (refused, or the stream and the call crossed): drop them.
		const calls = (this.delegateCalls.get(threadId) ?? []).filter(call => call.turnId === turnId);
		const next = calls.shift();
		if (calls.length) {
			this.delegateCalls.set(threadId, calls);
		} else {
			this.delegateCalls.delete(threadId);
		}
		return next?.callId;
	}

	private async delegate(parentId: string, args: Record<string, unknown>, token: CancellationToken, toolCallId: string | undefined, single = false): Promise<IVoltHostToolResult> {
		if (Array.isArray(args.tasks) && args.tasks.length && !single) {
			return this.delegateBatch(parentId, args, args.tasks, token, toolCallId);
		}
		const brief = typeof args.task === 'string' ? args.task.trim() : '';
		if (!brief) {
			return { error: 'delegate_task needs a `task`: the complete brief for the subagent.' };
		}
		const fanOut = Array.isArray(args.models) ? [...new Set(args.models.filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()))] : [];
		if (fanOut.length > 1 && !single) {
			return this.delegateToModels(parentId, args, fanOut, token, toolCallId);
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
		// Work a Multitask chat splits up is the user's own parallel work: multitask agents, whose chats
		// take follow-ups. A turn without a mode (a report waking the chat) keeps what the chat started.
		const multitask = args.multitask === true
			|| parentMode === 'multitask'
			|| previous?.origin === 'user'
			|| (!parent?.active?.prompt.mode && Object.values(this.state.tasks).some(task => task.parentId === parentId && task.origin === 'user'));
		// A child never gets more than its parent: a read-only chat delegates read-only work.
		const mode = parentMode === 'ask' || parentMode === 'plan' ? 'ask' : modeForTaskRole(role, undefined);
		const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 80) : previous?.title ?? titleFromBrief(brief);
		const taskId = newTaskId(id => !!this.state.tasks[id]);
		const depth = (parent?.depth ?? 0) + 1;
		const step = this.apply({
			type: 'task.spawn',
			spawn: {
				parentId,
				brief,
				title,
				role,
				origin: multitask ? 'user' : 'agent',
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
	 * The queue's "Start Multitasking": every queued message starts now as a multitask agent of the
	 * chat (its own chat, running beside the others), instead of waiting its turn. Returns how many started.
	 */
	async multitaskQueue(threadId: string, itemIds?: readonly string[]): Promise<number> {
		await this.whenReady;
		const only = itemIds ? new Set(itemIds) : undefined;
		const items = (this.state.threads[threadId]?.queue ?? [])
			.filter(item => (item.kind ?? 'prompt') === 'prompt' && (!only || only.has(item.id)))
			.slice(0, this.limits.spawnsPerCall);
		let started = 0;
		for (const item of items) {
			const display = item.prompt.display as { readonly text?: unknown } | undefined;
			const shown = typeof display?.text === 'string' && display.text.trim() ? display.text.trim() : item.prompt.text;
			let model: string | undefined = item.prompt.modelRef;
			try {
				this.resolveModel(model);
			} catch {
				model = undefined;
			}
			const result = await this.delegate(threadId, { task: item.prompt.text, title: titleFromBrief(shown), multitask: true, client_request_id: `queue:${item.id}`, ...(model ? { model } : {}) }, CancellationToken.None, undefined, true);
			if (!result.error) {
				this.apply({ type: 'queue.remove', threadId, itemId: item.id });
				started++;
			}
		}
		return started;
	}

	/**
	 * Several independent parts in one call: a task each, all asked for at once (as many run as the
	 * limits allow; the rest queue and start as slots free up). The parent's delegate_task row lists
	 * every one of them, and each report comes back like any task's.
	 */
	private async delegateBatch(parentId: string, args: Record<string, unknown>, list: readonly unknown[], token: CancellationToken, toolCallId: string | undefined): Promise<IVoltHostToolResult> {
		const entries = list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
		if (entries.length !== list.length) {
			return { error: 'delegate_task `tasks` takes objects, one per part: { task, title?, model?, role?, isolation?, scope? }.' };
		}
		if (entries.length > this.limits.spawnsPerCall) {
			return { error: `delegate_task starts at most ${this.limits.spawnsPerCall} tasks in one call (the user's setting). Start the most important ones now and the rest once these report.` };
		}
		const missing = entries.findIndex(entry => typeof entry.task !== 'string' || !entry.task.trim());
		if (missing >= 0) {
			return { error: `tasks[${missing}] has no \`task\`: every part needs its complete brief.` };
		}
		// Resolve every model first: an unknown one starts nothing.
		for (const entry of entries) {
			this.resolveModel(entry.model ?? args.model);
		}
		const key = typeof args.client_request_id === 'string' && args.client_request_id.trim() ? args.client_request_id.trim() : undefined;
		const ids: string[] = [];
		const lines: string[] = [];
		for (const [index, entry] of entries.entries()) {
			const result = await this.delegate(parentId, {
				...args,
				tasks: undefined,
				models: undefined,
				previous_task_id: undefined,
				wait: false,
				task: entry.task,
				title: typeof entry.title === 'string' ? entry.title : undefined,
				model: entry.model ?? args.model,
				role: entry.role ?? args.role,
				isolation: entry.isolation ?? args.isolation,
				scope: entry.scope ?? args.scope,
				client_request_id: key ? `${key}:${index}` : undefined,
			}, token, toolCallId, true);
			const id = /\b(t-[0-9a-f]{6})\b/.exec(result.text ?? '')?.[1];
			if (id) {
				ids.push(id);
			}
			lines.push(`${index + 1}. ${result.error ? `not started: ${result.error}` : result.text?.split('\n')[0] ?? ''}`);
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
		if (!tasks.length) {
			return { error: ['No task was started:', ...lines].join('\n') };
		}
		return {
			text: [
				`Started ${tasks.length} of ${entries.length} tasks:`,
				...lines,
				...tasks.map(task => describeTask(task, now, { includeResult: isTerminalTaskState(task.state) })),
				finished.length === tasks.length ? '' : 'Their reports are delivered to this chat as they finish: end your turn now unless there is other work to do. wait_tasks returns them sooner if you cannot continue without them.',
			].filter(Boolean).join('\n'),
		};
	}

	/**
	 * One brief, several models: a task each (independent reviews, competing designs). The parent's
	 * delegate_task row lists them all; every report comes back like any task's.
	 */
	private async delegateToModels(parentId: string, args: Record<string, unknown>, names: readonly string[], token: CancellationToken, toolCallId: string | undefined): Promise<IVoltHostToolResult> {
		if (names.length > MAX_FAN_OUT) {
			return { error: `delegate_task runs one brief on at most ${MAX_FAN_OUT} models at once.` };
		}
		// Resolve every model first: an unknown one starts nothing.
		const models = names.map(name => this.resolveModel(name)!);
		const key = typeof args.client_request_id === 'string' && args.client_request_id.trim() ? args.client_request_id.trim() : undefined;
		const baseTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : titleFromBrief(String(args.task));
		const ids: string[] = [];
		const lines: string[] = [];
		for (const model of models) {
			const result = await this.delegate(parentId, {
				...args,
				models: undefined,
				model: model.ref,
				wait: false,
				title: `${baseTitle} · ${model.label}`,
				...(key ? { client_request_id: `${key}:${model.ref}` } : {}),
			}, token, toolCallId, true);
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

function isRunLive(status: string): boolean {
	return status === 'running' || status === 'queued' || status === 'waiting';
}

/** The chat a command is about, when it names one (task commands find theirs through the task). */
function commandThreadId(command: OrchCommandBody): string | undefined {
	if ('threadId' in command) {
		return command.threadId;
	}
	return command.type === 'task.spawn' ? command.spawn.parentId : undefined;
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

/** A resume the limit timer sent (`~l<n>`), as opposed to the user's own Resume now (`~m<n>`). */
function isAutoLimitResume(turn: IOrchTurn): boolean {
	return turn.kind === 'resume' && turn.limitProbe !== undefined && /~l\d+$/.test(turn.id);
}

/** A turn Volt sent on its own to continue a chat after a restart (`~r`) or after its work stopped (`~s`). */
function isAutomaticRestart(turn: IOrchTurn): boolean {
	return /~r\d+$/.test(turn.id) || isRescueTurnId(turn.id);
}

registerSingleton(IAgentOrchestratorService, AgentOrchestratorService, InstantiationType.Delayed);
