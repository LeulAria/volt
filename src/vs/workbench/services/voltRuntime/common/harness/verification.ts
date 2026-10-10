/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EvidenceStore, IEvidence, IEvidenceClassifier } from './evidence.js';
import { IExecutionPlan, isPlanComplete } from './plan.js';
import { isThinAnswer, matchesRequestedForm } from './requestShape.js';
import { EvidenceKind, isMachineCheckable, ITaskIntel } from './taskIntel.js';

/**
 * The verification engine and the completion check.
 *
 * The failure this exists to prevent is the single most common way an agent run goes wrong: the
 * model edits three files, writes "I've made the changes and everything should work now", and
 * stops. Nothing ran. Nothing was proven. The user finds out at the next build.
 *
 * So completion is not the model's opinion. It is a function of evidence:
 *
 *   - every machine-checkable criterion needs a passing check **recorded after the last edit**;
 *   - a run that changed code in a project that has checks must have run at least one;
 *   - a plan that still has open steps is not finished regardless of what was proven.
 *
 * `checkCompletion` returns *why* it is not done, not just that it is not, because that string
 * goes straight back to the model as the next instruction.
 */

// --- project detection --------------------------------------------------------------------

export interface IProjectCheckFiles {
	readonly packageJson?: {
		scripts?: Record<string, string>;
		packageManager?: string;
		devDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	readonly lock?: 'pnpm' | 'bun' | 'yarn' | 'npm';
	readonly tsconfig?: boolean;
	readonly cargoToml?: boolean;
	readonly goMod?: boolean;
	readonly pyproject?: boolean;
}

/** The commands this project verifies itself with. Absent means "this project has no such check". */
export interface IProjectChecks {
	readonly test?: string;
	readonly lint?: string;
	readonly typecheck?: string;
	readonly build?: string;
}

const SCRIPT_ALIASES: Readonly<Record<keyof IProjectChecks, readonly string[]>> = {
	test: ['test', 'tests', 'test:unit', 'unit', 'jest', 'vitest'],
	lint: ['lint', 'eslint', 'lint:check', 'check:lint'],
	typecheck: ['typecheck', 'type-check', 'types', 'tsc', 'check-types', 'compile-check'],
	build: ['build', 'compile', 'bundle'],
};

/**
 * Deliberately conservative: a command is only reported when the project clearly declares it.
 * Inventing `npm test` for a project with no test script produces a check that always fails,
 * which would then block every completion.
 */
export function detectProjectChecks(files: IProjectCheckFiles): IProjectChecks {
	const scripts = files.packageJson?.scripts ?? {};
	const runner = packageRunner(files);
	const checks: Record<string, string | undefined> = {};

	for (const key of Object.keys(SCRIPT_ALIASES) as (keyof IProjectChecks)[]) {
		const name = SCRIPT_ALIASES[key].find(alias => typeof scripts[alias] === 'string' && scripts[alias].trim());
		if (name) {
			// `npm test` / `pnpm test` is the idiomatic form every runner special-cases.
			checks[key] = name === 'test' ? `${runner} test` : `${runner} run ${name}`;
		}
	}

	// A TypeScript project with no typecheck script still type-checks; `tsc --noEmit` is the
	// universal way to ask, and it is safe because it writes nothing.
	if (!checks.typecheck && files.tsconfig) {
		checks.typecheck = `${execPrefix(runner)} tsc --noEmit`;
	}
	if (files.cargoToml) {
		checks.test ??= 'cargo test';
		checks.lint ??= 'cargo clippy -- -D warnings';
		checks.build ??= 'cargo build';
	}
	if (files.goMod) {
		checks.test ??= 'go test ./...';
		checks.lint ??= 'go vet ./...';
		checks.build ??= 'go build ./...';
	}
	if (files.pyproject) {
		checks.test ??= 'pytest';
		checks.lint ??= 'ruff check .';
	}

	return {
		...(checks.test ? { test: checks.test } : {}),
		...(checks.lint ? { lint: checks.lint } : {}),
		...(checks.typecheck ? { typecheck: checks.typecheck } : {}),
		...(checks.build ? { build: checks.build } : {}),
	};
}

function packageRunner(files: IProjectCheckFiles): 'npm' | 'pnpm' | 'yarn' | 'bun' {
	const declared = files.packageJson?.packageManager?.split('@')[0];
	if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
		return declared;
	}
	return files.lock && files.lock !== 'npm' ? files.lock : 'npm';
}

