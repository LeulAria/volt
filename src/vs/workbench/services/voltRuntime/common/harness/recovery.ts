/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltLane } from './lanes.js';
import { IReplanRequest } from './plan.js';
import { ErrorClass, IProgressReport, isRetryable } from './progress.js';

/**
 * The recovery controller. Progress intelligence says *something is wrong*; this decides *what
 * to do about it*, and routes the answer to the part of the runtime that can act:
 *
 *   retry     → the loop, after a backoff
 *   nudge     → the loop, with a corrective message prepended to the next turn
 *   switch    → the loop, told to abandon the current approach
 *   replan    → the planner
 *   escalate  → the model router
 *   delegate  → the orchestrator
 *   reset     → the context engine
 *   rollback  → the state manager
 *   ask/stop  → the user
 *
 * The ladder is strictly ordered and each rung has a budget. That ordering is the whole design:
 * without it a recovery system becomes its own doom loop, retrying forever or escalating to the
 * most expensive model on the first hiccup. Once a rung's budget is spent the controller may
 * only climb, never descend, so a run makes at most a bounded number of recovery attempts before
 * it reaches `ask`.
 */

export type RecoveryStrategy =
	| 'continue'
	| 'retry'
	| 'nudge'
	| 'switch'
	| 'replan'
	| 'escalate'
	| 'delegate'
	| 'reset'
	| 'rollback'
	| 'isolate'
	| 'ask'
	| 'stop';

/**
 * Ladder order, cheapest first. `continue` is not on it; it means nothing was wrong.
 *
 * `rollback` sits third because undoing a bad edit is cheap and local - it discards the last few
 * minutes of work and nothing else. Everything above it changes the shape of the run: a new
 * approach, a new plan, a different model, a different worker, a different context. Getting this
 * order wrong is what makes a harness thrash: a run that escalates to the expensive model while
 * standing on broken code pays more to fail the same way.
 */
const LADDER: readonly RecoveryStrategy[] = ['retry', 'nudge', 'rollback', 'switch', 'replan', 'escalate', 'delegate', 'isolate', 'reset', 'ask', 'stop'];

/**
 * How many times each rung may be used in one run. Retry is generous because transient failures
 * genuinely are transient; escalate is one because there is only one model above the current
 * one worth paying for; rollback is one because a second rollback means the checkpoint was not
 * the problem.
 */
const BUDGET: Readonly<Record<RecoveryStrategy, number>> = {
	continue: Number.MAX_SAFE_INTEGER,
	retry: 4,
	nudge: 4,
	switch: 2,
	replan: 2,
	escalate: 1,
	delegate: 2,
	reset: 1,
	rollback: 1,
	isolate: 1,
	ask: 1,
	stop: 1,
};

const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 8_000;

export interface IRecoveryContext {
	readonly lane: VoltLane;
	readonly report: IProgressReport;
	/** A stronger model is configured and the run is not already on it. */
	readonly canEscalate: boolean;
	/** The lane grants the `agents` group and sub-agent depth is left. */
	readonly canDelegate: boolean;
	/** A checkpoint exists to roll back to. */
	readonly canRollback: boolean;
	/** Context pressure is high enough that a reset would actually free room. */
	readonly canReset: boolean;
	/** The run has more than one worker or a worktree to quarantine a failure in. */
	readonly canIsolate?: boolean;
	readonly hasPlan: boolean;
	/** The plan step in flight, if any. Required for `replan`. */
	readonly activeStepId?: string;
	/** 0..1 of the lane budget already consumed. Near 1, cheap rungs stop being worth it. */
	readonly budgetUsed: number;
	/** Strategy the execution policy wants first (stuck → replan, regression → rollback). */
	readonly prefer?: RecoveryStrategy;
}

export interface IRecoveryDecision {
	readonly strategy: RecoveryStrategy;
	/** One line for the decision trace and, for `ask`/`stop`, for the user. */
	readonly reason: string;
	/** Prepended to the next turn as a user-role message. Present for retry/nudge/switch/reset. */
	readonly guidance?: string;
	/** Present for `replan`. */
	readonly replan?: IReplanRequest;
	/** Present for `retry`. */
	readonly cooldownMs?: number;
}

/**
 * One per run. Holds the per-rung budgets, which is the only state recovery needs - everything
 * else arrives in the context.
 */
export class RecoveryController {

	private readonly used = new Map<RecoveryStrategy, number>();
	/** The highest rung reached. The controller never descends below it. */
	private floor = 0;

