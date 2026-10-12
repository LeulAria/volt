/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Line diffs for the apps' diff views: a patience diff (unique lines as anchors, an LCS table
// between them while it is small) that stays fast and light on big files, and a parser for the
// unified diffs the agents' edit blocks carry.

export type DiffLineKind = 'context' | 'add' | 'del';

export interface IDiffLine {
	readonly kind: DiffLineKind;
	readonly text: string;
	/** 1-based, on the old side (context and deletions). */
	readonly oldLine?: number;
	/** 1-based, on the new side (context and additions). */
	readonly newLine?: number;
}

export interface IDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	/** The `@@` line's trailing text (the enclosing function, when git gives it). */
	readonly header?: string;
	readonly lines: readonly IDiffLine[];
}

export interface IFileDiff {
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly hunks: readonly IDiffHunk[];
	readonly additions: number;
	readonly deletions: number;
	readonly binary?: boolean;
}

type Op = { readonly kind: DiffLineKind; readonly a: number; readonly b: number };

const TABLE_LIMIT = 2_500_000;

function splitLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** The edit script turning `a[a0..a1)` into `b[b0..b1)`, appended to `out`. */
function diffRange(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, out: Op[]): void {
	// Common prefix and suffix first: most edits touch a few lines of a long file.
	while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
		out.push({ kind: 'context', a: a0++, b: b0++ });
	}
	const tail: Op[] = [];
	while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
		tail.push({ kind: 'context', a: --a1, b: --b1 });
	}
	const n = a1 - a0;
	const m = b1 - b0;
	if (!n || !m) {
		for (let i = a0; i < a1; i++) {
			out.push({ kind: 'del', a: i, b: b0 });
		}
		for (let j = b0; j < b1; j++) {
			out.push({ kind: 'add', a: a1, b: j });
		}
	} else if ((n + 1) * (m + 1) <= TABLE_LIMIT) {
		lcsTable(a, b, a0, a1, b0, b1, out);
	} else {
		const anchors = uniqueAnchors(a, b, a0, a1, b0, b1);
		if (!anchors.length) {
			for (let i = a0; i < a1; i++) {
				out.push({ kind: 'del', a: i, b: b0 });
			}
			for (let j = b0; j < b1; j++) {
				out.push({ kind: 'add', a: a1, b: j });
			}
		} else {
			let pa = a0;
			let pb = b0;
			for (const [ia, ib] of anchors) {
				diffRange(a, b, pa, ia, pb, ib, out);
				out.push({ kind: 'context', a: ia, b: ib });
				pa = ia + 1;
				pb = ib + 1;
			}
			diffRange(a, b, pa, a1, pb, b1, out);
		}
	}
	for (let i = tail.length - 1; i >= 0; i--) {
		out.push(tail[i]);
	}
}

function lcsTable(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, out: Op[]): void {
	const n = a1 - a0;
	const m = b1 - b0;
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] = a[a0 + i] === b[b0 + j]
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[a0 + i] === b[b0 + j]) {
			out.push({ kind: 'context', a: a0 + i++, b: b0 + j++ });
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			out.push({ kind: 'del', a: a0 + i++, b: b0 + j });
		} else {
			out.push({ kind: 'add', a: a0 + i, b: b0 + j++ });
		}
	}
	while (i < n) {
		out.push({ kind: 'del', a: a0 + i++, b: b1 });
	}
	while (j < m) {
		out.push({ kind: 'add', a: a1, b: b0 + j++ });
	}
}

/** Lines that occur once on each side, in an order both sides agree on (longest increasing run). */
function uniqueAnchors(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
	const counts = new Map<string, { ca: number; cb: number; ia: number; ib: number }>();
	for (let i = a0; i < a1; i++) {
		const entry = counts.get(a[i]) ?? { ca: 0, cb: 0, ia: i, ib: -1 };
		entry.ca++;
		entry.ia = i;
		counts.set(a[i], entry);
	}
	for (let j = b0; j < b1; j++) {
		const entry = counts.get(b[j]);
		if (entry) {
			entry.cb++;
			entry.ib = j;
		}
	}
	const pairs: [number, number][] = [];
	for (const entry of counts.values()) {
		if (entry.ca === 1 && entry.cb === 1) {
			pairs.push([entry.ia, entry.ib]);
		}
	}
	pairs.sort((x, y) => x[0] - y[0]);
	// Longest increasing subsequence on the b side (patience sorting).
	const tails: number[] = [];
	const prev = new Int32Array(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pairs[tails[mid]][1] < pairs[k][1]) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		prev[k] = lo > 0 ? tails[lo - 1] : -1;
		tails[lo] = k;
	}
	const result: [number, number][] = [];
	for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) {
		result.push(pairs[k]);
	}
	return result.reverse();
}

