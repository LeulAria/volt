/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';

/**
 * The on-disk trigram index. A segment is three files:
 *
 * - `<id>.keys`: a header, the sorted trigram keys (u32) and each key's offset into the postings
 *   (u32, one more than keys). Loaded whole; ~8 bytes per distinct trigram.
 * - `<id>.post`: every key's posting list, back to back, read on demand. An entry is the doc id
 *   gap (varint) and two Blackbird masks: the trigram's start positions mod 8 and a hash of the
 *   bytes that follow it. Together they give near-quadgram precision for two bytes.
 * - `<id>.docs.json`: the segment's files (paths, sizes, mtimes) and `<id>.syms.json` its symbols.
 *
 * Keys are 24 bits: three bytes of UTF-8 with ASCII letters lower-cased.
 */

const MAGIC = 0x31494356; // 'VCI1'
const VERSION = 1;
const HEADER_BYTES = 32;

export const FOLD = new Uint8Array(256);
export const NEXT_BIT = new Uint8Array(256);
for (let byte = 0; byte < 256; byte++) {
	FOLD[byte] = byte >= 65 && byte <= 90 ? byte + 32 : byte;
	NEXT_BIT[byte] = 1 << (Math.imul(byte, 0x9E3779B1) >>> 29);
}

export function rotl8(mask: number, by: number): number {
	return ((mask << by) | (mask >>> (8 - by))) & 0xff;
}

//#region One document's trigrams

/**
 * The distinct trigrams of one file with their masks, in a reused open-addressing table that
 * grows with the number of distinct trigrams (not the file size) and shrinks back after a big file.
 */
export class TrigramTable {
	private bits = 0;
	private keys = new Int32Array(0);
	private locs = new Uint8Array(0);
	private nexts = new Uint8Array(0);
	private used = new Int32Array(0);
	count = 0;

	private allocate(bits: number): void {
		this.bits = bits;
		this.keys = new Int32Array(1 << bits).fill(-1);
		this.locs = new Uint8Array(1 << bits);
		this.nexts = new Uint8Array(1 << bits);
		this.used = new Int32Array(1 << (bits - 1));
	}

	/** Doubles the table, keeping its entries. */
	private grow(): void {
		const keys = this.keys, locs = this.locs, nexts = this.nexts, used = this.used, count = this.count;
		this.allocate(this.bits + 1);
		const shift = 32 - this.bits;
		const mask = (1 << this.bits) - 1;
		for (let i = 0; i < count; i++) {
			const from = used[i];
			const key = keys[from];
			let slot = Math.imul(key, 0x9E3779B1) >>> shift;
			while (this.keys[slot] !== -1) {
				slot = (slot + 1) & mask;
			}
			this.keys[slot] = key;
			this.locs[slot] = locs[from];
			this.nexts[slot] = nexts[from];
			this.used[i] = slot;
		}
	}

	reset(): void {
		if (this.bits > 17) {
			this.allocate(14); // a big file left a big table; do not keep it
		} else {
			for (let i = 0; i < this.count; i++) {
				const slot = this.used[i];
				this.keys[slot] = -1;
				this.locs[slot] = 0;
				this.nexts[slot] = 0;
			}
		}
		this.count = 0;
	}

	/** Collects the trigrams of `bytes` (after a reset). */
	add(bytes: Uint8Array): void {
		this.reset();
		const n = bytes.length;
		if (n < 3) {
			return;
		}
		if (!this.bits) {
			this.allocate(14);
		}
		let keys = this.keys;
		let shift = 32 - this.bits;
		let mask = (1 << this.bits) - 1;
		let limit = 1 << (this.bits - 1);
		let key = (FOLD[bytes[0]] << 8) | FOLD[bytes[1]];
		for (let i = 0; i + 2 < n; i++) {
			key = ((key << 8) | FOLD[bytes[i + 2]]) & 0xffffff;
			let slot = Math.imul(key, 0x9E3779B1) >>> shift;
			for (; ;) {
				const found = keys[slot];
				if (found === key) {
					break;
				}
				if (found === -1) {
					if (this.count + 1 >= limit) {
						this.grow();
						keys = this.keys;
						shift = 32 - this.bits;
						mask = (1 << this.bits) - 1;
						limit = 1 << (this.bits - 1);
						slot = Math.imul(key, 0x9E3779B1) >>> shift;
						continue;
					}
					keys[slot] = key;
					this.used[this.count++] = slot;
					break;
				}
				slot = (slot + 1) & mask;
			}
			this.locs[slot] |= 1 << (i & 7);
			if (i + 3 < n) {
				this.nexts[slot] |= NEXT_BIT[FOLD[bytes[i + 3]]];
			}
		}
	}

