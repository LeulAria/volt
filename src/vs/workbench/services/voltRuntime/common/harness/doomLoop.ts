/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../../../base/common/hash.js';
import { asRecord, pickString, pickStringAllowEmpty } from '../tools/args.js';
import type { IToolCall } from '../tools/tool.js';
import type { ErrorClass } from './progress.js';
import type { ToolKind } from './workLog.js';

const DEFAULT_THRESHOLD = 3;

export interface IDoomLoopState {
	lastKey?: string;
	repeats: number;
}

export function toolCallKey(call: IToolCall): string {
	return `${call.name}\0${stableJson(call.args)}`;
}

export function batchKey(calls: readonly IToolCall[]): string {
	return calls.map(toolCallKey).join('\n');
}

/**
 * Three identical consecutive tool batches (same names + arguments) is a doom loop. Kept for the
 * progress tracker; the live loops use `LoopDetector`, which also looks at what came back.
 */
export function recordToolBatch(state: IDoomLoopState, calls: readonly IToolCall[], threshold = DEFAULT_THRESHOLD): { state: IDoomLoopState; looping: boolean } {
	if (!calls.length) {
		return { state: { repeats: 0 }, looping: false };
	}
	const key = batchKey(calls);
	if (state.lastKey === key) {
		const repeats = state.repeats + 1;
		return { state: { lastKey: key, repeats }, looping: repeats >= threshold };
	}
	return { state: { lastKey: key, repeats: 1 }, looping: false };
}

//#region Loop detector

/**
 * Loop detection for both engines (native loop and ACP agents). Pure: it sees normalised records of
 * what each step did and answers `ok`, `warn` (with a corrective message for the model) or `stop`
 * (with a reason for the user), always with the steps that make up the pattern.
 *
 * Design rules, from what Cursor gets wrong (`Cursor SS/v3/loop-extremes`): Cursor only kills a
 * single message that repeats ~100 characters, with a dead-end error, and lets 100 identical tool
 * calls through. Volt looks across steps, nudges first and stops only when the nudge was ignored,
 * and judges repetition by *result*: calling something again is only a loop when nothing changed
 * in between and the same thing came back. Polling tools, re-reads after an edit, re-runs after a
 * fix and repetition the user asked for are never counted.
 */

export type LoopEffect = 'read' | 'write' | 'exec' | 'wait' | 'other';

/** One tool call, normalised. Build it with `loopCallRecord` (or `toLoopStep` in progress.ts). */
export interface ILoopCallRecord {
	readonly tool: string;
	/** Exact identity: tool plus canonical (sorted-key) JSON arguments, hashed. */
	readonly callKey: string;
	/** Near-duplicate identity: like `callKey` with whitespace collapsed and numbers masked. */
	readonly shapeKey: string;
	readonly ok: boolean;
	/** What came back, with volatile parts (durations, timestamps, ids) masked, hashed. */
	readonly resultKey: string;
	/**
	 * Errors only. Commands: the whole error output with source positions masked ("same failing
	 * command, same failure"). Other tools: the salient line with operands masked ("same mistake").
	 */
	readonly errorKey?: string;
	readonly errorClass?: ErrorClass;
	/** Salient error line, for messages. */
	readonly errorLine?: string;
	readonly effect: LoopEffect;
	/** Workspace path read or written. */
	readonly file?: string;
	/** Writes: hashes of the replaced and the new text (edits) or of the new content (writes). */
	readonly change?: { readonly from?: string; readonly to: string };
	/** The main argument (command, path, query, url), so a request that names it marks repeats as intended. */
	readonly primary?: string;
	/** Short label for people and for the nudge: `read_file src/a.ts`, `shell \`npm test\``. */
	readonly label: string;
}

export interface ILoopStepRecord {
	readonly step: number;
	readonly calls: readonly ILoopCallRecord[];
	/** Assistant text of the step. */
	readonly text?: string;
}

