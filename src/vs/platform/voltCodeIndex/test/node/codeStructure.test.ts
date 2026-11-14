/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CodeIndexEngine } from '../../node/codeIndexEngine.js';
import { parseLooseJson } from '../../node/codeStructure.js';
import { metaToIdentifiers, TreeSitterParsers } from '../../node/treeSitterStructure.js';

/**
 * The code index's structure layer: declarations with their ranges, imports and the reverse import
 * graph from tree-sitter, and structural search, with no language server running.
 */
suite('Volt code index: structure (tree-sitter)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let ws: string;
	let engine: CodeIndexEngine;

	suiteSetup(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `volt-index-structure-${generateUuid().slice(0, 8)}-`)));
		ws = join(base, 'ws');
		await fs.mkdir(join(ws, 'src', 'lib'), { recursive: true });
		await fs.mkdir(join(ws, 'pkg'), { recursive: true });
		const files: Record<string, string> = {
			'src/a.ts': [
				'/** Doubles. */',
				'export function foo(x: number) {',
				'\tconst local = bar(x);',
				'\treturn local * 2;',
				'}',
				'export class Box {',
				'\topen(): number {',
				'\t\treturn 1;',
				'\t}',
				'}',
				'export const router = {',
				'\tlist: () => 1,',
				'\tget: async () => 2,',
				'};',
				'function bar(x: number) { return x; }',
				'',
			].join('\n'),
			'src/b.ts': 'import { foo } from \'./a.js\';\nexport const y = foo(1);\nexport const z = foo(y, 2);\n',
			'src/c.test.ts': 'import { y } from \'./b\';\nimport * as lib from \'@app/lib/util\';\nfoo(2);\n',
			'src/d.ts': 'import type { Box } from "./a";\nexport type B = Box;\n',
			'src/lib/util.ts': 'export const util = 1;\n',
			'src/e.ts': 'const x = 1; // mentions a but imports nothing\n',
			'tsconfig.json': '{\n\t// comments are allowed\n\t"compilerOptions": { "paths": { "@app/*": ["src/*"], }, },\n}\n',
			'pkg/__init__.py': '',
			'pkg/mod.py': 'MAX_SIZE = 3\n\ndef helper():\n    pass\n\nclass K:\n    def m(self):\n        return 1\n',
			'pkg/use.py': 'from .mod import helper, K\nimport os\n',
		};
		for (const [path, text] of Object.entries(files)) {
			await fs.writeFile(join(ws, path), text);
		}
		engine = new CodeIndexEngine(join(base, 'data'), () => { });
	});

	suiteTeardown(async () => {
		await engine?.dispose();
		await fs.rm(base, { recursive: true, force: true });
	});

	test('outline: declarations with their whole range, members under their container, no locals', async () => {
		const result = await engine.structure({ root: ws, path: 'src/a.ts', waitMs: 30_000 });
		assert.strictEqual(result.kind, 'results');
		const shown = result.kind === 'results' ? result.symbols.map(symbol => `${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name} ${symbol.line}-${symbol.endLine}`) : [];
		assert.deepStrictEqual(shown, [
			'function foo 2-5',
			'class Box 6-10',
			'method Box.open 7-9',
			'constant router 11-14',
			'method router.list 12-12',
			'method router.get 13-13',
			'function bar 15-15',
		]);
	});

	test('imports resolve to files: relative with .js for .ts, without extension, tsconfig paths', async () => {
		const b = await engine.structure({ root: ws, path: 'src/b.ts', waitMs: 30_000 });
		assert.deepStrictEqual(b.kind === 'results' ? b.imports.map(item => [item.specifier, item.resolved, item.names.join(',')]) : [], [['./a.js', 'src/a.ts', 'foo']]);
		const c = await engine.structure({ root: ws, path: 'src/c.test.ts', waitMs: 30_000 });
		assert.deepStrictEqual(c.kind === 'results' ? c.imports.map(item => [item.specifier, item.resolved]) : [], [['./b', 'src/b.ts'], ['@app/lib/util', 'src/lib/util.ts']]);
	});

	test('importers: direct ones, then files importing those (the tests to run)', async () => {
		const direct = await engine.importers({ root: ws, path: 'src/a.ts', limit: 50, waitMs: 30_000 });
		assert.deepStrictEqual(direct.kind === 'results' ? direct.importers.map(item => `${item.path}:${item.line}`).sort() : [], ['src/b.ts:1', 'src/d.ts:1']);
		const two = await engine.importers({ root: ws, path: 'src/a.ts', depth: 2, limit: 50, waitMs: 30_000 });
		assert.deepStrictEqual(two.kind === 'results' ? two.importers.filter(item => item.depth === 2).map(item => `${item.path} via ${item.via}`) : [], ['src/c.test.ts via src/b.ts']);
	});

	test('python: outline and relative imports', async () => {
		const outline = await engine.structure({ root: ws, path: 'pkg/mod.py', waitMs: 30_000 });
		assert.deepStrictEqual(outline.kind === 'results' ? outline.symbols.map(symbol => `${symbol.kind} ${symbol.name} ${symbol.line}-${symbol.endLine}`) : [], ['constant MAX_SIZE 1-1', 'function helper 3-4', 'class K 6-8', 'method m 7-8']);
		const importers = await engine.importers({ root: ws, path: 'pkg/mod.py', limit: 10, waitMs: 30_000 });
		assert.deepStrictEqual(importers.kind === 'results' ? importers.importers.map(item => `${item.path} ${item.names.join(',')}`) : [], ['pkg/use.py helper,K']);
	});

	test('structural search: metavariables, $$$ for any arguments, a repeated name must repeat', async () => {
		const one = await engine.structural({ root: ws, pattern: 'foo($A)', maxMatches: 20, waitMs: 30_000 });
		assert.deepStrictEqual(one.kind === 'results' ? one.matches.map(match => `${match.path}:${match.line} ${JSON.stringify(match.vars)}`) : one, ['src/b.ts:2 {"A":"1"}', 'src/c.test.ts:3 {"A":"2"}']);
		const any = await engine.structural({ root: ws, pattern: 'foo($$$)', maxMatches: 20, waitMs: 30_000 });
		assert.strictEqual(any.kind === 'results' ? any.matches.length : -1, 3);
		const same = await engine.structural({ root: ws, pattern: 'foo($A, $A)', maxMatches: 20, waitMs: 30_000 });
		assert.strictEqual(same.kind === 'results' ? same.matches.length : -1, 0);
		const python = await engine.structural({ root: ws, pattern: 'def $F(self): $$$', language: 'python', maxMatches: 20, waitMs: 30_000 });
		assert.deepStrictEqual(python.kind === 'results' ? python.matches.map(match => `${match.path}:${match.line} ${match.vars?.F}`) : python, ['pkg/mod.py:7 m']);
	});

	test('a pattern that is not code says so', async () => {
		const parsers = new TreeSitterParsers();
		const result = await parsers.match('typescript', 'foo(( $A', 'foo(1)', 10);
		assert.strictEqual(typeof result, 'string');
		assert.strictEqual(metaToIdentifiers('python', 'f($A, $$$)'), 'f(\u00b5A, \u00b5\u00b5\u00b5)');
	});

	test('tsconfig with comments and trailing commas parses', () => {
		assert.deepStrictEqual(parseLooseJson('{ // x\n "a": [1, 2,], /* y */ "b": "http://z" }'), { a: [1, 2], b: 'http://z' });
	});
});
