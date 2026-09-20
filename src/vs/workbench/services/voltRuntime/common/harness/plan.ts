/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltLane } from './lanes.js';
import { isMachineCheckable, ISuccessCriterion, ITaskIntel } from './taskIntel.js';

/**
 * The adaptive planner. A plan is a DAG of steps, not a checklist: the scheduler needs to know
 * what may run at the same time, and the recovery controller needs to know what a failed step
 * blocks.
 *
 * Three rules keep this from becoming ceremony:
 *   1. `chat` gets no plan at all, and `fast` gets one implement step (plus a research step
 *      when the change depends on current facts). Planning a one-line edit costs a model call
 *      and buys nothing.
 *   2. Steps are derived from the user's own deliverables. The planner never invents work.
 *   3. A plan is data, not control flow. The loop asks `readySteps()` what it may do next; the
 *      plan has no opinion about how a step is carried out.
 */

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * Which kind of worker a step wants. The orchestrator maps these onto sub-agents; the native
 * loop uses them only to frame the step for the model.
 */
export type PlanStepRole = 'explore' | 'research' | 'implement' | 'verify' | 'review' | 'ui' | 'debug' | 'browser';

export interface IPlanStep {
	readonly id: string;
	readonly title: string;
	readonly role: PlanStepRole;
	/** Step ids that must reach a terminal, non-failed state first. */
	readonly dependsOn: readonly string[];
	readonly status: PlanStepStatus;
	/** Criterion ids (`c0`, `c1`, …) this step is expected to satisfy. */
	readonly satisfies: readonly string[];
	/** May share a scheduling wave with other parallel-safe steps. */
	readonly parallelSafe: boolean;
	readonly attempts: number;
	/** Set when a step fails or is skipped, so the summary can explain the gap. */
	readonly note?: string;
}

export interface IExecutionPlan {
	readonly goal: string;
	readonly steps: readonly IPlanStep[];
	/** Bumped by every `replan`. The UI uses it to animate the plan changing rather than blinking. */
	readonly revision: number;
	readonly criteria: readonly ISuccessCriterion[];
}

export interface IPlanValidation {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

// --- construction ----------------------------------------------------------------------------

export function criterionId(index: number): string {
	return `c${index}`;
}

/**
 * Decomposes task intelligence into a DAG.
 *
 * Shape for a coding lane:
 *   explore -+- implement#1 -+- verify
 *            +- implement#2 -+
 *            +- implement#3 -+
 *
 * Implement steps depend on each other only where the user stated an order, so independent
 * deliverables schedule into the same wave.
 */
export function buildPlan(intel: ITaskIntel, lane: VoltLane): IExecutionPlan | undefined {
	if (lane === 'chat') {
		return undefined;
	}

	const criteria = intel.successCriteria;
	const machine = criteria.flatMap((criterion, index) => isMachineCheckable(criterion.evidence) ? [criterionId(index)] : []);
	const soft = criteria.flatMap((criterion, index) => isMachineCheckable(criterion.evidence) ? [] : [criterionId(index)]);
	const steps: IPlanStep[] = [];

	const lookupIds = criteria.flatMap((criterion, index) => criterion.evidence === 'lookup' ? [criterionId(index)] : []);
	const willLookup = intel.shape.lookup;
	let researchId: string | undefined;
	if (willLookup) {
		researchId = 's1';
		steps.push(step(researchId, `Look up what this depends on: ${intel.goal}`, 'research', [], lookupIds, true));
	}

	if (lane === 'fast') {
		const dependsOn = researchId ? [researchId] : [];
		steps.push(step(`s${steps.length + 1}`, intel.goal, 'implement', dependsOn, [...soft.filter(id => !lookupIds.includes(id)), ...machine], false));
		return { goal: intel.goal, steps, revision: 1, criteria };
	}

	const needsExplore = intel.complexityScore >= 0.3 || intel.deliverables.length > 1;
	const exploreId = `s${steps.length + 1}`;
	if (needsExplore) {
		steps.push(step(exploreId, `Locate the code behind: ${intel.goal}`, 'explore', researchId ? [researchId] : [], [], true));
	}

	// A verify step only earns its place when something can actually be run. Without one, the
	// implement steps carry every criterion so the coverage check stays honest.
	const willVerify = machine.length > 0 && intel.deliverables.length > 0;
	const implementClaims = (willVerify ? soft : [...soft, ...machine]).filter(id => !lookupIds.includes(id));

	const implementIds: string[] = [];
	intel.deliverables.forEach((deliverable, index) => {
		const id = `s${steps.length + 1}`;
		const stated = intel.dependencies
			.filter(dependency => dependency.to === index)
			.map(dependency => implementIds[dependency.from])
			.filter((value): value is string => !!value);
		const prefix = [...(researchId && !needsExplore ? [researchId] : []), ...(needsExplore ? [exploreId] : [])];
		const dependsOn = [...prefix, ...stated];
		steps.push(step(id, deliverable, 'implement', dependsOn, implementClaims, stated.length === 0));
		implementIds.push(id);
	});

	if (willVerify) {
		steps.push(step(
			`s${steps.length + 1}`,
			verifyTitle(criteria.filter(criterion => isMachineCheckable(criterion.evidence))),
			'verify',
			implementIds,
			machine,
			false,
		));
	}

	return { goal: intel.goal, steps, revision: 1, criteria };
}

function step(
	id: string,
	title: string,
	role: PlanStepRole,
	dependsOn: readonly string[],
	satisfies: readonly string[],
	parallelSafe: boolean,
): IPlanStep {
	return { id, title, role, dependsOn, status: 'pending', satisfies, parallelSafe, attempts: 0 };
}

function verifyTitle(criteria: readonly ISuccessCriterion[]): string {
	const kinds = [...new Set(criteria.map(criterion => criterion.evidence))];
	return `Verify: ${kinds.join(', ')}`;
}

// --- validation ---------------------------------------------------------------------------------

/**
 * Structural check only. A plan that references a step that does not exist, or that cannot be
 * topologically ordered, would deadlock the scheduler, so those are errors. Coverage gaps are
 * warnings: a plan that leaves a criterion unclaimed is still runnable, it just will not be
 * able to prove it finished.
 */
export function validatePlan(plan: IExecutionPlan): IPlanValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ids = new Set<string>();

