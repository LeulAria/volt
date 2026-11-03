/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { arrowheadDrawing, fitDashes, freehandDrawing, IScratchPathSpec, linearCenterline, linearDrawing, shapeDrawing, strokeDash } from '../../common/scratchBoard/scratchDrawing.js';
import { createDraw, createLinear, createShape } from '../../common/scratchBoard/scratchFactory.js';
import { freehandOptionsFor, freehandOutline, outlineToSvgPath, simplifyStroke } from '../../common/scratchBoard/scratchFreehand.js';
import { pointInPolygon, Vec } from '../../common/scratchBoard/scratchMath.js';
import { hachureLines, roughCurve, roughEllipse, roughPath, roughPolyline, roughShape } from '../../common/scratchBoard/scratchRough.js';
import { pathToSvg, SHAPE_KINDS, shapeGeometry } from '../../common/scratchBoard/scratchShapes.js';
import { ScratchArrowhead, ScratchPressurePoint } from '../../common/scratchBoard/scratchTypes.js';

const identity = (c: string) => c;

function assertFinite(specs: readonly IScratchPathSpec[]): void {
	for (const spec of specs) {
		assert.ok(!/NaN|Infinity/.test(spec.d), `bad path: ${spec.d.slice(0, 80)}`);
	}
}

/** Every x,y pair in an SVG path (good enough for M/L paths). */
function vertices(d: string): Vec[] {
	const out: Vec[] = [];
	const re = /[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(d))) {
		out.push([Number(m[1]), Number(m[2])]);
	}
	return out;
}

