/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolResult } from '../tools/tool.js';
import { evaluateConfidence, IConfidenceReport } from './confidence.js';
import { EvidenceStore } from './evidence.js';
import { VoltLane } from './lanes.js';
import { LessonBook } from './lessons.js';
import { ILoopDirective, ILoopStep } from './nativeLoop.js';
import { advanceOoda, createOoda, IOodaState, phaseFor } from './ooda.js';
import { IExecutionPlan, isPlanComplete, planProgress, readySteps, replan, withStepStatus } from './plan.js';
import { IProgressReport, ProgressTracker } from './progress.js';
import { IRecoveryDecision, RecoveryController, RecoveryStrategy } from './recovery.js';
import { proofOfCompletion, ICompletionProof } from './proof.js';
import { isFailedStep, MistakeTracker } from './mistakes.js';
import { IContingency, IExitCriteria } from './strategy.js';
import { ITaskIntel } from './taskIntel.js';
import { checkCompletion, commandClassifier, ICompletionCheck, IProjectChecks, IVerificationGate, planGates } from './verification.js';

/**
 * The harness controller. Everything else in this folder is a pure function or a small stateful
 * observer; this is the thing that runs them in the right order and turns their opinions into a
 * single instruction for the loop.
 *
 * It sits on exactly two events:
 *
 *   **after a step that used tools** - record evidence, score progress, and if the run is going
 *   nowhere, climb the recovery ladder.
 *
 *   **when the model tries to finish** - run the completion check. This is the important one.
 *   A model that says "done" is making a claim, and the controller's job is to test it against
 *   the evidence and hand back the specific reason when it does not hold. The model then
 *   continues with a concrete instruction rather than a vague "are you sure?".
 *
 * Structural recoveries - escalate, delegate, rollback, reset - are *decided* here and *carried
 * out* by the runtime, which is the only layer that knows about models, sub-agents, and git.
 * The controller reports them as an `action` and keeps the loop moving.
 */

/** A recovery the runtime has to perform; the controller cannot do these itself. */
export type HarnessAction = 'escalate' | 'delegate' | 'rollback' | 'reset' | 'isolate';

export interface IHarnessCapabilities {
	readonly canEscalate: boolean;
	readonly canDelegate: boolean;
	readonly canRollback: boolean;
	readonly canReset: boolean;
	readonly canIsolate?: boolean;
}

export interface IHarnessStepResult {
	readonly progress: IProgressReport;
	readonly recovery: IRecoveryDecision;
	/** What the loop does next. */
	readonly directive: ILoopDirective;
	/** Set when `recovery.strategy` needs the runtime to act before the next step. */
	readonly action?: HarnessAction;
	/** Present on a step where the model tried to finish. */
	readonly completion?: ICompletionCheck;
	readonly ooda: IOodaState;
	readonly confidence?: IConfidenceReport;
	readonly proof?: ICompletionProof;
}

export interface IHarnessControllerOptions {
	readonly intel: ITaskIntel;
	readonly lane: VoltLane;
	readonly checks: IProjectChecks;
	/** Undefined for lanes that do not plan. */
	readonly plan?: IExecutionPlan;
	/** The lane cannot write, so "nothing changed" is not a failure. */
	readonly readOnly?: boolean;
	/** Re-read every step: a model can become unavailable, a checkpoint can appear. */
	readonly capabilities: () => IHarnessCapabilities;
	/** Lane budget, used to tell recovery when cheap rungs stop being worth a model call. */
	readonly budget: { readonly maxModelCalls: number; readonly maxToolCalls: number };
	/** When set, a "complete" claim below this confidence is sent back. */
	readonly exit?: IExitCriteria;
	/** When set, stuck/regression/budget pick this policy's first recovery. */
	readonly contingency?: IContingency;
}

/**
 * How many times the completion check may send the model back before the harness accepts that
 * it is not going to close the gap. Without this, a project whose tests genuinely cannot pass
 * would loop until the lane budget ran out and then report nothing useful.
 */
const MAX_COMPLETION_REJECTIONS = 3;

export class HarnessController {

	readonly evidence: EvidenceStore;
	readonly gates: IVerificationGate[];
	readonly lessons = new LessonBook();
	readonly mistakes = new MistakeTracker();

