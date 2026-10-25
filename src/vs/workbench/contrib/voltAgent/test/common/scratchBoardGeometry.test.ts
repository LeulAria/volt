/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bindingCandidateAt, bindingEndpoint, facingSide, rebindConnector, retypeConnector, routeContext, routeElbow, separateElbowLegs } from '../../common/scratchBoard/scratchBinding.js';
import { applyPatch, createLabel, createLinear, createShape } from '../../common/scratchBoard/scratchFactory.js';
import { elementBounds, elementsInMarquee, hitTestElement, localToWorld, topmostHit } from '../../common/scratchBoard/scratchGeometry.js';
import { Vec } from '../../common/scratchBoard/scratchMath.js';
import { snapBounds, snapPoint, snapToGrid } from '../../common/scratchBoard/scratchSnapping.js';
import { alignMany, distributeMany, flipMany, resizeMany, resizeSingle, rotateMany } from '../../common/scratchBoard/scratchTransform.js';
import { IScratchBounds, IScratchLinearElement, ScratchElement, ScratchShapeKind } from '../../common/scratchBoard/scratchTypes.js';

function shape(x: number, y: number, width: number, height: number, extra: { shape?: ScratchShapeKind; angle?: number; fill?: string; id?: string } = {}) {
	return createShape({ x, y, width, height, shape: extra.shape ?? 'rectangle', roundness: 'sharp', fill: extra.fill ?? 'transparent', angle: extra.angle ?? 0, id: extra.id });
}

function close(actual: number, expected: number, epsilon = 0.05, message?: string): void {
	assert.ok(Math.abs(actual - expected) <= epsilon, `${message ?? ''} expected ${expected}, got ${actual}`);
}

function closePoint(actual: Vec, expected: Vec, epsilon = 0.05): void {
	close(actual[0], expected[0], epsilon, 'x:');
	close(actual[1], expected[1], epsilon, 'y:');
}

function endWorld(base: IScratchLinearElement, patch: { x: number; y: number; points: readonly (readonly [number, number])[] }): Vec {
	const last = patch.points[patch.points.length - 1];
	return [patch.x + last[0], patch.y + last[1]];
}

function assertOrthogonal(points: readonly Vec[]): void {
	for (let i = 1; i < points.length; i++) {
		const [a, b] = [points[i - 1], points[i]];
		assert.ok(Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6, `segment ${i} is diagonal: ${JSON.stringify([a, b])}`);
	}
}

function segmentCrossesInterior(a: Vec, b: Vec, box: IScratchBounds): boolean {
	if (Math.abs(a[1] - b[1]) < 1e-6) {
		return a[1] > box.minY && a[1] < box.maxY && Math.max(a[0], b[0]) > box.minX && Math.min(a[0], b[0]) < box.maxX;
	}
	return a[0] > box.minX && a[0] < box.maxX && Math.max(a[1], b[1]) > box.minY && Math.min(a[1], b[1]) < box.maxY;
}

