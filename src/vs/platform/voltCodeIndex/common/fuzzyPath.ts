/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fuzzy file search over the index's file list, for when FFF is not installed. Each word of the
 * query must match the path (so `sched fair` narrows to `kernel/sched/fair.c`), the file name
 * counts more than its folders, and one typo per word is forgiven when nothing matches exactly
 * (`rootIndez` still finds `rootIndex.ts`). Pure, and a few milliseconds over 100k paths.
 */

const BOUNDARY = new Set(['/', '_', '-', '.', ' ']);
/** Words this short are matched as written: dropping a letter from them matches everything. */
const MIN_TYPO_TERM = 4;

export interface IFuzzyPathResult {
	/** Best first. */
	readonly paths: readonly string[];
	/** Paths that matched, of which `paths` is the best `limit`. */
	readonly total: number;
	/** Nothing matched as written; these allow one typo per word. */
	readonly typos: boolean;
}

export function fuzzyTerms(query: string): string[] {
	return query.toLowerCase().split(/\s+/).map(term => term.replace(/\\/g, '/')).filter(Boolean);
}

function isBoundary(path: string, index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = path[index - 1];
	if (BOUNDARY.has(previous)) {
		return true;
	}
	// camelCase: a capital after a lower-case letter starts a word.
	const char = path.charCodeAt(index);
	const prev = path.charCodeAt(index - 1);
	return char >= 65 && char <= 90 && prev >= 97 && prev <= 122;
}

/** In-order match of `needle` in `hay` (lower-cased `original`), rewarding runs and word starts; 0 when absent. */
function subsequence(hay: string, original: string, offset: number, needle: string): number {
	let score = 0;
	let at = 0;
	let run = 0;
	let first = -1;
	for (let n = 0; n < needle.length; n++) {
		const char = needle.charCodeAt(n);
		let found = -1;
		for (let i = at; i < hay.length; i++) {
			if (hay.charCodeAt(i) === char) {
				found = i;
				break;
			}
		}
		if (found < 0) {
			return 0;
		}
		if (first < 0) {
			first = found;
		}
		run = n > 0 && found === at ? run + 1 : 1;
		score += 1 + (run > 1 ? 2 : 0) + (isBoundary(original, offset + found) ? 3 : 0);
		at = found + 1;
	}
	// A match that starts later and spreads wider is a weaker one.
	return Math.max(0.5, score - Math.min(first, 10) * 0.2 - Math.min(at - first - needle.length, 20) * 0.1);
}

/** Score of one word against one path; 0 when it does not match. */
function termScore(path: string, lower: string, nameStart: number, term: string): number {
	if (term.includes('/')) {
		const index = lower.indexOf(term);
		if (index >= 0) {
			return 20 + term.length * 2 - Math.min(index, 20) * 0.1;
		}
		return subsequence(lower, path, 0, term);
	}
	const name = lower.slice(nameStart);
	if (name === term) {
		return 100;
	}
	const dot = name.indexOf('.');
	if (dot > 0 && name.slice(0, dot) === term) {
		return 90;
	}
	if (name.startsWith(term)) {
		return 60 + term.length;
	}
	const inName = name.indexOf(term);
	if (inName >= 0) {
		return 40 + term.length + (isBoundary(path, nameStart + inName) ? 10 : 0);
	}
	const fuzzyName = subsequence(name, path, nameStart, term);
	if (fuzzyName) {
		return 10 + fuzzyName * 1.5;
	}
	const inPath = lower.indexOf(term);
	if (inPath >= 0) {
		return 15 + term.length + (isBoundary(path, inPath) ? 5 : 0);
	}
	return subsequence(lower, path, 0, term) * 0.6;
}

/** The term with one character dropped at each position: one deleted, extra or wrong letter. */
function typoVariants(term: string): string[] {
	if (term.length < MIN_TYPO_TERM || term.includes('/')) {
		return [];
	}
	const out = new Set<string>();
	for (let i = 0; i < term.length; i++) {
		out.add(term.slice(0, i) + term.slice(i + 1));
	}
	return [...out];
}

