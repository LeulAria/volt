/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DrawStroke, parseShapes, placeStrokes, svgPathStrokes } from '../../../common/tools/desktopDraw.js';

function round(strokes: readonly DrawStroke[]): number[][][] {
	return strokes.map(stroke => stroke.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
}

function bounds(stroke: DrawStroke): [number, number, number, number] {
	const xs = stroke.map(p => p[0]);
	const ys = stroke.map(p => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

suite('Desktop drawing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lines, rectangles and polygons become strokes in the 0-100 space', () => {
		assert.deepStrictEqual(round(parseShapes('line 10,10 90,90 | rect 20,30 10,5 | polygon 50,50 60,50 55,40')), [
			[[10, 10], [90, 90]],
			[[20, 30], [30, 30], [30, 35], [20, 35], [20, 30]],
			[[50, 50], [60, 50], [55, 40], [50, 50]],
		]);
		assert.deepStrictEqual(round(parseShapes('dot 5,5 6,6')), [[[5, 5]], [[6, 6]]]);
	});

	test('a circle stays round on a wide target: its radius is in hundredths of the width', () => {
		const [square] = parseShapes('circle 50,50 10');
		assert.deepStrictEqual(bounds(square).map(Math.round), [40, 40, 60, 60]);
		// On a 2:1 target, 10% of the width is 20% of the height.
		const [wide] = parseShapes('circle 50,50 10', 2);
		assert.deepStrictEqual(bounds(wide).map(Math.round), [40, 30, 60, 70]);
		const placed = placeStrokes([wide], [0, 0, 800, 400])[0];
		const [x1, y1, x2, y2] = bounds(placed);
		assert.ok(Math.abs((x2 - x1) - (y2 - y1)) < 1, 'as wide as it is tall on screen');
	});

	test('a stroke that starts where the last one ended continues it', () => {
		// Pressing on a line already drawn would grab it in most apps.
		const strokes = parseShapes('line 10,10 50,10 | line 50,10 50,50 | line 60,60 70,70');
		assert.deepStrictEqual(round(strokes), [[[10, 10], [50, 10], [50, 50]], [[60, 60], [70, 70]]]);
	});

	test('nothing is drawn outside the target', () => {
		assert.deepStrictEqual(round(parseShapes('line -20,50 140,50')), [[[0, 50], [100, 50]]]);
	});

	test('SVG paths: absolute and relative commands, curves, arcs and subpaths', () => {
		const strokes = svgPathStrokes('M10 10 h20 v20 H10 Z m40 0 l10 0 M60 60 C 60 80, 80 80, 80 60 Q 90 50 100 60 A 10 10 0 0 1 80 60');
		assert.strictEqual(strokes.length, 3);
		assert.deepStrictEqual(round([strokes[0]]), [[[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]]]);
		assert.deepStrictEqual(round([strokes[1]]), [[[50, 10], [60, 10]]]);
		const curve = strokes[2];
		assert.deepStrictEqual(curve[0], [60, 60]);
		assert.ok(curve.length > 20, 'curves are flattened into many short segments');
		const [x, y] = curve[curve.length - 1];
		assert.ok(Math.abs(x - 80) < 0.01 && Math.abs(y - 60) < 0.01, 'the arc ends at its end point');
		const lowest = Math.max(...curve.map(p => p[1]));
		assert.ok(lowest > 70 && lowest < 76, 'the cubic bulges toward its control points');
	});

	test('mistakes come back as messages the agent can act on', () => {
		assert.throws(() => parseShapes('circle 50,50'), /circle \(center, radius\) needs a number/);
		assert.throws(() => parseShapes('blob 1,2'), /unknown shape "blob"/);
		assert.throws(() => parseShapes('line 10,10'), /line needs two points/);
		assert.throws(() => parseShapes('path "M10 10 L"'), /missing a number/);
		assert.throws(() => parseShapes(''), /draw needs shapes/);
	});

	test('strokes are placed on the target box in screen points', () => {
		assert.deepStrictEqual(placeStrokes([[[0, 0], [50, 100]]], [100, 200, 300, 100]), [[[100, 200], [250, 300]]]);
	});
});
