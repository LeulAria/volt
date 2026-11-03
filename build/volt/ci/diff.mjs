/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Unified diff parsing shared by the lint ratchet (lintDiff.mjs, biomeDiff.mjs) and the AI review
// (review/). Works on one file's patch, as GitHub's pull request files API returns it, or on the
// output of `git diff` for many files.

/**
 * @typedef {{ kind: '+' | '-' | ' ', text: string, oldLine?: number, newLine?: number }} DiffLine
 * @typedef {{ oldStart: number, newStart: number, header: string, lines: DiffLine[] }} Hunk
 */

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses one file's patch (the part from the first `@@` on).
 * @param {string} patch
 * @returns {Hunk[]}
 */
export function parsePatch(patch) {
	/** @type {Hunk[]} */
	const hunks = [];
	/** @type {Hunk | undefined} */
	let hunk;
	let oldLine = 0;
	let newLine = 0;
	for (const raw of patch.split('\n')) {
		const header = hunkHeader.exec(raw);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			hunk = { oldStart: oldLine, newStart: newLine, header: header[5].trim(), lines: [] };
			hunks.push(hunk);
			continue;
		}
		if (!hunk || raw.startsWith('\\')) {
			continue; // file headers before the first hunk, "\ No newline at end of file"
		}
		const kind = raw[0];
		const text = raw.slice(1);
		if (kind === '+') {
			hunk.lines.push({ kind, text, newLine: newLine++ });
		} else if (kind === '-') {
			hunk.lines.push({ kind, text, oldLine: oldLine++ });
		} else if (kind === ' ' || raw === '') {
			// An empty line inside a hunk is a context line whose leading space was trimmed.
			hunk.lines.push({ kind: ' ', text, oldLine: oldLine++, newLine: newLine++ });
		}
	}
	return hunks;
}

/**
 * Lines of the new file that the patch added.
 * @param {Hunk[]} hunks
 * @returns {Set<number>}
 */
export function addedLines(hunks) {
	const lines = new Set();
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.kind === '+' && line.newLine !== undefined) {
				lines.add(line.newLine);
			}
		}
	}
	return lines;
}

/**
 * Lines a pull request review comment can point at: GitHub accepts any line shown in the diff,
 * on the new side (RIGHT: added and context lines) or the old side (LEFT: removed lines).
 * @param {Hunk[]} hunks
 * @returns {{ right: Set<number>, left: Set<number> }}
 */
export function commentableLines(hunks) {
	const right = new Set();
	const left = new Set();
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.kind === '-') {
				left.add(/** @type {number} */(line.oldLine));
			} else {
				right.add(/** @type {number} */(line.newLine));
			}
		}
	}
	return { right, left };
}

/**
 * The hunk index each new-side line belongs to, so a multi-line suggestion can be kept inside one hunk.
 * @param {Hunk[]} hunks
 * @returns {Map<number, number>}
 */
export function hunkOfNewLine(hunks) {
	const map = new Map();
	hunks.forEach((hunk, index) => {
		for (const line of hunk.lines) {
			if (line.newLine !== undefined) {
				map.set(line.newLine, index);
			}
		}
	});
	return map;
}

/**
 * Splits `git diff` output into one patch per new path (the old path for deletions).
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function splitGitDiff(output) {
	/** @type {Map<string, string>} */
	const patches = new Map();
	let current = '';
	/** @type {string[]} */
	let buffer = [];
	let oldPath = '';
	const flush = () => {
		if (current) {
			patches.set(current, buffer.join('\n'));
		}
		buffer = [];
	};
	for (const line of output.split('\n')) {
		if (line.startsWith('diff --git ')) {
			flush();
			current = '';
			oldPath = '';
			continue;
		}
		if (line.startsWith('--- ') && !buffer.length) {
			oldPath = line === '--- /dev/null' ? '' : unquote(line.slice(4)).replace(/^a\//, '');
			continue;
		}
		if (line.startsWith('+++ ') && !buffer.length) {
			current = line === '+++ /dev/null' ? oldPath : unquote(line.slice(4)).replace(/^b\//, '');
			continue;
		}
		if (current || buffer.length || hunkHeader.test(line)) {
			buffer.push(line);
		}
	}
	flush();
	return patches;
}

/**
 * Git quotes paths with unusual characters ("a/sp\303\244ce.ts").
 * @param {string} path
 */
function unquote(path) {
	if (!path.startsWith('"')) {
		return path;
	}
	const bytes = [];
	const body = path.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\' && /[0-7]{3}/.test(body.slice(i + 1, i + 4))) {
			bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
			i += 3;
		} else if (body[i] === '\\') {
			const escaped = body[++i];
			bytes.push(...Buffer.from(({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[escaped] ?? escaped));
		} else {
			bytes.push(...Buffer.from(body[i]));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}
