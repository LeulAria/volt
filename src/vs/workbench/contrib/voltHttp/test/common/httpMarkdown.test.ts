/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { HttpMdBlock, HttpMdInline, httpMarkdownFromAnswer, httpMarkdownPlainText, looksLikeHttpMarkdown, parseHttpMarkdown, parseHttpMarkdownInline, serializeHttpMarkdown } from '../../common/httpMarkdown.js';

const roundTrip = (markdown: string) => serializeHttpMarkdown(parseHttpMarkdown(markdown));

/** What Postman writes for a request: headings, a parameter table, a body example, notes. */
const POSTMAN_DOC = [
	'# Create user',
	'',
	'Creates a **new user** in the workspace. Returns the *created* user with its `id`.',
	'',
	'## Query parameters',
	'',
	'| Name | Type | Description |',
	'| --- | --- | --- |',
	'| `notify` | boolean | Sends the welcome email when `true` |',
	'| `role` | string | One of `admin`, `member` |',
	'',
	'## Body',
	'',
	'```json',
	'{',
	'  "name": "Ada",',
	'',
	'  "email": "ada@example.com"',
	'}',
	'```',
	'',
	'## Errors',
	'',
	'- `400` the body is not valid',
	'- `409` the email is taken',
	'  - retry with another email',
	'  - or [sign in](https://example.com/login "Log in")',
	'',
	'1. Call the endpoint',
	'2. Read the `Location` header',
	'',
	'> Rate limited to 10 calls a minute.',
	'',
	'---',
	'',
	'![diagram](https://example.com/flow.png)',
].join('\n');

