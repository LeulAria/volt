/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildTaskNotification, isLiveTaskState, isTerminalTaskState, taskNotificationDisplay } from './agentTasks.js';
import { DEFAULT_ORCH_LIMITS, IOrchEventEnvelope, IOrchLimits, IOrchPrompt, IOrchQueueItem, IOrchState, IOrchTask, IOrchThread, IOrchTurn, OrchCommand, OrchEffect, OrchEvent, OrchOutcome, OrchRestartResume, OrchTaskState, nextQueued } from './orchestrator.js';
import { applyOrchEvent, applyOrchEvents } from './orchestratorProjector.js';

/**
 * The decider: command + state -> events, and the scheduler that runs after every command. Both
 * are pure. Nothing here reads a clock (commands carry `at`) or generates ids from randomness
 * (callers pick ids; derived ids come from the state's sequence), so the same log always replays
 * to the same state and the chaos tests can compare runs.
 */

export interface IOrchDecision {
	readonly events: readonly OrchEvent[];
	/** The command was refused; nothing changed. Callers turn this into a tool error or a notice. */
	readonly rejected?: string;
	/** Submit: what happened to the prompt. */
	readonly outcome?: 'started' | 'queued' | 'steered' | 'duplicate';
	/** Spawn: the task that serves the request (a new one, or an existing one it matched). */
	readonly taskId?: string;
	readonly reused?: boolean;
}

export interface IOrchStep {
	readonly state: IOrchState;
	readonly envelopes: readonly IOrchEventEnvelope[];
	readonly effects: readonly OrchEffect[];
	readonly decision: IOrchDecision;
}

/** Decide, apply, schedule, derive effects: one command end to end. */
export function runOrchCommand(state: IOrchState, command: OrchCommand, limits: IOrchLimits = DEFAULT_ORCH_LIMITS): IOrchStep {
	if (state.receipts.includes(command.id)) {
		return { state, envelopes: [], effects: [], decision: { events: [], outcome: 'duplicate' } };
	}
	const decision = decideOrch(state, command, limits);
	if (decision.rejected) {
		// A refusal is an answer too: the same command retried is not decided again.
		return { state: { ...state, receipts: boundedReceipts(state.receipts, command.id, limits) }, envelopes: [], effects: [], decision };
	}
	let next = applyOrchEvents(state, decision.events);
	const scheduled = scheduleOrch(next, command.at, limits);
	next = applyOrchEvents(next, scheduled);
	const events = [...decision.events, ...scheduled];
	const envelopes: IOrchEventEnvelope[] = events.map((event, index) => ({ seq: state.seq + index + 1, at: command.at, commandId: command.id, event }));
	next = { ...next, seq: state.seq + events.length, receipts: boundedReceipts(next.receipts, command.id, limits) };
	return { state: next, envelopes, effects: effectsFor(events, next), decision: { ...decision, events } };
}

function boundedReceipts(receipts: readonly string[], id: string, limits: IOrchLimits): readonly string[] {
	const next = [...receipts, id];
	return next.length > limits.receipts ? next.slice(next.length - limits.receipts) : next;
}

//#region Decide

