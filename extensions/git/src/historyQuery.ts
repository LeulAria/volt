/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A parsed history search query. The query is a space separated list of tokens. A token is
 * either a field (`key:value`, the value may be double quoted) or a bare word. Supported fields:
 *
 * - `author:<text>`                         commits whose author matches the text
 * - `after:<date>` / `since:<date>`         commits newer than the date
 * - `before:<date>` / `until:<date>`        commits older than the date
 * - `path:<path>`                           commits that touched the path (followed across renames when it is a single file)
 * - `lines:<start>-<end>:<path>`            commits that touched the line range of the file
 * - `message:<text>`                        commits whose message matches the text
 * - `merges:only` / `merges:none`           only merge commits / no merge commits
 *
 * Bare words are joined with spaces into one message phrase. A bare 7-40 character hex token is
 * also looked up as a commit. Dates are ISO dates (`2026-10-25`, `2026-10-25T10:30`), epoch seconds
 * (`@1760000000`) or relative dates (`2.weeks.ago`, `yesterday`).
 */
export interface HistoryQuery {
	readonly author?: string;
	readonly since?: string;
	readonly until?: string;
	readonly path?: string;
	/** Follow the path across renames (`path` names a single file, not a glob or a folder). */
	readonly follow?: boolean;
	readonly lineRange?: HistoryQueryLineRange;
	/** Message text: `message:` values and bare words, joined with spaces. */
	readonly message?: string;
	/** A bare hex token which may be a commit hash. */
	readonly commit?: string;
	readonly merges?: 'only' | 'none';
	/** Whether the query uses at least one field. When false, the query is plain text. */
	readonly hasFields: boolean;
}

export interface HistoryQueryLineRange {
	/** 1-based, inclusive. */
	readonly startLine: number;
	/** 1-based, inclusive. */
	readonly endLine: number;
	readonly path: string;
}

interface HistoryQueryToken {
	readonly key?: string;
	readonly value: string;
	/** The token as typed (quotes removed), used when a field turns out to be text. */
	readonly text: string;
	readonly quoted: boolean;
}

const FIELD_KEYS = new Set(['author', 'after', 'since', 'before', 'until', 'path', 'lines', 'message', 'merges']);

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const EPOCH_DATE_REGEX = /^@\d{1,12}$/;
const RELATIVE_DATE_REGEX = /^\d{1,4}\.(?:second|minute|hour|day|week|month|year)s?\.ago$/i;
const NAMED_DATE_REGEX = /^(?:now|today|yesterday)$/i;
const LINE_RANGE_REGEX = /^(\d{1,9})(?:[-,](\d{1,9}))?:(.+)$/;
const COMMIT_HASH_REGEX = /^[0-9a-f]{7,40}$/i;
const GLOB_REGEX = /[*?[\]{}]/;

/** Splits the query on whitespace; double quotes group text, also inside a field value (`author:"Jane Doe"`). */
function tokenize(query: string): HistoryQueryToken[] {
	const tokens: HistoryQueryToken[] = [];

	let index = 0;
	while (index < query.length) {
		while (index < query.length && /\s/.test(query[index])) {
			index++;
		}
		if (index >= query.length) {
			break;
		}

		let raw = '';
		let quoted = false;
		let inQuotes = false;
		// A field is `key:value` where the key was typed before any quote
		let separator = -1;
		while (index < query.length && (inQuotes || !/\s/.test(query[index]))) {
			const char = query[index++];
			if (char === '"') {
				inQuotes = !inQuotes;
				quoted = true;
				continue;
			}
			if (char === ':' && !quoted && separator === -1) {
				separator = raw.length;
			}
			raw += char;
		}

		if (raw === '') {
			continue;
		}

		const key = separator > 0 ? raw.substring(0, separator).toLowerCase() : undefined;
		if (key && FIELD_KEYS.has(key)) {
			tokens.push({ key, value: raw.substring(separator + 1).trim(), text: raw, quoted });
		} else {
			tokens.push({ value: raw, text: raw, quoted });
		}
	}

	return tokens;
}

export function isValidHistoryQueryDate(value: string): boolean {
	return ISO_DATE_REGEX.test(value) || EPOCH_DATE_REGEX.test(value) || RELATIVE_DATE_REGEX.test(value) || NAMED_DATE_REGEX.test(value);
}

// git reads a bare date as that day at the current time of day; `after:2026-09-21` means from its start.
function startOfDay(value: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
}

export function parseHistoryQuery(query: string): HistoryQuery {
	let author: string | undefined;
	let since: string | undefined;
	let until: string | undefined;
	let path: string | undefined;
	let lineRange: HistoryQueryLineRange | undefined;
	let commit: string | undefined;
	let merges: 'only' | 'none' | undefined;
	let hasFields = false;
	const messageParts: string[] = [];

	for (const token of tokenize(query)) {
		const value = token.value;

		switch (token.key) {
			case 'author':
				if (value) {
					author = value;
					hasFields = true;
					continue;
				}
				break;
			case 'after':
			case 'since':
				if (isValidHistoryQueryDate(value)) {
					since = startOfDay(value);
					hasFields = true;
					continue;
				}
				break;
			case 'before':
			case 'until':
				if (isValidHistoryQueryDate(value)) {
					until = startOfDay(value);
					hasFields = true;
					continue;
				}
				break;
			case 'path': {
				const normalized = normalizePath(value);
				if (normalized) {
					path = normalized;
					hasFields = true;
					continue;
				}
				break;
			}
			case 'lines': {
				const match = LINE_RANGE_REGEX.exec(value);
				const startLine = match ? Number(match[1]) : 0;
				const endLine = match ? Number(match[2] ?? match[1]) : 0;
				const linePath = match ? normalizePath(match[3]) : undefined;
				if (linePath && startLine >= 1 && endLine >= startLine && !GLOB_REGEX.test(linePath)) {
					lineRange = { startLine, endLine, path: linePath };
					hasFields = true;
					continue;
				}
				break;
			}
			case 'message':
				if (value) {
					messageParts.push(value);
					hasFields = true;
					continue;
				}
				break;
			case 'merges': {
				const mode = value.toLowerCase();
				if (mode === 'only' || mode === 'none') {
					merges = mode;
					hasFields = true;
					continue;
				}
				break;
			}
			default:
				if (!token.quoted && COMMIT_HASH_REGEX.test(value) && commit === undefined) {
					commit = value.toLowerCase();
				}
				messageParts.push(value);
				continue;
		}

		// A field with an invalid value is plain text
		messageParts.push(token.text);
	}

	const message = messageParts.length > 0 ? messageParts.join(' ') : undefined;
	const follow = path !== undefined && !GLOB_REGEX.test(path) && !path.endsWith('/') && path !== '.';

	return { author, since, until, path, follow: path !== undefined ? follow : undefined, lineRange, message, commit, merges, hasFields };
}

/** Repository-relative path with forward slashes and no leading `./` or `/`. */
function normalizePath(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
	return normalized !== '' ? normalized : undefined;
}
