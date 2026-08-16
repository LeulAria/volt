/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Instant, model-free ghost text. This is what makes Tab feel like Cursor when the
 * network model is missing, slow, or still thinking.
 *
 * Priority:
 *   1. Clipboard - if the typed prefix is a prefix of (or a keyword before) copied code
 *   2. Nearby-line continuation - reuse the most recent line that starts the same way
 *   3. Recent-edit insertion - finish what the user just started typing
 *   4. Harvested patterns - e.g. `process.env['VSCODE_CWD']` -> `const CWD = process.env['VSCODE_CWD'];`
 */

import { IPredictionContext } from '../prediction.js';
import { postProcessInline } from './postProcess.js';

const MAX_CLIPBOARD_CHARS = 2_000;
const MAX_CLIPBOARD_LINES = 20;
const KEYWORD_PREFIX = /^(const|let|var|return|export|import|await|type|interface|class|function|async|if|for|while|switch|throw|new)\s*$/;

export function predictLocal(ctx: IPredictionContext): string | undefined {
	const candidates = [
		fromClipboard(ctx.linePrefix, ctx.clipboard),
		fromNearbyLine(ctx.linePrefix, ctx.prefix),
		fromRecentEdit(ctx.linePrefix, ctx.recentEdits.at(-1)?.inserted),
		fromHarvestedPattern(ctx.linePrefix, ctx.prefix),
	];
	for (const raw of candidates) {
		if (!raw) {
			continue;
		}
		const cleaned = postProcessInline({ raw, linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix });
		if (cleaned) {
			return cleaned;
		}
	}
	return undefined;
}

/** Clipboard wins when it continues what the user is already typing. */
export function fromClipboard(linePrefix: string, clipboard: string | undefined): string | undefined {
	if (!clipboard) {
		return undefined;
	}
	const clip = clipboard.replace(/\r\n/g, '\n').trim();
	if (!clip || clip.length > MAX_CLIPBOARD_CHARS || clip.split('\n').length > MAX_CLIPBOARD_LINES) {
		return undefined;
	}
	if (!looksLikeCode(clip)) {
		return undefined;
	}

	const typed = linePrefix.trimStart();
	if (!typed) {
		return clip;
	}

	// Typed text is a prefix of the clipboard (the Cursor "I just copied this" case).
	if (startsWithIgnoreIndent(clip, typed)) {
		return remainderAfterPrefix(clip, typed);
	}

	// `const ` + clipboard that is already a full statement (`CWD = ...` or `const CWD = ...`).
	if (KEYWORD_PREFIX.test(typed)) {
		if (startsWithIgnoreIndent(clip, typed)) {
			return remainderAfterPrefix(clip, typed);
		}
		return clip.startsWith(' ') ? clip : ` ${clip}`;
	}

	return undefined;
}

/** Most recent earlier line that starts with the typed prefix. */
export function fromNearbyLine(linePrefix: string, prefix: string): string | undefined {
	const typed = linePrefix.trimStart();
	if (typed.length < 2) {
		return undefined;
	}
	const lines = prefix.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trimStart();
		if (line.startsWith(typed) && line.length > typed.length + 1) {
			return line.slice(typed.length);
		}
	}
	return undefined;
}

export function fromRecentEdit(linePrefix: string, inserted: string | undefined): string | undefined {
	if (!inserted) {
		return undefined;
	}
	const text = inserted.replace(/\r\n/g, '\n').trim();
	if (!text || text.length > 400 || !looksLikeCode(text)) {
		return undefined;
	}
	const typed = linePrefix.trimStart();
	if (typed && startsWithIgnoreIndent(text, typed)) {
		return remainderAfterPrefix(text, typed);
	}
	return undefined;
}

const ENV_ACCESS = /process\.env\[['"]([A-Z0-9_]+)['"]\]/g;

/**
 * Reconstructs a likely next statement from nearby identifiers.
 * `delete process.env['VSCODE_CWD']` + typed `const` -> ` CWD = process.env['VSCODE_CWD'];`
 */
export function fromHarvestedPattern(linePrefix: string, prefix: string): string | undefined {
	const matches = [...prefix.matchAll(ENV_ACCESS)];
	if (!matches.length) {
		return undefined;
	}
	const key = matches[matches.length - 1][1];
	const short = key.includes('_') ? key.slice(key.lastIndexOf('_') + 1) : key;
	const assignment = `${short} = process.env['${key}'];`;
	const full = `const ${assignment}`;
	const typed = linePrefix.trimStart();
	if (!typed) {
		return full;
	}
	if (KEYWORD_PREFIX.test(typed) && /^(const|let|var)\s*$/.test(typed)) {
		return ` ${assignment}`;
	}
	if (startsWithIgnoreIndent(full, typed)) {
		return remainderAfterPrefix(full, typed);
	}
	return undefined;
}

function looksLikeCode(text: string): boolean {
	if (/^https?:\/\//i.test(text) && !text.includes('\n')) {
		return false;
	}
	return /[={};()[\]<>]|=>|\b(const|let|var|function|class|import|export|return|if|for)\b/.test(text)
		|| /^[\w$.]+\(/.test(text);
}

function startsWithIgnoreIndent(text: string, prefix: string): boolean {
	return text.trimStart().startsWith(prefix);
}

function remainderAfterPrefix(text: string, prefix: string): string {
	const trimmed = text.trimStart();
	return trimmed.slice(prefix.length);
}
