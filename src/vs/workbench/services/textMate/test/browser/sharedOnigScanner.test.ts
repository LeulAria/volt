/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOnigLibLike, IOnigMatchLike, IOnigScannerLike, IOnigStringLike, SharedOnigPatterns } from '../../browser/sharedOnigScanner.js';

/**
 * Stands in for vscode-oniguruma: scanners with the internals the shared scanner reads (`_ptr`,
 * `_onigBinding` with `_findNextOnigScannerMatch` and `HEAPU32`), patterns run as JS regular
 * expressions, and oniguruma's rule for the winner (the leftmost match; of equals the first listed).
 */
class FakeOnig implements IOnigLibLike {

	/** Pattern lists compiled, in order. */
	readonly compiled: string[][] = [];
	disposedScanners = 0;
	bindingCalls = 0;

	private readonly scanners = new Map<number, RegExp[]>();
	private readonly strings = new Map<number, string>();
	private lastId = 0;

	private readonly binding = {
		HEAPU32: new Uint32Array(16),
		_findNextOnigScannerMatch: (scanner: number, stringId: number, _stringPtr: number, _utf8Length: number, position: number, _options: number): number => {
			this.bindingCalls++;
			const found = this.search(this.scanners.get(scanner)!, this.strings.get(stringId)!, position);
			if (!found) {
				return 0;
			}
			this.binding.HEAPU32.set([found.index, 1, found.start, found.end], 8);
			return 32;
		},
	};

	constructor(private readonly withInternals = true) { }

	private search(patterns: RegExp[], text: string, position: number): { index: number; start: number; end: number } | undefined {
		let best: { index: number; start: number; end: number } | undefined;
		for (let index = 0; index < patterns.length; index++) {
			const pattern = patterns[index];
			pattern.lastIndex = position;
			const match = pattern.exec(text);
			if (!match) {
				continue;
			}
			if (!best || match.index < best.start) {
				best = { index, start: match.index, end: match.index + match[0].length };
			}
			if (match.index === position) {
				break;
			}
		}
		return best;
	}

	createOnigScanner(sources: string[]): IOnigScannerLike {
		this.compiled.push(sources);
		const ptr = ++this.lastId;
		const patterns = sources.map(source => new RegExp(source, 'g'));
		this.scanners.set(ptr, patterns);
		const scanner = {
			findNextMatchSync: (string: string | IOnigStringLike, startPosition: number): IOnigMatchLike | null => {
				const found = this.search(patterns, typeof string === 'string' ? string : string.content, startPosition);
				return found ? { index: found.index, captureIndices: [{ start: found.start, end: found.end, length: found.end - found.start }] } : null;
			},
			dispose: () => {
				this.disposedScanners++;
				this.scanners.delete(ptr);
			},
		};
		return this.withInternals ? Object.assign(scanner, { _ptr: ptr, _onigBinding: this.binding }) : scanner;
	}

	createOnigString(content: string): IOnigStringLike {
		const id = ++this.lastId;
		this.strings.set(id, content);
		const string = { content, dispose: () => { this.strings.delete(id); } };
		return this.withInternals ? Object.assign(string, { id, ptr: id, utf8Length: content.length, convertUtf16OffsetToUtf8: (offset: number) => offset }) : string;
	}

	/** Scanners made for a whole list (not the one-pattern scanners the shared patterns are). */
	get wholeLists(): string[][] {
		return this.compiled.filter(sources => sources.length > 1);
	}
}

