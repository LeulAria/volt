/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDeepseekStep } from '../deepseek/loop.js';
import { HarnessController, IHarnessCapabilities, IHarnessStepResult } from './harnessController.js';
import { IIntent } from './intent.js';
import { IRunEvidence } from './runMetrics.js';
import { analyzeTask } from './taskIntel.js';
import { IProjectChecks } from './verification.js';

/**
 * `volt.agent.evidenceGate`: the evidence check may send a native run back when it claims to be
 * done without proof (tests the task needs never ran, files it should change untouched). Off, the
 * check only watches and its verdict goes into the run's metrics and trace.
 */
export const EVIDENCE_GATE_SETTING = 'volt.agent.evidenceGate';

/** The observer never asks the runtime to escalate, delegate, roll back or reset: the live loop owns those. */
const OBSERVE_ONLY: IHarnessCapabilities = { canEscalate: false, canDelegate: false, canRollback: false, canReset: false, canIsolate: false };

export interface IEvidenceObserverInput {
	readonly text: string;
	readonly intent: IIntent;
	readonly checks: IProjectChecks;
	/** The mode cannot write, so "nothing changed" is not a failure. */
	readonly readOnly: boolean;
	readonly hasPriorTurns: boolean;
}

/**
 * The {@link HarnessController} beside a live native run: it records the evidence of every step
 * (reads, edits, checks that ran and passed) and, when the model wants to finish, tests the claim
 * against it. Its verdict is the run's evidence summary; with the gate on, an unproven finish is
 * sent back with the controller's specific reason (the loop bounds how often).
 */
export class EvidenceObserver {

	private readonly controller: HarnessController;
	private lastFinish: IHarnessStepResult | undefined;

	constructor(input: IEvidenceObserverInput) {
		this.controller = new HarnessController({
			intel: analyzeTask(input.text, input.intent, { hasPriorTurns: input.hasPriorTurns }),
			lane: input.intent.lane,
			checks: input.checks,
			readOnly: input.readOnly,
			capabilities: () => OBSERVE_ONLY,
			budget: input.intent.budget,
		});
	}

	/** One loop step. On a finishing step: the message that sends the model back, when the evidence does not hold. */
	observe(step: IDeepseekStep): string | undefined {
		const result = this.controller.afterStep({
			step: step.step,
			calls: step.calls,
			results: step.results,
			assistantText: step.assistant,
			wantsToFinish: step.wantsToFinish,
			...(step.loop.kind === 'stop' ? { doomLoop: true } : {}),
		});
		if (!step.wantsToFinish) {
			return undefined;
		}
		this.lastFinish = result;
		return result.directive.kind === 'inject' ? result.directive.message : undefined;
	}

	/** A file the run changed outside a tool result (a CLI agent, a shell side effect). */
	noteFileChange(step: number, path: string, kind: 'edit' | 'create' | 'delete'): void {
		this.controller.recordFileChange(step, path, kind);
	}

	summary(lessons: readonly string[] | undefined): IRunEvidence {
		const completion = this.lastFinish?.completion ?? this.controller.completion;
		return {
			complete: completion.complete,
			reason: completion.reason,
			...(this.lastFinish?.proof ? { proven: this.lastFinish.proof.ok } : {}),
			...(this.lastFinish?.confidence ? { confidence: this.lastFinish.confidence.score } : {}),
			changedFiles: this.controller.evidence.changedFiles().length,
			lessons: lessons ?? [],
		};
	}
}