	for (const item of plan.steps) {
		if (ids.has(item.id)) {
			errors.push(`Duplicate step id ${item.id}.`);
		}
		ids.add(item.id);
		if (!item.title.trim()) {
			errors.push(`Step ${item.id} has no title.`);
		}
	}

	if (!plan.steps.length) {
		errors.push('Plan has no steps.');
	}

	for (const item of plan.steps) {
		for (const dependency of item.dependsOn) {
			if (!ids.has(dependency)) {
				errors.push(`Step ${item.id} depends on unknown step ${dependency}.`);
			}
			if (dependency === item.id) {
				errors.push(`Step ${item.id} depends on itself.`);
			}
		}
	}

	const cycle = findCycle(plan.steps);
	if (cycle) {
		errors.push(`Plan has a dependency cycle: ${cycle.join(' -> ')}.`);
	}

	const claimed = new Set(plan.steps.flatMap(item => item.satisfies));
	plan.criteria.forEach((criterion, index) => {
		if (!claimed.has(criterionId(index))) {
			warnings.push(`No step proves: ${criterion.text}`);
		}
	});

	if (plan.steps.some(item => item.role === 'verify') && !plan.steps.some(item => item.role === 'implement')) {
		warnings.push('Plan verifies work that no step produces.');
	}

	return { ok: errors.length === 0, errors, warnings };
}

/** Iterative DFS with a colour map; returns the first cycle found as a readable path. */
function findCycle(steps: readonly IPlanStep[]): string[] | undefined {
	const edges = new Map(steps.map(item => [item.id, item.dependsOn]));
	const state = new Map<string, 'open' | 'closed'>();
	const path: string[] = [];

	const visit = (id: string): string[] | undefined => {
		const current = state.get(id);
		if (current === 'closed') {
			return undefined;
		}
		if (current === 'open') {
			const start = path.indexOf(id);
			return [...path.slice(start < 0 ? 0 : start), id];
		}
		state.set(id, 'open');
		path.push(id);
		for (const next of edges.get(id) ?? []) {
			if (!edges.has(next)) {
				continue;
			}
			const found = visit(next);
			if (found) {
				return found;
			}
		}
		path.pop();
		state.set(id, 'closed');
		return undefined;
	};

	for (const item of steps) {
		const found = visit(item.id);
		if (found) {
			return found;
		}
	}
	return undefined;
}

// --- scheduling ------------------------------------------------------------------------------------

/**
 * Steps whose dependencies are all `done` (or `skipped` - a skipped dependency did not fail, it
 * was unnecessary). A step behind a failed dependency stays out of the list until the recovery
 * controller either retries the dependency or skips it, which is what stops a broken plan from
 * grinding through steps that cannot possibly work.
 */
export function readySteps(plan: IExecutionPlan): IPlanStep[] {
	const byId = new Map(plan.steps.map(item => [item.id, item]));
	return plan.steps.filter(item => {
		if (item.status !== 'pending') {
			return false;
		}
		return item.dependsOn.every(id => {
			const dependency = byId.get(id);
			return dependency?.status === 'done' || dependency?.status === 'skipped';
		});
	});
}

/**
 * The whole plan as execution waves, ignoring current status. Used to show the shape of the work
 * up front and to size the concurrency window. A wave mixing parallel-safe and unsafe steps is
 * split so the unsafe ones stay serial.
 */
