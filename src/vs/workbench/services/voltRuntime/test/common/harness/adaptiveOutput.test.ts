/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { presentOutput } from '../../../common/harness/adaptiveOutput.js';

suite('Adaptive output presentation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('tables the live ranking screenshot with no blank line before the list', () => {
		const views = presentOutput([
			'I\'ll look up current population figures so the ranking is based on latest data, then list the 10 most populated countries.',
			'',
			'The 10 most populated countries, based on 2026 Worldometer estimates (from UN World Population Prospects):',
			'1. India — 1,476,625,576',
			'2. China — 1,412,914,089',
			'3. United States — 349,035,494',
			'4. Indonesia — 287,886,782',
			'5. Pakistan — 259,299,791',
			'6. Nigeria — 242,431,832',
			'7. Brazil — 213,562,666',
			'8. Bangladesh — 177,818,044',
			'9. Russia — 143,394,458',
			'10. Ethiopia — 138,902,185',
			'',
			'These are mid-year estimates, not census counts, so figures can differ slightly by source.',
		].join('\n'));
		const table = views.find(view => view.kind === 'table');
		assert.ok(table && table.kind === 'table');
		if (table?.kind === 'table') {
			assert.deepStrictEqual([...table.headers], ['Rank', 'Country', 'Population']);
			assert.strictEqual(table.rows.length, 10);
			assert.deepStrictEqual([...table.rows[9]], ['10', 'Ethiopia', '138,902,185']);
		}
	});

	test('tables rankings that use hyphens or en dashes', () => {
		const hyphen = presentOutput('Top countries:\n1. India - 1,476,625,576\n2. China - 1,412,914,089\n3. United States - 349,035,494');
		assert.ok(hyphen.some(view => view.kind === 'table'));
		const en = presentOutput('Top countries:\n1. India – 1,476,625,576\n2. China – 1,412,914,089\n3. United States – 349,035,494');
		assert.ok(en.some(view => view.kind === 'table'));
	});

	test('turns a comparable ranking list into a table', () => {
		const views = presentOutput([
			'The 10 most populated countries (2026 estimates from Worldometer, based on UN data):',
			'',
			'1. India — 1,476,625,576',
			'2. China — 1,412,914,089',
			'3. United States — 349,035,494',
			'4. Indonesia — 287,886,782',
			'5. Pakistan — 259,299,791',
			'6. Nigeria — 242,431,832',
			'7. Brazil — 213,562,666',
			'8. Bangladesh — 177,818,044',
			'9. Russia — 143,394,458',
			'10. Ethiopia — 138,902,185',
			'',
			'These are estimates, not census counts, so figures differ by source.',
		].join('\n'));

		assert.deepStrictEqual(views.map(view => view.kind), ['text', 'table', 'text']);
		const table = views[1];
		assert.strictEqual(table.kind, 'table');
		if (table.kind !== 'table') {
			return;
		}
		assert.deepStrictEqual([...table.headers], ['Rank', 'Country', 'Population']);
		assert.strictEqual(table.rows.length, 10);
		assert.deepStrictEqual([...table.rows[0]], ['1', 'India', '1,476,625,576']);
		assert.deepStrictEqual([...table.rows[2]], ['3', 'United States', '349,035,494']);
		assert.ok(views[0].kind === 'text' && /most populated countries/.test(views[0].markdown));
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

	test('does not table a numbered plan or narrative steps', () => {
		const views = presentOutput('1. Open `src/app.ts` and read the handler.\n2. Add the missing import.\n3. Run the tests.');
		assert.ok(views.every(view => view.kind !== 'table'));
	});

	test('leaves a short non-comparable list as a list', () => {
		const views = presentOutput('1. Patrol\n2. Kicks\n3. X-Trail');
		assert.strictEqual(views.length, 1);
		assert.strictEqual(views[0].kind, 'list');
		if (views[0].kind === 'list') {
			assert.strictEqual(views[0].ordered, true);
			assert.deepStrictEqual([...views[0].items], ['Patrol', 'Kicks', 'X-Trail']);
		}
	});

	test('tables prices and specs with a consistent delimiter', () => {
		const views = presentOutput('UAE starting prices:\n\n- Patrol: AED 215,900\n- Kicks: AED 89,900\n- X-Trail: AED 129,900');
		const table = views.find(view => view.kind === 'table');
		assert.ok(table && table.kind === 'table');
		if (table?.kind === 'table') {
			assert.ok(table.headers.includes('Price'));
			assert.strictEqual(table.rows.length, 3);
			assert.ok(table.rows[0].includes('AED 215,900'));
		}
	});

	test('uses a table property when the model emits structured output', () => {
		const views = presentOutput(JSON.stringify({
			kind: 'table',
			headers: ['Rank', 'Country', 'Population'],
			rows: [['1', 'India', '1476625576'], ['2', 'China', '1412914089']],
		}));
		assert.strictEqual(views[0].kind, 'table');
		if (views[0].kind === 'table') {
			assert.deepStrictEqual([...views[0].headers], ['Rank', 'Country', 'Population']);
		}
	});

	test('tables a JSON array of comparable objects', () => {
		const views = presentOutput(JSON.stringify([
			{ country: 'India', population: 1476625576 },
			{ country: 'China', population: 1412914089 },
		]));
		assert.strictEqual(views[0].kind, 'table');
		if (views[0].kind === 'table') {
			assert.deepStrictEqual([...views[0].headers], ['Country', 'Population']);
			assert.strictEqual(views[0].rows[0][0], 'India');
		}
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

	test('turns heading groups into cards', () => {
		const views = presentOutput([
			'## Patrol',
			'Nissan\'s flagship SUV, built for desert and family trips alike.',
			'',
			'## Kicks',
			'A compact crossover with a lower starting price in the UAE.',
		].join('\n'));
		assert.strictEqual(views[0].kind, 'cards');
		if (views[0].kind === 'cards') {
			assert.strictEqual(views[0].items.length, 2);
			assert.strictEqual(views[0].items[0].title, 'Patrol');
		}
	});

	test('tables a language ranking whose notes are prose', () => {
		const views = presentOutput([
			'I\'ll look up current 2026 language rankings rather than guessing from older lists.',
			'There is no single 2026 ranking. Python, JavaScript, TypeScript, Java, C, C++, and C# sit at the top.',
			'A practical consensus for 2026:',
			'1. Python — #1 on TIOBE (Sep 2026) and PYPL; the default for AI, data, and backend',
			'2. JavaScript — #1 among professional developers (Stack Overflow 2025) and #1 on RedMonk (Jan 2026)',
			'3. TypeScript — #1 on GitHub by contributors (Octoverse 2025)',
			'4. Java — still a top-3/4 enterprise language',
			'5. C / C++ — systems, performance, and embedded',
			'6. C# — cloud, desktop, and games',
			'7. SQL — still used by most professional developers',
			'8. PHP — still huge on the web (RedMonk #4)',
			'9. Go — common in cloud/infrastructure',
			'10. Rust — fastest riser into TIOBE\'s top 10',
		].join('\n'));
		const table = views.find(view => view.kind === 'table');
		assert.ok(table && table.kind === 'table');
		if (table?.kind === 'table') {
			assert.deepStrictEqual([...table.headers], ['Rank', 'Language', 'Notes']);
			assert.strictEqual(table.rows.length, 10);
			assert.deepStrictEqual([...table.rows[0]], ['1', 'Python', '#1 on TIOBE (Sep 2026) and PYPL; the default for AI, data, and backend']);
			assert.deepStrictEqual([...table.rows[4]], ['5', 'C / C++', 'systems, performance, and embedded']);
			assert.deepStrictEqual([...table.rows[8]], ['9', 'Go', 'common in cloud/infrastructure']);
		}
		assert.ok(views[0].kind === 'text' && /practical consensus/.test(views[0].markdown));
	});

	test('tables index rundowns written as parallel sentences', () => {
		const views = presentOutput([
			'How the major indexes currently line up:',
			'',
			'TIOBE, September 2026 (search-engine popularity): Python, C, C++, Java, C#, JavaScript, Visual Basic, SQL, R, Rust.',
			'',
			'RedMonk, January 2026 (GitHub PRs + Stack Overflow): JavaScript, Python, Java, PHP/C# (tie), TypeScript, CSS/C++ (tie), Ruby, C.',
			'',
			'GitHub Octoverse 2025 (contributors): TypeScript, Python, JavaScript, Java, C#.',
			'',
			'Stack Overflow 2025 (professional use): JavaScript 68.9%, HTML/CSS 63.1%, SQL 61.4%, Python 54.9%, TypeScript',
			'48.8%.',
		].join('\n'));
		assert.deepStrictEqual(views.map(view => view.kind), ['text', 'table']);
		const table = views[1];
		assert.strictEqual(table.kind, 'table');
		if (table.kind !== 'table') {
			return;
		}
		assert.deepStrictEqual([...table.headers], ['Index', 'Measure', 'Ranking']);
		assert.strictEqual(table.rows.length, 4);
		assert.deepStrictEqual([...table.rows[0]], ['TIOBE, September 2026', 'search-engine popularity', 'Python, C, C++, Java, C#, JavaScript, Visual Basic, SQL, R, Rust']);
		assert.deepStrictEqual([...table.rows[2]], ['GitHub Octoverse 2025', 'contributors', 'TypeScript, Python, JavaScript, Java, C#']);
		assert.deepStrictEqual([...table.rows[3]], ['Stack Overflow 2025', 'professional use', 'JavaScript 68.9%, HTML/CSS 63.1%, SQL 61.4%, Python 54.9%, TypeScript 48.8%']);
	});

	test('keeps both tables when a ranking answer mixes a list and an index rundown', () => {
		const views = presentOutput([
			'A practical consensus for 2026 languages:',
			'1. Python — default for AI and data',
			'2. JavaScript — language of the web',
			'3. Rust — systems and tooling',
			'',
			'How the major indexes currently line up:',
			'TIOBE, September 2026 (search-engine popularity): Python, C, Java.',
			'RedMonk, January 2026 (GitHub PRs): JavaScript, Python, Java.',
			'GitHub Octoverse 2025 (contributors): TypeScript, Python, JavaScript.',
		].join('\n'));
		assert.deepStrictEqual(views.map(view => view.kind), ['text', 'table', 'text', 'table']);
	});

	test('does not table numbered steps that use a dash', () => {
		const views = presentOutput('1. Open the file — then read the handler.\n2. Add the import — the build needs it.\n3. Run the tests — they cover the change.');
		assert.ok(views.every(view => view.kind !== 'table'));
	});

	test('leaves a two-item description list as a list', () => {
		const views = presentOutput('1. Patrol — desert SUV\n2. Kicks — city crossover');
		assert.ok(views.every(view => view.kind !== 'table'));
		assert.strictEqual(views[0].kind, 'list');
	});

	test('leaves ordinary parenthetical sentences as text', () => {
		const views = presentOutput([
			'Use the API (2024): it returns the name, the id, and the status.',
			'',
			'Call it from the client (2025): pass the token, the id, and the flag.',
			'',
			'Read the result (2026): check the name, the id, and the error.',
		].join('\n'));
		assert.ok(views.every(view => view.kind !== 'table'));
	});

	test('uses a chart fence for share breakdowns', () => {
		const views = presentOutput('```chart\nlabel, value\nDogs, 40\nCats, 35\nBirds, 25\n```');
		assert.strictEqual(views[0].kind, 'chart');
		if (views[0].kind === 'chart') {
			assert.deepStrictEqual([...views[0].labels], ['Dogs', 'Cats', 'Birds']);
			assert.deepStrictEqual([...views[0].values], [40, 35, 25]);
		}
	});
});