export function decideOrch(state: IOrchState, command: OrchCommand, limits: IOrchLimits = DEFAULT_ORCH_LIMITS): IOrchDecision {
	switch (command.type) {
		case 'thread.upsert': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				const parent = command.parentId ? state.threads[command.parentId] : undefined;
				return { events: [{ type: 'thread.created', thread: newThread(command.threadId, command.at, parent, { title: command.title, modelRef: command.modelRef, modelLabel: command.modelLabel }) }] };
			}
			const changed = (command.title !== undefined && command.title !== thread.title)
				|| (command.modelRef !== undefined && command.modelRef !== thread.modelRef)
				|| (command.modelLabel !== undefined && command.modelLabel !== thread.modelLabel);
			return {
				events: changed ? [{
					type: 'thread.updated',
					threadId: thread.id,
					...(command.title !== undefined ? { title: command.title } : {}),
					...(command.modelRef !== undefined ? { modelRef: command.modelRef } : {}),
					...(command.modelLabel !== undefined ? { modelLabel: command.modelLabel } : {}),
				}] : [],
			};
		}
		case 'thread.submit':
			return decideSubmit(state, command.threadId, { id: command.turnId, prompt: command.prompt, at: command.at }, command.delivery, !!command.canSteer);
		case 'thread.notify':
			return decideNotify(state, command.threadId, { id: command.turnId, prompt: command.prompt, at: command.at, kind: 'notification' }, limits, !!command.interrupt);
		case 'thread.block': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return command.reason ? { events: [{ type: 'thread.created', thread: { ...newThread(command.threadId, command.at, undefined, {}), blocked: command.reason } }] } : { events: [] };
			}
			return thread.blocked === command.reason ? { events: [] } : { events: [{ type: 'thread.blocked', threadId: thread.id, reason: command.reason }] };
		}
		case 'thread.forget': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [] };
			}
			if (thread.active || thread.queue.length || liveChildren(state, thread.id).length) {
				return { events: [], rejected: 'The chat is still working.' };
			}
			return { events: [{ type: 'thread.forgotten', threadId: thread.id }] };
		}
		case 'queue.remove': {
			const thread = state.threads[command.threadId];
			return thread?.queue.some(item => item.id === command.itemId)
				? { events: [{ type: 'queue.removed', threadId: thread.id, itemId: command.itemId, reason: 'user' }] }
				: { events: [] };
		}
		case 'queue.reorder': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [] };
			}
			const ids = command.ids.filter((id, index) => command.ids.indexOf(id) === index && thread.queue.some(item => item.id === id));
			const current = thread.queue.map(item => item.id);
			const changed = ids.some((id, index) => current[index] !== id);
			return changed ? { events: [{ type: 'queue.reordered', threadId: thread.id, ids }] } : { events: [] };
		}
		case 'queue.update': {
			const thread = state.threads[command.threadId];
			return thread?.queue.some(item => item.id === command.itemId)
				? { events: [{ type: 'queue.updated', threadId: thread.id, itemId: command.itemId, prompt: command.prompt, held: false }] }
				: { events: [] };
		}
		case 'queue.hold': {
			const thread = state.threads[command.threadId];
			const item = thread?.queue.find(candidate => candidate.id === command.itemId);
			return thread && item && !!item.held !== command.held
				? { events: [{ type: 'queue.updated', threadId: thread.id, itemId: item.id, held: command.held }] }
				: { events: [] };
		}
		case 'queue.clear': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [] };
			}
			const events: OrchEvent[] = [];
			for (const item of thread.queue) {
				events.push({ type: 'queue.removed', threadId: thread.id, itemId: item.id, reason: 'cleared' });
			}
			return { events };
		}
		case 'queue.sendNow': {
			const thread = state.threads[command.threadId];
			const item = thread?.queue.find(candidate => candidate.id === command.itemId);
			if (!thread || !item) {
				return { events: [] };
			}
			const removed: OrchEvent = { type: 'queue.removed', threadId: thread.id, itemId: item.id, reason: 'dispatched' };
			const after = applyOrchEvent(state, removed);
			const rest = decideSubmit(after, thread.id, { id: item.id, prompt: item.prompt, at: command.at, kind: item.kind }, 'now', !!command.canSteer);
			return { ...rest, events: [removed, ...rest.events] };
		}
		case 'queue.resume': {
			const thread = state.threads[command.threadId];
			if (!thread?.pause) {
				return { events: [] };
			}
			const events: OrchEvent[] = [{ type: 'queue.resumed', threadId: thread.id }];
			// Resuming a stopped or failed subagent's chat with follow-ups waiting continues the task.
			const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
			if (task && isTerminalTaskState(task.state) && nextQueued(thread)) {
				events.push({ type: 'task.resumed', taskId: task.id, at: command.at });
			}
			return { events };
		}
		case 'queue.pause': {
			const thread = state.threads[command.threadId];
			return thread && thread.pause !== command.reason ? { events: [{ type: 'queue.paused', threadId: thread.id, reason: command.reason }] } : { events: [] };
		}
		case 'turn.cancel':
			return decideCancel(state, command.threadId, command.cascade, command.at);
		case 'turn.resume': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [] };
			}
			if (thread.active) {
				return { events: [{ type: 'queue.added', threadId: thread.id, item: { id: command.turnId, prompt: command.prompt, at: command.at, kind: 'resume' }, head: true }] };
			}
			return { events: [dispatch(thread.id, { id: command.turnId, kind: 'resume', prompt: command.prompt, at: command.at })], outcome: 'started' };
		}
		case 'run.started':
			return decideRunStarted(state, command.threadId, command.runId, command.turnId, command.at, !!command.steerable);
		case 'steer.failed': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [] };
			}
			if (command.taskIds?.length) {
				const ids = command.taskIds.filter(id => state.tasks[id]?.delivery === 'delivered');
				return { events: ids.length ? [{ type: 'task.delivery', taskIds: ids, delivery: 'pending' }] : [] };
			}
			if (thread.queue.some(item => item.id === command.steerId) || thread.active?.id === command.steerId) {
				return { events: [] };
			}
			return { events: [{ type: 'queue.added', threadId: thread.id, item: { id: command.steerId, prompt: command.prompt, at: command.at }, head: true }] };
		}
		case 'run.settled':
			return decideRunSettled(state, command.threadId, { runId: command.runId, turnId: command.turnId }, command.outcome, command.at, command.error, command.reply);
		case 'dispatch.failed': {
			const thread = state.threads[command.threadId];
			if (!thread?.active || thread.active.id !== command.turnId) {
				return { events: [] };
			}
			return decideRunSettled(state, thread.id, { turnId: command.turnId }, 'failed', command.at, command.error, undefined);
		}
		case 'input.opened': {
			const thread = state.threads[command.threadId];
			if (!thread || thread.inputs.some(input => input.id === command.inputId)) {
				return { events: [] };
			}
			const events: OrchEvent[] = [{ type: 'input.opened', threadId: thread.id, input: { id: command.inputId, kind: command.kind, at: command.at } }];
			const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
			if (task && isLiveTaskState(task.state)) {
				events.push({ type: 'task.waiting', taskId: task.id, on: command.kind });
			}
			return { events };
		}
		case 'input.closed': {
			const thread = state.threads[command.threadId];
			if (!thread?.inputs.some(input => input.id === command.inputId)) {
				return { events: [] };
			}
			const events: OrchEvent[] = [{ type: 'input.closed', threadId: thread.id, inputId: command.inputId }];
			const rest = thread.inputs.filter(input => input.id !== command.inputId);
			const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
			if (task?.state === 'waiting') {
				events.push({ type: 'task.waiting', taskId: task.id, on: rest.at(-1)?.kind });
			}
			return { events };
		}
		case 'task.spawn':
			return decideSpawn(state, command, limits);
		case 'task.cancel':
			return decideTaskCancel(state, command.taskId, command.at, command.reason);
		case 'task.message': {
			const task = state.tasks[command.taskId];
			if (!task) {
				return { events: [], rejected: `No task ${command.taskId}.` };
			}
			if (task.source !== 'volt' || !task.childId || !state.threads[task.childId]) {
				return { events: [], rejected: 'This subagent belongs to the agent\'s own harness; Volt cannot send it messages.' };
			}
			const item: IOrchQueueItem = { id: command.turnId, prompt: command.prompt, at: command.at, kind: 'followup' };
			const events: OrchEvent[] = [];
			if (isTerminalTaskState(task.state)) {
				events.push({ type: 'task.resumed', taskId: task.id, at: command.at });
				const child = state.threads[task.childId];
				if (child.pause) {
					events.push({ type: 'queue.resumed', threadId: child.id });
				}
			}
			events.push({ type: 'queue.added', threadId: task.childId, item });
			return { events, taskId: task.id };
		}
		case 'task.ack': {
			const ids = command.taskIds.filter(id => {
				const task = state.tasks[id];
				return task && isTerminalTaskState(task.state) && (task.delivery === 'pending' || task.delivery === 'none') && task.source === 'volt';
			});
			return { events: ids.length ? [{ type: 'task.delivery', taskIds: ids, delivery: 'acknowledged' }] : [] };
		}
		case 'task.progress': {
			const task = state.tasks[command.taskId];
			if (!task || isTerminalTaskState(task.state)) {
				return { events: [] };
			}
			const files = command.files?.filter(path => !task.files.includes(path));
			const activity = command.activity !== undefined && command.activity !== task.activity ? command.activity : undefined;
			const steps = command.steps !== undefined && command.steps !== task.steps ? command.steps : undefined;
			if (activity === undefined && steps === undefined && !files?.length) {
				return { events: [] };
			}
			return {
				events: [{
					type: 'task.updated',
					taskId: task.id,
					...(activity !== undefined ? { activity } : {}),
					...(steps !== undefined ? { steps } : {}),
					...(files?.length ? { files } : {}),
				}],
			};
		}
		case 'task.worktree': {
			const task = state.tasks[command.taskId];
			if (!task) {
				return { events: [] };
			}
			const events: OrchEvent[] = [{ type: 'task.updated', taskId: task.id, worktreePath: command.path, worktreeBranch: command.branch }];
			const child = task.childId ? state.threads[task.childId] : undefined;
			if (child?.blocked === WORKTREE_BLOCK) {
				events.push({ type: 'thread.blocked', threadId: child.id, reason: undefined });
			}
			return { events };
		}
		case 'task.error': {
			const task = state.tasks[command.taskId];
			if (!task) {
				return { events: [] };
			}
			const events: OrchEvent[] = [];
			const child = task.childId ? state.threads[task.childId] : undefined;
			if (isTerminalTaskState(task.state)) {
				// Its worktree failed after the task ended (stopped, restarted): the chat must not wait for
				// that checkout forever, and follow-ups queued for it would run without it.
				if (child?.blocked === WORKTREE_BLOCK) {
					for (const item of child.queue) {
						events.push({ type: 'queue.removed', threadId: child.id, itemId: item.id, reason: 'cleared' });
					}
					events.push({ type: 'thread.blocked', threadId: child.id, reason: undefined });
				}
				return { events };
			}
			if (child?.blocked === WORKTREE_BLOCK) {
				events.push({ type: 'thread.blocked', threadId: child.id, reason: undefined });
			}
			if (child?.active && child.active.phase !== 'cancelling') {
				events.push({ type: 'turn.cancelling', threadId: child.id, turnId: child.active.id });
			}
			for (const item of child?.queue ?? []) {
				events.push({ type: 'queue.removed', threadId: child!.id, itemId: item.id, reason: 'cleared' });
			}
			events.push({ type: 'task.settled', taskId: task.id, state: 'failed', at: command.at, error: command.error });
			return { events };
		}
		case 'harness.started': {
			const thread = state.threads[command.threadId];
			if (!thread?.active) {
				return { events: [] };
			}
			const id = harnessTaskId(command.toolCallId);
			const existing = state.tasks[id];
			if (existing) {
				const title = command.title && command.title !== existing.title ? command.title : undefined;
				const kind = command.kind && command.kind !== existing.kind ? command.kind : undefined;
				return { events: title || kind ? [{ type: 'task.updated', taskId: id, ...(title ? { title } : {}), ...(kind ? { kind } : {}) }] : [] };
			}
			const task: IOrchTask = {
				id,
				source: 'harness',
				parentId: thread.id,
				rootId: thread.rootId,
				parentTurnId: thread.active.id,
				toolCallId: command.toolCallId,
				title: command.title,
				...(command.kind ? { kind: command.kind } : {}),
				role: 'general',
				origin: 'agent',
				brief: command.brief ?? '',
				...(command.modelLabel ? { modelLabel: command.modelLabel } : thread.modelLabel ? { modelLabel: thread.modelLabel } : {}),
				...(thread.modelRef ? { modelRef: thread.modelRef } : {}),
				isolation: 'shared',
				depth: thread.depth + 1,
				createdAt: command.at,
				state: 'running',
				startedAt: command.at,
				steps: 0,
				files: [],
				delivery: 'none',
				rounds: 1,
			};
			return { events: [{ type: 'task.created', task }], taskId: id };
		}
		case 'harness.progress': {
			const task = state.tasks[harnessTaskId(command.toolCallId)];
			if (!task || isTerminalTaskState(task.state)) {
				return { events: [] };
			}
			const activity = command.activity?.trim() && command.activity.trim() !== task.activity ? command.activity.trim() : undefined;
			const title = command.title && command.title !== task.title ? command.title : undefined;
			const kind = command.kind && command.kind !== task.kind ? command.kind : undefined;
			const modelLabel = command.modelLabel && command.modelLabel !== task.modelLabel ? command.modelLabel : undefined;
			if (!activity && !title && !kind && !modelLabel) {
				return { events: [] };
			}
			return {
				events: [{
					type: 'task.updated',
					taskId: task.id,
					...(activity ? { activity, steps: task.steps + 1 } : {}),
					...(title ? { title } : {}),
					...(kind ? { kind } : {}),
					...(modelLabel ? { modelLabel } : {}),
				}],
			};
		}
		case 'harness.ended': {
			const task = state.tasks[harnessTaskId(command.toolCallId)];
			if (!task || isTerminalTaskState(task.state)) {
				return { events: [] };
			}
			return {
				events: [{
					type: 'task.settled',
					taskId: task.id,
					state: command.ok ? 'completed' : 'failed',
					at: command.at,
					...(command.result !== undefined ? { result: command.result } : {}),
					...(command.error !== undefined ? { error: command.error } : {}),
				}],
			};
		}
		case 'file.changed':
			return decideFileChanged(state, command.threadId, command.path, command.at);
		case 'thread.handoff': {
			const thread = state.threads[command.threadId];
			if (!thread) {
				return { events: [], rejected: 'Unknown chat.' };
			}
			if (thread.modelRef === command.to && !thread.pendingHandoff) {
				return { events: [] };
			}
			const handoff = {
				...(thread.modelRef ? { from: thread.modelRef } : {}),
				...(thread.modelLabel ? { fromLabel: thread.modelLabel } : {}),
				to: command.to,
				toLabel: command.toLabel,
				at: command.at,
				by: command.by,
				...(command.reason ? { reason: command.reason } : {}),
				...(command.brief ? { brief: command.brief } : {}),
			};
			return { events: [thread.active ? { type: 'handoff.requested', threadId: thread.id, handoff } : { type: 'handoff.applied', threadId: thread.id, handoff }] };
		}
		case 'recover':
			return decideRecover(state, command.at, command.resume ?? 'off', limits);
	}
}

