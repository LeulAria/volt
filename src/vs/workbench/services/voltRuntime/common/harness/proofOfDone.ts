/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolResult } from '../tools/tool.js';
import { IEvidence } from './evidence.js';
import { VoltLane } from './lanes.js';
import { defaultCriterionText, EvidenceKind, isMachineCheckable, ITaskIntel } from './taskIntel.js';
import { IProjectChecks } from './verification.js';

/**
 * Proof of done. A run that says it is finished is making a claim. At the start this turns the
 * request into a short contract of what "finished" means: the user's own criteria first, then the
 * project's own check, then the change itself. At the end it writes the run's receipt: every item
 * with the evidence that proves it, recorded after the last edit, or the plain reason it is not
 * proven. On a substantial run the receipt is also the gate: a finish with failed, stale or
 * missing proof goes back to the model with the exact gap and the command that closes it.
 *
 * Pure and model-free. The runtime supplies the evidence, the changed files, the model's own
 * `finish` claims and, when it ran, the second opinion.
 */

/**
 * Where an item stands. `stale`: it passed, but before the last edit, so it proves nothing about
 * the code as it is. `claimed`: nothing can run it (the change itself, a criterion in prose); only
 * the second opinion can turn it into `proven`. `unavailable`: the project declares no command for it.
 */
export type ProofStatus = 'proven' | 'failed' | 'stale' | 'missing' | 'claimed' | 'unavailable';

export type ProofVerdict = 'proven' | 'partial' | 'failed';

/** Who put an item on the receipt: the user's request, Volt's own floor, or the agent's `finish` claim. */
export type ProofSource = 'user' | 'volt' | 'agent';

export interface IDoneItem {
	readonly text: string;
	readonly kind: EvidenceKind;
	/** The project command that proves it, when the project declares one. */
	readonly command?: string;
	readonly source: ProofSource;
}

export interface IDoneContract {
	/** The user's criteria (at most four), then the change itself. */
	readonly items: readonly IDoneItem[];
	/** The project's own check, for a change to code. Added to the receipt only when it is worth running. */
	readonly floor?: IDoneItem;
	/** The request alone makes this run substantial: the gate applies from the first finish. */
	readonly substantial: boolean;
}

export interface IReceiptLine {
	readonly text: string;
	readonly kind: EvidenceKind;
	readonly status: ProofStatus;
	readonly source: ProofSource;
	/** The command that ran, or the one that would prove it. */
	readonly command?: string;
	/** Why it has this status: the failure's first line, an output tail, the reviewer's note. Bounded. */
	readonly detail?: string;
}

/** The second opinion: a fresh-context review of the diff against the items nothing could run. */
export interface IProofReview {
	readonly verdict: 'pass' | 'fail';
	/** One line on what the reviewer found. */
	readonly summary: string;
	/** Concrete problems to fix (a requirement missed, a bug in the diff). At most five. */
	readonly gaps: readonly string[];
	/** Per claimed item, in the order they were asked: met or not, with a short note. */
	readonly items: readonly { readonly met: boolean; readonly note?: string }[];
}

export interface IRunReceipt {
	readonly verdict: ProofVerdict;
	readonly lines: readonly IReceiptLine[];
	/** Changed files relative to the run's folder, in the order first touched. At most twelve. */
	readonly changed: readonly string[];
	readonly changedCount: number;
	/** What the agent itself said is left (`finish.remaining`). */
	readonly open: readonly string[];
	readonly review?: IProofReview;
	/** The receipt was binding: a finish it did not prove went back. */
	readonly gated: boolean;
	/** How many times the gate sent the run back before it ended. */
	readonly sentBack: number;
}

/** What the agent put in its `finish` call: checks it says passed, and what it says is left. */
export interface IFinishClaims {
	readonly verified: readonly string[];
	readonly remaining: readonly string[];
}

const MAX_USER_ITEMS = 4;
const MAX_CHANGED = 12;
const MAX_OPEN = 5;
const MAX_CLAIMS = 3;
const TEXT_CHARS = 120;
const DETAIL_CHARS = 280;

