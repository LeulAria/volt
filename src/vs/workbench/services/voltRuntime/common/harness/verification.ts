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
