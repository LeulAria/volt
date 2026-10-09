/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IRunGroup, IRunGroupRollup, IRunGroupRun, RunStatus, runWorkMs } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { formatCost, formatTokens } from '../usage/agentUsageFormat.js';

/** The sidebar's badge kinds, for a run or a whole group. */
export type RunBadgeKind = 'input' | 'working' | 'done' | 'failed' | 'interrupted';

/** "42s", "3m 05s", "1h 02m": steady width, so a live clock does not jitter. */
export function formatRunTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) {
		return `${h}h ${String(m).padStart(2, '0')}m`;
	}
	if (m) {
		return `${m}m ${String(s).padStart(2, '0')}s`;
	}
	return `${s}s`;
}

export function formatRunTokens(run: Pick<IRunGroupRun, 'usage'>): string {
	return run.usage.tokens ? formatTokens(run.usage.tokens) : '—';
}

export function formatRunCost(run: Pick<IRunGroupRun, 'usage'>): string {
	return run.usage.costUsd !== undefined ? formatCost(run.usage.costUsd) : '—';
}

/** "Creating worktree", "Setting up 1/2", "Working 1m 05s", "Done", ... */
export function runStatusLabel(status: RunStatus, run: IRunGroupRun, now: number): string {
	switch (status) {
		case 'setup': {
			if (run.setup.state === 'worktree' || run.setup.state === 'pending') {
				return localize('voltRun.status.worktree', "Creating worktree");
			}
			const steps = run.setup.steps;
			const done = steps.filter(step => step.state === 'done').length;
			return steps.length
				? localize('voltRun.status.setupSteps', "Setting up {0}/{1}", Math.min(steps.length, done + 1), steps.length)
				: localize('voltRun.status.setup', "Setting up");
		}
		case 'setupFailed':
			return run.setup.state === 'cancelled' ? localize('voltRun.status.setupStopped', "Setup stopped") : localize('voltRun.status.setupFailed', "Setup failed");
		case 'waiting':
			return localize('voltRun.status.starting', "Starting");
		case 'working':
			return localize('voltRun.status.working', "Working {0}", formatRunTime(runWorkMs(run, now)));
		case 'needsInput':
			return localize('voltRun.status.input', "Needs input");
		case 'stopping':
			return localize('voltRun.status.stopping', "Stopping");
		case 'paused':
			return localize('voltRun.status.paused', "Paused");
		case 'failed':
			return localize('voltRun.status.failed', "Failed");
		case 'interrupted':
			return localize('voltRun.status.interrupted', "Interrupted");
		case 'stopped':
			return localize('voltRun.status.stopped', "Stopped");
		case 'done':
			return localize('voltRun.status.done', "Done");
	}
}

export function runBadgeKind(status: RunStatus): RunBadgeKind | undefined {
	switch (status) {
		case 'setup':
		case 'waiting':
		case 'working':
		case 'stopping':
			return 'working';
		case 'needsInput':
			return 'input';
		case 'done':
			return 'done';
		case 'failed':
		case 'setupFailed':
			return 'failed';
		case 'interrupted':
			return 'interrupted';
		case 'paused':
		case 'stopped':
			return undefined;
	}
}

/** The group row's badge and its one-line summary ("3 models · 2 working"). */
export function runGroupBadge(rollup: IRunGroupRollup): { readonly kind: RunBadgeKind; readonly label: string } | undefined {
	switch (rollup.status) {
		case 'needsInput':
			return { kind: 'input', label: localize('voltRun.badge.input', "Input") };
		case 'running':
			return { kind: 'working', label: localize('voltRun.badge.working', "{0}/{1}", rollup.total - rollup.live, rollup.total) };
		case 'failed':
			return { kind: 'failed', label: localize('voltRun.badge.failed', "Failed") };
		case 'done':
			return { kind: 'done', label: localize('voltRun.badge.done', "Done") };
		case 'stopped':
			return undefined;
	}
}

export function runGroupSummary(group: IRunGroup, rollup: IRunGroupRollup): string {
	const models = localize('voltRun.summary.models', "{0} models", group.runs.length);
	if (group.winner) {
		const winner = group.runs.find(run => run.id === group.winner!.runId);
		return winner ? localize('voltRun.summary.winner', "{0} · {1} won", models, winner.model.label) : models;
	}
	if (rollup.live) {
		return localize('voltRun.summary.live', "{0} · {1} working", models, rollup.live);
	}
	return models;
}

export function winnerActionLabel(action: 'merge' | 'checkout' | 'pr', base: string | undefined): string {
	switch (action) {
		case 'merge':
			return base ? localize('voltRun.winner.merge', "Merge into {0}", base) : localize('voltRun.winner.mergeBase', "Merge into the base branch");
		case 'checkout':
			return localize('voltRun.winner.checkout', "Check out its branch");
		case 'pr':
			return localize('voltRun.winner.pr', "Open a pull request");
	}
}