/** Raw input for `loopCallRecord`. ACP callers map `tool_call` / `tool_call_update` into this. */
export interface ILoopCallInput {
	readonly tool: string;
	readonly args: unknown;
	readonly ok: boolean;
	/** Result or error text as the model saw it. */
	readonly text: string;
	readonly kind?: ToolKind;
	readonly file?: string;
	/** Hashes from `loopHash`; derived from edit/write arguments when omitted. */
	readonly change?: { readonly from?: string; readonly to: string };
	readonly errorClass?: ErrorClass;
}

export type LoopSignal = 'repeat' | 'near-repeat' | 'oscillation' | 'repeated-error' | 'no-progress' | 'text-repeat' | 'runaway';

export interface ITextRepeat {
	/** The repeating unit. */
	readonly unit: string;
	readonly repeats: number;
	/** Offset in the checked text where the repetition starts. */
	readonly start: number;
	readonly length: number;
}

export interface ILoopFinding {
	readonly signal: LoopSignal;
	/** What repeated: a call label, a file, an error line, or a text excerpt. */
	readonly subject: string;
	readonly count: number;
	/** Steps that make up the pattern, oldest first. */
	readonly evidence: readonly number[];
	/** One English line for the trace. */
	readonly reason: string;
	/** `runaway` only: where the streamed text started repeating. */
	readonly text?: ITextRepeat;
}

export type LoopVerdict =
	| { readonly kind: 'ok' }
	| (ILoopFinding & { readonly kind: 'warn'; /** Corrective user-role message for the model. */ readonly nudge: string })
	| (ILoopFinding & { readonly kind: 'stop' });

export interface ILoopThreshold {
	readonly warn: number;
	readonly stop: number;
}

export interface ILoopDetectorOptions {
	/**
	 * The user's request. When it asks for repetition ("30 times", "repeatedly"), a call whose main
	 * argument it names (`run echo ping 30 times`) may repeat without being flagged.
	 */
	readonly request?: string;
	/** Identical call, identical result, nothing written in between. */
	readonly repeat?: ILoopThreshold;
	/** Same call modulo whitespace and numbers, identical result. */
	readonly nearRepeat?: ILoopThreshold;
	/** Reverts of an earlier change to the same file (2 = re-applied after a revert). */
	readonly oscillation?: ILoopThreshold;
	/** Same error from the same tool, across attempts. */
	readonly repeatedError?: ILoopThreshold;
	/** Consecutive steps that learned nothing new and changed nothing. */
	readonly noProgress?: ILoopThreshold;
	/** Identical non-trivial assistant text on steps that learned nothing. */
	readonly textRepeat?: ILoopThreshold;
	/** Polling tools (job_wait, sleep loops): same call, same result. */
	readonly wait?: ILoopThreshold;
	readonly runaway?: Partial<IRunawayOptions>;
	/** Class-specific advice appended to the repeated-error nudge (recovery.ts `errorGuidance`). */
	readonly guidance?: (errorClass: ErrorClass | undefined, detail: string) => string | undefined;
}

export interface IRunawayOptions {
	/** The repeated run must be at least this long, in characters. */
	readonly minChars: number;
	readonly minRepeats: number;
	/** Longest unit considered, in characters. */
	readonly maxUnit: number;
}

export const DEFAULT_LOOP_THRESHOLDS = {
	repeat: { warn: 3, stop: 5 },
	nearRepeat: { warn: 4, stop: 7 },
	oscillation: { warn: 2, stop: 4 },
	repeatedError: { warn: 3, stop: 6 },
	noProgress: { warn: 6, stop: 10 },
	textRepeat: { warn: 3, stop: 5 },
	wait: { warn: 12, stop: 24 },
	runaway: { minChars: 1_500, minRepeats: 6, maxUnit: 500 },
} as const;

