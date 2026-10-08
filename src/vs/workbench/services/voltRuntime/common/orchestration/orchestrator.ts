/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IVoltModelOptions } from '../models/modelOptions.js';
import type { AgentTaskDelivery, AgentTaskIsolation, AgentTaskOrigin, AgentTaskRole } from './agentTasks.js';
import type { IWorkspaceMoveSpec } from '../git/workspaceMove.js';

/**
 * Volt's agent orchestrator: the one owner of what every chat (thread) is doing.
 *
 * Clients (the chat view, the MCP task tools, the runtime observer) send typed commands. A pure
 * decider turns a command and the current state into events; a pure projector folds events into
 * state; a scheduler derives follow-up events (dispatch the next queued prompt, start a queued
 * subagent, wake a parent with its children's reports). Events are the source of truth: they are
 * persisted before any side effect runs, and effects (start a turn, cancel a run) are derived from
 * them, so a crash between "decided" and "done" is visible and recoverable.
 *
 * Threads are Volt chats. A turn is one prompt and the run that answers it; a thread has at most
 * one active turn, everything else waits in its queue. Tasks are subagents: Volt-owned children
 * (a child thread started by `delegate_task`) and harness-owned ones (Claude's or Cursor's own
 * Task tool) share one model, so the UI shows them the same way.
 *
 * Modeled on T3 Code's server orchestrator (decider, event log, projections, outbox) and Cursor's
 * multitask view (subagents and queue in one card above the composer).
 */

export const ORCHESTRATOR_STATE_VERSION = 1;

//#region State

/** What a turn sends. `display` is the transcript's frozen payload (composer text and mentions); the core never reads it. */
export interface IOrchPrompt {
	readonly text: string;
	readonly display?: unknown;
	/** The composer mode it was written in ("Agent", "Plan", "Multitask", ...). */
	readonly mode?: string;
	/** Catalog ref of the model; absent: the thread's current model. */
	readonly modelRef?: string;
	readonly options?: IVoltModelOptions;
	/** Send options only the chat UI understands (run on a new worktree, its branch). JSON. */
	readonly host?: unknown;
}

/**
 * - `prompt`: the user's message (sent, or taken from the queue).
 * - `notification`: Volt waking the parent with finished subagents' reports.
 * - `brief`: a subagent's first turn. `followup`: another round in a subagent (message_task).
 * - `resume`: continuing a turn that was interrupted (restart, crash).
 * - `external`: a run Volt saw start without a command (adopted so the queue waits for it).
 */
export type OrchTurnKind = 'prompt' | 'notification' | 'brief' | 'followup' | 'resume' | 'external';

export type OrchTurnPhase = 'dispatching' | 'running' | 'cancelling';

export interface IOrchTurn {
	/** Also the transcript id of the user message the turn opens. */
	readonly id: string;
	readonly kind: OrchTurnKind;
	readonly prompt: IOrchPrompt;
	readonly at: number;
	readonly phase: OrchTurnPhase;
	readonly runId?: string;
	/** `notification`: the tasks whose reports it carries. */
	readonly taskIds?: readonly string[];
	/** Started by a steer that interrupted the previous turn ("Send now"). */
	readonly interrupting?: boolean;
	/** The running agent reads messages between steps (native loop): reports and Send now go in without stopping it. */
	readonly steerable?: boolean;
	/** A turn that continues a chat parked at a usage limit: the automatic resumes sent so far for that stop. */
	readonly limitProbe?: number;
	/** That chat's own auto-resume choice, carried so a probe that hits the limit again keeps it. */
	readonly limitAuto?: boolean;
}

export interface IOrchQueueItem {
	/** Becomes the turn id when it is dispatched. */
	readonly id: string;
	readonly prompt: IOrchPrompt;
	readonly at: number;
	/** Default `prompt`. A subagent's chat queues its brief and follow-ups with their own kinds. */
	readonly kind?: OrchTurnKind;
	/** Loaded into the composer for editing: the queue waits at it until it is put back. */
	readonly held?: boolean;
}

