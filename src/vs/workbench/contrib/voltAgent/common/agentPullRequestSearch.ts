/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Pull Requests list's search: pure, and cheap enough to run over every pull request on every
 * keystroke. Each word must match somewhere; how well it matches ranks the list. A word is tried on
 * the number, title, branch, author, labels, status ("failing", "draft", "ready to merge", "mine")
 * and base branch, from best to worst: the whole field, its start, a word start, anywhere inside,
 * fuzzily ("esc" finds "edit-scroll-chips"), then with two letters swapped ("scorll").
 *
 * `author:` (or `@`), `label:`, `branch:`, `base:`, `title:` and `is:` keep a word to one field,
 * `#12` to the number, "quoted words" must appear as typed, and a leading `-` leaves matches out.
 * A regular expression (`/pattern/flags`, or the search's regex toggle) is tested on the same fields;
 * without flags it ignores case unless the pattern has a capital letter.
 */

import { createMatches, fuzzyScore, fuzzyScoreGracefulAggressive, IMatch } from '../../../../base/common/filters.js';
import { IVoltPullRequest } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { blockedReason, prInvolvement } from './agentPullRequests.js';

type PrSearchField = 'number' | 'title' | 'branch' | 'author' | 'labels' | 'status' | 'base';

/** Fields a list row shows, so their hits are highlighted. */
type ShownField = 'number' | 'title' | 'author' | 'branch';

const ALL_FIELDS: readonly PrSearchField[] = ['number', 'title', 'branch', 'author', 'labels', 'status', 'base'];

/** A hit on the number beats one in the title, which beats the branch, and so on down. */
const FIELD_WEIGHT: Record<PrSearchField, number> = { number: 1.6, title: 1, branch: 0.8, author: 0.8, labels: 0.7, status: 0.6, base: 0.4 };

const QUALIFIERS: Record<string, readonly PrSearchField[]> = {
	author: ['author'],
	by: ['author'],
	label: ['labels'],
	branch: ['branch'],
	head: ['branch'],
	base: ['base'],
	title: ['title'],
	is: ['status'],
	status: ['status'],
};

const MAX_TERMS = 8;
/** Highlights per field: a pattern like /e/ should not split a title into fifty spans. */
const MAX_HIGHLIGHTS = 24;
const TERM_PATTERN = /-?(?:[a-z]+:)?"[^"]*"?|\S+/gi;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export interface IPrSearchHit {
	readonly score: number;
	/** Ranges to highlight in what a row shows: `#12`, the title, the author's login, the branch. */
	readonly number: readonly IMatch[];
	readonly title: readonly IMatch[];
	readonly author: readonly IMatch[];
	readonly branch: readonly IMatch[];
}

export interface IPrSearch {
	/** Nothing to search for: every pull request, in the list's own order. */
	readonly empty: boolean;
	readonly regex: boolean;
	/** The regular expression does not compile: why. Nothing matches until it does. */
	readonly error?: string;
	match(pr: IVoltPullRequest): IPrSearchHit | undefined;
}

interface ITerm {
	readonly text: string;
	readonly low: string;
	readonly fields: readonly PrSearchField[];
	readonly negate: boolean;
	/** Quoted: the words as typed, no fuzzy matching. */
	readonly exact: boolean;
}

type FieldTexts = Record<PrSearchField, readonly string[]>;

interface IScored {
	readonly score: number;
	readonly matches: IMatch[];
}

const NO_HIT: IPrSearchHit = { score: 0, number: [], title: [], author: [], branch: [] };

/**
 * Compiles what was typed into the search box. `regex` is the box's toggle; a query starting with
 * `/` is a regular expression either way, so `/fix(` already filters while the closing `/` is missing.
 */
export function compilePrSearch(query: string, regex = false): IPrSearch {
	const trimmed = query.trim();
	if (trimmed.startsWith('/') || (regex && trimmed)) {
		return regexSearch(trimmed);
	}
	const terms = parseTerms(trimmed);
	if (!terms.length) {
		return { empty: true, regex: false, match: () => NO_HIT };
	}
	return { empty: false, regex: false, match: pr => matchTerms(terms, fieldTexts(pr)) };
}

/** The items whose pull request matches, best first; equal scores keep the list's own order. */
export function rankBySearch<T>(items: readonly T[], search: IPrSearch, pr: (item: T) => IVoltPullRequest): { readonly item: T; readonly hit: IPrSearchHit }[] {
	const hits: { readonly item: T; readonly hit: IPrSearchHit; readonly index: number }[] = [];
	for (let index = 0; index < items.length; index++) {
		const hit = search.match(pr(items[index]));
		if (hit) {
			hits.push({ item: items[index], hit, index });
		}
	}
	if (!search.empty) {
		hits.sort((a, b) => b.hit.score - a.hit.score || a.index - b.index);
	}
	return hits;
}

