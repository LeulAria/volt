/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, join, normalize, relative } from '../../../../../base/common/path.js';
import type { IDeepseekStep } from '../deepseek/loop.js';
import { pickString } from '../tools/args.js';
import { HarnessController, IHarnessCapabilities, IHarnessStepResult } from './harnessController.js';
import { IIntent } from './intent.js';
import { buildReceipt, contractNote, doneContract, IDoneContract, IFinishClaims, IProofReview, IReceiptLine, IRunReceipt, isSubstantialRun, NO_CODE_IMPACT, parseFinishClaims, sendBackMessage } from './proofOfDone.js';
import { IRunEvidence } from './runMetrics.js';
import { analyzeTask } from './taskIntel.js';
import { IProjectChecks } from './verification.js';

/**
 * `volt.agent.evidenceGate`: proof of done. `substantial` (the default) holds substantial runs to
 * their receipt: a finish whose checks failed, went stale or never ran goes back with the gap.
 * `always` holds every run that writes; `off` only keeps the receipt. `true`/`false` from before
 * the setting had levels read as `always`/`off`.
 */
export const EVIDENCE_GATE_SETTING = 'volt.agent.evidenceGate';

/** `volt.agent.proofReview`: on a gated run, a fresh-context second opinion reads the diff before the run may end. */
export const PROOF_REVIEW_SETTING = 'volt.agent.proofReview';

export type ProofGateMode = 'off' | 'substantial' | 'always';

export function resolveProofGate(value: unknown): ProofGateMode {
	if (value === true || value === 'always') {
		return 'always';
	}
	return value === false || value === 'off' ? 'off' : 'substantial';
}

/** The observer never asks the runtime to escalate, delegate, roll back or reset: the live loop owns those. */
const OBSERVE_ONLY: IHarnessCapabilities = { canEscalate: false, canDelegate: false, canRollback: false, canReset: false, canIsolate: false };

/** Second opinions per run. A fail sends the run back once; the next finish is reviewed again, and then it stands. */
const MAX_REVIEWS = 2;
/** Changed files the review diff reads, in the order they were first touched. */
const MAX_REVIEW_FILES = 24;
/**
 * Times the gate may send one run back. The loop's own bound resets after every few steps of new
 * work, so over hours it is not a bound; this is.
 */
const MAX_SEND_BACKS = 4;

export interface IEvidenceObserverInput {
	/** The user's request this run serves (for a continuation, the request it continues). */
	readonly text: string;
	readonly intent: IIntent;
	readonly checks: IProjectChecks;
	/** The mode cannot write, so "nothing changed" is not a failure. */
	readonly readOnly: boolean;
	readonly hasPriorTurns: boolean;
	/** The run's folder: changed files are shown and diffed relative to it. */
	readonly root?: string;
	readonly gate: ProofGateMode;
}

/** A file the run changed, with what it held before the run first touched it. */
export interface IObservedChange {
	readonly path: string;
	/** Absolute, for reading what it holds now. */
	readonly fsPath: string;
	/** Undefined: it did not exist before, or nothing reported its old content. */
	readonly before: string | undefined;
	readonly existed: boolean;
}

/**
 * The proof keeper beside a live native run. It records the evidence of every step (reads, edits,
 * checks and whether they passed, in order), the files the run changed (its own edits and its
 * subagents'), and the agent's own `finish` claims; from those it writes the run's receipt
 * against the contract made from the request. With the gate on, a finishing step whose receipt
 * does not hold comes back as the message that sends the model back to close the gap.
 */
export class EvidenceObserver {

	readonly contract: IDoneContract;
	/** The request the contract was made from. */
	readonly request: string;

	private readonly controller: HarnessController;
	private readonly root: string | undefined;
	private readonly gate: ProofGateMode;
	private readonly readOnly: boolean;
	private lastFinish: IHarnessStepResult | undefined;
	/** Files changed, by normalized absolute path, in the order first touched. */
	private readonly changes = new Map<string, IObservedChange>();
	/** `file.change` events since the last step was observed, matched against that step's own edits. */
	private pending: { readonly fsPath: string; readonly kind: 'edit' | 'create' | 'delete' }[] = [];
	private claims: IFinishClaims | undefined;
	private answer = '';
	private steps = 0;
	private sentBack = 0;
	/** The last finish was sent back; the next observed step proves the loop honored it. */
	private sendBackPending = false;
	/** Send-backs issued (the loop may still drop one at its own cap). */
	private issued = 0;
	private reviews = 0;
	private review: IProofReview | undefined;
	/** The review whose failure already went to the model. */
	private reviewSent: IProofReview | undefined;
	/** Evidence count when the last review ran: the same work is not reviewed twice. */
	private reviewedAt = -1;