/**
 * Why a thread's queue does not drain on its own: the last turn failed, the user stopped it, Volt
 * restarted, or the chat woke itself up too many times in a row (subagent reports, no user turn).
 */
export type OrchPause = 'failed' | 'stopped' | 'interrupted' | 'wakeups' | 'limit';

export type OrchOutcome = 'done' | 'failed' | 'cancelled' | 'interrupted';

/** The agent is blocked on the user. */
export interface IOrchInput {
	readonly id: string;
	readonly kind: 'approval' | 'question';
	readonly at: number;
}

export interface IOrchHandoff {
	readonly from?: string;
	readonly fromLabel?: string;
	readonly to: string;
	readonly toLabel: string;
	readonly at: number;
	readonly reason?: string;
	/** The brief the previous model wrote for the next one, when it handed off itself. */
	readonly brief?: string;
	readonly by: 'agent' | 'user';
}

/**
 * A chat parked at a provider usage limit (see limitRecovery.ts). It waits, paused, until the
 * reset (or the next probe when no reset is known), then continues where it left off.
 */
export interface IOrchLimitPark {
	/** The turn the limit stopped. */
	readonly turnId: string;
	readonly at: number;
	/** When the provider said the limit resets (epoch ms). */
	readonly resetAt?: number;
	/** The provider's sentence ("You've hit your limit · resets 3:40pm"). */
	readonly message?: string;
	/** Automatic resumes already sent for this stop (probes, when no reset is known). */
	readonly probes: number;
	/** The user's choice for this chat: false cancelled the resume; true asked for it with the setting off. */
	readonly auto?: boolean;
	/** Chats waking at the same reset are staggered: this one not before then. */
	readonly notBefore?: number;
	/** The stopped turn's composer mode, which the resume keeps. */
	readonly mode?: string;
}

/**
 * Moving a chat to another checkout (a new worktree, the project's main checkout, another
 * worktree). `target` is the mover's own description; the orchestrator only sequences it: it
 * waits for the running turn, holds the queue while the files move, and records how it went.
 */
export interface IOrchMove {
	readonly id: string;
	readonly target: unknown;
	/** "a new worktree", "the local checkout", "worktree volt/ab12cd34". */
	readonly label: string;
	readonly by: 'user' | 'agent';
	readonly at: number;
}

export interface IOrchMoveResult {
	readonly id: string;
	readonly at: number;
	readonly ok: boolean;
	readonly label: string;
	readonly error?: string;
	/** Where the chat works now (absent: the project's main checkout). */
	readonly path?: string;
	readonly branch?: string;
	/** From where. */
	readonly fromPath?: string;
	readonly fromBranch?: string;
	/** Files whose uncommitted changes came along. */
	readonly files?: number;
	readonly by?: 'user' | 'agent';
}

export interface IOrchThread {
	readonly id: string;
	/** The chat that delegated to this one (subagent chats only). */
	readonly parentId?: string;
	/** The top of the tree; persistence is per root. */
	readonly rootId: string;
	/** The task this chat runs, for subagent chats. */
	readonly taskId?: string;
	readonly depth: number;
	readonly createdAt: number;
	readonly title?: string;
	readonly modelRef?: string;
	readonly modelLabel?: string;
	readonly active?: IOrchTurn;
	readonly queue: readonly IOrchQueueItem[];
	readonly pause?: OrchPause;
	/** The chat cannot run yet (its project is still cloning). */
	readonly blocked?: string;
	readonly inputs: readonly IOrchInput[];
	readonly last?: { readonly turnId: string; readonly kind: OrchTurnKind; readonly outcome: OrchOutcome; readonly at: number; readonly error?: string };
	/** Turns dispatched so far. */
	readonly turns: number;
	/** Automatic turns (subagent reports) since the last user turn. */
	readonly wakeups?: number;
	/** A model switch waiting for the active turn to end. */
	readonly pendingHandoff?: IOrchHandoff;
	readonly handoffs: readonly IOrchHandoff[];
	/** Parked at a usage limit, waiting for the reset. */
	readonly limit?: IOrchLimitPark;
	/** A move to another checkout waiting for the active turn to end. */
	readonly pendingMove?: IOrchMove;
	/** A move under way: nothing starts until it is done. */
	readonly moving?: IOrchMove;
	/** How the latest move ended; the next turn opens with it. */
	readonly lastMove?: IOrchMoveResult;
}