	private readonly progress: ProgressTracker;
	private readonly recovery = new RecoveryController();
	private ooda = createOoda();
	private currentPlan: IExecutionPlan | undefined;
	private activeStepId: string | undefined;
	private rejections = 0;
	private toolCalls = 0;
	private modelCalls = 0;
	private lastCompletion: ICompletionCheck | undefined;
	private lastProgressReport: IProgressReport | undefined;

	constructor(private readonly options: IHarnessControllerOptions) {
		this.evidence = new EvidenceStore(commandClassifier(options.checks));
		this.gates = planGates(options.intel, options.checks);
		this.progress = new ProgressTracker();
		this.currentPlan = options.plan;
		this.activeStepId = options.plan ? readySteps(options.plan)[0]?.id : undefined;
	}

	get plan(): IExecutionPlan | undefined {
		return this.currentPlan;
	}

	get oodaState(): IOodaState {
		return this.ooda;
	}

	/** The completion check as of the last time it ran. Used by the synthesizer. */
	get completion(): ICompletionCheck {
		return this.lastCompletion ?? this.runCompletionCheck();
	}

	get lastProgress(): IProgressReport | undefined {
		return this.lastProgressReport;
	}

	/**
	 * Called once per loop step. `step.wantsToFinish` distinguishes the two jobs: a step that
	 * called tools is judged on progress, a step that tried to stop is judged on evidence.
	 */
	afterStep(step: ILoopStep): IHarnessStepResult {
		this.modelCalls++;
		this.toolCalls += step.results.length;
		this.evidence.record(step.step, step.calls, step.results);
		this.ooda = advanceOoda(this.ooda, phaseFor('tools-done'));
		this.ooda = advanceOoda(this.ooda, phaseFor('progress'));

		const progress = this.progress.observe({
			step: step.step,
			calls: step.calls,
			results: step.results,
			assistantText: step.assistantText,
			filesChanged: this.mutationsIn(step.results),
			goalDistance: this.currentPlan ? 1 - planProgress(this.currentPlan) : undefined,
			regression: this.evidence.failing().some(item => item.proves) && this.hadPassingCheck(),
			...(step.tokens ? { tokens: step.tokens } : {}),
		});
		this.lastProgressReport = progress;

		this.advancePlan(step, progress);

		if (step.wantsToFinish) {
			this.ooda = advanceOoda(this.ooda, phaseFor('finish'));
			const forced = this.forceToolUse(step, progress);
			if (forced) {
				return forced;
			}
			return this.gateCompletion(progress, step.assistantText);
		}

		this.ooda = advanceOoda(this.ooda, phaseFor('recovery'));
		const miss = this.mistakes.record(isFailedStep(progress.score, progress.errors.length, progress.stuck));
		const prefer = this.preferredRecovery(progress) ?? miss.prefer;
		const decision = this.recovery.decide({
			lane: this.options.lane,
			report: progress,
			hasPlan: !!this.currentPlan,
			...(this.activeStepId ? { activeStepId: this.activeStepId } : {}),
			budgetUsed: this.budgetUsed(),
			...this.options.capabilities(),
			...(prefer ? { prefer } : {}),
		});
		this.ooda = advanceOoda(this.ooda, phaseFor('directive'));
		if (decision.strategy !== 'continue') {
			this.lessons.record(lessonError(progress), decision.strategy, false, decision.reason);
		}

		return { progress, recovery: decision, ooda: this.ooda, ...this.applyRecovery(decision) };
	}

	/** Records a mutation the runtime saw as a `file.change` event rather than a tool result. */
	recordFileChange(step: number, path: string, kind: 'edit' | 'create' | 'delete'): void {
		this.evidence.recordFileChange(step, path, kind);
	}

	/** Human edit-plan: replace the DAG the controller is recovering against. */
	replacePlan(plan: IExecutionPlan): void {
		this.currentPlan = plan;
		this.activeStepId = readySteps(plan)[0]?.id;
	}

	// --- completion -----------------------------------------------------------------------

