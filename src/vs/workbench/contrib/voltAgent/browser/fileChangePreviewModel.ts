/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import { splitLines } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';

/** Show the whole change when added+removed lines stay under this. */
export const FILE_CHANGE_PREVIEW_FULL_LIMIT = 12;
/** Large edits only show a short review slice. */
export const FILE_CHANGE_PREVIEW_LARGE_MAX = 5;
/** Expanded file cards show a longer review slice for big edits. */
export const FILE_CHANGE_PREVIEW_EXPANDED_MAX = 40;

export type FileChangeVerb = 'Edited' | 'Created' | 'Deleted';

export type FileChangePreviewLineKind = 'context' | 'insert' | 'delete';

export interface IFileChangePreviewLine {
	readonly kind: FileChangePreviewLineKind;
	readonly lineNumber: number;
	readonly text: string;
}

export interface IFileChangePreviewHunk {
	readonly lines: readonly IFileChangePreviewLine[];
	readonly additions: number;
	readonly deletions: number;
}

export interface IFileChangePreviewModel {
	readonly name: string;
	readonly resource?: URI;
	readonly language?: string;
	readonly additions: number;
	readonly deletions: number;
	readonly lines: readonly IFileChangePreviewLine[];
	readonly truncated: boolean;
}

export interface IFileChangePreviewSource {
	readonly uri?: URI;
	readonly path?: string;
	readonly name?: string;
	readonly language?: string;
	readonly verb?: FileChangeVerb;
	readonly original?: string;
	readonly modified?: string;
	readonly unifiedDiff?: string;
	readonly lines?: readonly IFileChangePreviewLine[];
	readonly additions?: number;
	readonly deletions?: number;
}

export interface IFileChangePreviewComputeOptions {
	readonly maxLines?: number;
}

/** High-level accordion row vs. the detailed file-diff card. */
export type FileChangeDiffStyle = 'accordion' | 'card';

export interface IFileChangeDiffStyleContext {
	readonly surface: 'sidebar' | 'browser';
	readonly files?: number;
	readonly additions?: number;
	readonly deletions?: number;
	readonly preferred?: FileChangeDiffStyle;
}

/**
 * Pick how to render a file change: the sidebar stays compact (accordion),
 * the browser agent text area shows the detailed file-diff card.
 */
export function chooseFileChangeDiffStyle(context: IFileChangeDiffStyleContext): FileChangeDiffStyle {
	if (context.preferred) {
		return context.preferred;
	}
	if (context.surface === 'browser') {
		return 'card';
	}
	return 'accordion';
}

const DIFF_OPTIONS = {
	ignoreTrimWhitespace: false,
	maxComputationTimeMs: 80,
	computeMoves: false,
} as const;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function resourceFromPreviewSource(source: IFileChangePreviewSource): URI | undefined {
	if (source.uri) {
		return source.uri;
	}
	if (source.path) {
		return URI.file(source.path);
	}
	return undefined;
}

export function previewFileName(source: IFileChangePreviewSource, resource = resourceFromPreviewSource(source)): string {
	if (source.name) {
		return source.name;
	}
	if (resource) {
		return basename(resource.path);
	}
	if (source.path) {
		return basename(source.path);
	}
	return 'file';
}

export function computeFileChangePreview(source: IFileChangePreviewSource, options?: IFileChangePreviewComputeOptions): IFileChangePreviewModel {
	const resource = resourceFromPreviewSource(source);
	const name = previewFileName(source, resource);
	const hunks = hunksFromSource(source);
	const additions = source.additions ?? hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
	const deletions = source.deletions ?? hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
	const { lines, truncated } = selectPreviewLines(hunks, additions, deletions, source.lines, options?.maxLines);
	return {
		name,
		resource,
		language: source.language,
		additions,
		deletions,
		lines,
		truncated,
	};
}