export type OrchTaskSource = 'volt' | 'harness';

export type OrchTaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface IOrchTask {
	/** Short and quotable (`t-1a2b3c`). Harness tasks use their tool call id. */
	readonly id: string;
	readonly source: OrchTaskSource;
	readonly parentId: string;
	readonly rootId: string;
	/** The parent turn it was started in. */
	readonly parentTurnId?: string;
	/** The parent's tool call: `delegate_task` for Volt tasks, the harness's own Task call otherwise. */
	readonly toolCallId?: string;
	/** Volt tasks: the child chat. */
	readonly childId?: string;
	readonly title: string;
	/** Harness subagent type (explore, generalPurpose) when it names one. */
	readonly kind?: string;
	readonly role: AgentTaskRole;
	readonly origin: AgentTaskOrigin;
	readonly brief: string;
	readonly modelRef?: string;
	readonly modelLabel?: string;
	readonly mode?: string;
	readonly isolation: AgentTaskIsolation;
	/** Paths the task said it owns (prefixes). Overlapping live claims are reported as conflicts. */
	readonly scope?: readonly string[];
	readonly depth: number;
	readonly createdAt: number;
	readonly clientRequestId?: string;
	readonly state: OrchTaskState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	/** The child's latest step ("Read auth.ts"). */
	readonly activity?: string;
	readonly steps: number;
	readonly waitingOn?: 'approval' | 'question';
	readonly result?: string;
	readonly error?: string;
	readonly files: readonly string[];
	readonly delivery: AgentTaskDelivery;
	readonly rounds: number;
	readonly worktreePath?: string;
	readonly worktreeBranch?: string;
	/**
	 * A later round of the same work, delegated again as a new task (a second review after fixes):
	 * the task it follows, and its place in that chain (2 for the second round).
	 */
	readonly previousTaskId?: string;
	readonly iteration?: number;
	/** Times Volt restarted while it ran and it continued on its own. */
	readonly restarts?: number;
}

export interface IOrchConflict {
	readonly path: string;
	readonly taskIds: readonly string[];
	readonly at: number;
}

export interface IOrchState {
	readonly version: number;
	readonly seq: number;
	readonly threads: Readonly<Record<string, IOrchThread>>;
	readonly tasks: Readonly<Record<string, IOrchTask>>;
	/** Recent command ids, oldest first: a retried command is acknowledged without acting twice. */
	readonly receipts: readonly string[];
	/** Live file conflicts between parallel subagents, by root. */
	readonly conflicts: Readonly<Record<string, readonly IOrchConflict[]>>;
}

export function emptyOrchState(): IOrchState {
	return { version: ORCHESTRATOR_STATE_VERSION, seq: 0, threads: {}, tasks: {}, receipts: [], conflicts: {} };
}

/**
 * The prompt the queue sends next. The queue keeps its order: while the head is open for editing
 * nothing behind it goes, so the edited prompt is not answered after the ones written later.
 */
export function nextQueued(thread: Pick<IOrchThread, 'queue'>): IOrchQueueItem | undefined {
	const head = thread.queue[0];
	return head && !head.held ? head : undefined;
}

//#endregion

//#region Commands

/**
 * How `thread.submit` treats a busy thread.
 * - `auto`: run now when idle, else queue (Enter).
 * - `queue`: always queue, even when idle and paused (the user queued it on purpose).
 * - `now`: steer the running agent when it takes messages, else stop it and run this first (Cmd+Enter).
 */
export type OrchDelivery = 'auto' | 'queue' | 'now';

