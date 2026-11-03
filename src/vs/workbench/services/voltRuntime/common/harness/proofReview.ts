/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LcsDiff } from '../../../../../base/common/diff/diff.js';
import { IProofReview, IReceiptLine } from './proofOfDone.js';

/**
 * The second opinion. Checks prove what a command can prove; "every requested change is made"
 * and criteria written in prose cannot run. For those, one side request with a clean context
 * (no transcript, so none of the agent's own reasoning to agree with) reads the request, the
 * diff of what the run changed, and the checks that passed, and says per item whether the change
 * does it. It is asked to look for what is missing or wrong, not to grade the work.
 *
 * Bounded on both sides: the diff is cut to a budget with the files it left out named, and the
 * answer is a small JSON object read leniently, so a chatty model still yields a verdict.
 */

export const PROOF_REVIEW_SYSTEM = [
	'You review a coding agent\'s finished change for Volt, with fresh eyes. You see the user\'s request, the diff of what the run changed, the checks that passed, and the agent\'s final message.',
	'For each numbered item, decide whether the diff actually does it. Then list concrete problems a careful reviewer would send back: a requested part that is missing, a change that contradicts the request, an obvious bug or a broken edge the diff introduces.',
	'Judge only from what you are shown. Do not ask for tests, docs, refactors, or polish the user did not ask for, and do not flag style. When the diff plainly does what was asked, pass it.',
	'Answer with one JSON object and nothing else:',
	'{"verdict":"pass"|"fail","summary":"one sentence","items":[{"n":1,"met":true,"note":"short reason"}],"gaps":["concrete problem, with the file"]}',
	'"verdict" is "fail" only when an item is not met or a gap is serious enough that the user would send the work back.',
].join('\n');

export interface IProofReviewInput {
	/** The user's request, as typed. */
	readonly request: string;
	/** The receipt lines nothing could run, in order: these are the numbered items. */
	readonly items: readonly IReceiptLine[];
	/** Checks that passed after the last edit, as `command: last line`. */
	readonly passed: readonly string[];
	readonly diff: string;
	/** The agent's final answer. */
	readonly answer: string;
}

const REQUEST_CHARS = 4_000;
const ANSWER_CHARS = 2_000;
const MAX_GAPS = 5;
const NOTE_CHARS = 200;

export function proofReviewRequest(input: IProofReviewInput): string {
	return [
		'<request>',
		clipBlock(input.request, REQUEST_CHARS),
		'</request>',
		'',
		'<items>',
		...input.items.map((item, index) => `${index + 1}. ${item.text}`),
		'</items>',
		'',
		...(input.passed.length ? ['<checks_passed>', ...input.passed, '</checks_passed>', ''] : []),
		'<diff>',
		input.diff || '(no diff available)',
		'</diff>',
		'',
		'<agent_final_message>',
		clipBlock(input.answer, ANSWER_CHARS) || '(none)',
		'</agent_final_message>',
	].join('\n');
}

/**
 * The reviewer's verdict, or undefined when the answer holds no usable verdict (the run then
 * keeps its items as claimed: a review that failed to run must never read as a pass).
 */
export function parseProofReview(text: string, count: number): IProofReview | undefined {
	const json = outermostObject(text);
	if (!json) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	const record = asRecord(value);
	const verdict = record.verdict === 'pass' || record.verdict === 'fail' ? record.verdict : undefined;
	if (!verdict) {
		return undefined;
	}
	const answers = Array.isArray(record.items) ? record.items.map(asRecord) : [];
	const items = Array.from({ length: count }, (_, index) => {
		const answer = answers.find(item => Number(item.n) === index + 1) ?? answers[index];
		if (!answer || typeof answer.met !== 'boolean') {
			return { met: verdict === 'pass' };
		}
		const note = typeof answer.note === 'string' ? clipLine(answer.note, NOTE_CHARS) : '';
		return { met: answer.met, ...(note ? { note } : {}) };
	});
	const gaps = (Array.isArray(record.gaps) ? record.gaps : [])
		.filter((gap): gap is string => typeof gap === 'string' && !!gap.trim())
		.map(gap => clipLine(gap, NOTE_CHARS))
		.slice(0, MAX_GAPS);
	// A "pass" that lists unmet items is a fail; a "fail" with nothing named is not actionable.
	const failed = verdict === 'fail' ? items.some(item => !item.met) || gaps.length > 0 : items.some(item => !item.met);
	return {
		verdict: failed ? 'fail' : 'pass',
		summary: typeof record.summary === 'string' ? clipLine(record.summary, NOTE_CHARS) : '',
		gaps: failed ? gaps : [],
		items,
	};
}

// --- diff ------------------------------------------------------------------------------------

