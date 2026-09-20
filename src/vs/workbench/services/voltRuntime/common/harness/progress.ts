/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pickString } from '../tools/args.js';
import { IToolCall, IToolResult } from '../tools/tool.js';
import { IDoomLoopState, recordToolBatch, toolCallKey } from './doomLoop.js';

/**
 * Progress intelligence. The doom-loop detector catches the pathological case - three identical
 * tool batches in a row - but most stuck runs are subtler than that: the model keeps reading
 * new files, keeps producing plausible text, and never changes anything. This module watches
 * every step and answers one question for the recovery controller: *is this run still getting
 * somewhere?*
 *
 * Two distinct notions of progress are tracked separately because conflating them hides the
 * failure mode above:
 *
 *   state change  the workspace was mutated - files written, a command with effects succeeded
 *   forward       knowledge was gained - new files read, errors cleared, gates flipped
 *
 * A run that only ever scores on `forward` is exploring; that is fine for two or three steps and
 * a symptom after six. A run that scores on neither is barren, and `barrenSteps` is what
 * eventually trips `stuck`.
 */

// --- error classification --------------------------------------------------------------------

/**
 * Why a tool failed, in the terms the recovery controller reasons about. The class is what picks
 * a strategy: a `transient` failure wants the same call again, a `not-found` wants a search
 * first, and an `assertion` wants a different plan entirely.
 */
export type ErrorClass =
	| 'transient'     // network blip, timeout, rate limit
	| 'permission'    // access policy or filesystem permission
	| 'not-found'     // path, symbol, or command does not exist
	| 'invalid-args'  // the model's arguments did not satisfy the tool
	| 'syntax'        // the edit produced code that does not parse or compile
	| 'assertion'     // a test or check ran and reported a real failure
	| 'environment'   // missing binary, dependency, or configuration
	| 'conflict'      // the file moved under the edit
	| 'cancelled'
	| 'unknown';

export interface IClassifiedError {
	readonly callId: string;
	readonly tool: string;
	readonly class: ErrorClass;
	/** First line of the failure, trimmed. Enough for the trace, never the whole stack. */
	readonly message: string;
	/** True when the identical failure already happened earlier in this run. */
	readonly repeated: boolean;
}