export interface IOrchTaskSpawn {
	readonly parentId: string;
	readonly brief: string;
	readonly title: string;
	readonly role: AgentTaskRole;
	readonly origin: AgentTaskOrigin;
	readonly modelRef?: string;
	readonly modelLabel?: string;
	readonly mode?: string;
	readonly isolation: AgentTaskIsolation;
	readonly scope?: readonly string[];
	readonly clientRequestId?: string;
	readonly toolCallId?: string;
	/** The task this one is the next round of (a new review after fixes). */
	readonly previousTaskId?: string;
	/** Id for the new task and its child chat, picked by the caller so a retry can be recognized. */
	readonly taskId: string;
	readonly childId: string;
	/** The prompt the child model receives (Volt's subagent framing around the brief). */
	readonly childPrompt: IOrchPrompt;
}

export type OrchCommandBody =
	/** Describe a chat (title, model). Creates it when unknown. */
	| { readonly type: 'thread.upsert'; readonly threadId: string; readonly title?: string; readonly modelRef?: string; readonly modelLabel?: string; readonly parentId?: string }
	| { readonly type: 'thread.submit'; readonly threadId: string; readonly turnId: string; readonly prompt: IOrchPrompt; readonly delivery: OrchDelivery; readonly canSteer?: boolean }
	/**
	 * Volt wakes the chat with news it did not ask for in this turn (a watched pull request's checks
	 * failed, a review came in). It runs as a `notification` turn after whatever is running or
	 * queued, counts toward `maxWakeups`, and is refused once the chat woke that often in a row.
	 * Another chat's agent messages a chat the same way (`thread_send`), so two agents cannot keep
	 * each other busy forever. `interrupt`: stop the running turn and run this one next.
	 */
	| { readonly type: 'thread.notify'; readonly threadId: string; readonly turnId: string; readonly prompt: IOrchPrompt; readonly interrupt?: boolean }
	| { readonly type: 'thread.block'; readonly threadId: string; readonly reason: string | undefined }
	| { readonly type: 'thread.forget'; readonly threadId: string }
	| { readonly type: 'queue.remove'; readonly threadId: string; readonly itemId: string }
	| { readonly type: 'queue.reorder'; readonly threadId: string; readonly ids: readonly string[] }
	| { readonly type: 'queue.update'; readonly threadId: string; readonly itemId: string; readonly prompt: IOrchPrompt }
	| { readonly type: 'queue.hold'; readonly threadId: string; readonly itemId: string; readonly held: boolean }
	| { readonly type: 'queue.clear'; readonly threadId: string }
	| { readonly type: 'queue.sendNow'; readonly threadId: string; readonly itemId: string; readonly canSteer?: boolean }
	| { readonly type: 'queue.resume'; readonly threadId: string }
	/** Hold the queue until the user resumes it (the chat's project failed to clone, ...). */
	| { readonly type: 'queue.pause'; readonly threadId: string; readonly reason: OrchPause }
	/** Stop. `cascade`: also stop the subagents this turn started (`turn`) or every live one of the chat (`all`). */
	| { readonly type: 'turn.cancel'; readonly threadId: string; readonly cascade?: 'turn' | 'all'; readonly reason?: string }
	/** Continue a turn that was interrupted. */
	| { readonly type: 'turn.resume'; readonly threadId: string; readonly turnId: string; readonly prompt: IOrchPrompt }
	/** The runtime started the run for a turn (or one Volt did not dispatch). */
	| { readonly type: 'run.started'; readonly threadId: string; readonly runId: string; readonly turnId?: string; readonly steerable?: boolean }
	/** `limit`: the provider refused for a usage limit; the chat parks until the reset instead of failing. */
	| { readonly type: 'run.settled'; readonly threadId: string; readonly runId?: string; readonly turnId?: string; readonly outcome: OrchOutcome; readonly error?: string; readonly reply?: string; readonly limit?: { readonly resetAt?: number; readonly message: string } }
	/** A steer could not be delivered (the run ended first): reports go back to pending, a prompt back to the queue's head. */
	| { readonly type: 'steer.failed'; readonly threadId: string; readonly steerId: string; readonly prompt: IOrchPrompt; readonly taskIds?: readonly string[] }
	/** The effect that starts a turn failed before the runtime took it. */
	| { readonly type: 'dispatch.failed'; readonly threadId: string; readonly turnId: string; readonly error: string }
	| { readonly type: 'input.opened'; readonly threadId: string; readonly inputId: string; readonly kind: 'approval' | 'question' }
	| { readonly type: 'input.closed'; readonly threadId: string; readonly inputId: string }
	| { readonly type: 'task.spawn'; readonly spawn: IOrchTaskSpawn }
	| { readonly type: 'task.cancel'; readonly taskId: string; readonly reason?: string }
	| { readonly type: 'task.message'; readonly taskId: string; readonly turnId: string; readonly prompt: IOrchPrompt }
	/** The parent's agent read these reports itself (task_status, wait_tasks): no notification turn. */
	| { readonly type: 'task.ack'; readonly taskIds: readonly string[] }
	| { readonly type: 'task.progress'; readonly taskId: string; readonly activity?: string; readonly steps?: number; readonly files?: readonly string[] }
	| { readonly type: 'task.worktree'; readonly taskId: string; readonly path: string; readonly branch: string }
	/** Something outside a turn failed the task (its worktree could not be created). */
	| { readonly type: 'task.error'; readonly taskId: string; readonly error: string }
	/** The harness started its own subagent (a Task tool call) in a thread's running turn. */
	| { readonly type: 'harness.started'; readonly threadId: string; readonly toolCallId: string; readonly title: string; readonly kind?: string; readonly brief?: string; readonly modelLabel?: string }
	| { readonly type: 'harness.progress'; readonly threadId: string; readonly toolCallId: string; readonly activity?: string; readonly title?: string; readonly kind?: string; readonly modelLabel?: string }
	| { readonly type: 'harness.ended'; readonly threadId: string; readonly toolCallId: string; readonly ok: boolean; readonly result?: string; readonly error?: string }
	| { readonly type: 'file.changed'; readonly threadId: string; readonly path: string }
	/** Switch a chat to another model, now when idle or when its turn ends. */
	| { readonly type: 'thread.handoff'; readonly threadId: string; readonly to: string; readonly toLabel: string; readonly reason?: string; readonly brief?: string; readonly by: 'agent' | 'user' }
	/**
	 * The clock reached a parked chat's reset (or probe) time. `autoResume` is the setting; each
	 * chat's own choice wins. Due chats continue one at a time, the rest get later slots.
	 */
	| { readonly type: 'limit.tick'; readonly autoResume: boolean }
	/** Resume a parked chat now (the user's Resume now, or after switching models). */
	| { readonly type: 'limit.resume'; readonly threadId: string }
	/** The user's choice for a parked chat: `auto` false cancels its resume; undefined follows the setting. */
	| { readonly type: 'limit.configure'; readonly threadId: string; readonly auto: boolean | undefined }
	/** Move the chat to another checkout: now when idle, else when its turn ends (`stop`: stop the turn first). */
	| { readonly type: 'thread.move'; readonly threadId: string; readonly move: IOrchMove; readonly stop?: boolean }
	| { readonly type: 'move.cancel'; readonly threadId: string }
	/** The mover is done (or gave up and rolled back). */
	| { readonly type: 'move.finished'; readonly threadId: string; readonly result: IOrchMoveResult }
	/**
	 * After a restart: nothing that was running is running any more. `resume` picks what continues
	 * on its own (see `OrchRestartResume`); everything else waits for the user.
	 */
	| { readonly type: 'recover'; readonly resume?: OrchRestartResume };

