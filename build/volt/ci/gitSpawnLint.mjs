/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Git lint (K.4, INV-16): every git process Volt runs goes through HostGit
// (src/vs/platform/voltGit/node/hostGit.ts, or the stdio service's `git` method that calls it), so a
// repository can never make Volt run its fsmonitor, hooks or `ext::` remotes implicitly. A git spawn
// anywhere else fails CI unless git-spawn-allowlist.json lists it with a reason.
//
//   node build/volt/ci/gitSpawnLint.mjs            lint src/ and apps/ (exit 1 on a finding)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** HostGit itself, and code that never runs in Volt (tests, the built-in git extension is the user's SCM). */
const EXEMPT = [
	/^src\/vs\/platform\/voltGit\/node\/hostGit\.ts$/,
	/\/test\//,
	/\.test\.m?[jt]s$/,
	/^extensions\//,
];

/**
 * Shapes of a git spawn. Heuristic on purpose: they match the ways Volt's code has started git
 * (child_process with a `git` literal, a runner whose first argument is `'git'`, an argv array
 * starting with `'git'`, a stdio request whose command or file is git).
 */
const SUBCOMMAND = '(?:\\.\\.\\.|[\'"](?:-[\\w=.-]*|status|diff|log|show|rev-parse|add|commit|checkout|worktree|branch|fetch|push|pull|stash|reset|apply|ls-files|cat-file|merge|merge-base|rebase|init|clone|config|symbolic-ref|for-each-ref|blame|remote|submodule|hash-object|update-index|read-tree|write-tree|clean|restore|switch|tag|describe|rev-list|ls-remote|ls-tree|grep|mv|rm|gc|maintenance|cherry-pick|revert|am|format-patch|notes)[\'"\\s])';
export const GIT_SPAWN_PATTERNS = [
	{ id: 'child-process', re: /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*['"`]git(?:\.exe)?(?:['"`]|\s)/ },
	{ id: 'runner', re: /\b(?:run|runGit|runCommand|runProcess|execGit|execa|command)\(\s*['"]git(?:\.exe)?['"]\s*,/ },
	// A runner that takes a context first: `this.execFile(ctx, 'git', args, …)`.
	{ id: 'runner', re: /\b\w*(?:[eE]xec|[rR]un|[sS]pawn)\w*\([^()'"`]*,\s*['"]git(?:\.exe)?['"]\s*,/ },
	{ id: 'argv', re: new RegExp(`\\[\\s*['"]git(?:\\.exe)?['"]\\s*,\\s*${SUBCOMMAND}`) },
	{ id: 'stdio-request', re: /\b(?:command|file)\s*:\s*['"`]git(?:\.exe)?(?:['"`]|\s)/ },
];

/** Comments and the text of line comments are not code. */
function codeLines(text) {
	const out = [];
	let inBlock = false;
	for (const raw of text.split('\n')) {
		let line = raw;
		if (inBlock) {
			const end = line.indexOf('*/');
			if (end < 0) {
				out.push('');
				continue;
			}
			line = line.slice(end + 2);
			inBlock = false;
		}
		line = line.replace(/\/\*.*?\*\//g, '');
		const start = line.indexOf('/*');
		if (start >= 0) {
			line = line.slice(0, start);
			inBlock = true;
		}
		const trimmed = line.trim();
		out.push(trimmed.startsWith('//') || trimmed.startsWith('*') ? '' : line.replace(/\s\/\/\s.*$/, ''));
	}
	return out;
}

/** Findings in one file's text: `{ line, id, text }`. */
export function findGitSpawns(text) {
	const findings = [];
	codeLines(text).forEach((line, index) => {
		for (const { id, re } of GIT_SPAWN_PATTERNS) {
			if (re.test(line)) {
				findings.push({ line: index + 1, id, text: line.trim() });
				break;
			}
		}
	});
	return findings;
}

/** Dependencies and build output: not Volt's source. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', '.expo', 'Pods', 'build']);

function* sourceFiles(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (SKIPPED_DIRS.has(name)) {
			continue;
		}
		if (statSync(path).isDirectory()) {
			yield* sourceFiles(path);
		} else if (/\.(?:ts|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
			yield path;
		}
	}
}

/**
 * Allow-list entries: `{ file, match, reason }`. `match` is a substring of the flagged line, so an
 * entry covers that one call, not the whole file.
 */
export function loadAllowlist(path = join(ROOT, 'build', 'volt', 'ci', 'git-spawn-allowlist.json')) {
	const entries = JSON.parse(readFileSync(path, 'utf8'));
	for (const entry of entries) {
		if (!entry.file || !entry.match || !entry.reason || entry.reason.length < 20) {
			throw new Error(`git-spawn-allowlist.json: every entry needs file, match and a real reason: ${JSON.stringify(entry)}`);
		}
	}
	return entries;
}

export function lint(root = ROOT, allowlist = loadAllowlist()) {
	const problems = [];
	const used = new Set();
	const files = ['src', 'apps'].filter(dir => existsSync(join(root, dir))).flatMap(dir => [...sourceFiles(join(root, dir))]);
	for (const file of files) {
		const rel = relative(root, file).split('\\').join('/');
		if (EXEMPT.some(re => re.test(rel))) {
			continue;
		}
		for (const finding of findGitSpawns(readFileSync(file, 'utf8'))) {
			const allowed = allowlist.find(entry => entry.file === rel && finding.text.includes(entry.match));
			if (allowed) {
				used.add(allowed);
			} else {
				problems.push({ file: rel, ...finding });
			}
		}
	}
	const stale = allowlist.filter(entry => !used.has(entry));
	return { problems, stale };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { problems, stale } = lint();
	for (const p of problems) {
		console.error(`${p.file}:${p.line}: git spawned outside HostGit (${p.id}): ${p.text}`);
	}
	for (const entry of stale) {
		console.error(`git-spawn-allowlist.json: stale entry (no such call any more): ${entry.file} "${entry.match}"`);
	}
	if (problems.length || stale.length) {
		console.error('\nRun git through HostGit: runHostGit/prepareHostGit (node) or IVoltStdioService.git (workbench). See src/vs/platform/voltGit/common/hostGit.ts.');
		process.exit(1);
	}
	console.log('git lint: every git spawn goes through HostGit.');
}
