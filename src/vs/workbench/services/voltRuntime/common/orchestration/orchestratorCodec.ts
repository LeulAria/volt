/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLiveTaskState } from './agentTasks.js';
import { IOrchConflict, IOrchEventEnvelope, IOrchLimitPark, IOrchMove, IOrchMoveResult, IOrchQueueItem, IOrchState, IOrchTask, IOrchThread, IOrchTurn, ORCHESTRATOR_STATE_VERSION } from './orchestrator.js';

/**
 * Orchestration is persisted per root chat: the chat, its subagents' chats and their tasks in one
 * file, written whole (atomically) after each change batch. A root file is small (threads, queues,
 * task records; transcripts live in agent history), so rewriting it is cheap and a torn write can
 * only leave the previous complete file. The newest events ride along as an audit trail.
 *
 * Reading never trusts the file: malformed threads and tasks are dropped one by one, so a damaged
 * file loses what is damaged and nothing else.
 */

export const ORCH_ROOT_EVENTS_KEPT = 200;

export interface IOrchRootSnapshot {
	readonly version: number;
	readonly rootId: string;
	readonly seq: number;
	readonly savedAt: number;
	readonly threads: readonly IOrchThread[];
	readonly tasks: readonly IOrchTask[];
	readonly conflicts: readonly IOrchConflict[];
	readonly events: readonly IOrchEventEnvelope[];
}

export interface IOrchIndex {
	readonly version: number;
	readonly seq: number;
	/** Roots with work that a restart must look at (running, queued, paused, undelivered). */
	readonly live: readonly string[];
	/** Every root with a file, most recently saved last. */
	readonly roots: readonly string[];
}

export function rootIdsOf(state: IOrchState): string[] {
	return [...new Set(Object.values(state.threads).map(thread => thread.rootId))];
}

export function extractRoot(state: IOrchState, rootId: string, events: readonly IOrchEventEnvelope[], savedAt: number): IOrchRootSnapshot {
	return {
		version: ORCHESTRATOR_STATE_VERSION,
		rootId,
		seq: state.seq,
		savedAt,
		threads: Object.values(state.threads).filter(thread => thread.rootId === rootId),
		tasks: Object.values(state.tasks).filter(task => task.rootId === rootId),
		conflicts: state.conflicts[rootId] ?? [],
		events: events.slice(-ORCH_ROOT_EVENTS_KEPT),
	};
}

/** The root has something a restart must reconcile or the user must see. */
export function isRootLive(state: IOrchState, rootId: string): boolean {
	for (const thread of Object.values(state.threads)) {
		if (thread.rootId === rootId && (thread.active || thread.queue.length || thread.pause || thread.inputs.length || thread.pendingHandoff || thread.limit || thread.pendingMove || thread.moving)) {
			return true;
		}
	}
	for (const task of Object.values(state.tasks)) {
		if (task.rootId === rootId && (isLiveTaskState(task.state) || task.delivery === 'pending')) {
			return true;
		}
	}
	return false;
}

/** Puts a loaded root into the state, replacing whatever the state had for it. */
export function mergeRoot(state: IOrchState, snapshot: IOrchRootSnapshot): IOrchState {
	const threads: Record<string, IOrchThread> = {};
	for (const [id, thread] of Object.entries(state.threads)) {
		if (thread.rootId !== snapshot.rootId) {
			threads[id] = thread;
		}
	}
	for (const thread of snapshot.threads) {
		threads[thread.id] = thread;
	}
	const tasks: Record<string, IOrchTask> = {};
	for (const [id, task] of Object.entries(state.tasks)) {
		if (task.rootId !== snapshot.rootId) {
			tasks[id] = task;
		}
	}
	for (const task of snapshot.tasks) {
		tasks[task.id] = task;
	}
	const conflicts = { ...state.conflicts };
	if (snapshot.conflicts.length) {
		conflicts[snapshot.rootId] = snapshot.conflicts;
	} else {
		delete conflicts[snapshot.rootId];
	}
	return { ...state, seq: Math.max(state.seq, snapshot.seq), threads, tasks, conflicts };
}

export function parseIndex(raw: unknown): IOrchIndex {
	const value = raw as Partial<IOrchIndex> | undefined;
	const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && isSafeId(id)) : [];
	return {
		version: ORCHESTRATOR_STATE_VERSION,
		seq: typeof value?.seq === 'number' && Number.isFinite(value.seq) ? value.seq : 0,
		live: ids(value?.live),
		roots: ids(value?.roots),
	};
}