/**
 * What continues by itself after Volt restarts mid-run (the agent processes died with the window).
 * - `off`: nothing; every interrupted chat shows Resume.
 * - `subagents`: delegated tasks continue, so the chat that is waiting for their reports gets them.
 * - `all`: interrupted chats continue too.
 */
export type OrchRestartResume = 'off' | 'subagents' | 'all';

export const ORCH_RESUME_AFTER_RESTART_SETTING = 'volt.agent.resumeAfterRestart';

export type OrchCommand = OrchCommandBody & {
	/** Idempotency key. A command id seen before is acknowledged without effect. */
	readonly id: string;
	readonly at: number;
};

//#endregion

//#region Events

export type OrchEvent =
	| { readonly type: 'thread.created'; readonly thread: IOrchThread }
	| { readonly type: 'thread.updated'; readonly threadId: string; readonly title?: string; readonly modelRef?: string; readonly modelLabel?: string }
	| { readonly type: 'thread.blocked'; readonly threadId: string; readonly reason: string | undefined }
	| { readonly type: 'thread.forgotten'; readonly threadId: string }
	| { readonly type: 'queue.added'; readonly threadId: string; readonly item: IOrchQueueItem; readonly head?: boolean }
	| { readonly type: 'queue.removed'; readonly threadId: string; readonly itemId: string; readonly reason: 'user' | 'dispatched' | 'cleared' }
	| { readonly type: 'queue.reordered'; readonly threadId: string; readonly ids: readonly string[] }
	| { readonly type: 'queue.updated'; readonly threadId: string; readonly itemId: string; readonly prompt?: IOrchPrompt; readonly held?: boolean }
	| { readonly type: 'queue.paused'; readonly threadId: string; readonly reason: OrchPause }
	| { readonly type: 'queue.resumed'; readonly threadId: string }
	| { readonly type: 'turn.dispatched'; readonly threadId: string; readonly turn: IOrchTurn }
	| { readonly type: 'turn.steered'; readonly threadId: string; readonly turnId: string; readonly prompt: IOrchPrompt; readonly steerId: string; readonly taskIds?: readonly string[] }
	| { readonly type: 'turn.bound'; readonly threadId: string; readonly turnId: string; readonly runId: string; readonly steerable?: boolean }
	| { readonly type: 'turn.cancelling'; readonly threadId: string; readonly turnId: string }
	| { readonly type: 'turn.settled'; readonly threadId: string; readonly turnId: string; readonly outcome: OrchOutcome; readonly at: number; readonly error?: string }
	| { readonly type: 'input.opened'; readonly threadId: string; readonly input: IOrchInput }
	| { readonly type: 'input.closed'; readonly threadId: string; readonly inputId: string }
	| { readonly type: 'task.created'; readonly task: IOrchTask }
	| { readonly type: 'task.started'; readonly taskId: string; readonly at: number }
	| { readonly type: 'task.updated'; readonly taskId: string; readonly activity?: string; readonly steps?: number; readonly files?: readonly string[]; readonly title?: string; readonly kind?: string; readonly modelLabel?: string; readonly worktreePath?: string; readonly worktreeBranch?: string }
	| { readonly type: 'task.waiting'; readonly taskId: string; readonly on: 'approval' | 'question' | undefined }
	| { readonly type: 'task.settled'; readonly taskId: string; readonly state: Extract<OrchTaskState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>; readonly at: number; readonly result?: string; readonly error?: string }
	| { readonly type: 'task.resumed'; readonly taskId: string; readonly at: number }
	/** Volt restarted while the task ran and it continues in a resume turn. */
	| { readonly type: 'task.restarted'; readonly taskId: string; readonly at: number }
	| { readonly type: 'task.delivery'; readonly taskIds: readonly string[]; readonly delivery: AgentTaskDelivery }
	/** Old finished tasks leave the state (their chats stay in history). */
	| { readonly type: 'task.pruned'; readonly taskIds: readonly string[] }
	| { readonly type: 'handoff.requested'; readonly threadId: string; readonly handoff: IOrchHandoff }
	| { readonly type: 'handoff.applied'; readonly threadId: string; readonly handoff: IOrchHandoff }
	| { readonly type: 'limit.parked'; readonly threadId: string; readonly limit: IOrchLimitPark }
	| { readonly type: 'limit.configured'; readonly threadId: string; readonly auto: boolean | undefined }
	| { readonly type: 'limit.deferred'; readonly threadId: string; readonly notBefore: number }
	| { readonly type: 'move.requested'; readonly threadId: string; readonly move: IOrchMove }
	| { readonly type: 'move.dropped'; readonly threadId: string; readonly moveId: string }
	| { readonly type: 'move.started'; readonly threadId: string; readonly move: IOrchMove }
	| { readonly type: 'move.finished'; readonly threadId: string; readonly result: IOrchMoveResult }
	| { readonly type: 'conflict.detected'; readonly rootId: string; readonly conflict: IOrchConflict }
	| { readonly type: 'conflict.cleared'; readonly rootId: string; readonly path: string };

