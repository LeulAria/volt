/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search over every chat, in two passes. Titles first: a fuzzy match over the history index,
 * synchronous and cheap enough for every keystroke. Then what was said: each chat's prompts and
 * replies cut into stemmed terms and scored with BM25, so a word used in every chat says little and
 * one used in two says a lot. Prompts weigh more than replies (they say what the chat was for),
 * half-typed words and typos widen to the words the chats actually use, and the turn where the
 * query's words meet is the one the hit points at. Pure: text in, ranked hits out.
 *
 * The index keeps no text: each chat is a sorted array of term ids with their weights and the turns
 * they occur in, a few kilobytes per chat. Snippets come from the opening words of each prompt, or
 * from turn texts the caller passes in (see {@link IChatSearchOptions.texts}).
 */

import { createMatches, fuzzyScore, IMatch } from '../../../../base/common/filters.js';

//#region Terms

const STOP_WORDS = new Set([
	'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
	'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'his',
	'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or',
	'our', 'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
	'those', 'to', 'too', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
	'will', 'with', 'would', 'you', 'your',
]);

/** Longer runs are hashes, base64 or minified code: nothing anyone types. */
const MAX_TERM_LENGTH = 40;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const CAMEL_BOUNDARY = /[a-z][A-Z]|[A-Za-z][0-9]|[0-9][A-Za-z]/;
const CAMEL_PART = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;
const VOWEL = /[aeiouy]/;
/** Three digits among letters in a long run: a commit, a uuid, a token. */
const HASH_LIKE = /(?:\d\D*){3}/;

/**
 * A light English stemmer: plurals, -ing, -ed and a final e fold together, so "fixing the sidebar"
 * finds "fixed sidebars". Only lowercase ASCII words change; both sides of a match go through it.
 */
export function stemTerm(word: string): string {
	if (word.length <= 3 || !/^[a-z]+$/.test(word)) {
		return word;
	}
	let w = word;
	if (w.endsWith('ies') && w.length > 4) {
		return `${w.slice(0, -3)}y`;
	}
	if (/(?:ss|x|ch|sh|z)es$/.test(w)) {
		w = w.slice(0, -2);
	} else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) {
		w = w.slice(0, -1);
	}
	if (w.endsWith('ing') && w.length > 5 && VOWEL.test(w.slice(0, -3))) {
		w = undouble(w.slice(0, -3));
	} else if (w.endsWith('ed') && w.length > 4 && VOWEL.test(w.slice(0, -2))) {
		w = undouble(w.slice(0, -2));
	}
	if (w.endsWith('e') && w.length > 4) {
		w = w.slice(0, -1);
	}
	return w;
}

function undouble(word: string): string {
	const last = word.length - 1;
	return last > 1 && word[last] === word[last - 1] && !'lsz'.includes(word[last]) ? word.slice(0, -1) : word;
}

/**
 * Calls `fn` with each searchable term of `text` and the word it came from. With `parts`, a camelCase
 * or snake_case identifier also gives its parts, so "agentHomePane" is found by "home pane".
 */
export function forEachTerm(text: string, parts: boolean, fn: (term: string, start: number, end: number) => void): void {
	const pattern = new RegExp(WORD_PATTERN);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text))) {
		const word = match[0];
		for (const term of wordTerms(word, parts)) {
			fn(term, match.index, match.index + word.length);
		}
	}
}

/** The terms one word gives: none for stop words and hash-like runs, its stem, and its camelCase parts. */
function wordTerms(word: string, parts: boolean): string[] {
	if (word.length > MAX_TERM_LENGTH || (word.length >= 12 && HASH_LIKE.test(word))) {
		return [];
	}
	const terms: string[] = [];
	const low = word.toLowerCase();
	if (low.length > 1 && !STOP_WORDS.has(low)) {
		terms.push(stemTerm(low));
	}
	if (parts && word.length > 3 && CAMEL_BOUNDARY.test(word)) {
		for (const part of word.matchAll(CAMEL_PART)) {
			const partLow = part[0].toLowerCase();
			if (partLow !== low && partLow.length > 1 && !STOP_WORDS.has(partLow)) {
				const term = stemTerm(partLow);
				if (!terms.includes(term)) {
					terms.push(term);
				}
			}
		}
	}
	return terms;
}

