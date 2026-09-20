/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltMode } from '../modes.js';
import { IIntentSignals } from './intake.js';
import { IIntent } from './intent.js';
import { ILaneBudget, VoltLane } from './lanes.js';
import { IExecutionPlan, IPlanStep, PlanStepRole, withStepStatus } from './plan.js';
import { RecoveryStrategy } from './recovery.js';
import { ITaskIntel } from './taskIntel.js';
import { IResourceBudget } from './governor.js';
import { needsResearch } from './requestShape.js';

/**
 * Strategy selector, execution policy, contingency, and exit criteria. The planner produces
 * *what* to do; this produces *how* - how much may run in parallel, whether a dry-run is
 * required, what happens when the run gets stuck, and what "done" is allowed to mean.
 *
 * These are deterministic. A strategy that called a model would add a round-trip to every
 * send() just to decide how to start.
 */

export type RunStrategy =
	| 'answer'
	| 'research-answer'
	| 'fast-edit'
	| 'explore-implement-verify'
	| 'research-first'
	| 'debug'
	| 'ui-browser'
	| 'mission-contract';

export interface IExecutionPolicy {
	readonly strategy: RunStrategy;
	readonly parallelism: number;
	readonly requireVerify: boolean;
	readonly requireApproval: boolean;
	readonly isolateWorkers: boolean;
	readonly dryRun: boolean;
	readonly maxDepth: number;
	readonly reason: string;
}

export interface IContingency {
	readonly onStuck: RecoveryStrategy;
	readonly onFail: RecoveryStrategy;
	readonly onBudget: RecoveryStrategy;
	readonly onRegression: RecoveryStrategy;
	readonly onPermission: RecoveryStrategy;
}

export interface IExitCriteria {
	readonly requirePlanComplete: boolean;
	readonly requireGates: boolean;
	readonly requireMutation: boolean;
	readonly requireConfidence: number;
}

export interface IStrategyPlan {
	readonly strategy: RunStrategy;
	readonly policy: IExecutionPolicy;
	readonly contingency: IContingency;
	readonly exit: IExitCriteria;
	readonly budgets: Partial<IResourceBudget>;
}

export function selectStrategy(intel: ITaskIntel, intent: IIntent, signals: IIntentSignals, mode: VoltMode): IStrategyPlan {
	const strategy = strategyOf(intel, intent, signals, mode);
	return {
		strategy,
		policy: policyOf(strategy, intent, signals),
		contingency: contingencyOf(strategy, signals),
		exit: exitOf(strategy, intent),
		budgets: budgetsOf(strategy, intent.lane),
	};
}

function strategyOf(intel: ITaskIntel, intent: IIntent, signals: IIntentSignals, mode: VoltMode): RunStrategy {
	if (intent.lane === 'chat') {
		return needsResearch(intel.shape) ? 'research-answer' : 'answer';
	}
	if (intent.lane === 'fast' && !intel.shape.lookup) {
		return 'fast-edit';
	}
	if (intent.lane === 'mission') {
		return 'mission-contract';
	}
	if (mode === 'debug' || /\b(crash|stack trace|repro|debugger|hangs?|segfault|deadlock|race condition)\b/i.test(intel.goal)) {
		return 'debug';
	}
	if (signals.browserRequired || intent.wantsPreview) {
		return 'ui-browser';
	}
	if (intel.shape.lookup || needsResearch(intel.shape) || (signals.webRequired && intel.complexityScore >= 0.3)) {
		return 'research-first';
	}
	return 'explore-implement-verify';
}

function policyOf(strategy: RunStrategy, intent: IIntent, signals: IIntentSignals): IExecutionPolicy {
	const approval = signals.autonomy === 'supervised' || signals.risk === 'critical' || signals.risk === 'high';
	switch (strategy) {
		case 'answer':
			return { strategy, parallelism: 1, requireVerify: false, requireApproval: approval, isolateWorkers: false, dryRun: false, maxDepth: 0, reason: 'A question does not earn a plan.' };
		case 'research-answer':
			return { strategy, parallelism: 2, requireVerify: false, requireApproval: approval, isolateWorkers: false, dryRun: false, maxDepth: 0, reason: 'Look the facts up, then answer in the form they asked for.' };
		case 'fast-edit':
			return { strategy, parallelism: 1, requireVerify: false, requireApproval: approval, isolateWorkers: false, dryRun: signals.risk === 'critical', maxDepth: 0, reason: 'A named one-line change runs linearly.' };
		case 'debug':
			return { strategy, parallelism: 1, requireVerify: true, requireApproval: approval, isolateWorkers: false, dryRun: false, maxDepth: 1, reason: 'Debugging is serial: reproduce, then change one thing.' };
		case 'ui-browser':
			return { strategy, parallelism: 2, requireVerify: true, requireApproval: approval, isolateWorkers: false, dryRun: false, maxDepth: 1, reason: 'UI work verifies in the browser after the edit.' };
		case 'research-first':
			return { strategy, parallelism: 2, requireVerify: true, requireApproval: approval, isolateWorkers: false, dryRun: false, maxDepth: 1, reason: 'Look the facts up before editing.' };
		case 'mission-contract':
			return { strategy, parallelism: 3, requireVerify: true, requireApproval: approval || signals.risk !== 'safe', isolateWorkers: true, dryRun: signals.risk === 'critical', maxDepth: 2, reason: 'Mission work is contract-first and isolated.' };
		case 'explore-implement-verify':
		default:
			return { strategy, parallelism: 1, requireVerify: intent.lane === 'agent', requireApproval: approval, isolateWorkers: false, dryRun: signals.risk === 'critical', maxDepth: 1, reason: 'Default coding loop: find, change, prove.' };
	}
}