export function selectPreviewLines(
	hunks: readonly IFileChangePreviewHunk[],
	additions: number,
	deletions: number,
	precomputed?: readonly IFileChangePreviewLine[],
	maxLines = FILE_CHANGE_PREVIEW_LARGE_MAX,
): { lines: IFileChangePreviewLine[]; truncated: boolean } {
	const changed = additions + deletions;
	const all = precomputed ? [...precomputed] : flattenHunks(hunks);
	if (changed < FILE_CHANGE_PREVIEW_FULL_LIMIT || all.length <= maxLines) {
		return { lines: all, truncated: changed >= FILE_CHANGE_PREVIEW_FULL_LIMIT && all.length > maxLines };
	}
	const review = pickReviewHunk(hunks);
	const slice = clipLargePreview(review ? [...review.lines] : all, maxLines);
	return { lines: slice, truncated: all.length > slice.length || changed > slice.filter(line => line.kind !== 'context').length };
}

export function formatChangeStats(additions: number, deletions: number): { added?: string; removed?: string } {
	return {
		added: additions > 0 ? `+${additions}` : undefined,
		removed: deletions > 0 ? `-${deletions}` : undefined,
	};
}

export function parseUnifiedDiff(diff: string): IFileChangePreviewHunk[] {
	const hunks: IFileChangePreviewHunk[] = [];
	let lines: IFileChangePreviewLine[] = [];
	let additions = 0;
	let deletions = 0;
	let originalLine = 0;
	let modifiedLine = 0;
	let inHunk = false;

	const flush = () => {
		if (!inHunk || !lines.length) {
			return;
		}
		hunks.push({ lines, additions, deletions });
		lines = [];
		additions = 0;
		deletions = 0;
		inHunk = false;
	};

	for (const raw of splitLines(diff)) {
		if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('---') || raw.startsWith('+++')) {
			flush();
			continue;
		}
		const header = HUNK_RE.exec(raw);
		if (header) {
			flush();
			originalLine = Number(header[1]);
			modifiedLine = Number(header[3]);
			inHunk = true;
			continue;
		}
		if (!inHunk) {
			continue;
		}
		const mark = raw.charAt(0);
		const text = mark === '+' || mark === '-' || mark === ' ' ? raw.slice(1) : raw;
		if (mark === '+') {
			lines.push({ kind: 'insert', lineNumber: modifiedLine, text });
			modifiedLine++;
			additions++;
		} else if (mark === '-') {
			lines.push({ kind: 'delete', lineNumber: originalLine, text });
			originalLine++;
			deletions++;
		} else if (mark === '\\') {
			continue;
		} else {
			lines.push({ kind: 'context', lineNumber: modifiedLine, text });
			originalLine++;
			modifiedLine++;
		}
	}
	flush();
	return hunks;
}

function hunksFromSource(source: IFileChangePreviewSource): IFileChangePreviewHunk[] {
	if (source.lines?.length) {
		return [{
			lines: source.lines,
			additions: source.additions ?? source.lines.filter(line => line.kind === 'insert').length,
			deletions: source.deletions ?? source.lines.filter(line => line.kind === 'delete').length,
		}];
	}
	if (source.unifiedDiff) {
		return parseUnifiedDiff(source.unifiedDiff);
	}
	if (source.original !== undefined || source.modified !== undefined) {
		return hunksFromContents(toLines(source.original ?? ''), toLines(source.modified ?? ''));
	}
	return [];
}