	constructor(input: IEvidenceObserverInput) {
		const intel = analyzeTask(input.text, input.intent, { hasPriorTurns: input.hasPriorTurns });
		this.request = input.text;
		this.root = input.root;
		this.gate = input.gate;
		this.readOnly = input.readOnly;
		this.contract = doneContract({ text: input.text, intel, checks: input.checks, lane: input.intent.lane, readOnly: input.readOnly });
		this.controller = new HarnessController({
			intel,
			lane: input.intent.lane,
			checks: input.checks,
			readOnly: input.readOnly,
			capabilities: () => OBSERVE_ONLY,
			budget: input.intent.budget,
		});
	}

	/** The contract the model reads with the request, on a run gated from its first finish. */
	contractNote(): string | undefined {
		return this.gate === 'off' || this.readOnly ? undefined : contractNote(this.gate === 'always' ? { ...this.contract, substantial: true } : this.contract);
	}

	/** One loop step: its evidence, then the changes it made that its own results do not show (a subagent's edits). */
	observe(step: IDeepseekStep): void {
		if (this.sendBackPending) {
			this.sendBackPending = false;
			this.sentBack++;
		}
		this.steps = Math.max(this.steps, step.step);
		const result = this.controller.afterStep({
			step: step.step,
			calls: step.calls,
			results: step.results,
			assistantText: step.assistant,
			wantsToFinish: step.wantsToFinish,
			...(step.loop.kind === 'stop' ? { doomLoop: true } : {}),
		});
		this.recordPending(step);
		if (step.wantsToFinish) {
			this.lastFinish = result;
			// The latest finish speaks for the run: a plain-text finish withdraws earlier `finish` claims.
			this.claims = parseFinishClaims(step.results);
			if (step.assistant.trim()) {
				this.answer = step.assistant;
			}
		}
	}

	/** A `file.change` the run's tools or subagents reported. The first report keeps the file's old content. */
	noteFileChange(fsPath: string, kind: 'edit' | 'create' | 'delete', before: string | undefined, existed: boolean | undefined): void {
		const key = this.absolute(fsPath);
		if (!this.changes.has(key)) {
			this.changes.set(key, { path: this.display(key), fsPath: key, before, existed: existed ?? kind !== 'create' });
		}
		this.pending.push({ fsPath: key, kind });
	}

	/** The gate holds this run to its receipt now: by setting, by the request, or by the work done so far. */
	get gated(): boolean {
		if (this.gate === 'off' || this.readOnly || !this.contract.items.length) {
			return false;
		}
		return this.gate === 'always' || isSubstantialRun(this.contract, { changedFiles: this.changedPaths().length, steps: this.steps });
	}

	/** The run's receipt as of now. */
	receipt(): IRunReceipt {
		const gated = this.gated;
		return buildReceipt({
			contract: this.contract,
			evidence: this.controller.evidence.all(),
			changed: this.changedPaths(),
			...(this.claims ? { claims: this.claims } : {}),
			...(this.review ? { review: this.review } : {}),
			withFloor: gated,
			gated,
			sentBack: this.sentBack,
		});
	}

	/**
	 * On a finishing step of a gated run: the message that sends it back when the receipt does not
	 * hold. `undefined` lets it finish (the gate is off, or it already sent this run back as often
	 * as it may: a check that cannot pass here must not hold the run forever, and the receipt says
	 * so instead). Counted on the receipt once the loop shows it took it (the next step arrives).
	 */
	sendBack(receipt: IRunReceipt): string | undefined {
		if (!receipt.gated || this.issued >= MAX_SEND_BACKS) {
			this.sendBackPending = false;
			return undefined;
		}
		// A failed second opinion sends the run back once; the receipt keeps showing it after that.
		const message = sendBackMessage(receipt, this.review !== undefined && this.review !== this.reviewSent);
		this.sendBackPending = !!message;
		if (message) {
			this.issued++;
			this.reviewSent = this.review;
		}
		return message;
	}