suite('Scratch board geometry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('hit tests', () => {

		test('a 45° rotated rectangle is hit inside its turned box, not its old corner', () => {
			const solid = shape(0, 0, 100, 50, { angle: Math.PI / 4, fill: '#ffc9c9' });
			assert.strictEqual(hitTestElement(solid, [50, 25], 2, false), true);
			// The unrotated top-right corner now lies outside the shape.
			assert.strictEqual(hitTestElement(solid, [100, 0], 2, false), false);
			// The turned top-right corner is on the outline.
			assert.strictEqual(hitTestElement(solid, [103.03, 42.68], 2, false), true);
		});

		test('an empty shape is only hit on its outline unless selected or labelled', () => {
			const empty = shape(0, 0, 100, 100);
			assert.strictEqual(hitTestElement(empty, [50, 50], 2, false), false);
			assert.strictEqual(hitTestElement(empty, [50, 50], 2, true), true);
			assert.strictEqual(hitTestElement(empty, [100, 50], 2, false), true);
			const labelled = { ...empty, label: createLabel('API') };
			assert.strictEqual(hitTestElement(labelled, [50, 50], 2, false), true);
		});

		test('a connector is hit within tolerance plus half its stroke', () => {
			const arrow = createLinear({ type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], arrowType: 'sharp', strokeWidth: 2 });
			assert.strictEqual(hitTestElement(arrow, [50, 3], 2, false), true);
			assert.strictEqual(hitTestElement(arrow, [50, 4], 2, false), false);
		});

		test('topmost hit prefers the upper element and skips locked ones', () => {
			const below = shape(0, 0, 100, 100, { fill: '#a5d8ff' });
			const above = shape(50, 50, 100, 100, { fill: '#ffc9c9' });
			assert.strictEqual(topmostHit([below, above], [75, 75], 2, new Set())?.id, above.id);
			const locked = { ...above, locked: true };
			assert.strictEqual(topmostHit([below, locked], [75, 75], 2, new Set())?.id, below.id);
			// A selected element under another one still wins inside the selection.
			assert.strictEqual(topmostHit([below, above], [75, 75], 2, new Set([below.id]))?.id, below.id);
		});

		test('bounds pad for arrowheads so culling never clips them', () => {
			const arrow = createLinear({ type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], arrowType: 'sharp', strokeWidth: 2, roughness: 0 });
			const bounds = elementBounds(arrow);
			assert.ok(bounds.maxX >= 100 + 12 && bounds.minY <= -12);
		});
	});

	suite('marquee', () => {

		test('contain wants the whole element, intersect any touch', () => {
			const a = shape(10, 10, 20, 20, { fill: '#a5d8ff' });
			const b = shape(100, 100, 50, 50, { fill: '#a5d8ff' });
			assert.deepStrictEqual(elementsInMarquee([a, b], { minX: 0, minY: 0, maxX: 40, maxY: 40 }, 'contain').map(el => el.id), [a.id]);
			assert.deepStrictEqual(elementsInMarquee([a, b], { minX: 20, minY: 20, maxX: 120, maxY: 120 }, 'contain').map(el => el.id), []);
			assert.deepStrictEqual(elementsInMarquee([a, b], { minX: 20, minY: 20, maxX: 120, maxY: 120 }, 'intersect').map(el => el.id), [a.id, b.id]);
		});

		test('a marquee inside an empty shape does not touch it', () => {
			const big = shape(0, 0, 500, 500);
			assert.deepStrictEqual(elementsInMarquee([big], { minX: 200, minY: 200, maxX: 250, maxY: 250 }, 'intersect'), []);
			const filled = shape(0, 0, 500, 500, { fill: '#ffec99' });
			assert.strictEqual(elementsInMarquee([filled], { minX: 200, minY: 200, maxX: 250, maxY: 250 }, 'intersect').length, 1);
		});
	});

	suite('bindings', () => {

		test('an end lands on the outline, a gap short of it', () => {
			const binding = (id: string) => ({ elementId: id, anchor: null });
			const rect = shape(0, 0, 100, 100);
			closePoint(bindingEndpoint(rect, binding(rect.id), [300, 50], 6), [106, 50]);
			const ellipse = shape(0, 0, 100, 100, { shape: 'ellipse' });
			closePoint(bindingEndpoint(ellipse, binding(ellipse.id), [300, 50], 6), [106, 50], 0.2);
			const diamond = shape(0, 0, 100, 100, { shape: 'diamond' });
			closePoint(bindingEndpoint(diamond, binding(diamond.id), [50, 300], 6), [50, 106]);
			closePoint(bindingEndpoint(diamond, binding(diamond.id), [200, 200], 6), [75 + 6 / Math.SQRT2, 75 + 6 / Math.SQRT2]);
		});

		test('a rotated target is reached on its turned outline', () => {
			const turned = shape(0, 0, 100, 50, { angle: Math.PI / 2 });
			closePoint(bindingEndpoint(turned, { elementId: turned.id, anchor: null }, [300, 25], 6), [81, 25]);
		});

		test('an anchored end sits on its port', () => {
			const rect = shape(0, 0, 100, 100);
			closePoint(bindingEndpoint(rect, { elementId: rect.id, anchor: [0.5, 0] }, [500, 500], 6), [50, -6]);
		});

		test('ends near a port snap to it; nearby ends aim at the centre', () => {
			const rect = shape(0, 0, 100, 100);
			const atPort = bindingCandidateAt([rect], [100, 50], 1, new Set());
			assert.deepStrictEqual(atPort?.anchor, [1, 0.5]);
			assert.strictEqual(atPort?.port, 1);
			const nearSide = bindingCandidateAt([rect], [100, 20], 1, new Set());
			assert.strictEqual(nearSide?.element.id, rect.id);
			assert.strictEqual(nearSide?.anchor, null);
			assert.strictEqual(bindingCandidateAt([rect], [120, 50], 1, new Set()), undefined);
			// Zoomed out, the reach grows in world units.
			assert.strictEqual(bindingCandidateAt([rect], [120, 50], 0.5, new Set())?.port, 1);
			assert.strictEqual(bindingCandidateAt([rect], [50, 50], 1, new Set([rect.id])), undefined);
		});

		test('a connector follows a moved target and drops a missing one', () => {
			const a = shape(0, 0, 100, 100, { id: 'a' });
			const b = shape(300, 0, 100, 100, { id: 'b' });
			const arrow = createLinear({
				type: 'arrow', x: 106, y: 50, points: [[0, 0], [188, 0]], arrowType: 'sharp',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			const lookup = (moved: ScratchElement | undefined) => (id: string) => id === 'a' ? a : moved;
			assert.strictEqual(rebindConnector(arrow, lookup(b)), undefined);

			const movedB = { ...b, y: 200 };
			const patch = rebindConnector(arrow, lookup(movedB))!;
			assert.ok(patch);
			closePoint([patch.x, patch.y], [100 + 6 * 0.83205, 83.333 + 6 * 0.5547], 0.05);
			closePoint(endWorld(arrow, patch), [300 - 6 * 0.83205, 216.667 - 6 * 0.5547], 0.05);
			assert.deepStrictEqual(patch.points[0], [0, 0]);

			const dropped = rebindConnector(arrow, lookup(undefined))!;
			assert.strictEqual(dropped.endBinding, null);
			assert.deepStrictEqual(dropped.startBinding, arrow.startBinding);
			closePoint(endWorld(arrow, dropped), [294, 50]);
		});

		test('an elbow connector is re-routed with right angles only', () => {
			const a = shape(0, 0, 100, 100, { id: 'a' });
			const b = shape(300, 200, 100, 100, { id: 'b' });
			const elbow = createLinear({
				type: 'arrow', x: 106, y: 50, points: [[0, 0], [100, 0]], arrowType: 'elbow',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			const patch = rebindConnector(elbow, id => id === 'a' ? a : b)!;
			const world = patch.points.map((p): Vec => [patch.x + p[0], patch.y + p[1]]);
			assertOrthogonal(world);
			// Leaves A's right side and enters B's left side.
			closePoint(world[0], [106, 50]);
			closePoint(world[world.length - 1], [294, 250]);
		});

		test('switching arrow type routes an elbow, and leaving elbow keeps only the ends', () => {
			const a = shape(0, 0, 100, 100, { id: 'a' });
			const b = shape(300, 200, 100, 100, { id: 'b' });
			const lookup = (id: string) => id === 'a' ? a : id === 'b' ? b : undefined;
			const sharp = createLinear({
				type: 'arrow', x: 106, y: 50, points: [[0, 0], [188, 200]], arrowType: 'sharp',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			const toElbow = retypeConnector({ ...sharp, arrowType: 'elbow' }, 'sharp', lookup)!;
			const routed = toElbow.points.map((p): Vec => [toElbow.x + p[0], toElbow.y + p[1]]);
			assert.ok(routed.length > 2);
			assertOrthogonal(routed);

			const elbow = applyPatch({ ...sharp, arrowType: 'elbow' }, toElbow) as IScratchLinearElement;
			const back = retypeConnector({ ...elbow, arrowType: 'round' }, 'elbow', lookup)!;
			assert.strictEqual(back.points.length, 2);
			assert.deepStrictEqual(back.startBinding, sharp.startBinding);

			// Unbound: a plain right-angled route between the ends.
			const free = createLinear({ type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 120]], arrowType: 'sharp' });
			const freeElbow = retypeConnector({ ...free, arrowType: 'elbow' }, 'sharp', () => undefined)!;
			const freeWorld = freeElbow.points.map((p): Vec => [freeElbow.x + p[0], freeElbow.y + p[1]]);
			assertOrthogonal(freeWorld);
			closePoint(freeWorld[0], [0, 0]);
			closePoint(freeWorld[freeWorld.length - 1], [200, 120]);

			assert.strictEqual(retypeConnector(sharp, 'sharp', lookup), undefined);
		});
	});

	suite('elbow routing', () => {

		test('routes between two points with right angles', () => {
			const route = routeElbow([100, 50], [1, 0], [300, 250], [-1, 0], [
				{ minX: 0, minY: 0, maxX: 100, maxY: 100 },
				{ minX: 300, minY: 200, maxX: 400, maxY: 300 },
			]);
			assertOrthogonal(route);
			assert.deepStrictEqual(route[0], [100, 50]);
			assert.deepStrictEqual(route[route.length - 1], [300, 250]);
			assert.ok(route.length <= 6, `too many bends: ${route.length}`);
		});

		test('goes around an obstacle in the way', () => {
			const wall: IScratchBounds = { minX: 80, minY: -30, maxX: 120, maxY: 30 };
			const route = routeElbow([0, 0], [1, 0], [200, 0], [-1, 0], [wall]);
			assertOrthogonal(route);
			assert.deepStrictEqual(route[0], [0, 0]);
			assert.deepStrictEqual(route[route.length - 1], [200, 0]);
			for (let i = 1; i < route.length; i++) {
				assert.ok(!segmentCrossesInterior(route[i - 1], route[i], wall), `segment ${i} crosses the wall`);
			}
		});

		test('a straight shot stays straight', () => {
			const route = routeElbow([0, 0], [1, 0], [200, 0], [-1, 0], []);
			assert.deepStrictEqual(route, [[0, 0], [200, 0]]);
		});

		test('leaves across the wider gap between two boxes', () => {
			const box: IScratchBounds = { minX: 0, minY: 0, maxX: 200, maxY: 60 };
			// Below and well to the right, but the boxes overlap across: bottom to top, not round a corner.
			assert.strictEqual(facingSide(box, { minX: 150, minY: 160, maxX: 350, maxY: 220 }), 2);
			assert.strictEqual(facingSide(box, { minX: 400, minY: 40, maxX: 500, maxY: 100 }), 1);
			// Diagonal: the wider of the two gaps wins.
			assert.strictEqual(facingSide(box, { minX: -300, minY: 400, maxX: -250, maxY: 460 }), 2);
			assert.strictEqual(facingSide(box, { minX: -500, minY: 200, maxX: -450, maxY: 260 }), 3);
		});

		test('a bound elbow goes round a shape between its ends, and keeps a route that still fits', () => {
			const a = shape(0, 0, 100, 60, { id: 'a' });
			const middle = shape(0, 140, 100, 60, { id: 'm' });
			const b = shape(0, 280, 100, 60, { id: 'b' });
			const lookup = (id: string) => [a, middle, b].find(s => s.id === id);
			const elbow = createLinear({
				type: 'arrow', x: 50, y: 66, points: [[0, 0], [0, 208]], arrowType: 'elbow',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			const patch = rebindConnector(elbow, lookup, undefined, routeContext([a, middle, b]))!;
			const world = patch.points.map((p): Vec => [patch.x + p[0], patch.y + p[1]]);
			assertOrthogonal(world);
			const box = elementBounds(middle);
			for (let i = 1; i < world.length; i++) {
				assert.ok(!segmentCrossesInterior(world[i - 1], world[i], box), `segment ${i} runs through the middle shape`);
			}
			// Without the board's other shapes it runs straight through, as before.
			assert.strictEqual(rebindConnector(elbow, lookup), undefined);

			// Placed somewhere else as a whole (a paste, a drawing), the route is kept as it is.
			const routed = applyPatch(elbow, patch) as IScratchLinearElement;
			const moved = [a, middle, b].map(s => ({ ...s, x: s.x + 500, y: s.y + 40 }));
			const movedLookup = (id: string) => moved.find(s => s.id === id);
			assert.strictEqual(rebindConnector({ ...routed, x: routed.x + 500, y: routed.y + 40 }, movedLookup, undefined, routeContext(moved)), undefined);
		});

		test('a re-routed elbow keeps a track away from the lines already there', () => {
			const a = shape(0, 0, 100, 60, { id: 'a' });
			const b = shape(300, 200, 100, 60, { id: 'b' });
			const lookup = (id: string) => [a, b].find(s => s.id === id);
			const elbow = createLinear({
				type: 'arrow', x: 50, y: 66, points: [[0, 0], [300, 128]], arrowType: 'elbow',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			// Right side to left side: the middle leg runs down between them.
			const alone = rebindConnector(elbow, lookup, undefined, routeContext([a, b]))!;
			assert.strictEqual(alone.points.length, 4);
			const middle = alone.x + alone.points[1][0];
			// Another elbow already runs down that very line.
			const other = createLinear({ type: 'arrow', x: middle - 200, y: -50, points: [[0, 0], [200, 0], [200, 450], [400, 450]], arrowType: 'elbow' });
			const apart = rebindConnector(elbow, lookup, undefined, routeContext([a, b, other]))!;
			const world = apart.points.map((p): Vec => [apart.x + p[0], apart.y + p[1]]);
			assertOrthogonal(world);
			assert.ok(Math.abs(world[1][0] - middle) >= 12, `${world[1][0]} vs ${middle}`);
		});

		test('a route keeps off another line instead of running along it', () => {
			// Straight across is shortest, but another line already runs there.
			const other = { id: 'x', axis: 1 as const, at: 0, lo: -50, hi: 250 };
			const route = routeElbow([0, 0], [1, 0], [200, 0], [-1, 0], [], 24, [], [other]);
			assertOrthogonal(route);
			for (let i = 1; i < route.length; i++) {
				const level = route[i - 1][1] === route[i][1];
				assert.ok(!level || Math.abs(route[i][1]) >= 12 || Math.abs(route[i][0] - route[i - 1][0]) <= 48, `segment ${i} runs along the other line: ${JSON.stringify(route)}`);
			}
		});

		test('an unanchored end slides off a spot another line already ends at', () => {
			const a = shape(0, 0, 200, 60, { id: 'a' });
			const b = shape(0, 200, 200, 60, { id: 'b' });
			const lookup = (id: string) => [a, b].find(s => s.id === id);
			const make = (id: string) => createLinear({
				id, type: 'arrow', x: 100, y: 66, points: [[0, 0], [0, 128]], arrowType: 'elbow',
				startBinding: { elementId: 'a', anchor: null }, endBinding: { elementId: 'b', anchor: null },
			});
			// The first one runs straight down the middle; the second leaves beside it.
			const first = applyPatch(make('one'), rebindConnector(make('one'), lookup, undefined, routeContext([a, b])) ?? {}) as IScratchLinearElement;
			const second = rebindConnector(make('two'), lookup, undefined, routeContext([a, b, first]))!;
			const world = second.points.map((p): Vec => [second.x + p[0], second.y + p[1]]);
			assert.ok(Math.abs(world[0][0] - 100) >= 12, `starts at ${world[0][0]}`);
			assertOrthogonal(world);
		});

		test('legs in the same gap get tracks of their own, and labelled ones room for their labels', () => {
			// Two routes turning on the same line between two rows, overlapping from x 100 to 200.
			const one: Vec[] = [[0, 0], [0, 100], [200, 100], [200, 200]];
			const two: Vec[] = [[100, 0], [100, 100], [300, 100], [300, 200]];
			const [p, q] = separateElbowLegs([one, two], []);
			assertOrthogonal(p);
			assertOrthogonal(q);
			assert.notStrictEqual(p[1][1], q[1][1]);
			assert.strictEqual(Math.abs(p[1][1] - q[1][1]), 12);
			// Ends stay on their ports.
			assert.deepStrictEqual([p[0], p[3], q[0], q[3]], [one[0], one[3], two[0], two[3]]);
			// The order that does not cross: the line that comes down further right turns first.
			assert.ok(q[1][1] < p[1][1]);
			const [lp, lq] = separateElbowLegs([one, two], [], [{ width: 80, height: 30 }, { width: 80, height: 30 }]);
			assert.ok(Math.abs(lp[1][1] - lq[1][1]) >= 30);
		});
	});

	suite('transforms', () => {

		test('resizing a rotated rectangle keeps the opposite corner in place', () => {
			const rect = shape(0, 0, 100, 50, { angle: Math.PI / 6 });
			const fixed = localToWorld(rect, [0, 0]);
			const pointer = localToWorld(rect, [150, 80]);
			const next = applyPatch(rect, resizeSingle(rect, 'se', pointer, { keepAspect: false, fromCenter: false }));
			close(next.width, 150);
			close(next.height, 80);
			closePoint(localToWorld(next, [0, 0]), fixed);
			assert.strictEqual(next.angle, rect.angle);
		});

		test('keep aspect and from centre', () => {
			const rect = shape(0, 0, 100, 50);
			const aspect = applyPatch(rect, resizeSingle(rect, 'se', [200, 60], { keepAspect: true, fromCenter: false }));
			close(aspect.width, 200);
			close(aspect.height, 100);
			const centred = applyPatch(rect, resizeSingle(rect, 'e', [120, 25], { keepAspect: false, fromCenter: true }));
			close(centred.width, 140);
			close(centred.x + centred.width / 2, 50);
			// Dragging past the opposite side clamps instead of flipping.
			const tiny = applyPatch(rect, resizeSingle(rect, 'e', [-40, 25], { keepAspect: false, fromCenter: false }));
			close(tiny.width, 1);
			close(tiny.x, 0);
		});

		test('resizing a connector scales its points', () => {
			const line = createLinear({ type: 'line', x: 10, y: 10, points: [[0, 0], [100, 50]], arrowType: 'sharp' });
			const next = applyPatch(line, resizeSingle(line, 'se', [210, 110], { keepAspect: false, fromCenter: false }));
			assert.strictEqual(next.x, 10);
			assert.strictEqual(next.y, 10);
			assert.deepStrictEqual(next.points, [[0, 0], [200, 100]]);
		});

		test('scaling a selection uniformly scales its text', () => {
			const a = shape(0, 0, 100, 100);
			const b = shape(100, 100, 100, 100);
			const patches = resizeMany([a, b], { minX: 0, minY: 0, maxX: 200, maxY: 200 }, 'se', [400, 400], { keepAspect: true, fromCenter: false });
			const nb = applyPatch(b, patches.get(b.id)!);
			close(nb.x, 200);
			close(nb.width, 200);
		});

		test('rotating around a centre moves and turns each element', () => {
			const rect = shape(0, 0, 100, 100);
			const next = applyPatch(rect, rotateMany([rect], [0, 0], Math.PI / 2).get(rect.id)!);
			close(next.x, -100);
			close(next.y, 0);
			close(next.angle, Math.PI / 2);
		});

		test('flipping mirrors positions, connector points and their anchors', () => {
			const a = shape(0, 0, 10, 10, { id: 'a' });
			const b = shape(90, 0, 10, 10, { id: 'b' });
			const arrow = createLinear({
				type: 'arrow', x: 10, y: 5, points: [[0, 0], [80, 0]], arrowType: 'sharp', roughness: 0,
				startBinding: { elementId: 'a', anchor: [1, 0.5] }, endBinding: { elementId: 'b', anchor: [0, 0.5] },
			});
			const patches = flipMany([a, b, arrow], 'horizontal');
			assert.strictEqual(applyPatch(a, patches.get('a')!).x, 90);
			assert.strictEqual(applyPatch(b, patches.get('b')!).x, 0);
			const flipped = applyPatch(arrow, patches.get(arrow.id)!) as IScratchLinearElement;
			closePoint([flipped.x, flipped.y], [90, 5]);
			closePoint([flipped.x + flipped.points[1][0], flipped.y + flipped.points[1][1]], [10, 5]);
			assert.deepStrictEqual(flipped.startBinding?.anchor, [0, 0.5]);
			assert.deepStrictEqual(flipped.endBinding?.anchor, [1, 0.5]);
		});

		test('align and distribute', () => {
			const a = shape(0, 0, 10, 10);
			const b = shape(50, 20, 10, 10);
			assert.strictEqual(applyPatch(b, alignMany([a, b], 'left').get(b.id)!).x, 0);
			assert.strictEqual(alignMany([a, b], 'left').has(a.id), false);
			const c = shape(30, 0, 10, 10);
			const d = shape(100, 0, 10, 10);
			const spread = distributeMany([a, c, d], 'horizontal');
			assert.strictEqual(applyPatch(c, spread.get(c.id)!).x, 50);
			assert.strictEqual(spread.has(a.id) || spread.has(d.id), false);
		});
	});

	suite('snapping', () => {

		test('a box snaps to a neighbour edge and shows guides', () => {
			const result = snapBounds({ minX: 102, minY: 0, maxX: 152, maxY: 50 }, [{ minX: 0, minY: 0, maxX: 100, maxY: 50 }], 5);
			assert.strictEqual(result.dx, -2);
			assert.strictEqual(result.dy, 0);
			assert.ok(result.guides.some(g => g.axis === 'x' && g.value === 100));
			assert.ok(result.guides.some(g => g.axis === 'y' && g.value === 25));
		});

		test('nothing within the threshold leaves it alone', () => {
			const result = snapBounds({ minX: 120, minY: 80, maxX: 170, maxY: 130 }, [{ minX: 0, minY: 0, maxX: 100, maxY: 50 }], 5);
			assert.deepStrictEqual(result, { dx: 0, dy: 0, guides: [] });
		});

		test('points and the grid', () => {
			assert.deepStrictEqual(snapPoint([49, 203], [{ minX: 0, minY: 0, maxX: 100, maxY: 200 }], 4).point, [50, 200]);
			assert.strictEqual(snapToGrid(29, 20), 20);
			assert.strictEqual(snapToGrid(31, 20), 40);
		});
	});
});