/** Bit per letter a-z and digit group present in `text` (lower-case): a subsequence needs all of its bits. */
export function charMask(text: string): number {
	let mask = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 97 && c <= 122) {
			mask |= 1 << (c - 97);
		} else if (c >= 48 && c <= 57) {
			mask |= 1 << 26;
		} else if (c === 47) {
			mask |= 1 << 27;
		} else if (c === 95 || c === 45) {
			mask |= 1 << 28;
		} else if (c === 46) {
			mask |= 1 << 29;
		}
	}
	return mask;
}

export function scorePath(path: string, terms: readonly string[], typos = false, lowerPath?: string): number {
	const lower = lowerPath ?? path.toLowerCase();
	const nameStart = lower.lastIndexOf('/') + 1;
	let total = 0;
	for (const term of terms) {
		let score = termScore(path, lower, nameStart, term);
		if (!score && typos) {
			for (const variant of typoVariants(term)) {
				score = Math.max(score, termScore(path, lower, nameStart, variant) * 0.5);
			}
		}
		if (!score) {
			return 0;
		}
		total += score;
	}
	// Shallow and short paths win ties: `src/index.ts` over `test/fixtures/deep/index.ts`.
	let depth = 0;
	for (let i = 0; i < path.length; i++) {
		if (path.charCodeAt(i) === 47) {
			depth++;
		}
	}
	return total - depth * 0.3 - path.length * 0.01;
}

/**
 * A file list prepared for repeated fuzzy searches: lower-cased paths and a letter mask per path,
 * computed once, so a query skips (with one AND) every path missing a letter it needs.
 */
export class FuzzyPathIndex {

	private readonly lower: string[];
	private readonly masks: Uint32Array;

	constructor(readonly paths: readonly string[]) {
		this.lower = paths.map(path => path.toLowerCase());
		this.masks = new Uint32Array(this.lower.length);
		for (let i = 0; i < this.lower.length; i++) {
			this.masks[i] = charMask(this.lower[i]);
		}
	}

	find(query: string, limit: number, prefix = ''): IFuzzyPathResult {
		const terms = fuzzyTerms(query);
		if (!terms.length) {
			return { paths: [], total: 0, typos: false };
		}
		for (const typos of [false, true]) {
			if (typos && !terms.some(term => typoVariants(term).length)) {
				break;
			}
			// Exact terms need all their letters; a typo variant may lack any one letter, so only the
			// letters every variant keeps (those that occur twice or more) can be required.
			const need = terms.reduce((mask, term) => mask | (typos ? repeatedMask(term) : charMask(term)), 0) >>> 0;
			const scored: { path: string; score: number }[] = [];
			for (let i = 0; i < this.paths.length; i++) {
				if ((this.masks[i] & need) !== need) {
					continue;
				}
				const path = this.paths[i];
				if (prefix && !path.startsWith(prefix)) {
					continue;
				}
				const score = scorePath(path, terms, typos, this.lower[i]);
				if (score > 0) {
					scored.push({ path, score });
				}
			}
			if (scored.length) {
				scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
				return { paths: scored.slice(0, limit).map(entry => entry.path), total: scored.length, typos };
			}
		}
		return { paths: [], total: 0, typos: false };
	}
}

/** Letters that occur at least twice in `term`: still present after any single letter is dropped. */
function repeatedMask(term: string): number {
	let once = 0;
	let twice = 0;
	for (let i = 0; i < term.length; i++) {
		const bit = charMask(term[i]);
		twice |= once & bit;
		once |= bit;
	}
	return twice;
}

export function fuzzyFindPaths(paths: Iterable<string>, query: string, limit: number): IFuzzyPathResult {
	return new FuzzyPathIndex(Array.isArray(paths) ? paths as readonly string[] : [...paths]).find(query, limit);
}
