/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * A TextMate grammar hands oniguruma one list of patterns per rule, and oniguruma compiles every
 * pattern of every list on its own. Grammars repeat their patterns across rules: the TypeScript
 * grammar's first 42 rules are 2,046 patterns of which 239 are distinct, and their compiled copies
 * grow oniguruma's WASM heap from 16 to 40 MiB for a few code blocks in a chat (62 MiB for a large
 * file), which never shrinks.
 *
 * Here each distinct pattern is compiled once and shared by every rule that lists it. A rule's
 * scanner asks its patterns one by one and picks the match oniguruma itself would pick (the
 * leftmost; of equals the first listed). That walk costs more per call than oniguruma's own loop,
 * so a scanner that turns out to be busy replaces itself with oniguruma's own scanner for its
 * list. The busy scanners are few; the memory is in the many rules that are entered a few times
 * each, and those stay shared.
 *
 * No imports: the round-10 probe (onigshare) loads this file in plain node.
 */

/** The parts of vscode-oniguruma's `OnigString` used here (`id`, `ptr`, `utf8Length` are not in its typings). */
export interface IOnigStringLike {
	readonly content: string;
	dispose(): void;
}

interface IOnigStringInternals extends IOnigStringLike {
	readonly id: number;
	readonly ptr: number;
	readonly utf8Length: number;
	convertUtf16OffsetToUtf8(offset: number): number;
}

export interface IOnigCaptureLike {
	start: number;
	end: number;
	length: number;
}

export interface IOnigMatchLike {
	index: number;
	captureIndices: IOnigCaptureLike[];
}

export interface IOnigScannerLike {
	findNextMatchSync(string: string | IOnigStringLike, startPosition: number, options: number | boolean): IOnigMatchLike | null;
	dispose(): void;
}

/** The parts of the vscode-oniguruma module used here. */
export interface IOnigLibLike {
	createOnigScanner(sources: string[]): IOnigScannerLike;
	createOnigString(str: string): IOnigStringLike;
}

/** vscode-oniguruma's WASM exports as its scanners hold them (not in its typings). */
interface IOnigBinding {
	readonly HEAPU32: Uint32Array;
	_findNextOnigScannerMatch(scanner: number, stringId: number, stringPtr: number, utf8Length: number, utf8Position: number, options: number): number;
}

interface IOnigScannerInternals extends IOnigScannerLike {
	readonly _ptr: number;
	readonly _onigBinding: IOnigBinding;
}

/** oniguruma's `FindOption.DebugCall`: such calls go through the library's own entry point. */
const FIND_OPTION_DEBUG_CALL = 8;

/** A scanner is busy once it has answered this many calls. */
export const SHARED_ONIG_SCANNER_BUSY_CALLS = 1024;

/** One compiled pattern, shared by every scanner that lists it. */
class SharedPattern {

	refs = 0;
	readonly ptr: number;
	/** oniguruma does not remember searches of a pattern anchored at the search position (`\G`); neither does this. */
	readonly remembers: boolean;

	// oniguruma's own memory of this pattern's last search, mirrored so a search it would answer
	// from memory costs no call: on the same string, from a position at or after the last one, no
	// match stays no match and a match at or after the position stays the match.
	stringId = -1;
	position = 0;
	options = 0;
	matched = false;
	location = 0;

	constructor(readonly scanner: IOnigScannerInternals, source: string) {
		this.ptr = scanner._ptr;
		this.remembers = !source.includes('\\G');
	}
}

function hasScannerInternals(scanner: IOnigScannerLike): scanner is IOnigScannerInternals {
	const candidate = scanner as Partial<IOnigScannerInternals>;
	return typeof candidate._ptr === 'number' && !!candidate._onigBinding
		&& typeof candidate._onigBinding._findNextOnigScannerMatch === 'function'
		&& candidate._onigBinding.HEAPU32 instanceof Uint32Array;
}

function hasStringInternals(string: IOnigStringLike): string is IOnigStringInternals {
	const candidate = string as Partial<IOnigStringInternals>;
	return typeof candidate.id === 'number' && typeof candidate.ptr === 'number' && typeof candidate.utf8Length === 'number'
		&& typeof candidate.convertUtf16OffsetToUtf8 === 'function';
}

/**
 * Makes scanners whose patterns are compiled once per distinct source. With a vscode-oniguruma
 * whose internals are not the ones read here, it hands out the library's own scanners.
 */
export class SharedOnigPatterns {

	private readonly patterns = new Map<string, SharedPattern>();
	private supported: boolean | undefined;

	constructor(
		private readonly lib: IOnigLibLike,
		private readonly busyCalls = SHARED_ONIG_SCANNER_BUSY_CALLS,
	) { }

	/** Distinct patterns compiled for sharing right now. */
	get size(): number {
		return this.patterns.size;
	}

	createOnigScanner(sources: string[]): IOnigScannerLike {
		if (sources.length < 2 || !this.isSupported()) {
			return this.lib.createOnigScanner(sources);
		}
		return new SharedOnigScanner(this, sources, this.busyCalls);
	}

	createOwnScanner(sources: string[]): IOnigScannerLike {
		return this.lib.createOnigScanner(sources);
	}