/** One line of text: whitespace runs collapsed, so snippet offsets are offsets into what is shown. */
export function normalizeSearchText(text: string, max: number): string {
	return (text.length > max * 2 ? text.slice(0, max * 2) : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function mergeMatches(matches: IMatch[]): IMatch[] {
	const sorted = matches.filter(match => match.end > match.start).sort((a, b) => a.start - b.start);
	const merged: IMatch[] = [];
	for (const match of sorted) {
		const last = merged.at(-1);
		if (last && match.start <= last.end) {
			last.end = Math.max(last.end, match.end);
		} else {
			merged.push({ start: match.start, end: match.end });
		}
	}
	return merged;
}

/** Levenshtein distance between `a` and `b` when it is at most `max`, else `max + 1`. */
function boundedDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) {
		return max + 1;
	}
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			current.push(value);
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin > max) {
			return max + 1;
		}
		previous = current;
	}
	return previous[b.length];
}

//#endregion

//#region Titles

export interface IChatTitleCandidate {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: number;
	/** Project, branch: a query word that misses the title may hit these, as long as another hits the title. */
	readonly context?: string;
}

export interface IChatTitleHit {
	readonly id: string;
	readonly score: number;
	readonly highlights: readonly IMatch[];
}

/**
 * Chats whose title fuzzy-matches every word of `query` ("sbs" finds "Sidebar search"), best first,
 * then most recent. A word may also sit inside a title word, or in the chat's project or branch.
 */
export function searchChatTitles(candidates: readonly IChatTitleCandidate[], query: string, limit: number): IChatTitleHit[] {
	const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
	if (!words.length) {
		return [];
	}
	const lowWords = words.map(word => word.toLowerCase());
	const hits: (IChatTitleHit & { readonly updatedAt: number })[] = [];
	for (const candidate of candidates) {
		const title = candidate.title;
		const titleLow = title.toLowerCase();
		const contextLow = candidate.context?.toLowerCase();
		const matches: IMatch[] = [];
		let score = 0;
		let inTitle = 0;
		let matched = true;
		for (const [i, word] of words.entries()) {
			const low = lowWords[i];
			const fuzzy = fuzzyScore(word, low, 0, title, titleLow, 0);
			if (fuzzy) {
				score += Math.max(fuzzy[0], 1);
				inTitle++;
				matches.push(...createMatches(fuzzy));
				continue;
			}
			const at = titleLow.indexOf(low);
			if (at >= 0) {
				score += 1;
				inTitle++;
				matches.push({ start: at, end: at + low.length });
				continue;
			}
			if (contextLow?.includes(low)) {
				score += 0.5;
				continue;
			}
			matched = false;
			break;
		}
		if (matched && inTitle) {
			hits.push({ id: candidate.id, score, highlights: mergeMatches(matches), updatedAt: candidate.updatedAt });
		}
	}
	hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
	return hits.slice(0, limit).map(({ id, score, highlights }) => ({ id, score, highlights }));
}

//#endregion

//#region Conversations

export interface IChatSearchTurnText {
	readonly id: string;
	readonly user: string;
	readonly agent: string;
}

export interface IChatSearchSource {
	readonly id: string;
	/** The history index's `updatedAt` when the text was read: a chat that moved on is read again. */
	readonly updatedAt: number;
	readonly turns: readonly IChatSearchTurnText[];
}

export interface IChatSnippet {
	readonly role: 'user' | 'agent';
	readonly text: string;
	readonly highlights: readonly IMatch[];
	/** What to look for in the chat to land on the hit: the phrase, else the first word found. */
	readonly find: string;
}

