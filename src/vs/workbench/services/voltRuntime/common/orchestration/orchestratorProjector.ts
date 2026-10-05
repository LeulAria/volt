/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOrchState, IOrchTask, IOrchThread, OrchEvent } from './orchestrator.js';

/**
 * Folds one event into the state. Pure and total: an event about an unknown thread or task is a
 * no-op, never a throw, so a log that lost a record (or a root that was pruned) still loads.
 * Unchanged threads and tasks keep their identity, so views can compare by reference.
 */
export function applyOrchEvent(state: IOrchState, event: OrchEvent): IOrchState {
	switch (event.type) {
		case 'thread.created':
			if (state.threads[event.thread.id]) {
				return state;
			}
			return withThread(state, event.thread);
		case 'thread.updated':
			return updateThread(state, event.threadId, thread => ({
				...thread,
				...(event.title !== undefined ? { title: event.title } : {}),
				...(event.modelRef !== undefined ? { modelRef: event.modelRef } : {}),
				...(event.modelLabel !== undefined ? { modelLabel: event.modelLabel } : {}),
			}));
		case 'thread.blocked':
			return updateThread(state, event.threadId, thread => {
				const { blocked: _blocked, ...rest } = thread;
				return event.reason ? { ...rest, blocked: event.reason } : rest;
			});
		case 'thread.forgotten': {
			if (!state.threads[event.threadId]) {
				return state;
			}
			const threads = { ...state.threads };
			delete threads[event.threadId];
			return { ...state, threads };
		}
		case 'queue.added':
			return updateThread(state, event.threadId, thread => thread.queue.some(item => item.id === event.item.id)
				? thread
				: { ...thread, queue: event.head ? [event.item, ...thread.queue] : [...thread.queue, event.item] });
		case 'queue.removed':
			return updateThread(state, event.threadId, thread => thread.queue.some(item => item.id === event.itemId)
				? { ...thread, queue: thread.queue.filter(item => item.id !== event.itemId) }
				: thread);
		case 'queue.reordered':
			return updateThread(state, event.threadId, thread => {
				const byId = new Map(thread.queue.map(item => [item.id, item]));
				const queue = event.ids.map(id => byId.get(id)).filter(item => item !== undefined);
				for (const item of thread.queue) {
					if (!event.ids.includes(item.id)) {
						queue.push(item);
					}
				}
				return { ...thread, queue };
			});
		case 'queue.updated':
			return updateThread(state, event.threadId, thread => ({
				...thread,
				queue: thread.queue.map(item => {
					if (item.id !== event.itemId) {
						return item;
					}
					const { held: _held, ...rest } = item;
					const held = event.held ?? item.held;
					return { ...rest, ...(event.prompt ? { prompt: event.prompt } : {}), ...(held ? { held: true } : {}) };
				}),
			}));
		case 'queue.paused':
			return updateThread(state, event.threadId, thread => thread.pause === event.reason ? thread : { ...thread, pause: event.reason });
		case 'queue.resumed':
			return updateThread(state, event.threadId, thread => {
				if (!thread.pause && !thread.wakeups) {
					return thread;
				}
				const { pause: _pause, wakeups: _wakeups, ...rest } = thread;
				return rest;
			});
		case 'turn.dispatched':
			return updateThread(state, event.threadId, thread => {
				const { pause: _pause, wakeups: _wakeups, ...rest } = thread;
				const automatic = event.turn.kind === 'notification';
				const wakeups = automatic ? (thread.wakeups ?? 0) + 1 : event.turn.kind === 'external' ? thread.wakeups : 0;
				return { ...rest, active: event.turn, turns: thread.turns + 1, ...(wakeups ? { wakeups } : {}) };
			});
		case 'turn.steered':
			return state;
		case 'turn.bound':
			return updateThread(state, event.threadId, thread => thread.active?.id === event.turnId
				? { ...thread, active: { ...thread.active, runId: event.runId, phase: thread.active.phase === 'cancelling' ? 'cancelling' : 'running', ...(event.steerable ? { steerable: true } : {}) } }
				: thread);
		case 'turn.cancelling':
			return updateThread(state, event.threadId, thread => thread.active?.id === event.turnId
				? { ...thread, active: { ...thread.active, phase: 'cancelling' } }
				: thread);
		case 'turn.settled':
			return updateThread(state, event.threadId, thread => {
				if (thread.active?.id !== event.turnId) {
					return thread;
				}
				const { active, ...rest } = thread;
				return {
					...rest,
					inputs: [],
					last: { turnId: active.id, kind: active.kind, outcome: event.outcome, at: event.at, ...(event.error ? { error: event.error } : {}) },
				};
			});
		case 'input.opened':
			return updateThread(state, event.threadId, thread => thread.inputs.some(input => input.id === event.input.id)
				? thread
				: { ...thread, inputs: [...thread.inputs, event.input] });
		case 'input.closed':
			return updateThread(state, event.threadId, thread => thread.inputs.some(input => input.id === event.inputId)
				? { ...thread, inputs: thread.inputs.filter(input => input.id !== event.inputId) }
				: thread);
		case 'task.created':
			if (state.tasks[event.task.id]) {
				return state;
			}
			return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
		case 'task.started':
			return updateTask(state, event.taskId, task => ({ ...task, state: 'running', startedAt: event.at }));
		case 'task.resumed':
			// Another round waits for a slot like a new task; `task.started` restarts its clock.
			return updateTask(state, event.taskId, task => {
				const { result: _result, error: _error, endedAt: _endedAt, waitingOn: _waitingOn, startedAt: _startedAt, ...rest } = task;
				return { ...rest, state: 'queued', rounds: task.rounds + 1, delivery: 'none' };
			});
		case 'task.updated':
			return updateTask(state, event.taskId, task => ({
				...task,
				...(event.activity !== undefined ? { activity: event.activity } : {}),
				...(event.steps !== undefined ? { steps: event.steps } : {}),
				...(event.files !== undefined ? { files: mergeFiles(task.files, event.files) } : {}),
				...(event.title !== undefined ? { title: event.title } : {}),
				...(event.kind !== undefined ? { kind: event.kind } : {}),
				...(event.modelLabel !== undefined ? { modelLabel: event.modelLabel } : {}),
				...(event.worktreePath !== undefined ? { worktreePath: event.worktreePath } : {}),
				...(event.worktreeBranch !== undefined ? { worktreeBranch: event.worktreeBranch } : {}),
			}));
		case 'task.waiting':
			return updateTask(state, event.taskId, task => {
				if (task.state !== 'running' && task.state !== 'waiting') {
					return task;
				}
				const { waitingOn: _waitingOn, ...rest } = task;
				return event.on ? { ...rest, state: 'waiting', waitingOn: event.on } : { ...rest, state: 'running' };
			});
		case 'task.settled':
			return updateTask(state, event.taskId, task => {
				const { waitingOn: _waitingOn, ...rest } = task;
				return {
					...rest,
					state: event.state,
					endedAt: event.at,
					...(event.result !== undefined ? { result: event.result } : {}),
					...(event.error !== undefined ? { error: event.error } : {}),
					// Harness subagents report inside the parent's own turn; only Volt tasks wake their parent.
					delivery: task.source === 'volt' && event.state !== 'cancelled' ? 'pending' : 'none',
				};
			});
		case 'task.delivery': {
			let next = state;
			for (const id of event.taskIds) {
				next = updateTask(next, id, task => task.delivery === event.delivery ? task : { ...task, delivery: event.delivery });
			}
			return next;
		}
		case 'task.pruned': {
			if (!event.taskIds.some(id => state.tasks[id])) {
				return state;
			}
			const tasks = { ...state.tasks };
			for (const id of event.taskIds) {
				delete tasks[id];
			}
			return { ...state, tasks };
		}
		case 'handoff.requested':
			return updateThread(state, event.threadId, thread => ({ ...thread, pendingHandoff: event.handoff }));
		case 'handoff.applied':
			return updateThread(state, event.threadId, thread => {
				const { pendingHandoff: _pending, ...rest } = thread;
				return {
					...rest,
					modelRef: event.handoff.to,
					modelLabel: event.handoff.toLabel,
					handoffs: [...thread.handoffs, event.handoff],
					// Prompts queued for the old model follow the chat to the new one.
					queue: thread.queue.map(item => item.prompt.modelRef && item.prompt.modelRef !== event.handoff.to
						? { ...item, prompt: { ...item.prompt, modelRef: event.handoff.to } }
						: item),
				};
			});
		case 'conflict.detected': {
			const list = state.conflicts[event.rootId] ?? [];
			const existing = list.findIndex(conflict => conflict.path === event.conflict.path);
			const next = existing >= 0 ? list.map((conflict, index) => index === existing ? event.conflict : conflict) : [...list, event.conflict];
			return { ...state, conflicts: { ...state.conflicts, [event.rootId]: next } };
		}
		case 'conflict.cleared': {
			const list = state.conflicts[event.rootId];
			if (!list?.some(conflict => conflict.path === event.path)) {
				return state;
			}
			const next = list.filter(conflict => conflict.path !== event.path);
			const conflicts = { ...state.conflicts };
			if (next.length) {
				conflicts[event.rootId] = next;
			} else {
				delete conflicts[event.rootId];
			}
			return { ...state, conflicts };
		}
	}
}

