/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPredictionContext } from '../../common/prediction.js';
import { locateAnchor } from '../../common/prediction/anchorEdits.js';
import { cursorIdentifiers, extractExcerpt, extractImports, relevantSnippet, truncateSnippet } from '../../common/prediction/contextWindow.js';
import { lineDelta, meetsConfidence, orderEdits, samePath, shiftRangeAfterAccept } from '../../common/prediction/editGraph.js';
import { IParsedEdit, parseMultiEdit } from '../../common/prediction/multiEditParser.js';
import { dedupeLineEcho, dedupePrefixOverlap, fitToLineSuffix, inlineEditForLine, isProseCompletion, postProcessInline, stripFences, stripSpecialTokens, trimSuffixOverlap, trimToBlock } from '../../common/prediction/postProcess.js';
import { PredictionCache, predictionCacheKey, TypedThroughCache } from '../../common/prediction/predictionCache.js';
import { fromClipboard, fromHarvestedPattern, fromNearbyLine, predictLocal } from '../../common/prediction/localPredictor.js';
import { buildInlinePrompt, buildNextEditPrompt, CURSOR_MARKER } from '../../common/prediction/predictionPrompt.js';

suite('Volt prediction: context window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('excerpt around an offset snaps to line boundaries', () => {
		const text = 'line1\nline2\nline3\nline4\nline5';
		const offset = text.indexOf('line3') + 2; // inside "line3"
		const { prefix, suffix } = extractExcerpt(text, offset, { before: 8, after: 8 });
		// 8 chars back reaches into "line2", snapped forward to the start of that break.
		assert.ok(prefix.endsWith('li'));
		assert.ok(!prefix.startsWith('ne2'), `prefix must start on a line boundary, got ${JSON.stringify(prefix)}`);
		assert.ok(suffix.startsWith('ne3'));
		assert.ok(!suffix.includes('line5'));
	});

	test('full file fits inside the budget untouched', () => {
		const text = 'const a = 1;\nconst b = 2;';
		const { prefix, suffix } = extractExcerpt(text, 12);
		assert.strictEqual(prefix + suffix, text);
	});

	test('imports are collected across languages', () => {
		const ts = `import { a } from './a.js';\nconst x = require('x');\nconst y = 1;`;
		assert.strictEqual(extractImports(ts).split('\n').length, 2);
		const py = `from os import path\nimport sys\nx = 1`;
		assert.strictEqual(extractImports(py).split('\n').length, 2);
	});

	test('related files contribute only the lines that mention names near the cursor', () => {
		const text = 'a\nb\nfunction getUser() {}\nc\nd\ne\nf\nconst z = getUser();\ng';
		assert.strictEqual(relevantSnippet(text, ['getUser']), 'b\nfunction getUser() {}\nc\n...\nf\nconst z = getUser();\ng');
		assert.strictEqual(relevantSnippet(text, ['missing']), '');
		assert.strictEqual(relevantSnippet(text, []), '');
		assert.deepStrictEqual(cursorIdentifiers('import x\nconst user = load();\n', 'return user.na'), ['user', 'load']);
	});

	test('snippet truncation marks the cut', () => {
		assert.strictEqual(truncateSnippet('abc', 10), 'abc');
		assert.ok(truncateSnippet('a'.repeat(500), 10).endsWith('...'));
	});
});

