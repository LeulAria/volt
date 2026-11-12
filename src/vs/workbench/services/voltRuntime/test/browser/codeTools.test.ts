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
});
