/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltLane } from './lanes.js';
import { IExecutionPlan, IPlanStep, PlanStepRole, scheduleWaves } from './plan.js';
import { ITaskIntel } from './taskIntel.js';

/**
 * Agent orchestrator. Looks at the plan and decides *how many* workers run it, and *what kind*
 * each one is. It does not spawn anything - the runtime is the only layer that knows how to
 * start a sub-session. This module's job is to make that decision deterministic and cheap.
 *
 *   single     one worker, the native loop. Chat, fast, and simple agent runs.
 *   subagents  one specialist per plan role that has work. Mission and large agent runs.
 *   swarm      several implementers in the same wave, sharing task state. Only when the
 *              scheduler actually produced a parallel wave of three or more.
 *
 * The threshold for swarm is deliberately high. Parallel writers on the same repo without a
 * real independent-deliverable split is how you get conflicting edits, not speed.
 */

export type OrchestrationMode = 'single' | 'subagents' | 'swarm';

export type AgentRole = PlanStepRole | 'general';

export interface IWorkerSpec {
	readonly id: string;
	readonly role: AgentRole;
	readonly title: string;
	readonly stepIds: readonly string[];
	/** When set, this worker may run in the same wave as others. */
	readonly parallel: boolean;
}

export interface IOrchestration {
	readonly mode: OrchestrationMode;
	readonly workers: readonly IWorkerSpec[];
	readonly reason: string;
	/** Maximum concurrent workers. 1 for single; the widest wave for swarm. */
	readonly concurrency: number;
}

const ROLE_LABEL: Readonly<Record<AgentRole, string>> = {
	explore: 'Explorer',
	research: 'Researcher',
	implement: 'Implementer',
	verify: 'Tester',
	review: 'Reviewer',
	ui: 'UI Agent',
	debug: 'Debugger',
	browser: 'Browser Agent',
	general: 'Agent',
};

export function orchestrate(intel: ITaskIntel, lane: VoltLane, plan: IExecutionPlan | undefined): IOrchestration {
	if (!plan || lane === 'chat' || lane === 'fast') {
		const researching = intel.shape.lookup;
		const role = lane === 'chat' && researching ? 'research' : 'general';
		return {
			mode: 'single',
			workers: [worker('w1', role, intel.goal, plan?.steps.map(step => step.id) ?? [], false)],
			reason: lane === 'chat'
				? (researching ? 'Research the question, then answer.' : 'Chat does not orchestrate.')
				: researching
					? 'Look the facts up, then make the change in one worker.'
					: 'A single-step change does not earn workers.',
			concurrency: 1,
		};
	}

	const waves = scheduleWaves(plan);
	const widest = Math.max(1, ...waves.map(wave => wave.length));
	const implementParallel = Math.max(0, ...waves.map(wave => wave.filter(step => step.role === 'implement' && step.parallelSafe).length));

	if (lane === 'mission' && implementParallel >= 3) {
		return {
			mode: 'swarm',
			workers: workersFromPlan(plan),
			reason: `Swarm: ${implementParallel} independent implement steps can run together.`,
			concurrency: widest,
		};
	}

	if (lane === 'mission' || intel.complexityScore >= 0.52 || intel.deliverables.length >= 3) {
		return {
			mode: 'subagents',
			workers: workersFromPlan(plan),
			reason: lane === 'mission'
				? 'Mission work is split across specialists.'
				: 'Several deliverables; each role gets its own worker.',
			concurrency: Math.min(widest, 3),
		};
	}

	return {
		mode: 'single',
		workers: [worker('w1', 'general', intel.goal, plan.steps.map(step => step.id), false)],
		reason: 'The plan fits one agent.',
		concurrency: 1,
	};
}

export function roleLabel(role: AgentRole): string {
	return ROLE_LABEL[role];
}

/**
 * Framing injected when a worker starts a step. Specialists get a tighter instruction than
 * the general agent so they do not wander into each other's jobs.
 */
export function workerFraming(role: AgentRole): string {
	switch (role) {
		case 'explore':
			return 'Find the files, symbols, and constraints this step needs. Do not edit. Report paths and what each one is for.';
		case 'research':
			return 'Look up what this depends on. Search, then fetch primary sources. Match the form and completeness they asked for. Do not invent APIs, versions, or figures. Do not edit the workspace.';
		case 'implement':
			return 'Make the change this step names. Touch only what it requires. Do not start unrelated cleanup.';
		case 'verify':
			return 'Run the project\'s own checks for this step. Do not "fix" a failing test by weakening it.';
		case 'review':
			return 'Read the diff and say what is wrong or missing. Do not rewrite the change unless asked.';
		case 'ui':
			return 'Change only presentation (markup, styles, copy). Verify in the browser when the user asked to see it.';
		case 'debug':
			return 'Reproduce the failure first. Change one thing. Do not start unrelated cleanup.';
		case 'browser':
			return 'Verify the running UI. Snapshot, click, and report what is on screen. Do not rewrite the app to make the snapshot pass.';
		case 'general':
		default:
			return 'Work the current step end to end.';
	}
}

function workersFromPlan(plan: IExecutionPlan): IWorkerSpec[] {
	const byRole = new Map<PlanStepRole, IPlanStep[]>();
	for (const step of plan.steps) {
		const list = byRole.get(step.role) ?? [];
		list.push(step);
		byRole.set(step.role, list);
	}
	const workers: IWorkerSpec[] = [];
	let index = 1;
	for (const [role, steps] of byRole) {
		if (role === 'implement' && steps.length > 1 && steps.every(step => step.parallelSafe)) {
			for (const step of steps) {
				workers.push(worker(`w${index++}`, role, step.title, [step.id], true));
			}
			continue;
		}
		workers.push(worker(`w${index++}`, role, ROLE_LABEL[role], steps.map(step => step.id), steps.every(step => step.parallelSafe)));
	}
	return workers;
}

function worker(id: string, role: AgentRole, title: string, stepIds: readonly string[], parallel: boolean): IWorkerSpec {
	return { id, role, title, stepIds, parallel };
}
