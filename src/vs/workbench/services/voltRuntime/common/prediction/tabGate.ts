/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether a Tab request is worth its tokens at the cursor: an online logistic regression over a
 * few cheap features of the situation (Copilot's "contextual filter"). It starts from hand-set
 * weights and learns from what the user accepts and dismisses. A request it rates below the bar
 * is skipped, except for a small share sent anyway so the gate keeps learning where it is wrong.
 * Pure: the caller supplies the features, the outcome and the dice.
 */

export const GATE_FEATURES = ['bias', 'midWord', 'suffixCode', 'emptyLine', 'afterOpener', 'afterTerminator', 'typingFast', 'deleting', 'writing', 'streak', 'fatigue'] as const;

export type GateFeatureName = typeof GATE_FEATURES[number];

/** Hand-set starting weights: most spots are worth asking; the middle of a word never is. */
const PRIOR: Record<GateFeatureName, number> = {
	bias: 0.6,
	midWord: -3.2,
	suffixCode: -0.7,
	emptyLine: 0.5,
	afterOpener: 0.6,
	afterTerminator: -0.4,
	typingFast: -0.9,
	deleting: -1.2,
	writing: -0.2,
	streak: 1.2,
	fatigue: -0.8,
};

const LEARNING_RATE = 0.05;
const MAX_WEIGHT = 4;
/** Share of skipped spots asked anyway: without it, a spot the gate gave up on is never seen again. */
const EXPLORE_RATE = 0.05;
/** The bar is relative to how often this user takes a suggestion at all. */
const BAR_SHARE_OF_BASE_RATE = 0.5;
const MIN_BAR = 0.06;
const MAX_BAR = 0.25;

/** What the gate looks at, all known before any request. */
export interface IGateSituation {
	readonly linePrefix: string;
	readonly lineSuffix: string;
	/** Writing (Markdown, a comment) rather than code. */
	readonly writing: boolean;
	/** Keystrokes in the last second. */
	readonly keysLastSecond: number;
	/** The last change removed text and inserted none (backspace, cut). */
	readonly deleting: boolean;
	/** A suggestion was accepted in this file a moment ago. */
	readonly streak: boolean;
	/** Suggestions dismissed or typed over, in a row. */
	readonly dismissedInRow: number;
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const CLOSERS_ONLY = /^[\s)\]}>"'`;,]*$/;
/** Ends where an expression or a block must follow. */
const OPENER = /(?:[([{=,:?+\-*/%&|<>!]|=>|\b(?:return|await|new|yield|throw|in|of|case|else|do))\s*$/;

/** The feature vector for `situation`, aligned with {@link GATE_FEATURES}. */
export function gateFeatures(situation: IGateSituation): number[] {
	const { linePrefix, lineSuffix } = situation;
	const before = linePrefix.slice(-1);
	const after = lineSuffix.slice(0, 1);
	return [
		1,
		before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after) ? 1 : 0,
		lineSuffix.trim() && !CLOSERS_ONLY.test(lineSuffix) ? 1 : 0,
		linePrefix.trim() ? 0 : 1,
		OPENER.test(linePrefix) || /\.$/.test(linePrefix) ? 1 : 0,
		/[;}]\s*$/.test(linePrefix) && !lineSuffix.trim() ? 1 : 0,
		Math.min(1, Math.max(0, (situation.keysLastSecond - 4) / 6)),
		situation.deleting ? 1 : 0,
		situation.writing ? 1 : 0,
		situation.streak ? 1 : 0,
		Math.min(1, situation.dismissedInRow / 4),
	];
}

export interface IGateState {
	readonly weights: readonly number[];
	readonly baseRate: number;
}

export class TabGate {

	private readonly weights: number[];
	/** Running share of shown suggestions that were taken. */
	private baseRate: number;
	private learned = 0;

	constructor(saved?: IGateState) {
		this.weights = Array.isArray(saved?.weights) && saved.weights.length === GATE_FEATURES.length && saved.weights.every(Number.isFinite)
			? saved.weights.map(clampWeight)
			: GATE_FEATURES.map(name => PRIOR[name]);
		this.baseRate = saved && Number.isFinite(saved.baseRate) ? Math.min(1, Math.max(0, saved.baseRate)) : 0.3;
	}

	/** How likely a suggestion here is taken, 0..1. */
	probability(features: readonly number[]): number {
		let sum = 0;
		for (let i = 0; i < this.weights.length; i++) {
			sum += this.weights[i] * (features[i] ?? 0);
		}
		return 1 / (1 + Math.exp(-sum));
	}

	/** The probability below which a request is skipped. */
	get bar(): number {
		return Math.min(MAX_BAR, Math.max(MIN_BAR, this.baseRate * BAR_SHARE_OF_BASE_RATE));
	}

	/** True: ask the model. `dice` in [0, 1) decides the exploration share. */
	shouldRequest(features: readonly number[], dice: number = Math.random()): boolean {
		return this.probability(features) >= this.bar || dice < EXPLORE_RATE;
	}

	/** One gradient step on the log loss for a suggestion that was shown with `features`. */
	learn(features: readonly number[], taken: boolean): void {
		const error = (taken ? 1 : 0) - this.probability(features);
		for (let i = 0; i < this.weights.length; i++) {
			this.weights[i] = clampWeight(this.weights[i] + LEARNING_RATE * error * (features[i] ?? 0));
		}
		this.baseRate += ((taken ? 1 : 0) - this.baseRate) * 0.02;
		this.learned++;
	}

	/** Steps taken since the state was last saved. */
	get unsaved(): number {
		return this.learned;
	}

	save(): IGateState {
		this.learned = 0;
		return { weights: [...this.weights], baseRate: this.baseRate };
	}
}

function clampWeight(weight: number): number {
	return Math.min(MAX_WEIGHT, Math.max(-MAX_WEIGHT, weight));
}