export interface IOrchEventEnvelope {
	readonly seq: number;
	readonly at: number;
	readonly commandId: string;
	readonly event: OrchEvent;
}

//#endregion

//#region Effects

/** Work the service does after the events that caused it are durable. */
export type OrchEffect =
	| { readonly kind: 'startTurn'; readonly threadId: string; readonly turn: IOrchTurn }
	| { readonly kind: 'steer'; readonly threadId: string; readonly turnId: string; readonly prompt: IOrchPrompt; readonly steerId: string; readonly taskIds?: readonly string[] }
	| { readonly kind: 'cancelTurn'; readonly threadId: string; readonly turnId: string; readonly runId?: string }
	/** Long polls (`wait_tasks`) waiting on these tasks re-check. */
	| { readonly kind: 'tasksChanged'; readonly taskIds: readonly string[] }
	/** A subagent asked for a worktree; the service creates it before its first turn starts. */
	| { readonly kind: 'prepareWorktree'; readonly taskId: string }
	/** Move a chat's checkout (see `IOrchWorkspaceMover`); ends with `move.finished`. */
	| { readonly kind: 'moveWorkspace'; readonly threadId: string; readonly move: IOrchMove };

//#endregion

//#region Limits

export interface IOrchLimits {
	/** Volt subagents per parent that run at once; more wait in `queued`. */
	readonly runningPerParent: number;
	/** Volt subagents across the window that run at once. */
	readonly runningTotal: number;
	readonly maxDepth: number;
	/** Command ids remembered for idempotency. */
	readonly receipts: number;
	/** Finished tasks kept per root (the oldest are dropped from state). */
	readonly finishedTasksPerRoot: number;
	/** Automatic turns in a row before the chat waits for the user. */
	readonly maxWakeups: number;
	/** Restarts a running turn continues through on its own; past that it waits for the user (a crash loop). */
	readonly maxRestartResumes: number;
}