	/** Frees a large table between builds. */
	release(): void {
		if (this.bits > 14) {
			this.allocate(14);
		}
	}

	key(i: number): number { return this.keys[this.used[i]]; }
	loc(i: number): number { return this.locs[this.used[i]]; }
	next(i: number): number { return this.nexts[this.used[i]]; }
}

//#endregion

//#region Varints

class ByteWriter {
	buf: Uint8Array;
	length = 0;

	constructor(capacity: number) {
		this.buf = new Uint8Array(Math.max(1024, capacity));
	}

	private room(bytes: number): void {
		if (this.length + bytes > this.buf.length) {
			const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + bytes));
			next.set(this.buf.subarray(0, this.length));
			this.buf = next;
		}
	}

	varint(value: number): void {
		this.room(5);
		while (value >= 0x80) {
			this.buf[this.length++] = (value & 0x7f) | 0x80;
			value = Math.floor(value / 128);
		}
		this.buf[this.length++] = value;
	}

	entry(gap: number, loc: number, next: number): void {
		this.varint(gap);
		this.room(2);
		this.buf[this.length++] = loc;
		this.buf[this.length++] = next;
	}
}

export interface IPostingList {
	readonly docs: Uint32Array;
	readonly locs: Uint8Array;
	readonly nexts: Uint8Array;
}

export function decodePostings(bytes: Uint8Array): IPostingList {
	const max = Math.ceil(bytes.length / 3);
	const docs = new Uint32Array(max);
	const locs = new Uint8Array(max);
	const nexts = new Uint8Array(max);
	let n = 0;
	let p = 0;
	let prev = -1;
	while (p < bytes.length) {
		let value = 0;
		let scale = 1;
		let byte: number;
		do {
			byte = bytes[p++];
			value += (byte & 0x7f) * scale;
			scale *= 128;
		} while (byte & 0x80);
		prev += value + 1;
		docs[n] = prev;
		locs[n] = bytes[p++];
		nexts[n] = bytes[p++];
		n++;
	}
	// Exact-size copies: views would keep the worst-case buffers (up to 1.7x) alive in the posting cache.
	return { docs: docs.slice(0, n), locs: locs.slice(0, n), nexts: nexts.slice(0, n) };
}

/**
 * Every trigram key in `bytes` as a bitset (2^24 bits, 2 MB): for files too large to index, so a
 * search can rule them out without reading them. Keys as the index builds them (ASCII folded).
 */
export function trigramBits(bytes: Uint8Array): Uint8Array {
	const bits = new Uint8Array(1 << 21);
	if (bytes.length < 3) {
		return bits;
	}
	let key = (FOLD[bytes[0]] << 8) | FOLD[bytes[1]];
	for (let i = 0; i + 2 < bytes.length; i++) {
		key = ((key << 8) | FOLD[bytes[i + 2]]) & 0xffffff;
		bits[key >>> 3] |= 1 << (key & 7);
	}
	return bits;
}

//#endregion

//#region Segment files

export interface ISegmentDocs {
	readonly paths: string[];
	readonly sizes: number[];
	readonly mtimes: number[];
}

/** Symbols of a segment, column-wise. */
export interface ISegmentSymbols {
	readonly names: string[];
	readonly docs: number[];
	readonly lines: number[];
	readonly kinds: number[];
}