const WORKTREE_BLOCK = 'worktree';

/** Harness subagents are keyed by their Task call so a retried update finds the same row. */
export function harnessTaskId(toolCallId: string): string {
	return `h-${toolCallId}`;
}

function newThread(id: string, at: number, parent: IOrchThread | undefined, info: { title?: string; modelRef?: string; modelLabel?: string; taskId?: string; blocked?: string }): IOrchThread {
	return {
		id,
		rootId: parent?.rootId ?? id,
		...(parent ? { parentId: parent.id } : {}),
		...(info.taskId ? { taskId: info.taskId } : {}),
		depth: parent ? parent.depth + 1 : 0,
		createdAt: at,
		...(info.title ? { title: info.title } : {}),
		...(info.modelRef ? { modelRef: info.modelRef } : {}),
		...(info.modelLabel ? { modelLabel: info.modelLabel } : {}),
		...(info.blocked ? { blocked: info.blocked } : {}),
		queue: [],
		inputs: [],
		turns: 0,
		handoffs: [],
	};
}

function dispatch(threadId: string, turn: Omit<IOrchTurn, 'phase'> & { readonly phase?: IOrchTurn['phase'] }): OrchEvent {
	return { type: 'turn.dispatched', threadId, turn: { ...turn, phase: turn.phase ?? 'dispatching' } };
}

