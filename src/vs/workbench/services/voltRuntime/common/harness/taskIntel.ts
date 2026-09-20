/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIntent } from './intent.js';
import { formatShapeBrief, IRequestShape, needsResearch } from './requestShape.js';

/**
 * Task intelligence. The intent router answers "which lane"; this answers "what is actually
 * being asked for". It is deterministic and model-free for the same reason the router is: it
 * runs on every send and must not cost a round trip.
 *
 * Its four consumers each need a different slice:
 *   - the context pack injects `constraints` so the model sees "don't touch X" as a rule,
 *     not as a sentence buried in the transcript;
 *   - the planner decomposes `deliverables`;
 *   - the verification engine turns `successCriteria` into gates;
 *   - the model router reads `complexityScore` to decide whether to escalate.
 *
 * Every field degrades to something harmless when the text gives nothing away: no constraints,
 * one deliverable, `moderate` complexity, zero ambiguity.
 */

export type TaskComplexity = 'trivial' | 'small' | 'moderate' | 'large' | 'epic';

export type ConstraintKind =
	| 'forbid'         // "don't add dependencies"
	| 'require'        // "must keep the public API"
	| 'scope'          // "only touch the header"
	| 'style';         // "match the existing pattern"

export interface ITaskConstraint {
	readonly kind: ConstraintKind;
	/** The clause as the user wrote it, trimmed. Replayed verbatim so nothing is paraphrased away. */
	readonly text: string;
}

/**
 * How Volt expects to prove a criterion. The verification engine maps these onto the project's
 * own commands; `manual` means there is nothing to run and the diff is the evidence.
 */
export type EvidenceKind = 'build' | 'test' | 'lint' | 'typecheck' | 'runtime' | 'browser' | 'diff' | 'manual' | 'lookup';

/**
 * Whether proving this criterion means running something. `diff`, `manual`, and `lookup` are
 * proved by the change existing, the answer matching the asked form, or a web result - they
 * never justify a project-check verification step of their own.
 */
export function isMachineCheckable(evidence: EvidenceKind): boolean {
	return evidence !== 'diff' && evidence !== 'manual' && evidence !== 'lookup';
}

export interface ISuccessCriterion {
	readonly text: string;
	readonly evidence: EvidenceKind;
	/** Stated by the user rather than inferred by Volt. Stated criteria are never dropped. */
	readonly explicit: boolean;
}

export interface IAmbiguity {
	/** 0 = fully specified, 1 = unusable. The clarify gate trips well above 0.5. */
	readonly score: number;
	readonly reasons: readonly string[];
	/** The one question worth interrupting for. Undefined means proceed. */
	readonly question?: string;
}

export interface ITaskDependency {
	/** Index into `deliverables`. */
	readonly from: number;
	readonly to: number;
	/** The word that established the order ("then", "after", "once"). */
	readonly marker: string;
}

export interface ITaskIntel {
	/** One imperative line. Used by the planner, the work log, and the final summary. */
	readonly goal: string;
	readonly deliverables: readonly string[];
	readonly constraints: readonly ITaskConstraint[];
	readonly successCriteria: readonly ISuccessCriterion[];
	readonly dependencies: readonly ITaskDependency[];
	readonly complexity: TaskComplexity;
	/** 0..1. Continuous because the model router thresholds it. */
	readonly complexityScore: number;
	readonly ambiguity: IAmbiguity;
	/** How the answer itself should look. Independent of the coding lane. */
	readonly shape: IRequestShape;
}

export interface ITaskIntelContext {
	/** Prior user turns. A dangling "fix it" is only ambiguous on the first turn. */
	readonly hasPriorTurns?: boolean;
	/** Files the user attached or @-mentioned. A named target removes most ambiguity. */
	readonly attachments?: readonly string[];
}

// --- lexicon -------------------------------------------------------------------------------

const LEAD_IN = /^(?:\s*(?:hey|hi|hello|ok(?:ay)?|so|yo|please|pls|plz|kindly|now|alright|right|just|quick(?:ly)?)[,!.\s]+)+/i;