	decide(context: IRecoveryContext): IRecoveryDecision {
		const { report } = context;

		if (!needsRecovery(report)) {
			return { strategy: 'continue', reason: report.reason };
		}

		for (const candidate of this.preference(context)) {
			if (this.take(candidate, context)) {
				return this.build(candidate, context);
			}
		}
		return this.build('stop', context);
	}

	/** Strategies worth trying for this failure, best first. The ladder then filters by budget. */
	private preference(context: IRecoveryContext): RecoveryStrategy[] {
		const { report } = context;
		const wanted: RecoveryStrategy[] = [];
		if (context.prefer) {
			wanted.push(context.prefer);
		}
		const error = report.dominantError;

		if (error === 'cancelled') {
			return ['stop'];
		}

		// A doom loop means the model is not reacting to results at all. Nudging it with more
		// prose is exactly what it is already ignoring, so skip straight to changing the shape
		// of the run.
		if (report.doomLoop) {
			wanted.push('switch', 'replan', 'escalate', 'delegate', 'reset', 'ask');
		} else if (error && isRetryable(error) && !repeatedFailure(report)) {
			wanted.push('retry', 'nudge', 'switch');
		} else if (error) {
			wanted.push('nudge');
			// An edit that keeps breaking the same way is the one case where undoing beats
			// reasoning harder: every further attempt is reasoning about code Volt just broke.
			if (error === 'syntax' && repeatedFailure(report)) {
				wanted.push('rollback');
			}
			wanted.push('switch', 'replan', 'escalate');
		}

		if (report.stuck) {
			wanted.push('switch', 'replan', 'escalate', 'delegate', 'isolate', 'reset');
		}
		if (report.regression) {
			wanted.push('rollback', 'isolate', 'replan');
		}
		if (report.signals.oscillation >= 1) {
			wanted.push('switch', 'isolate');
		}
		if (report.signals.toolWaste >= 0.8) {
			wanted.push('switch', 'nudge');
		}
		if (report.signals.tokenWaste >= 0.8) {
			wanted.push('reset', 'escalate');
		}

		wanted.push(...LADDER.filter(strategy => strategy !== 'retry'));
		return [...new Set(wanted)];
	}

	/** Claims a rung if it is available, allowed by the context, and not below the floor. */
	private take(strategy: RecoveryStrategy, context: IRecoveryContext): boolean {
		const rung = LADDER.indexOf(strategy);
		if (rung < 0 || rung < this.floor) {
			return false;
		}
		if (!this.permitted(strategy, context)) {
			return false;
		}
		const used = this.used.get(strategy) ?? 0;
		if (used >= BUDGET[strategy]) {
			// A spent rung raises the floor: the run may not fall back to it later.
			this.floor = Math.max(this.floor, rung + 1);
			return false;
		}
		this.used.set(strategy, used + 1);
		this.floor = Math.max(this.floor, rung);
		return true;
	}

	private permitted(strategy: RecoveryStrategy, context: IRecoveryContext): boolean {
		switch (strategy) {
			case 'escalate': return context.canEscalate;
			case 'delegate': return context.canDelegate;
			case 'rollback': return context.canRollback;
			case 'reset': return context.canReset;
			case 'isolate': return context.canIsolate === true;
			case 'replan': return context.hasPlan && !!context.activeStepId;
			// Cheap in-loop fixes stop being worth a model call once the budget is nearly gone.
			case 'retry':
			case 'nudge': return context.budgetUsed < 0.9;
			default: return true;
		}
	}