/** Text the user may legitimately ask to be repeated (a sentence N times) is allowed up to this. */
const REQUESTED_TEXT_CHARS = 20_000;
const MIN_REPEATED_TEXT = 80;
const MIN_INTENT_CHARS = 4;
const REPETITION_CUE = /\b\d+\s*(?:times|x)\b|\b(?:twice|thrice|(?:two|three|four|five|six|seven|eight|nine|ten|several|many|multiple|a few) times)\b|\brepeat(?:edly|ing)?\b|\bin a loop\b|\bseparate (?:tool )?calls\b/i;
const OK: LoopVerdict = { kind: 'ok' };

/** Order in which findings of the same step are reported: the most specific diagnosis first. */
const PRIORITY: readonly LoopSignal[] = ['oscillation', 'repeated-error', 'repeat', 'near-repeat', 'no-progress', 'text-repeat'];

interface IRepeatEntry {
	world: number;
	steps: number[];
	callKeys: Set<string>;
	record: ILoopCallRecord;
}

interface IFileHistory {
	states: Set<string>;
	last?: string;
	changes: { from: string; to: string; step: number }[];
	flips: number[];
}

/**
 * One per run (or per ACP prompt turn). `observe` after each step's tools finished; `checkText`
 * while a reply streams. Escalation is per pattern: one nudge, then a stop if it continues.
 */
export class LoopDetector {

	private readonly options: ILoopDetectorOptions;
	private readonly request: string;
	private world = 0;
	private readonly files = new Map<string, IFileHistory>();
	private readonly written = new Set<string>();
	private readonly exact = new Map<string, IRepeatEntry>();
	private readonly shapes = new Map<string, IRepeatEntry>();
	private readonly errors = new Map<string, { steps: number[]; record: ILoopCallRecord }>();
	private readonly seen = new Set<string>();
	private readonly texts = new Map<string, number[]>();
	private barren: number[] = [];
	private readonly warned = new Set<string>();
	private runaways = 0;

	constructor(options: ILoopDetectorOptions = {}) {
		this.options = options;
		// Only a request that asks for repetition ("30 times", "repeatedly") makes a named call intended.
		this.request = REPETITION_CUE.test(options.request ?? '') ? normalizeIntent(options.request ?? '') : '';
	}

	observe(step: ILoopStepRecord): LoopVerdict {
		const findings: ILoopFinding[] = [];
		let considered = 0;
		let learned = false;
		const counted = new Set<string>();

		for (const record of step.calls) {
			const intended = this.isIntended(record);
			const neutral = intended || record.effect === 'wait';
			if (!neutral) {
				considered++;
			}
			const novel = this.isNovel(record);
			if (novel && !neutral) {
				learned = true;
			}
			this.remember(record);

			if (record.ok && record.effect === 'write') {
				const change = this.trackChange(step.step, record);
				if (change.fresh) {
					learned = true;
				}
				if (change.flip) {
					findings.push(change.flip);
				}
				if (!intended) {
					findings.push(this.repeatFinding(this.count(this.exact, `${record.callKey}\0${record.resultKey}`, step.step, record, counted)));
				}
				continue;
			}

			// Polling fails the same way until the thing it waits for is ready; it has its own limits.
			if (!record.ok && record.errorKey && record.effect !== 'wait') {
				const key = `${record.tool}\0${record.errorKey}`;
				if (!counted.has(key)) {
					counted.add(key);
					const entry = this.errors.get(key) ?? { steps: [], record };
					entry.steps.push(step.step);
					entry.record = record;
					this.errors.set(key, entry);
					findings.push(this.errorFinding(entry.record, entry.steps));
				}
			}

			if (!intended) {
				const exact = this.count(this.exact, `${record.callKey}\0${record.resultKey}`, step.step, record, counted);
				findings.push(this.repeatFinding(exact));
				const shape = this.count(this.shapes, `${record.shapeKey}\0${record.resultKey}`, step.step, record, counted);
				if (shape.callKeys.size > 1) {
					findings.push({
						signal: 'near-repeat',
						subject: record.tool,
						count: shape.steps.length,
						evidence: shape.steps.slice(),
						reason: `${record.tool} was called ${shape.steps.length} times with nearly the same arguments and the same result.`,
					});
				}
			}
		}

		if (considered) {
			if (learned) {
				this.barren = [];
			} else {
				this.barren.push(step.step);
				findings.push({
					signal: 'no-progress',
					subject: `no progress since step ${this.barren[0]}`,
					count: this.barren.length,
					evidence: this.barren.slice(),
					reason: `${this.barren.length} steps in a row produced no new information and changed nothing.`,
				});
				const text = normalizeText(step.text ?? '');
				if (text.length >= MIN_REPEATED_TEXT) {
					const key = loopHash(text);
					const steps = this.texts.get(key) ?? [];
					steps.push(step.step);
					this.texts.set(key, steps);
					findings.push({
						signal: 'text-repeat',
						subject: excerpt(text, 60),
						count: steps.length,
						evidence: steps.slice(),
						reason: `The same message was written ${steps.length} times without progress.`,
					});
				}
			}
		}

		return this.grade(findings);
	}

