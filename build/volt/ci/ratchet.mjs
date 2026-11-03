/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A lint ratchet: main has problems that predate CI (eslint reports 35 errors and 1706 warnings,
// mostly unexternalized strings), so a check that fails on any problem would fail every PR.
// Instead each changed file is checked twice, at the base commit and at the head, and only
// problems the change adds fail. A problem is identified by file, message and the trimmed text of
// its line, not the line number, so code that moves keeps its old problems without failing.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { addedLines, parsePatch, splitGitDiff } from './diff.mjs';

/**
 * @typedef {{ file: string, line?: number, column?: number, message: string, rule?: string }} Problem
 * @typedef {{ status: string, path: string, oldPath: string }} Change
 */

/**
 * The key that matches a problem across the base and head versions of a file.
 * @param {Problem} problem
 * @param {(file: string, line: number) => string} lineText
 */
export function problemKey(problem, lineText) {
	const text = problem.line ? lineText(problem.file, problem.line).trim() : '';
	return `${problem.file}\0${problem.rule ?? ''}\0${problem.message}\0${text}`;
}

/**
 * Head problems the base does not have. When a key occurs more often in head than in base, the
 * occurrences on lines the change added are reported first.
 * @param {Problem[]} base
 * @param {Problem[]} head
 * @param {{ baseLine: (file: string, line: number) => string, headLine: (file: string, line: number) => string, added: (file: string) => Set<number> }} context
 * @returns {{ added: Problem[], fixed: number }}
 */
export function compareProblems(base, head, context) {
	/** @type {Map<string, number>} */
	const baseCounts = new Map();
	for (const problem of base) {
		const key = problemKey(problem, context.baseLine);
		baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
	}
	/** @type {Map<string, Problem[]>} */
	const headGroups = new Map();
	for (const problem of head) {
		const key = problemKey(problem, context.headLine);
		const group = headGroups.get(key);
		if (group) {
			group.push(problem);
		} else {
			headGroups.set(key, [problem]);
		}
	}
	/** @type {Problem[]} */
	const added = [];
	let matched = 0;
	for (const [key, group] of headGroups) {
		const extra = group.length - (baseCounts.get(key) ?? 0);
		matched += Math.min(group.length, baseCounts.get(key) ?? 0);
		if (extra <= 0) {
			continue;
		}
		const onAddedLines = (/** @type {Problem} */ p) => p.line !== undefined && context.added(p.file).has(p.line);
		const ordered = [...group.filter(onAddedLines), ...group.filter(p => !onAddedLines(p))];
		added.push(...ordered.slice(0, extra));
	}
	added.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
	return { added, fixed: base.length - matched };
}

/**
 * Files the change touches, with the path each one had at the base commit.
 * @param {string} base
 * @param {string | undefined} head a commit, or undefined for the working tree
 * @param {string} cwd
 * @returns {Change[]}
 */
export function listChanges(base, head, cwd) {
	const out = execFileSync('git', ['diff', '--name-status', '-M', '-z', base, ...(head ? [head] : [])], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const parts = out.split('\0').filter(Boolean);
	/** @type {Change[]} */
	const changes = [];
	for (let i = 0; i < parts.length;) {
		const status = parts[i++];
		if (status.startsWith('R') || status.startsWith('C')) {
			const oldPath = parts[i++];
			const path = parts[i++];
			changes.push({ status: status[0], path, oldPath });
		} else {
			const path = parts[i++];
			changes.push({ status, path, oldPath: path });
		}
	}
	return changes;
}

/**
 * Added lines per head path, from one `git diff -U0`.
 * @param {string} base
 * @param {string | undefined} head a commit, or undefined for the working tree
 * @param {string} cwd
 * @returns {Map<string, Set<number>>}
 */
export function addedLinesByFile(base, head, cwd) {
	const out = execFileSync('git', ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', base, ...(head ? [head] : [])], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	/** @type {Map<string, Set<number>>} */
	const result = new Map();
	for (const [path, patch] of splitGitDiff(out)) {
		result.set(path, addedLines(parsePatch(patch)));
	}
	return result;
}

/**
 * A file's content at a commit, or undefined when it did not exist there.
 * @param {string} commit
 * @param {string} path
 * @param {string} cwd
 * @returns {Buffer | undefined}
 */
export function showFile(commit, path, cwd) {
	try {
		return execFileSync('git', ['show', `${commit}:${path}`], { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return undefined;
	}
}

/**
 * Prints the new problems as GitHub annotations and a plain list, and writes the step summary.
 * @param {string} tool
 * @param {Problem[]} added
 * @param {{ fixed: number, files: number, unparsed?: string[] }} stats
 */
export function report(tool, added, stats) {
	for (const problem of added) {
		const location = [`file=${escapeProperty(problem.file)}`];
		if (problem.line) {
			location.push(`line=${problem.line}`);
		}
		if (problem.column) {
			location.push(`col=${problem.column}`);
		}
		const message = problem.rule ? `${problem.message} (${problem.rule})` : problem.message;
		console.log(`::error ${location.join(',')},title=${escapeProperty(tool)}::${escapeData(message)}`);
	}
	const lines = added.map(p => `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ''}` : ''}  ${p.message}${p.rule ? ` (${p.rule})` : ''}`);
	if (added.length) {
		console.log(`\n${tool}: ${added.length} new problem${added.length === 1 ? '' : 's'} in ${stats.files} changed files:\n${lines.map(l => `  ${l}`).join('\n')}`);
	} else {
		console.log(`\n${tool}: no new problems in ${stats.files} changed files.`);
	}
	if (stats.fixed > 0) {
		console.log(`${tool}: ${stats.fixed} existing problem${stats.fixed === 1 ? '' : 's'} fixed. Thank you.`);
	}
	for (const line of stats.unparsed ?? []) {
		console.log(`::error title=${escapeProperty(tool)}::${escapeData(`Unrecognized problem output: ${line}`)}`);
	}
	if (process.env.GITHUB_STEP_SUMMARY) {
		const summary = [`### ${tool}`, ''];
		summary.push(added.length ? `${added.length} new problem${added.length === 1 ? '' : 's'} in ${stats.files} changed files:` : `No new problems in ${stats.files} changed files.`);
		if (added.length) {
			summary.push('', '```', ...lines.slice(0, 200), ...(lines.length > 200 ? [`... and ${lines.length - 200} more`] : []), '```');
		}
		if (stats.fixed > 0) {
			summary.push('', `${stats.fixed} existing problem${stats.fixed === 1 ? '' : 's'} fixed.`);
		}
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n\n');
	}
}

/** @param {string} value */
function escapeData(value) {
	return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {string} value */
function escapeProperty(value) {
	return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Line text lookup over a set of file contents.
 * @param {Map<string, string[]>} files
 * @returns {(file: string, line: number) => string}
 */
export function lineLookup(files) {
	return (file, line) => files.get(file)?.[line - 1] ?? '';
}