interface ISubmitItem {
	readonly id: string;
	readonly prompt: IOrchPrompt;
	readonly at: number;
	readonly kind?: IOrchQueueItem['kind'];
}

function decideSubmit(state: IOrchState, threadId: string, item: ISubmitItem, delivery: 'auto' | 'queue' | 'now', canSteer: boolean): IOrchDecision {
	const events: OrchEvent[] = [];
	let thread = state.threads[threadId];
	if (!thread) {
		const created = newThread(threadId, item.at, undefined, {});
		events.push({ type: 'thread.created', thread: created });
		thread = created;
	}
	if (thread.active?.id === item.id || thread.queue.some(queued => queued.id === item.id)) {
		return { events: [], outcome: 'duplicate' };
	}
	const queued: IOrchQueueItem = { id: item.id, prompt: item.prompt, at: item.at, ...(item.kind ? { kind: item.kind } : {}) };
	// A message to a finished subagent's chat is another round of its task: it waits for a slot and
	// its report goes back to the parent. One still waiting for a slot does not jump the line.
	const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
	if (task && !thread.active && (isTerminalTaskState(task.state) || task.state === 'queued')) {
		if (isTerminalTaskState(task.state)) {
			events.push({ type: 'task.resumed', taskId: task.id, at: item.at });
		}
		if (thread.pause) {
			events.push({ type: 'queue.resumed', threadId: thread.id });
		}
		events.push({ type: 'queue.added', threadId: thread.id, item: queued, ...(delivery === 'now' ? { head: true } : {}) });
		return { events, outcome: 'queued' };
	}
	if (delivery === 'queue' || thread.blocked) {
		events.push({ type: 'queue.added', threadId: thread.id, item: queued });
		return { events, outcome: 'queued' };
	}
	const active = thread.active;
	if (!active) {
		events.push(dispatch(thread.id, { id: item.id, kind: item.kind ?? 'prompt', prompt: item.prompt, at: item.at }));
		return { events, outcome: 'started' };
	}
	if (delivery === 'auto') {
		events.push({ type: 'queue.added', threadId: thread.id, item: queued });
		return { events, outcome: 'queued' };
	}
	// Send now: a running agent that reads messages between steps takes it without stopping.
	if (canSteer && active.phase === 'running') {
		events.push({ type: 'turn.steered', threadId: thread.id, turnId: active.id, prompt: item.prompt, steerId: item.id });
		return { events, outcome: 'steered' };
	}
	// Otherwise stop the agent; this prompt goes first once the stop lands.
	events.push({ type: 'queue.added', threadId: thread.id, item: queued, head: true });
	if (active.phase !== 'cancelling') {
		events.push({ type: 'turn.cancelling', threadId: thread.id, turnId: active.id });
	}
	return { events, outcome: 'queued' };
}

/**
 * A notification never interrupts: it starts when the chat is idle and otherwise waits at the end
 * of the queue. A chat that keeps waking itself with no user turn between is left for the user.
 */
function decideNotify(state: IOrchState, threadId: string, item: ISubmitItem, limits: IOrchLimits, interrupt = false): IOrchDecision {
	const events: OrchEvent[] = [];
	let thread = state.threads[threadId];
	if (!thread) {
		const created = newThread(threadId, item.at, undefined, {});
		events.push({ type: 'thread.created', thread: created });
		thread = created;
	}
	if (thread.active?.id === item.id || thread.queue.some(queued => queued.id === item.id)) {
		return { events: [], outcome: 'duplicate' };
	}
	// A subagent's chat runs its task's turns only: news for one that is done or still waiting for a
	// slot goes nowhere (its parent hears about the task instead).
	const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
	if (thread.taskId && (!task || task.state === 'queued' || isTerminalTaskState(task.state))) {
		return { events: [], rejected: 'The subagent is not running.' };
	}
	const pendingWakes = thread.queue.filter(queued => queued.kind === 'notification').length;
	if ((thread.wakeups ?? 0) + pendingWakes >= limits.maxWakeups) {
		return { events: [], rejected: `The chat woke itself ${limits.maxWakeups} times in a row; it waits for the user.` };
	}
	const active = thread.active;
	if (interrupt && active && !task && !thread.blocked) {
		// Stop what runs and go first: the queue resumes with this turn once the stop lands.
		if (thread.pause) {
			events.push({ type: 'queue.resumed', threadId: thread.id });
		}
		events.push({ type: 'queue.added', threadId: thread.id, item: { id: item.id, prompt: item.prompt, at: item.at, kind: 'notification' }, head: true });
		if (active.phase !== 'cancelling') {
			events.push({ type: 'turn.cancelling', threadId: thread.id, turnId: active.id });
		}
		return { events, outcome: 'queued' };
	}
	if (task || active || thread.pause || thread.blocked || thread.queue.length) {
		events.push({ type: 'queue.added', threadId: thread.id, item: { id: item.id, prompt: item.prompt, at: item.at, kind: 'notification' } });
		return { events, outcome: 'queued' };
	}
	events.push(dispatch(thread.id, { id: item.id, kind: 'notification', prompt: item.prompt, at: item.at }));
	return { events, outcome: 'started' };
}

function decideCancel(state: IOrchState, threadId: string, cascade: 'turn' | 'all' | undefined, at: number): IOrchDecision {
	const thread = state.threads[threadId];
	if (!thread) {
		return { events: [] };
	}
	const events: OrchEvent[] = [];
	const active = thread.active;
	if (active && active.phase !== 'cancelling') {
		events.push({ type: 'turn.cancelling', threadId: thread.id, turnId: active.id });
	}
	if (cascade) {
		// Stopping a turn stops the subagents it started (as a harness's own subagents stop with it);
		// subagents from earlier turns keep working unless the user stops them all.
		let next = applyOrchEvents(state, events);
		for (const task of liveChildren(state, thread.id)) {
			if (task.source !== 'volt' || (cascade === 'turn' && (!active || task.parentTurnId !== active.id))) {
				continue;
			}
			const decision = decideTaskCancel(next, task.id, at, 'The parent chat was stopped.');
			events.push(...decision.events);
			next = applyOrchEvents(next, decision.events);
		}
	}
	return { events };
}

