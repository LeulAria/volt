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
import { dedupeLineEcho, dedupePrefixOverlap, fitToLineSuffix, inlineEditForLine, isProseCompletion, postProcessInline, repliedLineBreakOnly, stripFences, stripSpecialTokens, trimSuffixOverlap, trimToBlock } from '../../common/prediction/postProcess.js';
import { PredictionCache, predictionCacheKey, TypedThroughCache } from '../../common/prediction/predictionCache.js';
import { fromClipboard, fromHarvestedPattern, fromNearbyLine, predictLocal } from '../../common/prediction/localPredictor.js';
import { buildInlinePrompt, buildNextEditPrompt, CURSOR_MARKER, inlineWritingKind } from '../../common/prediction/predictionPrompt.js';
import { cleanComposerCompletion, ComposerLanguageModel } from '../../common/prediction/composerPredictor.js';

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

	test('rejects a note about the answer', () => {
		assert.ok(isProseCompletion('(Nothing to insert: the file is plain text and the line is complete.)'));
		assert.ok(isProseCompletion('[No completion]'));
		assert.ok(!isProseCompletion('[None] * size'));
		assert.ok(isProseCompletion('Three\n(Nothing to insert: the file is plain text with no code context to continue.)'));
	});

	test('drops system reminders an agent CLI leaks into the reply', () => {
		assert.strictEqual(postProcessInline({
			raw: '<system-reminder>(Nothing to insert: the file is plain text with no code context to continue.)</system-reminder>',
			linePrefix: 'some ',
			lineSuffix: '',
		}), undefined);
		assert.strictEqual(postProcessInline({
			raw: 'false;<system-reminder>Do not mention this.</system-reminder>',
			linePrefix: 'const amend = ',
			lineSuffix: '',
		}), 'false;');
	});

	test('keeps a real expression', () => {
		assert.ok(!isProseCompletion('process.env.VSCODE_CWD;'));
		assert.strictEqual(postProcessInline({
			raw: 'false;',
			linePrefix: 'const amend = ',
			lineSuffix: '',
		}), 'false;');
	});

	test('a tagged reply keeps the space an agent CLI would have trimmed', () => {
		assert.strictEqual(postProcessInline({ raw: '<insert> a + b;</insert>', linePrefix: '\treturn', lineSuffix: '' }), ' a + b;');
		assert.strictEqual(postProcessInline({ raw: '<insert> a + b;', linePrefix: '\treturn', lineSuffix: '' }), ' a + b;', 'a reply cut off before the closing tag');
	});

	test('whatever is outside the insert tags is not code', () => {
		assert.strictEqual(postProcessInline({ raw: 'Here you go: <insert>items.length;</insert> Hope it helps', linePrefix: 'const total = ', lineSuffix: '' }), 'items.length;');
	});

	test('an empty insert is no suggestion', () => {
		assert.strictEqual(postProcessInline({ raw: '<insert></insert>', linePrefix: 'const total = ', lineSuffix: '' }), undefined);
	});

	test('a tool call written as text is dropped, tagged or not', () => {
		assert.strictEqual(postProcessInline({ raw: '<parameter name="items"></parameter>', linePrefix: 'const total =', lineSuffix: '' }), undefined);
		assert.strictEqual(postProcessInline({ raw: '<insert><invoke name="x"></invoke></insert>', linePrefix: 'const total =', lineSuffix: '' }), undefined);
	});
});