	/**
	 * The model wants to stop. Let it - unless the evidence says otherwise, in which case send
	 * it back with the specific gap rather than a generic objection.
	 */
	/**
	 * Cline `noToolsUsed`. Agent/fast/mission lanes that have not touched the workspace
	 * yet are not allowed to bow out with a paragraph. Chat and read-only lanes may.
	 */
	private forceToolUse(step: ILoopStep, progress: IProgressReport): IHarnessStepResult | undefined {
		if (step.calls.length || step.results.length || this.toolCalls > 0 || this.evidence.changedFiles().length || this.evidence.lookedUp()) {
			return undefined;
		}
		if (this.rejections >= 1) {
			return undefined;
		}
		if (this.options.intel.shape.lookup) {
			this.rejections++;
			const reason = 'You did not look anything up. This answer depends on current facts.';
			return {
				progress,
				recovery: { strategy: 'nudge', reason },
				directive: {
					kind: 'inject',
					message: `${reason} Call web_search now, then web_fetch the primary sources. If you truly cannot, say why in one line and stop - do not guess.`,
				},
				ooda: this.ooda,
			};
		}
		if (this.options.readOnly || this.options.lane === 'chat') {
			return undefined;
		}
		if (this.options.lane !== 'fast' && this.options.lane !== 'agent' && this.options.lane !== 'mission') {
			return undefined;
		}
		this.rejections++;
		const reason = 'You did not use a tool. This task needs a workspace change.';
		return {
			progress,
			recovery: { strategy: 'nudge', reason },
			directive: {
				kind: 'inject',
				message: `${reason} Call a tool now (read_file, edit_file, …). If you truly cannot, say why in one line and stop - do not claim it is done.`,
			},
			ooda: this.ooda,
		};
	}

	private gateCompletion(progress: IProgressReport, assistantText?: string): IHarnessStepResult {
		const completion = this.runCompletionCheck(assistantText);
		const confidence = this.options.exit ? evaluateConfidence({
			completion,
			gates: this.gates,
			progress,
			exit: this.options.exit,
			changedFiles: this.evidence.changedFiles().length,
			...(this.currentPlan ? { plan: this.currentPlan } : {}),
		}) : undefined;

		const proof = proofOfCompletion(this.options.intel, this.evidence, completion, this.currentPlan);
		const thin = !!(confidence && completion.complete && !confidence.sufficient && this.rejections < MAX_COMPLETION_REJECTIONS);
		const unproven = !!(proof && completion.complete && !proof.ok && this.rejections < MAX_COMPLETION_REJECTIONS);
		if ((completion.complete && !thin && !unproven) || this.rejections >= MAX_COMPLETION_REJECTIONS) {
			return {
				progress,
				recovery: { strategy: 'continue', reason: completion.reason },
				directive: { kind: 'stop' },
				completion,
				ooda: this.ooda,
				proof,
				...(confidence ? { confidence } : {}),
			};
		}

		this.rejections++;
		const reason = unproven
			? proof.reason
			: thin
				? `Not done: confidence is ${confidence!.score} and this lane needs ${this.options.exit!.requireConfidence}. ${confidence!.reasons[0] ?? completion.reason}`
				: completion.reason;
		return {
			progress,
			recovery: { strategy: 'nudge', reason },
			directive: {
				kind: 'inject',
				message: [
					reason,
					'Do that now, then finish. If it genuinely cannot be done, say so plainly in one line and stop - do not claim it is done.',
				].join(' '),
			},
			completion,
			ooda: this.ooda,
			proof,
			...(confidence ? { confidence } : {}),
		};
	}

	private runCompletionCheck(assistantText?: string): ICompletionCheck {
		this.lastCompletion = checkCompletion({
			intel: this.options.intel,
			gates: this.gates,
			store: this.evidence,
			checks: this.options.checks,
			...(this.currentPlan ? { plan: this.currentPlan } : {}),
			...(this.options.readOnly ? { readOnly: true } : {}),
			...(assistantText ? { assistantText } : {}),
		});
		return this.lastCompletion;
	}

	// --- recovery ---------------------------------------------------------------------------

	/**
	 * Translates a ladder decision into a loop directive. The three structural strategies are
	 * reported upward and paired with a `continue`, because the runtime performs them between
	 * steps and the loop should not also be told to do something.
	 */
	private applyRecovery(decision: IRecoveryDecision): { directive: ILoopDirective; action?: HarnessAction } {
		switch (decision.strategy) {
			case 'continue':
				return { directive: { kind: 'continue' } };

			case 'retry':
			case 'nudge':
			case 'switch':
				return {
					directive: {
						kind: 'inject',
						message: decision.guidance ?? decision.reason,
						...(decision.cooldownMs ? { cooldownMs: decision.cooldownMs } : {}),
					},
				};

			case 'replan':
				if (decision.replan && this.currentPlan) {
					this.currentPlan = replan(this.currentPlan, decision.replan);
					this.activeStepId = readySteps(this.currentPlan)[0]?.id;
				}
				return { directive: { kind: 'inject', message: `Plan updated: ${decision.reason} Work the new first step.` } };

			case 'reset':
				return { directive: { kind: 'inject', message: decision.guidance ?? decision.reason }, action: 'reset' };

			case 'escalate':
			case 'delegate':
			case 'rollback':
			case 'isolate':
				return { directive: { kind: 'continue' }, action: decision.strategy };

			case 'ask':
			case 'stop':
			default:
				return { directive: { kind: 'stop', reason: decision.reason } };
		}
	}