	/**
	 * Checks streamed text (a reply or its reasoning) for a runaway repetition at its end. The first
	 * hit is a `warn`: the caller cuts the stream and sends `nudge`. A later hit in the same run stops.
	 */
	checkText(text: string): LoopVerdict {
		const runaway = this.runawayOptions();
		const found = findRepeatedText(text, runaway);
		if (!found || found.length < Math.max(runaway.minChars, requestedAllowance(found.unit, this.options.request ?? ''))) {
			return OK;
		}
		this.runaways++;
		const unit = excerpt(found.unit.replace(/\s+/g, ' ').trim() || found.unit, 40);
		const finding: ILoopFinding = {
			signal: 'runaway',
			subject: unit,
			count: found.repeats,
			evidence: [],
			reason: `The reply repeated "${unit}" ${found.repeats} times (${found.length} characters).`,
			text: found,
		};
		if (this.runaways > 1) {
			return { kind: 'stop', ...finding };
		}
		return {
			kind: 'warn',
			...finding,
			nudge: `Your last reply started repeating the same text ("${unit}" ${found.repeats} times) and was cut off there. Do not repeat it. Continue from before the repetition. If the user asked for repeated output, write it to a file with a tool instead of the chat.`,
		};
	}

	/** Forget everything, for a deliberately fresh approach (a new user turn on a kept detector). */
	reset(): void {
		this.world = 0;
		this.files.clear();
		this.written.clear();
		this.exact.clear();
		this.shapes.clear();
		this.errors.clear();
		this.seen.clear();
		this.texts.clear();
		this.barren = [];
		this.warned.clear();
		this.runaways = 0;
	}

	private runawayOptions(): IRunawayOptions {
		return { ...DEFAULT_LOOP_THRESHOLDS.runaway, ...this.options.runaway };
	}

	private threshold(signal: LoopSignal, record?: ILoopCallRecord): ILoopThreshold {
		const o = this.options;
		const d = DEFAULT_LOOP_THRESHOLDS;
		switch (signal) {
			case 'repeat': return record?.effect === 'wait' ? o.wait ?? d.wait : o.repeat ?? d.repeat;
			case 'near-repeat': return record?.effect === 'wait' ? o.wait ?? d.wait : o.nearRepeat ?? d.nearRepeat;
			case 'oscillation': return o.oscillation ?? d.oscillation;
			case 'repeated-error': return o.repeatedError ?? d.repeatedError;
			case 'no-progress': return o.noProgress ?? d.noProgress;
			case 'text-repeat': return o.textRepeat ?? d.textRepeat;
			default: return { warn: 1, stop: 2 };
		}
	}

	private isIntended(record: ILoopCallRecord): boolean {
		const primary = record.primary ? normalizeIntent(record.primary) : '';
		return primary.length >= MIN_INTENT_CHARS && !!this.request && this.request.includes(primary);
	}

