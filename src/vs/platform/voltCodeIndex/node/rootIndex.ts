/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import parcelWatcher from '@parcel/watcher';
import { parse as parseGlob, ParsedPattern } from '../../../base/common/glob.js';
import { isAbsolute, join, normalize, relative, sep } from '../../../base/common/path.js';
import { isLinux, isWindows } from '../../../base/common/platform.js';
import { FuzzyPathIndex } from '../common/fuzzyPath.js';
import { SymbolNameIndex } from '../common/symbolNameIndex.js';
import { literalTrigramQuery, regexTrigramQuery, toByteString, TrigramQuery } from '../common/regexQuery.js';
import { extractSymbols, hasSymbolRules, SYMBOL_KINDS } from '../common/symbolExtract.js';
import { createJsMatcher, IJsMatcher, matchText } from '../common/textMatch.js';
import { IVoltCodeIndexFileHits, IVoltCodeIndexFilesRequest, IVoltCodeIndexFilesResult, IVoltCodeIndexFindFilesRequest, IVoltCodeIndexFindFilesResult, IVoltCodeIndexOptions, IVoltCodeIndexSearchRequest, IVoltCodeIndexSearchResult, IVoltCodeIndexStatus, IVoltCodeIndexSymbolsRequest, IVoltCodeIndexSymbolsResult, IVoltCodeSymbol, VoltCodeIndexState, VoltCodeSymbolKind } from '../common/voltCodeIndex.js';
import { deleteSegment, ISegmentSymbols, mergeSegments, NEXT_BIT, PostingCache, releaseBuildMemory, rotl8, Segment, SegmentBuilder, TrigramTable, trigramBits } from './indexFormat.js';
import { IGNORE_FILE_NAMES, listFiles, searchFiles } from './ripgrep.js';

/** Text files up to this size are indexed; larger ones are always searched directly. */
const MAX_INDEXED_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1_000_000;
/** Files too large to index whose trigram bitsets (2 MB each) are kept, so searches can skip them. */
const MAX_LARGE_BITSETS = 16;
/** A broken index tries again after this long (a full disk, too many open files, a lost watcher). */
const HEAL_AFTER_MS = 60_000;
/** Errors no retry can fix: the index stays off for this folder and searches use ripgrep. */
class PermanentIndexError extends Error { }
/** Postings held in memory while building, before they are written as a segment (~16 MB). */
const BUILDER_POSTINGS = 2_000_000;
const FLUSH_DELAY_MS = 1_500;
const FLUSH_AT = 256;
const RELIST_DELAY_MS = 1_500;
const COMPACT_SEGMENTS = 8;
const COMPACT_DEAD_RATIO = 0.25;
/** Above this many candidates the index is not selective enough to beat ripgrep's full scan. */
const RG_VERIFY_MAX = 4_000;
/**
 * A pattern found in most files (`return`, `import`) fills the match limit within the first few
 * of them: those are read in-process and the search stops, where ripgrep would read every file.
 * When this many files do not fill the limit, ripgrep runs as before.
 */
const EARLY_SCAN_FILES = 512;
/** When the index rules out less than this share of the files, a plain ripgrep scan is faster. */
const UNSELECTIVE_RATIO = 0.35;
const POSTING_CACHE_BYTES = 24 * 1024 * 1024;
const SYMBOLS_TTL_MS = 3 * 60_000;
const READ_AHEAD = 16;
const MAX_KNOWN_IGNORED = 20_000;
const LOAD_WAIT_MS = 8_000;

const MANIFEST = 'manifest.json';
const MANIFEST_VERSION = 1;

/** Changing any of these changes which files ripgrep lists. */
const IGNORE_SOURCES = new Set(['.gitignore', '.ignore', '.rgignore', ...IGNORE_FILE_NAMES]);

/** The trigram table is reused by every build in the process (builds never interleave mid-file). */
const sharedTable = new TrigramTable();

