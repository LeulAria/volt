/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EvidenceStore } from './evidence.js';
import { IExecutionPlan } from './plan.js';
import { ITaskIntel } from './taskIntel.js';
import { evaluateGates, ICompletionCheck, IVerificationGate } from './verification.js';
import { formatDuration, IWorkCounts, summarizeWork } from './workLog.js';

/**
 * The final result synthesizer.
 *
 * Every line here is derived from the evidence store, never from the model's own account of
 * what it did. That constraint is the point: the most damaging thing an agent can do is finish
 * by asserting success it cannot support, and a summary written from the transcript will
 * faithfully repeat whatever the model believed. A summary written from evidence can only say
 * "tests passed" if a test command actually ran and exited zero after the last edit.
 *
 * Where the model *is* trusted is for the one thing evidence cannot supply: a sentence of prose
 * explaining what it did and why. That arrives via `assistantSummary` and is never used to
 * contradict a gate.
 */

export type RunStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface IChangeLine {
	readonly path: string;
	readonly kind: 'edit' | 'create' | 'delete';
}

export interface IVerificationLine {
	readonly label: string;
	readonly passed: boolean;
	readonly detail?: string;
}

export interface IArtifact {
	readonly kind: 'url' | 'file' | 'command';
	readonly value: string;
	readonly label?: string;
}

export interface IRunOutcome {
	readonly status: RunStatus;
	/** One sentence. The only line a user in a hurry reads. */
	readonly headline: string;
	/** The model's own explanation, trimmed. Empty when it did not give one. */
	readonly narrative: string;
	readonly changes: readonly IChangeLine[];
	readonly verification: readonly IVerificationLine[];
	readonly artifacts: readonly IArtifact[];
	/** What is left, phrased as things the user can act on. */
	readonly next: readonly string[];
	/** "Worked for 27s · Edited 3 files · ran 2 commands" */
	readonly statusLine: string;
}

export interface ISynthesisInput {
	readonly intel: ITaskIntel;
	readonly store: EvidenceStore;
	readonly gates: readonly IVerificationGate[];
	readonly completion: ICompletionCheck;
	readonly work: IWorkCounts;
	readonly durationMs: number;
	readonly plan?: IExecutionPlan;
	/** Text the model produced, or the `summary` field of its `finish` call. */
	readonly assistantSummary?: string;
	/** Items the model listed as remaining in its `finish` call. */
	readonly modelRemaining?: readonly string[];
	readonly cancelled?: boolean;
	/** The run ended in an error the harness could not recover from. */
	readonly failed?: boolean;
}

const NARRATIVE_CHARS = 900;

export function parseFinishPayload(text: string): { summary?: string; remaining?: string[] } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as { summary?: unknown; remaining?: unknown };
		const summary = typeof parsed.summary === 'string' ? parsed.summary : undefined;
		const remaining = Array.isArray(parsed.remaining)
			? parsed.remaining.filter((item): item is string => typeof item === 'string' && !!item.trim())
			: undefined;
		if (!summary && !remaining?.length) {
			return undefined;
		}
		return { ...(summary ? { summary } : {}), ...(remaining?.length ? { remaining } : {}) };
	} catch {
		return undefined;
	}
}

export function synthesize(input: ISynthesisInput): IRunOutcome {
	const status = statusOf(input);
	const changes = changeLines(input.store);
	// Re-resolved here rather than trusting the caller: the gates handed in are the *plan*, and
	// a summary built from a plan instead of a result is exactly the bug this module exists for.
	const verification = verificationLines(evaluateGates(input.gates, input.store), input.store);
	const artifacts = artifactLines(input.store);
	const next = nextActions(input, status);

	return {
		status,
		headline: headlineFor(input, status, changes, verification),
		narrative: trim(input.assistantSummary ?? '', NARRATIVE_CHARS),
		changes,
		verification,
		artifacts,
		next,
		statusLine: statusLine(input, status),
	};
}

// --- status ---------------------------------------------------------------------------------