suite('Volt prediction: post-process', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips markdown fences', () => {
		assert.strictEqual(stripFences('```ts\nconst a = 1;\n```'), 'const a = 1;');
		assert.strictEqual(stripFences('const a = 1;'), 'const a = 1;');
	});

	test('dedupes prompt-tail echo', () => {
		assert.strictEqual(dedupePrefixOverlap('const user = getUser(id);', 'const user = '), 'getUser(id);');
		assert.strictEqual(dedupePrefixOverlap('getUser(id);', 'const user = '), 'getUser(id);');
	});

	test('multiline completion collapses to one line when code follows the cursor', () => {
		assert.strictEqual(fitToLineSuffix('id) + 1;\nmore()', ') + 1;'), 'id');
		assert.strictEqual(fitToLineSuffix('id);\nmore()', ''), 'id);\nmore()');
		assert.strictEqual(fitToLineSuffix('a)', ') * 2'), 'a', 'a closer the suffix already has');
		// Only closers after the cursor: the body is kept, the echoed closers go.
		assert.strictEqual(fitToLineSuffix('\n  doIt();\n})', '})'), '\n  doIt();\n');
	});

	test('strips FIM and end-of-text tokens', () => {
		assert.strictEqual(stripSpecialTokens('foo()<|endoftext|>bar'), 'foo()');
		assert.strictEqual(stripSpecialTokens('<|fim_middle|>x + 1'), 'x + 1');
	});

	test('drops an echo of the lines above the cursor', () => {
		assert.strictEqual(dedupeLineEcho('function f() {\n  return 42;', 'function f() {\n  return ', '  return '), '42;');
	});

	test('stops at the end of the block', () => {
		assert.strictEqual(trimToBlock('\n    return x * 2\n\ndef g():\n    pass', 'def f(x):'), '\n    return x * 2\n', 'the next Python def');
		assert.strictEqual(trimToBlock('doA();\n  }\n\nfunction next() {}', '    '), 'doA();\n  }', 'keeps the closing brace');
	});

	test('drops a closing brace the document already has, but not a balanced block\'s own', () => {
		assert.strictEqual(trimSuffixOverlap('return 1;\n}', '\n}\n', ''), 'return 1;');
		assert.strictEqual(trimSuffixOverlap('if (x) {\n    y();\n  }', '\n}\n', ''), 'if (x) {\n    y();\n  }');
	});

	test('full pipeline on a fenced block body', () => {
		assert.strictEqual(postProcessInline({
			raw: '```ts\n  return a + b;\n}\n```',
			linePrefix: '  ',
			lineSuffix: '',
			prefix: 'function add(a, b) {\n  ',
			suffix: '\n}\n',
		}), 'return a + b;');
	});

	test('fits completions around the closers after the cursor', () => {
		assert.deepStrictEqual(inlineEditForLine('a, b', 'foo(', ')'), { insertText: 'a, b', replacesLineSuffix: false });
		assert.deepStrictEqual(inlineEditForLine('a, b);', 'foo(', ')'), { insertText: 'a, b);', replacesLineSuffix: true }, 'closes the call itself');
		assert.deepStrictEqual(inlineEditForLine('x > 0) {\n  y();\n}', 'if (', ')'), { insertText: 'x > 0) {\n  y();\n}', replacesLineSuffix: true });
		assert.deepStrictEqual(inlineEditForLine('\n  return 1;', 'function f() {', '}'), { insertText: '\n  return 1;\n}', replacesLineSuffix: true }, 'a body inside the braces');
		assert.deepStrictEqual(inlineEditForLine('hello', 'print("', '")'), { insertText: 'hello', replacesLineSuffix: false }, 'inside a string');
		assert.deepStrictEqual(inlineEditForLine('x', 'a = ', ''), { insertText: 'x', replacesLineSuffix: false });
	});

	test('full pipeline returns undefined for empty results', () => {
		assert.strictEqual(postProcessInline({ raw: '```\n\n```', linePrefix: '', lineSuffix: '' }), undefined);
		assert.strictEqual(postProcessInline({ raw: CURSOR_MARKER, linePrefix: 'x', lineSuffix: '' }), undefined);
	});

	test('full pipeline survives a realistic chat answer', () => {
		const raw = '```ts\nconst user = await getUser(id);\n```';
		assert.strictEqual(
			postProcessInline({ raw, linePrefix: 'const user = ', lineSuffix: '' }),
			'await getUser(id);');
	});

	test('rejects English ghost text from an agent', () => {
		assert.ok(isProseCompletion("There is no meaningful value for 'amend' in this CLI bootstrap"));
		assert.strictEqual(postProcessInline({
			raw: "There is no meaningful value for 'amend' in this CLI bootstrap",
			linePrefix: 'const amend = ',
			lineSuffix: '',
		}), undefined);
	});

	test('keeps a real expression', () => {
		assert.ok(!isProseCompletion('process.env.VSCODE_CWD;'));
		assert.strictEqual(postProcessInline({
			raw: 'false;',
			linePrefix: 'const amend = ',
			lineSuffix: '',
		}), 'false;');
	});
});

