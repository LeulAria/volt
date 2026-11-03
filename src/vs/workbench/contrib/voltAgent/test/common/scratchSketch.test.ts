/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseElement } from '../../common/scratchBoard/scratchDocument.js';
import { sketchIconNames, sketchToElements } from '../../common/scratchBoard/scratchSketch.js';
import { IScratchDrawElement, IScratchLinearElement, IScratchNoteElement, IScratchShapeElement, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';

function draw(value: unknown, icons: readonly string[] = []): { elements: ScratchElement[]; warnings: string[] } {
	const result = sketchToElements(value, { icon: name => icons.includes(name) ? { iconId: name, svg: '<svg/>', tintable: true } : undefined });
	assert.ok(!('error' in result), 'error' in result ? result.error : '');
	return result;
}

suite('Scratch sketches', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('draws shapes in the styles asked for', () => {
		const { elements } = draw([
			{ type: 'cloud', x: 10, y: 20, width: 200, height: 120, text: 'Ideas', fill: 'yellow', fillStyle: 'hachure', roughness: 2, angle: 90, stroke: 'orange' },
			{ type: 'circle', x: 0, y: 0, size: 40 },
		]);
		const cloud = elements[0] as IScratchShapeElement;
		assert.strictEqual(cloud.shape, 'cloud');
		assert.strictEqual(cloud.fill, '#ffec99');
		assert.strictEqual(cloud.fillStyle, 'hachure');
		assert.strictEqual(cloud.roughness, 2);
		assert.ok(Math.abs(cloud.angle - Math.PI / 2) < 1e-9);
		assert.ok(cloud.label?.html.includes('Ideas'));
		const circle = elements[1] as IScratchShapeElement;
		assert.deepStrictEqual([circle.shape, circle.width, circle.height], ['ellipse', 40, 40]);
	});

	test('arrows tie to shapes by id and keep a bend asked for', () => {
		const { elements, warnings } = draw([
			{ type: 'rectangle', id: 'a', x: 0, y: 0, width: 100, height: 60 },
			{ type: 'ellipse', id: 'b', x: 300, y: 200, width: 100, height: 60 },
			{ type: 'arrow', from: 'a', to: 'b', points: [[0, 0], [200, 30], [0, 0]], text: 'sends', arrowType: 'round' },
			{ type: 'arrow', from: 'a', to: 'nowhere' },
		]);
		const arrow = elements[2] as IScratchLinearElement;
		assert.strictEqual(arrow.startBinding?.elementId, elements[0].id);
		assert.strictEqual(arrow.endBinding?.elementId, elements[1].id);
		assert.deepStrictEqual([arrow.x, arrow.y], [50, 30], 'starts at the first shape\'s centre');
		assert.strictEqual(arrow.points.length, 3);
		assert.deepStrictEqual(arrow.points[2], [300, 200], 'ends at the second shape\'s centre');
		assert.ok(warnings.some(w => w.includes('"nowhere"')));
	});

	test('freehand, highlighter, notes, text and icons', () => {
		const { elements, warnings } = draw([
			{ type: 'freehand', points: [[0, 0], [10, 5], [20, 0]] },
			{ type: 'highlighter', points: [[0, 50], [120, 50]] },
			{ type: 'note', x: 0, y: 100, text: 'remember', fill: 'pink' },
			{ type: 'text', x: 0, y: 300, text: 'Title\nsub', fontSize: 'huge' },
			{ type: 'icon', x: 0, y: 400, icon: 'lucide:rocket' },
			{ type: 'icon', x: 0, y: 500, icon: 'lucide:missing' },
			{ type: 'teapot', x: 0, y: 0 },
		], ['lucide:rocket']);
		assert.deepStrictEqual(elements.map(el => el.type), ['draw', 'draw', 'note', 'text', 'icon']);
		assert.strictEqual((elements[1] as IScratchDrawElement).pen, 'highlighter');
		assert.strictEqual((elements[2] as IScratchNoteElement).fill, '#fcc2d7');
		assert.strictEqual(elements[3].height, Math.ceil(2 * 36 * 1.25));
		assert.ok(warnings.some(w => w.includes('lucide:missing')));
		assert.ok(warnings.some(w => w.includes('teapot')));
		for (const el of elements) {
			assert.ok(parseElement(JSON.parse(JSON.stringify(el))), `${el.type} survives a save`);
		}
	});

	test('groups move together, and nothing drawable is an error', () => {
		const { elements } = draw([
			{ type: 'rectangle', group: 'g' },
			{ type: 'text', text: 'in it', group: 'g' },
			{ type: 'rectangle' },
		]);
		assert.deepStrictEqual(elements[0].groupIds, elements[1].groupIds);
		assert.strictEqual(elements[0].groupIds.length, 1);
		assert.deepStrictEqual(elements[2].groupIds, []);
		assert.ok('error' in sketchToElements([{ type: 'teapot' }]));
		assert.ok('error' in sketchToElements('nope'));
		assert.deepStrictEqual(sketchIconNames([{ type: 'icon', icon: 'lucide:a' }, { type: 'text', icon: 'x' }]), ['lucide:a']);
	});
});
