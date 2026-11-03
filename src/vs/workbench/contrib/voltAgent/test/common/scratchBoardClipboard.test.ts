/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseScratchClipboard, serializeScratchClipboard } from '../../common/scratchBoard/scratchClipboard.js';
import { createFrame, createLinear, createShape, duplicateElements } from '../../common/scratchBoard/scratchFactory.js';
import { IScratchLinearElement, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';

suite('Scratch board clipboard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function board(): ScratchElement[] {
		const frame = createFrame({ id: 'frame', x: 0, y: 0, width: 400, height: 300, name: 'Flow' });
		const a = createShape({ id: 'a', x: 20, y: 20, width: 80, height: 60, shape: 'rectangle', groupIds: ['g1'], frameId: 'frame' });
		const b = createShape({ id: 'b', x: 200, y: 20, width: 80, height: 60, shape: 'ellipse', groupIds: ['g1'], frameId: 'frame' });
		const outside = createShape({ id: 'outside', x: 600, y: 20, width: 80, height: 60, shape: 'diamond' });
		const ab = createLinear({ id: 'ab', type: 'arrow', x: 100, y: 50, points: [[0, 0], [100, 0]], startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: [0, 0.5] }, frameId: 'frame' });
		const toOutside = createLinear({ id: 'bo', type: 'arrow', x: 280, y: 50, points: [[0, 0], [320, 0]], startBinding: { elementId: 'b', anchor: null }, endBinding: { elementId: 'outside', anchor: null }, frameId: 'frame' });
		return [frame, a, b, outside, ab, toOutside];
	}

	test('a copy round-trips through clipboard JSON', () => {
		const elements = board();
		const parsed = parseScratchClipboard(serializeScratchClipboard(elements));
		assert.deepStrictEqual(parsed?.map(el => el.id), elements.map(el => el.id));
		assert.deepStrictEqual((parsed?.[4] as IScratchLinearElement).endBinding, { elementId: 'b', anchor: [0, 0.5] });
	});

	test('text that is not ours is not elements', () => {
		assert.strictEqual(parseScratchClipboard(undefined), undefined);
		assert.strictEqual(parseScratchClipboard('hello'), undefined);
		assert.strictEqual(parseScratchClipboard('{not json'), undefined);
		assert.strictEqual(parseScratchClipboard(JSON.stringify({ type: 'excalidraw/clipboard', elements: board() })), undefined);
		assert.strictEqual(parseScratchClipboard(JSON.stringify({ type: 'volt-scratch/clipboard', elements: [{ nope: true }] })), undefined);
	});

	test('a paste gets fresh ids and keeps bindings, groups and frames inside the copied set', () => {
		const copied = parseScratchClipboard(serializeScratchClipboard(board().filter(el => el.id !== 'outside')))!;
		const { elements: pasted, idMap } = duplicateElements(copied, [16, 24]);
		const byOld = (id: string) => pasted.find(el => el.id === idMap.get(id))!;

		const oldIds = new Set(copied.map(el => el.id));
		assert.ok(pasted.every(el => !oldIds.has(el.id)), 'every pasted element has a new id');
		assert.strictEqual(new Set(pasted.map(el => el.id)).size, pasted.length);

		// Positions move by the offset.
		assert.deepStrictEqual([byOld('a').x, byOld('a').y], [36, 44]);

		// A connector between two copied shapes joins the copies.
		const ab = byOld('ab') as IScratchLinearElement;
		assert.deepStrictEqual(ab.startBinding, { elementId: idMap.get('a'), anchor: null });
		assert.deepStrictEqual(ab.endBinding, { elementId: idMap.get('b'), anchor: [0, 0.5] });

		// One to a shape that was not copied lets go of that end.
		const bo = byOld('bo') as IScratchLinearElement;
		assert.deepStrictEqual(bo.startBinding, { elementId: idMap.get('b'), anchor: null });
		assert.strictEqual(bo.endBinding, null);

		// The copies form a new group of their own, inside the copied frame.
		const group = byOld('a').groupIds;
		assert.strictEqual(group.length, 1);
		assert.notStrictEqual(group[0], 'g1');
		assert.deepStrictEqual(byOld('b').groupIds, group);
		assert.strictEqual(byOld('a').frameId, idMap.get('frame'));
		assert.strictEqual(byOld('bo').frameId, idMap.get('frame'));
	});

	test('pasting twice makes two independent copies', () => {
		const copied = board();
		const first = duplicateElements(copied).elements;
		const second = duplicateElements(copied).elements;
		const ids = new Set(first.map(el => el.id));
		assert.ok(second.every(el => !ids.has(el.id)));
		assert.notDeepStrictEqual(first[1].groupIds, second[1].groupIds);
	});
});