function execPrefix(runner: string): string {
	return runner === 'npm' ? 'npx' : runner === 'yarn' ? 'yarn' : `${runner} exec`;
}

export function hasAnyCheck(checks: IProjectChecks): boolean {
	return !!(checks.test || checks.lint || checks.typecheck || checks.build);
}

// --- command classification ---------------------------------------------------------------

/** Recognises a check even when the model ran it a slightly different way than detected. */
const GENERIC_CHECKS: readonly (readonly [EvidenceKind, RegExp])[] = [
	['test', /\b(?:jest|vitest|mocha|ava|pytest|rspec|phpunit|go test|cargo test|dotnet test|gradle test|mvn test)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i],
	['typecheck', /\btsc\b|\bmypy\b|\bpyright\b|\bflow check\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:typecheck|type-check|types|check-types|compile-check)\b/i],
	['lint', /\beslint\b|\bruff\b|\bflake8\b|\bclippy\b|\bgo vet\b|\brubocop\b|\bstylelint\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b/i],
	['build', /\b(?:cargo|go|dotnet|gradle|mvn)\s+build\b|\bwebpack\b|\bvite build\b|\btsup\b|\bmake\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|compile|bundle)\b/i],
];

/**
 * Maps a shell command onto the criterion it proves. Configured commands win over the generic
 * patterns so a project whose `build` script happens to run tests is attributed correctly.
 */