export function applyOrchEvents(state: IOrchState, events: readonly OrchEvent[]): IOrchState {
	let next = state;
	for (const event of events) {
		next = applyOrchEvent(next, event);
	}
	return next;
}

function withThread(state: IOrchState, thread: IOrchThread): IOrchState {
	return { ...state, threads: { ...state.threads, [thread.id]: thread } };
}

function updateThread(state: IOrchState, threadId: string, update: (thread: IOrchThread) => IOrchThread): IOrchState {
	const thread = state.threads[threadId];
	if (!thread) {
		return state;
	}
	const next = update(thread);
	return next === thread ? state : withThread(state, next);
}

function updateTask(state: IOrchState, taskId: string, update: (task: IOrchTask) => IOrchTask): IOrchState {
	const task = state.tasks[taskId];
	if (!task) {
		return state;
	}
	const next = update(task);
	return next === task ? state : { ...state, tasks: { ...state.tasks, [taskId]: next } };
}

const MAX_TASK_FILES = 200;

function mergeFiles(current: readonly string[], added: readonly string[]): readonly string[] {
	const fresh = added.filter(path => !current.includes(path));
	if (!fresh.length) {
		return current;
	}
	const merged = [...current, ...fresh];
	return merged.length > MAX_TASK_FILES ? merged.slice(merged.length - MAX_TASK_FILES) : merged;
}
