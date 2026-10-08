/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAxItem, diffAx, formatAxLine, placeOnImage, readingOrder, strokeBoxes, visibleInViewport } from '../../../common/tools/axAnnotations.js';

function item(ref: string, box: [number, number, number, number], extra: Partial<IAxItem> = {}): IAxItem {
	return { ref, role: 'button', name: ref, box, ...extra };
}

suite('Accessibility annotations for screenshots', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('places CSS boxes on a retina-scaled, cropped image', () => {
		const placed = placeOnImage([item('e1', [100, 50, 40, 20])], { origin: { x: 0, y: 0 }, scale: 0.5, width: 1280, height: 800 });
		assert.deepStrictEqual(placed[0].box, [50, 25, 20, 10]);

		const cropped = placeOnImage([item('e2', [100, 50, 40, 20])], { origin: { x: 90, y: 40 }, scale: 2, width: 400, height: 200 });
		assert.deepStrictEqual(cropped[0].box, [20, 20, 80, 40]);
	});

	test('clips partly visible boxes and drops boxes that miss the image', () => {
		const placed = placeOnImage([
			item('left', [-20, 10, 50, 20]),
			item('below', [10, 900, 50, 20]),
			item('none', [0, 0, 0, 0]),
		], { origin: { x: 0, y: 0 }, scale: 1, width: 800, height: 600 });
		assert.deepStrictEqual(placed.map(p => [p.ref, p.box]), [['left', [0, 10, 30, 20]]]);
	});

	test('keeps only viewport-visible items and sorts them in reading order', () => {
		const items = [
			item('c', [300, 200, 10, 10]),
			item('b', [20, 100, 10, 10]),
			item('a', [10, 100, 10, 10]),
			item('off', [10, 900, 10, 10]),
		];
		assert.deepStrictEqual(visibleInViewport(items, { width: 800, height: 600 }).map(i => i.ref), ['c', 'b', 'a']);
		assert.deepStrictEqual(readingOrder(items.slice(0, 3)).map(i => i.ref), ['a', 'b', 'c']);
	});

	test('formats a line with the ref, role, name, value, states and box', () => {
		assert.strictEqual(
			formatAxLine(item('e12', [120, 340, 180, 36], { name: 'Publish now', states: ['disabled'] })),
			'- e12 button "Publish now" [disabled] box=[120, 340, 180, 36]',
		);
		assert.strictEqual(
			formatAxLine({ ref: 'e3', role: 'textbox', name: 'Title', value: 'Hi', box: [1, 2, 3, 4] }),
			'- e3 textbox "Title" value="Hi" box=[1, 2, 3, 4]',
		);
	});

	test('diffs two listings of one document by ref and ignores positions', () => {
		const before = [item('e1', [0, 0, 10, 10], { name: 'Save' }), item('e2', [0, 20, 10, 10], { name: 'Cancel' }), item('e3', [0, 40, 10, 10], { name: 'Old' })];
		const after = [
			item('e1', [0, 0, 10, 10], { name: 'Save' }),
			item('e2', [0, 300, 10, 10], { name: 'Cancel' }),
			item('e3', [0, 40, 10, 10], { name: 'Saved', states: ['disabled'] }),
			item('e4', [0, 80, 10, 10], { name: 'Toast' }),
		];
		const diff = diffAx(before, after);
		assert.deepStrictEqual(diff.added.map(i => i.ref), ['e4']);
		assert.deepStrictEqual(diff.changed.map(i => i.ref), ['e3']);
		assert.deepStrictEqual(diff.removed, []);
		assert.strictEqual(diff.unchanged, 2);
	});

	test('reports removed elements in diffs', () => {
		const diff = diffAx([item('e1', [0, 0, 1, 1])], []);
		assert.deepStrictEqual(diff.removed.map(i => i.ref), ['e1']);
	});

	test('strokes box outlines on a copy and clamps boxes at the edge', () => {
		const image = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
		const out = strokeBoxes(image, [[1, 1, 2, 2], [3, 3, 5, 5]], 1);
		const at = (x: number, y: number) => Array.from(out.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 3));
		assert.deepStrictEqual(at(1, 1), [255, 59, 48]);
		assert.deepStrictEqual(at(2, 2), [255, 59, 48]);
		assert.deepStrictEqual(at(3, 3), [255, 59, 48]);
		assert.deepStrictEqual(at(0, 0), [0, 0, 0]);
		assert.strictEqual(image.data[(1 * 4 + 1) * 4], 0, 'the source image is not modified');
	});
});