function hunksFromContents(original: string[], modified: string[]): IFileChangePreviewHunk[] {
	if (!original.length && !modified.length) {
		return [];
	}
	if (!original.length || !modified.length) {
		return [fullReplaceHunk(original, modified)];
	}
	try {
		const diff = linesDiffComputers.getDefault().computeDiff(original, modified, DIFF_OPTIONS);
		return diff.changes.map(change => {
			const lines: IFileChangePreviewLine[] = [];
			const contextOriginal = change.original.startLineNumber - 1;
			const contextModified = change.modified.startLineNumber - 1;
			if (contextOriginal >= 1 && contextOriginal <= original.length) {
				lines.push({
					kind: 'context',
					lineNumber: contextModified >= 1 ? contextModified : contextOriginal,
					text: (contextModified >= 1 && contextModified <= modified.length)
						? modified[contextModified - 1]
						: original[contextOriginal - 1],
				});
			}
			for (let n = change.original.startLineNumber; n < change.original.endLineNumberExclusive; n++) {
				lines.push({ kind: 'delete', lineNumber: n, text: original[n - 1] ?? '' });
			}
			for (let n = change.modified.startLineNumber; n < change.modified.endLineNumberExclusive; n++) {
				lines.push({ kind: 'insert', lineNumber: n, text: modified[n - 1] ?? '' });
			}
			return {
				lines,
				additions: change.modified.length,
				deletions: change.original.length,
			};
		});
	} catch {
		return [fullReplaceHunk(original, modified)];
	}
}

function flattenHunks(hunks: readonly IFileChangePreviewHunk[]): IFileChangePreviewLine[] {
	const lines: IFileChangePreviewLine[] = [];
	for (const hunk of hunks) {
		lines.push(...hunk.lines);
	}
	return lines;
}

function pickReviewHunk(hunks: readonly IFileChangePreviewHunk[]): IFileChangePreviewHunk | undefined {
	let best: IFileChangePreviewHunk | undefined;
	let bestScore = -1;
	for (const hunk of hunks) {
		const score = hunk.additions + hunk.deletions;
		if (score > bestScore) {
			best = hunk;
			bestScore = score;
		}
	}
	return best;
}

function clipLargePreview(lines: IFileChangePreviewLine[], max = FILE_CHANGE_PREVIEW_LARGE_MAX): IFileChangePreviewLine[] {
	if (lines.length <= max) {
		return lines;
	}
	const context = lines[0]?.kind === 'context' ? [lines[0]] : [];
	const rest = context.length ? lines.slice(1) : lines;
	const budget = Math.max(1, max - context.length);
	const deletes = rest.filter(line => line.kind === 'delete');
	const inserts = rest.filter(line => line.kind === 'insert');
	if (deletes.length && inserts.length) {
		const deleteCount = Math.min(deletes.length, Math.max(1, Math.floor(budget / 2)));
		const insertCount = Math.min(inserts.length, budget - deleteCount);
		return [...context, ...deletes.slice(0, deleteCount), ...inserts.slice(0, insertCount)];
	}
	return [...context, ...rest.slice(0, budget)];
}

function fullReplaceHunk(original: string[], modified: string[]): IFileChangePreviewHunk {
	const lines: IFileChangePreviewLine[] = [];
	for (let i = 0; i < original.length; i++) {
		lines.push({ kind: 'delete', lineNumber: i + 1, text: original[i] });
	}
	for (let i = 0; i < modified.length; i++) {
		lines.push({ kind: 'insert', lineNumber: i + 1, text: modified[i] });
	}
	return { lines, additions: modified.length, deletions: original.length };
}

function toLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const lines = splitLines(text);
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

const PATH_KEYS = ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath', 'relative_path', 'relativePath'];
const ORIGINAL_KEYS = ['old_string', 'oldString', 'old_text', 'oldText', 'original', 'old_str', 'oldStr'];
const MODIFIED_KEYS = ['new_string', 'newString', 'new_text', 'newText', 'contents', 'new_str', 'newStr'];
const DIFF_KEYS = ['diff', 'unifiedDiff', 'unified_diff', 'patch'];

export function fileChangeVerb(kind?: string, name?: string, title?: string): FileChangeVerb {
	const s = `${kind ?? ''} ${name ?? ''} ${title ?? ''}`.toLowerCase();
	if (/\b(delete|deleted|remove|removed)\b/.test(s)) {
		return 'Deleted';
	}
	if (/\b(create|created|write|wrote|new file)\b/.test(s) && !/\bedit(ed|ing)?\b/.test(s)) {
		return 'Created';
	}
	return 'Edited';
}