export interface IChatContentHit {
	readonly id: string;
	readonly score: number;
	/** The turn where the query's words meet. */
	readonly turnId: string;
	/** Absent when the hit is in a reply and the chat's text was not passed in. */
	readonly snippet?: IChatSnippet;
}

export interface IChatSearchOptions {
	readonly limit: number;
	readonly now: number;
	/** Normalized turn texts of chats the caller has loaded, for snippets beyond the opening words of a prompt. */
	readonly texts?: (id: string) => readonly IChatSearchTurnText[] | undefined;
}

interface IChatSearchDoc {
	readonly id: string;
	readonly updatedAt: number;
	readonly turnIds: readonly string[];
	/** Each prompt's opening words, a snippet before the chat's text is loaded. */
	readonly heads: readonly string[];
	/** Ascending. */
	readonly termIds: Uint32Array;
	readonly tf: Float32Array;
	/** Turns of term `k` are `turnList[turnStart[k]..turnStart[k + 1]]`. */
	readonly turnStart: Uint32Array;
	readonly turnList: Uint16Array;
	readonly length: number;
}

interface IExpansion {
	readonly id: number;
	readonly term: string;
	/** Exact 1, prefix and typo less, times the term's idf. */
	readonly weight: number;
}

interface IQueryTerm {
	readonly raw: string;
	readonly expansions: readonly IExpansion[];
}

const USER_WEIGHT = 2;
const AGENT_WEIGHT = 1;
/** Text past this in one prompt or reply is not indexed: pasted logs and generated files. */
const INDEX_CHARS = 60_000;
const HEAD_CHARS = 220;
const PREFIX_WEIGHT = 0.6;
const TYPO_WEIGHT = 0.45;
const PREFIX_EXPANSIONS = 24;
const TYPO_EXPANSIONS = 10;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SAME_TURN_BONUS = 1.35;
const RECENCY_BONUS = 0.35;
const RECENCY_MS = 21 * 24 * 60 * 60 * 1000;
const SNIPPET_CHARS = 160;
const SNIPPET_LEAD = 36;
/** Spellings whose term ids are remembered; past this the memo starts over. */
const WORD_CACHE = 200_000;