/**
 * What a request must say for a check to bind: the check as an outcome ("the build passes", "make
 * sure it type-checks"), not the same word as a verb or a noun ("build a page", "add types").
 */
const STRICT_HINTS: Partial<Record<EvidenceKind, RegExp>> = {
	test: /\b(?:unit |e2e |integration )?tests?\b|\bspecs?\b|\bjest\b|\bvitest\b|\bmocha\b|\bpytest\b|\btest suite\b/i,
	typecheck: /\btype-?checks?\b|\btsc\b|\bmypy\b|\bpyright\b|\btype errors?\b|\btypes? (?:check|pass|clean|are (?:clean|correct|sound))/i,
	lint: /\blint(?:s|er|ing)?\b|\beslint\b|\bruff\b|\bclippy\b|\bprettier\b|\bformatter\b/i,
	build: /\bthe build\b|\b(?:it|project|app|code|still|everything) (?:still )?(?:builds|compiles)\b|\bbuilds? (?:cleanly|successfully|fine|green|without)\b|\bcompiles?\b|\bnpm run build\b|\bcargo build\b|\bvite build\b|\bwebpack\b/i,
	browser: /\bin the browser\b|\bscreenshots?\b|\bvisually\b|\bon screen\b|\bui looks?\b/i,
};

/** Request complexity (taskIntel's 0..1 score) from which an agent-lane run is gated from the start. */
const SUBSTANTIAL_SCORE = 0.45;
/** Work that makes any writing run substantial, whatever the request looked like. */
const SUBSTANTIAL_FILES = 4;
const SUBSTANTIAL_STEPS = 16;

/** Files whose change cannot break a build or a test: docs, styles, images, fonts. */
export const NO_CODE_IMPACT = /\.(?:md|mdx|markdown|txt|rst|css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf)$/i;

// --- contract ------------------------------------------------------------------------------

export interface IDoneContractInput {
	/** The request as typed: a check named only in passing must be confirmed by it. */
	readonly text: string;
	readonly intel: ITaskIntel;
	readonly checks: IProjectChecks;
	readonly lane: VoltLane;
	readonly readOnly: boolean;
}

/**
 * The contract for one run. Read-only and chat runs change nothing, so they have none. Each
 * machine check appears once, however many ways the user phrased it; prose criteria stay as
 * written (minus the "so that" in front), because Volt must never paraphrase what was asked.
 */
export function doneContract(input: IDoneContractInput): IDoneContract {
	if (input.readOnly || input.lane === 'chat') {
		return { items: [], substantial: false };
	}
	const items: IDoneItem[] = [];
	const kinds = new Set<EvidenceKind>();
	for (const criterion of input.intel.successCriteria) {
		const lookup = criterion.evidence === 'lookup';
		if ((!criterion.explicit && !lookup) || criterion.evidence === 'diff' || items.length >= MAX_USER_ITEMS) {
			continue;
		}
		// Task intel reads checks loosely ("build a page" names the build); a contract item binds, so it must be meant.
		const named = criterion.text === defaultCriterionText(criterion.evidence);
		const meant = !STRICT_HINTS[criterion.evidence] || STRICT_HINTS[criterion.evidence]!.test(named ? input.text : criterion.text);
		if (named && !meant) {
			continue;
		}
		const kind: EvidenceKind = meant ? criterion.evidence : 'manual';
		if (kind !== 'manual' && kinds.has(kind)) {
			continue;
		}
		kinds.add(kind);
		const command = commandFor(kind, input.checks);
		items.push({ text: criterionSentence(criterion.text), kind, ...(command ? { command } : {}), source: criterion.explicit ? 'user' : 'volt' });
	}
	items.push({ text: input.intel.deliverables.length > 1 ? 'Every requested change is made.' : 'The requested change is made.', kind: 'diff', source: 'volt' });

	const askedForCheck = items.some(item => item.source === 'user' && isProjectCheck(item.kind));
	const floor = askedForCheck ? undefined : floorFor(input.checks);
	return {
		items,
		...(floor ? { floor } : {}),
		substantial: input.lane === 'mission'
			|| items.some(item => item.source === 'user' && isMachineCheckable(item.kind))
			|| (input.lane === 'agent' && input.intel.complexityScore >= SUBSTANTIAL_SCORE),
	};
}