suite('Volt prediction: multi-edit parser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a valid envelope', () => {
		const parsed = parseMultiEdit(JSON.stringify({
			confidence: 0.8,
			edits: [
				{ path: 'src/a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, replacement: 'foo', reason: 'rename' },
				{ path: 'src/b.ts', startLine: 3, startColumn: 2, endLine: 4, endColumn: 1, replacement: 'bar' },
			],
		}));
		assert.strictEqual(parsed?.confidence, 0.8);
		assert.strictEqual(parsed?.edits.length, 2);
		assert.strictEqual(parsed?.edits[0].reason, 'rename');
	});

	test('extracts JSON wrapped in prose or fences', () => {
		const parsed = parseMultiEdit('Here you go:\n```json\n{"confidence":0.6,"edits":[]}\n```\nDone!');
		assert.strictEqual(parsed?.confidence, 0.6);
	});

	test('text-anchored edits: the same anchor once, and never a no-op', () => {
		const parsed = parseMultiEdit(JSON.stringify({
			confidence: 0.9,
			edits: [
				{ path: 'a.ts', find: 'x', replace: 'y' },
				{ path: 'a.ts', find: 'x', replace: 'z' },
				{ path: 'a.ts', find: 'same', replace: 'same' },
			],
		}));
		assert.strictEqual(parsed?.edits.length, 1);
		assert.strictEqual(parsed?.edits[0].find, 'x');
		assert.strictEqual(parsed?.edits[0].replacement, 'y');
	});

	test('anchors resolve nearest the cursor, and despite different indentation', () => {
		const text = 'a\nfoo(1)\nb\nfoo(1)\nc\nd\n';
		assert.deepStrictEqual(locateAnchor(text, 'foo(1)', 'foo(2)', text.indexOf('b')), { start: 2, end: 8, replacement: 'foo(2)' }, 'one character away beats two');
		assert.deepStrictEqual(locateAnchor(text, 'foo(1)', 'foo(2)', text.indexOf('d')), { start: 11, end: 17, replacement: 'foo(2)' });
		const block = 'if (x) {\n    call();\n}';
		assert.deepStrictEqual(locateAnchor(block, '      call();', '      call(1);', 0), { start: 9, end: 20, replacement: '    call(1);' });
		assert.strictEqual(locateAnchor(block, 'missing();', 'x', 0), undefined);
	});

	test('rejects garbage entirely', () => {
		assert.strictEqual(parseMultiEdit('I cannot help with that.'), undefined);
		assert.strictEqual(parseMultiEdit('{"edits": "nope"}'), undefined);
	});

	test('drops malformed, traversal, and overlapping edits but keeps the rest', () => {
		const parsed = parseMultiEdit(JSON.stringify({
			confidence: 1,
			edits: [
				{ path: 'a.ts', startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, replacement: 'x' },
				{ path: 'a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 9, replacement: 'overlap' },
				{ path: '../../etc/passwd', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, replacement: 'evil' },
				{ path: 'b.ts', startLine: 0, startColumn: 1, endLine: 1, endColumn: 1, replacement: 'zero-based' },
				{ path: 'b.ts', startLine: 2, startColumn: 1, endLine: 1, endColumn: 1, replacement: 'inverted' },
			],
		}));
		assert.strictEqual(parsed?.edits.length, 1);
		assert.strictEqual(parsed?.edits[0].path, 'a.ts');
	});

	test('clamps confidence into 0..1 and defaults to 0.5', () => {
		assert.strictEqual(parseMultiEdit('{"confidence": 7, "edits": []}')?.confidence, 1);
		assert.strictEqual(parseMultiEdit('{"edits": []}')?.confidence, 0.5);
	});
});

