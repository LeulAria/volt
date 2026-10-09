/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IReleaseNoteSummary {
	/** The first list items, as plain text. */
	readonly items: readonly string[];
	/** How many list items the notes have in total. */
	readonly total: number;
}

/**
 * The "What's changed" list of a GitHub Release body: its top-level bullet items as plain text.
 * Handles GitHub's generated notes (`* feat: x by @a in https://…/pull/12`) and the nightly
 * commit list (`- subject (abc1234)`).
 */
export function summarizeReleaseNotes(markdown: string | undefined, max = 8): IReleaseNoteSummary {
	const items: string[] = [];
	for (const line of (markdown ?? '').split(/\r?\n/)) {
		const match = /^ {0,1}[-*+]\s+(.+)$/.exec(line);
		if (match) {
			const text = plainText(match[1]);
			if (text) {
				items.push(text);
			}
		}
	}
	return { items: items.slice(0, Math.max(0, max)), total: items.length };
}

function plainText(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/(\d+)/g, '#$1')
		.replace(/(\*\*|__)(.+?)\1/g, '$2')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\s\([0-9a-f]{7,12}\)$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}
