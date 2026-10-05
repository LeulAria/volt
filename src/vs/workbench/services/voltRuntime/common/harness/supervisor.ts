/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltEvent, IVoltToolDiff } from '../events.js';
import type { ToolKind } from './workLog.js';
import { toolCallKey } from './doomLoop.js';
import { BudgetMeter, IResourceBudget, isBounded, ResourceGovernor, unlimitedBudget } from './governor.js';

/**
 * Run supervisor: judges a run from the normalised `IVoltEvent` stream, so ACP agents and the
 * native loop can share it. It is pure (no timers, no I/O): feed it events, act on the directives.
 *
 * - Loops: the same failing call again and again, the same edit failing on the same file with
 *   different arguments, A/B oscillation, and the same call returning the same result in a row.
 *   Cursor has no cross-step detector at all (100 identical `cat` calls passed, loop-extremes 1e).
 * - Budgets: wall clock and tool calls per run through {@link ResourceGovernor}. Cursor has none
 *   (a "never stop improving" run went 40 min / 237 calls).
 * - Test gaming: product code that sniffs the call stack or the test runner (both harnesses did
 *   this on the contradictory-test trap).
 *
 * Normal edit -> test -> fix cycles are safe by construction: a loop needs an *identical* outcome
 * (normalised for timings and ids), and test output changes as soon as a fix changes anything.
 */

export type SupervisorDirective =
	/** Show the user something; the run continues. */
	| { readonly kind: 'notice'; readonly severity: 'info' | 'warning'; readonly title: string; readonly description?: string }
	/** Interrupt the agent and send `text` as a corrective prompt. `title`/`description` explain it to the user. */
	| { readonly kind: 'steer'; readonly text: string; readonly title: string; readonly description: string; readonly signal: ILoopSignal }
	/** End the run. */
	| { readonly kind: 'stop'; readonly reason: 'loop' | 'budget'; readonly message: string; readonly retryable: boolean; readonly meter?: BudgetMeter; readonly signal?: ILoopSignal };

/** Notice titles the UI can key on (WP6 looping tray). */
export const LOOP_NOTICE_TITLE = 'Agent looping detected';
export const BUDGET_NOTICE_TITLE = 'Run budget';
export const TEST_GAMING_NOTICE_TITLE = 'Possible test special-casing';

// --- Loop detection ------------------------------------------------------------------------

/** One finished tool call, reduced to what loop detection compares. */
export interface ISupervisedCall {
	/** Tool identity without arguments (`execute`, `edit`, `read_file`). */
	readonly tool: string;
	/** Identity plus stable arguments: equal keys are the same call. */
	readonly key: string;
	/** The file the call works on, when known. */
	readonly target?: string;
	readonly failed: boolean;
	/** Fingerprint of the normalised result or error. */
	readonly outcome: string;
	/** Fingerprint of the first error line only (arguments may differ, the complaint does not). */
	readonly errorKey?: string;
	/** Short human label: the command, or "Edit config.js". */
	readonly label: string;
	/** First error line, for the corrective prompt. */
	readonly error?: string;
}

export type LoopKind =
	/** The same call failed the same way, back to back or between other calls. */
	| 'repeat-error'
	/** The same tool kept failing on the same file with the same error, arguments varying. */
	| 'same-target-error'
	/** Two calls alternating with unchanged results. */
	| 'alternating'
	/** The same call returned the same result several times in a row. */
	| 'repeat';

export interface ILoopSignal {
	readonly kind: LoopKind;
	readonly count: number;
	/** What the policy remembers between signals (a key, or tool plus target). */
	readonly subject: string;
	readonly label: string;
	readonly error?: string;
	/** For `alternating`: the other call. */
	readonly otherLabel?: string;
}

/**
 * The detector contract. WP1 owns `doomLoop.ts`; when its richer detector lands it can be adapted
 * to this interface and passed in through {@link IRunSupervisorOptions.detector}.
 */
export interface ILoopDetector {
	record(call: ISupervisedCall): ILoopSignal | undefined;
	reset(): void;
}