const REQUEST_FRAME = /^(?:(?:can|could|would|will) you(?: please)?|i(?:'d| would) like you to|i want you to|i need you to|(?:please )?(?:help me|let'?s)|(?:i )?want to|(?:i )?need to|we (?:should|need to|want to))\s+/i;

const SLASH = /^\/(?:mission|fast|quick|ask|chat|q)\b\s*/i;

const VERBS = 'fix|add|implement|refactor|rename|create|update|remove|delete|write|build|migrate|install|run|test|debug|deploy|change|make|edit|move|replace|convert|generate|set ?up|configure|wire|hook up|extract|inline|split|merge|clean ?up|optimi[sz]e|speed up|improve|rewrite|port|upgrade|bump|revert|patch|scaffold|bootstrap|integrate|connect|enable|disable|introduce|drop|swap|style|restyle|redesign|polish|animate|center|align|resize|format|lint|type-?check|compile|bundle|ship|release|publish|support|handle|validate|cache|log|track|document';

const IMPERATIVE = new RegExp(`\\b(?:${VERBS})\\b`, 'i');

/**
 * Clause separators that imply "another thing to do", not "another way of saying it". A bare
 * "and" only splits when the next word is itself an imperative, so "a button and a spinner"
 * stays one deliverable while "add a button and update the tests" becomes two.
 */
const CLAUSE_SPLIT = new RegExp([
	'\\n+',
	'(?:^|\\s)(?:[-*•]|\\d+[.)])\\s+',
	';\\s+',
	',?\\s+(?:and then|then|after that|afterwards|next|also|plus|as well as|followed by|before (?:you|we|i))\\s+',
	`,?\\s+and\\s+(?=(?:${VERBS})\\b)`,
].join('|'), 'i');

const ORDER_MARKER = /\b(then|after|afterwards|once|before|first|finally|last(?:ly)?|next|followed by|so that|in order to)\b/i;

