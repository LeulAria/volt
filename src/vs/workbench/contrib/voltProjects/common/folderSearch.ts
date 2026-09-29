/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IFolderCandidate {
	readonly name: string;
	readonly path: string;
	readonly gitRepo?: boolean;
}

export interface IFolderRankContext {
	/** Paths already added as projects. */
	readonly projects: ReadonlySet<string>;
	/** Paths opened recently, most recent first. */
	readonly recents: readonly string[];
}

/**
 * Scores a folder for "search all folders": how well the name matches, boosted for git repos,
 * known projects and recent folders, lightly penalised for depth. Undefined when it does not
 * match at all.
 */
export function scoreFolder(candidate: IFolderCandidate, query: string, context: IFolderRankContext): number | undefined {
	const needle = query.trim().toLowerCase();
	const name = candidate.name.toLowerCase();
	let score: number;
	if (!needle) {
		score = 0;
	} else if (name === needle) {
		score = 100;
	} else if (name.startsWith(needle)) {
		score = 80;
	} else if (wordStart(name, needle)) {
		score = 70;
	} else if (name.includes(needle)) {
		score = 60;
	} else if (isSubsequence(needle, name)) {
		score = 30;
	} else {
		return undefined;
	}
	if (candidate.gitRepo) {
		score += 25;
	}
	if (context.projects.has(candidate.path)) {
		score += 15;
	}
	const recent = context.recents.indexOf(candidate.path);
	if (recent >= 0) {
		score += Math.max(5, 20 - recent);
	}
	score -= candidate.path.split(/[\\/]/).length * 1.5;
	return score;
}

export function rankFolders<T extends IFolderCandidate>(candidates: readonly T[], query: string, context: IFolderRankContext): T[] {
	const scored: { candidate: T; score: number }[] = [];
	for (const candidate of candidates) {
		const score = scoreFolder(candidate, query, context);
		if (score !== undefined) {
			scored.push({ candidate, score });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.candidate.path.length - b.candidate.path.length || a.candidate.path.localeCompare(b.candidate.path));
	return scored.map(entry => entry.candidate);
}

function wordStart(name: string, needle: string): boolean {
	return name.split(/[-_. ]/).some(part => part.startsWith(needle));
}

function isSubsequence(needle: string, haystack: string): boolean {
	let at = 0;
	for (let i = 0; i < haystack.length && at < needle.length; i++) {
		if (haystack[i] === needle[at]) {
			at++;
		}
	}
	return at === needle.length;
}
