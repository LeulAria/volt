/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { presentOutput } from '../../../common/harness/adaptiveOutput.js';

suite('Adaptive output presentation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const RANKING = [
		'The 10 most populated countries (2026 estimates from Worldometer, based on UN data):',
		'',
		'1. India — 1,476,625,576',
		'2. China — 1,412,914,089',
		'3. United States — 349,035,494',
		'',
		'These are estimates, not census counts, so figures differ by source.',
	].join('\n');

	test('keeps a ranking list as the model wrote it', () => {
		const views = presentOutput(RANKING);
		assert.deepStrictEqual(views.map(view => view.kind), ['text']);
		assert.ok(views[0].kind === 'text' && views[0].markdown === RANKING);
	});

	test('keeps process steps with bold labels intact, markup and all', () => {
		const text = [
			'`POST /api/install` runs these phases:',
			'',
			'- **installing**: if `dsh` isn\'t found, it runs `npm install`.',
			'- **configuring**: it adds the `dsh-cursor-acp` plugin.',
			'- **starting**: it stops anything on port 3080, then runs `dsh web`.',
			'- **ready** (or **error**): it records the Harness URL.',
		].join('\n');
		const views = presentOutput(text);
		assert.deepStrictEqual(views.map(view => view.kind), ['text']);
		assert.ok(views[0].kind === 'text' && views[0].markdown.includes('**ready** (or **error**)'));
	});

	test('keeps headings as headings', () => {
		const text = '## Patrol\nNissan\'s flagship SUV.\n\n## Kicks\nA compact crossover.';
		const views = presentOutput(text);
		assert.deepStrictEqual(views.map(view => view.kind), ['text']);
	});

	test('keeps a markdown pipe table as a table view', () => {
		const views = presentOutput('| Rank | Country | Population |\n| --- | --- | --- |\n| 1 | India | 1,476,625,576 |\n| 2 | China | 1,412,914,089 |');
		assert.strictEqual(views.length, 1);
		assert.strictEqual(views[0].kind, 'table');
		if (views[0].kind === 'table') {
			assert.deepStrictEqual([...views[0].headers], ['Rank', 'Country', 'Population']);
			assert.deepStrictEqual([...views[0].rows[0]], ['1', 'India', '1,476,625,576']);
		}
	});

	test('splits text around a table the model wrote', () => {
		const views = presentOutput('Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.');
		assert.deepStrictEqual(views.map(view => view.kind), ['text', 'table', 'text']);
	});

	test('uses a table from an output fence', () => {
		const views = presentOutput('```output\n' + JSON.stringify({
			kind: 'table',
			headers: ['Rank', 'Country', 'Population'],
			rows: [['1', 'India', '1476625576'], ['2', 'China', '1412914089']],
		}) + '\n```');
		assert.strictEqual(views[0].kind, 'table');
		if (views[0].kind === 'table') {
			assert.deepStrictEqual([...views[0].headers], ['Rank', 'Country', 'Population']);
		}
	});

	test('leaves bare JSON in prose as text and a json fence as code', () => {
		const raw = JSON.stringify([{ country: 'India', population: 1476625576 }]);
		assert.deepStrictEqual(presentOutput(raw).map(view => view.kind), ['text']);
		const fenced = presentOutput('```json\n' + raw + '\n```');
		assert.strictEqual(fenced[0].kind, 'code');
	});

	test('keeps mermaid fences as a mermaid view', () => {
		const views = presentOutput('```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```');
		assert.strictEqual(views[0].kind, 'mermaid');
		if (views[0].kind === 'mermaid') {
			assert.ok(/graph TD/.test(views[0].source));
			assert.strictEqual(views[0].closed, true);
		}
	});

	test('keeps ordinary code fences as code', () => {
		const views = presentOutput('```ts\nexport const n = 1;\n```');
		assert.strictEqual(views[0].kind, 'code');
		if (views[0].kind === 'code') {
			assert.strictEqual(views[0].language, 'ts');
			assert.ok(views[0].code.includes('export const n'));
		}
	});

	test('uses a chart fence for share breakdowns', () => {
		const views = presentOutput('```chart\nlabel, value\nDogs, 40\nCats, 35\nBirds, 25\n```');
		assert.strictEqual(views[0].kind, 'chart');
		if (views[0].kind === 'chart') {
			assert.deepStrictEqual([...views[0].labels], ['Dogs', 'Cats', 'Birds']);
			assert.deepStrictEqual([...views[0].values], [40, 35, 25]);
		}
	});
	test('Cursor code citations open a fence like any language does', () => {
		const text = 'In `src/server.js`:\n\n```30:30:src/server.js\nconst values = parse();\n```\n\nThe bug:\n\n```10:13:src/stats.js\nexport function median(values) {\n```\n\nFix:\n\n```js\nsort((a, b) => a - b);\n```';
		const code = presentOutput(text).filter(view => view.kind === 'code');
		assert.deepStrictEqual(code.map(view => view.kind === 'code' ? [view.language, view.code] : []), [
			['30:30:src/server.js', 'const values = parse();'],
			['10:13:src/stats.js', 'export function median(values) {'],
			['js', 'sort((a, b) => a - b);'],
		]);
	});
});
