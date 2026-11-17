/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { declarationLineIn, declarationsOnly, declaredNameOn, enclosingName, ICodeIntelHost, ICodeLocation, ICodeNavIndex, IDiagnostic, outlineSymbols, runCodeAction, runCodeNav, runDiagnostics } from '../../browser/tools/codeTools.js';

suite('code_nav answers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/repo');
	const at = (path: string, line: number, preview: string): ICodeLocation => ({ uri: URI.file(`/repo/${path}`), line, column: 3, preview });

	function host(references: ICodeLocation[]): ICodeIntelHost {
		return {
			diagnostics: async () => [],
			definitions: async () => [],
			references: async () => references,
			symbols: async () => [],
			columnOf: async () => 3,
			lspAllowed: () => true,
			wordAt: async () => 'maxOccupancy',
		};
	}

	function index(references: ICodeLocation[]): ICodeNavIndex {
		return { definitions: async () => [], references: async () => references, outline: async () => [] };
	}

	test('references are grouped by file, the path written once', async () => {
		const result = await runCodeNav(host([at('a/service.ts', 10, 'x.maxOccupancy'), at('a/service.ts', 12, 'y.maxOccupancy'), at('b/other.ts', 4, 'z.maxOccupancy')]), root, { op: 'references', path: 'a/service.ts', line: 10, symbol: 'maxOccupancy' }, undefined);
		assert.strictEqual(result.text, '3 references in 2 files:\na/service.ts:\n  10: x.maxOccupancy\n  12: y.maxOccupancy\nb/other.ts:\n  4: z.maxOccupancy');
	});

	test('a language server answer confined to one file says where else the index sees the name', async () => {
		const declaration = at('schema/room.ts', 50, 'maxOccupancy: integer()');
		const nav = index([declaration, at('api/room.service.ts', 59, 'existing.maxOccupancy'), at('api/room.service.ts', 74, 'existing.maxOccupancy'), at('api/search.ts', 97, 't.maxOccupancy')]);
		const result = await runCodeNav(host([declaration]), root, { op: 'references', path: 'schema/room.ts', line: 50, symbol: 'maxOccupancy' }, nav);
		assert.ok(result.text.startsWith('1 reference:\nschema/room.ts:50  maxOccupancy: integer()'), result.text);
		assert.ok(result.text.includes('also appears in 2 other files (3 whole-word matches; by name, not type-checked'), result.text);
		assert.ok(result.text.includes('api/room.service.ts: 59, 74\napi/search.ts: 97'), result.text);
	});

	test('a language server answer across files is left alone', async () => {
		let asked = false;
		const nav: ICodeNavIndex = { definitions: async () => [], references: async () => { asked = true; return []; }, outline: async () => [] };
		const result = await runCodeNav(host([at('a.ts', 1, 'f()'), at('b.ts', 2, 'f()')]), root, { op: 'references', path: 'a.ts', line: 1, symbol: 'f' }, nav);
		assert.strictEqual(asked, false);
		assert.strictEqual(result.text, '2 references in 2 files:\na.ts:1  f()\nb.ts:2  f()');
	});

	test('implementations the language server cannot see come from the index, marked as such', async () => {
		const nav: ICodeNavIndex = {
			definitions: async () => [], references: async () => [], outline: async () => [],
			implementations: async (_root, name) => name === 'PaymentGateway' ? [at('apps/api/stripe-gateway.ts', 31, 'export class StripeGateway implements PaymentGateway {'), at('apps/api/mock-gateway.ts', 10, 'export class MockGateway implements PaymentGateway {')] : [],
		};
		const lsp = { ...host([]), implementations: async () => [] };
		const result = await runCodeNav(lsp, root, { op: 'implementations', path: 'packages/shared/payment-gateway.interface.ts', line: 66, symbol: 'PaymentGateway' }, nav);
		assert.strictEqual(result.text, '2 implementations in 2 files (from the code index: matched by name, not type-checked):\napps/api/stripe-gateway.ts:31  export class StripeGateway implements PaymentGateway {\napps/api/mock-gateway.ts:10  export class MockGateway implements PaymentGateway {');
	});

	suite('a line that misses the symbol', () => {

		// In the benchmark agents passed `line: 53` for a class on 54, `21` for one on 51, `1` for a method on 386.
		const lines = ['import { X } from "x";', '', '@Module({})', 'export class ReservationModule {}', '', 'export class Other {', '  cancelled = true;', '  async cancel(id: string) {', '    return id;', '  }', '}'];
		function fileHost(asked: { line: number; column: number }[]): ICodeIntelHost {
			return {
				...host([]),
				columnOf: async (_uri, line, symbol) => {
					const found = new RegExp(`\\b${symbol}\\b`).exec(lines[line - 1] ?? '');
					return found ? found.index + 1 : undefined;
				},
				fileText: async () => lines.join('\n'),
				definitions: async (uri, line, column) => {
					asked.push({ line, column });
					return [{ uri, line, column, preview: lines[line - 1].trim() }];
				},
			};
		}

		test('one or two lines off: the nearby line is used, and the answer says so', async () => {
			const asked: { line: number; column: number }[] = [];
			const result = await runCodeNav(fileHost(asked), root, { op: 'definition', path: 'a.ts', line: 3, symbol: 'ReservationModule' }, undefined);
			assert.deepStrictEqual(asked, [{ line: 4, column: 14 }]);
			assert.ok(!result.isError, result.text);
			assert.ok(result.text.startsWith('"ReservationModule" is on line 4, not 3.\n'), result.text);
		});

		test('further off: the file is searched by name, nearest whole-word use first', async () => {
			const asked: { line: number; column: number }[] = [];
			const result = await runCodeNav(fileHost(asked), root, { op: 'definition', path: 'a.ts', line: 1, symbol: 'cancel' }, undefined);
			assert.deepStrictEqual(asked, [{ line: 8, column: 9 }], 'not `cancelled` on line 7');
			assert.ok(result.text.startsWith('"cancel" is on line 8, not 1.\n'), result.text);
		});

		test('a name that is not in the file still fails', async () => {
			const result = await runCodeNav(fileHost([]), root, { op: 'definition', path: 'a.ts', line: 4, symbol: 'Missing' }, undefined);
			assert.strictEqual(result.isError, true);
			assert.strictEqual(result.text, '"Missing" does not appear on line 4 of a.ts or anywhere else in it.');
		});

		test('the given line wins when the symbol is on it', async () => {
			const asked: { line: number; column: number }[] = [];
			const result = await runCodeNav(fileHost(asked), root, { op: 'definition', path: 'a.ts', line: 7, symbol: 'cancelled' }, undefined);
			assert.deepStrictEqual(asked, [{ line: 7, column: 3 }]);
			assert.ok(!result.text.includes('not 7'), result.text);
		});

		test('no line: the symbol\'s declaration in the file is used', async () => {
			// The hotel benchmark's warm-up: { op: 'references', path, symbol: 'StateReader' } answered "This op needs line".
			const asked: { line: number; column: number }[] = [];
			const result = await runCodeNav(fileHost(asked), root, { op: 'definition', path: 'a.ts', symbol: 'Other.cancel' }, undefined);
			assert.deepStrictEqual(asked, [{ line: 8, column: 9 }]);
			assert.ok(!result.isError, result.text);
			assert.ok(!result.text.includes(' not '), result.text);
		});
	});

	test('declarationLineIn prefers a declaration to a use, and finds a member after its type', () => {
		const text = ['import { StateReader } from "./query";', 'const r: StateReader = x;', 'export interface StateReader {', '  query(sql: string): Row[];', '}', 'reader.query("x");'].join('\n');
		assert.strictEqual(declarationLineIn(text, 'StateReader'), 3);
		assert.strictEqual(declarationLineIn(text, 'StateReader.query'), 4);
		assert.strictEqual(declarationLineIn(text, 'nothingHere'), undefined);
	});

	test('a symbol without a path is found by its declaration; tests lose to the real one, ties are listed', async () => {
		const ref = (path: string, line: number, name = 'StateReader', container?: string) => ({ name, kind: 'interface', uri: URI.file(`/repo/${path}`), line, column: 18, ...(container ? { container } : {}) });
		const asked: string[] = [];
		const lsp = (symbols: ReturnType<typeof ref>[]): ICodeIntelHost => ({ ...host([]), workspaceSymbols: async () => symbols, references: async (uri, line) => { asked.push(`${uri.path}:${line}`); return [at('x.ts', 1, 'StateReader')]; } });
		const found = await runCodeNav(lsp([ref('packages/domain/test/fake.test.ts', 3), ref('packages/domain/src/query.ts', 41)]), root, { op: 'references', symbol: 'StateReader' }, undefined);
		assert.ok(!found.isError, found.text);
		assert.deepStrictEqual(asked, ['/repo/packages/domain/src/query.ts:41']);
		const tie = await runCodeNav(lsp([ref('a/one.ts', 3), ref('b/two.ts', 9)]), root, { op: 'references', symbol: 'StateReader' }, undefined);
		assert.strictEqual(tie.isError, true);
		assert.ok(tie.text.startsWith('"StateReader" is declared in 2 places; pass path (and line) for the one you mean:\ninterface StateReader  a/one.ts:3\ninterface StateReader  b/two.ts:9'), tie.text);
	});

	test('workspace symbols of another project the language server has loaded are not this chat\'s', async () => {
		const other = { name: 'PriceRule', kind: 'interface', uri: URI.file('/other/src/pricing/rule.ts'), line: 4, column: 18 };
		const own = { name: 'PriceRule', kind: 'interface', uri: URI.file('/repo/pricing/rule.go'), line: 6, column: 6 };
		const asked: string[] = [];
		const lsp = (symbols: (typeof own)[]): ICodeIntelHost => ({ ...host([]), workspaceSymbols: async () => symbols, references: async uri => { asked.push(uri.path); return [at('pricing/rule.go', 6, 'type PriceRule interface {')]; } });
		const listed = await runCodeNav(lsp([other, own]), root, { op: 'workspace_symbols', query: 'PriceRule' }, undefined);
		assert.strictEqual(listed.text, '1 symbol matching "PriceRule":\ninterface PriceRule  pricing/rule.go:6');
		await runCodeNav(lsp([other, own]), root, { op: 'references', symbol: 'PriceRule' }, undefined);
		assert.deepStrictEqual(asked, ['/repo/pricing/rule.go']);
		// Only the other project has it: the index answers for this one (here: nothing), never the other project's file.
		const none = await runCodeNav(lsp([other]), root, { op: 'references', symbol: 'PriceRule' }, index([]));
		assert.strictEqual(none.isError, true);
		assert.doesNotMatch(none.text, /other/);
		assert.doesNotMatch((await runCodeNav(lsp([other]), root, { op: 'workspace_symbols', query: 'PriceRule' }, index([]))).text, /other/);
	});

	test('diagnostics never says "no errors" for a file nothing checks, or for a project it only knows the open files of', async () => {
		const go = URI.file('/repo/api/refund.go');
		const withUnchecked = (found: IDiagnostic[]): ICodeIntelHost => ({ ...host([]), diagnostics: async () => found, unchecked: async uris => uris.filter(uri => uri.path.endsWith('.go') || uri.path.endsWith('.py')) });
		const none = await runDiagnostics(withUnchecked([]), root, { paths: ['api/refund.go'] });
		assert.strictEqual(none.isError, true);
		assert.strictEqual(none.text, 'Not checked: api/refund.go. No language service in Volt covers this file (no extension for the language is installed), so this says nothing about its errors. Run `go vet ./...` (or `go build ./...`) with your shell tool.');
		const mixed = await runDiagnostics(withUnchecked([]), root, { paths: ['src/a.ts', 'shop/refund.py'] });
		assert.ok(!mixed.isError);
		assert.match(mixed.text, /^No errors in src\/a\.ts\.\nNot checked: shop\/refund\.py\. .*py_compile/);
		const found = await runDiagnostics(withUnchecked([{ uri: URI.file('/repo/src/a.ts'), line: 4, column: 9, severity: 'error', message: 'Cannot find name \'x\'.', source: 'ts', code: '2304' }]), root, { paths: ['src/a.ts', 'api/refund.go'] });
		assert.match(found.text, /^1 error, 0 other:\nsrc\/a\.ts:4:9 error 2304: Cannot find name 'x'\. \(ts\)\nNot checked: api\/refund\.go\./);
		void go;
		// A checked file with nothing to report is still a plain answer.
		assert.strictEqual((await runDiagnostics(withUnchecked([]), root, { paths: ['src/a.ts'] })).text, 'No errors in src/a.ts.');
		// No paths: what the language services have open, said as such.
		const all = await runDiagnostics(withUnchecked([]), root, {});
		assert.match(all.text, /^No errors in the files the language services have open\. That is not the whole project/);
		assert.doesNotMatch(all.text, /in the workspace/);
	});

	test('a rename that would reach outside the project changes nothing', async () => {
		// The hotel copy's node_modules link into another checkout: a rename through them would edit it.
		let wrote = 0;
		const write = async () => { wrote++; return { added: 1, removed: 1, text: '' }; };
		const lsp = (paths: string[]): ICodeIntelHost => ({ ...host([]), fileText: async () => 'export function lineTotal() {}', rename: async () => paths.map(path => ({ uri: URI.file(path), before: 'lineTotal', after: 'lineAmount' })) });
		const ctx = { signal: new AbortController().signal } as Parameters<typeof runCodeAction>[4];
		const refused = await runCodeAction(lsp(['/repo/src/cart.ts', '/elsewhere/node_modules/pkg/cart.ts']), root, { op: 'rename', path: 'src/cart.ts', line: 1, symbol: 'lineTotal', new_name: 'lineAmount' }, write, ctx);
		assert.strictEqual(refused.isError, true);
		assert.ok(refused.text.includes('outside this project (/elsewhere/node_modules/pkg/cart.ts)'), refused.text);
		assert.strictEqual(wrote, 0);
		const done = await runCodeAction(lsp(['/repo/src/cart.ts', '/repo/test/cart.test.ts']), root, { op: 'rename', path: 'src/cart.ts', line: 1, symbol: 'lineTotal', new_name: 'lineAmount' }, write, ctx);
		assert.ok(!done.isError, done.text);
		assert.strictEqual(wrote, 2);
	});

	test('a line without symbol or column names what is declared on it', () => {
		// "Pass column or symbol." answered { op: 'inspect', path, line: 43 } in the hotel benchmark.
		const text = 'export interface StateReader {\n  query(sql: string): Row[];\n  if (x) {\n}';
		assert.strictEqual(declaredNameOn(text, 1), 'StateReader');
		assert.strictEqual(declaredNameOn(text, 2), 'query');
		assert.strictEqual(declaredNameOn(text, 3), undefined);
		assert.strictEqual(declaredNameOn(text, 9), undefined);
	});

	test('the index\'s declarations leave out import specifiers', () => {
		const found = declarationsOnly([at('a.ts', 1, 'type StateReader,'), at('b.ts', 2, 'import type { StateReader } from "x";'), at('c.ts', 41, 'export interface StateReader {'), at('d.ts', 5, 'StateReader as Reader,')]);
		assert.deepStrictEqual(found?.map(location => location.uri.path), ['/repo/c.ts']);
	});

	test('the outline leaves out locals and callbacks inside function bodies', () => {
		const symbols = [
			{ name: 'bookingsRouter', kind: 'constant', line: 1, endLine: 40, depth: 0 },
			{ name: 'create', kind: 'property', line: 2, endLine: 20, depth: 1 },
			{ name: 'handler() callback', kind: 'function', line: 3, endLine: 19, depth: 2 },
			{ name: 'tenant', kind: 'variable', line: 4, endLine: 4, depth: 3 },
			{ name: 'quote', kind: 'property', line: 21, endLine: 39, depth: 1 },
			{ name: 'priceBooking', kind: 'function', line: 42, endLine: 60, depth: 0 },
			{ name: 'total', kind: 'variable', line: 43, endLine: 43, depth: 1 },
		];
		assert.deepStrictEqual(outlineSymbols(symbols).map(symbol => symbol.name), ['bookingsRouter', 'create', 'quote', 'priceBooking']);
		assert.strictEqual(enclosingName(symbols, 4), 'bookingsRouter.create');
		assert.strictEqual(enclosingName(symbols, 43), 'priceBooking');
	});

	test('callers with depth walk callers of callers, and name the procedures a module-level call is in', async () => {
		const file = (path: string) => URI.file(`/repo/${path}`);
		const edge = (name: string, kind: string, path: string, line: number, sites: number[]) => ({ name, kind, uri: file(path), line, column: 7, sites });
		const graph: Record<string, ReturnType<typeof edge>[]> = {
			'/repo/lib/pricing.ts:10': [edge('priceBooking', 'function', 'services/quote.ts', 300, [362]), edge('quoteBooking', 'function', 'services/quote.ts', 788, [815])],
			'/repo/services/quote.ts:300': [edge('index.ts', 'module', 'routers/bookings.ts', 1, [1830])],
			'/repo/services/quote.ts:788': [edge('index.ts', 'module', 'routers/bookings.ts', 1, [1580])],
		};
		const routerOutline = [
			{ name: 'bookingsRouter', kind: 'constant', line: 1500, endLine: 2100, depth: 0 },
			{ name: 'quote', kind: 'property', line: 1576, endLine: 1582, depth: 1 },
			{ name: 'create', kind: 'property', line: 1583, endLine: 2050, depth: 1 },
		];
		const lsp: ICodeIntelHost = {
			...host([]),
			calls: async (uri, line) => graph[`${uri.path}:${line}`] ?? [],
			symbols: async uri => uri.path.endsWith('routers/bookings.ts') ? routerOutline : [],
		};
		const result = await runCodeNav(lsp, root, { op: 'callers', path: 'lib/pricing.ts', line: 10, symbol: 'resolveBookingStayRent', depth: 3 }, undefined);
		assert.ok(!result.isError, result.text);
		const lines = result.text.split('\n');
		assert.ok(lines[0].startsWith('Callers of resolveBookingStayRent (lib/pricing.ts:10:3), 3 levels, 4 functions:'), result.text);
		assert.deepStrictEqual(lines.slice(1, 5), [
			'function priceBooking  services/quote.ts:300 (calls at 362)',
			'  routers/bookings.ts: calls in bookingsRouter.create (1830)',
			'function quoteBooking  services/quote.ts:788 (calls at 815)',
			'  routers/bookings.ts: calls in bookingsRouter.quote (1580)',
		]);
	});

	test('implementations: places typed as the interface in files the language server did not report are listed', async () => {
		const nav: ICodeNavIndex = {
			definitions: async () => [], outline: async () => [],
			references: async () => [at('packages/domain/src/query.ts', 41, 'export interface StateReader {'), at('apps/api/src/sync/commands.ts', 88, 'export const postgresReader = (db: Db): StateReader => ({'), at('apps/api/src/sync/commands.ts', 23, 'import type { StateReader } from "@hotel/domain";'), at('packages/sync/src/commands.ts', 39, 'const sqliteReader: StateReader = {')],
		};
		const lsp: ICodeIntelHost = { ...host([]), implementations: async () => [at('packages/domain/src/memory.ts', 9, 'export class MemoryStore implements StateReader {')] };
		const result = await runCodeNav(lsp, root, { op: 'implementations', path: 'packages/domain/src/query.ts', line: 41, symbol: 'StateReader' }, nav);
		assert.ok(result.text.startsWith('1 implementation:\npackages/domain/src/memory.ts:9'), result.text);
		assert.ok(result.text.includes('These 2 places type something as StateReader in files it did not report (matched by name, not type-checked):\napps/api/src/sync/commands.ts:88  export const postgresReader = (db: Db): StateReader => ({\npackages/sync/src/commands.ts:39  const sqliteReader: StateReader = {'), result.text);
	});
});