interface IManifest {
	readonly version: number;
	readonly root: string;
	readonly optionsKey: string;
	readonly nextId: number;
	readonly segments: readonly number[];
	/** Dead documents per segment id. */
	readonly tombstones: Readonly<Record<string, readonly number[]>>;
	/** Text files too large to index, searched directly. */
	readonly large: readonly string[];
	/** Binary files: listed for glob, never searched. */
	readonly binary?: readonly string[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastUsedAt: number;
	readonly stats?: { readonly files: number; readonly bytes: number; readonly symbols: number; readonly diskBytes: number };
}

type ReadResult =
	| { readonly kind: 'text'; readonly bytes: Buffer; readonly size: number; readonly mtime: number }
	| { readonly kind: 'large' }
	| { readonly kind: 'binary' }
	| { readonly kind: 'missing' };

interface ILocation {
	readonly seg: Segment;
	readonly doc: number;
}

interface IWatcherEvent {
	readonly path: string;
	readonly type: 'create' | 'update' | 'delete';
}

const EMPTY = new Uint32Array(0);

function yieldToLoop(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

function hasNul(bytes: Uint8Array, limit = 8192): boolean {
	const end = Math.min(bytes.length, limit);
	for (let i = 0; i < end; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

function utf16Bom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return 'utf-16le';
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		return 'utf-16be';
	}
	return undefined;
}

function intersect(a: Uint32Array, b: Uint32Array): Uint32Array {
	if (a.length > b.length) {
		[a, b] = [b, a];
	}
	// A short list against a long one (a rare trigram and `the`): look each doc up instead of
	// walking the long list. O(a log b) instead of O(a + b).
	if (a.length * 16 < b.length) {
		const out = new Uint32Array(a.length);
		let n = 0;
		let from = 0;
		for (let i = 0; i < a.length; i++) {
			from = seek(b, a[i], from);
			if (from >= b.length) {
				break;
			}
			if (b[from] === a[i]) {
				out[n++] = a[i];
			}
		}
		return out.subarray(0, n);
	}
	const out = new Uint32Array(Math.min(a.length, b.length));
	let i = 0, j = 0, n = 0;
	while (i < a.length && j < b.length) {
		const x = a[i], y = b[j];
		if (x === y) {
			out[n++] = x;
			i++;
			j++;
		} else if (x < y) {
			i++;
		} else {
			j++;
		}
	}
	return out.subarray(0, n);
}

function unionAll(lists: readonly Uint32Array[]): Uint32Array {
	if (lists.length === 1) {
		return lists[0];
	}
	const seen = new Set<number>();
	for (const list of lists) {
		for (const doc of list) {
			seen.add(doc);
		}
	}
	return Uint32Array.from([...seen].sort((a, b) => a - b));
}

/**
 * An AND drops each phrase another of its phrases contains (`em_c` next to `em_cache`): the longer
 * one already requires it. Dropping an operand of an AND only widens the candidates, which are
 * always checked against the files, so this can save work but never lose a match.
 */
function withoutContainedPhrases(query: TrigramQuery): TrigramQuery {
	if (query.op !== 'and') {
		return query;
	}
	const phrases = query.sub.filter(sub => sub.op === 'phrase').map(sub => (sub as { readonly text: string }).text);
	const sub = query.sub.filter(part => part.op !== 'phrase' || !phrases.some(other => other !== part.text && other.length > part.text.length && other.includes(part.text)));
	// Equal phrases: keep the first.
	const seen = new Set<string>();
	const unique = sub.filter(part => part.op !== 'phrase' || (seen.has(part.text) ? false : (seen.add(part.text), true)));
	return unique.length === query.sub.length ? query : { ...query, sub: unique };
}

/** Whether a document with these trigrams can satisfy `query` (adjacency is not checked: a superset). */
function bitsMayMatch(query: TrigramQuery, bits: Uint8Array): boolean {
	switch (query.op) {
		case 'all':
			return true;
		case 'none':
			return false;
		case 'and':
			return query.sub.every(sub => bitsMayMatch(sub, bits));
		case 'or':
			return query.sub.some(sub => bitsMayMatch(sub, bits));
		case 'phrase':
			for (let i = 0; i + 2 < query.text.length; i++) {
				const key = (query.text.charCodeAt(i) << 16) | (query.text.charCodeAt(i + 1) << 8) | query.text.charCodeAt(i + 2);
				if (!(bits[key >>> 3] & (1 << (key & 7)))) {
					return false;
				}
			}
			return true;
	}
}

/** The first index at or after `from` whose doc is >= `doc`. */
function seek(docs: Uint32Array, doc: number, from: number): number {
	let lo = from;
	let hi = docs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (docs[mid] < doc) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A path set that counts its changes, so derived lookups (the fuzzy index) know when they are stale. */
class FileSet extends Set<string> {
	private changes: number | undefined;

	get version(): number {
		return this.changes ?? 0;
	}

	override add(path: string): this {
		if (!this.has(path)) {
			this.changes = (this.changes ?? 0) + 1;
		}
		return super.add(path);
	}

	override delete(path: string): boolean {
		const deleted = super.delete(path);
		if (deleted) {
			this.changes = (this.changes ?? 0) + 1;
		}
		return deleted;
	}

	override clear(): void {
		this.changes = (this.changes ?? 0) + 1;
		super.clear();
	}
}

/** One segment's symbols, with a name lookup built on the first query that needs it. */
interface ISymbolTable {
	readonly syms: ISegmentSymbols;
	names?: SymbolNameIndex;
}

function namesOf(table: ISymbolTable): SymbolNameIndex {
	return table.names ??= new SymbolNameIndex(table.syms.names);
}

export function optionsKey(options: IVoltCodeIndexOptions | undefined): string {
	return JSON.stringify({ h: !!options?.hierarchicalIgnore, s: !!options?.ignoreSymlinks });
}

/**
 * The index of one folder: its segments on disk, which of their documents are still current,
 * and the files changed since (searched directly until they are indexed again).
 */
export class RootIndex {

	private state: VoltCodeIndexState = 'none';
	private error: string | undefined;
	private progress: { done: number; total: number } | undefined;
	private started: Promise<void> | undefined;
	private disposed = false;
	/** Bumped by rebuild and dispose; work started under an older generation stops. */
	private generation = 0;

	private manifest: IManifest | undefined;
	private segments: Segment[] = [];
	private readonly dead = new Map<number, Uint8Array>();
	private deadCount = 0;

	/** Every file ripgrep lists, of any kind. */
	private listed = new FileSet();
	/** `listed` prepared for fuzzy search, rebuilt when the list changed. */
	private fuzzy: { readonly of: FileSet; readonly version: number; readonly index: FuzzyPathIndex } | undefined;
	/** Indexed files and where their current document is. */
	private readonly live = new Map<string, ILocation>();
	private readonly large = new Set<string>();
	private readonly binary = new Set<string>();
	/** Changed since indexed: searched directly until flushed into a new segment. */
	private readonly dirty = new Set<string>();
	private readonly inFlight = new Set<string>();
	/** Created or changed paths ripgrep has not listed yet (maybe ignored). */
	private readonly pendingCreates = new Set<string>();
	/** Paths a relist showed to be ignored. */
	private readonly knownIgnored = new Set<string>();
	private fullRelistNeeded = false;
	private touchedWhileCompacting: Set<string> | undefined;

	private relisting: Promise<void> | undefined;
	private relistTimer: ReturnType<typeof setTimeout> | undefined;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private compacting = false;
	private watcher: parcelWatcher.AsyncSubscription | undefined;
	/**
	 * The root with symlinks resolved. File watchers report real paths (macOS: `/private/var/...`
	 * for a root opened as `/var/...`); matched only against `root`, every event would be dropped
	 * and new or edited files would silently stop being search candidates.
	 */
	private realRoot: string | undefined;

	private readonly cache = new PostingCache(POSTING_CACHE_BYTES);
	private symbolCache: { readonly bySegment: Map<number, ISymbolTable>; timer: ReturnType<typeof setTimeout> } | undefined;
	private lastSearchMs: number | undefined;
	private waiters: (() => void)[] = [];
	private permanent = false;
	/** Trigram bitsets of files too large to index, valid while their size and time are unchanged. */
	private readonly largeBits = new Map<string, { readonly size: number; readonly mtime: number; readonly bits: Uint8Array }>();
	private lastHealAt = 0;
	lastUsedAt = Date.now();

	constructor(
		readonly root: string,
		private readonly dir: string,
		private options: IVoltCodeIndexOptions,
		private readonly onChange: () => void,
		private readonly log: (message: string) => void,
	) { }

	get key(): string {
		return optionsKey(this.options);
	}

	//#region Lifecycle

	/** Loads or builds the index (once) and keeps it fresh. */
	start(options?: IVoltCodeIndexOptions): Promise<void> {
		this.lastUsedAt = Date.now();
		if (options && optionsKey(options) !== this.key) {
			this.options = options;
			return this.rebuild();
		}
		if (!this.started) {
			const generation = this.generation;
			this.state = 'indexing';
			this.started = this.open(generation).catch(err => this.fail(err, generation));
		}
		return this.started;
	}

	rebuild(): Promise<void> {
		const generation = ++this.generation;
		this.started = this.resetAndBuild(generation).catch(err => this.fail(err, generation));
		return this.started;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.generation++;
		clearTimeout(this.flushTimer);
		clearTimeout(this.relistTimer);
		this.dropSymbols();
		await this.watcher?.unsubscribe().catch(() => undefined);
		this.watcher = undefined;
		await this.closeSegments(this.segments);
		this.segments = [];
		this.cache.clear();
	}

	private fail(err: unknown, generation: number): void {
		if (this.disposed || generation !== this.generation) {
			return;
		}
		this.state = 'error';
		this.error = err instanceof Error ? err.message : String(err);
		this.permanent = err instanceof PermanentIndexError;
		this.progress = undefined;
		this.log(`[code index] ${this.root}: ${this.error}`);
		this.changed();
	}

	/**
	 * Builds the index again, at most once a minute: after a failed build, or when a query found
	 * its files on disk gone or unreadable. Until then searches fall back to ripgrep.
	 */
	private heal(reason: string): void {
		if (this.disposed || this.permanent || Date.now() - this.lastHealAt < HEAL_AFTER_MS) {
			return;
		}
		this.lastHealAt = Date.now();
		this.log(`[code index] ${this.root}: rebuilding (${reason})`);
		void this.rebuild();
	}

	/** A query failed: an I/O error means the index on disk changed under it, so rebuild it. */
	private queryFailed(err: unknown): { readonly kind: 'fallback'; readonly reason: string } {
		const code = (err as { code?: unknown } | undefined)?.code;
		if (typeof code === 'string' && /^(ENOENT|EIO|EBADF|EISDIR|ENOTDIR)$/.test(code)) {
			this.heal(`index files unreadable: ${code}`);
		}
		return { kind: 'fallback', reason: `index: ${err instanceof Error ? err.message : err}` };
	}

	/** Tells the engine and anyone waiting in `prepare` that the state moved. */
	private changed(): void {
		this.onChange();
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	private waitForChange(ms: number): Promise<void> {
		return new Promise(resolve => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.waiters.push(done);
		});
	}

	/** Old segments stay open a while: a search that started before a swap may still read them. */
	private retire(segments: readonly Segment[]): void {
		if (!segments.length) {
			return;
		}
		setTimeout(() => {
			void (async () => {
				await this.closeSegments(segments);
				for (const segment of segments) {
					await deleteSegment(this.dir, segment.id).catch(() => undefined);
				}
			})();
		}, 30_000);
	}

	private async open(generation: number): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		const manifest = await this.readManifest();
		if (manifest && manifest.version === MANIFEST_VERSION && manifest.optionsKey === this.key && manifest.root === this.root) {
			try {
				await this.load(manifest, generation);
				return;
			} catch (err) {
				this.log(`[code index] ${this.root}: rebuilding, the index on disk could not be read (${err instanceof Error ? err.message : err})`);
			}
		}
		await this.resetAndBuild(generation);
	}

	private async readManifest(): Promise<IManifest | undefined> {
		try {
			return JSON.parse(await fs.readFile(join(this.dir, MANIFEST), 'utf8')) as IManifest;
		} catch {
			return undefined;
		}
	}

	private async writeManifest(next: Omit<IManifest, 'version' | 'root' | 'optionsKey' | 'updatedAt' | 'lastUsedAt' | 'stats'>): Promise<void> {
		let diskBytes = 0;
		for (const segment of this.segments) {
			diskBytes += await segment.diskBytes();
		}
		const manifest: IManifest = {
			...next,
			version: MANIFEST_VERSION,
			root: this.root,
			optionsKey: this.key,
			updatedAt: Date.now(),
			lastUsedAt: this.lastUsedAt,
			stats: { files: this.live.size, bytes: this.indexedBytes(), symbols: this.manifest?.stats?.symbols ?? 0, diskBytes },
		};
		const tmp = join(this.dir, `${MANIFEST}.tmp`);
		await fs.writeFile(tmp, JSON.stringify(manifest));
		await fs.rename(tmp, join(this.dir, MANIFEST));
		this.manifest = manifest;
	}

	private persistTombstones(): Promise<void> {
		const tombstones: Record<string, number[]> = {};
		for (const [id, bits] of this.dead) {
			const docs: number[] = [];
			for (let doc = 0; doc < bits.length; doc++) {
				if (bits[doc]) {
					docs.push(doc);
				}
			}
			if (docs.length) {
				tombstones[id] = docs;
			}
		}
		return this.writeManifest({
			nextId: this.manifest?.nextId ?? 1,
			segments: this.segments.map(segment => segment.id),
			tombstones,
			large: [...this.large],
			binary: [...this.binary],
			createdAt: this.manifest?.createdAt ?? Date.now(),
		});
	}

	private async load(manifest: IManifest, generation: number): Promise<void> {
		this.state = 'indexing';
		this.changed();
		const segments: Segment[] = [];
		try {
			for (const id of manifest.segments) {
				segments.push(await Segment.open(this.dir, id));
			}
		} catch (err) {
			await this.closeSegments(segments);
			throw err;
		}
		if (generation !== this.generation) {
			await this.closeSegments(segments);
			return;
		}
		this.manifest = manifest;
		this.install(segments, manifest.tombstones);
		for (const path of manifest.large) {
			this.large.add(path);
		}
		for (const path of manifest.binary ?? []) {
			this.binary.add(path);
		}
		this.listed = new FileSet([...this.live.keys(), ...this.large, ...this.binary]);
		await this.removeStrayFiles(manifest.segments);
		// Catch up with what changed while nothing was watching: ripgrep's list, then sizes and times.
		await this.startWatcher(generation);
		this.fullRelistNeeded = true;
		await this.relist();
		if (generation !== this.generation) {
			return;
		}
		this.state = 'ready';
		this.changed();
	}

	/** Makes `segments` the current index (documents later in the list win). */
	private install(segments: Segment[], tombstones: Readonly<Record<string, readonly number[]>>): void {
		this.segments = segments;
		this.live.clear();
		this.dead.clear();
		this.deadCount = 0;
		for (const segment of segments) {
			const bits = new Uint8Array(segment.docCount);
			for (const doc of tombstones[segment.id] ?? []) {
				if (doc < bits.length && !bits[doc]) {
					bits[doc] = 1;
					this.deadCount++;
				}
			}
			this.dead.set(segment.id, bits);
			for (let doc = 0; doc < segment.docCount; doc++) {
				if (bits[doc]) {
					continue;
				}
				const path = segment.docs.paths[doc];
				const old = this.live.get(path);
				if (old) {
					this.kill(old);
				}
				this.live.set(path, { seg: segment, doc });
			}
		}
	}

	private async removeStrayFiles(keep: readonly number[]): Promise<void> {
		const keepIds = new Set(keep);
		for (const name of await fs.readdir(this.dir).catch(() => [] as string[])) {
			const id = /^(\d+)\./.exec(name)?.[1];
			if (id && !keepIds.has(Number(id))) {
				await fs.rm(join(this.dir, name), { force: true });
			}
		}
	}

	private async closeSegments(segments: readonly Segment[]): Promise<void> {
		await Promise.all(segments.map(segment => segment.close()));
	}

	private async resetAndBuild(generation: number): Promise<void> {
		this.state = 'indexing';
		this.error = undefined;
		this.progress = { done: 0, total: 0 };
		this.changed();
		await this.watcher?.unsubscribe().catch(() => undefined);
		this.watcher = undefined;
		const old = this.segments;
		this.segments = [];
		await this.closeSegments(old);
		this.live.clear();
		this.dead.clear();
		this.deadCount = 0;
		this.large.clear();
		this.largeBits.clear();
		this.binary.clear();
		this.dirty.clear();
		this.inFlight.clear();
		this.pendingCreates.clear();
		this.knownIgnored.clear();
		this.cache.clear();
		this.dropSymbols();
		await fs.rm(this.dir, { recursive: true, force: true });
		await fs.mkdir(this.dir, { recursive: true });

		// Watch first, so nothing that changes during the build is missed.
		await this.startWatcher(generation);
		const listed = await listFiles(this.root, this.options, MAX_FILES);
		if (listed.truncated) {
			throw new PermanentIndexError(`more than ${MAX_FILES.toLocaleString()} files; searches use ripgrep`);
		}
		this.listed = new FileSet(listed.paths);
		const paths = [...listed.paths].sort(comparePaths);
		this.progress = { done: 0, total: paths.length };
		let nextId = 1;
		const built = await this.indexPaths(paths, () => nextId++, generation, done => {
			this.progress = { done, total: paths.length };
			this.changed();
		});
		if (generation !== this.generation) {
			return;
		}
		let segments: Segment[] = [];
		for (const id of built.ids) {
			segments.push(await Segment.open(this.dir, id));
		}
		if (segments.length > 1) {
			const id = nextId++;
			await mergeSegments(this.dir, id, segments.map(segment => ({ segment, live: () => true })));
			await this.closeSegments(segments);
			for (const segment of segments) {
				await deleteSegment(this.dir, segment.id);
			}
			segments = [await Segment.open(this.dir, id)];
		}
		if (generation !== this.generation) {
			await this.closeSegments(segments);
			return;
		}
		this.install(segments, {});
		for (const path of built.large) {
			this.large.add(path);
		}
		for (const path of built.binary) {
			this.binary.add(path);
		}
		for (const path of built.missing) {
			this.listed.delete(path);
		}
		this.manifest = { version: MANIFEST_VERSION, root: this.root, optionsKey: this.key, nextId, segments: [], tombstones: {}, large: [], createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: this.lastUsedAt, stats: { files: 0, bytes: 0, symbols: built.symbols, diskBytes: 0 } };
		// Files that changed while being read were marked dirty by the watcher already.
		for (const path of this.dirty) {
			const at = this.live.get(path);
			if (at) {
				this.kill(at);
				this.live.delete(path);
			}
		}
		await this.persistTombstones();
		this.progress = undefined;
		this.state = 'ready';
		this.changed();
		this.scheduleFlush();
		this.log(`[code index] ${this.root}: indexed ${this.live.size.toLocaleString()} files`);
	}

	//#endregion

	//#region Indexing

	private async readForIndex(path: string): Promise<ReadResult> {
		const abs = join(this.root, path);
		let stat;
		try {
			stat = await fs.stat(abs);
		} catch {
			return { kind: 'missing' };
		}
		if (!stat.isFile()) {
			return { kind: 'missing' };
		}
		if (stat.size > MAX_INDEXED_BYTES) {
			const head = new Uint8Array(8192);
			const file = await fs.open(abs, 'r');
			try {
				const { bytesRead } = await file.read(head, 0, head.length, 0);
				const bytes = head.subarray(0, bytesRead);
				return hasNul(bytes) && !utf16Bom(bytes) ? { kind: 'binary' } : { kind: 'large' };
			} finally {
				await file.close();
			}
		}
		const bytes = await fs.readFile(abs);
		if (utf16Bom(bytes)) {
			return { kind: 'large' }; // ripgrep transcodes these; search them directly
		}
		if (hasNul(bytes)) {
			return { kind: 'binary' };
		}
		return { kind: 'text', bytes, size: stat.size, mtime: Math.round(stat.mtimeMs) };
	}

	/**
	 * Reads and indexes `paths` in order into new segments (as many as the postings budget needs).
	 * Yields often, so searches keep running while it works.
	 */
	private async indexPaths(paths: readonly string[], nextId: () => number, generation: number, onProgress?: (done: number) => void): Promise<{ ids: number[]; large: string[]; binary: string[]; missing: string[]; symbols: number }> {
		const ids: number[] = [];
		const large: string[] = [];
		const binary: string[] = [];
		const missing: string[] = [];
		let symbols = 0;
		// Small batches (a few changed files) get a small builder; the builder grows for a big file.
		let builder = new SegmentBuilder(Math.min(BUILDER_POSTINGS, Math.max(65_536, paths.length * 4_000)));
		const window: Promise<ReadResult>[] = [];
		let next = 0;
		const fill = () => {
			while (window.length < READ_AHEAD && next < paths.length) {
				window.push(this.readForIndex(paths[next++]).catch((): ReadResult => ({ kind: 'missing' })));
			}
		};
		const writeBuilder = async () => {
			if (builder.docCount) {
				const id = nextId();
				await builder.write(this.dir, id);
				ids.push(id);
			}
			builder = new SegmentBuilder(Math.min(BUILDER_POSTINGS, Math.max(65_536, (paths.length - next) * 4_000)));
		};
		fill();
		let lastYield = Date.now();
		for (let i = 0; i < paths.length; i++) {
			const read = await window.shift()!;
			fill();
			if (generation !== this.generation) {
				throw new Error('cancelled');
			}
			const path = paths[i];
			if (read.kind === 'missing') {
				missing.push(path);
			} else if (read.kind === 'binary') {
				binary.push(path);
			} else if (read.kind === 'large') {
				large.push(path);
			} else {
				sharedTable.add(read.bytes);
				if (!builder.fits(sharedTable.count)) {
					// Writing awaits; collect the table again afterwards (another build may reuse it).
					await writeBuilder();
					sharedTable.add(read.bytes);
				}
				const found = hasSymbolRules(path) ? extractSymbols(path, read.bytes.toString('utf8')) : [];
				symbols += found.length;
				builder.addDoc(path, read.size, read.mtime, sharedTable, found);
			}
			if (Date.now() - lastYield > 12) {
				onProgress?.(i + 1);
				await yieldToLoop();
				lastYield = Date.now();
			}
		}
		await writeBuilder();
		sharedTable.release();
		releaseBuildMemory();
		onProgress?.(paths.length);
		return { ids, large, binary, missing, symbols };
	}

	private kill(at: ILocation): void {
		const bits = this.dead.get(at.seg.id);
		if (bits && !bits[at.doc]) {
			bits[at.doc] = 1;
			this.deadCount++;
		}
	}

	private markChanged(path: string): void {
		const at = this.live.get(path);
		if (at) {
			this.kill(at);
			this.live.delete(path);
		}
		this.large.delete(path);
		this.binary.delete(path);
		this.dirty.add(path);
		this.touchedWhileCompacting?.add(path);
		this.scheduleFlush();
	}

	private removePath(path: string): void {
		const at = this.live.get(path);
		if (at) {
			this.kill(at);
			this.live.delete(path);
		}
		this.listed.delete(path);
		this.large.delete(path);
		this.binary.delete(path);
		this.dirty.delete(path);
		this.touchedWhileCompacting?.add(path);
	}

	private scheduleFlush(): void {
		if (this.state !== 'ready' || this.disposed) {
			return;
		}
		clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => void this.flush(), this.dirty.size >= FLUSH_AT ? 0 : FLUSH_DELAY_MS);
	}

	/** Indexes the changed files into a new segment. */
	private async flush(): Promise<void> {
		if (this.flushing || this.compacting || !this.dirty.size || this.state !== 'ready' || this.disposed) {
			return;
		}
		this.flushing = true;
		const generation = this.generation;
		const batch = [...this.dirty].sort(comparePaths);
		this.dirty.clear();
		for (const path of batch) {
			this.inFlight.add(path);
		}
		try {
			let nextId = this.manifest?.nextId ?? 1;
			const built = await this.indexPaths(batch, () => nextId++, generation);
			if (generation !== this.generation) {
				return;
			}
			const added: Segment[] = [];
			for (const id of built.ids) {
				added.push(await Segment.open(this.dir, id));
			}
			for (const segment of added) {
				const bits = new Uint8Array(segment.docCount);
				this.dead.set(segment.id, bits);
				for (let doc = 0; doc < segment.docCount; doc++) {
					const path = segment.docs.paths[doc];
					const old = this.live.get(path);
					if (old) {
						this.kill(old);
					}
					if (this.dirty.has(path) || !this.listed.has(path)) {
						// Changed or removed again while this batch was read.
						bits[doc] = 1;
						this.deadCount++;
						this.live.delete(path);
					} else {
						this.live.set(path, { seg: segment, doc });
					}
				}
			}
			this.segments = [...this.segments, ...added];
			for (const path of built.large) {
				if (this.listed.has(path) && !this.dirty.has(path)) {
					this.large.add(path);
				}
			}
			for (const path of built.binary) {
				if (this.listed.has(path) && !this.dirty.has(path)) {
					this.binary.add(path);
				}
			}
			for (const path of built.missing) {
				if (!this.dirty.has(path)) {
					this.listed.delete(path);
				}
			}
			const stats = this.manifest!.stats;
			this.manifest = { ...this.manifest!, nextId, ...(stats ? { stats: { ...stats, symbols: stats.symbols + built.symbols } } : {}) };
			await this.persistTombstones();
			this.changed();
		} catch (err) {
			if (generation === this.generation) {
				for (const path of batch) {
					this.dirty.add(path);
				}
				this.log(`[code index] ${this.root}: update failed (${err instanceof Error ? err.message : err})`);
			}
		} finally {
			for (const path of batch) {
				this.inFlight.delete(path);
			}
			this.flushing = false;
		}
		if (this.dirty.size) {
			this.scheduleFlush();
		} else if (this.segments.length > COMPACT_SEGMENTS || this.deadCount > COMPACT_DEAD_RATIO * this.totalDocs()) {
			void this.compact();
		}
	}

	private totalDocs(): number {
		return this.segments.reduce((sum, segment) => sum + segment.docCount, 0);
	}

	/** Rewrites every segment's live documents as one segment. */
	private async compact(): Promise<void> {
		if (this.compacting || this.flushing || this.state !== 'ready' || this.segments.length < 2 && !this.deadCount) {
			return;
		}
		this.compacting = true;
		this.touchedWhileCompacting = new Set();
		const generation = this.generation;
		const old = this.segments;
		try {
			const id = this.manifest?.nextId ?? 1;
			const deadSnapshot = new Map([...this.dead].map(([segId, bits]) => [segId, bits.slice()]));
			await mergeSegments(this.dir, id, old.map(segment => ({ segment, live: doc => !deadSnapshot.get(segment.id)?.[doc] })));
			const merged = await Segment.open(this.dir, id);
			if (generation !== this.generation) {
				await merged.close();
				await deleteSegment(this.dir, id);
				return;
			}
			this.install([merged], {});
			for (const path of this.touchedWhileCompacting) {
				const at = this.live.get(path);
				if (at && (this.dirty.has(path) || this.inFlight.has(path) || !this.listed.has(path))) {
					this.kill(at);
					this.live.delete(path);
				}
			}
			this.manifest = { ...this.manifest!, nextId: id + 1 };
			this.cache.clear();
			await this.persistTombstones();
			this.retire(old);
			this.changed();
		} catch (err) {
			this.log(`[code index] ${this.root}: compaction failed (${err instanceof Error ? err.message : err})`);
		} finally {
			this.compacting = false;
			this.touchedWhileCompacting = undefined;
		}
		if (this.dirty.size) {
			this.scheduleFlush();
		}
	}

	//#endregion

	//#region Freshness

	private async startWatcher(generation: number): Promise<void> {
		if (this.watcher) {
			return;
		}
		const real = await fs.realpath(this.root).catch(() => this.root);
		this.realRoot = real !== this.root ? real : undefined;
		try {
			const subscription = await parcelWatcher.subscribe(this.root, (err, events) => {
				if (generation !== this.generation) {
					return;
				}
				if (err) {
					// Usually an overflow: some events were dropped. Re-list and re-check everything.
					this.fullRelistNeeded = true;
					this.scheduleRelist();
					return;
				}
				this.onEvents(events);
			}, {
				backend: isWindows ? 'windows' : isLinux ? 'inotify' : 'fs-events',
				ignore: ['.git', 'node_modules', '**/node_modules/**', '**/.git/**'],
			});
			if (generation !== this.generation) {
				await subscription.unsubscribe().catch(() => undefined);
				return;
			}
			this.watcher = subscription;
		} catch (err) {
			// Without a watcher the index cannot know about changes; searches fall back to ripgrep.
			throw new Error(`could not watch the folder (${err instanceof Error ? err.message : err})`);
		}
	}

	private relativePath(abs: string): string | undefined {
		for (const root of this.realRoot ? [this.root, this.realRoot] : [this.root]) {
			const rel = relative(root, abs);
			if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
				return sep === '/' ? rel : rel.split(sep).join('/');
			}
		}
		return undefined;
	}