/** Substantial now: by the request, or by the work the run has done so far. */
export function isSubstantialRun(contract: IDoneContract, work: { readonly changedFiles: number; readonly steps: number }): boolean {
	return contract.substantial || work.changedFiles >= SUBSTANTIAL_FILES || work.steps >= SUBSTANTIAL_STEPS;
}

/**
 * What the model reads with the request on a run gated from the start, so it plans the proof
 * instead of discovering it at the gate. Undefined when there is nothing to say beyond "make the
 * change". Appended to the message, never to the cached system prompt.
 */
export function contractNote(contract: IDoneContract): string | undefined {
	const items = [...contract.items.filter(item => item.kind !== 'diff'), ...(contract.floor ? [{ ...contract.floor, text: `${contract.floor.text.replace(/\.$/, '')}, if you change code.` }] : [])];
	if (!contract.substantial || !items.length) {
		return undefined;
	}
	return [
		'[Volt] Done when (Volt checks each against what ran after your last edit before this run can end):',
		...items.map((item, index) => `${index + 1}. ${item.text}${item.command ? ` (\`${item.command}\`)` : ''}`),
	].join('\n');
}

// --- receipt -------------------------------------------------------------------------------

export interface IReceiptInput {
	readonly contract: IDoneContract;
	/** The run's evidence in the order it was recorded (`EvidenceStore.all()`). */
	readonly evidence: readonly IEvidence[];
	/** Changed files relative to the run's folder, deduplicated, in the order first touched. */
	readonly changed: readonly string[];
	readonly claims?: IFinishClaims;
	readonly review?: IProofReview;
	/** Whether the floor check belongs on the receipt (a substantial run, or one that ran it anyway). */
	readonly withFloor: boolean;
	readonly gated: boolean;
	readonly sentBack: number;
}

export function buildReceipt(input: IReceiptInput): IRunReceipt {
	const lastEdit = findLastIndex(input.evidence, item => item.tag === 'mutation' && item.ok);
	const prove = (item: IDoneItem): IReceiptLine => ({ ...item, ...statusOf(item, input.evidence, lastEdit, input.changed.length) });

	const lines = input.contract.items.map(prove);
	const floor = input.contract.floor;
	if (floor && input.changed.some(path => !NO_CODE_IMPACT.test(path)) && (input.withFloor || ranSince(input.evidence, floor.kind, -1))) {
		// The project's check sits before the change itself: it is the stronger proof.
		lines.splice(Math.max(0, lines.length - 1), 0, prove(floor));
	}
	for (const claim of claimLines(input.claims, lines)) {
		lines.push(prove(claim));
	}

	const reviewed = input.review ? applyReview(lines, input.review) : lines;
	const open = (input.claims?.remaining ?? []).map(text => clip(text, TEXT_CHARS)).slice(0, MAX_OPEN);
	return {
		verdict: verdictOf(reviewed, open, input.review),
		lines: reviewed,
		changed: input.changed.slice(0, MAX_CHANGED),
		changedCount: input.changed.length,
		open,
		...(input.review ? { review: input.review } : {}),
		gated: input.gated,
		sentBack: input.sentBack,
	};
}

/** A receipt worth showing: something was checked, asked for, or claimed. A quick edit with none of these gets no card. */
export function isReceiptWorthShowing(receipt: IRunReceipt): boolean {
	if (!receipt.changedCount && !receipt.lines.some(line => line.status === 'failed' || (line.status === 'proven' && line.kind !== 'diff'))) {
		return false;
	}
	return receipt.gated
		|| !!receipt.review
		|| !!receipt.open.length
		|| receipt.lines.some(line => line.source !== 'volt' || (line.kind !== 'diff' && line.status !== 'missing'));
}

/** The lines a gated finish cannot end with: checks that failed, went stale, or never ran. */
export function receiptGaps(receipt: IRunReceipt): IReceiptLine[] {
	return receipt.lines.filter(line => (line.status === 'failed' || line.status === 'stale' || line.status === 'missing') && line.kind !== 'diff' && line.kind !== 'manual');
}

/**
 * The message that sends a finish back: one line per gap, each with the action that closes it,
 * then the second opinion's problems when it failed the change (`withReview`: a review sends a
 * run back once, not on every later finish). Undefined when nothing blocks.
 */
export function sendBackMessage(receipt: IRunReceipt, withReview = true): string | undefined {
	const gaps = receiptGaps(receipt).map(gapLine);
	const review = withReview && receipt.review?.verdict === 'fail' ? reviewLines(receipt) : [];
	if (!gaps.length && !review.length) {
		return undefined;
	}
	return [
		'Not done yet. Volt checked your finish against what ran after your last edit:',
		...gaps,
		...(review.length ? [receipt.review?.summary ? `A second reviewer read your diff: ${receipt.review.summary}` : 'A second reviewer read your diff and found:', ...review] : []),
		'Close these, then finish. If one cannot be done here, say why in one line in your final answer instead of claiming it.',
	].join('\n');
}

/** The receipt as the model would read it in a later turn: one compact line, no output. */
export function receiptSummary(receipt: IRunReceipt): string {
	const proven = receipt.lines.filter(line => line.status === 'proven').length;
	const failing = receipt.lines.filter(line => line.status === 'failed').map(line => line.command ?? line.text);
	return `Proof: ${receipt.verdict}, ${proven}/${receipt.lines.length} proven${failing.length ? `; failing: ${failing.join(', ')}` : ''}${receipt.open.length ? `; left open: ${receipt.open.length}` : ''}.`;
}

// --- finish claims ---------------------------------------------------------------------------

/** The agent's own `finish` payload in a step's results (`{ summary, changed, verified, remaining }`). */
export function parseFinishClaims(results: readonly IToolResult[]): IFinishClaims | undefined {
	const finish = results.find(result => result.name === 'finish' && !result.isError);
	if (!finish) {
		return undefined;
	}
	try {
		const payload = JSON.parse(finish.text) as { verified?: unknown; remaining?: unknown };
		return { verified: strings(payload.verified), remaining: strings(payload.remaining) };
	} catch {
		return undefined;
	}
}

/** Claim phrasings that name a check without its command ("type-check is clean", "all specs green"). */
const CLAIM_HINTS: readonly (readonly [RegExp, EvidenceKind])[] = [
	[/\btype-?check|\btsc\b|\bmypy\b|\bpyright\b|\btypes? (?:are )?(?:clean|ok|pass)/i, 'typecheck'],
	[/\blint|\bclippy\b|\bruff\b|\bgo vet\b/i, 'lint'],
	[/\btests?\b|\bspecs?\b|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b/i, 'test'],
	[/\bbuilds?\b|\bcompiles?\b|\bbundles?\b/i, 'build'],
	[/\bbrowser\b|\bscreenshot\b|\bsnapshot\b|\bon screen\b/i, 'browser'],
];

/**
 * The agent's "verified" claims that name a check the contract does not already cover, one per
 * kind. A claim with no matching run after the last edit shows up as missing, which is the point:
 * "tests pass" with no test run on record is the exact failure this exists to catch.
 */
function claimLines(claims: IFinishClaims | undefined, lines: readonly IReceiptLine[]): IDoneItem[] {
	if (!claims) {
		return [];
	}
	const covered = new Set(lines.map(line => line.kind));
	const out: IDoneItem[] = [];
	for (const claim of claims.verified) {
		const kind = CLAIM_HINTS.find(([pattern]) => pattern.test(claim))?.[1];
		if (!kind || covered.has(kind)) {
			continue;
		}
		covered.add(kind);
		out.push({ text: clip(claim, TEXT_CHARS), kind, source: 'agent' });
		if (out.length >= MAX_CLAIMS) {
			break;
		}
	}
	return out;
}

// --- status ----------------------------------------------------------------------------------

function statusOf(item: IDoneItem, evidence: readonly IEvidence[], lastEdit: number, changed: number): Pick<IReceiptLine, 'status' | 'detail' | 'command'> {
	switch (item.kind) {
		case 'diff':
			return changed ? { status: 'claimed' } : { status: 'missing', detail: 'Nothing in the workspace changed.' };
		case 'manual':
			return { status: 'claimed' };
		case 'lookup':
			return evidence.some(entry => entry.ok && (entry.tag === 'external' || entry.tool === 'web_search' || entry.tool === 'web_fetch'))
				? { status: 'proven', detail: 'Looked up on the web.' }
				: { status: 'missing', detail: 'Nothing was looked up.' };
		case 'runtime': {
			const at = findLastIndex(evidence, entry => entry.ok && (entry.proves === 'browser' || entry.proves === 'test' || (entry.tool === 'shell' && entry.tag === 'observation')));
			if (at < 0 || at < lastEdit) {
				return { status: 'missing', detail: at >= 0 ? 'It last ran before the last edit.' : 'Nothing ran it after the change.' };
			}
			const entry = evidence[at];
			return { status: 'proven', ...(entry.tool === 'shell' ? { command: entry.subject } : {}), detail: firstLine(entry.detail) || entry.subject };
		}
		default: {
			const at = findLastIndex(evidence, entry => entry.proves === item.kind && (entry.tag === 'verification' || entry.tag === 'external'));
			if (at < 0) {
				// The project has no command for a check the user asked for; an agent's claim with no run is simply unbacked.
				if (!item.command && item.kind !== 'browser' && item.source !== 'agent') {
					return { status: 'unavailable', detail: `This project declares no ${item.kind} command.` };
				}
				return { status: 'missing', detail: item.kind === 'browser' ? 'Not looked at in the browser after the change.' : 'Never ran.' };
			}
			const entry = evidence[at];
			const command = entry.tool === 'shell' || entry.tag === 'verification' ? entry.subject : item.command;
			if (at < lastEdit) {
				return { status: 'stale', ...(command ? { command } : {}), detail: entry.ok ? 'Passed before the last edit.' : 'Failed before the last edit.' };
			}
			return entry.ok
				? { status: 'proven', ...(command ? { command } : {}), ...(outputTail(entry.detail) ? { detail: outputTail(entry.detail) } : {}) }
				: { status: 'failed', ...(command ? { command } : {}), detail: failureLine(entry.detail) };
		}
	}
}

/** The second opinion settles the items nothing could run: met ones become proven, unmet ones fail. */
function applyReview(lines: readonly IReceiptLine[], review: IProofReview): IReceiptLine[] {
	let asked = 0;
	return lines.map(line => {
		if (line.status !== 'claimed') {
			return line;
		}
		const answer = review.items[asked++];
		if (!answer) {
			return review.verdict === 'pass' ? { ...line, status: 'proven', detail: 'Second opinion: met.' } : line;
		}
		return { ...line, status: answer.met ? 'proven' : 'failed', detail: clip(answer.note || (answer.met ? 'Second opinion: met.' : 'Second opinion: not met.'), DETAIL_CHARS) };
	});
}

function verdictOf(lines: readonly IReceiptLine[], open: readonly string[], review: IProofReview | undefined): ProofVerdict {
	if (lines.some(line => line.status === 'failed') || review?.verdict === 'fail') {
		return 'failed';
	}
	return !open.length && lines.every(line => line.status === 'proven' || line.status === 'unavailable') ? 'proven' : 'partial';
}

function gapLine(line: IReceiptLine): string {
	const run = line.command ? `\`${line.command}\`` : undefined;
	switch (line.status) {
		case 'failed':
			return `- ${line.text} ${run ? `${run} failed` : 'Failed'} after your last edit${line.detail ? `: ${line.detail}` : ''}. Fix the cause and run it again.`;
		case 'stale':
			return `- ${line.text} ${run ?? 'It'} last ran before your last edit. Run it again.`;
		default:
			if (line.source === 'agent') {
				return `- You said "${line.text}", but no run of it after your last edit is on record. Run it, or drop the claim.`;
			}
			switch (line.kind) {
				case 'browser':
					return `- ${line.text} Look at it in the browser (a snapshot or screenshot) after your last edit.`;
				case 'runtime':
					return `- ${line.text} Run it after your last edit and show that it works.`;
				case 'lookup':
					return `- ${line.text} Look it up (web_search, then web_fetch the primary source) instead of answering from memory.`;
				default:
					return `- ${line.text} Run ${run ?? `the project's ${line.kind} check`}: nothing has checked it since your last edit.`;
			}
	}
}

function reviewLines(receipt: IRunReceipt): string[] {
	const unmet = receipt.lines.filter(line => line.status === 'failed' && (line.kind === 'diff' || line.kind === 'manual')).map(line => `- ${line.text} ${line.detail ?? ''}`.trim());
	const gaps = (receipt.review?.gaps ?? []).map(gap => `- ${gap}`);
	return [...unmet, ...gaps].slice(0, 6);
}

// --- helpers ---------------------------------------------------------------------------------

/** The project's first check by strength of proof per second: type-check, then build, then tests, then lint. */
function floorFor(checks: IProjectChecks): IDoneItem | undefined {
	if (checks.typecheck) {
		return { text: 'The project still type-checks.', kind: 'typecheck', command: checks.typecheck, source: 'volt' };
	}
	if (checks.build) {
		return { text: 'The project still builds.', kind: 'build', command: checks.build, source: 'volt' };
	}
	if (checks.test) {
		return { text: 'The project\'s tests still pass.', kind: 'test', command: checks.test, source: 'volt' };
	}
	if (checks.lint) {
		return { text: 'The project still lints clean.', kind: 'lint', command: checks.lint, source: 'volt' };
	}
	return undefined;
}

function commandFor(kind: EvidenceKind, checks: IProjectChecks): string | undefined {
	switch (kind) {
		case 'test': return checks.test;
		case 'typecheck': return checks.typecheck;
		case 'lint': return checks.lint;
		case 'build': return checks.build;
		default: return undefined;
	}
}

function isProjectCheck(kind: EvidenceKind): boolean {
	return kind === 'test' || kind === 'typecheck' || kind === 'lint' || kind === 'build';
}

/** A check of `kind` ran after evidence index `after` (-1: at any time). */
function ranSince(evidence: readonly IEvidence[], kind: EvidenceKind, after: number): boolean {
	return findLastIndex(evidence, entry => entry.tag === 'verification' && entry.proves === kind) > after;
}

const CONNECTIVE = /^(?:so that|such that|until|verify that|confirm that|prove that|make sure(?: that)?|ensure(?: that)?|it should|they should|the result should|expected(?: to be)?)\s+/i;

/** "so that the form saves on enter" -> "The form saves on enter." */
function criterionSentence(text: string): string {
	const stripped = text.trim().replace(CONNECTIVE, '').replace(/[\s,;:]+$/, '');
	if (!stripped) {
		return clip(text, TEXT_CHARS);
	}
	const sentence = stripped[0].toUpperCase() + stripped.slice(1);
	return clip(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`, TEXT_CHARS);
}

/** The line a failing check is known by: the first that reads like an error, else the first. */
function failureLine(detail: string): string {
	const lines = detail.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('$ ') && !/^\[exit /.test(line));
	const error = lines.find(line => /\b(?:error|fail(?:ed|ing|ure)?|assert|expected|cannot|not found|exception|TS\d{4})\b/i.test(line));
	return clip(error ?? lines[0] ?? 'It failed.', DETAIL_CHARS);
}

/** A passing check's last meaningful line ("42 passing", "Found 0 errors"), without the shell's own status line. */
function outputTail(detail: string): string | undefined {
	const lines = detail.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('$ ') && !/^\[(?:exit |output was long)/i.test(line) && line !== '(no output)');
	const last = lines.at(-1);
	return last ? clip(last, DETAIL_CHARS) : undefined;
}

function firstLine(text: string): string {
	return clip((text.split('\n').find(line => line.trim() && !line.startsWith('$ ')) ?? '').trim(), DETAIL_CHARS);
}

function clip(text: string, max: number): string {
	const single = text.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()) : [];
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (predicate(items[i])) {
			return i;
		}
	}
	return -1;
}