export interface ISymbolRecord {
	readonly name: string;
	readonly kind: number;
	readonly line: number;
}

function keysFile(dir: string, id: number) { return join(dir, `${id}.keys`); }
function postFile(dir: string, id: number) { return join(dir, `${id}.post`); }
function docsFile(dir: string, id: number) { return join(dir, `${id}.docs.json`); }
function symsFile(dir: string, id: number) { return join(dir, `${id}.syms.json`); }

export function segmentFiles(dir: string, id: number): string[] {
	return [keysFile(dir, id), postFile(dir, id), docsFile(dir, id), symsFile(dir, id)];
}

async function writeKeys(dir: string, id: number, docCount: number, keys: Uint32Array, offs: Uint32Array): Promise<void> {
	const header = new Uint32Array(HEADER_BYTES / 4);
	header[0] = MAGIC;
	header[1] = VERSION;
	header[2] = docCount;
	header[3] = keys.length;
	const file = await fs.open(keysFile(dir, id), 'w');
	try {
		await file.write(new Uint8Array(header.buffer));
		await file.write(new Uint8Array(keys.buffer, keys.byteOffset, keys.byteLength));
		await file.write(new Uint8Array(offs.buffer, offs.byteOffset, offs.byteLength));
	} finally {
		await file.close();
	}
}

/** Scratch for the radix sort, shared by every build in the process. */
let sortScratch: { hi: Uint32Array; lo: Uint32Array } | undefined;

/** Drops the sort scratch once nothing is being built (it is as large as a builder). */
export function releaseBuildMemory(): void {
	sortScratch = undefined;
}

/** Postings of a batch of files in memory, written out as one segment. */
export class SegmentBuilder {
	private hi: Uint32Array;
	private lo: Uint32Array;
	private n = 0;
	readonly docs: ISegmentDocs = { paths: [], sizes: [], mtimes: [] };
	private readonly symbols: ISegmentSymbols = { names: [], docs: [], lines: [], kinds: [] };
	bytes = 0;

	constructor(private readonly capacity: number) {
		this.hi = new Uint32Array(capacity);
		this.lo = new Uint32Array(capacity);
	}

	get docCount(): number { return this.docs.paths.length; }
	get postings(): number { return this.n; }

	/** Whether a file with this many trigrams still fits (one file always fits an empty builder). */
	fits(trigrams: number): boolean {
		return this.docCount < 0xffff && (this.n + trigrams <= this.capacity || this.docCount === 0);
	}

	addDoc(path: string, size: number, mtime: number, table: TrigramTable, symbols: readonly ISymbolRecord[]): void {
		const doc = this.docCount;
		if (this.n + table.count > this.hi.length) {
			const grow = (from: Uint32Array) => {
				const to = new Uint32Array(this.n + table.count);
				to.set(from.subarray(0, this.n));
				return to;
			};
			this.hi = grow(this.hi);
			this.lo = grow(this.lo);
		}
		for (let i = 0; i < table.count; i++) {
			this.hi[this.n] = table.key(i);
			this.lo[this.n] = ((doc << 16) | (table.loc(i) << 8) | table.next(i)) >>> 0;
			this.n++;
		}
		this.docs.paths.push(path);
		this.docs.sizes.push(size);
		this.docs.mtimes.push(mtime);
		this.bytes += size;
		for (const symbol of symbols) {
			this.symbols.names.push(symbol.name);
			this.symbols.docs.push(doc);
			this.symbols.lines.push(symbol.line);
			this.symbols.kinds.push(symbol.kind);
		}
	}

