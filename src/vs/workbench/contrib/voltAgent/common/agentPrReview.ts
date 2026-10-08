/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Automatic review of pull requests (Bugbot-style): when a review runs, what its findings are,
 * which of them are new on a re-review, and the prompts it is given. Pure, so every rule here is
 * unit tested; the service in browser/pullRequests runs the review agent and stores the result.
 */

/** `volt.pullRequests.autoReview`: review nothing, the pull requests the user opened, or every open one. */
export type AutoReviewMode = 'off' | 'mine' | 'all';

export const AUTO_REVIEW_MODES: readonly AutoReviewMode[] = ['off', 'mine', 'all'];

export function isAutoReviewMode(value: unknown): value is AutoReviewMode {
	return value === 'off' || value === 'mine' || value === 'all';
}

export type ReviewSeverity = 'high' | 'medium' | 'low';

export type ReviewFindingState = 'open' | 'dismissed' | 'resolved';

/** A finding as the review agent wrote it, before Volt merges it with earlier reviews. */
export interface IRawReviewFinding {
	readonly file: string;
	readonly line: number;
	readonly severity: ReviewSeverity;
	readonly title: string;
	readonly explanation: string;
	readonly suggestion?: string;
}

/** A finding Volt keeps for a pull request. `headSha` is the commit it was last seen on. */
export interface IReviewFinding extends IRawReviewFinding {
	readonly id: string;
	readonly state: ReviewFindingState;
	/** The head the finding was first reported on; new findings on a re-review carry the newest one. */
	readonly firstSeenSha: string;
	readonly headSha: string;
}

export type ReviewRunState = 'running' | 'done' | 'failed';

/** One pull request's review, as stored in `User/voltPullRequests/reviews.json`. */
export interface IPrReviewRecord {
	readonly key: string;
	readonly headSha: string;
	readonly state: ReviewRunState;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly model?: string;
	readonly error?: string;
	readonly findings: readonly IReviewFinding[];
}

/** Lines this far apart still count as the same finding after a push moved it. */
export const FINDING_LINE_WINDOW = 6;
export const REVIEW_DIFF_MAX_CHARS = 120_000;
/** Where the review agent writes its findings, relative to its worktree. */
export const REVIEW_FINDINGS_PATH = '.volt-review/findings.json';

/**
 * Whether a pull request gets a review now. Off means never; `mine` only for pull requests the
 * user opened; a head that was already reviewed (or is being reviewed) is not reviewed again.
 */
export function shouldAutoReview(mode: AutoReviewMode, pr: { readonly isOpen: boolean; readonly isMine: boolean; readonly headSha: string | undefined }, record: IPrReviewRecord | undefined): boolean {
	if (mode === 'off' || !pr.isOpen || !pr.headSha) {
		return false;
	}
	if (mode === 'mine' && !pr.isMine) {
		return false;
	}
	return !record || record.headSha !== pr.headSha;
}

/** Whether a review is still due, and so can start (a restarted window finds half-finished ones). */
export function reviewNeedsStart(record: IPrReviewRecord | undefined, headSha: string): boolean {
	return !record || record.headSha !== headSha || record.state === 'failed';
}

/**
 * The review agent's findings. Accepts the JSON file it writes (`{ "findings": [...] }`) and a
 * reply with a fenced ```json block or bare JSON. Findings without a file, line or title are
 * dropped; an unknown severity counts as medium. Undefined when no JSON object was found.
 */
export function parseReviewOutput(text: string): IRawReviewFinding[] | undefined {
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.findings)) {
		return undefined;
	}
	const out: IRawReviewFinding[] = [];
	for (const item of parsed.findings as unknown[]) {
		const finding = normalizeFinding(item);
		if (finding) {
			out.push(finding);
		}
	}
	return out;
}

function parseJsonObject(text: string): { findings?: unknown } | undefined {
	const candidates: string[] = [];
	const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
	if (fenced) {
		candidates.push(fenced[1]);
	}
	candidates.push(text.trim());
	// Prose before or after the object: the outermost braces.
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start !== -1 && end > start) {
		candidates.push(text.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return value as { findings?: unknown };
			}
		} catch {
			// Not JSON; try the next form.
		}
	}
	return undefined;
}

function normalizeFinding(item: unknown): IRawReviewFinding | undefined {
	if (!item || typeof item !== 'object') {
		return undefined;
	}
	const raw = item as Record<string, unknown>;
	const file = typeof raw.file === 'string' ? raw.file.trim().replace(/^\.\//, '') : '';
	const line = typeof raw.line === 'number' ? Math.floor(raw.line) : Number(raw.line);
	const title = typeof raw.title === 'string' ? raw.title.trim() : '';
	if (!file || !title || !Number.isFinite(line) || line < 1) {
		return undefined;
	}
	const severity: ReviewSeverity = raw.severity === 'high' || raw.severity === 'low' ? raw.severity : 'medium';
	const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : '';
	const suggestion = typeof raw.suggestion === 'string' && raw.suggestion.trim() ? raw.suggestion.trim() : undefined;
	return { file, line, severity, title, explanation, ...(suggestion ? { suggestion } : {}) };
}

/** Same finding: same file and title, and a line within the window (a push shifts lines). */
export function sameFinding(a: Pick<IRawReviewFinding, 'file' | 'line' | 'title'>, b: Pick<IRawReviewFinding, 'file' | 'line' | 'title'>): boolean {
	return a.file === b.file && a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && Math.abs(a.line - b.line) <= FINDING_LINE_WINDOW;
}

/** A stable id for a finding, from where it is and what it says. */
export function findingId(finding: Pick<IRawReviewFinding, 'file' | 'line' | 'title'>): string {
	let hash = 0;
	const text = `${finding.file}\u0000${finding.title.trim().toLowerCase()}\u0000${finding.line}`;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) | 0;
	}
	return `f-${(hash >>> 0).toString(36)}`;
}