	private build(strategy: RecoveryStrategy, context: IRecoveryContext): IRecoveryDecision {
		const { report } = context;
		const error = report.dominantError;
		switch (strategy) {
			case 'retry': {
				const attempt = this.used.get('retry') ?? 1;
				return {
					strategy,
					reason: `Retrying after a ${error ?? 'transient'} failure (attempt ${attempt}).`,
					cooldownMs: Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)),
					guidance: `The previous call failed with a temporary error: ${firstError(report)}. Try the same thing once more.`,
				};
			}
			case 'nudge':
				return { strategy, reason: `Correcting a ${error ?? 'tool'} failure.`, guidance: nudgeFor(error, report) };
			case 'switch':
				return {
					strategy,
					reason: report.doomLoop ? 'Same tool batch three times; forcing a different approach.' : 'No progress; forcing a different approach.',
					guidance: switchGuidance(report),
				};
			case 'replan':
				return {
					strategy,
					reason: 'Reopening the current step with a prerequisite.',
					replan: {
						stepId: context.activeStepId!,
						reason: report.reason,
						insertBefore: [`Find out why this failed: ${firstError(report) || report.reason}`],
					},
				};
			case 'escalate':
				return { strategy, reason: 'Escalating to a stronger model after repeated failures.' };
			case 'delegate':
				return { strategy, reason: 'Handing the stuck sub-problem to a focused sub-agent.' };
			case 'isolate':
				return { strategy, reason: 'Isolating the failing worker so the rest of the plan can continue.' };
			case 'reset':
				return {
					strategy,
					reason: 'Resetting context; the transcript is no longer helping.',
					guidance: 'The earlier attempts have been summarised away. Restate the goal in one line, then take the single most direct next action.',
				};
			case 'rollback':
				return { strategy, reason: 'Rolling back to the last checkpoint; the edits made things worse.' };
			case 'ask':
				return { strategy, reason: askReason(context) };
			case 'stop':
			default:
				return { strategy: 'stop', reason: error === 'cancelled' ? 'Cancelled.' : 'Out of recovery options; stopping instead of spinning.' };
		}
	}
}

// --- triggers ------------------------------------------------------------------------------

/** Below this, a step is worth intervening on even without an explicit error. */
const INTERVENE_SCORE = 0.2;

export function needsRecovery(report: IProgressReport): boolean {
	return report.doomLoop
		|| report.stuck
		|| report.regression
		|| !!report.dominantError
		|| report.score < INTERVENE_SCORE
		|| report.signals.tokenWaste >= 0.8
		|| report.signals.oscillation >= 1
		|| report.signals.toolWaste >= 0.8;
}

function repeatedFailure(report: IProgressReport): boolean {
	return report.errors.some(error => error.repeated);
}

function firstError(report: IProgressReport): string {
	return report.errors[0]?.message ?? '';
}

// --- guidance ---------------------------------------------------------------------------------

/**
 * What to actually say to the model. These are the highest-leverage strings in the harness: a
 * precise correction recovers a run in one step, and a vague "please try again" burns the rest
 * of the budget. Each one names the observed failure and prescribes a concrete next action
 * rather than describing the desired outcome.
 */
function nudgeFor(error: ErrorClass | undefined, report: IProgressReport): string {
	const detail = firstError(report);
	switch (error) {
		case 'not-found':
			return `That path or symbol does not exist: ${detail}. Do not guess another name - search for it first, then act on a path you have seen in a result.`;
		case 'invalid-args':
			return `The tool rejected your arguments: ${detail}. Re-read the tool's schema, and for an edit re-read the file so the text you are replacing matches byte for byte.`;
		case 'syntax':
			return `The change does not compile: ${detail}. Read the file back around the error, fix that specific line, and do not rewrite the surrounding code.`;
		case 'assertion':
			return `A real check failed: ${detail}. Treat it as information about the code, not about the command - find the cause before changing the test.`;
		case 'permission':
			return `Access was denied: ${detail}. Do not retry it or route around it. Either do the task a different way or say plainly that it needs the user's approval.`;
		case 'environment':
			return `The environment is missing something: ${detail}. Check what the project expects (its lockfile, its scripts) before installing anything.`;
		case 'conflict':
			return `The file changed underneath you: ${detail}. Re-read it and reapply the edit against the current contents.`;
		case 'transient':
			return `A temporary failure: ${detail}. Retry once; if it fails the same way, do it another way.`;
		default:
			return `The last step failed: ${detail || report.reason}. Say in one line what you think went wrong, then take a different action.`;
	}
}

function switchGuidance(report: IProgressReport): string {
	const repeated = report.signals.repetition >= 0.5;
	return [
		repeated
			? 'You are repeating calls you have already made and getting the same results.'
			: 'The last few steps changed nothing and produced no new information.',
		'Stop the current approach. In one short paragraph: what you now know, what you tried, and the different angle you will take.',
		'Then take that different action - a different tool, a different file, or a narrower question. Do not repeat any call you have already made.',
	].join(' ');
}

function askReason(context: IRecoveryContext): string {
	if (context.report.doomLoop) {
		return 'The run kept making the same call and could not recover. Tell me which part to change and I will pick it up from there.';
	}
	if (context.report.dominantError === 'permission') {
		return 'The run needs access it does not have. Approve the request or tell me to take a different route.';
	}
	return 'Several different approaches did not work. Here is what I tried and what I know - tell me which direction to take.';
}
