/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { basename, join } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';

const brotliCompress = promisify(zlib.brotliCompress);

/** Smaller files are cheap to compress in memory on each start; bigger ones are worth keeping. */
export const STATIC_CACHE_MIN_BYTES = 1024 * 1024;

/** Files brotli should not treat as text. */
const BINARY = /\.(wasm|ttf|otf|woff2?)$/i;

interface ILoaded {
	readonly name: string;
	/** Undefined while the copy is not on disk (it is being made, or could not be). */
	readonly data: Promise<Buffer | undefined>;
}

/**
 * Brotli at its best (quality 11, a 16 MB window) for a release's big static files: the browser
 * workbench's 22 MB bundle shrinks well past what the per-start in-memory copy gets, but takes far
 * too long to make on a request. Copies are made in the background, one at a time, on libuv's
 * threadpool, and kept on disk under `<serverDir>/static-cache`, named by the file's path, size
 * and modification time, so they survive restarts and a changed file (an update) gets a new one.
 * Only for files that never change under the same size and time: the server uses it for a
 * release's workbench, never in a dev checkout.
 */
export class ServerStaticCache extends Disposable {

	/** By source path: the copy for the size and time last asked for. */
	private readonly loaded = new Map<string, ILoaded>();
	/** Entry names waiting to be made or being made. */
	private readonly pending = new Set<string>();
	/** Entry names that could not be made: not tried again until the next start. */
	private readonly failed = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(
		private readonly dir: string,
		private readonly logService: ILogService,
		private readonly minBytes = STATIC_CACHE_MIN_BYTES,
	) {
		super();
		this._register(toDisposable(() => { this.disposed = true; }));
	}

	/**
	 * The stored copy of `file` at this size and modification time. Undefined at once when there is
	 * none yet (the caller serves its usual copy), and it is made in the background for next time.
	 */
	async get(file: string, size: number, mtimeMs: number): Promise<Buffer | undefined> {
		if (size <= this.minBytes) {
			return undefined;
		}
		const name = entryName(file, size, mtimeMs);
		let loaded = this.loaded.get(file);
		if (loaded?.name !== name) {
			loaded = { name, data: fs.readFile(join(this.dir, name)).then(data => data.length ? data : undefined, () => undefined) };
			this.loaded.set(file, loaded);
		}
		const data = await loaded.data;
		if (!data) {
			this.schedule(file, size, mtimeMs, name);
		}
		return data;
	}

	/** Loads or makes the copies of `files` (those big enough), one at a time. Resolves once all are done. */
	async warm(files: readonly string[]): Promise<void> {
		for (const file of files) {
			const stat = await fs.stat(file).catch(() => undefined);
			if (stat?.isFile()) {
				await this.get(file, stat.size, stat.mtimeMs);
			}
		}
		await this.whenIdle();
	}

	/** Resolves once nothing is waiting to be made. */
	async whenIdle(): Promise<void> {
		let queue: Promise<void>;
		do {
			queue = this.queue;
			await queue;
		} while (queue !== this.queue);
	}

	private schedule(file: string, size: number, mtimeMs: number, name: string): void {
		if (this.disposed || this.pending.has(name) || this.failed.has(name)) {
			return;
		}
		this.pending.add(name);
		this.queue = this.queue
			.then(() => this.make(file, size, mtimeMs, name))
			.catch(err => {
				this.failed.add(name);
				this.logService.warn(`[volt agent server] could not store a compressed copy of ${file}`, err);
			})
			.finally(() => this.pending.delete(name));
	}

	private async make(file: string, size: number, mtimeMs: number, name: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		const contents = await fs.readFile(file);
		const stat = await fs.stat(file);
		if (contents.length !== size || stat.size !== size || Math.floor(stat.mtimeMs) !== Math.floor(mtimeMs)) {
			// It changed since it was asked for: its new version is made when that is asked for.
			return;
		}
		const started = Date.now();
		const data = await brotliCompress(contents, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
				// The largest window a browser's decoder takes (2^24 bytes).
				[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length,
				[zlib.constants.BROTLI_PARAM_MODE]: BINARY.test(file) ? zlib.constants.BROTLI_MODE_GENERIC : zlib.constants.BROTLI_MODE_TEXT,
			},
		});
		const took = Date.now() - started;
		if (this.disposed) {
			return;
		}
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const target = join(this.dir, name);
		const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		try {
			await fs.writeFile(tmp, data, { mode: 0o600 });
			await fs.rename(tmp, target);
		} catch (err) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw err;
		}
		if (this.loaded.get(file)?.name === name) {
			this.loaded.set(file, { name, data: Promise.resolve(data) });
		}
		await this.prune(name);
		this.logService.info(`[volt agent server] stored ${basename(file)} at brotli 11: ${size} → ${data.length} bytes in ${took} ms`);
	}

	/** Removes the same file's other copies (older versions, a crashed write's temp file). */
	private async prune(keep: string): Promise<void> {
		const prefix = keep.slice(0, keep.indexOf('-') + 1);
		const names = await fs.readdir(this.dir).catch(() => [] as string[]);
		await Promise.all(names
			.filter(name => name.startsWith(prefix) && name !== keep)
			.map(name => fs.rm(join(this.dir, name), { force: true }).catch(() => undefined)));
	}
}

/** `<hash of the path>-<size>-<mtime>.br`: the path's copies share the prefix. */
export function entryName(file: string, size: number, mtimeMs: number): string {
	const hash = createHash('sha256').update(file).digest('hex').slice(0, 24);
	return `${hash}-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}.br`;
}