/**
 * Merges a new review into the findings already kept for the pull request. A finding that matches
 * an earlier one keeps its id, its state (a dismissed finding stays dismissed) and its first head;
 * an earlier open finding that the new review no longer reports becomes resolved.
 */
export function mergeReviewFindings(previous: readonly IReviewFinding[], raw: readonly IRawReviewFinding[], headSha: string): IReviewFinding[] {
	const merged: IReviewFinding[] = [];
	const matched = new Set<IReviewFinding>();
	for (const finding of raw) {
		const earlier = previous.find(candidate => !matched.has(candidate) && sameFinding(candidate, finding));
		if (earlier) {
			matched.add(earlier);
			merged.push({ ...finding, id: earlier.id, state: earlier.state, firstSeenSha: earlier.firstSeenSha, headSha });
		} else {
			merged.push({ ...finding, id: findingId(finding), state: 'open', firstSeenSha: headSha, headSha });
		}
	}
	for (const finding of previous) {
		if (!matched.has(finding) && finding.state === 'open') {
			merged.push({ ...finding, state: 'resolved' });
		} else if (!matched.has(finding) && finding.state === 'dismissed') {
			merged.push(finding);
		}
	}
	return merged;
}

/** Findings that are open and first appeared on `headSha`: what a re-review adds. */
export function newReviewFindings(findings: readonly IReviewFinding[], headSha: string): IReviewFinding[] {
	return findings.filter(finding => finding.state === 'open' && finding.firstSeenSha === headSha);
}

/** Open findings, most severe first, then by file and line. */
export function openFindingsSorted(findings: readonly IReviewFinding[]): IReviewFinding[] {
	const rank: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
	return findings.filter(finding => finding.state === 'open').sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export function reviewSeverityLabel(severity: ReviewSeverity): string {
	return severity === 'high' ? 'High' : severity === 'low' ? 'Low' : 'Medium';
}

/** Which lines of the new file the diff touched (`@@ -a,b +c,d @@` hunks), per file. */
export function changedLinesByFile(patch: string): Map<string, Set<number>> {
	const out = new Map<string, Set<number>>();
	let file: string | undefined;
	let line = 0;
	for (const row of patch.split('\n')) {
		if (row.startsWith('+++ ')) {
			file = row.slice(4).replace(/^b\//, '').trim();
			if (!out.has(file)) {
				out.set(file, new Set());
			}
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (!file || line === 0) {
			continue;
		}
		if (row.startsWith('+')) {
			out.get(file)!.add(line);
			line++;
		} else if (row.startsWith(' ')) {
			line++;
		}
	}
	return out;
}

/**
 * The review prompt: what the pull request changes, the repository's own rules (`.volt/review.md`)
 * (`.volt/review.md`) when it has them, and where to write the findings. The diff is cut at a size the model can read.
 */
export function buildReviewPrompt(input: { readonly title: string; readonly base: string; readonly head: string; readonly diff: string; readonly rules?: string }): string {
	const diff = input.diff.length > REVIEW_DIFF_MAX_CHARS ? `${input.diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n… (diff cut at ${REVIEW_DIFF_MAX_CHARS} characters; read the files for the rest)` : input.diff;
	const lines = [
		'[Volt review] You are reviewing a pull request in your own worktree, checked out at its head commit.',
		`Pull request: ${input.title} (${input.head} into ${input.base}).`,
		'',
		'Review only the change below for bugs that would hurt users: wrong results, crashes, data loss, security holes, broken edge cases, and tests that no longer test what they claim. Read the surrounding code when a finding depends on it. Do not report style, naming or formatting, and do not report something you cannot point to in a changed line.',
		'',
		'Do not run commands or edit files: the diff is below and nobody can approve tool calls here. Put your findings in your final reply as one ```json block with this shape:',
		'{ "findings": [ { "file": "relative/path.ts", "line": 12, "severity": "high" | "medium" | "low", "title": "short title", "explanation": "what is wrong and when it happens", "suggestion": "the fix, optional" } ] }',
		'Use an empty list when you find nothing. Keep the rest of your reply to one sentence.',
	];
	if (input.rules?.trim()) {
		lines.push('', 'The repository asks reviews to follow these rules (.volt/review.md):', input.rules.trim());
	}
	lines.push('', 'The diff:', '```diff', diff, '```');
	return lines.join('\n');
}

/** The prompt that sends one finding to the chat that owns the pull request. */
export function buildFixPrompt(finding: Pick<IReviewFinding, 'file' | 'line' | 'severity' | 'title' | 'explanation' | 'suggestion'>): string {
	const lines = [
		`A review of this pull request found a ${reviewSeverityLabel(finding.severity).toLowerCase()} severity issue in ${finding.file}:${finding.line}: ${finding.title}.`,
		'',
		finding.explanation || 'No explanation was given.',
	];
	if (finding.suggestion) {
		lines.push('', `The reviewer suggested: ${finding.suggestion}`);
	}
	lines.push('', 'Check the finding against the code, fix it if it is real, and say briefly what you changed. If it is not a real problem, explain why instead of changing the code.');
	return lines.join('\n');
}
