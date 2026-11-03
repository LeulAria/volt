/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseElement } from '../../common/scratchBoard/scratchDocument.js';
import { geometricBounds } from '../../common/scratchBoard/scratchGeometry.js';
import { htmlToPlainText } from '../../common/scratchBoard/scratchHtml.js';
import { boundsIntersect } from '../../common/scratchBoard/scratchMath.js';
import { bestCells, cellNumber, IPageSpec, PAGE_BEST_COLOR, pageToElements, parsePageSpec } from '../../common/scratchBoard/scratchPage.js';
import { IScratchTextElement } from '../../common/scratchBoard/scratchTypes.js';

/** The user's reference: three models compared on a hand-lettered slide. */
const COMPARISON = {
	heading: 'how it compares: Opus 5.5 & GPT-6.1 Sol',
	table: {
		columns: [{ label: 'Kimi K3.1 Pro', color: 'indigo' }, 'Opus 5.5', 'GPT-6.1 Sol'],
		rows: [
			{ label: 'intelligence index (AA)', cells: [55, 58, 52], best: 'high' },
			{ label: 'API price (in / out, per 1M)', cells: [{ text: '$2 / $10', best: true }, '$4 / $20', { text: '$2 / $10', best: true }] },
			{ label: 'cost per task (AA)', cells: ['$2.11', '$5.98', '$0.72'], best: 'low' },
			{ label: 'GDPval: real office work (Elo)', cells: ['1,846', '1,866', '1,596'], best: 'high' },
			{ label: 'hallucination rate (lower = better)', cells: ['43.9%', '58.6%', '54.3%'], best: 'low' },
			['open weights', { text: 'yes, Nov 4', best: true }, 'no', 'no'],
		],
	},
	footnote: 'AA = Artificial Analysis, independent tests (Oct 24). green = best of the three',
	bullets: ['opus 5.5 is still the smartest. kimi is 2nd, sol 3rd', 'sol is the cheapest per task. only kimi gives you the weights'],
};

function parse(value: unknown): IPageSpec {
	const parsed = parsePageSpec(value, 'Fallback');
	assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error : '');
	return parsed.spec;
}

suite('Scratch pages', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses columns, rows as objects or arrays, and cells as values or objects', () => {
		const spec = parse(COMPARISON);
		assert.strictEqual(spec.table?.columns.length, 3);
		assert.strictEqual(spec.table?.rows.length, 6);
		assert.deepStrictEqual(spec.table?.rows[5].cells.map(c => c.text), ['yes, Nov 4', 'no', 'no']);
		assert.strictEqual(spec.table?.rows[0].cells[1].text, '58');
		assert.strictEqual(spec.bullets.length, 2);
	});

	test('the heading falls back to the drawing\'s title, and an empty page is an error', () => {
		assert.strictEqual(parse({ bullets: ['one'] }).heading, 'Fallback');
		assert.ok('error' in parsePageSpec({ heading: 'Only a heading' }));
		assert.ok('error' in parsePageSpec({ table: { columns: [], rows: [] } }));
		assert.ok('error' in parsePageSpec(42));
	});

	test('reads the first number in a cell', () => {
		assert.strictEqual(cellNumber('$2 / $10'), 2);
		assert.strictEqual(cellNumber('1,846'), 1846);
		assert.strictEqual(cellNumber('67.2%'), 67.2);
		assert.strictEqual(cellNumber('no'), undefined);
	});

	test('a row that says which number wins marks its best cells; ties all win', () => {
		const spec = parse(COMPARISON);
		const rows = spec.table!.rows;
		assert.deepStrictEqual([...bestCells(rows[0])], [1]);
		assert.deepStrictEqual([...bestCells(rows[1])].sort(), [0, 2]);
		assert.deepStrictEqual([...bestCells(rows[2])], [2]);
		assert.deepStrictEqual([...bestCells(rows[4])], [0]);
		assert.deepStrictEqual([...bestCells(parse({ table: { columns: ['a', 'b'], rows: [{ label: 'x', cells: ['1', '1'], best: 'high' }] } }).table!.rows[0])], []);
	});

	test('lays the page out as board text that does not overlap and survives a save', () => {
		const elements = pageToElements(parse(COMPARISON), [0, 0]) as IScratchTextElement[];
		const texts = elements.map(el => htmlToPlainText(el.html).replace(/\s+/g, ' ').trim());
		assert.ok(texts.includes('how it compares: Opus 5.5 & GPT-6.1 Sol'));
		assert.ok(texts.includes('• sol is the cheapest per task. only kimi gives you the weights'));
		// The best values are green, the rest ink; the singled-out column keeps its colour.
		const cell = (text: string) => elements.filter((_, i) => texts[i] === text);
		assert.strictEqual(cell('$0.72')[0].stroke, PAGE_BEST_COLOR);
		assert.notStrictEqual(cell('$5.98')[0].stroke, PAGE_BEST_COLOR);
		assert.strictEqual(cell('yes, Nov 4')[0].stroke, PAGE_BEST_COLOR);
		assert.notStrictEqual(cell('Kimi K3.1 Pro')[0].stroke, cell('Opus 5.5')[0].stroke);
		// Values sit centred under their column header.
		const header = cell('Opus 5.5')[0];
		assert.strictEqual(cell('$5.98')[0].x, header.x);
		assert.strictEqual(cell('$5.98')[0].textAlign, 'center');
		for (let i = 0; i < elements.length; i++) {
			for (let j = i + 1; j < elements.length; j++) {
				// Columns sit edge to edge: only a real overlap counts.
				const a = geometricBounds(elements[i]), b = geometricBounds(elements[j]);
				assert.ok(!boundsIntersect({ minX: a.minX + 1, minY: a.minY + 1, maxX: a.maxX - 1, maxY: a.maxY - 1 }, b), `"${texts[i]}" overlaps "${texts[j]}"`);
			}
			assert.ok(parseElement(JSON.parse(JSON.stringify(elements[i]))), 'survives a save');
		}
	});
});