suite('SharedOnigPatterns', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const lists = [
		['\\d+', '[a-z]+', 'foo'],
		['foo', '[a-z]+', '\\s+'],
		['x', 'y\\Gz', '[a-z]{2}', '\\d'],
	];
	const texts = ['foo 12 bar', '   ', '12ab yGz x9', ''];

	function allMatches(scanner: IOnigScannerLike, lib: IOnigLibLike, text: string): (IOnigMatchLike | null)[] {
		const string = lib.createOnigString(text);
		const matches: (IOnigMatchLike | null)[] = [];
		for (let position = 0; position <= text.length; position++) {
			matches.push(scanner.findNextMatchSync(string, position, 0));
		}
		string.dispose();
		return matches;
	}

	test('picks the match the library picks, from every position', () => {
		for (const busyCalls of [Number.MAX_SAFE_INTEGER, 3]) {
			const lib = new FakeOnig();
			const patterns = new SharedOnigPatterns(lib, busyCalls);
			for (const sources of lists) {
				const shared = patterns.createOnigScanner(sources);
				const own = lib.createOnigScanner(sources);
				for (const text of texts) {
					assert.deepStrictEqual(allMatches(shared, lib, text), allMatches(own, lib, text), `${sources.join(' | ')} on "${text}"`);
					// Backwards too: a remembered search must not answer for an earlier position.
					const string = lib.createOnigString(text);
					for (let position = text.length; position >= 0; position--) {
						assert.deepStrictEqual(shared.findNextMatchSync(string, position, 0), own.findNextMatchSync(string, position, 0));
					}
					string.dispose();
					assert.deepStrictEqual(shared.findNextMatchSync(text, 0, 0), own.findNextMatchSync(text, 0, 0), 'plain string');
					assert.deepStrictEqual(shared.findNextMatchSync(lib.createOnigString(text), 0, true), own.findNextMatchSync(text, 0, true), 'debug call');
				}
				shared.dispose();
				own.dispose();
			}
		}
	});

	test('compiles each distinct pattern once and frees it with its last scanner', () => {
		const lib = new FakeOnig();
		const patterns = new SharedOnigPatterns(lib, Number.MAX_SAFE_INTEGER);
		const first = patterns.createOnigScanner(lists[0]);
		const second = patterns.createOnigScanner(lists[1]);
		// The probe for the library's internals, then one scanner per distinct pattern.
		assert.deepStrictEqual(lib.compiled.slice(1), [['\\d+'], ['[a-z]+'], ['foo'], ['\\s+']]);
		assert.strictEqual(patterns.size, 4);

		const disposedBefore = lib.disposedScanners;
		first.dispose();
		assert.strictEqual(patterns.size, 3, 'only the first list had \\d+');
		assert.strictEqual(lib.disposedScanners, disposedBefore + 1);
		second.dispose();
		assert.strictEqual(patterns.size, 0);
		assert.strictEqual(lib.disposedScanners, disposedBefore + 4);
		assert.strictEqual(first.findNextMatchSync('foo', 0, 0), null, 'a disposed scanner finds nothing');
	});

	test('a search oniguruma answers from memory costs no call', () => {
		const lib = new FakeOnig();
		const patterns = new SharedOnigPatterns(lib, Number.MAX_SAFE_INTEGER);
		const scanner = patterns.createOnigScanner(['\\d+', 'zzz']);
		const string = lib.createOnigString('ab 12 cd');
		assert.strictEqual(scanner.findNextMatchSync(string, 0, 0)?.captureIndices[0].start, 3);
		const calls = lib.bindingCalls;
		// From 1 and 3 the number is still ahead (or at) the position and `zzz` still matches nothing.
		assert.strictEqual(scanner.findNextMatchSync(string, 1, 0)?.captureIndices[0].start, 3);
		assert.strictEqual(scanner.findNextMatchSync(string, 3, 0)?.captureIndices[0].start, 3);
		assert.strictEqual(lib.bindingCalls, calls);
		// Past the remembered match the number is searched again; `zzz` is not.
		assert.strictEqual(scanner.findNextMatchSync(string, 4, 0)?.captureIndices[0].start, 4);
		assert.strictEqual(lib.bindingCalls, calls + 1);
		// Another string, or other options, is another search of both.
		const other = lib.createOnigString('ab 12 cd');
		scanner.findNextMatchSync(other, 2, 0);
		assert.strictEqual(lib.bindingCalls, calls + 3);
		scanner.findNextMatchSync(other, 2, 4);
		assert.strictEqual(lib.bindingCalls, calls + 5);
		string.dispose();
		other.dispose();
		scanner.dispose();
	});

	test('a busy scanner becomes the library\'s own for its list', () => {
		const lib = new FakeOnig();
		const patterns = new SharedOnigPatterns(lib, 3);
		const busy = patterns.createOnigScanner(lists[0]);
		const quiet = patterns.createOnigScanner(lists[1]);
		const string = lib.createOnigString('foo 12 bar');
		busy.findNextMatchSync(string, 0, 0);
		busy.findNextMatchSync(string, 1, 0);
		assert.deepStrictEqual(lib.wholeLists, []);
		assert.deepStrictEqual(busy.findNextMatchSync(string, 4, 0), { index: 0, captureIndices: [{ start: 4, end: 6, length: 2 }] });
		assert.deepStrictEqual(lib.wholeLists, [lists[0]]);
		assert.strictEqual(patterns.size, 3, 'the patterns only the busy list had are freed');
		assert.deepStrictEqual(busy.findNextMatchSync(string, 7, 0), { index: 1, captureIndices: [{ start: 7, end: 10, length: 3 }] });
		assert.deepStrictEqual(quiet.findNextMatchSync(string, 3, 0), { index: 2, captureIndices: [{ start: 3, end: 4, length: 1 }] });

		const disposedBefore = lib.disposedScanners;
		busy.dispose();
		assert.strictEqual(lib.disposedScanners, disposedBefore + 1, 'its own scanner');
		quiet.dispose();
		string.dispose();
		assert.strictEqual(patterns.size, 0);
	});

	test('one-pattern lists and a library without the internals get the library\'s own scanners', () => {
		const lib = new FakeOnig();
		const patterns = new SharedOnigPatterns(lib);
		patterns.createOnigScanner(['foo']).dispose();
		assert.deepStrictEqual(lib.compiled, [['foo']]);
		assert.strictEqual(patterns.size, 0);

		const plain = new FakeOnig(false);
		const unsupported = new SharedOnigPatterns(plain);
		const scanner = unsupported.createOnigScanner(lists[0]);
		assert.deepStrictEqual(plain.wholeLists, [lists[0]]);
		assert.strictEqual(unsupported.size, 0);
		assert.strictEqual(scanner.findNextMatchSync('foo 12', 0, 0)?.index, 1);
		scanner.dispose();
	});
});
