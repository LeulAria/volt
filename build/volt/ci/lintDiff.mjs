/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lint for pull requests: runs the repository's own hygiene (build/hygiene.js: eslint, the CSS
// variable check, TypeScript formatting, copyright headers, tab indentation, stray unicode) on every
// changed file, at the base commit and at the head, and fails only on problems the change adds.
// See ratchet.mjs for why. The same check, on the same files, as the pre-commit hook, so a green
// local commit is a green CI lint.
// Usage: node build/volt/ci/lintDiff.mjs --base <sha> [--head <sha>]
//        node build/volt/ci/lintDiff.mjs --base origin/main   (your working tree against main)
// The head files are read from disk, so check out the head commit first when you pass --head.

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addedLinesByFile, compareProblems, lineLookup, listChanges, report, showFile } from './ratchet.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

/** @typedef {import('./ratchet.mjs').Problem} Problem */

const eslintLine = /(?:^|\] )(\/.+?|[A-Za-z]:\\.+?): line (\d+), col (\d+), (Error|Warning) - (.+?)(?: \(([^()]+)\))?$/;
const positionedLine = /^(\S.*?)\((\d+),(\d+)\): (.+)$/;
const copyrightLine = /^(\S.*?): Missing or bad copyright statement$/;
const formattingLine = /^File not formatted\. Run the 'Format Document' command to fix it: (.+)$/;
const ignoredLine = /^(\[[\d:]+\] )?(\d+ problems?|All valid variable names are in|To update that file, run|\(node:\d+\) |\(Use `node --trace-|$)/;

/**
 * Turns what hygiene printed into problems. Lines that look like neither a problem nor known noise
 * come back in `unparsed`, so a new message format fails loudly instead of passing unseen.
 * @param {string} output
 * @param {string} cwd
 * @returns {{ problems: Problem[], unparsed: string[] }}
 */
export function parseHygieneOutput(output, cwd) {
	/** @type {Problem[]} */
	const problems = [];
	/** @type {string[]} */
	const unparsed = [];
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
		let m;
		if ((m = eslintLine.exec(line))) {
			problems.push({ file: toPosix(path.relative(cwd, m[1])), line: Number(m[2]), column: Number(m[3]), message: m[5], rule: m[6] });
		} else if ((m = positionedLine.exec(line))) {
			problems.push({ file: toPosix(m[1]), line: Number(m[2]), column: Number(m[3]), message: m[4] });
		} else if ((m = copyrightLine.exec(line))) {
			problems.push({ file: toPosix(m[1]), message: 'Missing or bad copyright statement' });
		} else if ((m = formattingLine.exec(line))) {
			problems.push({ file: toPosix(m[1].trim()), message: `File not formatted. Run the 'Format Document' command to fix it.` });
		} else if (!ignoredLine.test(line) && !/^\[[\d:]+\] (Using gulpfile|Starting|Finished)/.test(line)) {
			unparsed.push(line);
		}
	}
	return { problems, unparsed };
}

/** @param {string} p */
function toPosix(p) {
	return p.split(path.sep).join('/');
}

/**
 * Runs hygiene over in-memory files and returns everything it printed.
 * @param {{ path: string, contents: Buffer }[]} files repository-relative paths
 * @returns {Promise<string>}
 */
async function runHygiene(files) {
	const require = createRequire(path.join(root, 'build', 'hygiene.js'));
	const { hygiene } = require('./hygiene.js');
	const { all } = require('./filters.js');
	const es = require('event-stream');
	const filter = require('gulp-filter');
	const VinylFile = require('vinyl');
	const vinyls = files.map(file => new VinylFile({
		path: path.join(root, file.path),
		base: root,
		contents: file.contents,
		stat: /** @type {fs.Stats} */ ({ isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: 0o100644, size: file.contents.length }),
	}));

	/** @type {string[]} */
	const captured = [];
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	const capture = /** @type {typeof process.stdout.write} */ (/** @type {unknown} */ ((/** @type {string | Uint8Array} */ chunk) => {
		captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		return true;
	}));
	process.stdout.write = capture;
	process.stderr.write = capture;
	try {
		await new Promise((resolve) => {
			// filter(all) first, exactly as the pre-commit hook does: it leaves out apps with their own
			// formatter (apps/docs) and other files hygiene does not own.
			hygiene(es.readArray(vinyls).pipe(filter(all)), true)
				.on('data', () => { /* drain */ })
				.on('end', resolve)
				// hygiene emits a summary error when it found problems; the problems themselves were printed.
				.on('error', resolve);
		});
	} finally {
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
	}
	return captured.join('');
}

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {{ base?: string, head?: string }} */
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') {
			args.base = argv[++i];
		} else if (argv[i] === '--head') {
			args.head = argv[++i];
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.base) {
		console.error('Usage: node build/volt/ci/lintDiff.mjs --base <sha> [--head <sha>]');
		process.exit(2);
	}
	// Node prints a deprecation once per process, so only one of the two runs would show it.
	process.noDeprecation = true;
	const started = Date.now();
	const changes = listChanges(args.base, args.head, root).filter(change => change.status !== 'D');
	/** @type {{ path: string, contents: Buffer }[]} */
	const headFiles = [];
	/** @type {{ path: string, contents: Buffer }[]} */
	const baseFiles = [];
	for (const change of changes) {
		const absolute = path.join(root, change.path);
		if (!fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isFile()) {
			continue;
		}
		headFiles.push({ path: change.path, contents: fs.readFileSync(absolute) });
		const before = change.status === 'A' ? undefined : showFile(args.base, change.oldPath, root);
		if (before) {
			// Keyed by the head path, so a renamed file is checked with the same rules at both commits.
			baseFiles.push({ path: change.path, contents: before });
		}
	}
	if (!headFiles.length) {
		report('Lint', [], { fixed: 0, files: 0 });
		return;
	}

	const baseRun = parseHygieneOutput(await runHygiene(baseFiles), root);
	const headRun = parseHygieneOutput(await runHygiene(headFiles), root);
	const lines = (/** @type {{ path: string, contents: Buffer }[]} */ files) => new Map(files.map(f => [f.path, f.contents.toString('utf8').split(/\r\n|\r|\n/)]));
	const added = addedLinesByFile(args.base, args.head, root);
	const result = compareProblems(baseRun.problems, headRun.problems, {
		baseLine: lineLookup(lines(baseFiles)),
		headLine: lineLookup(lines(headFiles)),
		added: file => added.get(file) ?? new Set(),
	});
	// Output hygiene printed that is not a known problem format: new only if the base did not print it too.
	const baseUnparsed = new Set(baseRun.unparsed);
	const unparsed = headRun.unparsed.filter(line => !baseUnparsed.has(line));
	report('Lint', result.added, { fixed: result.fixed, files: headFiles.length, unparsed });
	console.log(`(${headFiles.length} files at ${args.head ?? 'the working tree'}, ${baseFiles.length} at ${args.base}, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
	if (result.added.length || unparsed.length) {
		console.log(`\nFix these before merging. Run \`node build/hygiene.js <file>\` to check a file locally, and 'Format Document' for formatting.`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		console.error(error);
		process.exit(1);
	});
}