const ERROR_PATTERNS: readonly (readonly [ErrorClass, RegExp])[] = [
	['cancelled', /\b(?:abort(?:ed)?|cancell?ed|operation was cancell?ed|sigint|sigterm)\b/i],
	['permission', /\b(?:permission denied|eacces|eperm|not permitted|access (?:is )?denied|blocked by volt access policy|forbidden|unauthori[sz]ed|403|401)\b/i],
	['transient', /\b(?:etimedout|econnreset|econnrefused|enotfound|socket hang ?up|network|timed? ?out|rate limit|429|50[0234]|temporarily unavailable|try again)\b/i],
	// Ahead of `not-found` on purpose: "module not found" is a dependency problem, not a missing
	// path, and the recovery for the two is different (check the lockfile vs. search the repo).
	['environment', /\b(?:is not recognized as|module not found|cannot find module|missing (?:dependency|peer|binary)|not installed|no version of|requires? node|unsupported platform|venv|virtualenv)\b/i],
	['not-found', /\b(?:enoent|no such file|not found|cannot find (?:file|name|path)|does not exist|unknown tool|command not found|404|is not defined)\b/i],
	['conflict', /\b(?:conflict|modified since|changed on disk|stale|out of date|merge|index\.lock|would be overwritten)\b/i],
	['invalid-args', /\b(?:invalid (?:argument|parameter|input|json)|missing required|expected .{0,30} but (?:got|received)|schema|must be a|unexpected token .{0,20} in json|malformed|could not parse arguments|no match(?:es)? found for|old_string|string to replace)\b/i],
	['syntax', /\b(?:syntaxerror|parse error|unexpected token|unterminated|ts\d{4}:|error ts\d{4}|expected ['"`;)\]}]|cannot redeclare|type .{0,40} is not assignable|declared but (?:its value is )?never)\b/i],
	['assertion', /\b(?:assertion|assert(?:ionerror)?\b|expected .{0,40} to (?:be|equal|contain)|test(?:s)? failed|\d+ (?:failing|failed)|x|\u2716|fail(?:ed)?:|did not match snapshot)\b/i],
];

export function classifyError(tool: string, message: string): ErrorClass {
	for (const [kind, pattern] of ERROR_PATTERNS) {
		if (pattern.test(message)) {
			return kind;
		}
	}
	// A shell tool that fails with no recognisable text is almost always the command's own
	// non-zero exit, which is an assertion about the world rather than a broken tool call.
	return tool === 'shell' ? 'assertion' : 'unknown';
}

/** Whether calling the exact same thing again could plausibly work. */
export function isRetryable(kind: ErrorClass): boolean {
	return kind === 'transient' || kind === 'conflict';
}

// --- observation -----------------------------------------------------------------------------

export interface IStepObservation {
	readonly step: number;
	readonly calls: readonly IToolCall[];
	readonly results: readonly IToolResult[];
	/** Assistant text produced this step. A step with neither text nor tools did nothing. */
	readonly assistantText: string;
	/** Distinct workspace paths mutated this step. */
	readonly filesChanged: number;
	readonly tokens?: { readonly input: number; readonly output: number };
	/** 0 = at the goal, 1 = no closer than the start. Supplied by the plan when there is one. */
	readonly goalDistance?: number;
	/** A previously passing check failed after the last edit. */
	readonly regression?: boolean;
}

export interface IProgressSignals {
	/** The workspace changed. */
	readonly stateChanged: boolean;
	/** 0..1 - share of this step's calls never made before in this run. */
	readonly novelty: number;
	/** 0..1 - knowledge gained: successful calls, new resources, errors cleared. */
	readonly forward: number;
	/** 0..1 - share of this step's calls that repeat an earlier call verbatim. */
	readonly repetition: number;
	/** 0..1 - share of this step's results that failed. */
	readonly errorRate: number;
	/** 0..1 - tokens burned since the last step that changed state or learned something. */
	readonly tokenWaste: number;
	/** 0..1 - A-B-A-B resource oscillation. */
	readonly oscillation: number;
	/** 0..1 - successful calls that taught nothing and changed nothing. */
	readonly toolWaste: number;
	/** 0..1 - remaining distance to the goal. */
	readonly goalDistance: number;
}

export interface IProgressReport {
	readonly step: number;
	/** 0..1. Below `BARREN_SCORE` the step counts as barren. */
	readonly score: number;
	readonly signals: IProgressSignals;
	/** Consecutive barren steps, including this one. */
	readonly barrenSteps: number;
	/** Enough barren steps in a row that the run should change approach. */
	readonly stuck: boolean;
	/** Three identical tool batches in a row. */
	readonly doomLoop: boolean;
	readonly errors: readonly IClassifiedError[];
	/** The dominant error class this step, if any. Drives strategy selection. */
	readonly dominantError?: ErrorClass;
	/** A previously passing check is now failing. */
	readonly regression: boolean;
	/** One line for the decision trace. */
	readonly reason: string;
}

export interface IProgressOptions {
	/** Barren steps in a row before `stuck` trips. */
	readonly stuckAfter?: number;
	/** Tokens of unproductive work that saturate `tokenWaste`. */
	readonly wasteBudget?: number;
}

const DEFAULTS = { stuckAfter: 3, wasteBudget: 60_000 } as const;

/** A step scoring at or below this learned nothing and changed nothing worth counting. */
const BARREN_SCORE = 0.25;

/**
 * Stateful across a run, deliberately: novelty and repetition are only meaningful relative to
 * what already happened. One tracker per run; `reset()` when the context is reset so a fresh
 * approach is not immediately judged against the abandoned one.
 */
export class ProgressTracker {

	private readonly seenCalls = new Set<string>();
	private readonly seenResources = new Set<string>();
	private readonly seenErrors = new Set<string>();
	private readonly recentResources: string[] = [];
	private doom: IDoomLoopState = { repeats: 0 };
	private barren = 0;
	private wastedTokens = 0;
	private previousErrorCount = 0;
	private readonly stuckAfter: number;
	private readonly wasteBudget: number;

	constructor(options: IProgressOptions = {}) {
		this.stuckAfter = options.stuckAfter ?? DEFAULTS.stuckAfter;
		this.wasteBudget = options.wasteBudget ?? DEFAULTS.wasteBudget;
	}

	observe(observation: IStepObservation): IProgressReport {
		const errors = this.classify(observation);

		// Waste is folded in before scoring so the reported signals describe the state *after*
		// this step: a productive step shows zero waste, not the waste it just cleared.
		const base = this.signalsFor(observation);
		this.wastedTokens = base.stateChanged || base.forward >= 0.5 ? 0 : this.wastedTokens + tokensOf(observation);
		const oscillation = this.oscillationOf(observation);
		const toolWaste = toolWasteOf(base, observation);
		const signals: IProgressSignals = {
			...base,
			tokenWaste: round2(clamp01(this.wastedTokens / this.wasteBudget)),
			oscillation,
			toolWaste,
			goalDistance: round2(clamp01(observation.goalDistance ?? (observation.filesChanged > 0 ? 0.4 : 0.7))),
		};
		const score = scoreOf(signals, observation);

		const doomCheck = recordToolBatch(this.doom, observation.calls);
		this.doom = doomCheck.state;

		this.barren = score <= BARREN_SCORE ? this.barren + 1 : 0;

		this.remember(observation, errors);

		return {
			step: observation.step,
			score,
			signals,
			barrenSteps: this.barren,
			stuck: this.barren >= this.stuckAfter,
			doomLoop: doomCheck.looping,
			errors,
			dominantError: dominant(errors),
			regression: !!observation.regression,
			reason: explain(signals, score, this.barren, doomCheck.looping, !!observation.regression),
		};
	}

	/** Drop the history so a deliberately different approach starts from a clean slate. */
	reset(): void {
		this.seenCalls.clear();
		this.seenResources.clear();
		this.seenErrors.clear();
		this.recentResources.length = 0;
		this.doom = { repeats: 0 };
		this.barren = 0;
		this.wastedTokens = 0;
		this.previousErrorCount = 0;
	}

	private classify(observation: IStepObservation): IClassifiedError[] {
		return observation.results.filter(result => result.isError).map(result => {
			const message = firstLine(result.text);
			const kind = classifyError(result.name, result.text);
			return {
				callId: result.callId,
				tool: result.name,
				class: kind,
				message,
				repeated: this.seenErrors.has(errorSignature(result.name, kind, message)),
			};
		});
	}

	private signalsFor(observation: IStepObservation): IProgressSignals {
		const calls = observation.calls;
		const results = observation.results;

		const keys = calls.map(toolCallKey);
		const fresh = keys.filter(key => !this.seenCalls.has(key)).length;
		const novelty = keys.length ? fresh / keys.length : 0;
		const repetition = keys.length ? 1 - novelty : 0;

		const resources = calls.map(resourceKey).filter(Boolean);
		const newResources = resources.filter(resource => !this.seenResources.has(resource)).length;
		const resourceNovelty = resources.length ? newResources / resources.length : 0;

		const failed = results.filter(result => result.isError).length;
		const errorRate = results.length ? failed / results.length : 0;
		const successRatio = results.length ? 1 - errorRate : (observation.assistantText.trim() ? 1 : 0);
		const errorsCleared = this.previousErrorCount > 0 && failed === 0 ? 1 : 0;

		return {
			stateChanged: observation.filesChanged > 0,
			novelty: round2(novelty),
			forward: round2(clamp01(0.5 * successRatio + 0.3 * resourceNovelty + 0.2 * errorsCleared)),
			repetition: round2(repetition),
			errorRate: round2(errorRate),
			tokenWaste: 0,
			oscillation: 0,
			toolWaste: 0,
			goalDistance: 0,
		};
	}

	/**
	 * Four alternating resources (A B A B) is oscillation. Two is just "tried something
	 * else"; four is the model bouncing between two dead ends.
	 */
	private oscillationOf(observation: IStepObservation): number {
		for (const call of observation.calls) {
			const resource = resourceKey(call);
			if (resource) {
				this.recentResources.push(resource);
			}
		}
		if (this.recentResources.length > 8) {
			this.recentResources.splice(0, this.recentResources.length - 8);
		}
		if (this.recentResources.length < 4) {
			return 0;
		}
		const tail = this.recentResources.slice(-4);
		return tail[0] === tail[2] && tail[1] === tail[3] && tail[0] !== tail[1] ? 1 : 0;
	}

	private remember(observation: IStepObservation, errors: readonly IClassifiedError[]): void {
		for (const call of observation.calls) {
			this.seenCalls.add(toolCallKey(call));
			const resource = resourceKey(call);
			if (resource) {
				this.seenResources.add(resource);
			}
		}
		for (const error of errors) {
			this.seenErrors.add(errorSignature(error.tool, error.class, error.message));
		}
		this.previousErrorCount = errors.length;
	}
}

// --- scoring ------------------------------------------------------------------------------------

/**
 * Weights, and why: mutating the workspace is the only thing a coding run is ultimately for, so
 * it dominates. Novelty is weighted lightly because a model can generate novel-but-useless calls
 * indefinitely. Waste is subtracted rather than floored so a long unproductive stretch keeps
 * pushing the score down even while individual steps look busy.
 */
function scoreOf(signals: IProgressSignals, observation: IStepObservation): number {
	// A step that answered in prose and asked for nothing is the terminal step of a chat turn.
	if (!observation.calls.length) {
		return observation.assistantText.trim() ? 1 : 0;
	}
	const positive =
		0.40 * (signals.stateChanged ? 1 : 0) +
		0.35 * signals.forward +
		0.15 * signals.novelty +
		0.10 * (1 - signals.repetition);
	const penalty = 0.25 * signals.errorRate + 0.20 * signals.tokenWaste;
	return round2(clamp01(positive - penalty));
}

function toolWasteOf(signals: IProgressSignals, observation: IStepObservation): number {
	if (!observation.results.length) {
		return 0;
	}
	const useless = observation.results.filter(result => !result.isError).length;
	if (!useless) {
		return 0;
	}
	if (signals.stateChanged || signals.novelty >= 0.5) {
		return 0;
	}
	return round2(clamp01(useless / observation.results.length));
}

function explain(signals: IProgressSignals, score: number, barren: number, doomLoop: boolean, regression: boolean): string {
	if (doomLoop) {
		return 'Identical tool batch three times in a row.';
	}
	if (regression) {
		return 'A previously passing check is now failing.';
	}
	if (signals.oscillation >= 1) {
		return 'Oscillating between the same two resources.';
	}
	if (signals.stateChanged) {
		return `Changed the workspace (score ${score}).`;
	}
	if (barren >= 2) {
		return `${barren} steps without a change or a new result (score ${score}).`;
	}
	if (signals.errorRate >= 0.5) {
		return `Most calls this step failed (score ${score}).`;
	}
	if (signals.repetition >= 0.5) {
		return `Half or more of this step repeated earlier calls (score ${score}).`;
	}
	return `Exploring (score ${score}).`;
}

/** The class to act on: the most common, breaking ties toward the most specific. */
function dominant(errors: readonly IClassifiedError[]): ErrorClass | undefined {
	if (!errors.length) {
		return undefined;
	}
	const counts = new Map<ErrorClass, number>();
	for (const error of errors) {
		counts.set(error.class, (counts.get(error.class) ?? 0) + 1);
	}
	const ranked = [...counts].sort((a, b) => b[1] - a[1] || specificity(b[0]) - specificity(a[0]));
	return ranked[0][0];
}

const SPECIFICITY: readonly ErrorClass[] = ['unknown', 'transient', 'conflict', 'environment', 'permission', 'not-found', 'invalid-args', 'syntax', 'assertion', 'cancelled'];

function specificity(kind: ErrorClass): number {
	return SPECIFICITY.indexOf(kind);
}

// --- helpers -------------------------------------------------------------------------------------

/**
 * What the call acted on, independent of how it was parameterised. Reading `a.ts` at offset 0 and
 * at offset 200 are the same resource, so the second read is not novel.
 */
function resourceKey(call: IToolCall): string {
	const value = pickString(call.args, 'path', 'file', 'file_path', 'directory', 'command', 'cmd', 'url', 'pattern', 'query', 'q');
	return value ? `${call.name}\0${value}` : '';
}

/**
 * Two failures count as the same when only their operands differ. A model that guesses `a.ts`,
 * then `b.ts`, then `c.ts` is making one mistake three times, and masking the operands is what
 * lets the recovery controller see that instead of three unrelated misses.
 */
function errorSignature(tool: string, kind: ErrorClass, message: string): string {
	const shape = message
		.replace(/['"`][^'"`]*['"`]/g, '<s>')
		.replace(/\S*\/\S*/g, '<p>')
		.replace(/\b[\w-]+\.[a-z]{1,5}\b/gi, '<f>')
		.replace(/\d+/g, '#');
	return `${tool}\0${kind}\0${shape.slice(0, 120)}`;
}

function tokensOf(observation: IStepObservation): number {
	return (observation.tokens?.input ?? 0) + (observation.tokens?.output ?? 0);
}

function firstLine(text: string): string {
	return (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 200);
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