	/** Stable LSD radix sort by key: entries of one key stay in doc order. */
	private sort(): void {
		const n = this.n;
		if (!sortScratch || sortScratch.hi.length < n) {
			sortScratch = { hi: new Uint32Array(Math.max(n, this.capacity)), lo: new Uint32Array(Math.max(n, this.capacity)) };
		}
		let srcHi = this.hi, srcLo = this.lo;
		let dstHi = sortScratch.hi, dstLo = sortScratch.lo;
		const counts = new Uint32Array(256);
		for (let shift = 0; shift < 24; shift += 8) {
			counts.fill(0);
			for (let i = 0; i < n; i++) {
				counts[(srcHi[i] >>> shift) & 0xff]++;
			}
			let sum = 0;
			for (let b = 0; b < 256; b++) {
				const c = counts[b];
				counts[b] = sum;
				sum += c;
			}
			for (let i = 0; i < n; i++) {
				const at = counts[(srcHi[i] >>> shift) & 0xff]++;
				dstHi[at] = srcHi[i];
				dstLo[at] = srcLo[i];
			}
			[srcHi, dstHi] = [dstHi, srcHi];
			[srcLo, dstLo] = [dstLo, srcLo];
		}
		// Three passes: the sorted data is in the scratch arrays now; swap them in.
		sortScratch = { hi: this.hi, lo: this.lo };
		this.hi = srcHi;
		this.lo = srcLo;
	}

	async write(dir: string, id: number): Promise<{ readonly keys: number; readonly postBytes: number }> {
		this.sort();
		const n = this.n;
		let distinct = 0;
		for (let i = 0; i < n; i++) {
			if (i === 0 || this.hi[i] !== this.hi[i - 1]) {
				distinct++;
			}
		}
		const keys = new Uint32Array(distinct);
		const offs = new Uint32Array(distinct + 1);
		const out = new ByteWriter(n * 4);
		let k = -1;
		let prev = -1;
		for (let i = 0; i < n; i++) {
			const key = this.hi[i];
			if (k < 0 || key !== keys[k]) {
				k++;
				keys[k] = key;
				offs[k] = out.length;
				prev = -1;
			}
			const lo = this.lo[i];
			const doc = lo >>> 16;
			out.entry(doc - prev - 1, (lo >>> 8) & 0xff, lo & 0xff);
			prev = doc;
		}
		offs[distinct] = out.length;
		await fs.writeFile(postFile(dir, id), out.buf.subarray(0, out.length));
		await fs.writeFile(docsFile(dir, id), JSON.stringify(this.docs));
		await fs.writeFile(symsFile(dir, id), JSON.stringify(this.symbols));
		await writeKeys(dir, id, this.docCount, keys, offs);
		return { keys: distinct, postBytes: out.length };
	}
}

/** Decoded posting lists shared by every segment of a root, bounded by their size. */
export class PostingCache {
	private readonly map = new Map<string, IPostingList>();
	private size = 0;
	/** Lists being read: concurrent lookups of one key (a query's overlapping phrases) share one decode. */
	private readonly loading = new Map<string, Promise<IPostingList>>();

	constructor(private readonly budget: number) { }

	/** The cached list for `key`, or the one `load` reads (once, however many callers ask meanwhile). */
	async load(key: string, load: () => Promise<IPostingList>): Promise<IPostingList> {
		const hit = this.get(key);
		if (hit) {
			return hit;
		}
		let pending = this.loading.get(key);
		if (!pending) {
			pending = load().then(list => {
				this.set(key, list);
				return list;
			}).finally(() => this.loading.delete(key));
			this.loading.set(key, pending);
		}
		return pending;
	}

	get(key: string): IPostingList | undefined {
		const hit = this.map.get(key);
		if (hit) {
			this.map.delete(key);
			this.map.set(key, hit);
		}
		return hit;
	}

	set(key: string, list: IPostingList): void {
		const cost = list.docs.length * 6 + 64;
		if (cost > this.budget / 4) {
			return;
		}
		// Replacing a key must not count it twice: drifting over the budget would evict every new list.
		const old = this.map.get(key);
		if (old) {
			this.map.delete(key);
			this.size -= old.docs.length * 6 + 64;
		}
		this.map.set(key, list);
		this.size += cost;
		for (const [oldKey, old] of this.map) {
			if (this.size <= this.budget) {
				break;
			}
			this.map.delete(oldKey);
			this.size -= old.docs.length * 6 + 64;
		}
	}

	clear(): void {
		this.map.clear();
		this.size = 0;
	}

