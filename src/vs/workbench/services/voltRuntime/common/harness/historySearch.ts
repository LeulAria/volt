/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeLoopMessage } from './nativeLoop.js';

/**
 * pi-durable's `search_history`: compaction and tool-result clearing take messages out of the
 * model's view, never out of storage. The agent searches what was taken out (the exact command,
 * the error text, a tool's full output) instead of redoing work the summary only mentions.
 */

export const SEARCH_HISTORY_TOOL_NAME = 'search_history';

/** A message taken out of view, with when it was taken out. */
export interface IArchivedMessage {
	readonly message: INativeLoopMessage;
	/** When it was archived (ms). */
	readonly at: number;
}

const EXCERPT_CHARS = 700;
const MAX_OUTPUT_CHARS = 12_000;

/** What a message says, as searched: its text, and the calls it made with their arguments. */
function searchable(message: INativeLoopMessage): string {
	const calls = (message.toolCalls ?? []).map(call => `${call.name} ${safeJson(call.args)}`).join('\n');
	return [message.content, calls].filter(Boolean).join('\n');
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '';
	}
}

function terms(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_./:-]+/u).filter(term => term.length >= 2))];
}

function count(haystack: string, needle: string): number {
	let found = 0;
	for (let at = haystack.indexOf(needle); at >= 0 && found < 3; at = haystack.indexOf(needle, at + needle.length)) {
		found++;
	}
	return found;
}

/**
 * The best matches for `query`, newest first among equals, as text for the model: each with its
 * place in the history, who said it, the tool it came from, and an excerpt around the first match.
 */
export function searchArchivedHistory(archive: readonly IArchivedMessage[], query: string, limit = 8): string {
	const wanted = terms(query);
	if (!wanted.length) {
		return 'Give search_history a query: words from the command, error, file, or decision you are looking for.';
	}
	if (!archive.length) {
		return 'Nothing has been compacted or cleared in this chat yet: everything it did is still in view.';
	}
	const phrase = query.trim().toLowerCase();
	const hits: { readonly index: number; readonly score: number; readonly text: string; readonly first: number }[] = [];
	archive.forEach((entry, index) => {
		const text = searchable(entry.message);
		const lower = text.toLowerCase();
		let score = 0;
		let first = -1;
		for (const term of wanted) {
			const n = count(lower, term);
			if (n) {
				score += n;
				const at = lower.indexOf(term);
				first = first < 0 ? at : Math.min(first, at);
			}
		}
		if (!score) {
			return;
		}
		if (phrase.length > 3 && lower.includes(phrase)) {
			score += 5;
			first = lower.indexOf(phrase);
		}
		hits.push({ index, score, text, first });
	});
	if (!hits.length) {
		return `No earlier message matches "${query.trim()}". Try other words (a file name, a command, part of an error).`;
	}
	hits.sort((a, b) => b.score - a.score || b.index - a.index);
	const out: string[] = [];
	let chars = 0;
	for (const hit of hits.slice(0, Math.max(1, Math.min(20, limit)))) {
		const { message, at } = archive[hit.index];
		const start = Math.max(0, hit.first - Math.floor(EXCERPT_CHARS / 3));
		const excerpt = hit.text.slice(start, start + EXCERPT_CHARS).trim();
		const who = message.role === 'tool' ? `tool result${message.name ? ` (${message.name})` : ''}${message.isError ? ', error' : ''}` : message.role;
		const block = `[#${hit.index} ${who}, archived ${new Date(at).toISOString()}]\n${start > 0 ? '\u2026' : ''}${excerpt}${start + EXCERPT_CHARS < hit.text.length ? '\u2026' : ''}`;
		if (chars + block.length > MAX_OUTPUT_CHARS) {
			break;
		}
		out.push(block);
		chars += block.length;
	}
	const more = hits.length > out.length ? `\n\n(${hits.length - out.length} more matches; narrow the query to see them.)` : '';
	return `${out.join('\n\n')}${more}`;
}
