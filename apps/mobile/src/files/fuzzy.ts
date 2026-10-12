/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quick-open matching, the way an editor's file picker ranks: every query character in order,
 * with runs, word starts and the file name worth more than scattered hits deep in a folder.
 * Undefined when the path doesn't match.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
	const q = query.toLowerCase().replace(/\s+/g, '');
	if (!q) {
		return 0;
	}
	const p = path.toLowerCase();
	const nameStart = p.lastIndexOf('/') + 1;
	let score = 0;
	let at = 0;
	let run = 0;
	for (let i = 0; i < q.length; i++) {
		const found = p.indexOf(q[i], at);
		if (found < 0) {
			return undefined;
		}
		const boundary = found === 0 || '/._-'.includes(p[found - 1]) || (path[found] !== p[found] && path[found - 1] === p[found - 1]);
		run = found === at && i > 0 ? run + 1 : 0;
		score += 1 + run * 3 + (boundary ? 4 : 0) + (found >= nameStart ? 2 : 0);
		at = found + 1;
	}
	// Shorter paths and a name that contains the whole query rank first.
	if (p.slice(nameStart).includes(q)) {
		score += 20;
	}
	return score - path.length * 0.05;
}

/** The best `limit` matches, best first. */
export function fuzzyFilter(query: string, paths: readonly string[], limit = 80): string[] {
	const scored: { readonly path: string; readonly score: number }[] = [];
	for (const path of paths) {
		const score = fuzzyScore(query, path);
		if (score !== undefined) {
			scored.push({ path, score });
		}
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.path);
}