suite('Volt prediction: edit graph', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const edit = (path: string, line: number, replacement = 'x'): IParsedEdit =>
		({ path, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 2, replacement });

	test('current file first, top to bottom, then other files grouped', () => {
		const { local, remote } = orderEdits([
			edit('src/b.ts', 9),
			edit('src/a.ts', 20),
			edit('src/a.ts', 3),
			edit('src/b.ts', 1),
			edit('src/c.ts', 5),
		], '/work/src/a.ts');
		assert.deepStrictEqual(local.map(e => e.startLineNumber), [3, 20]);
		// b.ts edits stay grouped and sorted before c.ts
		assert.deepStrictEqual(remote.map(e => `${e.path}:${e.startLineNumber}`), ['src/b.ts:1', 'src/b.ts:9', 'src/c.ts:5']);
	});

	test('suffix path matching tolerates absolute vs relative echoes', () => {
		assert.ok(samePath('/Users/x/work/src/a.ts', 'src/a.ts'));
		assert.ok(samePath('src\\a.ts', './src/a.ts'));
		assert.ok(!samePath('src/a.ts', 'src/b.ts'));
	});

	test('confidence gate', () => {
		assert.ok(meetsConfidence(0.3));
		assert.ok(!meetsConfidence(0.1));
	});

	test('line delta and queued-range shifting after accept', () => {
		const accepted = { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 6, endColumn: 1 }, replacement: 'a\nb\nc\nd' };
		assert.strictEqual(lineDelta(accepted), 2); // 3 inserted newlines - 1 removed line
		const below = { startLineNumber: 10, startColumn: 2, endLineNumber: 11, endColumn: 3 };
		assert.deepStrictEqual(shiftRangeAfterAccept(below, accepted), { startLineNumber: 12, startColumn: 2, endLineNumber: 13, endColumn: 3 });
		const above = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 };
		assert.deepStrictEqual(shiftRangeAfterAccept(above, accepted), above);
	});
});

suite('Volt prediction: cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lru evicts the oldest entry', () => {
		const cache = new PredictionCache<string>(2);
		cache.set('a', '1');
		cache.set('b', '2');
		cache.get('a'); // refresh a
		cache.set('c', '3'); // evicts b
		assert.strictEqual(cache.get('a'), '1');
		assert.strictEqual(cache.get('b'), undefined);
		assert.strictEqual(cache.get('c'), '3');
	});

	test('typing into a suggestion is answered from the cache', () => {
		const cache = new TypedThroughCache();
		cache.remember('u', 'const x = ', '\n', 'foo(bar);');
		assert.strictEqual(cache.lookup('u', 'const x = fo', '\n'), 'o(bar);');
		assert.strictEqual(cache.lookup('u', 'const x = zz', '\n'), undefined, 'typed something else');
		assert.strictEqual(cache.lookup('u', 'const x = foo(bar);', '\n'), undefined, 'nothing left');
		assert.strictEqual(cache.lookup('u', 'const x = fo', ';\n'), undefined, 'the text after the cursor changed');
		assert.strictEqual(cache.lookup('other', 'const x = fo', '\n'), undefined);
	});

	test('key changes with cursor-local text only', () => {
		const base = predictionCacheKey('m', 'file:///a.ts', 'prefix', 'suffix');
		assert.strictEqual(predictionCacheKey('m', 'file:///a.ts', 'prefix', 'suffix'), base);
		assert.notStrictEqual(predictionCacheKey('m', 'file:///a.ts', 'prefixX', 'suffix'), base);
		assert.notStrictEqual(predictionCacheKey('other', 'file:///a.ts', 'prefix', 'suffix'), base);
		// An edit far above the window (outside the last 256 chars) does not thrash the key.
		const far = 'x'.repeat(600) + 'z'.repeat(256);
		const farChanged = 'y'.repeat(600) + 'z'.repeat(256);
		assert.strictEqual(
			predictionCacheKey('m', 'file:///a.ts', far, 'suffix'),
			predictionCacheKey('m', 'file:///a.ts', farChanged, 'suffix'));
	});
});