suite('Volt prediction: writing (Markdown, text, comments)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function writing(raw: string, linePrefix: string, prefix = linePrefix, kind: 'prose' | 'comment' = 'prose', suffix = '') {
		return postProcessInline({ raw, linePrefix, lineSuffix: '', prefix, suffix, writing: kind });
	}

	test('tells writing from code', () => {
		assert.strictEqual(inlineWritingKind('markdown', 'one'), 'prose');
		assert.strictEqual(inlineWritingKind('plaintext', ''), 'prose');
		assert.strictEqual(inlineWritingKind('git-commit', 'fix(tab): '), 'prose');
		assert.strictEqual(inlineWritingKind('typescript', '\t// Returns '), 'comment');
		assert.strictEqual(inlineWritingKind('typescript', 'const x = 1; // the '), 'comment');
		assert.strictEqual(inlineWritingKind('typescript', ' * Returns the '), 'comment');
		assert.strictEqual(inlineWritingKind('typescript', 'const url = "https://'), 'code');
		assert.strictEqual(inlineWritingKind('typescript', 'return users.'), 'code');
		assert.strictEqual(inlineWritingKind('python', '    # average of '), 'comment');
		assert.strictEqual(inlineWritingKind('python', `    s = '#' + `), 'code');
		assert.strictEqual(inlineWritingKind('cpp', '#include <'), 'code');
		assert.strictEqual(inlineWritingKind('sql', 'select 1 -- the '), 'comment');
	});

	test('a Markdown file gets the writing prompt, code keeps the code prompt', () => {
		const md: IPredictionContext = {
			uri: URI.file('/work/new.md'), languageId: 'markdown', prefix: 'one\ntwo\nThree\n', suffix: '', linePrefix: '', lineSuffix: '',
			imports: '', diagnostics: [], recentEdits: [], siblings: [], modelVersionId: 1,
		};
		const [system, user] = buildInlinePrompt(md);
		assert.ok(system.content.includes('<insert>'));
		assert.ok(!/source code/i.test(system.content));
		assert.ok(user.content.includes(`one\ntwo\nThree\n${CURSOR_MARKER}`));
		const [codeSystem] = buildInlinePrompt({ ...md, uri: URI.file('/work/a.ts'), languageId: 'typescript', prefix: 'const a = ', linePrefix: 'const a = ' });
		assert.ok(/source code/i.test(codeSystem.content));
	});

	test('keeps the next list item and sentence continuations', () => {
		assert.strictEqual(writing('<insert>four</insert>', '', 'one\ntwo\nThree\n'), 'four');
		assert.strictEqual(writing('<insert>ee</insert>', 'Thr', 'one\ntwo\nThr'), 'ee');
		assert.strictEqual(writing('lets you edit code with an AI that reads your whole project.', 'Volt is an AI code editor that '), 'lets you edit code with an AI that reads your whole project.');
		// A finished line may get the next one; mid-sentence a line break is a stray.
		assert.strictEqual(writing('<insert>\nFour</insert>', 'Three', 'one\ntwo\nThree'), '\nFour');
		assert.strictEqual(writing('\nfast', 'Volt is '), 'fast');
	});

	test('only the text inside the tags is used', () => {
		assert.strictEqual(writing('Sure.\n<insert>day, after the review.</insert>\nThat finishes the sentence.', 'We ship on Fri'), 'day, after the review.');
		assert.strictEqual(writing('<insert></insert>', 'some '), undefined);
		assert.strictEqual(writing('<insert>\n</insert>', 'Three'), undefined);
	});

	test('notes, refusals and reminders are never inserted', () => {
		assert.strictEqual(writing('(Nothing to insert: the file is plain text with no code context to continue.)', 'some '), undefined);
		assert.strictEqual(writing('<system-reminder>(Nothing to insert: the file is plain text with no code context to continue.)</system-reminder>', 'some '), undefined);
		assert.strictEqual(writing('<insert>(Nothing to insert: the line is complete.)</insert>', 'Three'), undefined);
		assert.strictEqual(writing(`I'm not going to continue that text, since the completion task sits inside a system setup that's asking me to act as an autocomplete tool.`, 'some '), undefined);
	});

	test('an echo of the line or of its bullet is dropped', () => {
		assert.strictEqual(writing(' Three', 'Three', 'one\ntwo\nThree'), undefined);
		assert.strictEqual(writing('<insert>Three</insert>', 'Three', 'one\ntwo\nThree'), undefined);
		assert.strictEqual(writing('- Small memory footprint', '- ', '- Fast startup\n- '), 'Small memory footprint');
		assert.strictEqual(writing('to thank everyone.', 'I wanted to '), 'thank everyone.');
		assert.strictEqual(writing(' AI-powered code editor that helps you write code faster.', 'Volt is an AI code editor that'), ' helps you write code faster.');
	});

	test('one sentence, one line, and Markdown stays Markdown', () => {
		assert.strictEqual(writing('take a moment to thank you. Your patience made a difference.', 'I wanted to '), 'take a moment to thank you.');
		assert.strictEqual(writing('Download it:\n\n```sh\nnpm i\n```', '', '## Install\n\n'), 'Download it:');
		assert.strictEqual(writing('<insert>Run `make start` to launch it.</insert>', '', '## Install\n\n'), 'Run `make start` to launch it.');
		assert.strictEqual(writing('<insert>Four\nFive\nSix</insert>', '', 'one\ntwo\nThree\n'), 'Four');
		assert.strictEqual(writing('<insert>\n\nfour</insert>', 'Three', 'one\ntwo\nThree'), '\nfour');
		assert.strictEqual(writing('<insert>\n\nNext paragraph.</insert>', 'End of the first.', 'Intro.\n\nEnd of the first.'), '\n\nNext paragraph.');
		assert.strictEqual(writing('<insert>```sh\nnpm i\n```</insert>', '', '## Install\n\n'), '```sh\nnpm i\n```');
		assert.strictEqual(writing('<insert>```sh\nnpm i</insert>', '', '## Install\n\n'), undefined);
		assert.strictEqual(writing('sentence that continues the line in the document.', 'some '), undefined);
		assert.strictEqual(writing(` ' ' + 'the' ... `, 'Volt is an AI code editor that'), undefined);
		assert.strictEqual(writing(' (and its tests) are fast.', 'The build'), ' (and its tests) are fast.');
		assert.strictEqual(writing('Tab autocomplete that predicts your next edit', '- '), 'Tab autocomplete that predicts your next edit');
	});

	test('a reply of only a line break is told apart', () => {
		assert.ok(repliedLineBreakOnly('<insert>\n</insert>'));
		assert.ok(repliedLineBreakOnly('<insert>\n<br>\n</insert>'));
		assert.ok(!repliedLineBreakOnly('<insert>\nFive</insert>'));
		assert.ok(!repliedLineBreakOnly('<insert></insert>'));
		assert.strictEqual(writing('<insert>\n<br>\nFour</insert>', 'Three', 'one\ntwo\nThree'), '\nFour');
	});

	test('a comment continues on its own line only', () => {
		assert.strictEqual(writing('the value clamped between min and max\n\treturn x;', '\t// Returns ', '\t// Returns ', 'comment'), 'the value clamped between min and max');
	});
});

