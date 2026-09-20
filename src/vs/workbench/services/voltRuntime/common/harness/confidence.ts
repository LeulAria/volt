/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExecutionPlan, planProgress } from './plan.js';
import { IProgressReport } from './progress.js';
import { IExitCriteria } from './strategy.js';
import { ICompletionCheck, IVerificationGate } from './verification.js';

/**
 * Confidence evaluator. Completion is binary (`checkCompletion`); confidence is the *quality*
 * of that binary. A run that edited one file and ran no checks can be "complete" in a chat
 * lane and still score 0.2 - the synthesizer uses that number to decide whether to say
 * "done" or "done, but I could not prove it".
 *
 * The completion gate may also refuse a "complete" result whose confidence is below the
 * strategy's `requireConfidence` floor. That is how a mission stays open when the evidence
 * is thin even if every named gate happened to pass.
 */

export interface IConfidenceReport {
	readonly score: number;
	readonly sufficient: boolean;
	readonly reasons: readonly string[];
}

export interface IConfidenceInput {
	readonly completion: ICompletionCheck;
	readonly gates: readonly IVerificationGate[];
	readonly progress?: IProgressReport;
	readonly plan?: IExecutionPlan;
	readonly exit: IExitCriteria;
	readonly changedFiles: number;
}

export function evaluateConfidence(input: IConfidenceInput): IConfidenceReport {
	const reasons: string[] = [];
	let score = 0.15;

	if (input.completion.complete) {
		score += 0.25;
		reasons.push('Completion check passed.');
	} else {
		reasons.push(input.completion.reason);
	}

	const runnable = input.gates.filter(gate => gate.status !== 'unavailable');
	const passed = runnable.filter(gate => gate.status === 'passed').length;
	if (runnable.length) {
		const ratio = passed / runnable.length;
		score += 0.30 * ratio;
		if (ratio === 1) {
			reasons.push('Every runnable gate passed.');
		} else {
			reasons.push(`${passed}/${runnable.length} gates passed.`);
		}
	} else if (input.exit.requireGates) {
		score -= 0.10;
		reasons.push('No runnable verification gates exist.');
	}

	if (input.changedFiles > 0) {
		score += 0.15;
		reasons.push(`${input.changedFiles} file${input.changedFiles === 1 ? '' : 's'} changed.`);
	} else if (input.exit.requireMutation) {
		score -= 0.15;
		reasons.push('Nothing in the workspace changed.');
	}

	if (input.plan) {
		const progress = planProgress(input.plan);
		score += 0.15 * progress;
		if (progress < 1 && input.exit.requirePlanComplete) {
			reasons.push(`Plan is ${Math.round(progress * 100)}% complete.`);
		}
	}

	if (input.progress) {
		score += 0.10 * clamp01(input.progress.score);
		if (input.progress.regression) {
			score -= 0.20;
			reasons.push('A previously passing check is now failing.');
		}
		if (input.progress.doomLoop || input.progress.stuck) {
			score -= 0.15;
			reasons.push(input.progress.doomLoop ? 'The run looped.' : 'The run is stuck.');
		}
	}

	const final = round2(clamp01(score));
	return {
		score: final,
		sufficient: input.completion.complete && final >= input.exit.requireConfidence,
		reasons,
	};
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
