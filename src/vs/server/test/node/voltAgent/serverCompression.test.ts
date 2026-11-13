/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as zlib from 'zlib';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CompressedCopies, compress, compressionLevel, CompressionEncoding, LARGE_FILE_BYTES, preferredEncoding } from '../../../node/voltAgent/serverCompression.js';

suite('Agent server compression', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-compression-'));
	});
	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** A compressor that records the levels it was asked for and tags its output with the level. */
	function recording(): { levels: number[]; compressor: typeof compress } {
		const levels: number[] = [];
		return {
			levels,
			compressor: async (contents: Buffer, encoding: CompressionEncoding, level: number) => {
				levels.push(level);
				return Buffer.from(`${encoding}:${level}:${contents.length}`);
			},
		};
	}

	test('prefers brotli, then gzip', () => {
		assert.strictEqual(preferredEncoding('gzip, deflate, br, zstd'), 'br');
		assert.strictEqual(preferredEncoding('gzip'), 'gzip');
		assert.strictEqual(preferredEncoding(undefined), undefined);
	});

	test('a large file gets a quick level first and the smallest one when upgraded', () => {
		assert.strictEqual(compressionLevel('br', LARGE_FILE_BYTES + 1, false), 4);
		assert.strictEqual(compressionLevel('br', 1000, false), 7);
		assert.strictEqual(compressionLevel('br', LARGE_FILE_BYTES + 1, true), zlib.constants.BROTLI_MAX_QUALITY);
		assert.strictEqual(compressionLevel('gzip', LARGE_FILE_BYTES + 1, true), zlib.constants.Z_BEST_COMPRESSION);
	});

	test('a remote request upgrades a large file to its smallest copy, kept on disk for the next server', async () => {
		const file = join(dir, 'workbench.js');
		await fs.writeFile(file, Buffer.alloc(LARGE_FILE_BYTES + 10, 'a'));
		const mtime = (await fs.stat(file)).mtimeMs;
		const cache = join(dir, 'cache');

		const first = recording();
		const copies = new CompressedCopies(cache, first.compressor);
		// This computer's browser: the quick copy, no upgrade.
		assert.strictEqual(String(await copies.copy(file, mtime, 'br', false).data), `br:4:${LARGE_FILE_BYTES + 10}`);
		await copies.whenUpgraded();
		assert.deepStrictEqual(first.levels, [4]);
		// A phone: still the quick copy now, the smallest one once it is made.
		const remote = copies.copy(file, mtime, 'br', true);
		assert.strictEqual(String(await remote.data), `br:4:${LARGE_FILE_BYTES + 10}`);
		await copies.whenUpgraded();
		assert.deepStrictEqual(first.levels, [4, 11]);
		assert.strictEqual(String(copies.copy(file, mtime, 'br', true).ready), `br:11:${LARGE_FILE_BYTES + 10}`);
		await copies.whenUpgraded();
		assert.deepStrictEqual(first.levels, [4, 11], 'upgraded once');

		// A new server reads the smallest copy from disk and compresses nothing.
		const second = recording();
		const next = new CompressedCopies(cache, second.compressor);
		assert.strictEqual(String(await next.copy(file, mtime, 'br', true).data), `br:11:${LARGE_FILE_BYTES + 10}`);
		await next.whenUpgraded();
		assert.deepStrictEqual(second.levels, []);

		// A changed file is compressed again, and its old copy leaves the disk.
		await fs.writeFile(file, Buffer.alloc(LARGE_FILE_BYTES + 20, 'b'));
		const changed = (await fs.stat(file)).mtimeMs + 1000;
		const third = recording();
		const after = new CompressedCopies(cache, third.compressor);
		await after.copy(file, changed, 'br', true).data;
		await after.whenUpgraded();
		assert.deepStrictEqual(third.levels, [4, 11]);
		assert.strictEqual((await fs.readdir(cache)).length, 1);
	});

	test('small files are never upgraded', async () => {
		const file = join(dir, 'small.json');
		await fs.writeFile(file, '{"a":1}'.repeat(500));
		const mtime = (await fs.stat(file)).mtimeMs;
		const r = recording();
		const copies = new CompressedCopies(join(dir, 'cache'), r.compressor);
		await copies.copy(file, mtime, 'br', true).data;
		await copies.whenUpgraded();
		assert.deepStrictEqual(r.levels, [7]);
	});

	test('the real compressor round-trips', async () => {
		const text = Buffer.from('const a = 1;\n'.repeat(1000));
		assert.deepStrictEqual(zlib.brotliDecompressSync(await compress(text, 'br', 4)), text);
		assert.deepStrictEqual(zlib.gunzipSync(await compress(text, 'gzip', 7)), text);
	});
});
