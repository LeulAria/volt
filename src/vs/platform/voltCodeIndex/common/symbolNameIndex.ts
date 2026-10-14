/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Case-insensitive exact and prefix lookup over a segment's symbol names without a pass over all
 * of them: a 32-bit hash of each lower-cased name (and of its first letters) in sorted typed
 * arrays. 16 bytes per symbol (Linux: 3M symbols, 48 MB) where a Map of names to index lists
 * would hold millions of strings and arrays. Hash collisions only add candidates; every hit is
 * checked against the name itself.
 */

/** Prefix lookups hash this many leading characters; shorter queries scan. */
export const PREFIX_CHARS = 4;

function hashLower(text: string, end: number): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < end; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Index order by hash: two 16-bit radix passes, linear in the number of symbols. `hashes` is
 * reused for the sorted output, so the result costs 8 bytes per symbol and the sort one more
 * buffer of 4 while it runs.
 */
function sortedByHash(hashes: Uint32Array): { readonly hashes: Uint32Array; readonly order: Uint32Array } {
	const n = hashes.length;
	let order = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		order[i] = i;
	}
	let scratch = new Uint32Array(n);
	const counts = new Uint32Array(65_537);
	for (const shift of [0, 16]) {
		counts.fill(0);
		for (let i = 0; i < n; i++) {
			counts[((hashes[order[i]] >>> shift) & 0xffff) + 1]++;
		}
		for (let b = 1; b < counts.length; b++) {
			counts[b] += counts[b - 1];
		}
		for (let i = 0; i < n; i++) {
			const index = order[i];
			scratch[counts[(hashes[index] >>> shift) & 0xffff]++] = index;
		}
		[order, scratch] = [scratch, order];
	}
	// `scratch` is free now: the sorted hashes go there, then back over `hashes` (owned by us).
	for (let i = 0; i < n; i++) {
		scratch[i] = hashes[order[i]];
	}
	hashes.set(scratch);
	return { hashes, order };
}

function firstAtLeast(sorted: Uint32Array, value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid] < value) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

export class SymbolNameIndex {

	private readonly exact: { readonly hashes: Uint32Array; readonly order: Uint32Array };
	private readonly prefix: { readonly hashes: Uint32Array; readonly order: Uint32Array };

	constructor(private readonly names: readonly string[]) {
		const full = new Uint32Array(names.length);
		const lead = new Uint32Array(names.length);
		for (let i = 0; i < names.length; i++) {
			const lower = names[i].toLowerCase();
			full[i] = hashLower(lower, lower.length);
			lead[i] = hashLower(lower, Math.min(PREFIX_CHARS, lower.length));
		}
		// One table at a time: the sort's scratch buffer of the first is free before the second.
		this.exact = sortedByHash(full);
		this.prefix = sortedByHash(lead);
	}

	private candidates(table: { readonly hashes: Uint32Array; readonly order: Uint32Array }, hash: number): Uint32Array {
		const start = firstAtLeast(table.hashes, hash);
		let end = start;
		while (end < table.hashes.length && table.hashes[end] === hash) {
			end++;
		}
		return table.order.subarray(start, end);
	}

	/** Indices of names equal to `lower` ignoring case, in index order. */
	equal(lower: string): number[] {
		const out: number[] = [];
		for (const i of this.candidates(this.exact, hashLower(lower, lower.length))) {
			if (this.names[i].toLowerCase() === lower) {
				out.push(i);
			}
		}
		return out.sort((a, b) => a - b);
	}

	/** Indices of names starting with `lower` ignoring case; undefined when `lower` is too short to look up. */
	startingWith(lower: string): number[] | undefined {
		if (lower.length < PREFIX_CHARS) {
			return undefined;
		}
		const out: number[] = [];
		for (const i of this.candidates(this.prefix, hashLower(lower, PREFIX_CHARS))) {
			if (this.names[i].toLowerCase().startsWith(lower)) {
				out.push(i);
			}
		}
		return out.sort((a, b) => a - b);
	}
}
