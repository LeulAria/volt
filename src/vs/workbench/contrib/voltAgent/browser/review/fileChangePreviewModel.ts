/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../../base/common/path.js';
import { splitLines } from '../../../../../base/common/strings.js';
import { URI } from '../../../../../base/common/uri.js';
import { linesDiffComputers } from '../../../../../editor/common/diff/linesDiffComputers.js';

/** Show the whole change when added+removed lines stay under this. */
export const FILE_CHANGE_PREVIEW_FULL_LIMIT = 12;
/** Large edits only show a short review slice. */
export const FILE_CHANGE_PREVIEW_LARGE_MAX = 5;
/** Expanded file cards show a longer review slice for big edits. */
export const FILE_CHANGE_PREVIEW_EXPANDED_MAX = 40;
/** Context lines around the change in the collapsed card. */
export const FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED = 1;
/** Context lines around the change after the user expands the card. */
export const FILE_CHANGE_PREVIEW_CONTEXT_EXPANDED = 3;

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
	readonly expandable: boolean;
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
	readonly contextLines?: number;
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
 * File diffs render as the compact filename card. Accordion stays available
 * when a surface explicitly prefers the high-level `Edited file +2 -1` row.
 */
export function chooseFileChangeDiffStyle(context: IFileChangeDiffStyleContext): FileChangeDiffStyle {
	return context.preferred ?? 'card';
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
	const contextLines = options?.contextLines ?? FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED;
	const hunks = hunksFromSource(source, contextLines);
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
		expandable: truncated || previewCanExpand(source, lines),
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

const CSS_SNIPPET_HOSTS = new Set(['html', 'xml', 'xhtml', 'plaintext', 'unknown']);
const CSS_PROP_RE = /^\s*[\w-]+\s*:\s*[^;{]+;?\s*$/;
const CSS_RULE_RE = /^\s*(?:[.#@][\w-]|\}|\{)/;
const JS_SNIPPET_RE = /\b(?:function|const|let|var|import|export|=>|document\.|window\.)\b/;

/**
 * Keep the file-extension language so the preview uses the same highlighter
 * as the open editor (`index.html` stays HTML, not standalone CSS).
 */
export function guessPreviewLanguage(filepathLanguage: string | undefined, _lines?: readonly string[]): string | undefined {
	return filepathLanguage;
}

export interface IPreviewTokenizerSeed {
	readonly language: string;
	readonly prefixLines: readonly string[];
}

/**
 * Pick the highlighter for a review slice. Host files keep their extension
 * (`.html` stays HTML in the header), but CSS/JS snippets inside them render
 * with the embedded language Monaco uses in the real editor.
 */
export function previewTokenizerSeed(filepathLanguage: string | undefined, lines: readonly string[]): IPreviewTokenizerSeed {
	const language = filepathLanguage && filepathLanguage !== 'unknown' ? filepathLanguage : PLAINTEXT_FALLBACK;
	const sample = lines.map(line => line.trim()).filter(Boolean).slice(0, 12);
	if (looksLikeCss(sample)) {
		if (language === 'css' || language === 'scss' || language === 'less') {
			return { language, prefixLines: ['body {'] };
		}
		if (CSS_SNIPPET_HOSTS.has(language)) {
			return { language: 'css', prefixLines: ['body {'] };
		}
	}
	if (CSS_SNIPPET_HOSTS.has(language) && looksLikeJavaScript(sample)) {
		return { language: 'javascript', prefixLines: ['<script>'] };
	}
	return { language, prefixLines: [] };
}

export function wrapPreviewDocument(text: string, prefixLines: readonly string[]): string {
	if (!prefixLines.length) {
		return text;
	}
	const prefix = prefixLines.join('\n');
	return text.length ? `${prefix}\n${text}` : prefix;
}

const PLAINTEXT_FALLBACK = 'plaintext';

function looksLikeCss(lines: readonly string[]): boolean {
	if (lines.length < 2) {
		return false;
	}
	const hits = lines.filter(line => CSS_PROP_RE.test(line) || CSS_RULE_RE.test(line)).length;
	return hits >= Math.max(2, Math.ceil(lines.length * 0.5));
}

function looksLikeJavaScript(lines: readonly string[]): boolean {
	if (!lines.length || looksLikeCss(lines)) {
		return false;
	}
	return lines.filter(line => JS_SNIPPET_RE.test(line)).length >= 1;
}

/** Split preview lines into the original/modified documents the Monaco diff editor renders. */
export interface IFileChangeOpenSelectionRange {
	readonly startLineNumber: number;
	readonly endLineNumber: number;
}

/** Line range to reveal in the on-disk file when opening from a file-change card. */
export function fileChangeOpenSelectionRange(source?: IFileChangePreviewSource, previewLines?: readonly IFileChangePreviewLine[]): IFileChangeOpenSelectionRange | undefined {
	const fromPreview = rangeFromChangedPreviewLines(previewLines);
	if (fromPreview) {
		return fromPreview;
	}
	if (!source) {
		return undefined;
	}
	if (source.unifiedDiff) {
		const fromPatch = rangeFromChangedPreviewLines(flattenHunks(parseUnifiedDiff(source.unifiedDiff)));
		if (fromPatch) {
			return fromPatch;
		}
	}
	if (!source.unifiedDiff) {
		const fromContents = rangeFromOriginalModified(source);
		if (fromContents) {
			return fromContents;
		}
	}
	const fromHunks = rangeFromChangedPreviewLines(flattenHunks(hunksFromSource(source, 0)));
	if (fromHunks) {
		return fromHunks;
	}
	if (source.lines?.length) {
		return rangeFromChangedPreviewLines(source.lines);
	}
	return undefined;
}

function rangeFromOriginalModified(source: IFileChangePreviewSource): IFileChangeOpenSelectionRange | undefined {
	if (source.original === undefined && source.modified === undefined) {
		return undefined;
	}
	const original = toLines(source.original ?? '');
	const modified = toLines(source.modified ?? '');
	if (!original.length && modified.length) {
		return { startLineNumber: 1, endLineNumber: modified.length };
	}
	if (!original.length && !modified.length) {
		return undefined;
	}
	try {
		const diff = linesDiffComputers.getDefault().computeDiff(original, modified, DIFF_OPTIONS);
		if (!diff.changes.length) {
			return undefined;
		}
		let start = Number.POSITIVE_INFINITY;
		let end = 0;
		for (const change of diff.changes) {
			if (change.modified.length > 0) {
				start = Math.min(start, change.modified.startLineNumber);
				end = Math.max(end, change.modified.endLineNumberExclusive - 1);
				continue;
			}
			if (change.original.length > 0) {
				const anchor = Math.min(Math.max(1, change.modified.startLineNumber), Math.max(modified.length, 1));
				start = Math.min(start, anchor);
				end = Math.max(end, anchor);
			}
		}
		if (!Number.isFinite(start) || end < 1) {
			return undefined;
		}
		return { startLineNumber: start, endLineNumber: Math.max(start, end) };
	} catch {
		return undefined;
	}
}

function rangeFromChangedPreviewLines(lines?: readonly IFileChangePreviewLine[]): IFileChangeOpenSelectionRange | undefined {
	if (!lines?.length) {
		return undefined;
	}
	const inserts = lines.filter(line => line.kind === 'insert').map(line => line.lineNumber).filter(n => n > 0);
	if (inserts.length) {
		return { startLineNumber: Math.min(...inserts), endLineNumber: Math.max(...inserts) };
	}
	const deletes = lines.filter(line => line.kind === 'delete').map(line => line.lineNumber).filter(n => n > 0);
	if (deletes.length) {
		return { startLineNumber: Math.min(...deletes), endLineNumber: Math.max(...deletes) };
	}
	return undefined;
}

export function fileChangePreviewDocuments(lines: readonly IFileChangePreviewLine[]): {
	original: string;
	modified: string;
	originalLineNumbers: number[];
	modifiedLineNumbers: number[];
} {
	const original: IFileChangePreviewLine[] = [];
	const modified: IFileChangePreviewLine[] = [];
	for (const line of lines) {
		if (line.kind !== 'insert') {
			original.push(line);
		}
		if (line.kind !== 'delete') {
			modified.push(line);
		}
	}
	return {
		original: original.map(line => line.text).join('\n'),
		modified: modified.map(line => line.text).join('\n'),
		originalLineNumbers: original.map(line => line.lineNumber),
		modifiedLineNumbers: modified.map(line => line.lineNumber),
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

function hunksFromSource(source: IFileChangePreviewSource, contextLines = FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED): IFileChangePreviewHunk[] {
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
		return hunksFromContents(toLines(source.original ?? ''), toLines(source.modified ?? ''), contextLines);
	}
	return [];
}

function hunksFromContents(original: string[], modified: string[], contextLines = FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED): IFileChangePreviewHunk[] {
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
			pushContextLines(lines, original, modified, change.original.startLineNumber, change.modified.startLineNumber, -contextLines);
			for (let n = change.original.startLineNumber; n < change.original.endLineNumberExclusive; n++) {
				lines.push({ kind: 'delete', lineNumber: n, text: original[n - 1] ?? '' });
			}
			for (let n = change.modified.startLineNumber; n < change.modified.endLineNumberExclusive; n++) {
				lines.push({ kind: 'insert', lineNumber: n, text: modified[n - 1] ?? '' });
			}
			pushContextLines(lines, original, modified, change.original.endLineNumberExclusive, change.modified.endLineNumberExclusive, contextLines);
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

function pushContextLines(
	lines: IFileChangePreviewLine[],
	original: string[],
	modified: string[],
	originalAnchor: number,
	modifiedAnchor: number,
	delta: number,
): void {
	if (delta === 0) {
		return;
	}
	const add = (originalLine: number, modifiedLine: number) => {
		if (modifiedLine >= 1 && modifiedLine <= modified.length) {
			lines.push({ kind: 'context', lineNumber: modifiedLine, text: modified[modifiedLine - 1] });
			return;
		}
		if (originalLine >= 1 && originalLine <= original.length) {
			lines.push({ kind: 'context', lineNumber: originalLine, text: original[originalLine - 1] });
		}
	};
	if (delta < 0) {
		for (let i = Math.abs(delta); i >= 1; i--) {
			add(originalAnchor - i, modifiedAnchor - i);
		}
		return;
	}
	for (let i = 0; i < delta; i++) {
		add(originalAnchor + i, modifiedAnchor + i);
	}
}

function flattenHunks(hunks: readonly IFileChangePreviewHunk[]): IFileChangePreviewLine[] {
	const lines: IFileChangePreviewLine[] = [];
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			const last = lines.at(-1);
			if (last && last.kind === 'context' && line.kind === 'context' && last.lineNumber === line.lineNumber && last.text === line.text) {
				continue;
			}
			lines.push(line);
		}
	}
	return lines;
}

function previewCanExpand(source: IFileChangePreviewSource, lines: readonly IFileChangePreviewLine[]): boolean {
	if (!lines.length || source.original === undefined && source.modified === undefined) {
		return false;
	}
	const last = Math.max(toLines(source.original ?? '').length, toLines(source.modified ?? '').length);
	return lines[0].lineNumber > 1 || lines[lines.length - 1].lineNumber < last;
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
