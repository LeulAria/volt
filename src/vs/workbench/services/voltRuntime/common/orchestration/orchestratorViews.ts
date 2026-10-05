/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLiveTaskState, isTerminalTaskState } from './agentTasks.js';
import { IOrchQueueItem, IOrchState, IOrchTask, IOrchThread, nextQueued, OrchPause } from './orchestrator.js';

/**
 * Read models the UI draws from orchestration state. One status per chat, derived the same way
 * everywhere (sidebar, title bar, composer), so "working", "waiting", "queued" and "done" never
 * disagree between surfaces.
 */

/**
 * - `working`: a turn is running. `starting`: it was sent and the agent has not answered yet.
 * - `needsInput`: the running turn waits for an approval or an answer.
 * - `delegating`: no turn runs, but subagents this chat started still work.
 * - `queued`: idle for a moment with prompts about to be sent.
 * - `paused`: prompts or subagent reports wait for the user (after an error or a restart).
 * - `blocked`: the chat cannot run yet (its project is cloning, its worktree is being made).
 */
export type OrchThreadStatusKind = 'idle' | 'starting' | 'working' | 'stopping' | 'needsInput' | 'delegating' | 'queued' | 'paused' | 'blocked' | 'failed' | 'interrupted';

export interface IOrchThreadStatus {
	readonly kind: OrchThreadStatusKind;
	/** Subagents of this chat that are running or waiting. */
	readonly running: number;
	/** Subagents blocked on the user. */
	readonly waiting: number;
	readonly queued: number;
	readonly pause?: OrchPause;
	/** Subagent reports the chat has not received yet. */
	readonly undelivered: number;
	/** A turn is live: the composer shows Stop. Subagents alone do not make a chat busy. */
	readonly busy: boolean;
}

export function threadStatus(state: IOrchState, threadId: string): IOrchThreadStatus {
	const thread = state.threads[threadId];
	const children = thread ? childTasks(state, thread.id) : [];
	const running = children.filter(task => isLiveTaskState(task.state)).length;
	const waiting = children.filter(task => task.state === 'waiting').length;
	const undelivered = children.filter(task => task.delivery === 'pending').length;
	const queued = thread?.queue.length ?? 0;
	const base = { running, waiting, queued, undelivered, ...(thread?.pause ? { pause: thread.pause } : {}) };
	if (!thread) {
		return { ...base, kind: 'idle', busy: false };
	}
	const active = thread.active;
	if (active) {
		const kind: OrchThreadStatusKind = thread.inputs.length ? 'needsInput'
			: active.phase === 'cancelling' ? 'stopping'
				: active.phase === 'dispatching' ? 'starting'
					: 'working';
		return { ...base, kind, busy: true };
	}
	if (thread.blocked) {
		return { ...base, kind: 'blocked', busy: queued > 0 };
	}
	if (thread.pause === 'interrupted' && (queued || undelivered || thread.last?.outcome === 'interrupted')) {
		return { ...base, kind: 'interrupted', busy: false };
	}
	if (thread.pause && (queued || undelivered)) {
		return { ...base, kind: 'paused', busy: false };
	}
	if (queued && nextQueued(thread)) {
		return { ...base, kind: 'queued', busy: false };
	}
	if (running) {
		return { ...base, kind: 'delegating', busy: false };
	}
	if (thread.last?.outcome === 'failed') {
		return { ...base, kind: 'failed', busy: false };
	}
	if (thread.last?.outcome === 'interrupted') {
		return { ...base, kind: 'interrupted', busy: false };
	}
	return { ...base, kind: 'idle', busy: false };
}

