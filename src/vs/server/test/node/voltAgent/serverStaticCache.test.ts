/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { brotliDecompressSync } from 'zlib';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { entryName, ServerStaticCache } from '../../../node/voltAgent/serverStaticCache.js';

suite('Agent server static file cache', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	/** Small enough to keep brotli 11 quick here; the server uses 1 MB. */
	const MIN_BYTES = 4096;

	let root: string;
	let cacheDir: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'volt-static-cache-'));
		cacheDir = join(root, 'agentServer', 'static-cache');
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const newCache = () => store.add(new ServerStaticCache(cacheDir, new NullLogService(), MIN_BYTES));

	async function writeSource(name: string, text: string, mtime?: Date): Promise<{ file: string; size: number; mtimeMs: number }> {
		const file = join(root, name);
		await fs.writeFile(file, text);
		if (mtime) {
			await fs.utimes(file, mtime, mtime);
		}
		const stat = await fs.stat(file);
		return { file, size: stat.size, mtimeMs: stat.mtimeMs };
	}

	const bundle = (seed: string) => Array.from({ length: 400 }, (_, i) => `export function ${seed}${i}(value) { return value * ${i} + ${JSON.stringify(seed)}; }\n`).join('');
	const listCache = async () => (await fs.readdir(cacheDir).catch(() => [] as string[])).sort();

	test('a file at or below the limit is left to the in-memory copy', async () => {
		const cache = newCache();
		const source = await writeSource('small.js', 'x'.repeat(MIN_BYTES));
		assert.strictEqual(await cache.get(source.file, source.size, source.mtimeMs), undefined);
		await cache.whenIdle();
		assert.deepStrictEqual(await listCache(), []);
	});

	test('a big file is answered from memory at first, then stored on disk and served from there', async () => {
		const cache = newCache();
		const text = bundle('a');
		const source = await writeSource('workbench.js', text);
		assert.ok(source.size > MIN_BYTES);

		assert.strictEqual(await cache.get(source.file, source.size, source.mtimeMs), undefined, 'nothing stored yet: the caller serves its usual copy');
		await cache.whenIdle();
		const name = entryName(source.file, source.size, source.mtimeMs);
		assert.deepStrictEqual(await listCache(), [name]);

		const stored = await cache.get(source.file, source.size, source.mtimeMs);
		assert.ok(stored);
		assert.ok(stored.length < source.size / 4, `compressed to ${stored.length} of ${source.size}`);
		assert.strictEqual(brotliDecompressSync(stored).toString('utf8'), text);
		assert.deepStrictEqual(stored, await fs.readFile(join(cacheDir, name)));
	});

	test('a later server start serves the stored copy at once', async () => {
		const source = await writeSource('workbench.css', bundle('b'));
		const first = newCache();
		await first.get(source.file, source.size, source.mtimeMs);
		await first.whenIdle();

		const second = newCache();
		const stored = await second.get(source.file, source.size, source.mtimeMs);
		assert.ok(stored, 'read from disk on the first request');
		assert.strictEqual(brotliDecompressSync(stored).toString('utf8'), bundle('b'));
	});

	test('a changed file gets a new copy and its old copies (and a crashed write\'s temp file) are removed', async () => {
		const cache = newCache();
		const before = await writeSource('workbench.js', bundle('c'), new Date(2026, 0, 1));
		await cache.get(before.file, before.size, before.mtimeMs);
		await cache.whenIdle();
		const oldName = entryName(before.file, before.size, before.mtimeMs);
		const prefix = oldName.slice(0, oldName.indexOf('-') + 1);
		const leftover = `${prefix}0-0.br.123.abcd.tmp`;
		await fs.writeFile(join(cacheDir, leftover), 'partial');
		const unrelated = await writeSource('other.js', bundle('d'));
		await cache.get(unrelated.file, unrelated.size, unrelated.mtimeMs);
		await cache.whenIdle();

		const after = await writeSource('workbench.js', bundle('cc'), new Date(2026, 1, 1));
		assert.strictEqual(await cache.get(after.file, after.size, after.mtimeMs), undefined, 'the old copy is not served for the new file');
		await cache.whenIdle();
		const newName = entryName(after.file, after.size, after.mtimeMs);
		assert.notStrictEqual(newName, oldName);
		assert.deepStrictEqual(await listCache(), [newName, entryName(unrelated.file, unrelated.size, unrelated.mtimeMs)].sort());
		const stored = await cache.get(after.file, after.size, after.mtimeMs);
		assert.strictEqual(stored && brotliDecompressSync(stored).toString('utf8'), bundle('cc'));
	});

	test('warm makes the copies of the big files given, one at a time, and skips the rest', async () => {
		const cache = newCache();
		const big = await writeSource('workbench.js', bundle('e'));
		const alsoBig = await writeSource('workbench.css', bundle('f'));
		const small = await writeSource('nls.messages.js', 'small');
		await cache.warm([big.file, alsoBig.file, small.file, join(root, 'missing.js')]);
		assert.deepStrictEqual(await listCache(), [entryName(big.file, big.size, big.mtimeMs), entryName(alsoBig.file, alsoBig.size, alsoBig.mtimeMs)].sort());
		assert.ok(await cache.get(big.file, big.size, big.mtimeMs));
	});

	test('nothing is stored after the server stops', async () => {
		const cache = newCache();
		const source = await writeSource('workbench.js', bundle('g'));
		await cache.get(source.file, source.size, source.mtimeMs);
		cache.dispose();
		await cache.whenIdle();
		assert.deepStrictEqual(await listCache(), []);
	});
});