export const DEFAULT_ORCH_LIMITS: IOrchLimits = {
	runningPerParent: 4,
	runningTotal: 8,
	maxDepth: 2,
	receipts: 512,
	finishedTasksPerRoot: 60,
	maxWakeups: 8,
	maxRestartResumes: 2,
};

//#endregion

//#region Service

export const IAgentOrchestratorService = createDecorator<IAgentOrchestratorService>('agentOrchestratorService');

export interface IOrchSubmitResult {
	/** What happened to the prompt: started, queued behind the running turn, steered into it, or dropped as a duplicate. */
	readonly outcome: 'started' | 'queued' | 'steered' | 'duplicate' | 'rejected';
	readonly reason?: string;
}

export interface IOrchChange {
	/** Threads whose state changed (projection consumers re-read these). */
	readonly threads: readonly string[];
	readonly tasks: readonly string[];
}

export interface IOrchStartTurnRequest {
	readonly threadId: string;
	readonly turn: IOrchTurn;
	readonly thread: IOrchThread;
	/** False once the turn was stopped or replaced: the host must not send it. */
	isCurrent(): boolean;
}

/**
 * Starts turns for the orchestrator. The chat UI implements it: it builds the transcript messages
 * (with or without a visible panel), records them, and hands the prompt to the runtime.
 */