	createOnigString(str: string): IOnigStringLike {
		return this.lib.createOnigString(str);
	}

	acquire(source: string): SharedPattern {
		let pattern = this.patterns.get(source);
		if (!pattern) {
			pattern = new SharedPattern(this.lib.createOnigScanner([source]) as IOnigScannerInternals, source);
			this.patterns.set(source, pattern);
		}
		pattern.refs++;
		return pattern;
	}

	release(source: string, pattern: SharedPattern): void {
		if (--pattern.refs === 0) {
			this.patterns.delete(source);
			pattern.scanner.dispose();
		}
	}

	private isSupported(): boolean {
		if (this.supported === undefined) {
			let scanner: IOnigScannerLike | undefined;
			let string: IOnigStringLike | undefined;
			try {
				scanner = this.lib.createOnigScanner(['a']);
				string = this.lib.createOnigString('a');
				this.supported = hasScannerInternals(scanner) && hasStringInternals(string);
			} catch {
				this.supported = false;
			} finally {
				scanner?.dispose();
				string?.dispose();
			}
		}
		return this.supported;
	}
}

class SharedOnigScanner implements IOnigScannerLike {

	private parts: SharedPattern[] | undefined;
	/** oniguruma's own scanner for the list, once this one turned out to be busy. */
	private own: IOnigScannerLike | undefined;
	private calls = 0;

	constructor(
		private readonly pool: SharedOnigPatterns,
		private readonly sources: string[],
		private readonly busyCalls: number,
	) {
		this.parts = sources.map(source => pool.acquire(source));
	}

	findNextMatchSync(string: string | IOnigStringLike, startPosition: number, options: number | boolean): IOnigMatchLike | null {
		if (this.own) {
			return this.own.findNextMatchSync(string, startPosition, options);
		}
		const parts = this.parts;
		if (!parts) {
			return null;
		}
		if (typeof string === 'string') {
			const onigString = this.pool.createOnigString(string);
			try {
				return this.findNextMatchSync(onigString, startPosition, options);
			} finally {
				onigString.dispose();
			}
		}
		if (typeof options !== 'number' || (options & FIND_OPTION_DEBUG_CALL) !== 0 || !hasStringInternals(string)) {
			return this.findThroughLibrary(parts, string, startPosition, options);
		}
		if (++this.calls >= this.busyCalls) {
			return this.becomeOwn().findNextMatchSync(string, startPosition, options);
		}

		const binding = parts[0].scanner._onigBinding;
		const stringId = string.id;
		const stringPtr = string.ptr;
		const utf8Length = string.utf8Length;
		const position = string.convertUtf16OffsetToUtf8(startPosition);
		let best = -1;
		let bestLocation = 0;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			let location: number;
			if (part.remembers && part.stringId === stringId && part.options === options && part.position <= position && (!part.matched || part.location >= position)) {
				if (!part.matched) {
					continue;
				}
				location = part.location;
			} else {
				const result = binding._findNextOnigScannerMatch(part.ptr, stringId, stringPtr, utf8Length, position, options);
				// [pattern index, capture count, start of the match, end of the match, ...], UTF-8 offsets.
				// The view is read after the call: growing the WASM heap replaces it.
				location = result === 0 ? 0 : binding.HEAPU32[(result >>> 2) + 2];
				if (part.remembers) {
					part.stringId = stringId;
					part.position = position;
					part.options = options;
					part.matched = result !== 0;
					part.location = location;
				}
				if (result === 0) {
					continue;
				}
			}
			if (best === -1 || location < bestLocation) {
				best = i;
				bestLocation = location;
			}
			if (location === position) {
				break;
			}
		}
		if (best === -1) {
			return null;
		}
		// The winner's captures, by the library's own decoding (answered from oniguruma's memory of the search above).
		const match = parts[best].scanner.findNextMatchSync(string, startPosition, options);
		if (match) {
			match.index = best;
		}
		return match;
	}

	/** The same choice through the library's public entry point only (plain strings' options, debug calls). */
	private findThroughLibrary(parts: SharedPattern[], string: IOnigStringLike, startPosition: number, options: number | boolean): IOnigMatchLike | null {
		let best: IOnigMatchLike | null = null;
		let bestIndex = 0;
		for (let i = 0; i < parts.length; i++) {
			const match = parts[i].scanner.findNextMatchSync(string, startPosition, options);
			if (!match || match.captureIndices.length === 0) {
				continue;
			}
			if (!best || match.captureIndices[0].start < best.captureIndices[0].start) {
				best = match;
				bestIndex = i;
			}
			if (match.captureIndices[0].start === startPosition) {
				break;
			}
		}
		if (best) {
			best.index = bestIndex;
		}
		return best;
	}

	private becomeOwn(): IOnigScannerLike {
		const own = this.own = this.pool.createOwnScanner(this.sources);
		this.releaseParts();
		return own;
	}

	private releaseParts(): void {
		const parts = this.parts;
		this.parts = undefined;
		if (parts) {
			for (let i = 0; i < parts.length; i++) {
				this.pool.release(this.sources[i], parts[i]);
			}
		}
	}

	dispose(): void {
		this.releaseParts();
		this.own?.dispose();
		this.own = undefined;
	}
}