suite('Volt prediction: composer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('finishes the unfinished word, restated or not', () => {
		assert.strictEqual(cleanComposerCompletion('g in the login handler', 'can you fix the bu'), 'g in the login handler');
		assert.strictEqual(cleanComposerCompletion('bug in the login handler', 'can you fix the bu'), 'g in the login handler');
	});

	test('a new word after a whole word gets its space', () => {
		assert.strictEqual(cleanComposerCompletion('the changes', 'great, now commit'), ' the changes');
		assert.strictEqual(cleanComposerCompletion('commit the clamp helper', 'great, now commit'), ' the clamp helper');
		assert.strictEqual(cleanComposerCompletion(' it', 'great, now commit'), ' it');
	});

	test('after a space the last word is not said again', () => {
		assert.strictEqual(cleanComposerCompletion('for', 'now add a test for '), undefined);
		assert.strictEqual(cleanComposerCompletion('for clamp in src/math.ts', 'now add a test for '), 'clamp in src/math.ts');
		assert.strictEqual(cleanComposerCompletion('clamp in src/math.ts', 'now add a test for '), 'clamp in src/math.ts');
	});

	test('drops a quote the draft never opened', () => {
		assert.strictEqual(cleanComposerCompletion('bug" the login click listener', 'can you fix the bu'), 'g the login click listener');
	});

	test('a name from the chat beats another word', () => {
		assert.strictEqual(cleanComposerCompletion('nent.ts so the chips wrap', 'also update agentCompo', ['agentComposerChips.ts']), undefined);
		assert.strictEqual(cleanComposerCompletion('serChips.ts too', 'also update agentCompo', ['agentComposerChips.ts']), 'serChips.ts too');
	});

	test('an HTML line break ends the line', () => {
		assert.strictEqual(cleanComposerCompletion('st<br>', 'please add a regression te'), 'st');
	});

	test('the local guess follows the user\'s casing over a shouted word', () => {
		const model = new ComposerLanguageModel({ prompts: ['TAB TEST WINDOW, the login button does nothing'], vocabulary: [] });
		assert.strictEqual(model.completeWord('add a regression te'), 'st');
		assert.strictEqual(model.completeWord('add a regression TE'), 'ST');
	});

	test('replies about the task are dropped', () => {
		assert.strictEqual(cleanComposerCompletion('Sure, here is the continuation', 'fix the '), undefined);
	});

	test('a tagged reply keeps the space that starts a new word', () => {
		assert.strictEqual(cleanComposerCompletion('<insert> system works</insert>', 'Can you explain how the'), ' system works');
		assert.strictEqual(cleanComposerCompletion('<insert> system works', 'Can you explain how the'), ' system works', 'cut off before the closing tag');
	});

	test('a tagged reply that finishes the word has no space', () => {
		assert.strictEqual(cleanComposerCompletion('<insert>g in the login handler</insert>', 'can you fix the bu'), 'g in the login handler');
	});

	test('a tagged reply after a space starts with the word', () => {
		assert.strictEqual(cleanComposerCompletion('<insert> why the build fails</insert>', 'can you check '), 'why the build fails');
	});

	test('an empty or text-only tagged reply is nothing, and a tool call is dropped', () => {
		assert.strictEqual(cleanComposerCompletion('<insert></insert>', 'fix the '), undefined);
		assert.strictEqual(cleanComposerCompletion('<insert>Sure, here is the continuation</insert>', 'fix the '), undefined);
		assert.strictEqual(cleanComposerCompletion('<parameter name="x"></parameter>', 'fix the '), undefined);
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

	test('the code prompt asks for the insert tags, so a leading space survives', () => {
		const [system, user] = buildInlinePrompt(ctx(), 'code');
		assert.ok(system.content.includes('<insert>') && system.content.includes('</insert>'));
		assert.ok(user.content.includes('<insert>'));
	});

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
