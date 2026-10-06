/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One line of a hunk, numbered on the side(s) it exists on. */
export interface IPrDiffLine {
	readonly kind: 'add' | 'del' | 'context';
	readonly text: string;
	readonly oldLine?: number;
	readonly newLine?: number;
}

export interface IPrDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	/** The text after the second `@@` (often the enclosing function). */
	readonly section: string;
	/** Unchanged lines between the previous hunk (or the file's start) and this one. */
	readonly skippedBefore: number;
	readonly lines: readonly IPrDiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** GitHub's `patch` field (hunks only, no file header) as numbered lines. */
export function parseUnifiedPatch(patch: string): IPrDiffHunk[] {
	const hunks: IPrDiffHunk[] = [];
	let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; skippedBefore: number; lines: IPrDiffLine[] } | undefined;
	let oldLine = 0;
	let newLine = 0;
	let previousOldEnd = 1;
	for (const raw of patch.split('\n')) {
		const header = HUNK_HEADER.exec(raw);
		if (header) {
			const oldStart = Number(header[1]);
			const oldLines = header[2] === undefined ? 1 : Number(header[2]);
			const newStart = Number(header[3]);
			const newLines = header[4] === undefined ? 1 : Number(header[4]);
			// A new file starts at -0,0: nothing was skipped.
			const skippedBefore = oldLines === 0 && oldStart === 0 ? 0 : Math.max(0, oldStart - previousOldEnd);
			current = { oldStart, oldLines, newStart, newLines, section: header[5].trim(), skippedBefore, lines: [] };
			hunks.push(current);
			oldLine = oldStart;
			newLine = newStart;
			previousOldEnd = oldStart + oldLines;
			continue;
		}
		if (!current) {
			continue;
		}
		if (raw.startsWith('\\')) {
			// "\ No newline at end of file"
			continue;
		}
		const marker = raw.charAt(0);
		const text = raw.slice(1);
		if (marker === '+') {
			current.lines.push({ kind: 'add', text, newLine: newLine++ });
		} else if (marker === '-') {
			current.lines.push({ kind: 'del', text, oldLine: oldLine++ });
		} else if (marker === ' ' || raw === '') {
			// The patch may end with a newline: a trailing empty string past the hunk is not a line.
			if (raw === '' && current.lines.length >= hunkLength(current)) {
				continue;
			}
			current.lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
		}
	}
	return hunks;
}

function hunkLength(hunk: { oldLines: number; newLines: number; lines: readonly IPrDiffLine[] }): number {
	// Every line is on the old side, the new side, or both: the hunk is complete once both counts are met.
	let old = 0;
	let next = 0;
	for (const line of hunk.lines) {
		if (line.kind !== 'add') {
			old++;
		}
		if (line.kind !== 'del') {
			next++;
		}
	}
	return old >= hunk.oldLines && next >= hunk.newLines ? hunk.lines.length : Number.MAX_SAFE_INTEGER;
}

/** The lines a selection spans on the new side (or old, for removed lines), for "ask the agent". */
export function lineRange(lines: readonly IPrDiffLine[]): { readonly start: number; readonly end: number; readonly side: 'new' | 'old' } | undefined {
	const numbers = lines.map(line => line.newLine).filter((value): value is number => value !== undefined);
	if (numbers.length) {
		return { start: Math.min(...numbers), end: Math.max(...numbers), side: 'new' };
	}
	const old = lines.map(line => line.oldLine).filter((value): value is number => value !== undefined);
	return old.length ? { start: Math.min(...old), end: Math.max(...old), side: 'old' } : undefined;
}
