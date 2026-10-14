/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltCodeIndexFileHits, IVoltCodeIndexSearchRequest } from '../../common/voltCodeIndex.js';
import { listFiles, searchFiles } from '../../node/ripgrep.js';
import { RootIndex } from '../../node/rootIndex.js';

/** Files in the fixture that contain `return` on every line: enough that the index rules almost nothing out. */
const COMMON_FILES = 2_200;
const MID_FILES = 300;
/** More than the in-process scan covers, few enough to stay selective: in-process first, ripgrep for the rest. */
const MIXED_FILES = 700;

function matchedLines(files: readonly IVoltCodeIndexFileHits[]): string[] {
	return files.flatMap(file => file.lines.filter(line => line.match).map(line => `${file.path}:${line.line}:${line.text}`)).sort();
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!await check()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

suite('Volt code index: search against ripgrep', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let dataDir: string;
	let index: RootIndex;

	suiteSetup(async () => {
		const base = join(tmpdir(), `volt-index-test-${generateUuid()}`);
		root = join(base, 'repo');
		dataDir = join(base, 'data');
		await fs.mkdir(join(root, 'common'), { recursive: true });
		await fs.mkdir(join(root, 'mid'), { recursive: true });
		await fs.mkdir(join(root, 'mixed'), { recursive: true });
		await fs.mkdir(join(root, 'with space'), { recursive: true });
		await fs.mkdir(join(root, 'ignored'), { recursive: true });
		await fs.mkdir(join(root, 'bin'), { recursive: true });
		await fs.writeFile(join(root, '.gitignore'), 'ignored/\n');
		await fs.writeFile(join(root, 'ignored', 'secret.ts'), 'const needle = 1;\n');
		await fs.writeFile(join(root, 'with space', 'file name.ts'), 'export const needle = "in a folder with a space";\n');
		await fs.writeFile(join(root, 'bin', 'data.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2, 3]));
		await fs.writeFile(join(root, 'long.txt'), `${'x'.repeat(10_000)} needle ${'y'.repeat(10_000)}\n`);
		// Over the 16 MB indexing limit: searched through its trigram bitset.
		await fs.writeFile(join(root, 'huge.txt'), `${'abc def\n'.repeat(2_200_000)}hugeOnlyToken here\n`);
		const writes: Promise<void>[] = [];
		for (let i = 0; i < COMMON_FILES; i++) {
			writes.push(fs.writeFile(join(root, 'common', `f${i}.ts`), `return ${i};\nreturn ${i + 1};\n`));
		}
		for (let i = 0; i < MID_FILES; i++) {
			writes.push(fs.writeFile(join(root, 'mid', `m${i}.ts`), `export function middleWord${i}() { return ${i}; }\n`));
		}
		for (let i = 0; i < MIXED_FILES; i++) {
			writes.push(fs.writeFile(join(root, 'mixed', `x${i}.ts`), `export const mixedToken${i} = ${i};\n`));
		}
		await Promise.all(writes);
		index = new RootIndex(root, dataDir, {}, () => { }, () => { });
		await index.start();
	});

	suiteTeardown(async () => {
		await index?.dispose();
		await fs.rm(join(root, '..'), { recursive: true, force: true });
	});

	const request = (pattern: string, extra: Partial<IVoltCodeIndexSearchRequest> = {}): IVoltCodeIndexSearchRequest => ({
		root, pattern, isRegExp: false, caseSensitive: false, multiline: false, maxMatches: 10_000, maxLineChars: 500, waitMs: 30_000, ...extra,
	});

	/** What ripgrep finds walking the folder (as the search service runs it): binary files are skipped. */
	async function ripgrep(pattern: string, isRegExp = false): Promise<string[]> {
		const listed = await listFiles(root, {}, 100_000);
		const text: string[] = [];
		for (const path of listed.paths) {
			const head = (await fs.readFile(join(root, path))).subarray(0, 8192);
			if (!head.includes(0)) {
				text.push(path);
			}
		}
		const found = await searchFiles(root, text, { pattern, isRegExp, caseSensitive: false, multiline: false, wholeWord: false, context: 0, maxMatches: 100_000, maxLineChars: 500 });
		return matchedLines(found.files);
	}

	test('a selective literal: same lines as ripgrep, ignored and binary files left out, spaces in paths kept', async () => {
		const result = await index.search(request('needle'));
		assert.strictEqual(result.kind, 'results');
		const lines = matchedLines(result.files);
		assert.deepStrictEqual(lines, await ripgrep('needle'));
		assert.ok(lines.some(line => line.startsWith('with space/file name.ts:1:')));
		assert.ok(!lines.some(line => line.startsWith('ignored/')));
		assert.ok(!lines.some(line => line.startsWith('bin/')));
	});

	test('a pattern in most files stops at the limit in-process and says more exist', async () => {
		const result = await index.search(request('return', { maxMatches: 50 }));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.stats.engine, 'index');
		assert.strictEqual(result.limitHit, true);
		const lines = matchedLines(result.files);
		assert.strictEqual(lines.length, 50);
		const all = new Set(await ripgrep('return'));
		assert.ok(lines.every(line => all.has(line)), 'every line returned is one ripgrep finds');
	});

	test('a pattern too short to look up is answered in-process with the limit', async () => {
		const result = await index.search(request('r', { caseSensitive: true, maxMatches: 20 }));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.limitHit, true);
		assert.strictEqual(matchedLines(result.files).length, 20);
	});

	test('a regex that rules nothing out (Unicode \\w) is answered in-process with the limit', async () => {
		const result = await index.search(request('\\w+', { isRegExp: true, maxMatches: 20 }));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.limitHit, true);
		assert.strictEqual(matchedLines(result.files).length, 20);
	});

	test('a regex that rules nothing out and has no JavaScript form (\\p{L}) is left to ripgrep', async () => {
		const result = await index.search(request('\\p{L}+', { isRegExp: true, maxMatches: 20 }));
		assert.deepStrictEqual(result, { kind: 'fallback', reason: 'unselective' });
	});

	test('a few hundred candidates without a limit: complete and identical to ripgrep', async () => {
		const result = await index.search(request('middleWord'));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.limitHit, false);
		assert.strictEqual(result.files.length, MID_FILES);
		assert.deepStrictEqual(matchedLines(result.files), await ripgrep('middleWord'));
	});

	test('hundreds of candidates, regex with \\d: in-process, identical to ripgrep, and the limit holds', async () => {
		const result = await index.search(request('mixedToken\\d+', { isRegExp: true }));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.stats.engine, 'index');
		assert.strictEqual(result.limitHit, false);
		assert.strictEqual(result.files.length, MIXED_FILES);
		assert.deepStrictEqual(matchedLines(result.files), await ripgrep('mixedToken\\d+', true));
		const limited = await index.search(request('mixedToken\\d+', { isRegExp: true, maxMatches: 600 }));
		assert.strictEqual(limited.kind, 'results');
		assert.strictEqual(limited.limitHit, true);
		assert.strictEqual(matchedLines(limited.files).length, 600);
	});

	test('a pattern only ripgrep can match: ripgrep reads the candidates, same lines', async () => {
		const result = await index.search(request('mixedToken\\p{N}+', { isRegExp: true }));
		assert.strictEqual(result.kind, 'results');
		assert.strictEqual(result.stats.engine, 'ripgrep');
		assert.strictEqual(result.files.length, MIXED_FILES);
		assert.deepStrictEqual(matchedLines(result.files), await ripgrep('mixedToken\\p{N}+', true));
	});

	test('no match, a malformed regex, and a huge line', async () => {
		const none = await index.search(request('zzqqxxnomatch'));
		assert.strictEqual(none.kind, 'results');
		assert.deepStrictEqual(none.files, []);
		assert.strictEqual(none.limitHit, false);

		const malformed = await index.search(request('needle(', { isRegExp: true }));
		assert.ok(malformed.kind === 'fallback' || malformed.files.length === 0, 'never a crash, never invented matches');

		const long = await index.search(request('needle', { maxLineChars: 100 }));
		assert.strictEqual(long.kind, 'results');
		const line = long.files.find(file => file.path === 'long.txt')?.lines.find(candidate => candidate.match);
		assert.ok(line, 'the match in the long line is found');
		assert.ok(line.text.length <= 101 + 3, `long lines are cut to maxLineChars (got ${line.text.length})`);
	});

	test('fuzzy file search over the index\'s file list, ignore files honored', async () => {
		const found = await index.findFiles({ root, query: 'file nam', limit: 5, waitMs: 30_000 });
		assert.strictEqual(found.kind, 'results');
		assert.strictEqual(found.paths[0], 'with space/file name.ts');
		const ignored = await index.findFiles({ root, query: 'secret', limit: 5 });
		assert.strictEqual(ignored.kind, 'results');
		assert.ok(!ignored.paths.includes('ignored/secret.ts'));
		const listed = index.listedFilter();
		assert.ok(listed?.('with space/file name.ts'));
		assert.ok(!listed?.('ignored/secret.ts'));
	});

	test('a file too large to index: found when it matches, skipped when it cannot, fresh after an edit', async () => {
		const hit = await index.search(request('hugeOnlyToken'));
		assert.strictEqual(hit.kind, 'results');
		assert.deepStrictEqual(hit.files.map(file => file.path), ['huge.txt']);
		const miss = await index.search(request('zzNotInHugeFile'));
		assert.strictEqual(miss.kind, 'results');
		assert.strictEqual(miss.stats.candidates, 0, 'its trigrams rule it out without reading it');
		await fs.appendFile(join(root, 'huge.txt'), 'appendedHugeToken\n');
		await until(async () => {
			const result = await index.search(request('appendedHugeToken'));
			return result.kind === 'results' && result.files.length === 1 && result.files[0].path === 'huge.txt';
		});
	});

	test('symbol lookups stay exact across edits: the new name appears, the old one is gone, no duplicates', async () => {
		const exact = await index.symbols({ root, query: 'middleWord5', limit: 10, waitMs: 30_000 });
		assert.strictEqual(exact.kind, 'results');
		assert.deepStrictEqual(exact.symbols.map(symbol => `${symbol.path}:${symbol.line}`), ['mid/m5.ts:1']);
		const anyCase = await index.symbols({ root, query: 'MIDDLEWORD5', limit: 10 });
		assert.strictEqual(anyCase.kind === 'results' && anyCase.symbols.length, 1);
		const prefix = await index.symbols({ root, query: 'middleWord29', match: 'prefix', limit: 50 });
		assert.strictEqual(prefix.kind === 'results' && prefix.symbols.length, 11, 'middleWord29 and middleWord290-299');
		await fs.writeFile(join(root, 'mid', 'm5.ts'), 'export function renamedWord5() { return 5; }\n');
		await until(async () => {
			const renamed = await index.symbols({ root, query: 'renamedWord5', limit: 10 });
			const old = await index.symbols({ root, query: 'middleWord5', limit: 10 });
			return renamed.kind === 'results' && renamed.symbols.length === 1 && old.kind === 'results' && old.symbols.length === 0;
		});
	});

	test('edits, new files, renames and deletes show up in the next search', async () => {
		const added = join(root, 'added.ts');
		await fs.writeFile(added, 'const freshNeedleToken = 1;\n');
		await until(async () => {
			const result = await index.search(request('freshNeedleToken'));
			return result.kind === 'results' && result.files.some(file => file.path === 'added.ts');
		});
		await fs.rename(added, join(root, 'renamed.ts'));
		await until(async () => {
			const result = await index.search(request('freshNeedleToken'));
			return result.kind === 'results' && result.files.length === 1 && result.files[0].path === 'renamed.ts';
		});
		await fs.writeFile(join(root, 'renamed.ts'), 'const nothingHere = 1;\n');
		await until(async () => {
			const result = await index.search(request('freshNeedleToken'));
			return result.kind === 'results' && result.files.length === 0;
		});
		await fs.rm(join(root, 'renamed.ts'));
		await until(async () => {
			const result = await index.findFiles({ root, query: 'renamed', limit: 5 });
			return result.kind === 'results' && !result.paths.includes('renamed.ts');
		});
	});
});