function contingencyOf(strategy: RunStrategy, signals: IIntentSignals): IContingency {
	if (signals.autonomy === 'supervised') {
		return { onStuck: 'ask', onFail: 'ask', onBudget: 'ask', onRegression: 'rollback', onPermission: 'ask' };
	}
	switch (strategy) {
		case 'answer':
			return { onStuck: 'stop', onFail: 'nudge', onBudget: 'stop', onRegression: 'stop', onPermission: 'ask' };
		case 'research-answer':
			return { onStuck: 'nudge', onFail: 'nudge', onBudget: 'stop', onRegression: 'stop', onPermission: 'ask' };
		case 'fast-edit':
			return { onStuck: 'switch', onFail: 'nudge', onBudget: 'ask', onRegression: 'rollback', onPermission: 'ask' };
		case 'mission-contract':
			return { onStuck: 'replan', onFail: 'isolate', onBudget: 'ask', onRegression: 'rollback', onPermission: 'ask' };
		default:
			return { onStuck: 'switch', onFail: 'nudge', onBudget: 'escalate', onRegression: 'rollback', onPermission: 'ask' };
	}
}

function exitOf(strategy: RunStrategy, intent: IIntent): IExitCriteria {
	switch (strategy) {
		case 'answer':
			return { requirePlanComplete: false, requireGates: false, requireMutation: false, requireConfidence: 0 };
		case 'research-answer':
			return { requirePlanComplete: false, requireGates: false, requireMutation: false, requireConfidence: 0 };
		case 'fast-edit':
			return { requirePlanComplete: true, requireGates: false, requireMutation: true, requireConfidence: 0.35 };
		case 'mission-contract':
			return { requirePlanComplete: true, requireGates: true, requireMutation: true, requireConfidence: 0.75 };
		default:
			return {
				requirePlanComplete: intent.lane !== 'chat',
				requireGates: strategy !== 'fast-edit',
				requireMutation: intent.lane !== 'chat',
				requireConfidence: 0.55,
			};
	}
}

function budgetsOf(strategy: RunStrategy, lane: VoltLane): Partial<IResourceBudget> {
	switch (strategy) {
		case 'answer':
			return { steps: 3, tools: 4, parallel: 1, tokens: 32_000, timeMs: 60_000 };
		case 'research-answer':
			return { steps: 12, tools: 24, parallel: 2, tokens: 64_000, timeMs: 4 * 60_000 };
		case 'fast-edit':
			return { steps: 6, tools: 10, parallel: 1, tokens: 64_000, timeMs: 3 * 60_000 };
		case 'research-first':
			return { parallel: 2, tokens: 96_000, timeMs: 8 * 60_000 };
		case 'mission-contract':
			return { parallel: 4, timeMs: 20 * 60 * 60_000 };
		default:
			return { parallel: lane === 'agent' ? 2 : 1 };
	}
}

/**
 * Relabel plan steps so the orchestrator assigns the right specialist. The DAG shape stays;
 * only the *role* of the first (and last, for UI) step changes.
 */
export function applyStrategy(plan: IExecutionPlan | undefined, strategy: RunStrategy, signals: IIntentSignals): IExecutionPlan | undefined {
	if (!plan) {
		return undefined;
	}
	const first = plan.steps[0];
	if (!first) {
		return plan;
	}
	const firstRole: PlanStepRole | undefined =
		first.role === 'research' ? undefined
			: strategy === 'debug' ? 'debug'
				: strategy === 'research-first' || strategy === 'research-answer' || signals.webRequired ? 'research'
					: strategy === 'ui-browser' && first.role === 'explore' ? 'explore'
						: undefined;
	let steps: IPlanStep[] = plan.steps;
	if (firstRole && first.role !== firstRole) {
		steps = steps.map((step, index) => index === 0 ? { ...step, role: firstRole } : step);
	}
	if (strategy === 'ui-browser' && !steps.some(step => step.role === 'ui' || step.role === 'browser')) {
		const last = steps[steps.length - 1];
		if (last && last.role === 'verify') {
			steps = steps.map(step => step.id === last.id ? { ...step, role: 'browser' as PlanStepRole } : step);
		}
	}
	return { ...plan, steps };
}

export function withStrategyNote(plan: IExecutionPlan, stepId: string, note: string): IExecutionPlan {
	return withStepStatus(plan, stepId, plan.steps.find(step => step.id === stepId)?.status ?? 'pending', note);
}

/** Strategy budgets overlay the lane ceiling so a researched answer can use more than a one-liner. */
export function overlayLaneBudget(lane: ILaneBudget, extras: Partial<IResourceBudget>): ILaneBudget {
	return {
		maxModelCalls: extras.steps ?? lane.maxModelCalls,
		maxToolCalls: extras.tools ?? lane.maxToolCalls,
	};
}