function statusOf(input: ISynthesisInput): RunStatus {
	if (input.cancelled) {
		return 'cancelled';
	}
	if (input.completion.complete) {
		return 'completed';
	}
	// Something was accomplished even though a gate is open: that is partial, not failed. The
	// distinction matters because a failed run invites a retry and a partial one invites a
	// decision about the remainder.
	const didSomething = input.store.changedFiles().length > 0 || input.store.verifiedSince().length > 0;
	if (input.failed && !didSomething) {
		return 'failed';
	}
	return didSomething ? 'partial' : 'failed';
}

// --- headline -------------------------------------------------------------------------------

/**
 * The headline states the outcome against the goal, then qualifies it. It never says "done"
 * without a passing gate behind it, and it never says "failed" when files changed.
 */
function headlineFor(input: ISynthesisInput, status: RunStatus, changes: readonly IChangeLine[], verification: readonly IVerificationLine[]): string {
	const goal = lowerFirst(input.intel.goal);
	const passed = verification.filter(line => line.passed).map(line => line.label);
	const failed = verification.filter(line => !line.passed).map(line => line.label);

	switch (status) {
		case 'cancelled':
			return changes.length
				? `Stopped partway through ${goal}. ${countFiles(changes)} already changed - the edits are still on disk.`
				: `Stopped before changing anything.`;
		case 'completed':
			if (passed.length) {
				return `Done: ${goal}. ${countFiles(changes)} changed, ${joinList(passed)} passing.`;
			}
			return changes.length ? `Done: ${goal}. ${countFiles(changes)} changed.` : `Done: ${goal}.`;
		case 'partial':
			if (failed.length) {
				return `Partly done: ${goal}. ${countFiles(changes)} changed, but ${joinList(failed)} is still failing.`;
			}
			return `Partly done: ${goal}. ${countFiles(changes)} changed. ${input.completion.reason.replace(/^Not done: /, 'Still open: ')}`;
		case 'failed':
		default:
			return `Could not complete ${goal}. ${input.completion.reason.replace(/^Not done: /, '')}`;
	}
}

// --- sections -------------------------------------------------------------------------------

function changeLines(store: EvidenceStore): IChangeLine[] {
	const byPath = new Map<string, IChangeLine>();
	for (const evidence of store.all()) {
		if (evidence.tag !== 'mutation' || !evidence.ok) {
			continue;
		}
		const kind = evidence.tool === 'write_file' ? 'create' : evidence.tool === 'delete_file' ? 'delete' : 'edit';
		// A file created and then edited is still a creation from the user's point of view.
		const existing = byPath.get(evidence.subject);
		byPath.set(evidence.subject, { path: evidence.subject, kind: existing?.kind === 'create' ? 'create' : kind });
	}
	return [...byPath.values()];
}

/**
 * Both the gates the user asked for and any check the run ran on its own. An unavailable gate
 * is reported as not passing, because "this project has no tests" is exactly the caveat a user
 * needs when deciding whether to trust the change.
 */
function verificationLines(gates: readonly IVerificationGate[], store: EvidenceStore): IVerificationLine[] {
	const lines: IVerificationLine[] = [];
	const covered = new Set<string>();

	for (const gate of gates) {
		covered.add(gate.kind);
		switch (gate.status) {
			case 'passed':
				lines.push({ label: gate.kind, passed: true, ...(gate.command ? { detail: gate.command } : {}) });
				break;
			case 'failed':
				lines.push({ label: gate.kind, passed: false, ...(gate.detail ? { detail: gate.detail } : {}) });
				break;
			case 'unavailable':
				lines.push({ label: gate.kind, passed: false, detail: gate.detail ?? 'not available in this project' });
				break;
			case 'pending':
				lines.push({ label: gate.kind, passed: false, detail: 'never run' });
				break;
		}
	}

	for (const evidence of store.verifiedSince()) {
		if (!evidence.proves || covered.has(evidence.proves)) {
			continue;
		}
		lines.push({ label: evidence.proves, passed: evidence.ok, detail: evidence.subject });
	}
	return lines;
}