const FORBID = /\b(?:don'?t|do not|never|avoid|without|no need to|skip|refrain from|stop|leave out|omit|must not|shouldn'?t|should not|cannot|can'?t)\b[^.;\n]*/gi;

const REQUIRE = /\b(?:must|has to|have to|needs? to|make sure|ensure|always|required to|be sure to|remember to|it'?s important (?:that|to))\b[^.;\n]*/gi;

const SCOPE = /\b(?:only|just|nothing else|don'?t touch|leave .{1,40} (?:alone|as is|unchanged)|keep .{1,40} (?:as is|unchanged|intact)|limit(?:ed)? to|scoped? to|within|restrict(?:ed)? to)\b[^.;\n]*/gi;

const STYLE = /\b(?:match(?:ing)? the|follow(?:ing)? the|same (?:style|pattern|convention|approach)|consistent with|in the style of|like the (?:existing|other)|idiomatic|house style)\b[^.;\n]*/gi;

/** Phrasings that state an acceptance condition rather than an action. */
const CRITERION = /\b(?:so that|such that|until|it should|they should|so it|so they|the result should|expected(?: to be)?|acceptance|definition of done|verify that|confirm that|prove that)\b[^.;\n]*/gi;

const EVIDENCE_HINTS: readonly (readonly [RegExp, EvidenceKind])[] = [
	[/\b(?:unit )?tests?\b|\bspecs?\b|\bjest\b|\bvitest\b|\bmocha\b|\bpytest\b|\btest suite\b|\bpasses?\b/i, 'test'],
	[/\btype-?check|\btypes?\b|\btsc\b|\bmypy\b|\btype error/i, 'typecheck'],
	[/\blint|\beslint\b|\bruff\b|\bclippy\b|\bformat/i, 'lint'],
	[/\bbuilds?\b|\bcompiles?\b|\bbundle|\bwebpack\b|\bvite build\b|\bcargo build\b/i, 'build'],
	[/\bin the browser\b|\bscreenshot|\bvisually|\brenders?\b|\bui looks?\b|\bon screen\b/i, 'browser'],
	[/\bruns?\b|\bstarts?\b|\bboots?\b|\bno (?:runtime )?errors?\b|\bworks?\b|\bwithout crashing\b/i, 'runtime'],
];

const VAGUE_QUALITY = /\b(?:better|nicer|cleaner|prettier|improve(?:d)?|nice|good|great|awesome|modern|professional|polish(?:ed)?|beautiful|slick|cool|proper(?:ly)?)\b/i;

const DANGLING_REFERENT = /^(?:fix|change|update|improve|refactor|remove|delete|move|rename|redo|revert|finish|continue|do)\s+(?:it|this|that|these|those|them|the rest|the same)\b/i;

const NEGATION = `(?:don'?t|do not|never|without|no new)`;

const CONTRADICTION: readonly (readonly [RegExp, RegExp, string])[] = [
	[new RegExp(`\\b${NEGATION} (?:add(?:ing)?|install(?:ing)?|introduc(?:e|ing)) (?:any )?(?:new )?(?:deps?\\b|dependenc)`, 'i'), /\b(?:add|install|use) .{0,30}\b(?:library|package|dependency|npm|pip)\b/i, 'asks for a library and forbids new dependencies'],
	[new RegExp(`\\b${NEGATION} (?:chang(?:e|ing)|touch(?:ing)?|modif(?:y|ying))\\b`, 'i'), /\b(?:rewrite|refactor|migrate) (?:the )?(?:whole|entire|all)\b/i, 'forbids changes and asks for a rewrite'],
	[/\bkeep it simple\b|\bminimal\b|\bsmallest\b/i, /\b(?:production[- ]ready|enterprise|fully[- ]featured|comprehensive|exhaustive)\b/i, 'asks for minimal and comprehensive at once'],
];

// --- entry point ---------------------------------------------------------------------------

export function analyzeTask(text: string, intent: IIntent, context: ITaskIntelContext = {}): ITaskIntel {
	const raw = text.trim();
	const body = raw.replace(SLASH, '').trim();

	const shape = intent.shape;
	const deliverables = extractDeliverables(body);
	const dependencies = extractDependencies(body, deliverables);
	const constraints = extractConstraints(body);
	const successCriteria = extractSuccessCriteria(body, intent, deliverables, shape);
	const complexityScore = scoreComplexity(body, intent, deliverables, constraints, shape);

	return {
		goal: extractGoal(body, deliverables),
		deliverables,
		constraints,
		successCriteria,
		dependencies,
		complexity: bucketComplexity(complexityScore),
		complexityScore,
		ambiguity: scoreAmbiguity(body, intent, context),
		shape,
	};
}

// --- goal ----------------------------------------------------------------------------------

const GOAL_MAX = 140;

/**
 * The goal is the request with the social wrapper removed. It is deliberately not a paraphrase:
 * anything Volt invents here would be repeated back in the final summary as if the user had
 * said it.
 */
function extractGoal(body: string, deliverables: readonly string[]): string {
	const first = deliverables[0] ?? body;
	const stripped = first.replace(LEAD_IN, '').replace(REQUEST_FRAME, '').trim();
	const single = stripped.replace(/\s+/g, ' ');
	if (!single) {
		return body.slice(0, GOAL_MAX);
	}
	const capped = single.length > GOAL_MAX ? `${single.slice(0, GOAL_MAX - 1).trimEnd()}…` : single;
	return capped.replace(/[.?!]+$/, '');
}

// --- deliverables + dependencies -------------------------------------------------------------

const DELIVERABLE_MIN_WORDS = 2;
const DELIVERABLE_LIMIT = 12;

/**
 * Splits the request into the things being asked for. Only clauses that carry an imperative
 * survive, so "add auth and it's urgent" yields one deliverable rather than two.
 */
function extractDeliverables(body: string): string[] {
	const clauses = body
		.split(CLAUSE_SPLIT)
		.map(clause => clause.replace(LEAD_IN, '').replace(REQUEST_FRAME, '').trim())
		.filter(Boolean);

	const withVerbs = clauses.filter(clause =>
		IMPERATIVE.test(clause) && clause.split(/\s+/).length >= DELIVERABLE_MIN_WORDS);

	const chosen = withVerbs.length ? withVerbs : clauses.slice(0, 1);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const clause of chosen) {
		const normalized = clause.replace(/\s+/g, ' ').replace(/[.,;]+$/, '');
		const key = normalized.toLowerCase();
		if (normalized && !seen.has(key)) {
			seen.add(key);
			out.push(normalized);
		}
		if (out.length >= DELIVERABLE_LIMIT) {
			break;
		}
	}
	return out.length ? out : [body.replace(/\s+/g, ' ')];
}

/**
 * Sequencing the user stated. Only adjacent pairs are linked: "A then B then C" means A→B→C,
 * not a fully connected graph. `before` inverts the pair.
 */
function extractDependencies(body: string, deliverables: readonly string[]): ITaskDependency[] {
	if (deliverables.length < 2) {
		return [];
	}
	const dependencies: ITaskDependency[] = [];
	for (let i = 1; i < deliverables.length; i++) {
		const previous = deliverables[i - 1];
		const current = deliverables[i];
		const between = textBetween(body, previous, current);
		const marker = between.match(ORDER_MARKER)?.[1]?.toLowerCase();
		if (!marker) {
			continue;
		}
		if (marker === 'before') {
			dependencies.push({ from: i, to: i - 1, marker });
		} else {
			dependencies.push({ from: i - 1, to: i, marker });
		}
	}
	return dependencies;
}

function textBetween(body: string, first: string, second: string): string {
	const start = body.indexOf(first);
	const end = body.indexOf(second, start < 0 ? 0 : start + first.length);
	if (start < 0 || end < 0) {
		return '';
	}
	return body.slice(start + first.length, end);
}

// --- constraints -----------------------------------------------------------------------------

const CONSTRAINT_LIMIT = 10;
const CONSTRAINT_MAX_CHARS = 160;

function extractConstraints(body: string): ITaskConstraint[] {
	const found: ITaskConstraint[] = [];
	const seen = new Set<string>();
	const add = (kind: ConstraintKind, pattern: RegExp) => {
		for (const match of body.match(pattern) ?? []) {
			const text = match.trim().replace(/\s+/g, ' ').slice(0, CONSTRAINT_MAX_CHARS);
			const key = text.toLowerCase();
			if (text.split(/\s+/).length >= 2 && !seen.has(key)) {
				seen.add(key);
				found.push({ kind, text });
			}
		}
	};
	// Order matters: the first kind to claim a clause keeps it, and "only touch X" is a scope
	// statement even though it reads like a prohibition.
	add('scope', SCOPE);
	add('forbid', FORBID);
	add('require', REQUIRE);
	add('style', STYLE);
	return found.slice(0, CONSTRAINT_LIMIT);
}

// --- success criteria --------------------------------------------------------------------------

const CRITERION_LIMIT = 8;

/**
 * Explicit criteria come from the text. One implicit criterion is added when the lane will
 * change code, because "it still builds" is the floor no user bothers to write down.
 */
function extractSuccessCriteria(body: string, intent: IIntent, deliverables: readonly string[], shape: IRequestShape): ISuccessCriterion[] {
	const criteria: ISuccessCriterion[] = [];
	const seen = new Set<string>();

	for (const match of body.match(CRITERION) ?? []) {
		const text = match.trim().replace(/\s+/g, ' ').slice(0, CONSTRAINT_MAX_CHARS);
		const key = text.toLowerCase();
		if (text.split(/\s+/).length < 3 || seen.has(key)) {
			continue;
		}
		seen.add(key);
		criteria.push({ text, evidence: evidenceFor(text), explicit: true });
	}

	// A bare mention of the project's own checks is a criterion even outside a "so that" clause.
	for (const [pattern, evidence] of EVIDENCE_HINTS) {
		if (criteria.some(criterion => criterion.evidence === evidence) || !pattern.test(body)) {
			continue;
		}
		if (evidence === 'runtime' && !intent.wantsPreview) {
			continue;
		}
		criteria.push({ text: defaultCriterionText(evidence), evidence, explicit: true });
	}

	if (shape.lookup && !criteria.some(criterion => criterion.evidence === 'lookup')) {
		criteria.push({
			text: needsResearch(shape)
				? `Current facts are looked up and the answer is a ${shape.form === 'prose' ? 'full answer' : shape.form}.`
				: 'Current facts are looked up rather than guessed.',
			evidence: 'lookup',
			explicit: false,
		});
	}
	if ((shape.form === 'table' || shape.form === 'list') && !criteria.some(criterion => criterion.text.startsWith('The answer is a') || criterion.text.startsWith('Deliver a'))) {
		criteria.push({
			text: intent.lane === 'chat'
				? `The answer is a ${shape.form} covering what they asked for.`
				: `Deliver a ${shape.form} covering what they asked for.`,
			evidence: 'manual',
			explicit: true,
		});
	}
	if (shape.enumerate && !criteria.some(criterion => criterion.text.startsWith('Every requested item'))) {
		criteria.push({
			text: 'Every requested item is covered, not summarised away.',
			evidence: 'manual',
			explicit: true,
		});
	}

	if (intent.lane !== 'chat' && !criteria.some(criterion => criterion.evidence === 'diff')) {
		criteria.push({
			text: deliverables.length > 1
				? `Every requested change is applied and the project still builds cleanly.`
				: `${deliverables[0] ?? 'The change'} is applied and the project still builds cleanly.`,
			evidence: 'diff',
			explicit: false,
		});
	}

	return criteria.slice(0, CRITERION_LIMIT);
}

function evidenceFor(text: string): EvidenceKind {
	for (const [pattern, evidence] of EVIDENCE_HINTS) {
		if (pattern.test(text)) {
			return evidence;
		}
	}
	return 'manual';
}

function defaultCriterionText(evidence: EvidenceKind): string {
	switch (evidence) {
		case 'test': return 'The project\'s tests pass.';
		case 'typecheck': return 'The project type-checks.';
		case 'lint': return 'The project lints clean.';
		case 'build': return 'The project builds.';
		case 'browser': return 'The change is correct in the browser.';
		case 'runtime': return 'The project runs without errors.';
		case 'lookup': return 'Current facts are looked up rather than guessed.';
		default: return 'The change is applied.';
	}
}

// --- complexity ---------------------------------------------------------------------------------

/**
 * A continuous 0..1 estimate. The weights are tuned so that the common case - one imperative,
 * one named file, under 20 words - lands in `small`, and only genuinely multi-part work reaches
 * `large`. The lane contributes because the router already did the coarse classification and
 * disagreeing with it here would produce two competing opinions.
 */
function scoreComplexity(body: string, intent: IIntent, deliverables: readonly string[], constraints: readonly ITaskConstraint[], shape: IRequestShape): number {
	const words = body.split(/\s+/).filter(Boolean).length;
	const paths = (body.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? []).length;
	const bullets = (body.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;

	let score = 0;
	score += laneWeight(intent.lane);
	score += Math.min(0.20, (deliverables.length - 1) * 0.05);
	score += Math.min(0.12, words / 1200);
	score += Math.min(0.08, bullets * 0.02);
	score += Math.min(0.06, Math.max(0, paths - 1) * 0.02);
	score += Math.min(0.06, constraints.length * 0.015);
	if (shape.enumerate) {
		score += 0.12;
	}
	if (shape.form === 'table' || shape.form === 'list') {
		score += 0.08;
	}
	if (needsResearch(shape)) {
		score += 0.10;
	}
	if (/\b(?:migrate|rewrite|redesign|re-?architect|overhaul|from scratch|end[- ]to[- ]end|entire|whole|production[- ]ready)\b/i.test(body)) {
		score += 0.10;
	}
	if (/\b(?:race condition|deadlock|memory leak|performance|concurren|distributed|security|auth[oe]?|migration|schema|protocol)\b/i.test(body)) {
		score += 0.08;
	}
	return clamp01(round2(score));
}

function laneWeight(lane: IIntent['lane']): number {
	switch (lane) {
		case 'chat': return 0.05;
		case 'fast': return 0.15;
		case 'agent': return 0.40;
		case 'mission': return 0.65;
	}
}

function bucketComplexity(score: number): TaskComplexity {
	if (score < 0.12) { return 'trivial'; }
	if (score < 0.28) { return 'small'; }
	if (score < 0.52) { return 'moderate'; }
	if (score < 0.75) { return 'large'; }
	return 'epic';
}

// --- ambiguity ------------------------------------------------------------------------------------

const CLARIFY_THRESHOLD = 0.6;

/**
 * Tuned to almost never fire. Interrupting a run to ask a question the model could have answered
 * by reading one file is worse than guessing, so only a request with no target *and* no
 * measurable outcome - or one that contradicts itself - gets through.
 */
function scoreAmbiguity(body: string, intent: IIntent, context: ITaskIntelContext): IAmbiguity {
	const reasons: string[] = [];
	let score = 0;

	const hasTarget = intent.referencesWorkspace || !!context.attachments?.length;
	const dangling = DANGLING_REFERENT.test(body) && !context.hasPriorTurns && !hasTarget;
	if (dangling) {
		score += 0.45;
		reasons.push('refers to something ("it"/"this") that no earlier turn or attachment names');
	}

	const vagueOnly = VAGUE_QUALITY.test(body) && body.split(/\s+/).filter(Boolean).length <= 8;
	if (vagueOnly) {
		score += 0.35;
		reasons.push('asks for a quality ("better", "nicer") with no measurable outcome');
	}

	if (!hasTarget && intent.lane !== 'chat' && body.split(/\s+/).filter(Boolean).length <= 6) {
		score += 0.25;
		reasons.push('names no file, symbol, or area to change');
	}

	// A request that argues with itself is the one case worth interrupting on its own: no amount
	// of reading the codebase resolves it, and guessing wrong wastes the whole run.
	for (const [left, right, description] of CONTRADICTION) {
		if (left.test(body) && right.test(body)) {
			score += CLARIFY_THRESHOLD;
			reasons.push(description);
		}
	}

	// Chat never blocks on a question: the answer itself can ask for clarification inline.
	const final = intent.lane === 'chat' ? Math.min(score, CLARIFY_THRESHOLD - 0.01) : clamp01(score);
	return {
		score: round2(final),
		reasons,
		question: final >= CLARIFY_THRESHOLD ? buildQuestion(reasons) : undefined,
	};
}

export function shouldClarify(ambiguity: IAmbiguity): boolean {
	return ambiguity.score >= CLARIFY_THRESHOLD && !!ambiguity.question;
}

function buildQuestion(reasons: readonly string[]): string {
	if (reasons.some(reason => reason.startsWith('refers to'))) {
		return 'Which file or change did you mean? I do not have an earlier turn to resolve that reference against.';
	}
	if (reasons.some(reason => reason.includes('contradict') || reason.includes('at once') || reason.includes('forbids'))) {
		return 'Those two requirements conflict. Which one should win?';
	}
	if (reasons.some(reason => reason.startsWith('asks for a quality'))) {
		return 'What would "done" look like here - is there a specific behaviour, file, or look you want?';
	}
	return 'What should I change, and where?';
}

// --- prompt projection -------------------------------------------------------------------------------

/**
 * The slice of task intelligence worth spending tokens on. Constraints and stated criteria are
 * the only parts the model cannot re-derive from the user's message, because they are the parts
 * it reliably skims past.
 */
export function formatTaskBrief(intel: ITaskIntel): string | undefined {
	const lines: string[] = [];
	const shapeLine = formatShapeBrief(intel.shape);
	if (shapeLine) {
		lines.push('How to answer:');
		lines.push(`- ${shapeLine}`);
	}
	if (intel.constraints.length) {
		if (lines.length) {
			lines.push('');
		}
		lines.push('Constraints the user set:');
		lines.push(...intel.constraints.map(constraint => `- ${constraint.text}`));
	}
	const explicit = intel.successCriteria.filter(criterion => criterion.explicit);
	if (explicit.length) {
		if (lines.length) {
			lines.push('');
		}
		lines.push('Done means:');
		lines.push(...explicit.map(criterion => `- ${criterion.text}`));
	}
	return lines.length ? lines.join('\n').trim() : undefined;
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