//#region Words

function parseTerms(query: string): ITerm[] {
	const terms: ITerm[] = [];
	for (const [raw] of query.matchAll(TERM_PATTERN)) {
		let word = raw;
		let negate = false;
		if (word.length > 1 && word[0] === '-') {
			negate = true;
			word = word.slice(1);
		}
		let fields = ALL_FIELDS;
		const colon = word.indexOf(':');
		const qualifier = colon > 0 ? QUALIFIERS[word.slice(0, colon).toLowerCase()] : undefined;
		if (qualifier) {
			fields = qualifier;
			word = word.slice(colon + 1);
		} else if (word[0] === '@') {
			fields = ['author'];
			word = word.slice(1);
		} else if (/^#\d+$/.test(word)) {
			fields = ['number'];
		}
		let exact = false;
		if (word[0] === '"') {
			exact = true;
			word = word.slice(1, word.length > 1 && word.endsWith('"') ? -1 : undefined);
		}
		// Half typed ("author:", "@", "-", a lone quote): wait for the rest instead of emptying the list.
		if (!word || word === '#' || word === '-') {
			continue;
		}
		terms.push({ text: word, low: word.toLowerCase(), fields, negate, exact });
		if (terms.length === MAX_TERMS) {
			break;
		}
	}
	return terms;
}

function fieldTexts(pr: IVoltPullRequest): FieldTexts {
	return {
		number: [`#${pr.number}`],
		title: [pr.title],
		branch: [pr.headRefName],
		author: [pr.author.login],
		labels: pr.labels.map(label => label.name),
		status: [statusText(pr)],
		base: [pr.baseRefName],
	};
}

/** What the row's status says, plus the words people search a state by. */
function statusText(pr: IVoltPullRequest): string {
	const words: string[] = [pr.state];
	const reason = blockedReason(pr);
	if (reason) {
		words.push(reason);
	}
	if (pr.reviewDecision === 'approved') {
		words.push('approved');
	}
	if (pr.mergeable === 'conflicting') {
		words.push('conflict');
	}
	const involvement = prInvolvement(pr);
	if (involvement === 'authored') {
		words.push('mine');
	} else if (involvement === 'reviewRequested') {
		words.push('review requested');
	}
	return words.join(' · ');
}

function isShown(field: PrSearchField): field is ShownField {
	return field === 'number' || field === 'title' || field === 'author' || field === 'branch';
}

function matchTerms(terms: readonly ITerm[], texts: FieldTexts): IPrSearchHit | undefined {
	const highlights: Record<ShownField, IMatch[]> = { number: [], title: [], author: [], branch: [] };
	let score = 0;
	for (const term of terms) {
		if (term.negate) {
			if (term.fields.some(field => texts[field].some(text => containsTerm(term, field, text)))) {
				return undefined;
			}
			continue;
		}
		let best = 0;
		for (const field of term.fields) {
			for (const text of texts[field]) {
				const scored = scoreTerm(term, field, text);
				if (!scored) {
					continue;
				}
				const weighted = scored.score * FIELD_WEIGHT[field];
				// Highlight every shown field the word sits in, but not a stray fuzzy hit beside a better one.
				if (isShown(field) && (weighted >= best || scored.score >= 40)) {
					highlights[field].push(...scored.matches);
				}
				best = Math.max(best, weighted);
			}
		}
		if (!best) {
			return undefined;
		}
		score += best;
	}
	return {
		score,
		number: normalizeMatches(highlights.number),
		title: normalizeMatches(highlights.title),
		author: normalizeMatches(highlights.author),
		branch: normalizeMatches(highlights.branch),
	};
}

function containsTerm(term: ITerm, field: PrSearchField, text: string): boolean {
	if (field === 'number') {
		return !!scoreNumber(term, text);
	}
	return text.toLowerCase().includes(term.low);
}