	get bytes(): number {
		return this.size;
	}

	get entries(): number {
		return this.map.size;
	}
}

export class Segment {

	private constructor(
		readonly id: number,
		readonly dir: string,
		readonly docCount: number,
		readonly keys: Uint32Array,
		readonly offs: Uint32Array,
		private readonly post: fs.FileHandle,
		readonly docs: ISegmentDocs,
	) { }

	static async open(dir: string, id: number): Promise<Segment> {
		const raw = await fs.readFile(keysFile(dir, id));
		// Copy into a fresh buffer so the u32 views are aligned.
		const bytes = new Uint8Array(raw.length);
		bytes.set(raw);
		const header = new Uint32Array(bytes.buffer, 0, HEADER_BYTES / 4);
		if (header[0] !== MAGIC || header[1] !== VERSION) {
			throw new Error(`segment ${id}: not a Volt index segment`);
		}
		const docCount = header[2];
		const keyCount = header[3];
		if (bytes.length !== HEADER_BYTES + keyCount * 8 + 4) {
			throw new Error(`segment ${id}: truncated`);
		}
		const keys = new Uint32Array(bytes.buffer, HEADER_BYTES, keyCount);
		const offs = new Uint32Array(bytes.buffer, HEADER_BYTES + keyCount * 4, keyCount + 1);
		const docs = JSON.parse(await fs.readFile(docsFile(dir, id), 'utf8')) as ISegmentDocs;
		if (!Array.isArray(docs.paths) || docs.paths.length !== docCount) {
			throw new Error(`segment ${id}: document table does not match`);
		}
		const post = await fs.open(postFile(dir, id), 'r');
		return new Segment(id, dir, docCount, keys, offs, post, docs);
	}

	/** Index of `key` in the key table, or -1. */
	find(key: number): number {
		let lo = 0;
		let hi = this.keys.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const value = this.keys[mid];
			if (value === key) {
				return mid;
			}
			if (value < key) {
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return -1;
	}

	async postings(key: number, cache: PostingCache): Promise<IPostingList | undefined> {
		const index = this.find(key);
		if (index < 0) {
			return undefined;
		}
		return cache.load(`${this.id}:${key}`, async () => {
			const start = this.offs[index];
			const length = this.offs[index + 1] - start;
			const bytes = new Uint8Array(length);
			await this.post.read(bytes, 0, length, start);
			return decodePostings(bytes);
		});
	}

	async symbols(): Promise<ISegmentSymbols> {
		try {
			return JSON.parse(await fs.readFile(symsFile(this.dir, this.id), 'utf8')) as ISegmentSymbols;
		} catch {
			return { names: [], docs: [], lines: [], kinds: [] };
		}
	}

	async diskBytes(): Promise<number> {
		let total = 0;
		for (const file of segmentFiles(this.dir, this.id)) {
			total += await fs.stat(file).then(stat => stat.size, () => 0);
		}
		return total;
	}

	async close(): Promise<void> {
		await this.post.close().catch(() => undefined);
	}
}

/** Reads a postings file front to back in large chunks. */
class SequentialReader {
	private buf = new Uint8Array(1 << 20);
	private start = 0;
	private length = 0;

	constructor(private readonly file: fs.FileHandle) { }