export interface IToolLoopThresholds {
	/** Identical failing calls back to back. */
	readonly consecutiveErrors: number;
	/** Identical failing calls with other work (edits) in between, within {@link window}. */
	readonly interleavedErrors: number;
	/** Failures of one tool on one file with the same error, arguments varying. */
	readonly sameTargetErrors: number;
	/** A/B cycles (each cycle is two calls). */
	readonly alternatingCycles: number;
	/** Identical successful calls with identical results, back to back. */
	readonly identicalResults: number;
	readonly window: number;
}

export const DEFAULT_LOOP_THRESHOLDS: IToolLoopThresholds = {
	consecutiveErrors: 3,
	interleavedErrors: 5,
	sameTargetErrors: 3,
	alternatingCycles: 3,
	identicalResults: 4,
	window: 12,
};

export class ToolLoopDetector implements ILoopDetector {

	private history: ISupervisedCall[] = [];

	constructor(private readonly thresholds: IToolLoopThresholds = DEFAULT_LOOP_THRESHOLDS) { }

	reset(): void {
		this.history = [];
	}

	record(call: ISupervisedCall): ILoopSignal | undefined {
		this.history.push(call);
		const keep = Math.max(this.thresholds.window, this.thresholds.alternatingCycles * 2, this.thresholds.identicalResults) + 4;
		if (this.history.length > keep) {
			this.history.splice(0, this.history.length - keep);
		}
		return this.consecutive(call) ?? this.sameTarget(call) ?? this.alternating() ?? this.interleaved(call);
	}

	/** The tail is N copies of this call with the same outcome. */
	private consecutive(call: ISupervisedCall): ILoopSignal | undefined {
		let count = 0;
		for (let i = this.history.length - 1; i >= 0; i--) {
			const previous = this.history[i];
			if (previous.key !== call.key || previous.outcome !== call.outcome) {
				break;
			}
			count++;
		}
		const needed = call.failed ? this.thresholds.consecutiveErrors : this.thresholds.identicalResults;
		if (count < needed) {
			return undefined;
		}
		return { kind: call.failed ? 'repeat-error' : 'repeat', count, subject: call.key, label: call.label, error: call.error };
	}

	private sameTarget(call: ISupervisedCall): ILoopSignal | undefined {
		if (!call.failed || !call.target || !call.errorKey) {
			return undefined;
		}
		const recent = this.history.slice(-this.thresholds.window);
		const group = recent.filter(previous => previous.tool === call.tool && previous.target === call.target);
		let count = 0;
		for (let i = group.length - 1; i >= 0; i--) {
			if (!group[i].failed || group[i].errorKey !== call.errorKey) {
				break;
			}
			count++;
		}
		if (count < this.thresholds.sameTargetErrors) {
			return undefined;
		}
		return { kind: 'same-target-error', count, subject: `${call.tool}\0${call.target}`, label: `${call.tool} on ${call.target}`, error: call.error };
	}

	private alternating(): ILoopSignal | undefined {
		const span = this.thresholds.alternatingCycles * 2;
		if (this.history.length < span) {
			return undefined;
		}
		const tail = this.history.slice(-span);
		const [a, b] = tail;
		if (a.key === b.key) {
			return undefined;
		}
		for (let i = 0; i < tail.length; i++) {
			const expected = i % 2 === 0 ? a : b;
			if (tail[i].key !== expected.key || tail[i].outcome !== expected.outcome) {
				return undefined;
			}
		}
		const last = tail[tail.length - 1];
		const other = tail[tail.length - 2];
		return { kind: 'alternating', count: this.thresholds.alternatingCycles, subject: [a.key, b.key].sort().join('\n'), label: last.label, otherLabel: other.label };
	}