function scoreTerm(term: ITerm, field: PrSearchField, text: string): IScored | undefined {
	if (field === 'number') {
		return scoreNumber(term, text);
	}
	const low = text.toLowerCase();
	const length = term.low.length;
	if (low === term.low) {
		return { score: 100, matches: [{ start: 0, end: length }] };
	}
	const first = low.indexOf(term.low);
	if (first === 0) {
		return { score: 80, matches: [{ start: 0, end: length }] };
	}
	if (first > 0) {
		// A hit at a word's start ("scroll" in "fix: scroll") reads better than the first one inside a word.
		for (let at = first; at >= 0; at = low.indexOf(term.low, at + 1)) {
			if (isWordStart(text, at)) {
				return { score: 60, matches: [{ start: at, end: at + length }] };
			}
		}
		return { score: 40, matches: [{ start: first, end: first + length }] };
	}
	if (term.exact || field === 'status') {
		return undefined;
	}
	const fuzzy = fuzzyScore(term.text, term.low, 0, text, low, 0);
	if (fuzzy) {
		return { score: 20 + clamp(fuzzy[0], 0, 19), matches: createMatches(fuzzy) };
	}
	if (length >= 4) {
		const swapped = fuzzyScoreGracefulAggressive(term.text, term.low, 0, text, low, 0);
		if (swapped) {
			return { score: 8 + clamp(swapped[0], 0, 18) / 2, matches: createMatches(swapped) };
		}
	}
	return undefined;
}

/** `12` or `#12`: the number itself first, then numbers starting with it (`#3` finds #30 and #31). */
function scoreNumber(term: ITerm, text: string): IScored | undefined {
	const typed = /^#?(\d+)$/.exec(term.text);
	if (!typed) {
		return undefined;
	}
	const digits = typed[1];
	const start = term.text[0] === '#' ? 0 : 1;
	const end = 1 + digits.length;
	if (text.slice(1) === digits) {
		return { score: 100, matches: [{ start, end }] };
	}
	if (text.startsWith(digits, 1)) {
		return { score: 70, matches: [{ start, end }] };
	}
	return undefined;
}

function isWordStart(text: string, at: number): boolean {
	if (at === 0) {
		return true;
	}
	const before = text[at - 1];
	if (!WORD_CHAR.test(before)) {
		return true;
	}
	// camelCase: "Scroll" in "editScroll".
	const char = text[at];
	return before === before.toLowerCase() && char !== char.toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

//#endregion

//#region Regular expressions

/** `query` is the toggle's whole query, or `/pattern/flags` with the closing part optional. */
function regexSearch(query: string): IPrSearch {
	let source = query;
	let flags: string | undefined;
	if (query.startsWith('/')) {
		const literal = /^\/(.*?)(?:\/([a-z]*))?$/s.exec(query);
		source = literal?.[1] ?? '';
		flags = literal?.[2];
		if (!source) {
			return { empty: true, regex: true, match: () => NO_HIT };
		}
	}
	// Smart case (an escape such as \S is not a capital); sticky would stop at the first miss; global is for the highlights.
	const given = (flags ?? (/\p{Lu}/u.test(source.replace(/\\./g, '')) ? '' : 'i')).replace(/[gy]/g, '');
	let pattern: RegExp;
	try {
		pattern = new RegExp(source, `${given}g`);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { empty: false, regex: true, error, match: () => undefined };
	}
	return { empty: false, regex: true, match: pr => matchPattern(pattern, fieldTexts(pr)) };
}

function matchPattern(pattern: RegExp, texts: FieldTexts): IPrSearchHit | undefined {
	const highlights: Record<ShownField, IMatch[]> = { number: [], title: [], author: [], branch: [] };
	let score = 0;
	for (const field of ALL_FIELDS) {
		let found = false;
		for (const text of texts[field]) {
			let count = 0;
			for (const match of text.matchAll(pattern)) {
				found = true;
				if (isShown(field) && match[0].length && count < MAX_HIGHLIGHTS) {
					highlights[field].push({ start: match.index, end: match.index + match[0].length });
				}
				if (++count >= MAX_HIGHLIGHTS) {
					break;
				}
			}
		}
		if (found) {
			score += 50 * FIELD_WEIGHT[field];
		}
	}
	if (!score) {
		return undefined;
	}
	return {
		score,
		number: normalizeMatches(highlights.number),
		title: normalizeMatches(highlights.title),
		author: normalizeMatches(highlights.author),
		branch: normalizeMatches(highlights.branch),
	};
}

//#endregion

/** Sorted, with overlapping and touching ranges merged: several words may light the same letters. */
export function normalizeMatches(matches: readonly IMatch[]): IMatch[] {
	if (matches.length < 2) {
		return [...matches];
	}
	const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: IMatch[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const last = merged[merged.length - 1];
		const next = sorted[i];
		if (next.start <= last.end) {
			last.end = Math.max(last.end, next.end);
		} else {
			merged.push({ ...next });
		}
	}
	return merged;
}
