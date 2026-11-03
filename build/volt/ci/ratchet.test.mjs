/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGithubReporter } from './biomeDiff.mjs';
import { addedLines, commentableLines, hunkOfNewLine, parsePatch, splitGitDiff } from './diff.mjs';
import { parseHygieneOutput } from './lintDiff.mjs';
import { compareProblems, lineLookup } from './ratchet.mjs';

const patch = [
	'@@ -1,4 +1,5 @@ function a() {',
	' one',
	'-two',
	'+TWO',
	'+three',
	' four',
	'',
	'@@ -10,2 +11,2 @@',
	' ten',
	'-eleven',
	'+ELEVEN',
	'\\ No newline at end of file',
].join('\n');

test('parsePatch numbers old and new lines', () => {
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 2);
	assert.equal(hunks[0].header, 'function a() {');
	assert.deepEqual(hunks[0].lines.map(l => [l.kind, l.oldLine, l.newLine]), [[' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2], ['+', undefined, 3], [' ', 3, 4], [' ', 4, 5]]);
	assert.deepEqual(hunks[1].lines.map(l => [l.kind, l.oldLine, l.newLine]), [[' ', 10, 11], ['-', 11, undefined], ['+', undefined, 12]]);
});

test('addedLines and commentableLines', () => {
	const hunks = parsePatch(patch);
	assert.deepEqual([...addedLines(hunks)], [2, 3, 12]);
	const { right, left } = commentableLines(hunks);
	assert.deepEqual([...right].sort((a, b) => a - b), [1, 2, 3, 4, 5, 11, 12]);
	assert.deepEqual([...left].sort((a, b) => a - b), [2, 11]);
	const hunkOf = hunkOfNewLine(hunks);
	assert.equal(hunkOf.get(3), 0);
	assert.equal(hunkOf.get(12), 1);
});

test('splitGitDiff keys patches by the new path, and the old path for deletions', () => {
	const output = [
		'diff --git a/src/a.ts b/src/a.ts',
		'index 1..2 100644',
		'--- a/src/a.ts',
		'+++ b/src/a.ts',
		'@@ -1 +1 @@',
		'-x',
		'+y',
		'diff --git a/old.ts b/new.ts',
		'similarity index 90%',
		'rename from old.ts',
		'rename to new.ts',
		'--- a/old.ts',
		'+++ b/new.ts',
		'@@ -3,0 +4 @@',
		'+added',
		'diff --git a/gone.ts b/gone.ts',
		'deleted file mode 100644',
		'--- a/gone.ts',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-bye',
		'diff --git "a/sp\\303\\244ce.ts" "b/sp\\303\\244ce.ts"',
		'--- "a/sp\\303\\244ce.ts"',
		'+++ "b/sp\\303\\244ce.ts"',
		'@@ -0,0 +1 @@',
		'+hi',
	].join('\n');
	const patches = splitGitDiff(output);
	assert.deepEqual([...patches.keys()], ['src/a.ts', 'new.ts', 'gone.ts', `sp${String.fromCharCode(0xe4)}ce.ts`]);
	assert.deepEqual([...addedLines(parsePatch(/** @type {string} */(patches.get('new.ts'))))], [4]);
});

test('compareProblems reports only what the change adds', () => {
	const baseText = new Map([['a.ts', ['let x = "a";', 'let y = "b";']]]);
	const headText = new Map([['a.ts', ['// moved down', 'let x = "a";', 'let y = "b";', 'let z = "c";']]]);
	const base = [
		{ file: 'a.ts', line: 1, message: 'quotes', rule: 'q' },
		{ file: 'a.ts', line: 2, message: 'quotes', rule: 'q' },
		{ file: 'a.ts', message: 'Missing or bad copyright statement' },
	];
	const head = [
		{ file: 'a.ts', line: 2, message: 'quotes', rule: 'q' },
		{ file: 'a.ts', line: 3, message: 'quotes', rule: 'q' },
		{ file: 'a.ts', line: 4, message: 'quotes', rule: 'q' },
		{ file: 'a.ts', message: 'Missing or bad copyright statement' },
	];
	const result = compareProblems(base, head, { baseLine: lineLookup(baseText), headLine: lineLookup(headText), added: () => new Set([1, 4]) });
	assert.deepEqual(result.added, [{ file: 'a.ts', line: 4, message: 'quotes', rule: 'q' }]);
	assert.equal(result.fixed, 0);
});

test('compareProblems prefers added lines when a repeated problem grows', () => {
	const baseText = new Map([['a.ts', ['f();']]]);
	const headText = new Map([['a.ts', ['f();', 'f();', 'f();']]]);
	const problem = (/** @type {number} */ line) => ({ file: 'a.ts', line, message: 'm' });
	const result = compareProblems([problem(1)], [problem(1), problem(2), problem(3)], { baseLine: lineLookup(baseText), headLine: lineLookup(headText), added: () => new Set([2, 3]) });
	assert.deepEqual(result.added.map(p => p.line), [2, 3]);
	const onlyLast = compareProblems([problem(1)], [problem(1), problem(2), problem(3)], { baseLine: lineLookup(baseText), headLine: lineLookup(headText), added: () => new Set([3]) });
	assert.deepEqual(onlyLast.added.map(p => p.line), [1, 3]);
});

test('compareProblems counts fixed problems', () => {
	const text = new Map([['a.ts', ['bad']]]);
	const result = compareProblems([{ file: 'a.ts', line: 1, message: 'm' }], [], { baseLine: lineLookup(text), headLine: lineLookup(new Map()), added: () => new Set() });
	assert.deepEqual(result, { added: [], fixed: 1 });
});

test('parseHygieneOutput reads every hygiene message format', () => {
	const cwd = '/repo';
	const output = [
		'[12:00:00] /repo/src/a.ts: line 3, col 5, Error - Expected { after \'if\' condition. (curly)',
		'/repo/src/a.ts: line 4, col 1, Warning - Only use double-quoted strings for externalized strings. (local/code-no-unexternalized-strings)',
		'',
		'2 problems',
		'src/b.ts(7,1): Bad whitespace indentation',
		'src/b.css(2,1): Unknown variable: --vscode-nope',
		'src/c.ts: Missing or bad copyright statement',
		'File not formatted. Run the \'Format Document\' command to fix it: src/d.ts',
		'All valid variable names are in `build/lib/stylelint/vscode-known-variables.json`',
		'(node:123) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.',
		'something unexpected',
	].join('\n');
	const { problems, unparsed } = parseHygieneOutput(output, cwd);
	assert.deepEqual(problems, [
		{ file: 'src/a.ts', line: 3, column: 5, message: 'Expected { after \'if\' condition.', rule: 'curly' },
		{ file: 'src/a.ts', line: 4, column: 1, message: 'Only use double-quoted strings for externalized strings.', rule: 'local/code-no-unexternalized-strings' },
		{ file: 'src/b.ts', line: 7, column: 1, message: 'Bad whitespace indentation' },
		{ file: 'src/b.css', line: 2, column: 1, message: 'Unknown variable: --vscode-nope' },
		{ file: 'src/c.ts', message: 'Missing or bad copyright statement' },
		{ file: 'src/d.ts', message: 'File not formatted. Run the \'Format Document\' command to fix it.' },
	]);
	assert.deepEqual(unparsed, ['something unexpected']);
});

test('parseGithubReporter reads Biome annotations', () => {
	const output = [
		'::error title=lint/a11y/noSvgWithoutTitle,file=/tmp/base/src/x.tsx,line=4,endLine=4,col=5,endColumn=9::Alternative text title element cannot be empty',
		'::error title=format,file=src/y.css,line=1,endLine=9,col=1,endColumn=2::File content differs from formatting output',
		'check -------',
	].join('\n');
	assert.deepEqual(parseGithubReporter(output, '/tmp/base', 'apps/docs'), [
		{ file: 'apps/docs/src/x.tsx', line: 4, column: 5, message: 'Alternative text title element cannot be empty', rule: 'lint/a11y/noSvgWithoutTitle' },
		{ file: 'apps/docs/src/y.css', line: 1, column: 1, message: 'File content differs from formatting output', rule: 'format' },
	]);
});