	/** Whether this record told the model something it has not seen in this run. */
	private isNovel(record: ILoopCallRecord): boolean {
		if (record.ok && record.effect === 'write') {
			return false; // judged by `trackChange`
		}
		const key = record.ok ? `${record.tool}\0ok\0${record.resultKey}` : `${record.tool}\0err\0${record.errorKey ?? record.resultKey}`;
		return !this.seen.has(key);
	}

	private remember(record: ILoopCallRecord): void {
		if (record.ok && record.effect === 'write') {
			return;
		}
		this.seen.add(record.ok ? `${record.tool}\0ok\0${record.resultKey}` : `${record.tool}\0err\0${record.errorKey ?? record.resultKey}`);
	}

	/**
	 * A successful write. A new file state advances the world, so repeats from before it no longer
	 * count; the reverse of an earlier change on the same file is a flip.
	 */
	private trackChange(step: number, record: ILoopCallRecord): { fresh: boolean; flip?: ILoopFinding } {
		const file = record.file ?? record.label;
		if (!this.written.has(file)) {
			// New ground: earlier failures were about a smaller program.
			this.written.add(file);
			this.errors.clear();
		}
		const change = record.change;
		if (!change) {
			this.world++;
			return { fresh: true };
		}
		const history = this.files.get(file) ?? { states: new Set<string>(), changes: [], flips: [] };
		this.files.set(file, history);
		const fresh = !history.states.has(change.to);
		if (fresh) {
			history.states.add(change.to);
			this.world++;
		}
		const from = change.from ?? history.last;
		let flip: ILoopFinding | undefined;
		if (from !== undefined && from !== change.to) {
			if (history.changes.some(previous => previous.from === change.to && previous.to === from)) {
				history.flips.push(step);
				const involved = history.changes
					.filter(previous => (previous.from === from && previous.to === change.to) || (previous.from === change.to && previous.to === from))
					.map(previous => previous.step);
				flip = {
					signal: 'oscillation',
					subject: file,
					count: history.flips.length,
					evidence: [...new Set([...involved, step])].sort((a, b) => a - b),
					reason: `${file} was changed back and forth ${history.flips.length + 1} times.`,
				};
			}
			history.changes.push({ from, to: change.to, step });
		}
		history.last = change.to;
		return { fresh, ...(flip ? { flip } : {}) };
	}

	/** Counts a record once per step; resets when the world moved since the entry started. */
	private count(map: Map<string, IRepeatEntry>, key: string, step: number, record: ILoopCallRecord, counted: Set<string>): IRepeatEntry {
		let entry = map.get(key);
		if (!entry || entry.world !== this.world) {
			entry = { world: this.world, steps: [], callKeys: new Set(), record };
			map.set(key, entry);
		}
		entry.callKeys.add(record.callKey);
		const once = `${map === this.exact ? 'x' : 's'}\0${key}`;
		if (!counted.has(once) && entry.steps.at(-1) !== step) {
			counted.add(once);
			entry.steps.push(step);
		}
		entry.record = record;
		return entry;
	}

	private repeatFinding(entry: IRepeatEntry): ILoopFinding {
		const count = entry.steps.length;
		return {
			signal: 'repeat',
			subject: entry.record.label,
			count,
			evidence: entry.steps.slice(),
			reason: entry.record.effect === 'write'
				? `The same change (${entry.record.label}) was applied ${count} times.`
				: `${entry.record.label} ran ${count} times with the same result and nothing changed in between.`,
		};
	}

	private errorFinding(record: ILoopCallRecord, steps: readonly number[]): ILoopFinding {
		return {
			signal: 'repeated-error',
			subject: record.errorLine || record.label,
			count: steps.length,
			evidence: steps.slice(),
			reason: `${record.label} failed the same way ${steps.length} times: ${record.errorLine || 'same error'}.`,
		};
	}