	async read(offset: number, length: number): Promise<Uint8Array> {
		if (offset < this.start || offset + length > this.start + this.length) {
			if (length > this.buf.length) {
				this.buf = new Uint8Array(length);
			}
			const { bytesRead } = await this.file.read(this.buf, 0, this.buf.length, offset);
			this.start = offset;
			this.length = bytesRead;
		}
		return this.buf.subarray(offset - this.start, offset - this.start + length);
	}
}

/**
 * Writes the live documents of `inputs` (in order) as one new segment, dropping the rest.
 * Streams key by key, so memory stays near the key tables.
 */
export async function mergeSegments(dir: string, id: number, inputs: readonly { readonly segment: Segment; readonly live: (doc: number) => boolean }[]): Promise<void> {
	const docs: ISegmentDocs = { paths: [], sizes: [], mtimes: [] };
	const symbols: ISegmentSymbols = { names: [], docs: [], lines: [], kinds: [] };
	const remaps: Int32Array[] = [];
	for (const { segment, live } of inputs) {
		const remap = new Int32Array(segment.docCount).fill(-1);
		for (let doc = 0; doc < segment.docCount; doc++) {
			if (live(doc)) {
				remap[doc] = docs.paths.length;
				docs.paths.push(segment.docs.paths[doc]);
				docs.sizes.push(segment.docs.sizes[doc]);
				docs.mtimes.push(segment.docs.mtimes[doc]);
			}
		}
		remaps.push(remap);
		const syms = await segment.symbols();
		for (let i = 0; i < syms.names.length; i++) {
			const doc = remap[syms.docs[i]];
			if (doc >= 0) {
				symbols.names.push(syms.names[i]);
				symbols.docs.push(doc);
				symbols.lines.push(syms.lines[i]);
				symbols.kinds.push(syms.kinds[i]);
			}
		}
	}

	const handles = await Promise.all(inputs.map(input => fs.open(postFile(input.segment.dir, input.segment.id), 'r')));
	const readers = handles.map(handle => new SequentialReader(handle));
	const out = await fs.open(postFile(dir, id), 'w');
	try {
		let keys = new Uint32Array(1 << 16);
		let offs = new Uint32Array((1 << 16) + 1);
		let keyCount = 0;
		let written = 0;
		const chunk = new ByteWriter(1 << 20);
		const cursors = new Uint32Array(inputs.length);
		for (; ;) {
			let key = Infinity;
			for (let i = 0; i < inputs.length; i++) {
				const segment = inputs[i].segment;
				if (cursors[i] < segment.keys.length && segment.keys[cursors[i]] < key) {
					key = segment.keys[cursors[i]];
				}
			}
			if (key === Infinity) {
				break;
			}
			const startLength = written + chunk.length;
			let prev = -1;
			for (let i = 0; i < inputs.length; i++) {
				const segment = inputs[i].segment;
				const at = cursors[i];
				if (at >= segment.keys.length || segment.keys[at] !== key) {
					continue;
				}
				cursors[i]++;
				const list = decodePostings(await readers[i].read(segment.offs[at], segment.offs[at + 1] - segment.offs[at]));
				const remap = remaps[i];
				for (let e = 0; e < list.docs.length; e++) {
					const doc = remap[list.docs[e]];
					if (doc >= 0) {
						chunk.entry(doc - prev - 1, list.locs[e], list.nexts[e]);
						prev = doc;
					}
				}
			}
			if (prev >= 0) {
				if (keyCount + 1 >= keys.length) {
					const grownKeys = new Uint32Array(keys.length * 2);
					grownKeys.set(keys);
					keys = grownKeys;
					const grownOffs = new Uint32Array(keys.length + 1);
					grownOffs.set(offs);
					offs = grownOffs;
				}
				keys[keyCount] = key;
				offs[keyCount] = startLength;
				keyCount++;
			}
			if (chunk.length >= (1 << 20) - 1024) {
				await out.write(chunk.buf.subarray(0, chunk.length));
				written += chunk.length;
				chunk.length = 0;
			}
		}
		if (chunk.length) {
			await out.write(chunk.buf.subarray(0, chunk.length));
			written += chunk.length;
		}
		offs[keyCount] = written;
		await fs.writeFile(docsFile(dir, id), JSON.stringify(docs));
		await fs.writeFile(symsFile(dir, id), JSON.stringify(symbols));
		await writeKeys(dir, id, docs.paths.length, keys.slice(0, keyCount), offs.slice(0, keyCount + 1));
	} finally {
		await out.close();
		await Promise.all(handles.map(handle => handle.close().catch(() => undefined)));
	}
}

export async function deleteSegment(dir: string, id: number): Promise<void> {
	await Promise.all(segmentFiles(dir, id).map(file => fs.rm(file, { force: true })));
}

//#endregion