export interface IOrchTurnHost {
	/** Resolves with the runtime's run id, or undefined when the turn was no longer current. */
	startTurn(request: IOrchStartTurnRequest): Promise<string | undefined>;
	/** Puts a message into a running native turn (and its transcript). False when the run ended first. */
	steer?(threadId: string, prompt: IOrchPrompt, steerId: string): boolean | Promise<boolean>;
	/** Ties a subagent's chat to its parent's project before its first turn. */
	prepareChild?(childId: string, parentId: string): Promise<void> | void;
}

export interface IOrchMoveRequest {
	readonly threadId: string;
	readonly move: IOrchMove;
	readonly thread: IOrchThread;
}

/**
 * Moves a chat's files and binding to another checkout (the chat UI implements it). Resolves with
 * how it went; it must roll back what it did when it fails, so the chat stays where it was.
 */
export interface IOrchWorkspaceMover {
	move(request: IOrchMoveRequest): Promise<Omit<IOrchMoveResult, 'id' | 'at' | 'label' | 'by'> & { readonly label?: string }>;
}

export interface IAgentOrchestratorService {
	readonly _serviceBrand: undefined;
	/** Fires after each command batch is applied (before effects run). */
	readonly onDidChange: Event<IOrchChange>;
	/** Tasks whose state or progress changed (long polls, rows with a live clock). */
	readonly onDidChangeTasks: Event<readonly string[]>;
	/** Resolves once persisted roots are loaded and recovery ran. */
	readonly whenReady: Promise<void>;

	getState(): IOrchState;
	getThread(threadId: string): IOrchThread | undefined;
	getTask(taskId: string): IOrchTask | undefined;
	/** Tasks a thread started, oldest first. */
	tasksOf(threadId: string): readonly IOrchTask[];
	/** The task behind a parent's tool call (a `delegate_task` call or the harness's own Task call). */
	taskForToolCall(threadId: string, toolCallId: string): IOrchTask | undefined;

	/** Apply a command. Commands are serialized; the promise resolves once its events are applied. */
	dispatch(command: OrchCommandBody & { readonly id?: string }): Promise<readonly OrchEvent[]>;

	/** `turnId` becomes the transcript id of the user message; callers pass one to correlate. */
	submit(threadId: string, prompt: IOrchPrompt, delivery: OrchDelivery, turnId?: string): Promise<IOrchSubmitResult>;

	/** Moves the chat to another checkout: now when idle, after the running turn (or at once with `stop`). */
	move(threadId: string, spec: IWorkspaceMoveSpec, options: { readonly by: 'user' | 'agent'; readonly stop?: boolean }): Promise<IOrchSubmitResult>;
	/** Resumes a chat parked at a usage limit now, without waiting for the reset. */
	resumeLimit(threadId: string): Promise<IOrchSubmitResult>;
	/** The chat's own auto-resume choice while parked: false cancels, true asks, undefined follows the setting. */
	configureLimit(threadId: string, auto: boolean | undefined): Promise<void>;
	/** Wakes the chat with a notification turn (see `thread.notify`). A retried `turnId` is not sent twice. */
	notify(threadId: string, prompt: IOrchPrompt, turnId: string, options?: { readonly interrupt?: boolean }): Promise<IOrchSubmitResult>;
	/** The user's Stop (or Stop all). Agents interrupt chats with `dispatch({ type: 'turn.cancel' })`, which does not fire `onDidStop`. */
	cancel(threadId: string, options?: { readonly cascade?: 'turn' | 'all' }): Promise<void>;
	/** The user stopped a chat: what it was waiting on for itself (pull request watches) ends too. */
	readonly onDidStop: Event<string>;
	/** The turn is the chat's active one and is not being stopped. */
	isTurnCurrent(threadId: string, turnId: string): boolean;
	/** Load a chat's persisted orchestration (its root) when it is opened. */
	ensureThreadLoaded(threadId: string): Promise<void>;
	setTurnHost(host: IOrchTurnHost): IDisposable;
	setWorkspaceMover(mover: IOrchWorkspaceMover): IDisposable;
	/** Whether parked chats resume on their own by default (the setting). */
	autoResumeDefault(): boolean;
}

//#endregion