	// --- plan ------------------------------------------------------------------------------

	/**
	 * Plan bookkeeping is intentionally coarse. The model is not asked which step it is on -
	 * it would answer unreliably and the answer would be one more thing to validate. Instead a
	 * step is marked done when the run makes real progress on it and failed when it does not,
	 * which is the same signal the recovery ladder uses.
	 */
	private advancePlan(step: ILoopStep, progress: IProgressReport): void {
		if (!this.currentPlan) {
			return;
		}
		if (!this.activeStepId) {
			this.activeStepId = readySteps(this.currentPlan)[0]?.id;
		}
		const active = this.activeStepId;
		if (!active) {
			return;
		}

		const current = this.currentPlan.steps.find(entry => entry.id === active);
		if (current?.status === 'pending') {
			this.currentPlan = withStepStatus(this.currentPlan, active, 'running');
		}

		const settled = step.wantsToFinish || progress.signals.stateChanged || progress.score >= 0.6;
		if (!settled) {
			return;
		}
		this.currentPlan = withStepStatus(this.currentPlan, active, 'done');
		this.activeStepId = readySteps(this.currentPlan)[0]?.id;

		// A finishing step closes whatever is left: the run is over, and leaving steps open
		// would make the completion check reject a run that genuinely finished.
		if (step.wantsToFinish && !isPlanComplete(this.currentPlan)) {
			for (const entry of this.currentPlan.steps) {
				if (entry.status !== 'done' && entry.status !== 'skipped') {
					this.currentPlan = withStepStatus(this.currentPlan, entry.id, 'done');
				}
			}
			this.activeStepId = undefined;
		}
	}

	// --- helpers ---------------------------------------------------------------------------

	private mutationsIn(results: readonly IToolResult[]): number {
		return new Set(results.filter(result => result.kind === 'edit' && !result.isError).map(result => result.callId)).size;
	}

	private budgetUsed(): number {
		const byModel = this.modelCalls / Math.max(1, this.options.budget.maxModelCalls);
		const byTools = this.toolCalls / Math.max(1, this.options.budget.maxToolCalls);
		return Math.min(1, Math.max(byModel, byTools));
	}

	private hadPassingCheck(): boolean {
		return this.evidence.all().some(item => item.tag === 'verification' && item.ok);
	}

	private preferredRecovery(progress: IProgressReport): RecoveryStrategy | undefined {
		const contingency = this.options.contingency;
		if (!contingency) {
			return undefined;
		}
		if (progress.regression) {
			return contingency.onRegression;
		}
		if (progress.stuck) {
			return contingency.onStuck;
		}
		if (progress.dominantError === 'permission') {
			return contingency.onPermission;
		}
		if (this.budgetUsed() >= 0.9) {
			return contingency.onBudget;
		}
		if (progress.score <= 0.25 && progress.dominantError) {
			return contingency.onFail;
		}
		return undefined;
	}
}

function lessonError(progress: IProgressReport): 'stuck' | 'doom' | 'regression' | 'waste' | NonNullable<IProgressReport['dominantError']> {
	if (progress.doomLoop) {
		return 'doom';
	}
	if (progress.regression) {
		return 'regression';
	}
	if (progress.stuck) {
		return 'stuck';
	}
	if (progress.signals.tokenWaste >= 0.8 || progress.signals.toolWaste >= 0.8) {
		return 'waste';
	}
	return progress.dominantError ?? 'unknown';
}

/** Strategies the runtime has to act on rather than the loop. */
export function isRuntimeAction(strategy: RecoveryStrategy): strategy is HarnessAction {
	return strategy === 'escalate' || strategy === 'delegate' || strategy === 'rollback' || strategy === 'reset' || strategy === 'isolate';
}

export type { IToolCall };