function decideTaskCancel(state: IOrchState, taskId: string, at: number, reason: string | undefined): IOrchDecision {
	const task = state.tasks[taskId];
	if (!task) {
		return { events: [], rejected: `No task ${taskId}.` };
	}
	if (isTerminalTaskState(task.state)) {
		return { events: [] };
	}
	if (task.source !== 'volt') {
		return { events: [], rejected: 'This subagent belongs to the agent\'s own harness and stops with the agent\'s turn.' };
	}
	const events: OrchEvent[] = [];
	const child = task.childId ? state.threads[task.childId] : undefined;
	if (child) {
		for (const item of child.queue) {
			events.push({ type: 'queue.removed', threadId: child.id, itemId: item.id, reason: 'cleared' });
		}
		if (child.active && child.active.phase !== 'cancelling') {
			events.push({ type: 'turn.cancelling', threadId: child.id, turnId: child.active.id });
		}
		// Its own subagents stop with it.
		let next = applyOrchEvents(state, events);
		for (const grandchild of liveChildren(state, child.id)) {
			if (grandchild.source === 'volt') {
				const decision = decideTaskCancel(next, grandchild.id, at, reason);
				events.push(...decision.events);
				next = applyOrchEvents(next, decision.events);
			}
		}
	}
	events.push({ type: 'task.settled', taskId: task.id, state: 'cancelled', at, ...(reason ? { error: reason } : {}) });
	return { events };
}

function decideRunStarted(state: IOrchState, threadId: string, runId: string, turnId: string | undefined, at: number, steerable: boolean): IOrchDecision {
	const thread = state.threads[threadId];
	if (!thread) {
		return { events: [] };
	}
	const active = thread.active;
	if (active) {
		if (active.runId === runId) {
			return { events: [] };
		}
		if (!active.runId && (turnId === undefined || turnId === active.id)) {
			return { events: [{ type: 'turn.bound', threadId: thread.id, turnId: active.id, runId, ...(steerable ? { steerable: true } : {}) }] };
		}
		if (turnId !== undefined && turnId !== active.id) {
			return { events: [] };
		}
		// A run Volt did not dispatch replaced the one it knows: the old turn is over.
		const settled = decideRunSettled(state, thread.id, { turnId: active.id }, 'cancelled', at, undefined, undefined, true);
		return { events: [...settled.events, dispatch(thread.id, { id: externalTurnId(runId), kind: 'external', prompt: { text: '' }, at, phase: 'running', runId })] };
	}
	// A run for a turn that already ended (stopped before the runtime took it) is not adopted; the
	// service stops it. Only a run nobody dispatched becomes an external turn.
	return turnId === undefined
		? { events: [dispatch(thread.id, { id: externalTurnId(runId), kind: 'external', prompt: { text: '' }, at, phase: 'running', runId })] }
		: { events: [] };
}

export function externalTurnId(runId: string): string {
	return `x-${runId}`;
}

function decideRunSettled(state: IOrchState, threadId: string, match: { readonly runId?: string; readonly turnId?: string }, outcome: OrchOutcome, at: number, error: string | undefined, reply: string | undefined, superseded = false): IOrchDecision {
	const thread = state.threads[threadId];
	const active = thread?.active;
	if (!thread || !active) {
		return { events: [] };
	}
	if (match.turnId !== undefined && match.turnId !== active.id) {
		return { events: [] };
	}
	if (match.runId !== undefined && active.runId !== undefined && active.runId !== match.runId) {
		return { events: [] };
	}
	const events: OrchEvent[] = [{ type: 'turn.settled', threadId: thread.id, turnId: active.id, outcome, at, ...(error ? { error } : {}) }];
	if (outcome === 'failed' && !superseded) {
		// The queue waits for the user instead of resending into a failing provider.
		events.push({ type: 'queue.paused', threadId: thread.id, reason: 'failed' });
	}
	// Harness subagents live inside the turn: whatever did not report an end ends with it.
	for (const task of Object.values(state.tasks)) {
		if (task.source === 'harness' && task.parentId === thread.id && task.parentTurnId === active.id && !isTerminalTaskState(task.state)) {
			events.push({ type: 'task.settled', taskId: task.id, state: harnessEndState(outcome), at });
		}
	}
	// A subagent's chat finished a round: its report goes to the parent, unless a follow-up waits.
	// Only a running round settles: a round queued behind a turn that is still unwinding is the next one.
	const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
	if (task && (task.state === 'running' || task.state === 'waiting')) {
		const continues = outcome === 'done' && !!nextQueued(thread) && !thread.pause;
		if (!continues) {
			events.push({
				type: 'task.settled',
				taskId: task.id,
				state: taskEndState(outcome),
				at,
				...(reply !== undefined ? { result: reply } : {}),
				...(error ? { error } : {}),
			});
			// Follow-ups that were waiting stay, held, for whoever resumes the chat.
			if (outcome !== 'failed' && thread.queue.length && !thread.pause) {
				events.push({ type: 'queue.paused', threadId: thread.id, reason: outcome === 'interrupted' ? 'interrupted' : 'stopped' });
			}
			// A subagent stopped from its own chat takes its subagents with it, as task.cancel does.
			if (outcome === 'cancelled') {
				let next = applyOrchEvents(state, events);
				for (const grandchild of liveChildren(next, thread.id)) {
					if (grandchild.source === 'volt') {
						const decision = decideTaskCancel(next, grandchild.id, at, 'Its parent subagent was stopped.');
						events.push(...decision.events);
						next = applyOrchEvents(next, decision.events);
					}
				}
			}
		}
	}
	return { events };
}

function harnessEndState(outcome: OrchOutcome): Extract<OrchTaskState, 'completed' | 'failed' | 'cancelled' | 'interrupted'> {
	switch (outcome) {
		case 'done': return 'completed';
		case 'failed': return 'failed';
		case 'cancelled': return 'cancelled';
		case 'interrupted': return 'interrupted';
	}
}

function taskEndState(outcome: OrchOutcome): Extract<OrchTaskState, 'completed' | 'failed' | 'cancelled' | 'interrupted'> {
	return harnessEndState(outcome);
}

