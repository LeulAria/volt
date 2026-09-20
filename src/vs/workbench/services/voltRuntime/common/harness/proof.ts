/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EvidenceStore } from './evidence.js';
import { IExecutionPlan, isPlanComplete } from './plan.js';
import { ISuccessCriterion, ITaskIntel } from './taskIntel.js';
import { ICompletionCheck } from './verification.js';

/**
 * Requirements coverage and proof of completion. The synthesizer writes prose;
 * this writes the checklist: every explicit criterion is either covered by
 * evidence or named as still open. A "complete" claim with uncovered explicit
 * criteria is not a proof.
 */

export interface IRequirementLine {
	readonly text: string;
	readonly evidence: ISuccessCriterion['evidence'];
	readonly explicit: boolean;
	readonly covered: boolean;
}

export interface IRequirementCoverage {
	readonly total: number;
	readonly covered: number;
	readonly lines: readonly IRequirementLine[];
	readonly uncoveredExplicit: readonly IRequirementLine[];
}

export interface ICompletionProof {
	readonly ok: boolean;
	readonly coverage: IRequirementCoverage;
	readonly planComplete: boolean;
	readonly reason: string;
}

export function coverRequirements(intel: ITaskIntel, store: EvidenceStore): IRequirementCoverage {
	const changed = store.changedFiles().length;
	const verified = store.verifiedSince();
	const lookedUp = store.lookedUp();
	const lines = intel.successCriteria.map(criterion => {
		const covered = criterion.evidence === 'lookup'
			? lookedUp
			: criterion.evidence === 'diff'
				? changed > 0
				: criterion.evidence === 'manual'
					? changed > 0 || lookedUp
					: verified.some(item => item.proves === criterion.evidence && item.ok);
		return { text: criterion.text, evidence: criterion.evidence, explicit: criterion.explicit, covered };
	});
	return {
		total: lines.length,
		covered: lines.filter(line => line.covered).length,
		lines,
		uncoveredExplicit: lines.filter(line => line.explicit && !line.covered),
	};
}

export function proofOfCompletion(
	intel: ITaskIntel,
	store: EvidenceStore,
	completion: ICompletionCheck,
	plan?: IExecutionPlan,
): ICompletionProof {
	const coverage = coverRequirements(intel, store);
	const planComplete = !plan || isPlanComplete(plan);
	if (!completion.complete) {
		return { ok: false, coverage, planComplete, reason: completion.reason };
	}
	if (!planComplete) {
		return { ok: false, coverage, planComplete, reason: 'The plan still has open steps.' };
	}
	const blocking = coverage.lines.filter(line => !line.covered && (line.explicit || line.evidence === 'lookup'));
	if (blocking.length) {
		const first = blocking[0];
		return {
			ok: false,
			coverage,
			planComplete,
			reason: `Not proven: "${first.text}" has no ${first.evidence} evidence.`,
		};
	}
	return {
		ok: true,
		coverage,
		planComplete,
		reason: coverage.total
			? `${coverage.covered}/${coverage.total} requirements covered.`
			: completion.reason,
	};
}