	/** The same failure keeps coming back while other work happens in between. */
	private interleaved(call: ISupervisedCall): ILoopSignal | undefined {
		if (!call.failed) {
			return undefined;
		}
		const recent = this.history.slice(-this.thresholds.window);
		let count = 0;
		for (let i = recent.length - 1; i >= 0; i--) {
			const previous = recent[i];
			if (previous.key !== call.key) {
				continue;
			}
			if (previous.outcome !== call.outcome) {
				// A different result for the same call is progress (or at least change).
				break;
			}
			count++;
		}
		if (count < this.thresholds.interleavedErrors) {
			return undefined;
		}
		return { kind: 'repeat-error', count, subject: call.key, label: call.label, error: call.error };
	}
}

// --- Call tracking ---------------------------------------------------------------------------

interface ITrackedCall {
	name: string;
	title?: string;
	kind?: ToolKind;
	input: string;
	target?: string;
}

/** Durations, clock times, dates and long hex ids change between identical runs; ignore them. */
export function normaliseOutcome(text: string): string {
	return text
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<date>')
		.replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, '<time>')
		.replace(/\b\d+(\.\d+)?\s?(ms|msec|s|sec|secs|seconds|m|min|mins|minutes)\b/gi, '<dur>')
		.replace(/\b(0x)?[0-9a-f]{8,}\b/gi, '<hex>')
		.replace(/\bpid[:= ]\s*\d+/gi, 'pid <n>')
		.replace(/\s+/g, ' ')
		.trim();
}

function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** The readable text of a tool result: ACP content blocks, `rawOutput` streams, or plain strings. */
export function resultText(value: unknown, depth = 0): string {
	if (value === undefined || value === null || depth > 4) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(item => resultText(item, depth + 1)).filter(Boolean).join('\n');
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of ['text', 'content', 'error', 'message', 'stdout', 'stderr', 'output', 'result']) {
			const text = resultText(record[key], depth + 1);
			if (text) {
				parts.push(text);
			}
		}
		if (parts.length) {
			return parts.join('\n');
		}
		try {
			return JSON.stringify(value);
		} catch {
			return '';
		}
	}
	return '';
}

function parseInput(input: string): Record<string, unknown> | undefined {
	if (!input.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(input);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function pickString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/** Non-zero exit codes count as failures even when the agent reports the call as completed. */
function exitCodeOf(value: unknown, depth = 0): number | undefined {
	if (!value || typeof value !== 'object' || depth > 2) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ['exitCode', 'exit_code']) {
		if (typeof record[key] === 'number') {
			return record[key] as number;
		}
	}
	for (const key of ['rawOutput', 'output', 'result']) {
		const nested = exitCodeOf(record[key], depth + 1);
		if (nested !== undefined) {
			return nested;
		}
	}
	return undefined;
}

function firstErrorLine(text: string): string | undefined {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line) {
			return line.length > 160 ? `${line.slice(0, 157)}...` : line;
		}
	}
	return undefined;
}