function decideSpawn(state: IOrchState, command: Extract<OrchCommand, { type: 'task.spawn' }>, limits: IOrchLimits): IOrchDecision {
	const spawn = command.spawn;
	const events: OrchEvent[] = [];
	let parent = state.threads[spawn.parentId];
	if (!parent) {
		parent = newThread(spawn.parentId, command.at, undefined, {});
		events.push({ type: 'thread.created', thread: parent });
	}
	if (state.tasks[spawn.taskId]) {
		return { events: [], taskId: spawn.taskId, reused: true };
	}
	if (spawn.clientRequestId) {
		const same = Object.values(state.tasks).find(task => task.parentId === parent!.id && task.clientRequestId === spawn.clientRequestId);
		if (same) {
			return { events: [], taskId: same.id, reused: true };
		}
	}
	// The same brief to the same model while the first is still working: hand back that one.
	const brief = normalizeBrief(spawn.brief);
	const duplicate = Object.values(state.tasks).find(task => task.parentId === parent!.id && task.source === 'volt' && isLiveTaskState(task.state)
		&& (task.modelRef ?? '') === (spawn.modelRef ?? '') && normalizeBrief(task.brief) === brief);
	if (duplicate) {
		return { events: [], taskId: duplicate.id, reused: true };
	}
	const depth = parent.depth + 1;
	if (depth > limits.maxDepth) {
		return { events: [], rejected: `Subagents can delegate only ${limits.maxDepth} level${limits.maxDepth === 1 ? '' : 's'} deep. Do this work yourself.` };
	}
	if (state.threads[spawn.childId]) {
		return { events: [], rejected: `Chat ${spawn.childId} already exists.` };
	}
	const previous = spawn.previousTaskId ? state.tasks[spawn.previousTaskId] : undefined;
	if (spawn.previousTaskId && (!previous || previous.rootId !== parent.rootId)) {
		return { events: [], rejected: `No task ${spawn.previousTaskId} in this chat to continue from.` };
	}
	const task: IOrchTask = {
		id: spawn.taskId,
		source: 'volt',
		parentId: parent.id,
		rootId: parent.rootId,
		...(parent.active ? { parentTurnId: parent.active.id } : {}),
		...(spawn.toolCallId ? { toolCallId: spawn.toolCallId } : {}),
		childId: spawn.childId,
		title: spawn.title,
		role: spawn.role,
		origin: spawn.origin,
		brief: spawn.brief,
		...(spawn.modelRef ? { modelRef: spawn.modelRef } : {}),
		...(spawn.modelLabel ? { modelLabel: spawn.modelLabel } : {}),
		...(spawn.mode ? { mode: spawn.mode } : {}),
		isolation: spawn.isolation,
		...(spawn.scope?.length ? { scope: spawn.scope } : {}),
		depth,
		createdAt: command.at,
		...(spawn.clientRequestId ? { clientRequestId: spawn.clientRequestId } : {}),
		state: 'queued',
		steps: 0,
		files: [],
		delivery: 'none',
		rounds: 1,
		...(previous ? { previousTaskId: previous.id, iteration: (previous.iteration ?? 1) + 1 } : {}),
	};
	const child = newThread(spawn.childId, command.at, parent, {
		title: spawn.title,
		modelRef: spawn.modelRef,
		modelLabel: spawn.modelLabel,
		taskId: task.id,
		blocked: spawn.isolation === 'worktree' ? WORKTREE_BLOCK : undefined,
	});
	events.push(
		{ type: 'task.created', task },
		{ type: 'thread.created', thread: child },
		{ type: 'queue.added', threadId: child.id, item: { id: `${task.id}-r1`, prompt: spawn.childPrompt, at: command.at, kind: 'brief' } },
	);
	return { events, taskId: task.id };
}

export function normalizeBrief(brief: string): string {
	return brief.trim().replace(/\s+/g, ' ').toLowerCase();
}

function decideFileChanged(state: IOrchState, threadId: string, path: string, at: number): IOrchDecision {
	const thread = state.threads[threadId];
	if (!thread) {
		return { events: [] };
	}
	const events: OrchEvent[] = [];
	const task = thread.taskId ? state.tasks[thread.taskId] : undefined;
	if (task && !task.files.includes(path)) {
		events.push({ type: 'task.updated', taskId: task.id, files: [path] });
	}
	// Two live writers in one checkout touching the same file is a conflict worth showing.
	if (task?.isolation === 'worktree') {
		return { events };
	}
	const writer = task?.id ?? thread.id;
	const others = new Set<string>();
	for (const other of Object.values(state.tasks)) {
		if (other.id === writer || other.rootId !== thread.rootId || other.source !== 'volt' || other.isolation !== 'shared' || !isLiveTaskState(other.state)) {
			continue;
		}
		if (other.files.includes(path) || other.scope?.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
			others.add(other.id);
		}
	}
	if (others.size) {
		const existing = state.conflicts[thread.rootId]?.find(conflict => conflict.path === path);
		const taskIds = [...new Set([...(existing?.taskIds ?? []), writer, ...others])].sort();
		if (!existing || taskIds.length !== existing.taskIds.length) {
			events.push({ type: 'conflict.detected', rootId: thread.rootId, conflict: { path, taskIds, at } });
		}
	}
	return { events };
}

/**
 * After a restart nothing is running: the agent processes died with the window. Pending questions
 * are gone. What was running continues by itself only where `resume` says so (a delegated task
 * whose parent waits for its report, or every chat); everything else is interrupted and waits for
 * the user (its queue held, its parent told). A turn that already went through
 * `maxRestartResumes` restarts waits too, so a crash it causes cannot loop.
 */
function decideRecover(state: IOrchState, at: number, resume: OrchRestartResume, limits: IOrchLimits): IOrchDecision {
	const events: OrchEvent[] = [];
	let next = state;
	const push = (more: readonly OrchEvent[]) => {
		events.push(...more);
		next = applyOrchEvents(next, more);
	};
	const continued = new Set<string>();
	for (const thread of sortedThreads(state)) {
		const current = next.threads[thread.id];
		if (!current) {
			continue;
		}
		for (const input of current.inputs) {
			push([{ type: 'input.closed', threadId: thread.id, inputId: input.id }]);
		}
		const task = current.taskId ? next.tasks[current.taskId] : undefined;
		const keepsGoing = continuesAfterRestart(current, task, resume, limits);
		if (current.active) {
			if (keepsGoing && current.active.kind !== 'external') {
				push(restartTurn(next, current, current.active, task, at));
				if (task) {
					continued.add(task.id);
				}
				continue;
			}
			push(decideRunSettled(next, thread.id, { turnId: current.active.id }, 'interrupted', at, undefined, undefined).events);
			push([{ type: 'queue.paused', threadId: thread.id, reason: 'interrupted' }]);
		} else if (current.queue.length && !current.pause) {
			if (keepsGoing) {
				// Between two rounds: the scheduler sends the next one.
				if (task) {
					continued.add(task.id);
				}
				continue;
			}
			push([{ type: 'queue.paused', threadId: thread.id, reason: 'interrupted' }]);
		}
	}
	for (const task of Object.values(next.tasks)) {
		if ((task.state === 'running' || task.state === 'waiting') && !continued.has(task.id)) {
			push([{ type: 'task.settled', taskId: task.id, state: 'interrupted', at }]);
		}
	}
	// A parent waiting on those reports does not start working on its own at launch: the user resumes it.
	for (const task of Object.values(next.tasks)) {
		const parent = next.threads[task.parentId];
		if (task.delivery === 'pending' && parent && !parent.pause && !parent.active) {
			push([{ type: 'queue.paused', threadId: parent.id, reason: 'interrupted' }]);
		}
	}
	return { events };
}

/** The suffix a turn continued after a restart gets; its count bounds a crash loop. */
const RESTART_TURN_SUFFIX = /~r(\d+)$/;