suite('Volt prediction: prompts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function ctx(overrides: Partial<IPredictionContext> = {}): IPredictionContext {
		return {
			uri: URI.file('/work/src/a.ts'),
			languageId: 'typescript',
			prefix: 'const user = ',
			suffix: ';\n',
			linePrefix: 'const user = ',
			lineSuffix: ';',
			imports: `import { getUser } from './api.js';`,
			diagnostics: ['3:7 Error Cannot find name "user"'],
			recentEdits: [{ uri: URI.file('/work/src/api.ts'), startLineNumber: 12, removed: '', inserted: 'export function getUser', timestamp: 1 }],
			siblings: [{ path: '/work/src/api.ts', excerpt: 'export function getUser() {}' }],
			modelVersionId: 1,
			...overrides,
		};
	}

	test('inline prompt carries the cursor marker and all context blocks', () => {
		const [system, user] = buildInlinePrompt(ctx({ clipboard: 'copiedIdentifier' }));
		assert.strictEqual(system.role, 'system');
		assert.ok(user.content.includes(CURSOR_MARKER));
		assert.ok(user.content.includes('Recent edits'));
		assert.ok(user.content.includes('Diagnostics'));
		assert.ok(user.content.includes('Imports'));
		assert.ok(user.content.includes('Related open file'));
		assert.ok(user.content.includes('Clipboard'));
		assert.ok(user.content.includes('copiedIdentifier'));
	});

	test('next-edit prompt demands the JSON contract, and intent lands verbatim', () => {
		const [system, user] = buildNextEditPrompt(ctx(), 'rename getUser to fetchUser');
		assert.ok(system.content.includes('"edits"'));
		assert.ok(user.content.includes('rename getUser to fetchUser'));
	});

	test('oversized blocks are dropped rather than blowing the budget', () => {
		const big = ctx({ siblings: [{ path: 'big.ts', excerpt: 'x'.repeat(50_000) }] });
		const [, user] = buildInlinePrompt(big);
		assert.ok(user.content.length < 20_000);
		assert.ok(user.content.includes(CURSOR_MARKER), 'the excerpt itself must never be dropped');
	});
});

suite('Volt prediction: local predictor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('clipboard continues a typed prefix', () => {
		assert.strictEqual(
			fromClipboard('const ', `const CWD = process.env['VSCODE_CWD'];`),
			`CWD = process.env['VSCODE_CWD'];`);
		assert.strictEqual(
			fromClipboard('const ', `CWD = process.env['VSCODE_CWD'];`),
			` CWD = process.env['VSCODE_CWD'];`);
	});

	test('clipboard on an empty line becomes the whole suggestion', () => {
		assert.strictEqual(fromClipboard('', 'foo()'), 'foo()');
		assert.strictEqual(fromClipboard('  ', 'https://example.com'), undefined);
	});

	test('nearby line completion matches the Cursor VSCODE_CWD case', () => {
		const prefix = `delete process.env['VSCODE_CWD'];\n`;
		assert.strictEqual(
			fromNearbyLine('const {', `const { join } = require('path');\n${prefix}`),
			` join } = require('path');`);
	});

	test('harvests process.env into a const assignment', () => {
		const prefix = `// keep cwd\ndelete process.env['VSCODE_CWD'];\n`;
		assert.strictEqual(fromHarvestedPattern('const', prefix), ` CWD = process.env['VSCODE_CWD'];`);
		assert.strictEqual(fromHarvestedPattern('', prefix), `const CWD = process.env['VSCODE_CWD'];`);
	});

	test('predictLocal prefers clipboard over harvest', () => {
		const result = predictLocal({
			uri: URI.file('/work/src/bootstrap-cli.ts'),
			languageId: 'typescript',
			prefix: `delete process.env['VSCODE_CWD'];\n`,
			suffix: '',
			linePrefix: 'const',
			lineSuffix: '',
			imports: '',
			diagnostics: [],
			recentEdits: [],
			siblings: [],
			clipboard: `const console.log('process.env', process.env);`,
			modelVersionId: 1,
		});
		assert.strictEqual(result, ` console.log('process.env', process.env);`);
	});
});