/** The hunks turning `before` into `after`, with `context` unchanged lines around each change. */
export function diffText(before: string, after: string, context = 3): IFileDiff {
	const a = splitLines(before);
	const b = splitLines(after);
	const ops: Op[] = [];
	diffRange(a, b, 0, a.length, 0, b.length, ops);
	const hunks: IDiffHunk[] = [];
	let additions = 0;
	let deletions = 0;
	let k = 0;
	while (k < ops.length) {
		if (ops[k].kind === 'context') {
			k++;
			continue;
		}
		const start = Math.max(0, k - context);
		let end = k;
		// Extend through changes whose gap of unchanged lines is short enough to merge.
		while (end < ops.length) {
			if (ops[end].kind !== 'context') {
				end++;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run].kind === 'context') {
				run++;
			}
			if (end + run >= ops.length || run > context * 2) {
				end = Math.min(ops.length, end + context);
				break;
			}
			end += run;
		}
		const lines: IDiffLine[] = [];
		for (let i = start; i < end; i++) {
			const op = ops[i];
			if (op.kind === 'context') {
				lines.push({ kind: 'context', text: a[op.a], oldLine: op.a + 1, newLine: op.b + 1 });
			} else if (op.kind === 'del') {
				deletions++;
				lines.push({ kind: 'del', text: a[op.a], oldLine: op.a + 1 });
			} else {
				additions++;
				lines.push({ kind: 'add', text: b[op.b], newLine: op.b + 1 });
			}
		}
		const first = ops[start];
		const oldLines = lines.filter(l => l.kind !== 'add').length;
		const newLines = lines.filter(l => l.kind !== 'del').length;
		hunks.push({ oldStart: oldLines ? first.a + 1 : first.a, oldLines, newStart: newLines ? first.b + 1 : first.b, newLines, lines });
		k = end;
	}
	return { hunks, additions, deletions };
}

/** Parses a unified diff (one or more files, git or plain). */
export function parseUnifiedDiff(diff: string): IFileDiff[] {
	const files: IFileDiff[] = [];
	let current: { oldPath?: string; newPath?: string; hunks: IDiffHunk[]; additions: number; deletions: number; binary?: boolean } | undefined;
	let hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; header?: string; lines: IDiffLine[] } | undefined;
	let oldNo = 0;
	let newNo = 0;
	const flush = () => {
		if (current && (current.hunks.length || current.binary || current.oldPath || current.newPath)) {
			files.push(current);
		}
	};
	const ensureFile = () => {
		if (!current) {
			current = { hunks: [], additions: 0, deletions: 0 };
		}
		return current;
	};
	for (const raw of diff.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.startsWith('diff --git ')) {
			flush();
			current = { hunks: [], additions: 0, deletions: 0 };
			hunk = undefined;
			continue;
		}
		const hunkDone = !hunk || (oldNo >= hunk.oldStart + hunk.oldLines && newNo >= hunk.newStart + hunk.newLines);
		if (line.startsWith('--- ') && hunkDone) {
			const file = ensureFile();
			if (file.hunks.length) {
				flush();
				current = { hunks: [], additions: 0, deletions: 0 };
			}
			const path = line.slice(4).replace(/^a\//, '').split('\t')[0];
			current!.oldPath = path === '/dev/null' ? undefined : path;
			hunk = undefined;
			continue;
		}
		if (line.startsWith('+++ ') && (!hunk || hunkDone)) {
			const path = line.slice(4).replace(/^b\//, '').split('\t')[0];
			ensureFile().newPath = path === '/dev/null' ? undefined : path;
			continue;
		}
		if (line.startsWith('Binary files ')) {
			ensureFile().binary = true;
			continue;
		}
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
		if (header) {
			hunk = { oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]), ...(header[5] ? { header: header[5] } : {}), lines: [] };
			ensureFile().hunks.push(hunk);
			oldNo = hunk.oldStart;
			newNo = hunk.newStart;
			continue;
		}
		if (!hunk) {
			continue;
		}
		const file = ensureFile();
		if (line.startsWith('+')) {
			hunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newNo++ });
			file.additions++;
		} else if (line.startsWith('-')) {
			hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldNo++ });
			file.deletions++;
		} else if (line.startsWith(' ') || line === '') {
			if (hunkDone) {
				continue;
			}
			hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
		}
	}
	flush();
	return files;
}

/** Words that changed between a deleted and an added line, as [start, end) columns on each. */
export function wordChanges(before: string, after: string): { readonly del: readonly (readonly [number, number])[]; readonly add: readonly (readonly [number, number])[] } {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) {
		start++;
	}
	let endA = before.length;
	let endB = after.length;
	while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
		endA--;
		endB--;
	}
	// Whole-line rewrites read better without a highlight.
	if ((endA - start) > before.length * 0.8 && (endB - start) > after.length * 0.8) {
		return { del: [], add: [] };
	}
	return { del: endA > start ? [[start, endA]] : [], add: endB > start ? [[start, endB]] : [] };
}
