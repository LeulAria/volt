/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure text-windowing helpers for prediction context. String in, string out - the browser
 * layer feeds these from ITextModel; tests feed them literals.
 */

export interface IExcerptBudget {
	/** Max characters of prefix (text before the cursor). */
	before: number;
	/** Max characters of suffix (text after the cursor). */
	after: number;
}

export const DEFAULT_EXCERPT_BUDGET: IExcerptBudget = { before: 3000, after: 1500 };

/** Ghost text needs the code around the cursor, not the whole function: about 900 tokens. */
export const INLINE_EXCERPT_BUDGET: IExcerptBudget = { before: 2400, after: 1000 };

export interface IExcerpt {
	prefix: string;
	suffix: string;
}

/**
 * Cuts a prefix/suffix window around `offset`. Cuts snap outward to the next line break so
 * the model never sees a half line at the window edge (except at file boundaries).
 */
export function extractExcerpt(text: string, offset: number, budget: IExcerptBudget = DEFAULT_EXCERPT_BUDGET): IExcerpt {
	const clamped = Math.max(0, Math.min(offset, text.length));

	let start = Math.max(0, clamped - budget.before);
	if (start > 0) {
		const nl = text.indexOf('\n', start);
		if (nl !== -1 && nl < clamped) {
			start = nl + 1;
		}
	}

	let end = Math.min(text.length, clamped + budget.after);
	if (end < text.length) {
		const nl = text.lastIndexOf('\n', end);
		if (nl > clamped) {
			end = nl;
		}
	}

	return { prefix: text.slice(start, clamped), suffix: text.slice(clamped, end) };
}

const IMPORT_LINE = /^\s*(import\s|from\s.+\simport\s|export\s+\{[^}]*\}\s+from\s|const\s+\w+\s*=\s*require\(|use\s+[\w:]+;|#include\s|using\s+[\w.]+;|require\s+['"]|package\s+[\w.]+)/;

/**
 * Collects the leading import/require block (first ~60 lines scanned). Language-agnostic
 * line heuristic - good enough for prompt context, never used for edits.
 */
export function extractImports(text: string, maxLines = 60): string {
	const out: string[] = [];
	const lines = text.split('\n', maxLines);
	for (const line of lines) {
		if (IMPORT_LINE.test(line)) {
			out.push(line.trimEnd());
		}
	}
	return out.join('\n');
}

export const KEYWORDS: ReadonlySet<string> = new Set([
	'abstract', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'def', 'delete', 'elif',
	'else', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'float', 'for', 'from', 'func', 'function', 'import', 'impl', 'interface',
	'lambda', 'let', 'match', 'none', 'null', 'number', 'package', 'private', 'protected', 'public', 'return', 'self', 'static',
	'string', 'struct', 'super', 'switch', 'this', 'throw', 'true', 'type', 'typeof', 'undefined', 'unsafe', 'void', 'while', 'with',
	'yield', 'var', 'int', 'bool', 'new', 'try', 'not', 'and', 'pass', 'use', 'mut', 'pub', 'then', 'end',
]);

/**
 * Identifiers near the cursor (the current line first, then the lines just above), the names a
 * related file is useful for. Keywords and short names are left out.
 */
export function cursorIdentifiers(prefix: string, linePrefix: string, max = 12): string[] {
	const recent = prefix.split('\n').slice(-6, -1).reverse();
	const seen = new Set<string>();
	for (const line of [linePrefix, ...recent]) {
		for (const match of line.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
			const word = match[0];
			if (!KEYWORDS.has(word.toLowerCase()) && !seen.has(word)) {
				seen.add(word);
				if (seen.size >= max) {
					return [...seen];
				}
			}
		}
	}
	return [...seen];
}

/**
 * The lines of a related file that mention `identifiers`, with a line of context either side,
 * capped at `maxChars`. Empty when nothing matches, so an unrelated file costs no tokens.
 */
export function relevantSnippet(text: string, identifiers: readonly string[], maxChars = 600): string {
	if (!identifiers.length) {
		return '';
	}
	const pattern = new RegExp(`\\b(?:${identifiers.map(id => id.replace(/[$]/g, '\\$')).join('|')})\\b`);
	const lines = text.split('\n');
	const keep = new Set<number>();
	for (let i = 0; i < lines.length && keep.size < 60; i++) {
		if (pattern.test(lines[i])) {
			keep.add(i - 1).add(i).add(i + 1);
		}
	}
	const out: string[] = [];
	let used = 0;
	let last = -2;
	for (const i of [...keep].filter(i => i >= 0 && i < lines.length).sort((a, b) => a - b)) {
		const line = lines[i].trimEnd();
		if (used + line.length + 1 > maxChars) {
			break;
		}
		if (last >= 0 && i > last + 1) {
			out.push('...');
		}
		out.push(line);
		used += line.length + 1;
		last = i;
	}
	return out.join('\n');
}

/** Truncates a snippet for prompt/ring-buffer use, marking the cut. */
export function truncateSnippet(text: string, maxChars = 400): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}...`;
}