	private grade(findings: readonly ILoopFinding[]): LoopVerdict {
		let warn: ILoopFinding | undefined;
		let stop: ILoopFinding | undefined;
		for (const signal of PRIORITY) {
			for (const finding of findings) {
				if (finding.signal !== signal) {
					continue;
				}
				const record = this.recordFor(finding);
				const limit = this.threshold(signal, record);
				const id = `${signal}\0${finding.subject}`;
				if (!stop && finding.count >= limit.stop && this.warned.has(id)) {
					stop = finding;
				} else if (!warn && finding.count >= limit.warn && !this.warned.has(id)) {
					warn = finding;
				}
			}
		}
		if (stop) {
			return { kind: 'stop', ...stop };
		}
		if (warn) {
			this.warned.add(`${warn.signal}\0${warn.subject}`);
			return { kind: 'warn', ...warn, nudge: this.nudgeFor(warn) };
		}
		return OK;
	}

	private recordFor(finding: ILoopFinding): ILoopCallRecord | undefined {
		if (finding.signal !== 'repeat' && finding.signal !== 'near-repeat') {
			return undefined;
		}
		for (const entry of [...this.exact.values(), ...this.shapes.values()]) {
			if (entry.record.label === finding.subject || entry.record.tool === finding.subject) {
				return entry.record;
			}
		}
		return undefined;
	}

	/**
	 * The corrective message. Each names what was observed, with step numbers, and prescribes a
	 * concrete next move, including the honest exit: stop and say what blocks you.
	 */
	private nudgeFor(finding: ILoopFinding): string {
		const steps = `steps ${finding.evidence.join(', ')}`;
		const exit = 'If you cannot make progress, stop and tell the user exactly what is blocking you.';
		switch (finding.signal) {
			case 'repeat': {
				const record = this.recordFor(finding);
				if (record?.effect === 'write') {
					return `You applied the same change (${finding.subject}) ${finding.count} times (${steps}). Something may be undoing it, such as a watcher, formatter, build step, or git hook. Find what changes the file instead of re-applying the edit. ${exit}`;
				}
				return `You called ${finding.subject} ${finding.count} times (${steps}) and got the same result each time, with nothing changed in between. Calling it again will not change the result. Use what it returned, or take a different approach. ${exit}`;
			}
			case 'near-repeat':
				return `You keep calling ${finding.subject} with nearly the same arguments (only whitespace or numbers differ) and getting the same result (${steps}). Small variations will not help. Re-read the last result and change approach. ${exit}`;
			case 'oscillation':
				return `You have changed ${finding.subject} back and forth (${steps}). Stop flipping between versions. Decide from evidence (the tests, the request) which one is right, say why in one line, and keep it. If two requirements conflict, stop and explain the conflict to the user.`;
			case 'repeated-error': {
				const record = [...this.errors.values()].find(entry => (entry.record.errorLine || entry.record.label) === finding.subject)?.record;
				const advice = this.options.guidance?.(record?.errorClass, finding.subject);
				return [
					`The same failure came back ${finding.count} times (${steps}): ${finding.subject}.`,
					advice ?? 'Read the error again and question your assumption about its cause.',
					'Do not retry it with small variations. If you are deliberately building toward a fix across several files, say so in one line and continue.',
					exit,
				].join(' ');
			}
			case 'no-progress':
				return `The last ${finding.count} steps (${steps}) produced no new information and changed nothing. Stop the current approach. In one short paragraph: what you know, what you tried, and the different angle you will take. Then take that different action, and do not repeat calls you already made. ${exit}`;
			case 'text-repeat':
				return `You have written the same message ${finding.count} times (${steps}) without making progress. Do something different, or finish and report what you found. ${exit}`;
			default:
				return exit;
		}
	}
}