export function commandClassifier(checks: IProjectChecks): IEvidenceClassifier {
	const configured: (readonly [EvidenceKind, string])[] = [];
	for (const key of ['test', 'typecheck', 'lint', 'build'] as const) {
		const command = checks[key];
		if (command) {
			configured.push([key, normalizeCommand(command)]);
		}
	}
	return (command: string) => {
		const normalized = normalizeCommand(command);
		for (const [kind, configuredCommand] of configured) {
			if (normalized === configuredCommand || normalized.startsWith(`${configuredCommand} `)) {
				return kind;
			}
		}
		for (const [kind, pattern] of GENERIC_CHECKS) {
			if (pattern.test(command)) {
				return kind;
			}
		}
		return undefined;
	};
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

// --- gates -----------------------------------------------------------------------------------

export type GateStatus = 'pending' | 'passed' | 'failed' | 'unavailable';

export interface IVerificationGate {
	readonly kind: EvidenceKind;
	/** The command to run. Absent means the project offers no way to check this. */
	readonly command?: string;
	readonly criteria: readonly string[];
	readonly status: GateStatus;
	/** Why it failed, or why it is unavailable. */
	readonly detail?: string;
}

/**
 * One gate per distinct machine-checkable criterion kind. A criterion whose project command is
 * missing produces an `unavailable` gate rather than being dropped, so the final summary can say
 * "you asked for the tests to pass but this project has no test script" instead of silently
 * declaring success.
 */
export function planGates(intel: ITaskIntel, checks: IProjectChecks): IVerificationGate[] {
	const byKind = new Map<EvidenceKind, string[]>();
	intel.successCriteria.forEach((criterion, index) => {
		if (!isMachineCheckable(criterion.evidence)) {
			return;
		}
		const existing = byKind.get(criterion.evidence) ?? [];
		existing.push(`c${index}`);
		byKind.set(criterion.evidence, existing);
	});

	return [...byKind].map(([kind, criteria]) => {
		const command = commandFor(kind, checks);
		return {
			kind,
			...(command ? { command } : {}),
			criteria,
			status: command || kind === 'browser' || kind === 'runtime' ? 'pending' as const : 'unavailable' as const,
			...(command || kind === 'browser' || kind === 'runtime' ? {} : { detail: `This project declares no ${kind} command.` }),
		};
	});
}

function commandFor(kind: EvidenceKind, checks: IProjectChecks): string | undefined {
	switch (kind) {
		case 'test': return checks.test;
		case 'lint': return checks.lint;
		case 'typecheck': return checks.typecheck;
		case 'build': return checks.build;
		default: return undefined;
	}
}

/** Resolves each gate against the evidence recorded since the last change to the workspace. */
export function evaluateGates(gates: readonly IVerificationGate[], store: EvidenceStore): IVerificationGate[] {
	return gates.map(gate => {
		if (gate.status === 'unavailable') {
			return gate;
		}
		const evidence = store.provenSince(gate.kind);
		if (!evidence) {
			return { ...gate, status: 'pending' as const, detail: undefined };
		}
		return evidence.ok
			? { ...gate, status: 'passed' as const, detail: undefined }
			: { ...gate, status: 'failed' as const, detail: firstLine(evidence.detail) };
	});
}

// --- completion ---------------------------------------------------------------------------------

export interface ICompletionCheck {
	readonly complete: boolean;
	/** Gate kinds that failed. */
	readonly failed: readonly EvidenceKind[];
	/** Gate kinds that were never run. */
	readonly pending: readonly EvidenceKind[];
	/** Gate kinds this project cannot check. Reported, never blocking. */
	readonly unavailable: readonly EvidenceKind[];
	/** The next instruction when incomplete, or the reason it is complete. */
	readonly reason: string;
}

export interface ICompletionInput {
	readonly intel: ITaskIntel;
	readonly gates: readonly IVerificationGate[];
	readonly store: EvidenceStore;
	readonly checks: IProjectChecks;
	readonly plan?: IExecutionPlan;
	/** The lane never changes code, so "nothing was edited" is not a failure. */
	readonly readOnly?: boolean;
	/** The model's last answer. Used to check table/list/completeness, never to prove a gate. */
	readonly assistantText?: string;
}

export function checkCompletion(input: ICompletionInput): ICompletionCheck {
	const gates = evaluateGates(input.gates, input.store);
	const failed = gates.filter(gate => gate.status === 'failed');
	const pending = gates.filter(gate => gate.status === 'pending');
	const unavailable = gates.filter(gate => gate.status === 'unavailable').map(gate => gate.kind);
	const changed = input.store.changedFiles();

	const summary = {
		failed: failed.map(gate => gate.kind),
		pending: pending.map(gate => gate.kind),
		unavailable,
	};

	if (failed.length) {
		const detail = failed.map(gate => `${gate.kind}${gate.detail ? ` (${gate.detail})` : ''}`).join(', ');
		return { complete: false, ...summary, reason: `Not done: ${detail} is still failing. Fix the cause and run it again.` };
	}

	// A check the run chose to run on its own is still binding. The user not having asked for
	// the build to pass is no reason to finish on a broken build the run already saw.
	const verified = input.store.verifiedSince();
	const gated = new Set(gates.map(gate => gate.kind));
	const failingUngated = verified.filter(item => !item.ok && item.proves && !gated.has(item.proves));
	if (failingUngated.length) {
		const detail = failingUngated.map(item => `${item.proves} (\`${item.subject}\`)`).join(', ');
		return { complete: false, ...summary, reason: `Not done: ${detail} failed the last time it ran. Fix it or say why it is unrelated.` };
	}

	if (pending.length) {
		const detail = pending.map(gate => gate.command ? `${gate.kind} (\`${gate.command}\`)` : gate.kind).join(', ');
		return { complete: false, ...summary, reason: `Not done: you have not run ${detail} since the last change. Run it before finishing.` };
	}

	if (input.plan && !isPlanComplete(input.plan)) {
		const open = input.plan.steps.filter(step => step.status !== 'done' && step.status !== 'skipped');
		return { complete: false, ...summary, reason: `Not done: ${open.length} plan step${open.length === 1 ? '' : 's'} still open - ${open[0].title}.` };
	}

	// The quiet failure: files were changed, the project has checks, and none were run. No gate
	// caught it because the user never named one, so the harness insists on its own behalf.
	if (!input.readOnly && changed.length && !verified.length && hasAnyCheck(input.checks)) {
		const command = input.checks.typecheck ?? input.checks.test ?? input.checks.build ?? input.checks.lint;
		return {
			complete: false,
			...summary,
			reason: `Not done: ${changed.length} file${changed.length === 1 ? ' was' : 's were'} changed and nothing was run to check them. Run \`${command}\` first.`,
		};
	}

	if (!input.readOnly && !changed.length && input.intel.successCriteria.some(criterion => criterion.evidence === 'diff')) {
		return { complete: false, ...summary, reason: 'Not done: nothing in the workspace changed yet.' };
	}

	if (input.intel.successCriteria.some(criterion => criterion.evidence === 'lookup') && !input.store.lookedUp()) {
		return {
			complete: false,
			...summary,
			reason: 'Not done: this answer depends on current facts. Use web_search, then web_fetch on the primary sources, then answer from those results.',
		};
	}

	const shape = input.intel.shape;
	const answer = input.assistantText?.trim() ?? '';
	const formInAnswer = input.readOnly || !changed.length;
	if (formInAnswer && !answer && (shape.form === 'table' || shape.form === 'list' || shape.enumerate) && input.store.lookedUp()) {
		return {
			complete: false,
			...summary,
			reason: `Not done: you looked the facts up but did not produce the ${shape.form === 'prose' ? 'full answer' : shape.form} they asked for.`,
		};
	}
	if (formInAnswer && answer && (shape.form === 'table' || shape.form === 'list') && !matchesRequestedForm(answer, shape.form)) {
		return {
			complete: false,
			...summary,
			reason: `Not done: the user asked for a ${shape.form}. Produce that ${shape.form} from the sources you gathered - do not summarise it into a paragraph.`,
		};
	}
	if (formInAnswer && answer && shape.form === 'prose' && isThinAnswer(answer, shape)) {
		return {
			complete: false,
			...summary,
			reason: 'Not done: they asked for the full set, not a one-line summary. Expand the answer from the sources you gathered.',
		};
	}

	return { complete: true, ...summary, reason: completionReason(changed.length, gates, verified) };
}

function completionReason(changed: number, gates: readonly IVerificationGate[], verified: readonly IEvidence[]): string {
	const passed = [...new Set([
		...gates.filter(gate => gate.status === 'passed').map(gate => gate.kind),
		...verified.flatMap(item => item.ok && item.proves ? [item.proves] : []),
	])];
	if (changed && passed.length) {
		return `${changed} file${changed === 1 ? '' : 's'} changed; ${passed.join(', ')} passing.`;
	}
	if (changed) {
		return `${changed} file${changed === 1 ? '' : 's'} changed.`;
	}
	return 'Nothing left to do.';
}

function firstLine(text: string): string {
	return (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 160);
}

// --- regression gate ------------------------------------------------------------------------------

/**
 * One run of a project check, reduced to what the regression gate compares. Test names are
 * collected from the common runners' output (node:test, TAP, Jest, Vitest, Mocha, pytest, go test,
 * cargo test); `parsed` says whether any were found, because "no failing names" means nothing
 * when the format was not understood.
 */
export interface ICheckReport {
	readonly command: string;
	/** Exit code 0 (or, when the exit code is unknown, at least one pass and no failures). */
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly failed: readonly string[];
	readonly passed: readonly string[];
	readonly counts?: { readonly pass: number; readonly fail: number };
	readonly parsed: boolean;
	readonly durationMs: number;
	/** The end of the output, for the evidence the agent is shown. */
	readonly tail: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const DURATION_SUFFIX = /\s+\((?:\d+(?:\.\d+)?\s*(?:ms|s|m)|[\d.]+\s*sec)\)\s*$/i;
const TAIL_CHARS = 3_000;
const TAIL_LINES = 40;

type LineRule = readonly [RegExp, 'pass' | 'fail', number];

const NAME_RULES: readonly LineRule[] = [
	// allow-any-unicode-next-line
	// node:test spec reporter and Mocha (`✔ name (1ms)` / `✖ name`), Jest/Vitest (`✓` / `✕` / `×`).
	[/^\s*[\u2714\u2713\u221a]\s+(.+)$/, 'pass', 1],
	[/^\s*[\u2716\u2715\u00d7\u2717]\s+(.+)$/, 'fail', 1],
	// TAP (node --test in a pipe on older Node, tap, ava --tap).
	[/^\s*ok \d+ - (.+?)(?:\s+#\s*(?:SKIP|TODO).*)?$/, 'pass', 1],
	[/^\s*not ok \d+ - (.+?)(?:\s+#\s*(?:SKIP|TODO).*)?$/, 'fail', 1],
	// Vitest / Jest file and test lines.
	[/^\s*FAIL\s+(\S.*?\s>\s.+)$/, 'fail', 1],
	// pytest.
	[/^(?:FAILED|ERROR)\s+(\S+::\S+)/, 'fail', 1],
	[/^(\S+::\S+)\s+PASSED\b/, 'pass', 1],
	[/^(\S+::\S+)\s+FAILED\b/, 'fail', 1],
	// go test.
	[/^\s*--- PASS: (\S+)/, 'pass', 1],
	[/^\s*--- FAIL: (\S+)/, 'fail', 1],
	// cargo test.
	[/^test (\S+) \.\.\. ok$/, 'pass', 1],
	[/^test (\S+) \.\.\. FAILED$/, 'fail', 1],
];

/** Summary lines: the counts are only used when names are missing on one side. */
const COUNT_RULES: readonly ((text: string) => { pass: number; fail: number } | undefined)[] = [
	text => matchCounts(text, /^[\u2139#] pass (\d+)$/m, /^[\u2139#] fail (\d+)$/m),
	text => matchCounts(text, /^Tests:.*?(\d+) passed/m, /^Tests:.*?(\d+) failed/m, true),
	text => matchCounts(text, /^\s*Tests\s+.*?(\d+) passed/m, /^\s*Tests\s+.*?(\d+) failed/m, true),
	text => matchCounts(text, /^\s*(\d+) passing\b/m, /^\s*(\d+) failing\b/m, true),
	text => matchCounts(text, /=+ .*?(\d+) passed/m, /=+ .*?(\d+) failed/m, true),
	text => matchCounts(text, /^test result: \w+\. (\d+) passed/m, /^test result: \w+\. \d+ passed; (\d+) failed/m),
];

function matchCounts(text: string, pass: RegExp, fail: RegExp, failOptional = false): { pass: number; fail: number } | undefined {
	const passed = pass.exec(text);
	const failed = fail.exec(text);
	if (!passed && !failed) {
		return undefined;
	}
	if (!failed && !failOptional) {
		return undefined;
	}
	return { pass: passed ? Number(passed[1]) : 0, fail: failed ? Number(failed[1]) : 0 };
}

/** Reduces one check's output. `exitCode` null means the process did not report one. */
export function parseCheckOutput(command: string, output: string, exitCode: number | null, durationMs = 0, timedOut = false): ICheckReport {
	const text = output.replace(ANSI, '').replace(/\r\n?/g, '\n');
	const failed = new Set<string>();
	const passed = new Set<string>();
	for (const raw of text.split('\n')) {
		const line = raw.trimEnd();
		if (!line || /^\s*[\u2716\u2715\u00d7\u2717]\s+failing tests:?$/i.test(line)) {
			continue;
		}
		for (const [pattern, verdict, group] of NAME_RULES) {
			const match = pattern.exec(line);
			if (!match) {
				continue;
			}
			const name = match[group].replace(DURATION_SUFFIX, '').trim();
			if (name) {
				(verdict === 'pass' ? passed : failed).add(name);
			}
			break;
		}
	}
	// A test that failed once and is listed again in a summary is still one failure; a name
	// reported both ways (a retried test) counts as failing.
	for (const name of failed) {
		passed.delete(name);
	}
	let counts: { pass: number; fail: number } | undefined;
	for (const rule of COUNT_RULES) {
		counts = rule(text);
		if (counts) {
			break;
		}
	}
	const ok = !timedOut && (exitCode !== null ? exitCode === 0 : (counts ? counts.fail === 0 && counts.pass > 0 : passed.size > 0 && failed.size === 0));
	return {
		command,
		ok,
		exitCode,
		timedOut,
		failed: [...failed],
		passed: [...passed],
		...(counts ? { counts } : {}),
		parsed: failed.size + passed.size > 0,
		durationMs,
		tail: outputTail(text),
	};
}

function outputTail(text: string): string {
	const lines = text.trimEnd().split('\n');
	const tail = lines.slice(-TAIL_LINES).join('\n');
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export interface IRegressionVerdict {
	readonly regressed: boolean;
	/**
	 * - `tests`: named tests fail now that did not fail before (including new tests that fail).
	 * - `suite`: the check passed before and fails now, with no names to compare.
	 * - `count`: both failed, but more tests fail now.
	 * - `unknown`: no usable baseline, a timeout, or nothing comparable; never acted on.
	 */
	readonly kind: 'none' | 'tests' | 'suite' | 'count' | 'unknown';
	readonly newFailures: readonly string[];
	readonly detail?: string;
}

/**
 * New failures caused by the run, never pre-existing ones: a test that already failed before the
 * run started is the user's problem (or the task), not a regression to send the agent back for.
 */
export function regressionVerdict(before: ICheckReport | undefined, after: ICheckReport): IRegressionVerdict {
	if (after.ok) {
		return { regressed: false, kind: 'none', newFailures: [] };
	}
	if (!before || before.timedOut || after.timedOut) {
		return { regressed: false, kind: 'unknown', newFailures: [] };
	}
	if (before.parsed && after.parsed && after.failed.length) {
		const previously = new Set(before.failed);
		const newFailures = after.failed.filter(name => !previously.has(name));
		return newFailures.length
			? { regressed: true, kind: 'tests', newFailures }
			: { regressed: false, kind: 'none', newFailures: [] };
	}
	if (before.ok) {
		return { regressed: true, kind: 'suite', newFailures: [], detail: `\`${after.command}\` passed before this change and fails now.` };
	}
	if (before.counts && after.counts && after.counts.fail > before.counts.fail) {
		return { regressed: true, kind: 'count', newFailures: [], detail: `${after.counts.fail} tests fail now; ${before.counts.fail} failed before this change.` };
	}
	return { regressed: false, kind: 'unknown', newFailures: [] };
}

const MAX_LISTED_FAILURES = 15;

export function formatRegressionNudge(verdict: IRegressionVerdict, after: ICheckReport): string {
	const lines = ['[Volt check] Volt ran the project tests after your change.'];
	if (verdict.kind === 'tests') {
		lines.push(`These tests passed (or did not exist) before your change and fail now (\`${after.command}\`):`);
		lines.push(...verdict.newFailures.slice(0, MAX_LISTED_FAILURES).map(name => `- ${name}`));
		if (verdict.newFailures.length > MAX_LISTED_FAILURES) {
			lines.push(`- ... and ${verdict.newFailures.length - MAX_LISTED_FAILURES} more`);
		}
	} else if (verdict.detail) {
		lines.push(verdict.detail);
	}
	if (after.tail) {
		lines.push('', 'End of the output:', '```', after.tail, '```');
	}
	lines.push('', 'Fix the cause in the code (do not weaken, skip or delete tests), run the tests again, then finish. Tests that were already failing before your change are not your concern unless the task was to fix them. If a failure is intended, say so and why in your final answer.');
	return lines.join('\n');
}

export interface ITodoEntry {
	readonly content: string;
	readonly status: 'pending' | 'in_progress' | 'completed' | string;
}

/** To-dos the agent left open: what it said it would do and did not mark done. */
export function openTodos(entries: readonly ITodoEntry[] | undefined): string[] {
	return (entries ?? []).filter(entry => entry.status === 'pending' || entry.status === 'in_progress').map(entry => entry.content.trim()).filter(Boolean);
}

export function formatTodoNudge(open: readonly string[]): string {
	return [
		`[Volt check] You ended the turn with ${open.length} open to-do${open.length === 1 ? '' : 's'}:`,
		...open.slice(0, MAX_LISTED_FAILURES).map(item => `- ${item}`),
		'Continue with them now. If any is no longer needed, mark it done or say why in your final answer.',
	].join('\n');
}

export interface IContinuationInput {
	/** The mode allows edits; Ask and Plan are never continued. */
	readonly writes: boolean;
	readonly verdict?: IRegressionVerdict;
	readonly after?: ICheckReport;
	readonly todos?: readonly ITodoEntry[];
	/** What this run was already sent back for; each reason fires at most once per run. */
	readonly used: { readonly regression: boolean; readonly todos: boolean };
}

export interface IContinuation {
	/** The message for the agent, or undefined to accept the answer. */
	readonly message?: string;
	/** The transcript notice that explains why the run goes on. */
	readonly notice?: string;
	readonly reasons: readonly ('regression' | 'todos')[];
}

/** Whether a run that wants to stop gets one more turn, and what it is told. Bounded: once per reason. */
export function decideContinuation(input: IContinuationInput): IContinuation {
	if (!input.writes) {
		return { reasons: [] };
	}
	const parts: string[] = [];
	const reasons: ('regression' | 'todos')[] = [];
	const notices: string[] = [];
	if (!input.used.regression && input.verdict?.regressed && input.after) {
		parts.push(formatRegressionNudge(input.verdict, input.after));
		reasons.push('regression');
		const count = input.verdict.newFailures.length;
		notices.push(count ? `${count} test${count === 1 ? '' : 's'} that passed before now fail${count === 1 ? 's' : ''}` : 'the tests passed before this change and fail now');
	}
	const open = openTodos(input.todos);
	if (!input.used.todos && open.length) {
		parts.push(formatTodoNudge(open));
		reasons.push('todos');
		notices.push(`${open.length} to-do${open.length === 1 ? ' is' : 's are'} still open`);
	}
	if (!parts.length) {
		return { reasons: [] };
	}
	const summary = notices.join(' and ');
	return { message: parts.join('\n\n'), notice: `${summary.charAt(0).toUpperCase()}${summary.slice(1)}; asking the agent to continue.`, reasons };
}

/** Commands that only look: running them during a baseline check cannot change its result. */
const READ_ONLY_COMMAND = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:ls|ll|cat|head|tail|less|wc|pwd|echo|printf|rg|grep|egrep|find|fd|tree|stat|file|which|type|env|printenv|date|whoami|uname|node\s+(?:-v|--version)|npm\s+(?:-v|--version|ls|list|view)|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|remote|config\s+--get))\b/;

/** True when a shell command plausibly changes files (anything not known to only read). */
export function mayMutateWorkspace(command: string): boolean {
	return !READ_ONLY_COMMAND.test(command) || /(?:^|[^>])>{1,2}\s*\S|\|\s*tee\b|\bsed\s+-i\b/.test(command);
}

/** The same check command, ignoring spacing and case. */
export function isSameCommand(a: string, b: string): boolean {
	return normalizeCommand(a) === normalizeCommand(b);
}
