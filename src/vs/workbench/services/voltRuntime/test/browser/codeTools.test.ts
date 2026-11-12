/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeIntelHost, ICodeLocation, ICodeNavIndex, runCodeNav } from '../../browser/tools/codeTools.js';

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
	});
});
