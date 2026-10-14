/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * File edits an agent passes to `browser_run` so a fix and its check are one tool call. Every model
 * call re-reads the whole context (~14k tokens for cursor-agent), so "edit, then verify" as two
 * calls costs a full turn more than it needs to. Edits are exact-text replacements, validated
 * against every file first and applied all or none.
 */
export interface IFileEdit {
	readonly path: string;
	/** Exact text to replace. Absent with `content` set: write the whole file. */
	readonly old?: string;
	readonly new?: string;
	/** The whole file (creates it when missing). */
	readonly content?: string;
	readonly replaceAll?: boolean;
}

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath', 'filename'] as const;
const OLD_KEYS = ['old', 'old_text', 'old_string', 'oldText', 'oldString', 'search', 'find'] as const;
const NEW_KEYS = ['new', 'new_text', 'new_string', 'newText', 'newString', 'replace', 'replacement'] as const;

function pick(raw: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (raw[key] !== undefined) {
			return raw[key];
		}
	}
	return undefined;
}

export const MAX_FILE_EDITS = 40;

export function parseFileEdits(input: unknown): { edits: IFileEdit[]; errors: string[] } {
	const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : [];
	const edits: IFileEdit[] = [];
	const errors: string[] = [];
	if (!list.length) {
		return { edits, errors: ['`edits` must be a non-empty array like [{"path":"src/app.js","old":"…","new":"…"}]'] };
	}
	if (list.length > MAX_FILE_EDITS) {
		errors.push(`At most ${MAX_FILE_EDITS} edits per call.`);
	}
	list.slice(0, MAX_FILE_EDITS).forEach((value, index) => {
		const where = `edit ${index + 1}`;
		const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
		const path = raw ? pick(raw, PATH_KEYS) : undefined;
		if (!raw || typeof path !== 'string' || !path.trim()) {
			errors.push(`${where}: needs a \`path\``);
			return;
		}
		const content = raw.content ?? raw.contents;
		const old = pick(raw, OLD_KEYS);
		const replacement = pick(raw, NEW_KEYS);
		if (typeof content === 'string' && old === undefined) {
			edits.push({ path: path.trim(), content });
			return;
		}
		if (typeof old !== 'string' || !old.length) {
			errors.push(`${where} (${path}): needs \`old\` (exact text to replace) and \`new\`, or \`content\` for the whole file`);
			return;
		}
		if (typeof replacement !== 'string') {
			errors.push(`${where} (${path}): needs \`new\` (use "" to delete the text)`);
			return;
		}
		edits.push({ path: path.trim(), old, new: replacement, ...(raw.replace_all === true || raw.replaceAll === true ? { replaceAll: true } : {}) });
	});
	return { edits: errors.length ? [] : edits, errors };
}

/** A relative path that stays inside the folder it is resolved against. */
export function safeEditPath(path: string): string | undefined {
	const parts = path.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(part => part && part !== '.');
	return parts.length && !parts.includes('..') ? parts.join('/') : undefined;
}

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
		n++;
	}
	return n;
}

/** The line most like the first line of the text that was not found, to show where the file differs. */
function closestLine(text: string, wanted: string): string | undefined {
	const first = wanted.split('\n').map(line => line.trim()).find(Boolean);
	if (!first) {
		return undefined;
	}
	const words = new Set(first.split(/\W+/).filter(word => word.length > 1));
	let best: { line: string; index: number; score: number } | undefined;
	text.split('\n').forEach((line, index) => {
		const score = line.split(/\W+/).filter(word => words.has(word)).length;
		if (score && (!best || score > best.score)) {
			best = { line: line.trim(), index, score };
		}
	});
	return best ? `line ${best.index + 1}: ${best.line.length > 160 ? `${best.line.slice(0, 157)}…` : best.line}` : undefined;
}

/** Applies one file's edits in order. Fails without a partial result when any edit does not fit. */
export function applyFileEdits(text: string | undefined, edits: readonly IFileEdit[], path: string): { text: string; replacements: number } | { error: string } {
	let current = text;
	let replacements = 0;
	for (const edit of edits) {
		if (edit.content !== undefined) {
			current = edit.content;
			replacements++;
			continue;
		}
		if (current === undefined) {
			return { error: `${path} does not exist (pass \`content\` to create it)` };
		}
		let old = edit.old!;
		let replacement = edit.new!;
		if (!current.includes(old) && current.includes('\r\n') && !old.includes('\r\n')) {
			old = old.replace(/\n/g, '\r\n');
			replacement = replacement.replace(/\n/g, '\r\n');
		}
		const found = count(current, old);
		if (!found) {
			const near = closestLine(current, edit.old!);
			return { error: `${path}: the \`old\` text was not found${near ? ` (closest: ${near})` : ''}; copy it exactly from the file` };
		}
		if (found > 1 && !edit.replaceAll) {
			return { error: `${path}: the \`old\` text appears ${found} times; include more surrounding text or set replace_all` };
		}
		current = edit.replaceAll ? current.split(old).join(replacement) : current.replace(old, () => replacement);
		replacements += edit.replaceAll ? found : 1;
	}
	return { text: current ?? '', replacements };
}

/** Edits grouped by file, in the order each file was first named. */
export function groupFileEdits(edits: readonly IFileEdit[]): Map<string, IFileEdit[]> {
	const groups = new Map<string, IFileEdit[]>();
	for (const edit of edits) {
		const group = groups.get(edit.path) ?? [];
		group.push(edit);
		groups.set(edit.path, group);
	}
	return groups;
}