/** Normalises one tool call for the detector. */
export function loopCallRecord(input: ILoopCallInput): ILoopCallRecord {
	const effect = loopEffect(input.tool, input.kind, input.args);
	const args = stableJson(input.args);
	const file = input.file ?? pickString(input.args, 'path', 'file', 'file_path', 'filePath', 'target_file', 'notebook_path');
	const primary = pickString(input.args, 'command', 'cmd', 'path', 'file', 'file_path', 'filePath', 'target_file', 'url', 'query', 'q', 'pattern');
	const volatile = maskVolatile(input.text);
	const strict = maskPositions(volatile);
	const errorLine = input.ok ? undefined : salientLine(input.text);
	const change = input.change ?? (effect === 'write' ? changeFromArgs(input.args) : undefined);
	return {
		tool: input.tool,
		callKey: loopHash(`${input.tool}\0${args}`),
		shapeKey: loopHash(`${input.tool}\0${args.replace(/(?:\\[nrt]|\s)+/g, ' ').replace(/\d+/g, '#')}`),
		ok: input.ok,
		resultKey: loopHash(input.ok ? volatile : strict),
		...(input.ok ? {} : {
			errorKey: loopHash(effect === 'exec' ? strict : errorShape(errorLine ?? '')),
			...(errorLine ? { errorLine } : {}),
			...(input.errorClass ? { errorClass: input.errorClass } : {}),
		}),
		effect,
		...(file ? { file } : {}),
		...(change ? { change } : {}),
		...(primary ? { primary } : {}),
		label: callLabel(input.tool, input.tool === 'shell' || effect === 'exec' ? pickString(input.args, 'command', 'cmd') ?? primary : primary),
	};
}

/** Short stable hash (32-bit plus length) for keys; collisions need equal length too. */
export function loopHash(text: string): string {
	return `${(stringHash(text, 0) >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * The repetition at the end of `text`, if its last `minChars` characters are one unit (up to
 * `maxUnit` long) repeated at least `minRepeats` times. Linear: one prefix-function pass over the
 * window, then a walk back to where the run started.
 */
export function findRepeatedText(text: string, options: Partial<IRunawayOptions> = {}): ITextRepeat | undefined {
	const { minChars, minRepeats, maxUnit } = { ...DEFAULT_LOOP_THRESHOLDS.runaway, ...options };
	if (text.length < minChars) {
		return undefined;
	}
	const window = text.slice(text.length - minChars);
	const period = smallestPeriod(window);
	if (period > maxUnit || window.length / period < minRepeats) {
		return undefined;
	}
	let start = text.length - window.length;
	while (start > 0 && text.charCodeAt(start - 1) === text.charCodeAt(start - 1 + period)) {
		start--;
	}
	const length = text.length - start;
	return { unit: text.slice(start, start + period), repeats: Math.floor(length / period), start, length };
}

/** Effect of a call from its kind, falling back to its name. Polling is recognised by name or command. */
export function loopEffect(tool: string, kind: ToolKind | undefined, args: unknown): LoopEffect {
	if (/^(?:job_wait|job_output|await_answers|await_?shell|browser_wait_for|wait|sleep)$/i.test(tool)) {
		return 'wait';
	}
	const command = pickString(args, 'command', 'cmd');
	if (command && /(?:^|[;&|(]\s*)(?:sleep\s+\d|wait-on\b|until\b)/.test(command)) {
		return 'wait';
	}
	switch (kind) {
		case 'read': case 'search': case 'fetch': case 'browser': return 'read';
		case 'edit': return 'write';
		case 'execute': return 'exec';
		case 'think': case 'delegate': return 'other';
	}
	if (/edit|write|replace|delete|create|patch|rename|move/i.test(tool)) {
		return 'write';
	}
	if (/shell|exec|terminal|bash|command/i.test(tool)) {
		return 'exec';
	}
	if (/read|grep|glob|search|list|find|fetch|ls|view/i.test(tool)) {
		return 'read';
	}
	return 'other';
}

function changeFromArgs(args: unknown): { from?: string; to: string } | undefined {
	const record = asRecord(args);
	const edits = Array.isArray(record.edits) ? record.edits.map(asRecord) : [record];
	const news = edits.map(edit => pickStringAllowEmpty(edit, 'new_string', 'newString', 'new_str', 'new_text'));
	if (news.some(text => text !== undefined)) {
		const olds = edits.map(edit => pickStringAllowEmpty(edit, 'old_string', 'oldString', 'old_str', 'old_text') ?? '');
		return { from: loopHash(olds.join('\0')), to: loopHash(news.map(text => text ?? '').join('\0')) };
	}
	const content = pickStringAllowEmpty(args, 'contents', 'content', 'file_text', 'text');
	return content !== undefined ? { to: loopHash(content) } : undefined;
}

function callLabel(tool: string, primary: string | undefined): string {
	if (!primary) {
		return tool;
	}
	const shown = excerpt(primary.replace(/\s+/g, ' ').trim(), 60);
	return /\s/.test(shown) || tool === 'shell' ? `${tool} \`${shown.replace(/`/g, '\'')}\`` : `${tool} ${shown}`;
}