function basename(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

// --- Test gaming -----------------------------------------------------------------------------

const TEST_PATH = /(^|[\\/])(tests?|__tests__|__mocks__|specs?|e2e|fixtures?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|[\\/])test_[^\\/]*\.py$|(^|[\\/])conftest\.py$|\.config\.[cm]?[jt]s$/i;

const TEST_SNIFFING: readonly { pattern: RegExp; what: string }[] = [
	{ pattern: /new Error\(\)\.stack|Error\(\)\.stack|Error\.captureStackTrace|Error\.prepareStackTrace|\bcallsites?\(/, what: 'inspects the call stack' },
	{ pattern: /arguments\.callee|\.caller\b/, what: 'inspects its caller' },
	{ pattern: /\basync_hooks\b|executionAsyncResource|AsyncLocalStorage/, what: 'reads async context (it can see the running test)' },
	{ pattern: /JEST_WORKER_ID|\bVITEST\b|MOCHA_|process\.env\.NODE_ENV\s*[!=]==?\s*['"]test['"]|['"]test['"]\s*[!=]==?\s*process\.env\.NODE_ENV/, what: 'checks whether a test runner is active' },
	{ pattern: /expect\.getState\(|currentTestName|\btestPath\b|this\.test\.(title|fullTitle)/, what: 'reads the current test name' },
	{ pattern: /sys\._getframe|inspect\.stack\(|PYTEST_CURRENT_TEST|['"]pytest['"]\s+in\s+sys\.modules/, what: 'inspects the Python call stack or test runner' },
];

/** Lines the change added, and the first test-runner sniffing pattern among them. */
export function detectTestSniffing(path: string, before: string | null | undefined, after: string): string | undefined {
	if (TEST_PATH.test(path)) {
		return undefined;
	}
	const previous = new Set((before ?? '').split(/\r?\n/).map(line => line.trim()));
	const added = after.split(/\r?\n/).map(line => line.trim()).filter(line => line && !previous.has(line));
	if (!added.length) {
		return undefined;
	}
	const text = added.join('\n');
	return TEST_SNIFFING.find(rule => rule.pattern.test(text))?.what;
}

// --- The supervisor --------------------------------------------------------------------------

export interface IRunSupervisorOptions {
	/** Ceilings for this run; unset meters are unlimited. Defaults to {@link ACP_RUN_BUDGET}. */
	readonly budget?: Partial<IResourceBudget>;
	readonly detector?: ILoopDetector;
	/** Corrective prompts per run before a further loop stops it. */
	readonly maxSteers?: number;
	/** Fraction of a budget at which the user is told once. */
	readonly warnAt?: number;
	readonly startedAt?: number;
}

/**
 * ACP run ceilings. The native loop stops at 500 tool calls (`DEEPSEEK_BUDGET`); ACP gets the
 * same plus a wall clock that is past any sane single turn (Cursor's 40-minute runaway, loop-extremes 1d).
 */
export const ACP_RUN_BUDGET: Partial<IResourceBudget> = {
	tools: 500,
	timeMs: 90 * 60_000,
};

const METER_LABELS: Partial<Record<BudgetMeter, { unit: string; limit: (cap: number) => string }>> = {
	tools: { unit: 'tool budget', limit: cap => `${cap} tool calls` },
	time: { unit: 'time budget', limit: cap => `${Math.round(cap / 60_000)} minute${Math.round(cap / 60_000) === 1 ? '' : 's'}` },
	tokens: { unit: 'token budget', limit: cap => `${cap.toLocaleString('en-US')} tokens` },
};

export class RunSupervisor {

	private readonly governor: ResourceGovernor;
	private readonly cap: IResourceBudget;
	private readonly detector: ILoopDetector;
	private readonly calls = new Map<string, ITrackedCall>();
	private readonly steered = new Map<string, LoopKind>();
	private readonly intentional = new Set<string>();
	private readonly warned = new Set<BudgetMeter>();
	private readonly flaggedPaths = new Set<string>();
	private steers = 0;
	private stopped = false;

	constructor(private readonly options: IRunSupervisorOptions = {}) {
		this.cap = unlimitedBudget(options.budget ?? ACP_RUN_BUDGET);
		this.governor = new ResourceGovernor(this.cap, options.startedAt ?? Date.now());
		this.detector = options.detector ?? new ToolLoopDetector();
	}

	/** True once a `stop` directive was issued; later events are ignored. */
	get hasStopped(): boolean {
		return this.stopped;
	}

	get steerCount(): number {
		return this.steers;
	}

	observe(event: IVoltEvent, now = Date.now()): SupervisorDirective[] {
		if (this.stopped) {
			return [];
		}
		const out: SupervisorDirective[] = [];
		switch (event.type) {
			case 'tool.start': {
				const input = event.input ?? '';
				this.calls.set(event.callId, {
					name: event.name,
					title: event.title,
					kind: event.kind,
					input,
					target: event.locations?.[0]?.path,
				});
				this.governor.consume({ tools: 1 }, now);
				this.checkDiffs(event.diffs, out);
				break;
			}
			case 'tool.input.delta': {
				const call = this.calls.get(event.callId);
				if (call) {
					call.input = event.append ? call.input + event.delta : event.delta;
				}
				break;
			}
			case 'tool.update': {
				const call = this.calls.get(event.callId);
				if (call) {
					call.title = event.title ?? call.title;
					call.kind = event.kind ?? call.kind;
					call.target = event.locations?.[0]?.path ?? call.target;
				}
				this.checkDiffs(event.diffs, out);
				break;
			}
			case 'tool.end': {
				this.checkDiffs(event.diffs, out);
				const call = this.calls.get(event.callId);
				this.calls.delete(event.callId);
				if (call) {
					const signal = this.detector.record(this.summarise(call, event));
					const directive = signal && this.onLoop(signal);
					if (directive) {
						out.push(directive);
					}
				}
				break;
			}
			case 'usage':
				if (isBounded(this.cap, 'tokens')) {
					this.governor.consume({ tokens: event.output }, now);
				}
				break;
		}
		out.push(...this.checkBudget(now));
		if (out.some(directive => directive.kind === 'stop')) {
			this.stopped = true;
			return out.filter(directive => directive.kind !== 'steer');
		}
		return out;
	}

	/** A file write the agent made outside a tool event (ACP `fs/write_text_file`). */
	observeWrite(path: string, before: string | undefined, after: string): SupervisorDirective[] {
		const out: SupervisorDirective[] = [];
		this.checkDiffs([{ path, oldText: before ?? null, newText: after }], out);
		return out;
	}

	/** Wall-clock check for quiet stretches (call from a timer or the idle watchdog). */
	tick(now = Date.now()): SupervisorDirective[] {
		if (this.stopped) {
			return [];
		}
		const out = this.checkBudget(now);
		if (out.some(directive => directive.kind === 'stop')) {
			this.stopped = true;
		}
		return out;
	}

	private summarise(call: ITrackedCall, end: Extract<IVoltEvent, { type: 'tool.end' }>): ISupervisedCall {
		const args = parseInput(call.input);
		const command = pickString(args, ['command', 'cmd']);
		const target = call.target ?? pickString(args, ['path', 'file_path', 'filePath', 'target_file', 'file', 'notebook_path']);
		const kind = call.kind ?? (command ? 'execute' : undefined);
		const tool = kind ?? call.name.split(/[\s:(]/)[0].toLowerCase();
		const output = [end.output ?? '', resultText(end.result)].filter(Boolean).join('\n');
		const exitCode = end.exitCode ?? exitCodeOf(end.result);
		const failed = !!end.error || (exitCode !== undefined && exitCode !== 0) || /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)[:= ]+[1-9]/i.test(output);
		const normalised = normaliseOutcome(`${end.error ?? ''}\n${output}`.slice(-8000));
		// ACP agents say only "Tool failed"; the useful complaint is in the output.
		const error = failed ? firstErrorLine(end.error && end.error !== 'Tool failed' ? end.error : output || end.error || '') : undefined;
		const label = command ?? (target ? `${call.title?.split(/\s/)[0] || tool} ${basename(target)}` : call.title || call.name);
		return {
			tool,
			key: toolCallKey({ id: '', name: tool, args: args ?? call.title ?? call.name }),
			target,
			failed,
			outcome: hashText(`${failed ? 'fail' : 'ok'}\0${normalised}`),
			errorKey: error ? hashText(normaliseOutcome(error)) : undefined,
			label: label.length > 120 ? `${label.slice(0, 117)}...` : label,
			error,
		};
	}

	private onLoop(signal: ILoopSignal): SupervisorDirective | undefined {
		const maxSteers = this.options.maxSteers ?? 3;
		const previous = this.steered.get(signal.subject);
		if (signal.kind === 'repeat') {
			// Identical successful calls are sometimes the point ("run echo ping 30 times"). Ask once;
			// if the agent carries on after that, treat the repetition as intended.
			if (this.intentional.has(signal.subject)) {
				return undefined;
			}
			if (previous) {
				this.intentional.add(signal.subject);
				this.detector.reset();
				return { kind: 'notice', severity: 'info', title: LOOP_NOTICE_TITLE, description: `${signal.label} keeps returning the same result; continuing because the agent kept going after being asked.` };
			}
		} else if (previous || this.steers >= maxSteers) {
			return {
				kind: 'stop',
				reason: 'loop',
				signal,
				retryable: false,
				message: `Stopped: the agent kept ${describeLoop(signal)} after being asked to change approach.`,
			};
		}
		this.steers++;
		this.steered.set(signal.subject, signal.kind);
		this.detector.reset();
		return {
			kind: 'steer',
			signal,
			text: steerText(signal),
			title: LOOP_NOTICE_TITLE,
			description: `The agent was ${describeLoop(signal)}. Volt asked it to change approach.`,
		};
	}

	private checkBudget(now: number): SupervisorDirective[] {
		const snapshot = this.governor.snapshot(now);
		const out: SupervisorDirective[] = [];
		const warnAt = this.options.warnAt ?? 0.8;
		for (const meter of ['tools', 'time', 'tokens'] as const) {
			if (!isBounded(this.cap, meter)) {
				continue;
			}
			const key = meter === 'time' ? 'timeMs' : meter;
			const cap = this.cap[key];
			const spent = snapshot.spent[key];
			const label = METER_LABELS[meter]!;
			if (spent >= cap) {
				out.push({
					kind: 'stop',
					reason: 'budget',
					meter,
					retryable: true,
					message: `Paused at the ${label.unit} for one run (${label.limit(cap)}). Send "continue" to keep going from here.`,
				});
				return out;
			}
			if (spent >= cap * warnAt && !this.warned.has(meter)) {
				this.warned.add(meter);
				out.push({ kind: 'notice', severity: 'info', title: BUDGET_NOTICE_TITLE, description: `This run has used ${Math.round(warnAt * 100)}% of its ${label.unit} (${label.limit(cap)}).` });
			}
		}
		return out;
	}

	private checkDiffs(diffs: readonly IVoltToolDiff[] | undefined, out: SupervisorDirective[]): void {
		for (const diff of diffs ?? []) {
			if (this.flaggedPaths.has(diff.path)) {
				continue;
			}
			const what = detectTestSniffing(diff.path, diff.oldText, diff.newText);
			if (what) {
				this.flaggedPaths.add(diff.path);
				out.push({
					kind: 'notice',
					severity: 'warning',
					title: TEST_GAMING_NOTICE_TITLE,
					description: `${basename(diff.path)} now ${what}. Code that detects the test runner can make tests pass without fixing the behaviour.`,
				});
			}
		}
	}
}

function describeLoop(signal: ILoopSignal): string {
	switch (signal.kind) {
		case 'repeat-error':
			return `running ${signal.label} ${signal.count} times with the same error`;
		case 'same-target-error':
			return `retrying ${signal.label} ${signal.count} times with the same error`;
		case 'alternating':
			return `alternating between ${signal.otherLabel ?? 'two calls'} and ${signal.label} without progress`;
		case 'repeat':
			return `running ${signal.label} ${signal.count} times in a row with the same result`;
	}
}

/** The corrective prompt sent to an ACP agent (or injected into the native loop). */
export function steerText(signal: ILoopSignal): string {
	const error = signal.error ? ` ("${signal.error}")` : '';
	switch (signal.kind) {
		case 'repeat-error':
			return `You ran ${signal.label} ${signal.count} times and got the same error each time${error}. Running it again will not help. Change your approach, or stop and report what is blocking you.`;
		case 'same-target-error':
			return `Your last ${signal.count} attempts at ${signal.label} failed with the same error${error}. Re-read the current file contents before editing again, try a different approach, or stop and report what is blocking you.`;
		case 'alternating':
			return `You are alternating between ${signal.otherLabel ?? 'two calls'} and ${signal.label} and the results are not changing. Step back, change your approach, or stop and report what is blocking you.`;
		case 'repeat':
			return `You ran ${signal.label} ${signal.count} times in a row and got the same result each time. If the user asked for this repetition, say so in one line and continue; otherwise change your approach or stop and report.`;
	}
}