export function parseRootSnapshot(raw: unknown): IOrchRootSnapshot | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.rootId !== 'string' || !isSafeId(value.rootId) || typeof value.version !== 'number' || value.version > ORCHESTRATOR_STATE_VERSION) {
		return undefined;
	}
	const rootId = value.rootId;
	const threads = (Array.isArray(value.threads) ? value.threads : []).map(parseThread).filter((thread): thread is IOrchThread => !!thread && thread.rootId === rootId);
	const threadIds = new Set(threads.map(thread => thread.id));
	const tasks = (Array.isArray(value.tasks) ? value.tasks : []).map(parseTask).filter((task): task is IOrchTask => !!task && task.rootId === rootId);
	const conflicts = (Array.isArray(value.conflicts) ? value.conflicts : []).flatMap(item => {
		const conflict = item as Partial<IOrchConflict> | undefined;
		return conflict && typeof conflict.path === 'string' && Array.isArray(conflict.taskIds) && typeof conflict.at === 'number'
			? [{ path: conflict.path, taskIds: conflict.taskIds.filter((id): id is string => typeof id === 'string'), at: conflict.at }]
			: [];
	});
	return {
		version: value.version,
		rootId,
		seq: typeof value.seq === 'number' && Number.isFinite(value.seq) ? value.seq : 0,
		savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
		// A thread whose parent did not survive becomes its own root's orphan: keep it, drop the dangling link.
		threads: threads.map(thread => thread.parentId && !threadIds.has(thread.parentId) ? withoutParent(thread) : thread),
		tasks,
		conflicts,
		events: Array.isArray(value.events) ? value.events.filter(isEnvelope).slice(-ORCH_ROOT_EVENTS_KEPT) : [],
	};
}

function withoutParent(thread: IOrchThread): IOrchThread {
	const { parentId: _parentId, ...rest } = thread;
	return rest;
}

function isEnvelope(value: unknown): value is IOrchEventEnvelope {
	const envelope = value as Partial<IOrchEventEnvelope> | undefined;
	return !!envelope && typeof envelope.seq === 'number' && typeof envelope.at === 'number' && typeof envelope.commandId === 'string'
		&& !!envelope.event && typeof envelope.event === 'object' && typeof (envelope.event as { type?: unknown }).type === 'string';
}

