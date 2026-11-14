/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICallEdge, ICodeIntelHost, ICodeLocation, ICodeNavIndex, ICodeSymbol, isTestPath, runCodeNav, splitPathSymbol } from '../../browser/tools/codeTools.js';

/**
 * code_nav's impact, body and structural ops: one call for what a change reaches, one symbol's
 * source instead of a whole file, and search by code shape.
 */
suite('code_nav impact, body, structural', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/repo');
	const file = (path: string) => URI.file(`/repo/${path}`);
	const at = (path: string, line: number, preview: string): ICodeLocation => ({ uri: file(path), line, column: 10, preview });

	const pricing = [
		'import { round } from "./math";',
		'',
		'/**',
		' * The price of a stay.',
		' */',
		'export function priceStay(nights: number, rate: number) {',
		'\tconst base = nights * rate;',
		'\treturn round(base);',
		'}',
		'',
		'export class Quote {',
		'\ttotal(): number {',
		'\t\treturn priceStay(1, 2);',
		'\t}',
		'}',
	].join('\n');
	const outline: ICodeSymbol[] = [
		{ name: 'priceStay', kind: 'function', line: 6, endLine: 9, depth: 0 },
		{ name: 'base', kind: 'variable', line: 7, endLine: 7, depth: 1 },
		{ name: 'Quote', kind: 'class', line: 11, endLine: 15, depth: 0 },
		{ name: 'total', kind: 'method', line: 12, endLine: 14, depth: 1 },
	];

	function host(overrides: Partial<ICodeIntelHost> = {}): ICodeIntelHost {
		return {
			diagnostics: async () => [],
			definitions: async () => [],
			references: async () => [],
			symbols: async uri => uri.path.endsWith('pricing.ts') ? outline : [],
			columnOf: async (_uri, line, symbol) => {
				const index = (pricing.split('\n')[line - 1] ?? '').indexOf(symbol);
				return index >= 0 ? index + 1 : undefined;
			},
			lspAllowed: () => true,
			wordAt: async () => undefined,
			fileText: async uri => uri.path.endsWith('pricing.ts') ? pricing : undefined,
			...overrides,
		};
	}

	test('path#symbol is split into path and symbol', () => {
		assert.deepStrictEqual(splitPathSymbol({ op: 'body', path: 'src/pricing.ts#priceStay' }), { op: 'body', path: 'src/pricing.ts', symbol: 'priceStay' });
		assert.deepStrictEqual(splitPathSymbol({ op: 'body', symbol: 'src/pricing.ts#Quote.total' }), { op: 'body', path: 'src/pricing.ts', symbol: 'Quote.total' });
		assert.deepStrictEqual(splitPathSymbol({ op: 'body', symbol: '#private' }), { op: 'body', symbol: '#private' });
	});

	test('test files by convention', () => {
		assert.deepStrictEqual(['src/a.test.ts', 'src/__tests__/a.ts', 'pkg/test_mod.py', 'cmd/x_test.go', 'src/a.ts', 'src/testing.ts', 'src/contest/a.ts'].map(isTestPath), [true, true, true, true, false, false, false]);
	});

	test('body: the declaration with its doc comment and line numbers, not the file', async () => {
		const result = await runCodeNav(host(), root, { op: 'body', path: 'src/pricing.ts#priceStay' }, undefined);
		assert.strictEqual(result.text, [
			'src/pricing.ts:6-9 function priceStay',
			'    3  /**',
			'    4   * The price of a stay.',
			'    5   */',
			'    6  export function priceStay(nights: number, rate: number) {',
			'    7  \tconst base = nights * rate;',
			'    8  \treturn round(base);',
			'    9  }',
		].join('\n'));
	});

	test('body: a member by Type.member, several symbols in one call', async () => {
		const result = await runCodeNav(host(), root, { op: 'body', path: 'src/pricing.ts', symbol: 'Quote.total, priceStay' }, undefined);
		assert.ok(result.text.startsWith('src/pricing.ts:12-14 method total\n   12  \ttotal(): number {\n   13  \t\treturn priceStay(1, 2);\n   14  \t}\n\nsrc/pricing.ts:6-9 function priceStay'), result.text);
	});

	test('body without a language server: ranges from the syntax tree', async () => {
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			structure: async () => ({ symbols: [{ name: 'Quote', kind: 'class', line: 11, endLine: 15, column: 14, depth: 0 }], imports: [] }),
		};
		const result = await runCodeNav(host({ lspAllowed: () => false }), root, { op: 'body', path: 'src/pricing.ts', symbol: 'Quote' }, nav);
		assert.ok(result.text.startsWith('src/pricing.ts:11-15 class Quote\n   11  export class Quote {'), result.text);
		assert.ok(result.text.endsWith('   15  }'), result.text);
	});

	test('impact: callers up the chain, files that use or import it, the tests to run, errors now', async () => {
		const edge = (name: string, path: string, line: number, sites: number[]): ICallEdge => ({ name, kind: 'function', uri: file(path), line, column: 5, sites });
		const calls = async (uri: URI, line: number): Promise<ICallEdge[]> => {
			if (uri.path.endsWith('pricing.ts') && line === 6) {
				return [edge('quoteBooking', 'src/booking.ts', 20, [24])];
			}
			if (uri.path.endsWith('booking.ts')) {
				return [edge('createBooking', 'src/routes.ts', 40, [41])];
			}
			return [];
		};
		const lsp = host({
			references: async () => [
				at('src/pricing.ts', 6, 'export function priceStay(nights: number, rate: number) {'),
				at('src/pricing.ts', 13, 'return priceStay(1, 2);'),
				at('src/booking.ts', 2, 'import { priceStay } from "./pricing";'),
				at('src/booking.ts', 24, 'const price = priceStay(n, r);'),
				at('src/pricing.test.ts', 5, 'expect(priceStay(2, 10)).toBe(20);'),
			],
			calls,
			diagnostics: async uris => uris?.some(uri => uri.path.endsWith('booking.ts')) ? [{ uri: file('src/booking.ts'), line: 24, column: 3, severity: 'error', message: 'Expected 2 arguments, but got 1.' }] : [],
		});
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			importers: async (_root, uri) => uri.path.endsWith('booking.ts') ? [{ path: 'src/booking.test.ts', line: 1, names: ['quoteBooking'], depth: 1, uri: file('src/booking.test.ts') }] : [],
		};
		const result = await runCodeNav(lsp, root, { op: 'impact', path: 'src/pricing.ts', symbol: 'priceStay' }, nav);
		assert.strictEqual(result.text, [
			'Impact of `priceStay` (function, src/pricing.ts:6-9):',
			'',
			'Callers, 3 levels (1 with no callers: entry points or used by name):',
			'  quoteBooking  src/booking.ts:20 (calls at 24)',
			'    createBooking  src/routes.ts:40 (calls at 41)  [no callers]',
			'',
			'5 references; 4 files affected (1 import it):',
			'  src/pricing.ts  uses 13',
			'  src/booking.ts  imports; uses 24',
			'  src/pricing.test.ts [test]  uses 5',
			'  src/routes.ts  calls it indirectly',
			'',
			'Tests to run (2):',
			'  src/pricing.test.ts  (uses it)',
			'  src/booking.test.ts  (imports src/booking.ts)',
			'',
			'Errors now (1):',
			'  src/booking.ts:24 Expected 2 arguments, but got 1.',
		].join('\n'));
	});

	test('impact of a file: its importers, the tests among them', async () => {
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			importers: async () => [
				{ path: 'src/booking.ts', line: 2, names: ['priceStay'], depth: 1, uri: file('src/booking.ts') },
				{ path: 'src/booking.test.ts', line: 1, names: ['quoteBooking'], depth: 2, via: 'src/booking.ts', uri: file('src/booking.test.ts') },
			],
		};
		const result = await runCodeNav(host(), root, { op: 'impact', path: 'src/pricing.ts' }, nav);
		assert.strictEqual(result.text, [
			'Impact of src/pricing.ts (by the import graph):',
			'',
			'Imported by 1 file:',
			'  src/booking.ts:2  priceStay',
			'',
			'Through those, 1 more: src/booking.test.ts',
			'',
			'Tests to run (1): src/booking.test.ts',
			'',
			'Errors now: none in src/pricing.ts.',
		].join('\n'));
	});

	test('structural: matches grouped by file with their bindings; a bad pattern says why', async () => {
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			structural: async (_root, request) => request.pattern.includes('((') ? 'The pattern does not parse as code.' : {
				matches: [
					{ path: 'src/a.ts', line: 3, endLine: 3, text: 'fetchUser(id, { cache: true })', vars: { ID: 'id' } },
					{ path: 'src/a.ts', line: 9, endLine: 11, text: 'fetchUser(other, {', vars: { ID: 'other' } },
				],
				limitHit: false,
				scanned: 4,
			},
		};
		const found = await runCodeNav(host(), root, { op: 'structural', pattern: 'fetchUser($ID, $$$)' }, nav);
		assert.strictEqual(found.text, '2 matches in 1 file:\nsrc/a.ts:\n  3: fetchUser(id, { cache: true })  {ID=id}\n  9-11: fetchUser(other, {  {ID=other}');
		const bad = await runCodeNav(host(), root, { op: 'structural', pattern: 'f((' }, nav);
		assert.strictEqual(bad.isError, true);
	});

	test('structural: glob splits into files to search and files to skip (!), where passes through', async () => {
		let seen: unknown;
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			structural: async (_root, request) => { seen = request; return { matches: [], limitHit: false, scanned: 2 }; },
		};
		await runCodeNav(host(), root, { op: 'structural', pattern: 'setTimeout($F, $MS)', glob: '**/*.ts, !**/*.test.*', where: { MS: '^\\d', bad: 3 } }, nav);
		const request = seen as { includes?: string[]; excludes?: string[]; where?: Record<string, string> };
		assert.deepStrictEqual([request.includes, request.excludes, request.where], [['**/*.ts'], ['**/*.test.*'], { MS: '^\\d' }]);
	});
});