export interface IFileChangeForReview {
	/** Relative to the run's folder. */
	readonly path: string;
	/** What it held before the run first touched it; undefined when unknown (see `existed`). */
	readonly before: string | undefined;
	/** It existed before the run: with no `before`, its old content was not recorded. */
	readonly existed: boolean;
	/** Undefined: the run deleted it. */
	readonly after: string | undefined;
}

const CONTEXT_LINES = 2;
const MAX_FILE_LINES = 160;
/** Above this many lines on either side the diff is one span: LCS on huge files costs more than it tells. */
const LCS_LINE_LIMIT = 6_000;

/**
 * The run's change as unified diffs, file by file, within `budget` characters. Files that do not
 * fit are named at the end, so the reviewer knows the diff is partial rather than guessing.
 */
export function reviewDiff(files: readonly IFileChangeForReview[], budget = 16_000): string {
	const parts: string[] = [];
	const left: string[] = [];
	let used = 0;
	for (const file of files) {
		const part = fileDiff(file);
		if (!part) {
			continue;
		}
		if (used + part.length > budget && parts.length) {
			left.push(file.path);
			continue;
		}
		const fitted = part.length > budget ? `${part.slice(0, budget)}\n... (cut)` : part;
		parts.push(fitted);
		used += fitted.length;
	}
	if (left.length) {
		parts.push(`(${left.length} more changed file${left.length === 1 ? '' : 's'} not shown: ${left.join(', ')})`);
	}
	return parts.join('\n\n');
}

function fileDiff(file: IFileChangeForReview): string | undefined {
	if (file.before === file.after) {
		return undefined;
	}
	if (file.after === undefined) {
		return `--- ${file.path}\n(deleted, or too large to read)`;
	}
	if (file.before === undefined && file.existed) {
		return `--- ${file.path}\n(changed; its earlier content was not recorded)`;
	}
	const before = file.before === undefined ? [] : file.before.split('\n');
	const after = file.after.split('\n');
	const header = file.before === undefined ? `--- /dev/null\n+++ ${file.path} (new file)` : `--- ${file.path}\n+++ ${file.path}`;
	const body = hunks(before, after);
	const lines = body.length > MAX_FILE_LINES ? [...body.slice(0, MAX_FILE_LINES), `... ${body.length - MAX_FILE_LINES} more diff lines in this file`] : body;
	return [header, ...lines].join('\n');
}

/** Unified hunks with a little context; changes closer than twice the context share a hunk. */
function hunks(before: readonly string[], after: readonly string[]): string[] {
	const changes = before.length > LCS_LINE_LIMIT || after.length > LCS_LINE_LIMIT
		? [spanChange(before, after)]
		: new LcsDiff({ getElements: () => before as string[] }, { getElements: () => after as string[] }).ComputeDiff(false).changes;
	const out: string[] = [];
	let index = 0;
	while (index < changes.length) {
		let last = index;
		while (last + 1 < changes.length && changes[last + 1].originalStart - (changes[last].originalStart + changes[last].originalLength) <= CONTEXT_LINES * 2) {
			last++;
		}
		const first = changes[index];
		const end = changes[last];
		const fromA = Math.max(0, first.originalStart - CONTEXT_LINES);
		const toA = Math.min(before.length, end.originalStart + end.originalLength + CONTEXT_LINES);
		const fromB = Math.max(0, first.modifiedStart - CONTEXT_LINES);
		const toB = Math.min(after.length, end.modifiedStart + end.modifiedLength + CONTEXT_LINES);
		out.push(`@@ -${fromA + 1},${toA - fromA} +${fromB + 1},${toB - fromB} @@`);
		let a = fromA;
		for (let i = index; i <= last; i++) {
			const change = changes[i];
			for (; a < change.originalStart; a++) {
				out.push(` ${before[a]}`);
			}
			for (let k = 0; k < change.originalLength; k++) {
				out.push(`-${before[change.originalStart + k]}`);
			}
			for (let k = 0; k < change.modifiedLength; k++) {
				out.push(`+${after[change.modifiedStart + k]}`);
			}
			a = change.originalStart + change.originalLength;
		}
		for (; a < toA; a++) {
			out.push(` ${before[a]}`);
		}
		index = last + 1;
	}
	return out;
}

/** One change from the first differing line to the last: the cheap form for very large files. */
function spanChange(before: readonly string[], after: readonly string[]): { originalStart: number; originalLength: number; modifiedStart: number; modifiedLength: number } {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
		suffix++;
	}
	return { originalStart: prefix, originalLength: before.length - prefix - suffix, modifiedStart: prefix, modifiedLength: after.length - prefix - suffix };
}

// --- helpers ---------------------------------------------------------------------------------

/** The first `{` to its matching `}`, skipping strings: models wrap JSON in prose or fences. */
function outermostObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === '\\') {
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}' && --depth === 0) {
			return text.slice(start, i + 1);
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clipLine(text: string, max: number): string {
	const single = text.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

function clipBlock(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}\n[...]` : trimmed;
}