	private onEvents(events: readonly IWatcherEvent[]): void {
		const deletedDirs = new Set<string>();
		for (const event of events) {
			const path = this.relativePath(event.path);
			if (!path || path === '.git' || path.startsWith('.git/') || path === 'node_modules' || path.startsWith('node_modules/') || path.includes('/node_modules/')) {
				continue;
			}
			const name = path.slice(path.lastIndexOf('/') + 1);
			if (IGNORE_SOURCES.has(name)) {
				this.fullRelistNeeded = true;
			}
			if (event.type === 'delete') {
				this.pendingCreates.delete(path);
				this.knownIgnored.delete(path);
				if (this.listed.has(path)) {
					this.removePath(path);
				} else {
					deletedDirs.add(path);
				}
			} else if (this.listed.has(path)) {
				this.markChanged(path);
			} else if (!this.knownIgnored.has(path)) {
				this.pendingCreates.add(path);
			}
		}
		if (deletedDirs.size) {
			for (const path of [...this.listed]) {
				for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) {
					if (deletedDirs.has(path.slice(0, slash))) {
						this.removePath(path);
						break;
					}
				}
			}
		}
		if (this.pendingCreates.size || this.fullRelistNeeded) {
			this.scheduleRelist();
		}
	}

	private scheduleRelist(): void {
		if (this.relistTimer || this.disposed) {
			return;
		}
		this.relistTimer = setTimeout(() => {
			this.relistTimer = undefined;
			void this.relist().catch(err => this.log(`[code index] ${this.root}: listing failed (${err instanceof Error ? err.message : err})`));
		}, RELIST_DELAY_MS);
	}

	/** Brings the file list up to date with ripgrep's; on a full relist, also checks sizes and times. */
	private relist(): Promise<void> {
		this.relisting ??= (async () => {
			try {
				const full = this.fullRelistNeeded;
				const pending = new Set(this.pendingCreates);
				this.fullRelistNeeded = false;
				this.pendingCreates.clear();
				const listed = await listFiles(this.root, this.options, MAX_FILES);
				if (listed.truncated) {
					throw new PermanentIndexError(`more than ${MAX_FILES.toLocaleString()} files; searches use ripgrep`);
				}
				const now = new Set(listed.paths);
				for (const path of [...this.listed]) {
					if (!now.has(path)) {
						this.removePath(path);
					}
				}
				for (const path of listed.paths) {
					if (!this.listed.has(path)) {
						this.listed.add(path);
						this.markChanged(path);
					}
				}
				if (this.knownIgnored.size > MAX_KNOWN_IGNORED) {
					this.knownIgnored.clear();
				}
				for (const path of pending) {
					if (!now.has(path)) {
						this.knownIgnored.add(path);
					}
				}
				if (full) {
					await this.statSweep();
				}
			} finally {
				this.relisting = undefined;
			}
		})();
		return this.relisting;
	}

	/** Files whose size or modification time differ from their indexed document. */
	private async statSweep(): Promise<void> {
		const entries = [...this.live.entries()];
		for (let i = 0; i < entries.length; i += 128) {
			await Promise.all(entries.slice(i, i + 128).map(async ([path, at]) => {
				const stat = await fs.stat(join(this.root, path)).catch(() => undefined);
				if (!stat) {
					this.removePath(path);
				} else if (this.live.get(path) === at && (stat.size !== at.seg.docs.sizes[at.doc] || Math.round(stat.mtimeMs) !== at.seg.docs.mtimes[at.doc])) {
					this.markChanged(path);
				}
			}));
		}
	}

	/**
	 * Waits until the index can answer: loaded, caught up, and new files listed. False when it
	 * cannot answer within `waitMs` (still building, or broken).
	 */
	private async prepare(waitMs: number | undefined): Promise<string | undefined> {
		this.lastUsedAt = Date.now();
		void this.start();
		const begun = Date.now();
		while (this.state !== 'ready' && this.state !== 'error') {
			// Loading an index from disk takes a moment and is worth waiting for; a first build is not.
			const loading = this.state === 'none' || !this.progress;
			const left = begun + (loading ? Math.max(waitMs ?? 0, LOAD_WAIT_MS) : (waitMs ?? 0)) - Date.now();
			if (left <= 0) {
				break;
			}
			await this.waitForChange(left);
		}
		if (this.state !== 'ready') {
			if (this.state === 'error') {
				this.heal(`retrying after: ${this.error}`);
				return `index error: ${this.error}`;
			}
			return 'indexing';
		}
		if (this.pendingCreates.size || this.fullRelistNeeded || this.relisting) {
			clearTimeout(this.relistTimer);
			this.relistTimer = undefined;
			try {
				await this.relist();
			} catch (err) {
				return `listing failed: ${err instanceof Error ? err.message : err}`;
			}
		}
		return undefined;
	}

	//#endregion

	//#region Queries

	private async evaluate(query: TrigramQuery, segment: Segment): Promise<Uint32Array | 'all'> {
		query = withoutContainedPhrases(query);
		switch (query.op) {
			case 'all':
				return 'all';
			case 'none':
				return EMPTY;
			case 'phrase':
				return this.phrase(query.text, segment);
			case 'and': {
				const parts = await Promise.all(query.sub.map(sub => this.evaluate(sub, segment)));
				let acc: Uint32Array | 'all' = 'all';
				for (const part of parts) {
					if (part !== 'all') {
						acc = acc === 'all' ? part : intersect(acc, part);
						if (!acc.length) {
							return EMPTY;
						}
					}
				}
				return acc;
			}
			case 'or': {
				const parts = await Promise.all(query.sub.map(sub => this.evaluate(sub, segment)));
				const lists: Uint32Array[] = [];
				for (const part of parts) {
					if (part === 'all') {
						return 'all';
					}
					lists.push(part);
				}
				return unionAll(lists);
			}
		}
	}

	/** Documents holding all trigrams of `text` next to each other (masks permitting). */
	private async phrase(text: string, segment: Segment): Promise<Uint32Array> {
		const count = text.length - 2;
		const keys: number[] = [];
		for (let i = 0; i < count; i++) {
			keys.push((text.charCodeAt(i) << 16) | (text.charCodeAt(i + 1) << 8) | text.charCodeAt(i + 2));
		}
		const distinct = [...new Set(keys)];
		const lists = await Promise.all(distinct.map(key => segment.postings(key, this.cache)));
		if (lists.some(list => !list)) {
			return EMPTY;
		}
		const byKey = new Map(distinct.map((key, i) => [key, lists[i]!]));
		const ordered = [...byKey.values()].sort((a, b) => a.docs.length - b.docs.length);
		let docs = ordered[0].docs;
		for (let i = 1; i < ordered.length && docs.length; i++) {
			docs = intersect(docs, ordered[i].docs);
		}
		if (!docs.length || count === 1) {
			return docs;
		}
		const cursors = new Map(distinct.map(key => [key, 0]));
		const at = new Map<number, number>();
		const out = new Uint32Array(docs.length);
		let n = 0;
		for (const doc of docs) {
			for (const key of distinct) {
				const list = byKey.get(key)!;
				const index = seek(list.docs, doc, cursors.get(key)!);
				cursors.set(key, index);
				at.set(key, index);
			}
			let possible = 0;
			let ok = true;
			for (let i = 0; i < count; i++) {
				const list = byKey.get(keys[i])!;
				const index = at.get(keys[i])!;
				const loc = list.locs[index];
				possible = i === 0 ? loc : rotl8(possible, 1) & loc;
				if (!possible || (i + 3 < text.length && !(list.nexts[index] & NEXT_BIT[text.charCodeAt(i + 3)]))) {
					ok = false;
					break;
				}
			}
			if (ok) {
				out[n++] = doc;
			}
		}
		return out.subarray(0, n);
	}

	/** Whether a file too large to index can match `query`: true unless its trigrams rule it out. */
	private async largeMayMatch(path: string, query: TrigramQuery): Promise<boolean> {
		if (query.op === 'all') {
			return true;
		}
		const abs = join(this.root, path);
		const stat = await fs.stat(abs).catch(() => undefined);
		if (!stat) {
			return true; // let the read decide (it skips files that are gone)
		}
		if (this.largeBits.size > this.large.size) {
			for (const known of [...this.largeBits.keys()]) {
				if (!this.large.has(known)) {
					this.largeBits.delete(known);
				}
			}
		}
		let entry = this.largeBits.get(path);
		if (!entry || entry.size !== stat.size || entry.mtime !== stat.mtimeMs) {
			if (!entry && this.largeBits.size >= MAX_LARGE_BITSETS) {
				return true;
			}
			const bytes = await fs.readFile(abs).catch(() => undefined);
			if (!bytes) {
				return true;
			}
			entry = { size: stat.size, mtime: stat.mtimeMs, bits: trigramBits(bytes) };
			this.largeBits.set(path, entry);
		}
		return bitsMayMatch(query, entry.bits);
	}

	/** The folder below the root a query is limited to ('' for the root), or undefined when outside. */
	private folderOf(folder: string | undefined): string | undefined {
		if (!folder) {
			return '';
		}
		const rel = relative(this.root, normalize(folder));
		if (rel === '') {
			return '';
		}
		if (rel.startsWith('..') || isAbsolute(rel)) {
			return undefined;
		}
		return sep === '/' ? rel : rel.split(sep).join('/');
	}

	private pathFilter(folder: string, includes: readonly string[] | undefined, excludes: readonly string[] | undefined): (path: string) => boolean {
		const include = (includes ?? []).map(glob => parseGlob(glob) as ParsedPattern);
		const exclude = (excludes ?? []).map(glob => parseGlob(glob) as ParsedPattern);
		const prefix = folder ? `${folder}/` : '';
		return path => {
			if (prefix && !path.startsWith(prefix)) {
				return false;
			}
			const inner = prefix ? path.slice(prefix.length) : path;
			return (!include.length || include.some(match => match(inner))) && !exclude.some(match => match(inner));
		};
	}

	private hasFilesUnder(folder: string): boolean {
		if (!folder) {
			return this.listed.size > 0;
		}
		const prefix = `${folder}/`;
		for (const path of this.listed) {
			if (path.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	private async readText(path: string): Promise<string | undefined> {
		try {
			const bytes = await fs.readFile(join(this.root, path));
			const bom = utf16Bom(bytes);
			if (bom) {
				return new TextDecoder(bom).decode(bytes.subarray(2));
			}
			if (hasNul(bytes)) {
				return undefined;
			}
			const text = bytes.toString('utf8');
			return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
		} catch {
			return undefined;
		}
	}

	async search(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult> {
		try {
			return await this.doSearch(request);
		} catch (err) {
			return this.queryFailed(err);
		}
	}

	private async doSearch(request: IVoltCodeIndexSearchRequest): Promise<IVoltCodeIndexSearchResult> {
		const started = Date.now();
		const notReady = await this.prepare(request.waitMs);
		if (notReady) {
			return { kind: 'fallback', reason: notReady };
		}
		const folder = this.folderOf(request.folder);
		if (folder === undefined || !this.hasFilesUnder(folder)) {
			return { kind: 'fallback', reason: 'not indexed' };
		}
		const caseInsensitive = !request.caseSensitive;
		const query = request.isRegExp ? regexTrigramQuery(request.pattern, caseInsensitive) : literalTrigramQuery(request.pattern, caseInsensitive);
		const filtered = !!folder || !!request.includes?.length || !!request.excludes?.length;
		const matcher = createJsMatcher(request.pattern, request.isRegExp, request.caseSensitive, request.multiline, !!request.wholeWord);
		if (query.op === 'all' && !filtered && !matcher) {
			return { kind: 'fallback', reason: 'unselective' }; // nothing to look up: ripgrep's full scan is faster
		}
		const keep = this.pathFilter(folder, request.includes, request.excludes);

		const candidates: string[] = [];
		if (query.op === 'all') {
			for (const path of this.live.keys()) {
				if (keep(path)) {
					candidates.push(path);
				}
			}
		} else {
			const segments = this.segments;
			const results = await Promise.all(segments.map(segment => this.evaluate(query, segment)));
			for (let i = 0; i < segments.length; i++) {
				const segment = segments[i];
				const result = results[i];
				const dead = this.dead.get(segment.id);
				const visit = (doc: number) => {
					if (dead?.[doc]) {
						return;
					}
					const path = segment.docs.paths[doc];
					if (this.live.get(path)?.seg === segment && keep(path)) {
						candidates.push(path);
					}
				};
				if (result === 'all') {
					for (let doc = 0; doc < segment.docCount; doc++) {
						visit(doc);
					}
				} else {
					for (const doc of result) {
						visit(doc);
					}
				}
			}
		}
		for (const path of [...this.dirty, ...this.inFlight]) {
			if (keep(path)) {
				candidates.push(path);
			}
		}
		// Files too large to index used to be read by every search (Linux: a 23 MB header, 8 ms each).
		for (const path of this.large) {
			if (keep(path) && await this.largeMayMatch(path, query)) {
				candidates.push(path);
			}
		}
		const context = Math.min(5, Math.max(0, request.context ?? 0));
		const maxLineChars = request.maxLineChars ?? 500;
		const deduped = [...new Set(candidates)];
		let unselective = deduped.length > RG_VERIFY_MAX;
		if (!unselective && deduped.length > 2_000) {
			let universe = this.dirty.size + this.inFlight.size + this.large.size;
			for (const path of this.live.keys()) {
				if (!filtered || keep(path)) {
					universe++;
				}
			}
			unselective = deduped.length > universe * UNSELECTIVE_RATIO;
		}
		if (unselective) {
			if (!matcher) {
				return { kind: 'fallback', reason: 'unselective' };
			}
			// The candidates' order is the index's: stable for an unchanged index, as cheap as it gets.
			const early = await this.verify(deduped.slice(0, EARLY_SCAN_FILES), matcher, context, request.maxMatches, maxLineChars);
			if (!early.limitHit && deduped.length > EARLY_SCAN_FILES) {
				return { kind: 'fallback', reason: 'unselective' };
			}
			this.lastSearchMs = Date.now() - started;
			return {
				kind: 'results',
				files: early.files.sort((a, b) => comparePaths(a.path, b.path)),
				limitHit: early.limitHit,
				stats: { candidates: deduped.length, scanned: early.scanned, indexedFiles: this.live.size, ms: this.lastSearchMs, engine: 'index' },
			};
		}
		const unique = deduped.sort(comparePaths);
		const ripgrep = (files: readonly string[], maxMatches: number) => searchFiles(this.root, files, {
			pattern: request.pattern,
			isRegExp: request.isRegExp,
			caseSensitive: request.caseSensitive,
			multiline: request.multiline,
			wholeWord: !!request.wholeWord,
			context,
			maxMatches,
			maxLineChars,
		});
		let result: { files: IVoltCodeIndexFileHits[]; limitHit: boolean; scanned: number; engine: 'index' | 'ripgrep' };
		if (!unique.length) {
			result = { files: [], limitHit: false, scanned: 0, engine: 'index' };
		} else if (matcher) {
			// In-process: it stops at the match limit, and for selective candidate sets reading them
			// here beats ripgrep's process start and file list (VOLT, ~1,500 candidates: 50 vs 200 ms).
			result = { ...await this.verify(unique, matcher, context, request.maxMatches, maxLineChars), engine: 'index' };
		} else {
			try {
				result = { ...await ripgrep(unique, request.maxMatches), scanned: unique.length, engine: 'ripgrep' };
			} catch (err) {
				return { kind: 'fallback', reason: `ripgrep: ${err instanceof Error ? err.message : err}` };
			}
		}
		this.lastSearchMs = Date.now() - started;
		return {
			kind: 'results',
			files: result.files,
			limitHit: result.limitHit,
			stats: { candidates: unique.length, scanned: result.scanned, indexedFiles: this.live.size, ms: this.lastSearchMs, engine: result.engine },
		};
	}

	private async verify(paths: readonly string[], matcher: IJsMatcher, context: number, maxMatches: number, maxLineChars: number): Promise<{ files: IVoltCodeIndexFileHits[]; limitHit: boolean; scanned: number }> {
		const files: IVoltCodeIndexFileHits[] = [];
		let total = 0;
		let scanned = 0;
		for (let i = 0; i < paths.length; i += 32) {
			const batch = paths.slice(i, i + 32);
			const texts = await Promise.all(batch.map(path => this.readText(path)));
			for (let j = 0; j < batch.length; j++) {
				const text = texts[j];
				if (text === undefined) {
					continue;
				}
				scanned++;
				const left = maxMatches - total;
				const found = matchText(text, matcher, context, left + 1, maxLineChars);
				if (!found.matches) {
					continue;
				}
				if (found.matches > left) {
					const trimmed = left > 0 ? matchText(text, matcher, context, left, maxLineChars) : undefined;
					if (trimmed?.matches) {
						files.push({ path: batch[j], matches: trimmed.matches, lines: trimmed.lines });
					}
					return { files, limitHit: true, scanned };
				}
				files.push({ path: batch[j], matches: found.matches, lines: found.lines });
				total += found.matches;
			}
		}
		return { files, limitHit: false, scanned };
	}

	async files(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult> {
		try {
			return await this.doFiles(request);
		} catch (err) {
			return this.queryFailed(err);
		}
	}

	private async doFiles(request: IVoltCodeIndexFilesRequest): Promise<IVoltCodeIndexFilesResult> {
		const notReady = await this.prepare(request.waitMs);
		if (notReady) {
			return { kind: 'fallback', reason: notReady };
		}
		const folder = this.folderOf(request.folder);
		if (folder === undefined || !this.hasFilesUnder(folder)) {
			return { kind: 'fallback', reason: 'not indexed' };
		}
		const keep = this.pathFilter(folder, [request.pattern], undefined);
		const out: string[] = [];
		for (const path of this.listed) {
			if (keep(path)) {
				out.push(path);
			}
		}
		out.sort(comparePaths);
		return { kind: 'results', paths: out.slice(0, request.limit), limitHit: out.length > request.limit };
	}

	/** Fuzzy, typo-tolerant search over every listed file's path. */
	async findFiles(request: IVoltCodeIndexFindFilesRequest): Promise<IVoltCodeIndexFindFilesResult> {
		try {
			const started = Date.now();
			const notReady = await this.prepare(request.waitMs);
			if (notReady) {
				return { kind: 'fallback', reason: notReady };
			}
			const folder = this.folderOf(request.folder);
			if (folder === undefined || !this.hasFilesUnder(folder)) {
				return { kind: 'fallback', reason: 'not indexed' };
			}
			const prefix = folder ? `${folder}/` : '';
			const listed = this.listed;
			if (this.fuzzy?.of !== listed || this.fuzzy.version !== listed.version) {
				this.fuzzy = { of: listed, version: listed.version, index: new FuzzyPathIndex([...listed]) };
			}
			const found = this.fuzzy.index.find(request.query, request.limit, prefix);
			return { kind: 'results', paths: found.paths, limitHit: found.total > found.paths.length, engine: 'index', ms: Date.now() - started };
		} catch (err) {
			return this.queryFailed(err);
		}
	}

	/**
	 * Which of `paths` (root-relative) are files of this project as the index lists them, so
	 * another engine's answer respects the same ignore files. Undefined until the list is loaded.
	 */
	listedFilter(): ((path: string) => boolean) | undefined {
		return this.state === 'ready' ? path => this.listed.has(path) : undefined;
	}

	private dropSymbols(): void {
		if (this.symbolCache) {
			clearTimeout(this.symbolCache.timer);
			this.symbolCache = undefined;
		}
	}

	private async loadSymbols(): Promise<Map<number, ISymbolTable>> {
		if (this.symbolCache && this.segments.every(segment => this.symbolCache!.bySegment.has(segment.id))) {
			clearTimeout(this.symbolCache.timer);
			this.symbolCache.timer = setTimeout(() => this.dropSymbols(), SYMBOLS_TTL_MS);
			return this.symbolCache.bySegment;
		}
		// Segments come and go (flushes, compaction): keep the tables of those still here.
		const previous = this.symbolCache?.bySegment;
		this.dropSymbols();
		const bySegment = new Map<number, ISymbolTable>();
		for (const segment of this.segments) {
			bySegment.set(segment.id, previous?.get(segment.id) ?? { syms: await segment.symbols() });
		}
		this.symbolCache = { bySegment, timer: setTimeout(() => this.dropSymbols(), SYMBOLS_TTL_MS) };
		return bySegment;
	}

	async symbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult> {
		try {
			return await this.doSymbols(request);
		} catch (err) {
			return this.queryFailed(err);
		}
	}

	private async doSymbols(request: IVoltCodeIndexSymbolsRequest): Promise<IVoltCodeIndexSymbolsResult> {
		const notReady = await this.prepare(request.waitMs);
		if (notReady) {
			return { kind: 'fallback', reason: notReady };
		}
		const query = request.query.trim();
		if (!query) {
			return { kind: 'results', symbols: [], limitHit: false };
		}
		const mode = request.match ?? 'exact';
		const lower = query.toLowerCase();
		const kinds = request.kinds?.length ? new Set(request.kinds) : undefined;
		const prefix = request.path ? request.path.replace(/^\.?\/+/, '').replace(/\/+$/, '') : '';
		const folder = this.folderOf(request.folder) ?? '';
		const scope = [folder, prefix].filter(Boolean).join('/');
		const fuzzy = mode === 'fuzzy' ? fuzzyMatcher(query) : undefined;
		const everything = query === '*';
		/** Higher is better; undefined is no match. */
		const score = (name: string): number | undefined => {
			if (everything) {
				return 1;
			}
			if (name === query) {
				return 100;
			}
			const nameLower = name.toLowerCase();
			if (nameLower === lower) {
				return 90;
			}
			if (mode === 'exact') {
				return undefined;
			}
			if (nameLower.startsWith(lower)) {
				return 70 - Math.min(20, name.length - query.length);
			}
			if (mode === 'prefix') {
				return undefined;
			}
			if (nameLower.includes(lower)) {
				return 50 - Math.min(20, name.length - query.length);
			}
			return fuzzy?.(name);
		};
		const hits: { symbol: Omit<IVoltCodeSymbol, 'text'>; score: number }[] = [];
		const consider = (name: string, kindIndex: number, path: string, line: number) => {
			const kind = SYMBOL_KINDS[kindIndex] ?? 'function';
			if (kinds && !kinds.has(kind)) {
				return;
			}
			if (scope && !(path === scope || path.startsWith(`${scope}/`))) {
				return;
			}
			const value = score(name);
			if (value !== undefined) {
				hits.push({ symbol: { name, kind, path, line }, score: value + kindBonus(kind) - (/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\./.test(path) ? 8 : 0) });
			}
		};
		const bySegment = await this.loadSymbols();
		for (const segment of this.segments) {
			const table = bySegment.get(segment.id);
			const dead = this.dead.get(segment.id);
			if (!table) {
				continue;
			}
			const syms = table.syms;
			// Cached tables outlive edits: a changed file's old symbols are skipped here (they are read
			// from the file below) and a removed file's are dead, so nothing stale is reported.
			const visit = (i: number) => {
				const doc = syms.docs[i];
				if (!dead?.[doc]) {
					const path = segment.docs.paths[doc];
					if (!this.dirty.has(path) && !this.inFlight.has(path)) {
						consider(syms.names[i], syms.kinds[i], path, syms.lines[i]);
					}
				}
			};
			// Exact and prefix (any case): a hash lookup instead of a pass over every symbol.
			const indexed = everything ? undefined : mode === 'exact' ? namesOf(table).equal(lower) : mode === 'prefix' ? namesOf(table).startingWith(lower) : undefined;
			if (indexed) {
				for (const i of indexed) {
					visit(i);
				}
			} else {
				for (let i = 0; i < syms.names.length; i++) {
					visit(i);
				}
			}
		}
		// Changed files are not indexed yet: read their symbols now.
		for (const path of [...this.dirty, ...this.inFlight]) {
			if (hasSymbolRules(path)) {
				const text = await this.readText(path);
				if (text !== undefined) {
					for (const symbol of extractSymbols(path, text)) {
						consider(symbol.name, symbol.kind, path, symbol.line);
					}
				}
			}
		}
		hits.sort((a, b) => b.score - a.score || a.symbol.path.length - b.symbol.path.length || comparePaths(a.symbol.path, b.symbol.path) || a.symbol.line - b.symbol.line);
		const top = hits.slice(0, request.limit);
		const texts = new Map<string, string[] | undefined>();
		const symbols: IVoltCodeSymbol[] = [];
		for (const { symbol } of top) {
			if (!texts.has(symbol.path)) {
				texts.set(symbol.path, (await this.readText(symbol.path))?.split('\n'));
			}
			const raw = texts.get(symbol.path)?.[symbol.line - 1] ?? '';
			const line = raw.trim();
			symbols.push({ ...symbol, column: Math.max(1, raw.indexOf(symbol.name) + 1), text: line.length > 200 ? `${line.slice(0, 200)}\u2026` : line });
		}
		return { kind: 'results', symbols, limitHit: hits.length > request.limit };
	}

	//#endregion

	private indexedBytes(): number {
		let bytes = 0;
		for (const { seg, doc } of this.live.values()) {
			bytes += seg.docs.sizes[doc] ?? 0;
		}
		return bytes;
	}

	status(): IVoltCodeIndexStatus {
		const stats = this.manifest?.stats;
		return {
			root: this.root,
			state: this.state,
			files: this.state === 'ready' ? this.live.size + this.large.size : stats?.files ?? 0,
			bytes: this.state === 'ready' ? this.indexedBytes() : stats?.bytes ?? 0,
			diskBytes: stats?.diskBytes ?? 0,
			symbols: stats?.symbols ?? 0,
			pending: this.dirty.size + this.inFlight.size + this.pendingCreates.size,
			...(this.progress ? { progress: { ...this.progress } } : {}),
			...(this.manifest ? { updatedAt: this.manifest.updatedAt } : {}),
			lastUsedAt: this.lastUsedAt,
			...(this.error && this.state === 'error' ? { error: this.error } : {}),
			...(this.lastSearchMs !== undefined ? { lastSearchMs: this.lastSearchMs } : {}),
		};
	}
}

function kindBonus(kind: VoltCodeSymbolKind): number {
	switch (kind) {
		case 'class': case 'interface': case 'struct': case 'trait': case 'enum': case 'type': return 6;
		case 'function': return 5;
		case 'method': return 4;
		case 'module': return 3;
		case 'constant': return 2;
		default: return 0;
	}
}

/**
 * In-order character matching that favours word starts, e.g. `getUsr` for `getUserById` or
 * `usrSvc` for `UserService`. Scattered matches (more skipped letters than the query is long)
 * are no match.
 */
function fuzzyMatcher(query: string): (name: string) => number | undefined {
	const q = query.toLowerCase();
	return name => {
		const n = name.toLowerCase();
		let at = 0;
		let gaps = 0;
		let humps = 0;
		for (const ch of q) {
			const found = n.indexOf(ch, at);
			if (found < 0) {
				return undefined;
			}
			gaps += found - at;
			const prev = name[found - 1];
			if (found === 0 || prev === '_' || prev === '$' || prev === '-' || (name[found] !== n[found] && prev === n[found - 1])) {
				humps++;
			}
			at = found + 1;
		}
		if (gaps > Math.max(3, q.length)) {
			return undefined;
		}
		return Math.max(1, 30 + humps * 2 - gaps);
	};
}

/** Used by tests: the folded byte string the index would store for `text`. */
export const indexedForm = toByteString;