export function scheduleWaves(plan: IExecutionPlan): IPlanStep[][] {
	const byId = new Map(plan.steps.map(item => [item.id, item]));
	const depth = new Map<string, number>();

	const depthOf = (id: string, seen: ReadonlySet<string>): number => {
		const cached = depth.get(id);
		if (cached !== undefined) {
			return cached;
		}
		if (seen.has(id)) {
			return 0;
		}
		const item = byId.get(id);
		if (!item) {
			return 0;
		}
		const next = new Set(seen).add(id);
		const value = item.dependsOn.length
			? Math.max(...item.dependsOn.map(dependency => depthOf(dependency, next) + 1))
			: 0;
		depth.set(id, value);
		return value;
	};

	const layers = new Map<number, IPlanStep[]>();
	for (const item of plan.steps) {
		const level = depthOf(item.id, new Set());
		const layer = layers.get(level) ?? [];
		layer.push(item);
		layers.set(level, layer);
	}

	const waves: IPlanStep[][] = [];
	for (const level of [...layers.keys()].sort((a, b) => a - b)) {
		const layer = layers.get(level)!;
		const parallel = layer.filter(item => item.parallelSafe);
		if (parallel.length) {
			waves.push(parallel);
		}
		for (const item of layer.filter(item => !item.parallelSafe)) {
			waves.push([item]);
		}
	}
	return waves;
}

// --- transitions -------------------------------------------------------------------------------------

export function withStepStatus(plan: IExecutionPlan, stepId: string, status: PlanStepStatus, note?: string): IExecutionPlan {
	return {
		...plan,
		steps: plan.steps.map(item => item.id === stepId
			? { ...item, status, attempts: status === 'running' ? item.attempts + 1 : item.attempts, ...(note ? { note } : {}) }
			: item),
	};
}

export function isPlanComplete(plan: IExecutionPlan): boolean {
	return plan.steps.every(item => item.status === 'done' || item.status === 'skipped');
}

/** A plan is stalled when nothing is running, nothing is ready, and something is unfinished. */
export function isPlanStalled(plan: IExecutionPlan): boolean {
	if (isPlanComplete(plan)) {
		return false;
	}
	return !plan.steps.some(item => item.status === 'running') && readySteps(plan).length === 0;
}

export function planProgress(plan: IExecutionPlan): number {
	if (!plan.steps.length) {
		return 1;
	}
	const settled = plan.steps.filter(item => item.status === 'done' || item.status === 'skipped').length;
	return round2(settled / plan.steps.length);
}

// --- replanning ---------------------------------------------------------------------------------------

export interface IReplanRequest {
	/** The step that could not be completed. */
	readonly stepId: string;
	readonly reason: string;
	/** Work the model says it must do first. Becomes a new dependency of the failed step. */
	readonly insertBefore?: readonly string[];
	/** Give up on the step and let dependents run. */
	readonly skip?: boolean;
}

/**
 * Adaptive replanning, kept deliberately small. The controller may only insert prerequisite
 * work, reset a failed step to pending, or skip it. Anything more ambitious - rewriting the
 * goal, dropping half the plan - is a new run, not a replan, because the user asked for the
 * original plan and should be told if it is being abandoned.
 */
export function replan(plan: IExecutionPlan, request: IReplanRequest): IExecutionPlan {
	const target = plan.steps.find(item => item.id === request.stepId);
	if (!target) {
		return plan;
	}

	if (request.skip) {
		return {
			...withStepStatus(plan, request.stepId, 'skipped', request.reason),
			revision: plan.revision + 1,
		};
	}

	const inserted: IPlanStep[] = [];
	let nextIndex = plan.steps.length;
	for (const title of request.insertBefore ?? []) {
		if (!title.trim()) {
			continue;
		}
		nextIndex++;
		inserted.push(step(`s${nextIndex}`, title.trim(), 'explore', target.dependsOn, [], true));
	}

	const steps = plan.steps.map(item => item.id === request.stepId
		? {
			...item,
			status: 'pending' as const,
			dependsOn: [...item.dependsOn, ...inserted.map(entry => entry.id)],
			note: request.reason,
		}
		: item);

	return { ...plan, steps: [...steps, ...inserted], revision: plan.revision + 1 };
}

// --- projection ------------------------------------------------------------------------------------------

/** The plan as the `plan` event the UI already renders. */
export function planEntries(plan: IExecutionPlan): { content: string; status: 'pending' | 'in_progress' | 'completed' }[] {
	return plan.steps.map(item => ({
		content: item.title,
		status: item.status === 'running'
			? 'in_progress' as const
			: item.status === 'done' || item.status === 'skipped'
				? 'completed' as const
				: 'pending' as const,
	}));
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
