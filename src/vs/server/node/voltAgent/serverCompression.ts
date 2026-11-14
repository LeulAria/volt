/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as zlib from 'zlib';
import { join } from '../../../base/common/path.js';

export type CompressionEncoding = 'br' | 'gzip';

/** Text assets worth compressing; the web IDE's editor bundle shrinks to about a quarter. */
export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.webmanifest', '.ttf', '.otf', '.txt', '.wasm', '.scm']);

/**
 * Files this big get a faster level first: brotli quality 7 takes about 4 s on the workbench's
 * 21 MB bundle, quality 4 about 1 s for a copy a tenth larger.
 */
export const LARGE_FILE_BYTES = 1024 * 1024;

export function preferredEncoding(header: string | string[] | undefined): CompressionEncoding | undefined {
	const value = Array.isArray(header) ? header.join(',') : header ?? '';
	return /\bbr\b/.test(value) ? 'br' : /\bgzip\b/.test(value) ? 'gzip' : undefined;
}

/** The level a copy is made at: quick for a large file's first copy, the smallest one (`best`) after. */
export function compressionLevel(encoding: CompressionEncoding, size: number, best: boolean): number {
	if (best) {
		return encoding === 'br' ? zlib.constants.BROTLI_MAX_QUALITY : zlib.constants.Z_BEST_COMPRESSION;
	}
	if (encoding === 'br') {
		return size > LARGE_FILE_BYTES ? 4 : 7;
	}
	return size > LARGE_FILE_BYTES ? 5 : 7;
}

export function compress(contents: Buffer, encoding: CompressionEncoding, level: number): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => encoding === 'br'
		? zlib.brotliCompress(contents, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length } }, (err, out) => err ? reject(err) : resolve(out))
		: zlib.gzip(contents, { level }, (err, out) => err ? reject(err) : resolve(out)));
}

export interface ICompressedCopy {
	readonly data: Promise<Buffer>;
	/** The copy, once made; a large file's smallest copy replaces its quick one when that is made. */
	readonly ready?: Buffer;
}

interface IEntry extends ICompressedCopy {
	readonly mtime: number;
	ready?: Buffer;
	upgrading?: boolean;
}

/**
 * Compressed copies of the files the server sends, by path and modification time.
 *
 * A phone opening the web IDE for the first time downloads the workbench's bundle, which a
 * large file's quick copy (brotli 4) made 5.8 MB; the smallest copy (brotli 11, 4.6 MB) takes
 * most of a minute of one core to make, too long to wait for. So the quick copy is sent at once,
 * and when a device that is not this computer asks for a large file, its smallest copy is made in
 * the background, one file at a time, and kept on disk (`cacheDir`) for the next server too.
 */
export class CompressedCopies {

	private readonly entries = new Map<string, IEntry>();
	private upgrades: Promise<void> = Promise.resolve();

	constructor(private readonly cacheDir: string | undefined, private readonly compressor: typeof compress = compress) { }

	/** `upgrade`: a large file's smallest copy is wanted (a remote device asked). */
	copy(file: string, mtime: number, encoding: CompressionEncoding, upgrade: boolean): ICompressedCopy {
		const key = `${encoding}:${file}`;
		let entry = this.entries.get(key);
		if (!entry || entry.mtime !== mtime) {
			const data = this.make(file, mtime, encoding);
			const made: IEntry = { mtime, data };
			entry = made;
			this.entries.set(key, made);
			data.then(out => made.ready ??= out, () => this.entries.delete(key));
		}
		if (upgrade && !entry.upgrading) {
			entry.upgrading = true;
			const target = entry;
			this.upgrades = this.upgrades.then(() => this.upgrade(file, mtime, encoding, target)).catch(() => { });
		}
		return entry;
	}

	/** Resolves once every upgrade asked for so far is done (for tests). */
	whenUpgraded(): Promise<void> {
		return this.upgrades;
	}

	private async make(file: string, mtime: number, encoding: CompressionEncoding): Promise<Buffer> {
		const contents = await fs.readFile(file);
		if (contents.length > LARGE_FILE_BYTES) {
			const kept = await this.readCache(file, mtime, contents.length, encoding);
			if (kept) {
				return kept;
			}
		}
		return this.compressor(contents, encoding, compressionLevel(encoding, contents.length, false));
	}

	private async upgrade(file: string, mtime: number, encoding: CompressionEncoding, entry: IEntry): Promise<void> {
		const contents = await fs.readFile(file);
		if (contents.length <= LARGE_FILE_BYTES || this.entries.get(`${encoding}:${file}`) !== entry) {
			return;
		}
		if (await this.readCache(file, mtime, contents.length, encoding)) {
			// The quick copy came from the cache already: it is the smallest one.
			return;
		}
		const best = await this.compressor(contents, encoding, compressionLevel(encoding, contents.length, true));
		if (this.entries.get(`${encoding}:${file}`) === entry) {
			entry.ready = best;
		}
		await this.writeCache(file, mtime, contents.length, encoding, best);
	}

	private cacheName(file: string, mtime: number, size: number, encoding: CompressionEncoding): { prefix: string; name: string } {
		const prefix = createHash('sha1').update(`${encoding}:${file}`).digest('hex').slice(0, 20);
		return { prefix, name: `${prefix}-${size.toString(36)}-${Math.floor(mtime).toString(36)}.${encoding}` };
	}

	private async readCache(file: string, mtime: number, size: number, encoding: CompressionEncoding): Promise<Buffer | undefined> {
		if (!this.cacheDir) {
			return undefined;
		}
		try {
			return await fs.readFile(join(this.cacheDir, this.cacheName(file, mtime, size, encoding).name));
		} catch {
			return undefined;
		}
	}

	private async writeCache(file: string, mtime: number, size: number, encoding: CompressionEncoding, data: Buffer): Promise<void> {
		if (!this.cacheDir) {
			return;
		}
		const { prefix, name } = this.cacheName(file, mtime, size, encoding);
		await fs.mkdir(this.cacheDir, { recursive: true });
		// Older copies of the same file (an earlier version of the app) go.
		for (const old of await fs.readdir(this.cacheDir)) {
			if (old.startsWith(`${prefix}-`) && old !== name) {
				await fs.rm(join(this.cacheDir, old), { force: true });
			}
		}
		const temp = join(this.cacheDir, `${name}.${process.pid}.tmp`);
		await fs.writeFile(temp, data);
		await fs.rename(temp, join(this.cacheDir, name));
	}
}