export function restartCount(turnId: string): number {
	const match = RESTART_TURN_SUFFIX.exec(turnId);
	return match ? Number(match[1]) : 0;
}

function continuesAfterRestart(thread: IOrchThread, task: IOrchTask | undefined, resume: OrchRestartResume, limits: IOrchLimits): boolean {
	if (resume === 'off' || thread.blocked) {
		return false;
	}
	if (thread.active && restartCount(thread.active.id) >= limits.maxRestartResumes) {
		return false;
	}
	if (task) {
		// A delegated task the parent still waits for: a harness subagent died with its parent's turn.
		return task.source === 'volt' && (task.state === 'running' || task.state === 'waiting') && (task.restarts ?? 0) < limits.maxRestartResumes;
	}
	return resume === 'all' && !thread.parentId && !!thread.active;
}

/** The text a turn cut off by a restart continues with. Model-facing; the transcript shows a short line. */
export const RESTART_RESUME_TEXT = '[Volt] Volt restarted while you were working, so your previous run was cut off part way. Continue where you left off: check what is already done (files, git status, command output) before redoing anything, then finish the work. If you were in the middle of a delegated task, end with your report as before.';

/**
 * Ends the turn the restart cut off and starts its continuation. A turn that never reached the
 * agent is sent again as it was; one that ran gets the resume prompt (the transcript holds what
 * it did, and the next agent session is briefed from it).
 */
function restartTurn(state: IOrchState, thread: IOrchThread, active: IOrchTurn, task: IOrchTask | undefined, at: number): OrchEvent[] {
	const events: OrchEvent[] = [{ type: 'turn.settled', threadId: thread.id, turnId: active.id, outcome: 'interrupted', at }];
	// Harness subagents live inside the turn and died with it.
	for (const other of Object.values(state.tasks)) {
		if (other.source === 'harness' && other.parentId === thread.id && other.parentTurnId === active.id && !isTerminalTaskState(other.state)) {
			events.push({ type: 'task.settled', taskId: other.id, state: 'interrupted', at });
		}
	}
	if (task) {
		if (task.state === 'waiting') {
			// Its question or approval died with the agent; the continued turn asks again if it must.
			events.push({ type: 'task.waiting', taskId: task.id, on: undefined });
		}
		events.push({ type: 'task.restarted', taskId: task.id, at });
	}
	const id = `${active.id.replace(RESTART_TURN_SUFFIX, '')}~r${restartCount(active.id) + 1}`;
	const unsent = active.phase === 'dispatching' && !active.runId;
	const prompt: IOrchPrompt = unsent ? active.prompt : {
		text: RESTART_RESUME_TEXT,
		display: { text: 'Continued after Volt restarted', notification: true },
		...(active.prompt.mode ? { mode: active.prompt.mode } : {}),
		...(active.prompt.modelRef ? { modelRef: active.prompt.modelRef } : {}),
	};
	events.push(dispatch(thread.id, {
		id,
		kind: unsent ? active.kind : 'resume',
		prompt,
		at,
		...(unsent && active.taskIds ? { taskIds: active.taskIds } : {}),
	}));
	return events;
}

//#endregion

//#region Schedule

/**
 * What should happen next, given nothing else does: start queued subagents while there is room,
 * apply handoffs that waited for a turn to end, wake parents whose subagents reported, and send
 * the next queued prompt of every idle chat. Runs to a fixed point (bounded).
 */
export function scheduleOrch(state: IOrchState, at: number, limits: IOrchLimits = DEFAULT_ORCH_LIMITS): OrchEvent[] {
	const events: OrchEvent[] = [];
	let next = state;
	for (let round = 0; round < 16; round++) {
		const batch = scheduleRound(next, at, limits, state.seq + events.length);
		if (!batch.length) {
			break;
		}
		events.push(...batch);
		next = applyOrchEvents(next, batch);
	}
	return events;
}