export function parseToolFileChange(source: {
	name?: string;
	title?: string;
	input?: string;
	output?: string;
	result?: unknown;
	path?: string;
}): IFileChangePreviewSource | undefined {
	const acc: {
		path?: string;
		original?: string;
		modified?: string;
		unifiedDiff?: string;
		additions?: number;
		deletions?: number;
	} = {};
	collectFileChange(source.input, acc);
	collectFileChange(source.output, acc);
	collectFileChange(source.result, acc);
	if (!acc.path) {
		acc.path = source.path;
	}
	if (!acc.path && (source.title || source.name)) {
		const fromTitle = (source.title || source.name || '').replace(/^(Edited|Created|Deleted|Wrote|Write|Edit)\s+/i, '').trim();
		if (fromTitle && (fromTitle.includes('/') || fromTitle.includes('\\') || /\.\w{1,8}$/.test(fromTitle))) {
			acc.path = fromTitle;
		}
	}
	if (!acc.path && acc.original === undefined && acc.modified === undefined && !acc.unifiedDiff) {
		return undefined;
	}
	return {
		path: acc.path,
		name: acc.path ? basename(acc.path) : undefined,
		verb: fileChangeVerb(source.name, source.title, acc.path),
		original: acc.original,
		modified: acc.modified,
		unifiedDiff: acc.unifiedDiff,
		additions: acc.additions,
		deletions: acc.deletions,
	};
}

function collectFileChange(value: unknown, acc: {
	path?: string;
	original?: string;
	modified?: string;
	unifiedDiff?: string;
	additions?: number;
	deletions?: number;
}): void {
	if (value === undefined || value === null) {
		return;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) {
			return;
		}
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				collectFileChange(JSON.parse(trimmed), acc);
				return;
			} catch {
				// Fall through and treat as a path or unified diff.
			}
		}
		if (trimmed.includes('@@ ') || trimmed.startsWith('diff ') || trimmed.startsWith('--- ')) {
			acc.unifiedDiff ??= trimmed;
			return;
		}
		if (!acc.path && (trimmed.includes('/') || trimmed.includes('\\') || /\.\w{1,8}$/.test(trimmed.split(/\s+/).pop() ?? ''))) {
			acc.path ??= trimmed.split(/\s+/).pop();
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectFileChange(item, acc);
		}
		return;
	}
	if (typeof value !== 'object') {
		return;
	}
	const o = value as Record<string, unknown>;
	const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
	if (type === 'diff' || ORIGINAL_KEYS.some(key => typeof o[key] === 'string') || MODIFIED_KEYS.some(key => typeof o[key] === 'string')) {
		acc.path ??= pickString(o, PATH_KEYS);
		acc.original ??= pickString(o, ORIGINAL_KEYS);
		acc.modified ??= pickString(o, [...MODIFIED_KEYS, 'content']);
		acc.unifiedDiff ??= pickString(o, DIFF_KEYS);
		if (typeof o.additions === 'number') {
			acc.additions = o.additions;
		}
		if (typeof o.deletions === 'number') {
			acc.deletions = o.deletions;
		}
	} else {
		acc.path ??= pickString(o, PATH_KEYS);
		acc.original ??= pickString(o, ORIGINAL_KEYS);
		acc.modified ??= pickString(o, MODIFIED_KEYS);
		acc.unifiedDiff ??= pickString(o, DIFF_KEYS);
		if (typeof o.content === 'string' && acc.modified === undefined && (type === 'write' || typeof o.path === 'string')) {
			acc.modified = o.content;
		}
	}
	for (const key of ['content', 'contents', 'result', 'output', 'diff']) {
		if (o[key] && typeof o[key] === 'object') {
			collectFileChange(o[key], acc);
		}
	}
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof o[key] === 'string' && o[key]) {
			return o[key] as string;
		}
	}
	return undefined;
}
