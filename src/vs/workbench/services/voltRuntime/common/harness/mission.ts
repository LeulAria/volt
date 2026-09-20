/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISuccessCriterion, ITaskIntel } from './taskIntel.js';

/**
 * Mission state machine (Zenith-shaped). Agent-lane planning is a DAG of steps; a mission
 * is a contract plus a task list whose reducers refuse in-place edits.
 *
 *   draft → planning → running <-> attention → done | failed | aborted
 *
 * Decisions are a tiny vocabulary: continue | patch | retry | next_mission | abort.
 * Task-list patches only add, supersede, or cancel. That constraint is the whole design:
 * a mission that rewrites its own contract mid-flight cannot be resumed or audited.
 */

export type MissionPhase = 'draft' | 'planning' | 'running' | 'attention' | 'done' | 'failed' | 'aborted';

export type MissionDecisionKind = 'continue' | 'patch' | 'retry' | 'next_mission' | 'abort';

export type MissionTaskType = 'work' | 'validate' | 'gate';

export type MissionTaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'superseded' | 'cancelled';

export interface IMissionTask {
	readonly id: string;
	readonly type: MissionTaskType;
	readonly body: string;
	readonly targets: readonly string[];
	readonly dependsOn: readonly string[];
	readonly status: MissionTaskStatus;
	readonly note?: string;
}

export interface IMissionGap {
	readonly id: string;
	readonly severity: 'low' | 'medium' | 'high';
	readonly expected: string;
	readonly observed: string;
	readonly evidence?: string;
}

export interface IMissionDecision {
	readonly kind: MissionDecisionKind;
	readonly at: number;
	readonly reason: string;
}

export interface ITaskListPatch {
	readonly add?: readonly Omit<IMissionTask, 'status'>[];
	readonly supersede?: readonly { readonly old: string; readonly next: Omit<IMissionTask, 'status'> }[];
	readonly cancel?: readonly string[];
}

export interface IMissionState {
	readonly id: string;
	readonly phase: MissionPhase;
	readonly goal: string;
	readonly contract: readonly ISuccessCriterion[];
	readonly tasks: readonly IMissionTask[];
	readonly gaps: readonly IMissionGap[];
	readonly decisions: readonly IMissionDecision[];
	readonly revision: number;
}

export function draftMission(id: string, intel: ITaskIntel): IMissionState {
	return {
		id,
		phase: 'draft',
		goal: intel.goal,
		contract: intel.successCriteria,
		tasks: intel.deliverables.map((body, index) => ({
			id: `T${index + 1}`,
			type: 'work' as const,
			body,
			targets: assignTargets(intel.successCriteria.length, index, intel.deliverables.length),
			dependsOn: index === 0 ? [] : [`T${index}`],
			status: 'pending' as const,
		})),
		gaps: [],
		decisions: [],
		revision: 1,
	};
}

export function submitPlan(state: IMissionState, now = Date.now()): IMissionState | { error: string } {
	if (state.phase !== 'draft' && state.phase !== 'planning') {
		return { error: `Cannot submit a plan from ${state.phase}.` };
	}
	if (!state.contract.length) {
		return { error: 'Plan has no contract.' };
	}
	if (!state.tasks.length) {
		return { error: 'Plan has no tasks.' };
	}
	const coverage = uncovered(state);
	if (coverage.length) {
		return { error: `Uncovered assertions: ${coverage.join(', ')}.` };
	}
	const owned = overcovered(state);
	if (owned.length) {
		return { error: `Over-covered assertions: ${owned.join(', ')}. Each assertion needs exactly one work owner.` };
	}
	const cycle = taskCycle(state.tasks);
	if (cycle) {
		return { error: `Task graph has a cycle: ${cycle.join(' -> ')}.` };
	}
	return {
		...state,
		phase: 'running',
		revision: state.revision + 1,
		decisions: [...state.decisions, { kind: 'continue', at: now, reason: 'Plan accepted.' }],
	};
}

export function applyPatch(state: IMissionState, patch: ITaskListPatch, reason: string, now = Date.now()): IMissionState {
	const sealed = sealedIds(state.tasks);
	let tasks = state.tasks.slice();
	for (const item of patch.add ?? []) {
		tasks.push({ ...item, status: 'pending' });
	}
	for (const item of patch.supersede ?? []) {
		if (sealed.has(item.old)) {
			continue;
		}
		tasks = tasks.map(task => task.id === item.old ? { ...task, status: 'superseded' as const, note: reason } : task);
		tasks.push({ ...item.next, status: 'pending' });
	}
	for (const id of patch.cancel ?? []) {
		if (sealed.has(id)) {
			continue;
		}
		tasks = tasks.map(task => task.id === id ? { ...task, status: 'cancelled' as const, note: reason } : task);
	}
	return {
		...state,
		tasks,
		revision: state.revision + 1,
		decisions: [...state.decisions, { kind: 'patch', at: now, reason }],
	};
}

/**
 * Zenith sealed-gate: a passed gate freezes its upstream closure. A later patch
 * may add work *after* the gate, but it cannot rewrite history behind it.
 */
export function sealedIds(tasks: readonly IMissionTask[]): Set<string> {
	const byId = new Map(tasks.map(task => [task.id, task]));
	const sealed = new Set<string>();
	const walk = (id: string): void => {
		if (sealed.has(id)) {
			return;
		}
		sealed.add(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			walk(dep);
		}
	};
	for (const task of tasks) {
		if (task.type === 'gate' && task.status === 'passed') {
			walk(task.id);
		}
	}
	return sealed;
}