const URL_RE = /https?:\/\/[^\s"'`<>)]+/;

/**
 * Things the user can open. A dev-server URL printed by a command is the single most useful
 * artifact a run produces and is otherwise buried in terminal output nobody scrolls back to.
 */
function artifactLines(store: EvidenceStore): IArtifact[] {
	const artifacts: IArtifact[] = [];
	const seen = new Set<string>();

	for (const evidence of store.all()) {
		const url = evidence.detail.match(URL_RE)?.[0] ?? (evidence.tag === 'external' ? evidence.subject.match(URL_RE)?.[0] : undefined);
		if (url && !seen.has(url) && !url.includes('schema.org') && !url.includes('w3.org')) {
			seen.add(url);
			artifacts.push({ kind: 'url', value: url, ...(evidence.tool === 'shell' ? { label: 'started by a command' } : {}) });
		}
	}
	return artifacts.slice(0, 5);
}

/**
 * What is left. Sourced from the completion check first (it is authoritative), then the plan,
 * then the model's own list - in that order, because the model's list is the least reliable and
 * duplicating an item the gate already named would read as two separate problems.
 */
function nextActions(input: ISynthesisInput, status: RunStatus): string[] {
	const next: string[] = [];
	const seen = new Set<string>();
	const add = (text: string) => {
		const clean = text.trim().replace(/\s+/g, ' ');
		const key = clean.toLowerCase();
		if (clean && !seen.has(key)) {
			seen.add(key);
			next.push(clean);
		}
	};

	for (const kind of input.completion.failed) {
		add(`Fix the failing ${kind} check.`);
	}
	for (const kind of input.completion.pending) {
		add(`Run the ${kind} check - it has not been run since the last change.`);
	}
	for (const kind of input.completion.unavailable) {
		add(`This project has no ${kind} command, so that part of "done" could not be proven.`);
	}

	for (const step of input.plan?.steps ?? []) {
		if (step.status === 'failed') {
			add(`Retry: ${step.title}${step.note ? ` (${step.note})` : ''}`);
		} else if (step.status === 'skipped') {
			add(`Skipped: ${step.title}${step.note ? ` (${step.note})` : ''}`);
		} else if (status !== 'completed' && step.status === 'pending') {
			add(`Not started: ${step.title}`);
		}
	}

	for (const item of input.modelRemaining ?? []) {
		add(item);
	}

	return next.slice(0, 8);
}

function statusLine(input: ISynthesisInput, status: RunStatus): string {
	if (status === 'cancelled') {
		return 'Cancelled';
	}
	return `Worked for ${formatDuration(input.durationMs)} · ${summarizeWork(input.work)}`;
}

// --- rendering ---------------------------------------------------------------------------------

/**
 * Markdown for the chat pane. Sections are omitted when empty rather than rendered as headings
 * over nothing - a result card with four empty sections reads as a failure even when the run
 * succeeded.
 */
export function renderOutcome(outcome: IRunOutcome): string {
	const blocks: string[] = [outcome.headline];

	if (outcome.narrative) {
		blocks.push(outcome.narrative);
	}

	if (outcome.changes.length) {
		blocks.push([
			`**Changed**`,
			...outcome.changes.map(change => `- ${change.kind === 'create' ? 'created' : change.kind === 'delete' ? 'deleted' : 'edited'} \`${change.path}\``),
		].join('\n'));
	}

	if (outcome.verification.length) {
		blocks.push([
			`**Verified**`,
			...outcome.verification.map(line => `- ${line.passed ? 'passed' : 'not passed'}: ${line.label}${line.detail ? ` - ${line.detail}` : ''}`),
		].join('\n'));
	}

	if (outcome.artifacts.length) {
		blocks.push([
			`**Open**`,
			...outcome.artifacts.map(artifact => `- ${artifact.value}${artifact.label ? ` (${artifact.label})` : ''}`),
		].join('\n'));
	}

	if (outcome.next.length) {
		blocks.push([`**Next**`, ...outcome.next.map(item => `- ${item}`)].join('\n'));
	}

	return blocks.join('\n\n');
}

// --- helpers ---------------------------------------------------------------------------------

function countFiles(changes: readonly IChangeLine[]): string {
	return `${changes.length} file${changes.length === 1 ? '' : 's'}`;
}

function joinList(items: readonly string[]): string {
	if (items.length <= 1) {
		return items[0] ?? '';
	}
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function lowerFirst(text: string): string {
	// Leave an acronym or a path alone: "API docs" must not become "aPI docs".
	return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function trim(text: string, max: number): string {
	const clean = text.trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
