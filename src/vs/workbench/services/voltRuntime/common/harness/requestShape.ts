/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the user is asking for, independent of lane or mode. A coding turn can still demand
 * official docs, a full table, or every item - and a question can still be a one-liner.
 *
 * Deterministic and model-free so it can run on every send().
 */

export type OutputForm = 'prose' | 'table' | 'list' | 'steps' | 'code';

export type AnswerDepth = 'brief' | 'full';

export interface IRequestShape {
	readonly form: OutputForm;
	/** They asked for the set, not a sample ("each", "every", "all", "full list"). */
	readonly enumerate: boolean;
	/** The answer depends on facts that live outside the workspace or go stale. */
	readonly lookup: boolean;
	/** They asked to cite, link, or follow official/primary sources. */
	readonly cite: boolean;
	readonly depth: AnswerDepth;
}

export interface IRequestShapeHints {
	readonly referencesWorkspace?: boolean;
	readonly coding?: boolean;
}

export interface IShapeFramingOptions {
	/** When true, the run may edit. Research framing must not forbid writes. */
	readonly allowWrites?: boolean;
}

const TABLE = /\b(?:in a table|as a table|in table form|a table of|the table of|give (?:me |it |them )?(?:in|as)(?: a)? table|markdown table|tabular(?:ly)?|spreadsheet|\bcsv\b)\b/i;

const LIST = /\b(?:as a list|in a list|give (?:me )?(?:a |the )?list|list (?:them|it|out|every|all|each)|bullet(?:ed)?(?: list)?|itemize|itemise)\b/i;

const STEPS = /\b(?:step[- ]by[- ]step|walk me through|walkthrough)\b/i;

const CODE = /\b(?:code block|snippet|paste the (?:code|diff))\b/i;

const ENUMERATE = /\b(?:each|every(?: single)?|all (?:of )?(?:the )?\w+|complete list|full (?:list|lineup|range|catalog|breakdown)|one by one)\b/i;

const DEPTH = /\b(?:detailed|breakdown|trim[- ]level|full(?:y)?|complete|comprehensive|side[- ]by[- ]side|compare|versus|\bvs\.?\b)\b/i;

/** Facts that are wrong if guessed from training data. Not product- or country-specific. */
const LOOKUP = /\b(?:price|prices|pricing|cost|costs|how much|latest|news|today|current|currently|official|release date|released|version of|docs? for|documentation|search (the )?web|look ?up|google|weather|stock|exchange rate|population|capital of|who (?:is|was)|when (?:did|was|is)|specs?|specifications|review(?:s)? of|api reference|changelog|from the docs)\b/i;

const CITE = /\b(?:cite|citation|sources?|references?|with links|official (?:docs?|documentation|api|spec|site)|from the (?:docs|documentation|spec|rfc))\b/i;

const URL_RE = /https?:\/\/\S+/i;

export function detectRequestShape(text: string, hints: IRequestShapeHints = {}): IRequestShape {
	const raw = text.trim();
	const form: OutputForm = TABLE.test(raw)
		? 'table'
		: LIST.test(raw)
			? 'list'
			: STEPS.test(raw)
				? 'steps'
				: CODE.test(raw)
					? 'code'
					: 'prose';
	const enumerate = ENUMERATE.test(raw);
	const cite = CITE.test(raw);
	const worldFact = !hints.referencesWorkspace && !hints.coding;
	const lookup = URL_RE.test(raw) || LOOKUP.test(raw) || cite || (enumerate && worldFact);
	const depth: AnswerDepth = enumerate || form === 'table' || form === 'list' || DEPTH.test(raw)
		? 'full'
		: 'brief';
	return { form, enumerate, lookup, cite, depth };
}

/** Search + fetch + a structured or sourced answer, not a one-line guess. */
export function needsResearch(shape: IRequestShape): boolean {
	return shape.lookup && (shape.depth === 'full' || shape.enumerate || shape.form !== 'prose' || shape.cite);
}

export function formatShapeBrief(shape: IRequestShape): string | undefined {
	const parts: string[] = [];
	if (shape.form !== 'prose') {
		parts.push(`Answer as a ${shape.form}.`);
	}
	if (shape.enumerate) {
		parts.push('Cover every item they asked for - do not collapse it to a one-line summary.');
	}
	if (shape.lookup) {
		parts.push('Look up current figures; do not guess.');
	}
	if (shape.cite) {
		parts.push('Cite the primary sources you used.');
	}
	return parts.length ? parts.join(' ') : undefined;
}

export function matchesRequestedForm(text: string, form: OutputForm): boolean {
	if (form === 'table') {
		const rows = text.split('\n').filter(line => line.includes('|') && line.replace(/\|/g, '').trim());
		return rows.length >= 3;
	}
	if (form === 'list') {
		const items = text.split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
		return items.length >= 3;
	}
	return true;
}

export function isThinAnswer(text: string, shape: IRequestShape): boolean {
	if (shape.depth !== 'full' && !shape.enumerate && shape.form === 'prose') {
		return false;
	}
	return text.split(/\s+/).filter(Boolean).length < 80;
}

/**
 * Extra framing from the request shape. Coding lanes keep their own lane framing and
 * append this; chat may use it as the lane framing. Never forbids writes unless
 * `allowWrites` is false.
 */
export function framingForShape(shape: IRequestShape | undefined, wantsWeb: boolean, options: IShapeFramingOptions = {}): string | undefined {
	const writes = !!options.allowWrites;
	if (shape && needsResearch(shape)) {
		return writes
			? 'This depends on current or external facts. Search and fetch primary sources first, then do the work. Match the form and completeness they asked for. Cover the full set - do not collapse it to a sentence.'
			: 'This is a research question. Search, fetch primary sources, then answer in the form they asked for. Cover the full set - do not collapse it to a sentence. Date or qualify figures that change. Do not modify the workspace and do not run commands.';
	}
	if (wantsWeb || shape?.lookup) {
		return writes
			? 'If this depends on current or external facts, look them up before you edit or answer. Do not guess versions, APIs, or figures.'
			: 'This is a question. Look up current facts rather than guessing. Answer in the form they asked for. Do not modify the workspace and do not run commands.';
	}
	if (shape && (shape.form !== 'prose' || shape.enumerate)) {
		const form = shape.form === 'prose' ? 'complete answer' : shape.form;
		return writes
			? `Deliver what they asked for as a ${form}. Cover every item - do not summarise it away.`
			: `Answer as a ${form}. Cover every item they asked for.`;
	}
	return undefined;
}