	/**
	 * The items only a second opinion can settle, when one is due: the run is gated, its checks
	 * hold, it changed something, and this work was not reviewed already.
	 */
	reviewDue(receipt: IRunReceipt): readonly IReceiptLine[] | undefined {
		if (!receipt.gated || this.reviews >= MAX_REVIEWS || !receipt.changedCount || this.reviewedAt === this.controller.evidence.all().length) {
			return undefined;
		}
		const claimed = receipt.lines.filter(line => line.status === 'claimed');
		return claimed.length && !receipt.lines.some(line => line.status === 'failed' || line.status === 'stale' || line.status === 'missing') ? claimed : undefined;
	}

	/** The second opinion's verdict (undefined: it could not run, and the items stay claimed). */
	noteReview(review: IProofReview | undefined): void {
		this.reviews++;
		this.reviewedAt = this.controller.evidence.all().length;
		if (review) {
			this.review = review;
		}
	}

	/** Changed files the review reads, code first (assets and docs say little in a diff). */
	reviewFiles(): readonly IObservedChange[] {
		const all = [...this.changes.values()];
		return [...all.filter(change => !NO_CODE_IMPACT.test(change.path)), ...all.filter(change => NO_CODE_IMPACT.test(change.path) && /\.(?:md|mdx|markdown|txt|rst|css|scss|sass|less|styl|svg)$/i.test(change.path))].slice(0, MAX_REVIEW_FILES);
	}

	/** The agent's last answer, for the second opinion. */
	get finalAnswer(): string {
		return this.answer;
	}

	summary(lessons: readonly string[] | undefined, receipt?: IRunReceipt): IRunEvidence {
		const completion = this.lastFinish?.completion ?? this.controller.completion;
		return {
			complete: completion.complete,
			reason: completion.reason,
			...(this.lastFinish?.proof ? { proven: this.lastFinish.proof.ok } : {}),
			...(this.lastFinish?.confidence ? { confidence: this.lastFinish.confidence.score } : {}),
			changedFiles: Math.max(this.controller.evidence.changedFiles().length, this.changes.size),
			lessons: lessons ?? [],
			...(receipt ? {
				receipt: {
					verdict: receipt.verdict,
					proven: receipt.lines.filter(line => line.status === 'proven').length,
					total: receipt.lines.length,
					gated: receipt.gated,
					sentBack: receipt.sentBack,
					...(receipt.review ? { review: receipt.review.verdict } : {}),
				},
			} : {}),
		};
	}

	/**
	 * Changes reported since the last step that the step's own results do not account for go
	 * into the evidence after them: a check that ran beside a subagent's edit proves nothing.
	 */
	private recordPending(step: IDeepseekStep): void {
		if (!this.pending.length) {
			return;
		}
		const own = new Set<string>();
		const args = new Map(step.calls.map(call => [call.id, call.args]));
		for (const result of step.results) {
			const path = result.kind === 'edit' && !result.isError ? pickString(args.get(result.callId), 'path', 'file', 'file_path') : undefined;
			if (path) {
				own.add(this.absolute(path));
			}
		}
		for (const change of this.pending) {
			if (!own.has(change.fsPath)) {
				this.controller.recordFileChange(step.step, this.display(change.fsPath), change.kind);
			}
		}
		this.pending = [];
	}

	/** Every file the run changed, relative to its folder, once each, in the order first touched. */
	private changedPaths(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (path: string) => {
			const key = this.absolute(path);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(this.display(key));
			}
		};
		for (const path of this.controller.evidence.changedFiles()) {
			add(path);
		}
		for (const key of this.changes.keys()) {
			add(key);
		}
		return out;
	}

	private absolute(path: string): string {
		return normalize(isAbsolute(path) || !this.root ? path : join(this.root, path));
	}

	private display(fsPath: string): string {
		if (!this.root) {
			return fsPath;
		}
		const rel = relative(this.root, fsPath);
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : fsPath;
	}
}
