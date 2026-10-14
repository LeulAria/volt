/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PREFIX_CHARS, SymbolNameIndex } from '../../common/symbolNameIndex.js';

/** Deterministic names: shared prefixes, case variants, short names and non-ASCII. */
function names(count: number): string[] {
	const parts = ['sched', 'Sched', 'SCHED', 'get', 'set', 'User', 'user', 'x', 'io', 'na\u00efve', 'Stra\u00dfe', '_init', 'fair', 'Rq'];
	const out: string[] = [];
	let seed = 7;
	const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff);
	for (let i = 0; i < count; i++) {
		const length = 1 + next() % 3;
		let name = '';
		for (let j = 0; j < length; j++) {
			name += parts[next() % parts.length];
		}
		out.push(name);
	}
	return out;
}

suite('Volt code index: symbol name lookup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const all = names(20_000);
	const index = new SymbolNameIndex(all);
	const brute = (test: (lower: string) => boolean) => all.map((name, i) => [name, i] as const).filter(([name]) => test(name.toLowerCase())).map(([, i]) => i);

	test('exact, ignoring case, equals a pass over every name', () => {
		for (const query of ['sched', 'schedfair', 'userget', 'x', 'na\u00efveio', 'stra\u00dfe_init', 'nothing-like-this', '']) {
			assert.deepStrictEqual(index.equal(query), brute(name => name === query), query);
		}
	});

	test('prefix, ignoring case, equals a pass over every name', () => {
		for (const query of ['sche', 'schedfa', 'user', 'getsets', 'na\u00efv', 'zzzz']) {
			assert.deepStrictEqual(index.startingWith(query), brute(name => name.startsWith(query)), query);
		}
	});

	test('prefixes shorter than the hashed length are left to a scan', () => {
		assert.strictEqual(index.startingWith('sch'.slice(0, PREFIX_CHARS - 1)), undefined);
	});

	test('an empty table', () => {
		const empty = new SymbolNameIndex([]);
		assert.deepStrictEqual(empty.equal('a'), []);
		assert.deepStrictEqual(empty.startingWith('abcd'), []);
	});
});
