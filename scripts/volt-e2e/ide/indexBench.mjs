/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): code index bench, no models, no Volt window.
// Builds Volt's code index for a repo in-process (the same CodeIndexEngine the index process runs),
// then times grep / symbol / fuzzy-file queries against it and against ripgrep on the same patterns.
//
// Usage: node scripts/volt-e2e/ide/indexBench.mjs <repo> [out.json]
// Needs a transpiled out/ (npm run transpile-client-oxc). Runs with --expose-gc for heap numbers.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../out');
const { CodeIndexEngine } = await import(join(out, 'vs/platform/voltCodeIndex/node/codeIndexEngine.js'));

const root = resolve(process.argv[2] ?? '/tmp/volt-e2e/ide/hotel');
const outFile = process.argv[3];
const RUNS = 15;

const GREPS = [
	// [label, pattern, isRegExp, caseSensitive]
	['literal rare', 'reservationStatusEnum', false, true],
	['literal common', 'propertyId', false, true],
	['regex insert', 'insert\\(reservations\\)', true, true],
	['regex route', '@(Post|Patch|Put)\\(', true, true],
	['regex wide', 'status\\s*[:=]\\s*\'(cancelled|checked_out)\'', true, false],
	['literal miss', 'zzNoSuchTokenzz', false, true],
];
const SYMBOLS = [['ReservationService', 'exact'], ['Reservation', 'prefix'], ['resSvc', 'fuzzy'], ['checkIn', 'exact']];
const FILES = ['reservation service', 'folio controller', 'nightaudit'];

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}
function p90(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}
function mb(bytes) {
	return Math.round(bytes / 1024 / 1024 * 10) / 10;
}
async function time(fn) {
	const start = performance.now();
	const value = await fn();
	return { ms: performance.now() - start, value };
}
async function waitReady(engine) {
	for (; ;) {
		const [status] = await engine.status([root]);
		if (status?.state === 'ready' && !status.pending) {
			return status;
		}
		if (status?.state === 'error') {
			throw new Error(status.error);
		}
		await new Promise(r => setTimeout(r, 20));
	}
}

const result = { root, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), node: process.version, runs: RUNS };
const dataDir = mkdtempSync(join(tmpdir(), 'volt-index-bench-'));
try {
	global.gc?.();
	const before = process.memoryUsage();
	// Cold build: an empty data dir.
	let engine = new CodeIndexEngine(dataDir, () => { });
	const cold = await time(async () => { await engine.warm(root); return waitReady(engine); });
	global.gc?.();
	const after = process.memoryUsage();
	result.coldBuild = { ms: Math.round(cold.ms), files: cold.value.files, bytes: cold.value.bytes, symbols: cold.value.symbols, diskBytes: cold.value.diskBytes, heapDeltaMB: mb(after.heapUsed - before.heapUsed), rssDeltaMB: mb(after.rss - before.rss), externalDeltaMB: mb(after.external + after.arrayBuffers - before.external - before.arrayBuffers) };

	// First query on the freshly built index (what the first agent search pays after warmup).
	const first = await time(() => engine.search({ root, pattern: 'propertyId', isRegExp: false, caseSensitive: true, multiline: false, maxMatches: 100 }));
	result.firstQueryMs = Math.round(first.ms * 10) / 10;
	await engine.dispose();

	// Reload: a new process opening the index from disk (Volt restarted, or the idle process exited).
	engine = new CodeIndexEngine(dataDir, () => { });
	const reload = await time(async () => { await engine.warm(root); return waitReady(engine); });
	result.reloadFromDisk = { ms: Math.round(reload.ms) };

	result.grep = [];
	for (const [label, pattern, isRegExp, caseSensitive] of GREPS) {
		const request = { root, pattern, isRegExp, caseSensitive, multiline: false, maxMatches: 100 };
		const index = [];
		let hits;
		for (let i = 0; i < RUNS; i++) {
			const t = await time(() => engine.search(request));
			index.push(t.ms);
			hits = t.value;
		}
		const rg = [];
		let rgFiles = 0;
		for (let i = 0; i < 5; i++) {
			const args = ['--json', '-m', '100', ...(caseSensitive ? ['-s'] : ['-i']), ...(isRegExp ? [] : ['-F']), '-e', pattern, root];
			const start = performance.now();
			const run = spawnSync('rg', args, { maxBuffer: 64 * 1024 * 1024 });
			rg.push(performance.now() - start);
			rgFiles = (run.stdout.toString().match(/"type":"begin"/g) ?? []).length;
		}
		result.grep.push({ label, pattern, indexMedianMs: +median(index).toFixed(2), indexP90Ms: +p90(index).toFixed(2), rgMedianMs: +median(rg).toFixed(1), indexFiles: hits.kind === 'results' ? hits.files.length : hits.reason, indexEngine: hits.kind === 'results' ? hits.stats?.engine : 'fallback', candidates: hits.stats?.candidates, rgFiles });
	}

	result.symbols = [];
	for (const [query, match] of SYMBOLS) {
		const times = [];
		let found;
		for (let i = 0; i < RUNS; i++) {
			const t = await time(() => engine.symbols({ root, query, match, limit: 30 }));
			times.push(t.ms);
			found = t.value;
		}
		const rg = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			spawnSync('rg', ['-n', '-e', `(class|interface|function|const|type|enum)\\s+${query}\\b`, root], { maxBuffer: 64 * 1024 * 1024 });
			rg.push(performance.now() - start);
		}
		result.symbols.push({ query, match, medianMs: +median(times).toFixed(2), p90Ms: +p90(times).toFixed(2), results: found.kind === 'results' ? found.symbols.length : found.reason, rgDeclarationRegexMedianMs: +median(rg).toFixed(1) });
	}

	result.findFiles = [];
	for (const query of FILES) {
		const times = [];
		let found;
		for (let i = 0; i < RUNS; i++) {
			const t = await time(() => engine.findFiles({ root, query, limit: 20, fff: 'off' }));
			times.push(t.ms);
			found = t.value;
		}
		const rg = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			spawnSync('rg', ['--files', root], { maxBuffer: 64 * 1024 * 1024 });
			rg.push(performance.now() - start);
		}
		result.findFiles.push({ query, medianMs: +median(times).toFixed(2), top: found.kind === 'results' ? found.paths.slice(0, 3) : found.reason, rgFilesListMedianMs: +median(rg).toFixed(1) });
	}
	await engine.dispose();
} finally {
	rmSync(dataDir, { recursive: true, force: true });
}

const text = JSON.stringify(result, null, 1);
console.log(text);
if (outFile) {
	writeFileSync(outFile, text);
}
process.exit(0);
