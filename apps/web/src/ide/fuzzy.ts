/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quick open's matcher, after VS Code's: the query's letters in order, scored up for matches at
 * the start of the name, after a separator or a case change, and in a run; a match in the file
 * name beats one spread over its folders. Fast enough to rank 100k paths per keystroke.
 */

export interface IFuzzyMatch {
	readonly score: number;
	/** Matched character positions in the text. */
	readonly positions: readonly number[];
}

function isSeparator(ch: string): boolean {
	return ch === '/' || ch === '\\' || ch === '_' || ch === '-' || ch === '.' || ch === ' ';
}

/** Scores `query` (lower-case, no spaces) against `text` from `offset`; undefined without a match. */
function scoreFrom(query: string, text: string, lower: string, offset: number): IFuzzyMatch | undefined {
	const positions: number[] = [];
	let score = 0;
	let ti = offset;
	let run = 0;
	for (let qi = 0; qi < query.length; qi++) {
		const ch = query[qi];
		const found = lower.indexOf(ch, ti);
		if (found < 0) {
			return undefined;
		}
		const prev = found > 0 ? text[found - 1] : '/';
		let bonus = 1;
		if (found === ti && positions.length) {
			run++;
			bonus += 4 + run;
		} else {
			run = 0;
		}
		if (isSeparator(prev)) {
			bonus += 6;
		} else if (text[found] !== lower[found] && prev === prev.toLowerCase()) {
			bonus += 5;
		}
		if (text[found] === ch) {
			bonus += 0.5;
		}
		score += bonus - Math.min(3, (found - ti) * 0.05);
		positions.push(found);
		ti = found + 1;
	}
	return { score, positions };
}

/** Matches a path: first in its file name, then over the whole path. */
export function fuzzyPath(query: string, path: string): IFuzzyMatch | undefined {
	const q = query.replace(/\s+/g, '').toLowerCase();
	if (!q) {
		return { score: 0, positions: [] };
	}
	const lower = path.toLowerCase();
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const inName = scoreFrom(q, path, lower, slash + 1);
	if (inName) {
		// File-name matches rank above anything spread over the folders; shorter names win ties.
		const exact = lower.slice(slash + 1) === q ? 40 : lower.slice(slash + 1).startsWith(q) ? 18 : 0;
		return { score: inName.score + 30 + exact - (path.length - slash) * 0.02, positions: inName.positions };
	}
	const anywhere = scoreFrom(q, path, lower, 0);
	return anywhere ? { score: anywhere.score - path.length * 0.01, positions: anywhere.positions } : undefined;
}

/** Matches free text (chat titles, commands). */
export function fuzzyText(query: string, text: string): IFuzzyMatch | undefined {
	const q = query.replace(/\s+/g, '').toLowerCase();
	if (!q) {
		return { score: 0, positions: [] };
	}
	const lower = text.toLowerCase();
	const contiguous = lower.indexOf(query.trim().toLowerCase());
	const match = scoreFrom(q, text, lower, 0);
	if (!match) {
		return undefined;
	}
	return contiguous >= 0 ? { score: match.score + 20 - contiguous * 0.1, positions: match.positions } : match;
}

/** The best `limit` items for `query`, best first. */
export function rank<T>(items: readonly T[], query: string, text: (item: T) => string, match: (query: string, text: string) => IFuzzyMatch | undefined, limit = 60): { readonly item: T; readonly match: IFuzzyMatch }[] {
	const out: { item: T; match: IFuzzyMatch }[] = [];
	let floor = -Infinity;
	for (const item of items) {
		const m = match(query, text(item));
		if (!m || (out.length >= limit && m.score <= floor)) {
			continue;
		}
		out.push({ item, match: m });
		if (out.length > limit * 2) {
			out.sort((a, b) => b.match.score - a.match.score);
			out.length = limit;
			floor = out[out.length - 1].match.score;
		}
	}
	out.sort((a, b) => b.match.score - a.match.score);
	return out.slice(0, limit);
}
