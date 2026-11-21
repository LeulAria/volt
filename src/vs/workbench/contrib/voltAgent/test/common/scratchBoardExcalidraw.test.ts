/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { excalidrawImageFiles, excalidrawToScratch, readExcalidrawScene } from '../../common/scratchBoard/scratchExcalidraw.js';
import { IScratchDrawElement, IScratchFrameElement, IScratchLinearElement, IScratchShapeElement, IScratchTextElement } from '../../common/scratchBoard/scratchTypes.js';

suite('Scratch board Excalidraw paste', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const common = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, seed: 7, isDeleted: false, locked: false, link: null };

	function clipboard(elements: object[], files: object = {}): string {
		return JSON.stringify({ type: 'excalidraw/clipboard', elements, files });
	}

	test('only Excalidraw JSON is a scene', () => {
		assert.strictEqual(readExcalidrawScene(undefined), undefined);
		assert.strictEqual(readExcalidrawScene('excalidraw'), undefined);
		assert.strictEqual(readExcalidrawScene('{"type":"excalidraw/clipboard"'), undefined);
		assert.strictEqual(readExcalidrawScene(JSON.stringify({ type: 'volt-scratch/clipboard', elements: [] })), undefined);
		assert.strictEqual(readExcalidrawScene(clipboard([{ ...common, id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true }])), undefined);
		assert.ok(readExcalidrawScene(JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ ...common, id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] })));
	});

	test('shapes keep their look, and text in a shape becomes its label', () => {
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 'box', type: 'rectangle', x: 10, y: 20, width: 200, height: 80, backgroundColor: '#ffec99', fillStyle: 'cross-hatch', strokeStyle: 'dashed', roughness: 2, opacity: 60, roundness: { type: 3 }, groupIds: ['g'], boundElements: [{ id: 'label', type: 'text' }] },
			{ ...common, id: 'label', type: 'text', x: 60, y: 47, width: 100, height: 25, strokeColor: '#e03131', text: 'Hello', originalText: 'Hello', fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: 'box', groupIds: ['g'] },
			{ ...common, id: 'gem', type: 'diamond', x: 300, y: 20, width: 80, height: 80, roundness: null },
		]))!;
		const { elements } = excalidrawToScratch(scene);
		assert.deepStrictEqual(elements.map(el => el.id), ['box', 'gem']);
		const box = elements[0] as IScratchShapeElement;
		assert.deepStrictEqual(
			[box.shape, box.x, box.y, box.width, box.height, box.fill, box.fillStyle, box.strokeStyle, box.roughness, box.opacity, box.roundness, box.groupIds],
			['rectangle', 10, 20, 200, 80, '#ffec99', 'cross-hatch', 'dashed', 2, 60, 'round', ['g']],
		);
		assert.deepStrictEqual(box.label, { html: '<p>Hello</p>', fontFamily: 'hand', fontSize: 20, textAlign: 'center', verticalAlign: 'middle', color: '#e03131' });
		assert.deepStrictEqual([(elements[1] as IScratchShapeElement).shape, elements[1].roundness], ['diamond', 'sharp']);
	});

	test('free text keeps its words, font and wrapping', () => {
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 't1', type: 'text', x: 5, y: 6, width: 300, height: 50, text: 'No login or\nLogin', originalText: 'No login or\nLogin', fontSize: 28, fontFamily: 3, textAlign: 'left', autoResize: true },
			{ ...common, id: 't2', type: 'text', x: 5, y: 80, width: 120, height: 50, text: 'a long\nline', originalText: 'a long line', fontSize: 16, fontFamily: 2, textAlign: 'right', autoResize: false },
			{ ...common, id: 'blank', type: 'text', x: 0, y: 0, width: 1, height: 1, text: ' ', originalText: ' ', fontSize: 20, fontFamily: 1 },
		]))!;
		const [t1, t2] = excalidrawToScratch(scene).elements as IScratchTextElement[];
		assert.deepStrictEqual([t1.html, t1.fontFamily, t1.fontSize, t1.autoSize], ['<p>No login or</p><p>Login</p>', 'mono', 28, true]);
		assert.deepStrictEqual([t2.html, t2.fontFamily, t2.textAlign, t2.autoSize, t2.width], ['<p>a long line</p>', 'sans', 'right', false, 120]);
		assert.strictEqual(excalidrawToScratch(scene).elements.length, 2);
	});

	test('arrows keep their points, heads and the shapes they are bound to', () => {
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 'a', type: 'text', x: 0, y: 0, width: 80, height: 25, text: 'Postman', originalText: 'Postman', fontSize: 20, fontFamily: 5, containerId: null },
			{ ...common, id: 'b', type: 'ellipse', x: 300, y: 0, width: 80, height: 80 },
			{ ...common, id: 'arr', type: 'arrow', x: 90, y: 10, width: 200, height: 20, roundness: { type: 2 }, points: [[0, 0], [0, 0], [200, 20]], startArrowhead: 'circle_outline', endArrowhead: 'triangle', startBinding: { elementId: 'a', mode: 'orbit', fixedPoint: [1, 0.5001] }, endBinding: { elementId: 'b', mode: 'inside', fixedPoint: [0.4, 0.6] } },
			{ ...common, id: 'old', type: 'arrow', x: 0, y: 100, width: 10, height: 10, roundness: null, elbowed: true, points: [[0, 0], [10, 10]], startArrowhead: null, endArrowhead: 'arrow', startBinding: { elementId: 'a', focus: 0.1, gap: 4 }, endBinding: { elementId: 'not-copied', focus: 0, gap: 4 } },
			{ ...common, id: 'arrLabel', type: 'text', x: 150, y: 10, width: 40, height: 25, text: 'calls', originalText: 'calls', fontSize: 16, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: 'arr' },
		]))!;
		const els = excalidrawToScratch(scene).elements;
		const arr = els.find(el => el.id === 'arr') as IScratchLinearElement;
		assert.deepStrictEqual([arr.x, arr.y, arr.points, arr.arrowType, arr.startArrowhead, arr.endArrowhead, arr.fill], [90, 10, [[0, 0], [200, 20]], 'round', 'circle', 'triangle', 'transparent']);
		assert.deepStrictEqual(arr.startBinding, { elementId: 'a', anchor: [1, 0.5] });
		assert.deepStrictEqual(arr.endBinding, { elementId: 'b', anchor: null });
		assert.strictEqual(arr.label?.html, '<p>calls</p>');
		const old = els.find(el => el.id === 'old') as IScratchLinearElement;
		assert.deepStrictEqual([old.arrowType, old.startArrowhead, old.startBinding, old.endBinding?.elementId], ['elbow', 'none', { elementId: 'a', anchor: null }, 'not-copied']);
		assert.ok(!els.some(el => el.id === 'arrLabel'));
	});

	test('a binding to a shape\'s label text joins the shape', () => {
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
			{ ...common, id: 'lbl', type: 'text', x: 10, y: 10, width: 50, height: 25, text: 'Box', originalText: 'Box', fontSize: 20, fontFamily: 5, containerId: 'box' },
			{ ...common, id: 'arr', type: 'arrow', x: 200, y: 25, width: 90, height: 0, points: [[0, 0], [-90, 0]], endBinding: { elementId: 'lbl', focus: 0, gap: 1 } },
		]))!;
		const arr = excalidrawToScratch(scene).elements.find(el => el.id === 'arr') as IScratchLinearElement;
		assert.strictEqual(arr.endBinding?.elementId, 'box');
	});

	test('rotated lines and strokes are drawn unrotated with the turn in their points', () => {
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 'l', type: 'line', x: 0, y: 0, width: 100, height: 0, angle: Math.PI / 2, points: [[0, 0], [100, 0]] },
			{ ...common, id: 'd', type: 'freedraw', x: 10, y: 10, width: 4, height: 4, points: [[0, 0], [2, 2], [4, 4]], pressures: [0.2, 0.4, 0.9], simulatePressure: false },
			{ ...common, id: 'poly', type: 'line', x: 0, y: 0, width: 10, height: 10, backgroundColor: '#a5d8ff', points: [[0, 0], [10, 0], [10, 10], [0, 0]] },
		]))!;
		const [l, d, poly] = excalidrawToScratch(scene).elements;
		const line = l as IScratchLinearElement;
		assert.strictEqual(line.angle, 0);
		assert.deepStrictEqual([Math.round(line.x), Math.round(line.y)], [50, -50]);
		assert.deepStrictEqual(line.points.map(p => p.map(Math.round)), [[0, 0], [0, 100]]);
		assert.deepStrictEqual((d as IScratchDrawElement).points, [[0, 0, 0.2], [2, 2, 0.4], [4, 4, 0.9]]);
		assert.deepStrictEqual([(poly as IScratchLinearElement).closed, poly.fill], [true, '#a5d8ff']);
	});

	test('frames come along; images need their pixels', () => {
		const png = 'data:image/png;base64,iVBORw0KGgo=';
		const scene = readExcalidrawScene(clipboard([
			{ ...common, id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300, name: null },
			{ ...common, id: 'in', type: 'rectangle', x: 10, y: 10, width: 40, height: 40, frameId: 'f' },
			{ ...common, id: 'orphan', type: 'rectangle', x: 10, y: 10, width: 40, height: 40, frameId: 'elsewhere' },
			{ ...common, id: 'img', type: 'image', x: 0, y: 0, width: 50, height: 40, fileId: 'file1', status: 'saved' },
			{ ...common, id: 'broken', type: 'image', x: 0, y: 0, width: 50, height: 40, fileId: 'gone', status: 'error' },
		], { file1: { id: 'file1', mimeType: 'image/png', dataURL: png } }))!;
		assert.deepStrictEqual(excalidrawImageFiles(scene).map(f => f.id), ['file1']);
		const { elements, missingImages } = excalidrawToScratch(scene, new Map([['file1', { assetId: 'abc.png', mime: 'image/png', width: 500, height: 400 }]]));
		assert.strictEqual(missingImages, 1);
		assert.deepStrictEqual(elements.map(el => el.id), ['f', 'in', 'orphan', 'img']);
		assert.strictEqual((elements[0] as IScratchFrameElement).name, 'Frame');
		assert.deepStrictEqual([elements[1].frameId, elements[2].frameId], ['f', null]);
		assert.deepStrictEqual(elements[3].type === 'image' && [elements[3].assetId, elements[3].naturalWidth], ['abc.png', 500]);
	});
});