function findTerm(termIds: Uint32Array, id: number): number {
	let lo = 0;
	let hi = termIds.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const value = termIds[mid];
		if (value === id) {
			return mid;
		}
		if (value < id) {
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return -1;
}

export class ChatSearchIndex {

	private readonly docs = new Map<string, IChatSearchDoc>();
	private readonly termIds = new Map<string, number>();
	private readonly terms: string[] = [];
	private readonly df: number[] = [];
	/** Term ids by their first two letters: a half-typed word or a typo scans one bucket, not the vocabulary. */
	private readonly buckets = new Map<string, number[]>();
	/** Term ids of each word as written: most words repeat, and the stemmer runs once per spelling. */
	private readonly wordIds = new Map<string, readonly number[]>();
	private totalLength = 0;

	get size(): number {
		return this.docs.size;
	}

	ids(): string[] {
		return [...this.docs.keys()];
	}

	/** True when the chat is indexed as of `updatedAt`. */
	has(id: string, updatedAt: number): boolean {
		return this.docs.get(id)?.updatedAt === updatedAt;
	}

	set(source: IChatSearchSource): void {
		this.delete(source.id);
		const postings = new Map<number, { tf: number; turns: number[] }>();
		let length = 0;
		const turnIds: string[] = [];
		const heads: string[] = [];
		for (const [index, turn] of source.turns.entries()) {
			const turnIndex = Math.min(index, 0xffff);
			turnIds.push(turn.id);
			heads.push(normalizeSearchText(turn.user, HEAD_CHARS));
			for (const [text, weight] of [[turn.user, USER_WEIGHT], [turn.agent, AGENT_WEIGHT]] as const) {
				const pattern = new RegExp(WORD_PATTERN);
				const indexed = text.length > INDEX_CHARS ? text.slice(0, INDEX_CHARS) : text;
				let match: RegExpExecArray | null;
				while ((match = pattern.exec(indexed))) {
					for (const id of this.idsOfWord(match[0])) {
						let posting = postings.get(id);
						if (!posting) {
							posting = { tf: 0, turns: [] };
							postings.set(id, posting);
						}
						posting.tf += weight;
						length += weight;
						if (posting.turns.at(-1) !== turnIndex) {
							posting.turns.push(turnIndex);
						}
					}
				}
			}
		}
		const ids = [...postings.keys()].sort((a, b) => a - b);
		const termIds = new Uint32Array(ids.length);
		const tf = new Float32Array(ids.length);
		const turnStart = new Uint32Array(ids.length + 1);
		let turnCount = 0;
		for (const id of ids) {
			turnCount += postings.get(id)!.turns.length;
		}
		const turnList = new Uint16Array(turnCount);
		let at = 0;
		for (const [k, id] of ids.entries()) {
			const posting = postings.get(id)!;
			termIds[k] = id;
			tf[k] = posting.tf;
			turnStart[k] = at;
			turnList.set(posting.turns, at);
			at += posting.turns.length;
			this.df[id]++;
		}
		turnStart[ids.length] = at;
		this.docs.set(source.id, { id: source.id, updatedAt: source.updatedAt, turnIds, heads, termIds, tf, turnStart, turnList, length });
		this.totalLength += length;
	}

	private idsOfWord(word: string): readonly number[] {
		let ids = this.wordIds.get(word);
		if (!ids) {
			if (this.wordIds.size >= WORD_CACHE) {
				this.wordIds.clear();
			}
			ids = wordTerms(word, true).map(term => this.termId(term));
			this.wordIds.set(word, ids);
		}
		return ids;
	}

	private termId(term: string): number {
		let id = this.termIds.get(term);
		if (id === undefined) {
			id = this.terms.length;
			this.termIds.set(term, id);
			this.terms.push(term);
			this.df.push(0);
			const key = term.slice(0, 2);
			const bucket = this.buckets.get(key);
			if (bucket) {
				bucket.push(id);
			} else {
				this.buckets.set(key, [id]);
			}
		}
		return id;
	}

	delete(id: string): void {
		const doc = this.docs.get(id);
		if (!doc) {
			return;
		}
		for (const termId of doc.termIds) {
			this.df[termId]--;
		}
		this.totalLength -= doc.length;
		this.docs.delete(id);
	}

	/** Chats whose prompts and replies best match `query`, with the turn and words that matched. */
	search(query: string, options: IChatSearchOptions): IChatContentHit[] {
		const count = this.docs.size;
		if (!count) {
			return [];
		}
		const terms = this.parse(query, count);
		if (!terms.some(term => term.expansions.length)) {
			return [];
		}
		const average = this.totalLength / count || 1;
		const scored: { doc: IChatSearchDoc; score: number }[] = [];
		for (const doc of this.docs.values()) {
			const norm = BM25_K1 * (1 - BM25_B + BM25_B * doc.length / average);
			let score = 0;
			let matched = 0;
			for (const term of terms) {
				let best = 0;
				for (const expansion of term.expansions) {
					const k = findTerm(doc.termIds, expansion.id);
					if (k < 0) {
						continue;
					}
					const tf = doc.tf[k];
					best = Math.max(best, expansion.weight * tf * (BM25_K1 + 1) / (tf + norm));
				}
				if (best > 0) {
					score += best;
					matched++;
				}
			}
			if (!matched) {
				continue;
			}
			// A two-word query needs one word, three need two: a stray hit on one word is noise.
			const coverage = matched / terms.length;
			if (terms.length > 1 && coverage < 0.5) {
				continue;
			}
			scored.push({ doc, score: score * coverage * coverage });
		}
		scored.sort((a, b) => b.score - a.score);

		const phrase = terms.length > 1 ? query.trim().replace(/\s+/g, ' ').toLowerCase() : '';
		const hitTerms = new Set(terms.flatMap(term => term.expansions.map(expansion => expansion.term)));
		const refined: IChatContentHit[] = [];
		for (const { doc, score } of scored.slice(0, options.limit * 3)) {
			const turn = this.bestTurn(doc, terms);
			let final = score;
			if (terms.length > 1 && turn.terms === terms.length) {
				final *= SAME_TURN_BONUS;
			}
			final *= 1 + RECENCY_BONUS * Math.exp(-Math.max(0, options.now - doc.updatedAt) / RECENCY_MS);
			const texts = options.texts?.(doc.id);
			const text = texts?.[turn.index]?.id === doc.turnIds[turn.index] ? texts[turn.index] : undefined;
			const fields = text
				? [{ role: 'user' as const, text: text.user }, { role: 'agent' as const, text: text.agent }]
				: [{ role: 'user' as const, text: doc.heads[turn.index] ?? '' }];
			const snippet = buildSnippet(fields, hitTerms, phrase) ?? (text ? { role: 'user' as const, text: text.user.slice(0, SNIPPET_CHARS), highlights: [], find: '' } : undefined);
			refined.push({ id: doc.id, score: final, turnId: doc.turnIds[turn.index], ...(snippet ? { snippet } : {}) });
		}
		refined.sort((a, b) => b.score - a.score);
		return refined.slice(0, options.limit);
	}

	private parse(query: string, count: number): IQueryTerm[] {
		const raws: string[] = [];
		for (const match of query.matchAll(WORD_PATTERN)) {
			const low = match[0].toLowerCase();
			if (!STOP_WORDS.has(low) && low.length <= MAX_TERM_LENGTH && !raws.includes(low)) {
				raws.push(low);
			}
		}
		return raws.slice(0, 8).map((raw, i) => ({ raw, expansions: this.expand(raw, i === raws.length - 1, count) }));
	}

	/**
	 * The vocabulary words `raw` stands for: its stem, words it starts (the last word is usually still
	 * being typed), and when neither is there, words a typo or two away.
	 */
	private expand(raw: string, last: boolean, count: number): IExpansion[] {
		const stem = stemTerm(raw);
		const weights = new Map<number, number>();
		const exact = this.termIds.get(stem);
		if (exact !== undefined && this.df[exact] > 0) {
			weights.set(exact, 1);
		}
		if (raw.length >= (last ? 2 : 3)) {
			const prefixed: number[] = [];
			for (const id of this.buckets.get(raw.slice(0, 2)) ?? []) {
				const term = this.terms[id];
				if (this.df[id] > 0 && id !== exact && term.length > stem.length && (term.startsWith(raw) || term.startsWith(stem))) {
					prefixed.push(id);
				}
			}
			prefixed.sort((a, b) => this.df[b] - this.df[a]);
			for (const id of prefixed.slice(0, PREFIX_EXPANSIONS)) {
				weights.set(id, PREFIX_WEIGHT);
			}
		}
		if (!weights.size && stem.length >= 4) {
			const max = stem.length >= 7 ? 2 : 1;
			const near: number[] = [];
			for (const [key, bucket] of this.buckets) {
				if (key[0] !== stem[0]) {
					continue;
				}
				for (const id of bucket) {
					if (this.df[id] > 0 && boundedDistance(stem, this.terms[id], max) <= max) {
						near.push(id);
					}
				}
			}
			near.sort((a, b) => this.df[b] - this.df[a]);
			for (const id of near.slice(0, TYPO_EXPANSIONS)) {
				weights.set(id, TYPO_WEIGHT);
			}
		}
		return [...weights].map(([id, weight]) => {
			const df = this.df[id];
			const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
			return { id, term: this.terms[id], weight: weight * idf };
		});
	}

	/** The turn holding the most query words (ties: more weight, then the later turn). */
	private bestTurn(doc: IChatSearchDoc, terms: readonly IQueryTerm[]): { index: number; terms: number } {
		const distinct = new Map<number, number>();
		const weight = new Map<number, number>();
		for (const term of terms) {
			const seen = new Set<number>();
			for (const expansion of term.expansions) {
				const k = findTerm(doc.termIds, expansion.id);
				if (k < 0) {
					continue;
				}
				for (let p = doc.turnStart[k]; p < doc.turnStart[k + 1]; p++) {
					const turn = doc.turnList[p];
					weight.set(turn, (weight.get(turn) ?? 0) + expansion.weight);
					if (!seen.has(turn)) {
						seen.add(turn);
						distinct.set(turn, (distinct.get(turn) ?? 0) + 1);
					}
				}
			}
		}
		let best = { index: 0, terms: 0 };
		let bestWeight = -1;
		for (const [turn, termCount] of distinct) {
			const turnWeight = weight.get(turn) ?? 0;
			if (termCount > best.terms || (termCount === best.terms && (turnWeight > bestWeight || (turnWeight === bestWeight && turn > best.index)))) {
				best = { index: turn, terms: termCount };
				bestWeight = turnWeight;
			}
		}
		return best;
	}
}

/**
 * About a line of the first field holding a match: the window with the most distinct query words,
 * starting a little before the first of them, or around the whole phrase when it is there.
 */
export function buildSnippet(fields: readonly { readonly role: 'user' | 'agent'; readonly text: string }[], hitTerms: ReadonlySet<string>, phrase: string): IChatSnippet | undefined {
	// The field with the phrase, else the most distinct query words; the prompt wins a tie.
	let chosen: { role: 'user' | 'agent'; text: string; hits: { start: number; end: number; term: string }[]; phraseAt: number; rank: number } | undefined;
	for (const field of fields) {
		const text = field.text;
		if (!text) {
			continue;
		}
		const hits: { start: number; end: number; term: string }[] = [];
		forEachTerm(text, true, (term, start, end) => {
			if (hitTerms.has(term) && hits.at(-1)?.start !== start) {
				hits.push({ start, end, term });
			}
		});
		const phraseAt = phrase ? text.toLowerCase().indexOf(phrase) : -1;
		const rank = (phraseAt >= 0 ? 1000 : 0) + new Set(hits.map(hit => hit.term)).size;
		if (rank > (chosen?.rank ?? 0)) {
			chosen = { role: field.role, text, hits, phraseAt, rank };
		}
	}
	if (!chosen) {
		return undefined;
	}
	const { text, hits, phraseAt } = chosen;
	let focus = phraseAt;
	if (focus < 0) {
		let bestCount = 0;
		for (const hit of hits.slice(0, 200)) {
			const inWindow = new Set(hits.filter(other => other.start >= hit.start && other.end <= hit.start + SNIPPET_CHARS - SNIPPET_LEAD).map(other => other.term));
			if (inWindow.size > bestCount) {
				bestCount = inWindow.size;
				focus = hit.start;
			}
		}
	}
	let start = Math.max(0, focus - SNIPPET_LEAD);
	if (start > 0) {
		const space = text.indexOf(' ', start);
		start = space >= 0 && space < focus ? space + 1 : start;
	}
	let end = Math.min(text.length, start + SNIPPET_CHARS);
	if (end < text.length) {
		const space = text.lastIndexOf(' ', end);
		end = space > focus ? space : end;
	}
	const lead = start > 0 ? '…' : '';
	const snippet = `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
	const ranges = phraseAt >= 0 ? [{ start: phraseAt, end: phraseAt + phrase.length }, ...hits] : hits;
	const highlights = mergeMatches(ranges
		.filter(range => range.end > start && range.start < end)
		.map(range => ({ start: Math.max(range.start, start) - start + lead.length, end: Math.min(range.end, end) - start + lead.length })));
	const first = phraseAt >= 0 ? { start: phraseAt, end: phraseAt + phrase.length } : hits.find(hit => hit.start >= start) ?? hits[0];
	return { role: chosen.role, text: snippet, highlights, find: text.slice(first.start, first.end) };
}

//#endregion