suite('Scratch board rendering', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('rough', () => {
		const rect = shapeGeometry('rectangle', 200, 120, 'sharp');

		test('same seed draws the same wobble, another seed a different one', () => {
			const a = roughPath(rect.fill, { roughness: 1, strokeWidth: 2, seed: 42 });
			const b = roughPath(rect.fill, { roughness: 1, strokeWidth: 2, seed: 42 });
			const c = roughPath(rect.fill, { roughness: 1, strokeWidth: 2, seed: 43 });
			assert.strictEqual(a, b);
			assert.notStrictEqual(a, c);
			assert.strictEqual(roughEllipse(50, 50, 100, 60, { roughness: 2, strokeWidth: 2, seed: 7 }), roughEllipse(50, 50, 100, 60, { roughness: 2, strokeWidth: 2, seed: 7 }));
			assert.notStrictEqual(roughCurve([[0, 0], [50, 30], [100, 0]], { roughness: 1, strokeWidth: 2, seed: 1 }), roughCurve([[0, 0], [50, 30], [100, 0]], { roughness: 1, strokeWidth: 2, seed: 2 }));
		});

		test('roughness 0 is the clean path', () => {
			for (const kind of SHAPE_KINDS) {
				const geometry = shapeGeometry(kind, 160, 100, 'round');
				assert.strictEqual(roughPath(geometry.fill, { roughness: 0, strokeWidth: 2, seed: 1 }), pathToSvg(geometry.fill));
				const drawn = roughShape(kind, geometry, { style: 'solid', visible: true }, { roughness: 0, strokeWidth: 2, seed: 1 });
				assert.strictEqual(drawn.fill, pathToSvg(geometry.fill));
				if (kind !== 'ellipse') {
					assert.strictEqual(drawn.stroke, geometry.strokes.map(s => pathToSvg(s)).join(''));
				}
			}
			assert.strictEqual(roughPolyline([[0, 0], [10, 0], [10, 10]], { roughness: 0, strokeWidth: 1, seed: 1 }), 'M0 0L10 0L10 10');
		});

		test('a stroke does not change when only the fill changes', () => {
			const options = { roughness: 1, strokeWidth: 2, seed: 9 };
			const none = roughShape('rectangle', rect, { style: 'solid', visible: false }, options);
			const solid = roughShape('rectangle', rect, { style: 'solid', visible: true }, options);
			const hachure = roughShape('rectangle', rect, { style: 'hachure', visible: true }, options);
			assert.strictEqual(none.stroke, solid.stroke);
			assert.strictEqual(none.stroke, hachure.stroke);
			assert.strictEqual(none.fill, undefined);
			assert.ok(solid.fill);
			assert.ok(hachure.hachure);
		});

		test('hachure lines stay inside the polygon and get denser with a smaller gap', () => {
			const square: Vec[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
			const lines = hachureLines(square, 10, -41);
			assert.ok(lines.length > 0);
			for (const [a, b] of lines) {
				for (const p of [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec]) {
					assert.ok(p[0] >= -1e-6 && p[0] <= 100 + 1e-6 && p[1] >= -1e-6 && p[1] <= 100 + 1e-6, `outside: ${p}`);
				}
				const mid: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				assert.ok(pointInPolygon(mid, square));
			}
			const dense = hachureLines(square, 5, -41);
			assert.ok(dense.length > lines.length * 1.6, `${dense.length} vs ${lines.length}`);
			const bigger = hachureLines([[0, 0], [200, 0], [200, 200], [0, 200]], 10, -41);
			assert.ok(bigger.length > lines.length * 1.6);
			// A concave polygon: no line midpoint lands in the notch.
			const notched: Vec[] = [[0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100]];
			for (const [a, b] of hachureLines(notched, 6, 30)) {
				assert.ok(pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], notched));
			}
		});

		test('a dashed outline is one path, so its dashes run on round the corners', () => {
			const star = shapeGeometry('star', 120, 120, 'sharp');
			const dashed = roughShape('star', star, { style: 'solid', visible: false }, { roughness: 1, strokeWidth: 2, seed: 7, singleStroke: true });
			assert.strictEqual((dashed.stroke.match(/M/g) ?? []).length, 1, dashed.stroke.slice(0, 120));
			// Solid strokes keep rough.js's second, offset pass.
			const solid = roughShape('star', star, { style: 'solid', visible: false }, { roughness: 1, strokeWidth: 2, seed: 7 });
			assert.ok((solid.stroke.match(/M/g) ?? []).length > 1);
		});

		test('cross-hatch draws both directions', () => {
			const options = { roughness: 0, strokeWidth: 2, seed: 1 };
			const hachure = roughShape('rectangle', rect, { style: 'hachure', visible: true }, options).hachure!;
			const cross = roughShape('rectangle', rect, { style: 'cross-hatch', visible: true }, options).hachure!;
			assert.ok(cross.length > hachure.length * 1.5);
		});
	});

	suite('freehand', () => {
		const options = freehandOptionsFor({ strokeWidth: 2, pen: 'pen', simulatePressure: true }, true);

		test('outlines one, two and many points', () => {
			const one: ScratchPressurePoint[] = [[10, 10, 0.5]];
			const two: ScratchPressurePoint[] = [[0, 0, 0.5], [40, 10, 0.5]];
			const many: ScratchPressurePoint[] = [];
			for (let i = 0; i < 60; i++) {
				many.push([i * 3, Math.sin(i / 6) * 20, 0.5]);
			}
			for (const points of [one, two, many]) {
				const outline = freehandOutline(points, options);
				assert.ok(outline.length >= 4, `outline of ${points.length}: ${outline.length}`);
				const d = outlineToSvgPath(outline, true);
				assert.ok(d.startsWith('M'), d.slice(0, 10));
				assert.ok(d.endsWith('Z'));
				assert.ok(!/NaN|Infinity/.test(d));
			}
		});

		test('pressure makes the stroke thicker', () => {
			const line = (pressure: number): ScratchPressurePoint[] => Array.from({ length: 30 }, (_, i) => [i * 4, 0, pressure] as ScratchPressurePoint);
			const real = freehandOptionsFor({ strokeWidth: 2, pen: 'pen', simulatePressure: false }, true);
			const width = (pts: ScratchPressurePoint[]) => {
				const ys = freehandOutline(pts, real).map(p => p[1]);
				return Math.max(...ys) - Math.min(...ys);
			};
			assert.ok(width(line(0.9)) > width(line(0.1)));
		});

		test('simplify keeps the ends and collapses a straight line', () => {
			const dense: ScratchPressurePoint[] = Array.from({ length: 200 }, (_, i) => [i, i * 0.5, i / 200] as ScratchPressurePoint);
			const simple = simplifyStroke(dense, 0.5);
			assert.strictEqual(simple.length, 2);
			assert.deepStrictEqual(simple[0], dense[0]);
			assert.deepStrictEqual(simple[1], dense[199]);
			const corner: ScratchPressurePoint[] = [[0, 0, 0.5], [50, 0, 0.5], [100, 0, 0.5], [100, 50, 0.6], [100, 100, 0.5]];
			const kept = simplifyStroke(corner, 1);
			assert.deepStrictEqual(kept, [[0, 0, 0.5], [100, 0, 0.5], [100, 100, 0.5]]);
		});

		test('freehand drawing fills in the stroke colour; the highlighter is translucent', () => {
			const points: ScratchPressurePoint[] = [[0, 0, 0.5], [20, 5, 0.5], [40, 0, 0.5], [60, 10, 0.5]];
			const pen = freehandDrawing(createDraw({ x: 0, y: 0, points, simulatePressure: true, stroke: '#123456' }), identity);
			assert.strictEqual(pen.length, 1);
			assert.strictEqual(pen[0].fill, '#123456');
			assert.strictEqual(pen[0].stroke, 'none');
			assert.strictEqual(pen[0].opacity, undefined);
			const marker = freehandDrawing(createDraw({ x: 0, y: 0, points, simulatePressure: false, pen: 'highlighter' }), identity);
			assert.strictEqual(marker[0].opacity, 0.45);
			assertFinite([...pen, ...marker]);
		});
	});

	suite('drawing', () => {
		test('dash patterns', () => {
			assert.strictEqual(strokeDash('solid', 2), undefined);
			assert.strictEqual(strokeDash('dashed', 2), '8 10');
			// Dots keep their shape at every width: the extra-bold pattern, scaled.
			assert.strictEqual(strokeDash('dotted', 4.5), '1.5 10.5');
			assert.strictEqual(strokeDash('dotted', 2), '0.67 4.67');
		});

		test('dashes fit each side: a dash at both ends of every side, whole periods round a loop', () => {
			const sides = fitDashes('M0 0L100 0L100 60L0 60Z', 8, 10);
			assert.strictEqual(sides.length, 4);
			for (const [i, length] of [100, 60, 100, 60].entries()) {
				const [on, off] = sides[i].dash.split(' ').map(Number);
				const n = Math.round((length + off) / (on + off));
				assert.ok(Math.abs(n * on + (n - 1) * off - length) < 0.1, `side ${i}: ${sides[i].dash}`);
			}
			// A wide rounded corner continues its side; a small one is a corner like a sharp turn.
			assert.strictEqual(fitDashes('M0 0L70 0C86.5 0 100 13.5 100 30L100 80', 8, 10).length, 1);
			assert.strictEqual(fitDashes('M0 0L90 0C95 0 100 5 100 10L100 60', 8, 10).length, 2);
			const ellipse = shapeDrawing(createShape({ x: 0, y: 0, width: 120, height: 80, shape: 'ellipse', strokeStyle: 'dashed', roughness: 0 }), identity).filter(spec => spec.dash);
			assert.strictEqual(ellipse.length, 1);
			const star = shapeDrawing(createShape({ x: 0, y: 0, width: 140, height: 134, shape: 'star', strokeStyle: 'dotted', roughness: 1 }), identity).filter(spec => spec.dash);
			assert.strictEqual(star.length, 10);
		});

		test('arrowhead tips land exactly on the tip', () => {
			const kinds: ScratchArrowhead[] = ['arrow', 'triangle', 'triangle-outline', 'diamond', 'diamond-outline', 'crowfoot-many', 'crowfoot-one-or-many', 'crowfoot-one', 'dot', 'circle'];
			const tip: Vec = [120, 80];
			for (const kind of kinds) {
				const head = arrowheadDrawing(kind, tip, [1, 0], 2, 200)!;
				assert.ok(head, kind);
				assert.ok(!/NaN|Infinity/.test(head.d), kind);
				if (kind === 'dot' || kind === 'circle') {
					assert.ok(head.d.startsWith('M120 80'), `${kind}: ${head.d}`);
					continue;
				}
				const hits = vertices(head.d).some(p => Math.abs(p[0] - tip[0]) < 1e-6 && Math.abs(p[1] - tip[1]) < 1e-6);
				assert.ok(hits, `${kind}: ${head.d}`);
				// Every vertex lies behind or on the tip (direction +x).
				for (const p of vertices(head.d)) {
					assert.ok(p[0] <= tip[0] + 1e-6, `${kind} pokes past the tip: ${p}`);
				}
			}
			assert.strictEqual(arrowheadDrawing('none', tip, [1, 0], 2, 200), undefined);
			assert.strictEqual(arrowheadDrawing('arrow', tip, [0, 0], 2, 200), undefined);
		});

		test('heads shrink on short segments', () => {
			const long = vertices(arrowheadDrawing('arrow', [0, 0], [1, 0], 2, 400)!.d);
			const short = vertices(arrowheadDrawing('arrow', [0, 0], [1, 0], 2, 20)!.d);
			assert.ok(Math.abs(short[0][0]) <= 10 + 1e-6);
			assert.ok(Math.abs(long[0][0]) > Math.abs(short[0][0]));
		});

		test('round centerline passes through every point', () => {
			const points: Vec[] = [[0, 0], [80, 40], [160, -20], [240, 30]];
			const el = createLinear({ x: 0, y: 0, type: 'arrow', points, arrowType: 'round' });
			const line = linearCenterline(el);
			for (const p of points) {
				assert.ok(line.some(q => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6), `missing ${p}`);
			}
			const sharp = linearCenterline({ ...el, arrowType: 'sharp' });
			assert.deepStrictEqual(sharp, points);
		});

		test('shapes, connectors and closed lines draw finite paths', () => {
			const specs: IScratchPathSpec[] = [];
			for (const kind of SHAPE_KINDS) {
				for (const roughness of [0, 1, 2]) {
					for (const fillStyle of ['solid', 'hachure', 'cross-hatch'] as const) {
						specs.push(...shapeDrawing(createShape({ x: 0, y: 0, width: 140, height: 90, shape: kind, roughness, fill: '#a5d8ff', fillStyle, strokeStyle: roughness === 2 ? 'dashed' : 'solid' }), identity));
					}
				}
				// Degenerate boxes still draw.
				specs.push(...shapeDrawing(createShape({ x: 0, y: 0, width: 0, height: 0, shape: kind }), identity));
			}
			for (const arrowType of ['sharp', 'round', 'elbow'] as const) {
				for (const roughness of [0, 1]) {
					const el = createLinear({ x: 0, y: 0, type: 'arrow', points: [[0, 0], [100, 0], [100, 80], [200, 80]], arrowType, roughness, startArrowhead: 'dot', endArrowhead: 'triangle' });
					const drawn = linearDrawing(el, identity);
					assert.strictEqual(drawn.length, 3, `${arrowType}/${roughness}: body and two heads`);
					specs.push(...drawn);
				}
			}
			const polygon = createLinear({ x: 0, y: 0, type: 'line', points: [[0, 0], [100, 0], [50, 80]], closed: true, fill: '#ffc9c9', endArrowhead: 'arrow' });
			const closed = linearDrawing(polygon, identity);
			assert.strictEqual(closed[0].fill, '#ffc9c9');
			assert.strictEqual(closed.length, 2, 'fill and outline, no heads on a closed line');
			specs.push(...closed);
			assert.deepStrictEqual(linearDrawing(createLinear({ x: 0, y: 0, type: 'line', points: [[0, 0], [0, 0]] }), identity), []);
			assertFinite(specs);
		});

		test('transparent fill and stroke draw nothing for them', () => {
			const specs = shapeDrawing(createShape({ x: 0, y: 0, width: 100, height: 60, shape: 'rectangle', fill: 'transparent', stroke: 'transparent' }), identity);
			assert.deepStrictEqual(specs, []);
		});

		test('colours go through the mapper', () => {
			const specs = shapeDrawing(createShape({ x: 0, y: 0, width: 100, height: 60, shape: 'ellipse', fill: '#ffffff', fillStyle: 'solid', stroke: '#000000' }), c => `mapped(${c})`);
			assert.deepStrictEqual(specs.map(s => [s.fill, s.stroke]), [['mapped(#ffffff)', 'none'], ['none', 'mapped(#000000)']]);
		});

		test('a filled head stops the body behind it', () => {
			const el = createLinear({ x: 0, y: 0, type: 'arrow', points: [[0, 0], [200, 0]], arrowType: 'sharp', roughness: 0, endArrowhead: 'triangle', startArrowhead: 'none' });
			const [body] = linearDrawing(el, identity);
			const ends = vertices(body.d);
			assert.ok(ends[ends.length - 1][0] < 200 - 5, body.d);
			const open = createLinear({ ...el, endArrowhead: 'arrow' });
			const [openBody] = linearDrawing(open, identity);
			assert.strictEqual(vertices(openBody.d).pop()![0], 200);
		});
	});
});