function scheduleRound(state: IOrchState, at: number, limits: IOrchLimits, seq: number): OrchEvent[] {
	const events: OrchEvent[] = [];
	let next = state;
	const push = (event: OrchEvent) => {
		events.push(event);
		next = applyOrchEvent(next, event);
	};

	// Queued subagents start in the order they were asked for, within the limits.
	const queued = Object.values(next.tasks).filter(task => task.source === 'volt' && task.state === 'queued').sort(byCreated);
	for (const task of queued) {
		const running = Object.values(next.tasks).filter(other => other.source === 'volt' && (other.state === 'running' || other.state === 'waiting'));
		if (running.length >= limits.runningTotal) {
			break;
		}
		if (running.filter(other => other.parentId === task.parentId).length >= limits.runningPerParent) {
			continue;
		}
		push({ type: 'task.started', taskId: task.id, at });
	}

	for (const thread of sortedThreads(next)) {
		let current = next.threads[thread.id];
		if (!current) {
			continue;
		}
		// A running agent that reads messages between steps gets its subagents' reports right away.
		const steering = current.active;
		if (steering) {
			if (steering.steerable && steering.phase === 'running' && !current.inputs.length) {
				const finished = Object.values(next.tasks)
					.filter(child => child.parentId === current!.id && child.source === 'volt' && child.delivery === 'pending' && isTerminalTaskState(child.state))
					.sort(byEnded);
				if (finished.length) {
					const ids = finished.map(child => child.id);
					const others = liveChildren(next, current.id).filter(child => child.source === 'volt');
					push({ type: 'task.delivery', taskIds: ids, delivery: 'delivered' });
					push({
						type: 'turn.steered',
						threadId: current.id,
						turnId: steering.id,
						steerId: `s${current.turns}-${seq + events.length + 1}`,
						prompt: { text: buildTaskNotification(finished, others, at), display: { text: taskNotificationDisplay(finished), notification: true } },
						taskIds: ids,
					});
				}
			}
			continue;
		}
		if (current.blocked) {
			continue;
		}
		if (current.pendingHandoff) {
			push({ type: 'handoff.applied', threadId: current.id, handoff: current.pendingHandoff });
			current = next.threads[thread.id];
		}
		if (current.pause) {
			continue;
		}
		const task = current.taskId ? next.tasks[current.taskId] : undefined;
		if (task && isTerminalTaskState(task.state) && hasPendingReports(next, current.id)) {
			// A subagent that finished while its own subagents still ran wakes up for their reports
			// and reports again: another round of its task. (Stopping a subagent stops its children,
			// so a stopped one only hears from a child someone explicitly resumed.)
			push({ type: 'task.resumed', taskId: task.id, at });
			continue;
		}
		if (task && isTerminalTaskState(task.state) && nextQueued(current)) {
			// Prompts left on a finished subagent's chat wait for the user; Resume runs another round.
			push({ type: 'queue.paused', threadId: current.id, reason: task.state === 'interrupted' ? 'interrupted' : task.state === 'failed' ? 'failed' : 'stopped' });
			continue;
		}
		if (task && (task.state === 'queued' || isTerminalTaskState(task.state))) {
			continue;
		}
		if (task && task.source === 'volt' && !current.queue.length && !hasPendingReports(next, current.id)) {
			// Its brief or follow-ups were removed before they ran: nothing is left to do.
			push({ type: 'task.settled', taskId: task.id, state: 'cancelled', at, error: 'Its prompt was removed before it ran.' });
			continue;
		}
		const finished = Object.values(next.tasks)
			.filter(child => child.parentId === current.id && child.source === 'volt' && child.delivery === 'pending' && isTerminalTaskState(child.state))
			.sort(byEnded);
		if (finished.length) {
			if ((current.wakeups ?? 0) >= limits.maxWakeups) {
				// Reports keep waking the chat with no user turn between: let the user decide.
				push({ type: 'queue.paused', threadId: current.id, reason: 'wakeups' });
				continue;
			}
			const others = liveChildren(next, current.id).filter(child => child.source === 'volt');
			const ids = finished.map(child => child.id);
			push({ type: 'task.delivery', taskIds: ids, delivery: 'delivered' });
			push(dispatch(current.id, {
				id: `n${current.turns + 1}-${seq + events.length + 1}`,
				kind: 'notification',
				prompt: {
					text: buildTaskNotification(finished, others, at),
					display: { text: taskNotificationDisplay(finished), notification: true },
				},
				at,
				taskIds: ids,
			}));
			continue;
		}
		const item = nextQueued(current);
		if (item) {
			push({ type: 'queue.removed', threadId: current.id, itemId: item.id, reason: 'dispatched' });
			push(dispatch(current.id, { id: item.id, kind: item.kind ?? 'prompt', prompt: item.prompt, at }));
		}
	}

	// Conflicts end when no live task is left to collide.
	for (const [rootId, conflicts] of Object.entries(next.conflicts)) {
		for (const conflict of conflicts) {
			const live = conflict.taskIds.filter(id => {
				const task = next.tasks[id];
				return task ? isLiveTaskState(task.state) : !!next.threads[id]?.active;
			});
			if (live.length < 2) {
				push({ type: 'conflict.cleared', rootId, path: conflict.path });
			}
		}
	}

	// Old finished tasks leave the state, leaves first; their chats stay in history.
	const roots = new Set(Object.values(next.tasks).map(task => task.rootId));
	for (const rootId of roots) {
		const finished = Object.values(next.tasks).filter(task => task.rootId === rootId && isTerminalTaskState(task.state) && task.delivery !== 'pending');
		let excess = finished.length - limits.finishedTasksPerRoot;
		if (excess <= 0) {
			continue;
		}
		const prunable = finished.filter(task => {
			const child = task.childId ? next.threads[task.childId] : undefined;
			return !child || (!child.active && !child.queue.length && !child.pause && !Object.values(next.tasks).some(other => other.parentId === child.id));
		}).sort(byEnded);
		const pruned = prunable.slice(0, excess);
		excess -= pruned.length;
		if (pruned.length) {
			push({ type: 'task.pruned', taskIds: pruned.map(task => task.id) });
			for (const task of pruned) {
				if (task.childId && next.threads[task.childId]) {
					push({ type: 'thread.forgotten', threadId: task.childId });
				}
			}
		}
	}
	return events;
}

//#endregion

//#region Effects

export function effectsFor(events: readonly OrchEvent[], state: IOrchState): OrchEffect[] {
	const effects: OrchEffect[] = [];
	const changed = new Set<string>();
	for (const event of events) {
		switch (event.type) {
			case 'turn.dispatched':
				if (event.turn.kind !== 'external') {
					effects.push({ kind: 'startTurn', threadId: event.threadId, turn: event.turn });
				}
				break;
			case 'turn.steered':
				effects.push({ kind: 'steer', threadId: event.threadId, turnId: event.turnId, prompt: event.prompt, steerId: event.steerId, ...(event.taskIds ? { taskIds: event.taskIds } : {}) });
				break;
			case 'turn.cancelling': {
				const thread = state.threads[event.threadId];
				const runId = thread?.active?.id === event.turnId ? thread.active.runId : undefined;
				effects.push({ kind: 'cancelTurn', threadId: event.threadId, turnId: event.turnId, ...(runId ? { runId } : {}) });
				break;
			}
			case 'task.created':
				changed.add(event.task.id);
				if (event.task.isolation === 'worktree' && event.task.source === 'volt') {
					effects.push({ kind: 'prepareWorktree', taskId: event.task.id });
				}
				break;
			case 'task.started':
			case 'task.resumed': {
				changed.add(event.taskId);
				// A checkout that failed or was lost to a restart is asked for again (the worker dedupes).
				const task = state.tasks[event.taskId];
				const child = task?.childId ? state.threads[task.childId] : undefined;
				if (child?.blocked === WORKTREE_BLOCK && !effects.some(effect => effect.kind === 'prepareWorktree' && effect.taskId === event.taskId)) {
					effects.push({ kind: 'prepareWorktree', taskId: event.taskId });
				}
				break;
			}
			case 'task.settled':
			case 'task.waiting':
			case 'task.restarted':
				changed.add(event.taskId);
				break;
			case 'task.updated':
				changed.add(event.taskId);
				break;
		}
	}
	// A dispatch superseded or stopped within the same batch must not start; its cancel settles it.
	const live = effects.filter(effect => {
		if (effect.kind !== 'startTurn') {
			return true;
		}
		const active = state.threads[effect.threadId]?.active;
		return active?.id === effect.turn.id && active.phase !== 'cancelling';
	});
	if (changed.size) {
		live.push({ kind: 'tasksChanged', taskIds: [...changed] });
	}
	return live;
}

//#endregion

//#region Helpers

function hasPendingReports(state: IOrchState, threadId: string): boolean {
	return Object.values(state.tasks).some(task => task.parentId === threadId && task.source === 'volt' && task.delivery === 'pending' && isTerminalTaskState(task.state));
}

export function liveChildren(state: IOrchState, threadId: string): IOrchTask[] {
	return Object.values(state.tasks).filter(task => task.parentId === threadId && isLiveTaskState(task.state)).sort(byCreated);
}

function sortedThreads(state: IOrchState): IOrchThread[] {
	return Object.values(state.threads).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function byCreated(a: IOrchTask, b: IOrchTask): number {
	return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byEnded(a: IOrchTask, b: IOrchTask): number {
	return (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

//#endregion