export function decideMission(state: IMissionState, kind: MissionDecisionKind, reason: string, now = Date.now()): IMissionState | { error: string } {
	if (kind === 'abort') {
		return { ...state, phase: 'aborted', revision: state.revision + 1, decisions: [...state.decisions, { kind, at: now, reason }] };
	}
	if (kind === 'next_mission') {
		return { ...state, phase: 'done', revision: state.revision + 1, decisions: [...state.decisions, { kind, at: now, reason }] };
	}
	if (kind === 'retry') {
		const failed = state.tasks.find(task => task.status === 'failed');
		if (!failed) {
			return { error: 'Nothing failed to retry.' };
		}
		return {
			...state,
			phase: 'running',
			tasks: state.tasks.map(task => task.id === failed.id ? { ...task, status: 'pending' as const, note: reason } : task),
			revision: state.revision + 1,
			decisions: [...state.decisions, { kind, at: now, reason }],
		};
	}
	if (kind === 'continue' && state.phase === 'attention') {
		return { ...state, phase: 'running', revision: state.revision + 1, decisions: [...state.decisions, { kind, at: now, reason }] };
	}
	return { ...state, decisions: [...state.decisions, { kind, at: now, reason }], revision: state.revision + 1 };
}

export function recordGap(state: IMissionState, gap: IMissionGap): IMissionState {
	return { ...state, phase: 'attention', gaps: [...state.gaps, gap], revision: state.revision + 1 };
}

export function endMission(state: IMissionState): IMissionState | { error: string } {
	const runnable = state.tasks.filter(task => task.status === 'pending' || task.status === 'running');
	if (runnable.length) {
		return { error: `Cannot end: ${runnable.length} runnable task${runnable.length === 1 ? '' : 's'} remain.` };
	}
	const failed = state.tasks.some(task => task.status === 'failed');
	const openGaps = state.gaps.length > 0 && state.decisions.at(-1)?.kind !== 'next_mission';
	if (failed || openGaps) {
		return { ...state, phase: 'attention', revision: state.revision + 1 };
	}
	return { ...state, phase: 'done', revision: state.revision + 1 };
}

export function readyTasks(state: IMissionState): IMissionTask[] {
	const byId = new Map(state.tasks.map(task => [task.id, task]));
	return state.tasks.filter(task => {
		if (task.status !== 'pending') {
			return false;
		}
		return task.dependsOn.every(id => {
			const dep = byId.get(id);
			return dep?.status === 'passed' || dep?.status === 'cancelled' || dep?.status === 'superseded';
		});
	});
}

function uncovered(state: IMissionState): string[] {
	const claimed = new Set(
		state.tasks
			.filter(task => task.status !== 'superseded' && task.status !== 'cancelled')
			.flatMap(task => task.targets),
	);
	return state.contract.map((_, index) => `c${index}`).filter(id => !claimed.has(id));
}

/** Zenith: every assertion has exactly one non-superseded work owner. */
function overcovered(state: IMissionState): string[] {
	const counts = new Map<string, number>();
	for (const task of state.tasks) {
		if (task.type !== 'work' || task.status === 'superseded' || task.status === 'cancelled') {
			continue;
		}
		for (const target of task.targets) {
			counts.set(target, (counts.get(target) ?? 0) + 1);
		}
	}
	return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Round-robin so a multi-deliverable draft does not mark every assertion as owned by
 * every worker - that would fail `submitPlan` under Zenith's exactly-one-owner rule.
 */
function assignTargets(criteria: number, index: number, taskCount: number): string[] {
	if (criteria <= 0) {
		return [];
	}
	if (taskCount <= 1) {
		return Array.from({ length: criteria }, (_, i) => `c${i}`);
	}
	return Array.from({ length: criteria }, (_, i) => `c${i}`).filter((_, i) => i % taskCount === index);
}

/**
 * Zenith AND-gate: every target the gate names must be covered by at least one
 * validator, and every covering validator must have passed.
 */
export function evaluateMissionGate(state: IMissionState, gate: IMissionTask): { readonly ok: boolean; readonly missing: readonly string[]; readonly dissent: readonly string[] } {
	const validators = state.tasks.filter(task =>
		task.type === 'validate'
		&& task.status !== 'superseded'
		&& task.status !== 'cancelled'
		&& task.targets.some(id => gate.targets.includes(id)));
	const missing: string[] = [];
	const dissent: string[] = [];
	for (const target of gate.targets) {
		const covering = validators.filter(task => task.targets.includes(target));
		if (!covering.length) {
			missing.push(target);
			continue;
		}
		if (covering.some(task => task.status !== 'passed')) {
			dissent.push(target);
		}
	}
	return { ok: missing.length === 0 && dissent.length === 0, missing, dissent };
}

function taskCycle(tasks: readonly IMissionTask[]): string[] | undefined {
	const edges = new Map(tasks.map(task => [task.id, task.dependsOn]));
	const state = new Map<string, 'open' | 'closed'>();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (state.get(id) === 'closed') {
			return undefined;
		}
		if (state.get(id) === 'open') {
			return [...path.slice(path.indexOf(id)), id];
		}
		state.set(id, 'open');
		path.push(id);
		for (const next of edges.get(id) ?? []) {
			const found = visit(next);
			if (found) {
				return found;
			}
		}
		path.pop();
		state.set(id, 'closed');
		return undefined;
	};
	for (const task of tasks) {
		const found = visit(task.id);
		if (found) {
			return found;
		}
	}
	return undefined;
}