export function childTasks(state: IOrchState, threadId: string): IOrchTask[] {
	return Object.values(state.tasks).filter(task => task.parentId === threadId).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Every task under a root, depth first in start order. */
export function rootTasks(state: IOrchState, rootId: string): IOrchTask[] {
	return Object.values(state.tasks).filter(task => task.rootId === rootId).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

//#region Subagent rows

export type OrchAgentRowState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** One subagent as the composer card, the transcript and the sidebar draw it. */
export interface IOrchAgentRow {
	readonly taskId: string;
	readonly source: IOrchTask['source'];
	readonly title: string;
	readonly modelLabel?: string;
	readonly modelRef?: string;
	readonly kind?: string;
	readonly state: OrchAgentRowState;
	/** "Running", "Waiting for you", "Done", ... */
	readonly stateLabel: string;
	/** The step it is on, or how it ended. */
	readonly detail?: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly childId?: string;
	readonly parentId: string;
	readonly depth: number;
	readonly error?: string;
	readonly files: number;
	/** Volt subagents the user can stop on their own; harness ones stop with their turn. */
	readonly cancellable: boolean;
	/** Has a chat to open (Volt subagents). */
	readonly openable: boolean;
	/** Started by the Multitask composer (the user), not by an agent. */
	readonly multitask: boolean;
}

export function agentRow(task: IOrchTask): IOrchAgentRow {
	return {
		taskId: task.id,
		source: task.source,
		title: task.title,
		...(task.modelLabel ? { modelLabel: task.modelLabel } : {}),
		...(task.modelRef ? { modelRef: task.modelRef } : {}),
		...(task.kind ? { kind: task.kind } : {}),
		state: task.state,
		stateLabel: taskStateLabel(task),
		...(rowDetail(task) ? { detail: rowDetail(task) } : {}),
		...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
		...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
		...(task.childId ? { childId: task.childId } : {}),
		parentId: task.parentId,
		depth: task.depth,
		...(task.error ? { error: task.error } : {}),
		files: task.files.length,
		cancellable: task.source === 'volt' && isLiveTaskState(task.state),
		openable: !!task.childId,
		multitask: task.origin === 'user',
	};
}

export function taskStateLabel(task: Pick<IOrchTask, 'state' | 'waitingOn'>): string {
	switch (task.state) {
		case 'queued': return 'Queued';
		case 'running': return 'Running';
		case 'waiting': return task.waitingOn === 'approval' ? 'Needs approval' : 'Needs input';
		case 'completed': return 'Done';
		case 'failed': return 'Failed';
		case 'cancelled': return 'Stopped';
		case 'interrupted': return 'Interrupted';
	}
}

function rowDetail(task: IOrchTask): string | undefined {
	if (task.state === 'failed') {
		return firstLine(task.error) ?? 'Failed';
	}
	if (task.state === 'interrupted') {
		return 'Volt restarted while it ran';
	}
	if (task.state === 'queued') {
		return 'Waiting for a free slot';
	}
	if (isTerminalTaskState(task.state)) {
		return firstLine(task.result) ?? task.activity;
	}
	return task.activity;
}

function firstLine(text: string | undefined): string | undefined {
	const line = text?.split('\n').map(part => part.trim()).find(Boolean);
	if (!line) {
		return undefined;
	}
	const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '');
	return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain;
}

//#endregion

//#region Composer card

export interface IOrchDockModel {
	readonly agents: readonly IOrchAgentRow[];
	/** Live first, then the finished ones of the current batch. */
	readonly running: number;
	readonly waiting: number;
	readonly failed: number;
	readonly queue: readonly IOrchQueueItem[];
	readonly pause?: OrchPause;
	readonly conflicts: readonly { readonly path: string; readonly titles: readonly string[] }[];
}

/**
 * What the card above the composer shows: this chat's subagents (live ones, plus the finished ones
 * from the latest batch so a result does not vanish the moment it lands) and its queue.
 */
export function dockModel(state: IOrchState, threadId: string): IOrchDockModel {
	const thread = state.threads[threadId];
	const tasks = thread ? childTasks(state, thread.id) : [];
	const live = tasks.filter(task => isLiveTaskState(task.state));
	// Finished subagents stay listed while any sibling of their batch still runs or their report is not in yet.
	const batchStart = live.length ? Math.min(...live.map(task => task.createdAt)) : undefined;
	const shown = tasks.filter(task => isLiveTaskState(task.state)
		|| task.delivery === 'pending'
		|| (batchStart !== undefined && task.createdAt >= batchStart)
		|| (thread?.active && (task.parentTurnId === thread.active.id || thread.active.taskIds?.includes(task.id))));
	const conflicts = thread ? (state.conflicts[thread.rootId] ?? []).map(conflict => ({
		path: conflict.path,
		titles: conflict.taskIds.map(id => state.tasks[id]?.title ?? state.threads[id]?.title ?? 'This chat'),
	})) : [];
	return {
		agents: shown.map(agentRow),
		running: live.length,
		waiting: live.filter(task => task.state === 'waiting').length,
		failed: shown.filter(task => task.state === 'failed').length,
		queue: thread?.queue ?? [],
		...(thread?.pause ? { pause: thread.pause } : {}),
		conflicts,
	};
}

//#endregion

//#region Lineage (the dock beside the chat)

export interface IOrchLineage {
	/** The chat that delegated to this one, when this is a subagent's chat. */
	readonly parent?: { readonly threadId: string; readonly title?: string; readonly status: IOrchThreadStatus };
	/** Live subagents anywhere under this chat's root. */
	readonly running: readonly IOrchAgentRow[];
	/** Finished ones, newest first. */
	readonly previous: readonly IOrchAgentRow[];
}

export function lineage(state: IOrchState, threadId: string): IOrchLineage {
	const thread = state.threads[threadId];
	if (!thread) {
		return { running: [], previous: [] };
	}
	const tasks = rootTasks(state, thread.rootId).filter(task => task.childId !== thread.id);
	const parent = thread.parentId ? state.threads[thread.parentId] : undefined;
	return {
		...(parent ? { parent: { threadId: parent.id, ...(parent.title ? { title: parent.title } : {}), status: threadStatus(state, parent.id) } } : {}),
		running: tasks.filter(task => isLiveTaskState(task.state)).map(agentRow),
		previous: tasks.filter(task => isTerminalTaskState(task.state)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).map(agentRow),
	};
}

//#endregion

/** "40s", "1m 14s", "6m 07s", "1h 02m": the clock T3 and Cursor show beside a subagent. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function rowElapsed(row: Pick<IOrchAgentRow, 'startedAt' | 'endedAt'>, now: number): string | undefined {
	return row.startedAt === undefined ? undefined : formatElapsed((row.endedAt ?? now) - row.startedAt);
}

/** Threads whose status label changed between two states (for sidebar refreshes). */
export function changedThreadIds(before: IOrchState, after: IOrchState): string[] {
	const ids = new Set<string>();
	for (const [id, thread] of Object.entries(after.threads)) {
		if (before.threads[id] !== thread) {
			ids.add(id);
		}
	}
	for (const id of Object.keys(before.threads)) {
		if (!after.threads[id]) {
			ids.add(id);
		}
	}
	for (const [id, task] of Object.entries(after.tasks)) {
		if (before.tasks[id] !== task) {
			ids.add(task.parentId);
			if (task.childId) {
				ids.add(task.childId);
			}
		}
	}
	return [...ids];
}

export function isOrchThreadIdle(thread: IOrchThread | undefined): boolean {
	return !thread?.active;
}
