/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatLineCount, guessPastedLanguage, pastedChipSummary, pastedFileName } from '../../common/agentPastedText.js';

function repeat(line: (i: number) => string, count: number): string {
	return Array.from({ length: count }, (_, i) => line(i)).join('\n');
}

suite('agentPastedText', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('line counts read like numbers', () => {
		assert.strictEqual(formatLineCount(1), '1 line');
		assert.strictEqual(formatLineCount(1203), '1,203 lines');
		assert.strictEqual(formatLineCount(1_250_000), '1,250,000 lines');
	});

	test('the chip summary names the language only when there is one', () => {
		assert.strictEqual(pastedChipSummary('48 KB', 1203), 'Pasted text · 48 KB · 1,203 lines');
		assert.strictEqual(pastedChipSummary('48 KB', 1203, guessPastedLanguage('{"a": 1}')), 'Pasted text · JSON · 48 KB · 1,203 lines');
		assert.strictEqual(pastedChipSummary('2 KB', undefined, guessPastedLanguage('hello there')), 'Pasted text · 2 KB');
	});

	test('structured formats', () => {
		assert.strictEqual(guessPastedLanguage(JSON.stringify({ items: [1, 2, 3], ok: true }, null, 2)).id, 'json');
		// Cut off mid-way: still JSON by its shape.
		assert.strictEqual(guessPastedLanguage('{\n  "name": "volt",\n  "deps": {\n    "a": "1"').id, 'json');
		assert.strictEqual(guessPastedLanguage(repeat(i => `{"i": ${i}, "ok": true}`, 20)).ext, 'jsonl');
		assert.strictEqual(guessPastedLanguage('<?xml version="1.0"?>\n<root><a/></root>').id, 'xml');
		assert.strictEqual(guessPastedLanguage('<!DOCTYPE html>\n<html><body><div>x</div></body></html>').id, 'html');
		assert.strictEqual(guessPastedLanguage('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b').id, 'diff');
		assert.strictEqual(guessPastedLanguage(repeat(i => `name${i},${i},${i * 2},note`, 10)).id, 'csv');
		assert.strictEqual(guessPastedLanguage(repeat(i => `name${i}\t${i}\t${i * 2}`, 10)).id, 'tsv');
	});

	test('logs and stack traces', () => {
		assert.strictEqual(guessPastedLanguage(repeat(i => `2026-10-08T12:00:${String(i % 60).padStart(2, '0')}Z INFO request ${i} served`, 50)).id, 'log');
		assert.strictEqual(guessPastedLanguage(repeat(i => `[worker] ERROR job ${i} failed: timeout`, 20)).id, 'log');
		assert.strictEqual(guessPastedLanguage('TypeError: x is undefined\n    at foo (/a/b.js:10:5)\n    at bar (/a/c.js:2:1)\n    at baz (/a/d.js:3:3)').id, 'log');
	});

	test('code by its tell-tale lines', () => {
		assert.strictEqual(guessPastedLanguage([
			'import { foo } from \'./foo\';',
			'export interface IThing {',
			'	readonly name: string;',
			'}',
			'export function make(name: string): IThing {',
			'	return { name };',
			'}',
		].join('\n')).id, 'typescript');
		assert.strictEqual(guessPastedLanguage([
			'const fs = require(\'fs\');',
			'const data = fs.readFileSync(\'x\');',
			'module.exports = function run() {',
			'	return data.length;',
			'};',
		].join('\n')).id, 'javascript');
		assert.strictEqual(guessPastedLanguage([
			'import os',
			'from pathlib import Path',
			'',
			'class Loader:',
			'    def __init__(self, root):',
			'        self.root = Path(root)',
			'    def load(self):',
			'        return os.listdir(self.root)',
		].join('\n')).id, 'python');
		assert.strictEqual(guessPastedLanguage('package main\n\nimport "fmt"\n\nfunc main() {\n\tx := 1\n\tfmt.Println(x)\n}').id, 'go');
		assert.strictEqual(guessPastedLanguage('use std::io;\n\npub fn read() -> Result<String, io::Error> {\n    let mut s = String::new();\n    Ok(s)\n}').id, 'rust');
		assert.strictEqual(guessPastedLanguage('SELECT id, name FROM users WHERE id = 1;\nINSERT INTO logs (a) VALUES (1);\nUPDATE users SET name = \'x\' WHERE id = 2;').id, 'sql');
		assert.strictEqual(guessPastedLanguage('#!/bin/bash\nset -e\necho hi').id, 'shellscript');
	});

	test('markdown and yaml', () => {
		assert.strictEqual(guessPastedLanguage('# Title\n\nSome text.\n\n## Part\n\n- [ ] todo\n- [x] done\n\nSee [docs](https://x.dev).').id, 'markdown');
		assert.strictEqual(guessPastedLanguage('name: build\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4').id, 'yaml');
		// An OpenAPI document's `type: string` lines are YAML, not TypeScript.
		assert.strictEqual(guessPastedLanguage(repeat(i => i % 2 ? `  field${i}:` : `    type: string`, 30)).id, 'yaml');
	});

	test('prose stays plain text', () => {
		const prose = repeat(i => `This is sentence number ${i} of a long email about the quarterly planning meeting.`, 40);
		assert.strictEqual(guessPastedLanguage(prose).id, 'plaintext');
		assert.strictEqual(guessPastedLanguage('').id, 'plaintext');
		assert.strictEqual(pastedFileName(guessPastedLanguage(prose)), 'pasted-text.txt');
	});
});