/** Durations, timestamps, ids, job ids, and ledger step numbers differ between identical runs. */
function maskVolatile(text: string): string {
	return text
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
		.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
		.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
		.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|min)\b/g, '<dur>')
		.replace(/\bstep \d+\b/gi, 'step #')
		.replace(/\bpid[ =:]?\d+/gi, 'pid #')
		.replace(/[ \t]+$/gm, '')
		.trim();
}

/** Source positions move when code is edited; the failure is the same. */
function maskPositions(text: string): string {
	return text
		.replace(/:\d+(?::\d+)?\b/g, ':#')
		.replace(/\blines? \d+(?:\s*[-\u2013,]\s*\d+)*/gi, 'line #')
		.replace(/\(\d+,\s*\d+\)/g, '(#,#)');
}

/**
 * Two failures are the same mistake when only their operands differ: guessing `a.ts`, then `b.ts`,
 * then `c.ts` is one error made three times. Shared with progress.ts.
 */
export function errorShape(message: string): string {
	return message
		.replace(/['"`][^'"`]*['"`]/g, '<s>')
		.replace(/\S*\/\S*/g, '<p>')
		.replace(/\b[\w-]+\.[a-z]{1,5}\b/gi, '<f>')
		.replace(/\d+/g, '#')
		.slice(0, 120);
}

const ERROR_LINE = /error|fail|exception|assert|cannot|can't|not found|no such|denied|refused|invalid|unexpected|missing|\u2716|\u2717|panic|traceback/i;

/** The line that says what went wrong: not the echoed command, not the exit status. */
export function salientLine(text: string): string {
	const lines = text.split('\n').map(line => line.trim()).filter(line => line && !/^\$ /.test(line) && !/^\[(?:exit|timed out|cancelled|running|output was long)/i.test(line));
	const line = lines.find(candidate => ERROR_LINE.test(candidate)) ?? lines[0] ?? '';
	return line.slice(0, 160);
}

function smallestPeriod(text: string): number {
	const n = text.length;
	const prefix = new Int32Array(n);
	for (let i = 1; i < n; i++) {
		let k = prefix[i - 1];
		while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) {
			k = prefix[k - 1];
		}
		if (text.charCodeAt(i) === text.charCodeAt(k)) {
			k++;
		}
		prefix[i] = k;
	}
	return n - (n ? prefix[n - 1] : 0);
}

/**
 * How much repetition of `unit` the user's own request accounts for: twice the longest run of the
 * same period in the request (copy this string), or a generous cap when the request contains the
 * unit itself (write this sentence N times).
 */
function requestedAllowance(unit: string, request: string): number {
	if (!request) {
		return 0;
	}
	const trimmed = unit.trim();
	if (trimmed.length >= 12 && normalizeText(request).includes(normalizeText(trimmed))) {
		return REQUESTED_TEXT_CHARS;
	}
	const period = unit.length;
	let best = 0;
	let run = 0;
	for (let i = 0; i + period < request.length; i++) {
		run = request.charCodeAt(i) === request.charCodeAt(i + period) ? run + 1 : 0;
		best = Math.max(best, run);
	}
	return best ? 2 * (best + period) : 0;
}

function normalizeIntent(text: string): string {
	return text.toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function excerpt(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

//#endregion

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(sortValue(value)) ?? String(value);
	} catch {
		return String(value);
	}
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			out[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}
