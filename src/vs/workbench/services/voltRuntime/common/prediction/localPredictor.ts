/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
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
import { KEYWORDS } from './contextWindow.js';
import { postProcessInline } from './postProcess.js';
import { inlineWritingKind } from './predictionPrompt.js';

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

/** A local guess and how sure of it the predictor is, 0..1. */
export interface ILocalPrediction {
	readonly text: string;
	readonly confidence: number;
}

/** At or above this, a local guess is shown with no model call at all. */
export const LOCAL_SURE = 0.85;
/** At or above this, a local guess is shown when the model is not asked or has nothing. */
export const LOCAL_PLAUSIBLE = 0.5;

/**
 * The best local guess with a confidence, after the same cleanup as a model reply. A counting
 * run of lines and a clipboard the line is already typing out are near-certain; a line that
 * starts like an earlier one is a fair guess; a recent edit or a harvested pattern a weak one.
 */
export function predictLocalScored(ctx: IPredictionContext): ILocalPrediction | undefined {
	const typed = ctx.linePrefix.trimStart();
	const candidates: ILocalPrediction[] = [];
	const sequence = fromSequence(ctx.prefix, ctx.linePrefix);
	if (sequence) {
		candidates.push({ text: sequence.text, confidence: sequence.lines >= 3 ? 0.92 : 0.6 });
	}
	const clip = clipboardMatch(ctx.linePrefix, ctx.clipboard);
	if (clip) {
		// Typing out the start of what was copied. Sure once the typed part names something
		// (`const total = `), not just a keyword every line starts with (`import { `).
		const named = (typed.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).some(name => !KEYWORDS.has(name.toLowerCase()));
		const confidence = clip.kind === 'prefix' ? (typed.length >= 6 && named ? 0.9 : typed.length >= 2 ? 0.6 : 0.3) : 0.45;
		candidates.push({ text: clip.text, confidence });
	}
	const line = fromNearbyLine(ctx.linePrefix, ctx.prefix);
	if (line) {
		candidates.push({ text: line, confidence: typed.length >= 8 ? 0.6 : 0.4 });
	}
	const edit = fromRecentEdit(ctx.linePrefix, ctx.recentEdits.at(-1)?.inserted);
	if (edit) {
		candidates.push({ text: edit, confidence: 0.55 });
	}
	const harvested = fromHarvestedPattern(ctx.linePrefix, ctx.prefix);
	if (harvested) {
		candidates.push({ text: harvested, confidence: 0.4 });
	}
	const writing = inlineWritingKind(ctx.languageId, ctx.linePrefix);
	let best: ILocalPrediction | undefined;
	for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
		if (best && best.confidence >= candidate.confidence) {
			break;
		}
		const text = postProcessInline({ raw: candidate.text, linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix, prefix: ctx.prefix, suffix: ctx.suffix, writing });
		if (text) {
			best = { text, confidence: candidate.confidence };
		}
	}
	return best;
}

/**
 * The next line of a run of lines that differ only in their counting numbers:
 * `a[0] = x0;`, `a[1] = x1;` -> `a[2] = x2;`. At least two lines right above the cursor, same
 * shape, every number moving by its own fixed step from one line to the next, and the line being
 * typed (if anything) the start of the next one. `lines` is the length of the run.
 */
export function fromSequence(prefix: string, linePrefix: string): { text: string; lines: number } | undefined {
	const above = prefix.split('\n');
	above.pop();
	const shapes: { shape: string; numbers: string[] }[] = [];
	for (let i = above.length - 1; i >= 0 && shapes.length < 8; i--) {
		const line = above[i];
		if (!line.trim()) {
			break;
		}
		const numbers = line.match(/\d+/g) ?? [];
		if (!numbers.length) {
			break;
		}
		const shape = line.replace(/\d+/g, '#');
		if (shapes.length && shapes[shapes.length - 1].shape !== shape) {
			break;
		}
		shapes.push({ shape, numbers });
	}
	if (shapes.length < 2) {
		return undefined;
	}
	shapes.reverse();
	const count = shapes[0].numbers.length;
	const steps: number[] = [];
	for (let k = 0; k < count; k++) {
		const step = Number(shapes[1].numbers[k]) - Number(shapes[0].numbers[k]);
		for (let i = 2; i < shapes.length; i++) {
			if (Number(shapes[i].numbers[k]) - Number(shapes[i - 1].numbers[k]) !== step) {
				return undefined;
			}
		}
		steps.push(step);
	}
	if (steps.every(step => step === 0) || steps.some(step => Math.abs(step) > 1000)) {
		return undefined;
	}
	const last = shapes[shapes.length - 1].numbers;
	// Keep zero padding: `07` -> `08`. A count running below zero has ended.
	const values = last.map((digits, i) => String(Number(digits) + steps[i]).padStart(digits.startsWith('0') ? digits.length : 0, '0'));
	if (values.some(value => value.startsWith('-'))) {
		return undefined;
	}
	let k = 0;
	const next = shapes[0].shape.replace(/#/g, () => values[k++]);
	if (!next.startsWith(linePrefix) || next.length <= linePrefix.length) {
		return undefined;
	}
	return { text: next.slice(linePrefix.length), lines: shapes.length };
}

/** How the clipboard continues the line: the line types out its start, or a keyword comes before it. */
function clipboardMatch(linePrefix: string, clipboard: string | undefined): { text: string; kind: 'prefix' | 'keyword' } | undefined {
	const text = fromClipboard(linePrefix, clipboard);
	if (text === undefined) {
		return undefined;
	}
	const typed = linePrefix.trimStart();
	const clip = clipboard!.replace(/\r\n/g, '\n').trim();
	return { text, kind: typed && startsWithIgnoreIndent(clip, typed) ? 'prefix' : 'keyword' };
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