export function isSafeId(id: string): boolean {
	return /^[A-Za-z0-9._:-]{1,160}$/.test(id);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parsePromptLike(value: unknown): IOrchTurn['prompt'] | undefined {
	const prompt = value as Record<string, unknown> | undefined;
	if (!prompt || typeof prompt.text !== 'string') {
		return undefined;
	}
	return {
		text: prompt.text,
		...(prompt.display !== undefined ? { display: prompt.display } : {}),
		...(typeof prompt.mode === 'string' ? { mode: prompt.mode } : {}),
		...(typeof prompt.modelRef === 'string' ? { modelRef: prompt.modelRef } : {}),
		...(prompt.options && typeof prompt.options === 'object' ? { options: prompt.options as Record<string, string | boolean> } : {}),
		...(prompt.host !== undefined ? { host: prompt.host } : {}),
	};
}

const TURN_KINDS = new Set(['prompt', 'notification', 'brief', 'followup', 'resume', 'external']);
const TURN_PHASES = new Set(['dispatching', 'running', 'cancelling']);
const PAUSES = new Set(['failed', 'stopped', 'interrupted', 'wakeups', 'limit']);
const OUTCOMES = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const TASK_STATES = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
const DELIVERIES = new Set(['pending', 'delivered', 'acknowledged', 'none']);
const ROLES = new Set(['general', 'research', 'implementation', 'review', 'test', 'design']);

function parseTurn(value: unknown): IOrchTurn | undefined {
	const turn = value as Record<string, unknown> | undefined;
	const prompt = parsePromptLike(turn?.prompt);
	if (!turn || typeof turn.id !== 'string' || !TURN_KINDS.has(turn.kind as string) || !TURN_PHASES.has(turn.phase as string) || !prompt || num(turn.at) === undefined) {
		return undefined;
	}
	return {
		id: turn.id,
		kind: turn.kind as IOrchTurn['kind'],
		prompt,
		at: turn.at as number,
		phase: turn.phase as IOrchTurn['phase'],
		...(typeof turn.runId === 'string' ? { runId: turn.runId } : {}),
		...(Array.isArray(turn.taskIds) ? { taskIds: turn.taskIds.filter((id): id is string => typeof id === 'string') } : {}),
		...(turn.interrupting === true ? { interrupting: true } : {}),
		...(turn.steerable === true ? { steerable: true } : {}),
		...(num(turn.limitProbe) !== undefined ? { limitProbe: turn.limitProbe as number } : {}),
		...(typeof turn.limitAuto === 'boolean' ? { limitAuto: turn.limitAuto } : {}),
	};
}

function parseLimit(value: unknown): IOrchLimitPark | undefined {
	const limit = value as Record<string, unknown> | undefined;
	if (!limit || typeof limit.turnId !== 'string' || num(limit.at) === undefined) {
		return undefined;
	}
	return {
		turnId: limit.turnId,
		at: limit.at as number,
		...(num(limit.resetAt) !== undefined ? { resetAt: limit.resetAt as number } : {}),
		...(str(limit.message) ? { message: limit.message as string } : {}),
		probes: num(limit.probes) ?? 0,
		...(typeof limit.auto === 'boolean' ? { auto: limit.auto } : {}),
		...(num(limit.notBefore) !== undefined ? { notBefore: limit.notBefore as number } : {}),
		...(str(limit.mode) ? { mode: limit.mode as string } : {}),
	};
}

function parseMove(value: unknown): IOrchMove | undefined {
	const move = value as Record<string, unknown> | undefined;
	if (!move || typeof move.id !== 'string' || typeof move.label !== 'string' || num(move.at) === undefined) {
		return undefined;
	}
	return { id: move.id, target: move.target, label: move.label, by: move.by === 'agent' ? 'agent' : 'user', at: move.at as number };
}

function parseMoveResult(value: unknown): IOrchMoveResult | undefined {
	const result = value as Record<string, unknown> | undefined;
	if (!result || typeof result.id !== 'string' || typeof result.label !== 'string' || num(result.at) === undefined || typeof result.ok !== 'boolean') {
		return undefined;
	}
	return {
		id: result.id,
		at: result.at as number,
		ok: result.ok,
		label: result.label,
		...(str(result.error) ? { error: result.error as string } : {}),
		...(str(result.path) ? { path: result.path as string } : {}),
		...(str(result.branch) ? { branch: result.branch as string } : {}),
		...(str(result.fromPath) ? { fromPath: result.fromPath as string } : {}),
		...(str(result.fromBranch) ? { fromBranch: result.fromBranch as string } : {}),
		...(num(result.files) !== undefined ? { files: result.files as number } : {}),
		...(result.by === 'agent' || result.by === 'user' ? { by: result.by } : {}),
	};
}

function parseQueueItem(value: unknown): IOrchQueueItem | undefined {
	const item = value as Record<string, unknown> | undefined;
	const prompt = parsePromptLike(item?.prompt);
	if (!item || typeof item.id !== 'string' || !prompt || num(item.at) === undefined) {
		return undefined;
	}
	return {
		id: item.id,
		prompt,
		at: item.at as number,
		...(TURN_KINDS.has(item.kind as string) ? { kind: item.kind as IOrchQueueItem['kind'] } : {}),
		// No `held`: it marks a prompt open in a composer, and no composer survives a reload. Kept,
		// a prompt the user was editing when the window closed would be skipped forever.
	};
}

function parseThread(value: unknown): IOrchThread | undefined {
	const thread = value as Record<string, unknown> | undefined;
	if (!thread || typeof thread.id !== 'string' || !isSafeId(thread.id) || typeof thread.rootId !== 'string' || num(thread.createdAt) === undefined) {
		return undefined;
	}
	const active = thread.active !== undefined ? parseTurn(thread.active) : undefined;
	const last = thread.last as Record<string, unknown> | undefined;
	return {
		id: thread.id,
		rootId: thread.rootId,
		...(str(thread.parentId) ? { parentId: thread.parentId as string } : {}),
		...(str(thread.taskId) ? { taskId: thread.taskId as string } : {}),
		depth: num(thread.depth) ?? 0,
		createdAt: thread.createdAt as number,
		...(str(thread.title) ? { title: thread.title as string } : {}),
		...(str(thread.modelRef) ? { modelRef: thread.modelRef as string } : {}),
		...(str(thread.modelLabel) ? { modelLabel: thread.modelLabel as string } : {}),
		...(active ? { active } : {}),
		queue: (Array.isArray(thread.queue) ? thread.queue : []).map(parseQueueItem).filter((item): item is IOrchQueueItem => !!item),
		...(PAUSES.has(thread.pause as string) ? { pause: thread.pause as IOrchThread['pause'] } : {}),
		...(str(thread.blocked) ? { blocked: thread.blocked as string } : {}),
		inputs: (Array.isArray(thread.inputs) ? thread.inputs : []).flatMap(item => {
			const input = item as Record<string, unknown> | undefined;
			return input && typeof input.id === 'string' && (input.kind === 'approval' || input.kind === 'question') && typeof input.at === 'number'
				? [{ id: input.id, kind: input.kind, at: input.at }]
				: [];
		}),
		...(last && typeof last.turnId === 'string' && TURN_KINDS.has(last.kind as string) && OUTCOMES.has(last.outcome as string) && typeof last.at === 'number'
			? { last: { turnId: last.turnId, kind: last.kind as IOrchTurn['kind'], outcome: last.outcome as 'done', at: last.at, ...(typeof last.error === 'string' ? { error: last.error } : {}) } }
			: {}),
		turns: num(thread.turns) ?? 0,
		...(num(thread.wakeups) ? { wakeups: thread.wakeups as number } : {}),
		...(thread.pendingHandoff && typeof (thread.pendingHandoff as { to?: unknown }).to === 'string' ? { pendingHandoff: thread.pendingHandoff as IOrchThread['pendingHandoff'] } : {}),
		handoffs: Array.isArray(thread.handoffs) ? thread.handoffs.filter(item => !!item && typeof (item as { to?: unknown }).to === 'string' && typeof (item as { at?: unknown }).at === 'number') as IOrchThread['handoffs'] : [],
		...optional('limit', parseLimit(thread.limit)),
		...optional('pendingMove', parseMove(thread.pendingMove)),
		...optional('moving', parseMove(thread.moving)),
		...optional('lastMove', parseMoveResult(thread.lastMove)),
	};
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function parseTask(value: unknown): IOrchTask | undefined {
	const task = value as Record<string, unknown> | undefined;
	if (!task || typeof task.id !== 'string' || typeof task.parentId !== 'string' || typeof task.rootId !== 'string' || typeof task.title !== 'string'
		|| (task.source !== 'volt' && task.source !== 'harness') || !TASK_STATES.has(task.state as string) || num(task.createdAt) === undefined) {
		return undefined;
	}
	return {
		id: task.id,
		source: task.source,
		parentId: task.parentId,
		rootId: task.rootId,
		...(str(task.parentTurnId) ? { parentTurnId: task.parentTurnId as string } : {}),
		...(str(task.toolCallId) ? { toolCallId: task.toolCallId as string } : {}),
		...(str(task.childId) ? { childId: task.childId as string } : {}),
		title: task.title,
		...(str(task.kind) ? { kind: task.kind as string } : {}),
		role: ROLES.has(task.role as string) ? task.role as IOrchTask['role'] : 'general',
		origin: task.origin === 'user' ? 'user' : 'agent',
		brief: str(task.brief) ?? '',
		...(str(task.modelRef) ? { modelRef: task.modelRef as string } : {}),
		...(str(task.modelLabel) ? { modelLabel: task.modelLabel as string } : {}),
		...(str(task.mode) ? { mode: task.mode as string } : {}),
		isolation: task.isolation === 'worktree' ? 'worktree' : 'shared',
		...(Array.isArray(task.scope) ? { scope: task.scope.filter((path): path is string => typeof path === 'string') } : {}),
		depth: num(task.depth) ?? 1,
		createdAt: task.createdAt as number,
		...(str(task.clientRequestId) ? { clientRequestId: task.clientRequestId as string } : {}),
		state: task.state as IOrchTask['state'],
		...(num(task.startedAt) !== undefined ? { startedAt: task.startedAt as number } : {}),
		...(num(task.endedAt) !== undefined ? { endedAt: task.endedAt as number } : {}),
		...(str(task.activity) ? { activity: task.activity as string } : {}),
		steps: num(task.steps) ?? 0,
		...(task.waitingOn === 'approval' || task.waitingOn === 'question' ? { waitingOn: task.waitingOn } : {}),
		...(str(task.result) !== undefined ? { result: task.result as string } : {}),
		...(str(task.error) !== undefined ? { error: task.error as string } : {}),
		files: Array.isArray(task.files) ? task.files.filter((path): path is string => typeof path === 'string') : [],
		delivery: DELIVERIES.has(task.delivery as string) ? task.delivery as IOrchTask['delivery'] : 'none',
		rounds: num(task.rounds) ?? 1,
		...(str(task.worktreePath) ? { worktreePath: task.worktreePath as string } : {}),
		...(str(task.worktreeBranch) ? { worktreeBranch: task.worktreeBranch as string } : {}),
		...(str(task.previousTaskId) ? { previousTaskId: task.previousTaskId as string } : {}),
		...(num(task.iteration) !== undefined ? { iteration: task.iteration as number } : {}),
		...(num(task.restarts) ? { restarts: task.restarts as number } : {}),
	};
}