suite('Volt HTTP client: Markdown', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a Postman description survives unchanged', () => {
		assert.strictEqual(roundTrip(POSTMAN_DOC), POSTMAN_DOC);
	});

	test('blocks are read as the model the editor draws', () => {
		const blocks = parseHttpMarkdown(POSTMAN_DOC);
		assert.deepStrictEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading', 'table', 'heading', 'code', 'heading', 'list', 'list', 'quote', 'rule', 'paragraph']);
		const code = blocks[5];
		assert.ok(code.type === 'code');
		assert.strictEqual(code.language, 'json');
		assert.strictEqual(code.text, '{\n  "name": "Ada",\n\n  "email": "ada@example.com"\n}');
		const table = blocks[3];
		assert.ok(table.type === 'table');
		assert.strictEqual(table.header.length, 3);
		assert.strictEqual(table.rows.length, 2);
		assert.deepStrictEqual(table.rows[0][0], [{ type: 'code', text: 'notify' }]);
		const list = blocks[7];
		assert.ok(list.type === 'list' && !list.ordered);
		assert.strictEqual(list.items.length, 2);
		const nested = list.items[1].children[1];
		assert.ok(nested.type === 'list');
		assert.strictEqual(nested.items.length, 2);
		const ordered = blocks[8];
		assert.ok(ordered.type === 'list' && ordered.ordered);
	});

	test('inline marks: bold, italic, strikethrough, code, links, images, breaks', () => {
		assert.deepStrictEqual(parseHttpMarkdownInline('a **b *c*** ~~d~~ `e` [f](http://g "h") ![i](j.png)'), [
			{ type: 'text', text: 'a ' },
			{ type: 'strong', children: [{ type: 'text', text: 'b ' }, { type: 'em', children: [{ type: 'text', text: 'c' }] }] },
			{ type: 'text', text: ' ' },
			{ type: 'strike', children: [{ type: 'text', text: 'd' }] },
			{ type: 'text', text: ' ' },
			{ type: 'code', text: 'e' },
			{ type: 'text', text: ' ' },
			{ type: 'link', href: 'http://g', title: 'h', children: [{ type: 'text', text: 'f' }] },
			{ type: 'text', text: ' ' },
			{ type: 'image', src: 'j.png', alt: 'i' },
		] satisfies HttpMdInline[]);
		assert.deepStrictEqual(parseHttpMarkdownInline('one  \ntwo\\\nthree\nfour'), [
			{ type: 'text', text: 'one' },
			{ type: 'break' },
			{ type: 'text', text: 'two' },
			{ type: 'break' },
			{ type: 'text', text: 'three\nfour' },
		] satisfies HttpMdInline[]);
		assert.strictEqual(httpMarkdownPlainText(parseHttpMarkdownInline('**a** _b_ `c`')), 'a b c');
	});

	test('underscore emphasis is read and written with stars; words with underscores stay', () => {
		assert.strictEqual(roundTrip('__bold__ and _italic_ and snake_case_name and 2 * 3 * 4'), '**bold** and *italic* and snake_case_name and 2 * 3 * 4');
	});

	test('what Postman and other editors write is normalized once, then stable', () => {
		const sources = [
			'Title\n=====\n\nSub\n---\n\ntext',
			'* one\n* two\n\n   * deep\n+ other',
			'1) first\n2) second\n\n    indented code\n\ntail',
			'- [ ] todo\n- [x] done\n- plain',
			'- a\n\n- b\n\n  more of b\n\n- c',
			'> quote\ncontinued\n>\n> - item\n> - item\n\nafter',
			'a | b\n:-- | --:\n1 | 2\n3 \\| 4 | `x|y`',
			'text\n| a |\n| - |\n| 1 |',
			'~~~\ncode with ``` inside\n~~~',
			'````md\n```js\nx\n```\n````',
			'line one  \nline two\\\nline three',
			'<https://example.com> and [a](<b c> \'t\') and ![x](y)',
			'***both*** and **a*b*** and *a**b*** and **a***b*',
			'# Heading with `code` and a trailing hash #',
			'#\n\n-\n\n1.',
			'Escapes: \\*not em\\* \\# \\[x\\](y) \\`tick\\` a\\\\b C:\\path 5 \\> 3',
			'7. seven\n8. eight\n   1. nested\n   2. nested',
			'- ```js\n  const a = 1;\n  ```\n- > quoted\n- # heading',
			'<div align="center">raw html</div>\n\n&amp; &lt;tag&gt; AT&T',
			'Hello!\n\n[link](x)![img](y)',
			'\ttabbed code\n\n-\titem',
			'',
			'   \n\n  ',
		];
		for (const source of sources) {
			const once = roundTrip(source);
			assert.strictEqual(roundTrip(once), once, `not stable: ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
			assert.deepStrictEqual(parseHttpMarkdown(roundTrip(once)), parseHttpMarkdown(once), `model drifts: ${JSON.stringify(source)}`);
		}
	});

	test('the canonical form of the common cases', () => {
		assert.strictEqual(roundTrip('Title\n=====\n\nSub\n---'), '# Title\n\n## Sub');
		assert.strictEqual(roundTrip('* one\n* two'), '- one\n- two');
		assert.strictEqual(roundTrip('- [ ] todo\n- [x] done'), '- [ ] todo\n- [x] done');
		assert.strictEqual(roundTrip('a | b\n:-- | --:\n1 | 2'), '| a | b |\n| :-- | --: |\n| 1 | 2 |');
		assert.strictEqual(roundTrip('line one  \nline two'), 'line one\\\nline two');
		assert.strictEqual(roundTrip('    indented'), '```\nindented\n```');
		assert.strictEqual(roundTrip('3. c\n4. d'), '3. c\n4. d');
		assert.strictEqual(roundTrip('a\r\n\r\nb'), 'a\n\nb');
		assert.strictEqual(roundTrip('- a\n\n  para\n- b'), '- a\n\n  para\n\n- b');
	});

	test('text that looks like Markdown is escaped, and reads back as the same text', () => {
		const texts = ['# not a heading', '- not a list', '1. not a list', '> not a quote', '*stars* and _unders_', 'a `tick` b', '[x](y)', '![x](y)', '~~no~~', '---', 'a\\*b', '<http://x.y>', '+ plus', 'ends with #', '2 * 3', 'a_b_c', '__init__', '```', '5) five', 'back\\slash\\'];
		for (const text of texts) {
			const model: HttpMdBlock[] = [{ type: 'paragraph', children: [{ type: 'text', text }] }];
			const written = serializeHttpMarkdown(model);
			assert.deepStrictEqual(parseHttpMarkdown(written), model, `${JSON.stringify(text)} written as ${JSON.stringify(written)}`);
		}
		for (const text of ['ends with #', '#', 'a ##', 'C#']) {
			const model: HttpMdBlock[] = [{ type: 'heading', level: 2, children: [{ type: 'text', text }] }];
			assert.deepStrictEqual(parseHttpMarkdown(serializeHttpMarkdown(model)), model, text);
		}
		assert.deepStrictEqual(parseHttpMarkdown(serializeHttpMarkdown([{ type: 'paragraph', children: [{ type: 'text', text: 'first\n- second\n# third\n===' }] }])), [{ type: 'paragraph', children: [{ type: 'text', text: 'first\n- second\n# third\n===' }] }]);
	});

	test('the shapes a contenteditable leaves are written as valid Markdown', () => {
		// <b>a </b><b>b</b>, a bold inside a bold, white space and a break at a mark's edge, an empty mark.
		const model: HttpMdBlock[] = [{
			type: 'paragraph',
			children: [
				{ type: 'text', text: 'x' },
				{ type: 'strong', children: [{ type: 'text', text: ' a ' }] },
				{ type: 'strong', children: [{ type: 'strong', children: [{ type: 'text', text: 'b' }] }, { type: 'break' }] },
				{ type: 'em', children: [{ type: 'text', text: '  ' }] },
				{ type: 'em', children: [{ type: 'text', text: 'c' }] },
				{ type: 'em', children: [{ type: 'text', text: 'd\xa0' }] },
				{ type: 'text', text: 'e' },
				{ type: 'break' },
			],
		}];
		const written = serializeHttpMarkdown(model);
		assert.strictEqual(written, 'x **a** **b**\\\n*cd* e');
		assert.strictEqual(roundTrip(written), written);
		assert.strictEqual(serializeHttpMarkdown([
			{ type: 'list', ordered: false, items: [{ children: [{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }] }] },
			{ type: 'list', ordered: false, items: [{ children: [] }, { checked: true, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'b' }] }] }] },
			{ type: 'list', ordered: true, start: 4, items: [{ children: [{ type: 'paragraph', children: [{ type: 'text', text: 'c' }] }, { type: 'code', language: 'sh', text: 'ls' }] }] },
			{ type: 'paragraph', children: [] },
			{ type: 'quote', children: [] },
		]), '- a\n-\n- [x] b\n\n4. c\n\n   ```sh\n   ls\n   ```');
	});

	test('table cells keep pipes, breaks and marks', () => {
		const model: HttpMdBlock[] = [{
			type: 'table',
			align: [undefined, 'center'],
			header: [[{ type: 'text', text: 'a|b' }], [{ type: 'strong', children: [{ type: 'text', text: 'c' }] }]],
			rows: [[[{ type: 'code', text: 'x|y' }, { type: 'break' }, { type: 'text', text: 'z' }], []]],
		}];
		const written = serializeHttpMarkdown(model);
		assert.strictEqual(written, '| a\\|b | **c** |\n| --- | :-: |\n| `x\\|y`<br>z |  |');
		assert.deepStrictEqual(parseHttpMarkdown(written), model);
	});

	test('a model answer loses the fence around the whole of it, not its own code blocks', () => {
		assert.strictEqual(httpMarkdownFromAnswer('```markdown\n# A\n\ntext\n```'), '# A\n\ntext');
		assert.strictEqual(httpMarkdownFromAnswer('```\n# A\n```\n'), '# A');
		assert.strictEqual(httpMarkdownFromAnswer('```json\n{}\n```\n\ntext\n\n```json\n[]\n```'), '```json\n{}\n```\n\ntext\n\n```json\n[]\n```');
		assert.strictEqual(httpMarkdownFromAnswer('```markdown\n# A\n\n```json\n{}\n```\n```'), '# A\n\n```json\n{}\n```');
		assert.strictEqual(httpMarkdownFromAnswer('```markdown\n# Partial'), '# Partial');
	});

	test('pasted text is read as Markdown only when it has marks', () => {
		assert.strictEqual(looksLikeHttpMarkdown('just a sentence, with (parens) and a_b'), false);
		assert.strictEqual(looksLikeHttpMarkdown('# Title\ntext'), true);
		assert.strictEqual(looksLikeHttpMarkdown('some **bold** words'), true);
		assert.strictEqual(looksLikeHttpMarkdown('| a | b |\n| - | - |'), true);
	});
});
