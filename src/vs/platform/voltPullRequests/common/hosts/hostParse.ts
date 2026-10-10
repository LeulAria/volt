/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltPrCheck, IVoltPrFilePatch, IVoltPrMergeOptions, IVoltPrUser, VoltPrFileChange } from '../voltPullRequests.js';

/**
 * Shared readers for the REST hosts' JSON (GitLab, Bitbucket, Gitea, Azure DevOps). Each host's
 * parser declares the shapes it reads with `unknown` leaves: the JSON is untrusted, so every value
 * goes through one of these readers.
 */

export function time(value: unknown): number | undefined {
	if (typeof value !== 'string' || !value) {
		return undefined;
	}
	const ms = Date.parse(value);
	// Gitea and GitLab write "0001-01-01T00:00:00Z" for never.
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

export function num(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && /^\d+$/.test(value)) {
		return Number(value);
	}
	return 0;
}

/**
 * The array's non-null entries, read as `T`: a shape with `unknown` leaves, so a host that sends
 * something else still only yields `undefined` reads.
 */
export function list<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? value.filter((item): item is T => item !== null && item !== undefined) : [];
}

export function user(login: unknown, avatarUrl?: unknown, bot?: boolean): IVoltPrUser {
	const name = typeof login === 'string' && login ? login : 'ghost';
	return {
		login: name,
		...(typeof avatarUrl === 'string' && /^https?:\/\//.test(avatarUrl) ? { avatarUrl } : {}),
		...(bot || /\[bot\]$|^bot$/i.test(name) ? { bot: true } : {}),
	};
}

/** Every merge method allowed, branch kept: what a host without a repository settings read offers. */
export const ALL_MERGE_OPTIONS: IVoltPrMergeOptions = { merge: true, squash: true, rebase: true, deleteBranchOnMerge: false, autoMergeAllowed: false };

/** `Draft: x`, `WIP: x`, `[WIP] x`: titles that mark a draft where the host has no draft flag. */
export function draftTitle(title: string): boolean {
	return /^\s*(?:\[?(?:wip|draft)\]?\s*:?\s+|\[(?:wip|draft)\]\s*)/i.test(title);
}

export function stripDraftTitle(title: string): string {
	return title.replace(/^\s*(?:\[?(?:wip|draft)\]?\s*:?\s+|\[(?:wip|draft)\]\s*)/i, '');
}

/** Newest first per name: the latest status a context reported is where it stands. */
export function latestByName(checks: readonly (IVoltPrCheck & { readonly at?: number })[]): IVoltPrCheck[] {
	const byName = new Map<string, IVoltPrCheck & { readonly at?: number }>();
	for (const check of checks) {
		const seen = byName.get(check.name);
		if (!seen || (check.at ?? 0) >= (seen.at ?? 0)) {
			byName.set(check.name, check);
		}
	}
	return [...byName.values()].map(({ at: _at, ...check }) => check as IVoltPrCheck);
}

/**
 * A multi-file unified diff (`git diff`, a host's `.diff`) split per file: the hunks start at the
 * first `@@`, like GitHub's `patch` field, so the inline diff rebuilds the old side the same way.
 */
export function splitUnifiedDiff(text: string): IVoltPrFilePatch[] {
	const files: IVoltPrFilePatch[] = [];
	const sections = text.split(/^(?=diff --git )/m).filter(section => section.startsWith('diff --git '));
	for (const section of sections) {
		const lines = section.split('\n');
		const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(lines[0]);
		let oldPath = header?.[1];
		let newPath = header?.[2];
		let change: VoltPrFileChange = 'modified';
		let binary = false;
		let blob: string | undefined;
		let index = 1;
		for (; index < lines.length && !lines[index].startsWith('@@'); index++) {
			const line = lines[index];
			if (line.startsWith('new file mode')) {
				change = 'added';
			} else if (line.startsWith('deleted file mode')) {
				change = 'deleted';
			} else if (line.startsWith('rename from ')) {
				oldPath = line.slice('rename from '.length);
				change = 'renamed';
			} else if (line.startsWith('rename to ')) {
				newPath = line.slice('rename to '.length);
				change = 'renamed';
			} else if (line.startsWith('copy to ')) {
				newPath = line.slice('copy to '.length);
				change = 'copied';
			} else if (line.startsWith('--- ') && line !== '--- /dev/null') {
				oldPath = line.slice(4).replace(/^a\//, '');
			} else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
				newPath = line.slice(4).replace(/^b\//, '');
			} else if (line.startsWith('index ')) {
				// `index <old>..<new> [mode]`: with --full-index, the new side's blob id.
				const ids = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(line);
				if (ids && /^[0-9a-f]{40,64}$/.test(ids[1]) && !/^0+$/.test(ids[1])) {
					blob = ids[1];
				}
			} else if (/^Binary files /.test(line) || line.startsWith('GIT binary patch')) {
				binary = true;
			}
		}
		const hunks = lines.slice(index);
		while (hunks.length && hunks[hunks.length - 1] === '') {
			hunks.pop();
		}
		let additions = 0;
		let deletions = 0;
		for (const line of hunks) {
			if (line.startsWith('+')) {
				additions++;
			} else if (line.startsWith('-')) {
				deletions++;
			}
		}
		const path = (change === 'deleted' ? oldPath : newPath) ?? oldPath ?? '';
		if (!path) {
			continue;
		}
		files.push({
			path,
			...(oldPath && oldPath !== path && change !== 'deleted' ? { previousPath: oldPath } : {}),
			change,
			additions,
			deletions,
			...(!binary && hunks.length ? { patch: hunks.join('\n') } : {}),
			...(blob && change !== 'deleted' ? { blob } : {}),
		});
	}
	return files;
}
