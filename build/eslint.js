/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check

// Lints every file matched by `eslintFilter`. Files are split across worker threads by a stable
// hash of their path, and each worker keeps its own content-based ESLint cache in .build/eslintcache,
// so unchanged files are skipped on later runs.
// Options (env): VSCODE_ESLINT_WORKERS=<n> (default: cores - 1, max 12), VSCODE_ESLINT_CACHE=0 to disable the cache.

const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const root = path.join(__dirname, '..');

// Files linted with type information (see the last block of eslint.config.js). Each worker that
// sees one builds those TypeScript programs, so they all go to the same worker.
const typedLintFolders = ['markdown-language-features', 'mermaid-chat-features', 'media-preview', 'simple-browser', 'typescript-language-features']
	.map(name => `extensions${path.sep}${name}${path.sep}`);

/** @param {string} file */
function bucketOf(file, buckets) {
	if (file.endsWith('.ts') && typedLintFolders.some(folder => file.startsWith(folder))) {
		return 0;
	}
	let hash = 0;
	for (let i = 0; i < file.length; i++) {
		hash = (hash * 31 + file.charCodeAt(i)) | 0;
	}
	return buckets > 1 ? 1 + Math.abs(hash) % (buckets - 1) : 0;
}

async function lintChunk() {
	const { ESLint } = require('eslint');
	const { files, cache, cacheLocation } = workerData;
	const linter = new ESLint({ cwd: root, cache, cacheLocation, cacheStrategy: 'content', errorOnUnmatchedPattern: false, warnIgnored: false });
	const formatter = await linter.loadFormatter('compact');
	const results = await linter.lintFiles(files);
	const message = await formatter.format(results);
	parentPort?.postMessage({
		message,
		errorCount: results.reduce((sum, r) => sum + r.errorCount, 0),
		warningCount: results.reduce((sum, r) => sum + r.warningCount, 0),
		fileCount: results.length,
	});
}

/** @returns {Promise<string[]>} */
function listFiles() {
	const es = require('event-stream');
	const vfs = require('vinyl-fs');
	const { eslintFilter } = require('./filters');
	return new Promise((resolve, reject) => {
		/** @type {string[]} */
		const files = [];
		vfs.src(eslintFilter, { base: '.', follow: true, allowEmpty: true, read: false })
			.pipe(es.through(file => { files.push(path.relative(root, file.path)); }, () => resolve(files)))
			.on('error', reject);
	});
}

async function main() {
	const started = Date.now();
	const files = await listFiles();
	const workers = Math.max(1, Number(process.env.VSCODE_ESLINT_WORKERS) || Math.min(12, os.availableParallelism() - 1));
	const cache = process.env.VSCODE_ESLINT_CACHE !== '0';
	/** @type {string[][]} */
	const chunks = Array.from({ length: workers }, () => []);
	for (const file of files) {
		chunks[bucketOf(file, workers)].push(file);
	}

	const outcomes = await Promise.all(chunks.map((chunk, index) => new Promise((resolve, reject) => {
		if (!chunk.length) {
			return resolve({ message: '', errorCount: 0, warningCount: 0, fileCount: 0 });
		}
		const worker = new Worker(__filename, {
			workerData: { files: chunk, cache, cacheLocation: path.join(root, '.build', 'eslintcache', `${workers}-${index}`) }
		});
		worker.once('message', resolve);
		worker.once('error', reject);
		worker.once('exit', code => code !== 0 && reject(new Error(`eslint worker ${index} exited with ${code}`)));
	})));

	let errorCount = 0, warningCount = 0, fileCount = 0;
	for (const outcome of outcomes) {
		if (outcome.message) {
			console.log(outcome.message);
		}
		errorCount += outcome.errorCount;
		warningCount += outcome.warningCount;
		fileCount += outcome.fileCount;
	}
	console.log(`eslint: ${fileCount} files, ${errorCount} errors, ${warningCount} warnings, ${workers} workers${cache ? ' (cached)' : ''}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
	if (errorCount > 0 || warningCount > 0) {
		throw new Error('eslint failed with warnings and/or errors');
	}
}

if (!isMainThread) {
	lintChunk().catch(err => { console.error(err); process.exit(1); });
} else if (require.main === module) {
	main().catch(err => {
		console.error();
		console.error(err);
		process.exit(1);
	});
}
