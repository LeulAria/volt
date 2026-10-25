/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { add, boundsIntersect, boundsOfPoints, distance, distanceToPolyline, expandBounds, normalize, pointInPolygon, pointsEqual, rotate, scale, segmentIntersection, sub, unionBounds, Vec } from './scratchMath.js';
import { SHAPE_PORTS } from './scratchShapes.js';
import { elementBox, elementCenter, elementOutline, geometricBounds, linearWorldPoints, localToWorld, worldToLocal } from './scratchGeometry.js';
import { IScratchBinding, IScratchBounds, IScratchLinearElement, isBindable, isLinear, SCRATCH_BINDING_GAP, ScratchElement, ScratchPoint } from './scratchTypes.js';

/**
 * Connectors attached to elements: which element an end lands on while dragging, where a bound end
 * sits on the outline, and how connectors follow when the elements they join move.
 */

export interface IBindingCandidate {
	readonly element: ScratchElement;
	/** A port (0..1 in the target's box) the end snapped to, or null to aim at the centre. */
	readonly anchor: ScratchPoint | null;
	readonly port: number | undefined;
}

/** World-space distance (at zoom 1) within which an end binds to an outline it is outside of. */
const BIND_DISTANCE = 14;
/** World-space distance (at zoom 1) within which an end snaps to a port. */
const PORT_DISTANCE = 12;

export function portPosition(target: ScratchElement, port: number): Vec {
	const box = elementBox(target);
	const p = SHAPE_PORTS[port] ?? SHAPE_PORTS[0];
	return localToWorld(target, [p[0] * box.width, p[1] * box.height]);
}

/**
 * The element a dragged connector end would attach to at `p`: the topmost bindable element whose
 * outline contains `p` or passes near it. Frames only win when nothing else does.
 */
export function bindingCandidateAt(elements: readonly ScratchElement[], p: Vec, zoom: number, exclude: ReadonlySet<string>): IBindingCandidate | undefined {
	const z = zoom > 0 ? zoom : 1;
	const reach = BIND_DISTANCE / z;
	const portReach = PORT_DISTANCE / z;
	let frame: ScratchElement | undefined;
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i];
		if (!isBindable(el) || exclude.has(el.id)) {
			continue;
		}
		const outline = elementOutline(el);
		if (el.type === 'frame') {
			// A frame is a region, not a box: only its border takes a connector end.
			if (distanceToPolyline(p, outline, true) <= reach) {
				frame ??= el;
			}
			continue;
		}
		if (!pointInPolygon(p, outline) && distanceToPolyline(p, outline, true) > reach) {
			continue;
		}
		return candidateFor(el, p, portReach);
	}
	return frame ? candidateFor(frame, p, portReach) : undefined;
}

function candidateFor(el: ScratchElement, p: Vec, portReach: number): IBindingCandidate {
	for (let i = 0; i < SHAPE_PORTS.length; i++) {
		if (distance(p, portPosition(el, i)) <= portReach) {
			return { element: el, anchor: SHAPE_PORTS[i], port: i };
		}
	}
	return { element: el, anchor: null, port: undefined };
}

/** Where the outline crosses the ray from `from` along `direction`; the farthest crossing within `maxLength`. */
function farthestOutlineHit(outline: readonly Vec[], from: Vec, direction: Vec, maxLength: number): Vec | undefined {
	const to = add(from, scale(direction, maxLength));
	let best: { point: Vec; t: number } | undefined;
	for (let i = 0; i < outline.length; i++) {
		const hit = segmentIntersection(from, to, outline[i], outline[(i + 1) % outline.length]);
		if (hit && (!best || hit.t > best.t)) {
			best = hit;
		}
	}
	return best?.point;
}

function nearestOutlineHit(outline: readonly Vec[], from: Vec, to: Vec): Vec | undefined {
	let best: { point: Vec; t: number } | undefined;
	for (let i = 0; i < outline.length; i++) {
		const hit = segmentIntersection(from, to, outline[i], outline[(i + 1) % outline.length]);
		if (hit && (!best || hit.t < best.t)) {
			best = hit;
		}
	}
	return best?.point;
}

function reachOf(target: ScratchElement): number {
	const box = elementBox(target);
	return Math.hypot(box.width, box.height) + 10;
}

/** The outline point straight out from the centre in `direction`, pushed `gap` further out. */
function projectFromCenter(target: ScratchElement, direction: Vec, gap: number): Vec {
	const center = elementCenter(target);
	const dir = pointsEqual(direction, [0, 0]) ? [1, 0] as Vec : normalize(direction);
	const hit = farthestOutlineHit(elementOutline(target), center, dir, reachOf(target)) ?? center;
	return add(hit, scale(dir, gap));
}

/**
 * Where a bound end sits. Without an anchor the end aims at the target's centre from `toward` and
 * stops `gap` short of the outline; with one it sits on the outline at that anchor, pushed `gap` out.
 */
export function bindingEndpoint(target: ScratchElement, binding: IScratchBinding, toward: Vec, gap: number): Vec {
	const center = elementCenter(target);
	if (binding.anchor) {
		const box = elementBox(target);
		const anchor = localToWorld(target, [binding.anchor[0] * box.width, binding.anchor[1] * box.height]);
		const direction = sub(anchor, center);
		if (Math.hypot(direction[0], direction[1]) > 1e-6) {
			return projectFromCenter(target, direction, gap);
		}
	}
	const outline = elementOutline(target);
	if (pointInPolygon(toward, outline) || pointsEqual(toward, center)) {
		return projectFromCenter(target, sub(toward, center), gap);
	}
	const hit = nearestOutlineHit(outline, toward, center);
	if (!hit) {
		return center;
	}
	const back = normalize(sub(toward, hit));
	return add(hit, scale(back, Math.min(gap, distance(toward, hit))));
}

/**
 * The outward direction of the box side nearest `at`, in world space: the side's normal in the
 * element's own frame, turned by its rotation.
 */
export function outwardDirection(target: ScratchElement, at: Vec): Vec {
	const box = elementBox(target);
	const local = worldToLocal(target, at);
	const nx = box.width > 1e-6 ? (local[0] - box.width / 2) / (box.width / 2) : 0;
	const ny = box.height > 1e-6 ? (local[1] - box.height / 2) / (box.height / 2) : 0;
	const axis: Vec = Math.abs(nx) >= Math.abs(ny) ? [nx >= 0 ? 1 : -1, 0] : [0, ny >= 0 ? 1 : -1];
	return rotate(axis, [0, 0], target.angle);
}

/** Connectors with an end on one of `ids`. */
export function boundConnectors(elements: readonly ScratchElement[], ids: ReadonlySet<string>): IScratchLinearElement[] {
	const out: IScratchLinearElement[] = [];
	for (const el of elements) {
		if (isLinear(el) && ((el.startBinding && ids.has(el.startBinding.elementId)) || (el.endBinding && ids.has(el.endBinding.elementId)))) {
			out.push(el);
		}
	}
	return out;
}

/** World points to element fields: the first point becomes x, y and [0, 0]. */
export function normalizeLinear(worldPoints: readonly Vec[]): { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly points: ScratchPoint[] } {
	if (!worldPoints.length) {
		return { x: 0, y: 0, width: 0, height: 0, points: [] };
	}
	const [x, y] = worldPoints[0];
	const points = worldPoints.map((p): ScratchPoint => [p[0] - x, p[1] - y]);
	const b = boundsOfPoints(points);
	return { x, y, width: b.maxX - b.minX, height: b.maxY - b.minY, points };
}

/** Snaps a direction to the nearest world axis. */
function axisOf(direction: Vec): Vec {
	if (Math.abs(direction[0]) >= Math.abs(direction[1])) {
		return [direction[0] >= 0 ? 1 : -1, 0];
	}
	return [0, direction[1] >= 0 ? 1 : -1];
}

/** Rebinding result: also resets `angle`, since bound ends are placed in world space. */
export type ScratchRebindPatch = Pick<IScratchLinearElement, 'x' | 'y' | 'width' | 'height' | 'points' | 'startBinding' | 'endBinding' | 'angle'>;

/** A box an elbow connector routes around. */
export interface IScratchObstacle {
	readonly id: string;
	readonly bounds: IScratchBounds;
}

/** How far past its ends an elbow looks for boxes in its way. */
const ROUTE_REACH = 200;
/** The nearest this many: the router's grid grows with every box. */
const MAX_ROUTE_OBSTACLES = 24;

/** A straight stretch of an elbow connector: `at` on `axis` (1 when it runs level), from `lo` to `hi` along it. */
export interface IScratchLeg {
	readonly id: string;
	readonly axis: 0 | 1;
	readonly at: number;
	readonly lo: number;
	readonly hi: number;
	/** Only crossing it costs (a label's outline): running beside it is fine. */
	readonly crossOnly?: boolean;
}

/** What an elbow routes around on a board, and the lines it keeps off. */
export interface IScratchRouteContext {
	readonly boxes: readonly IScratchObstacle[];
	/** The board's other elbows, so a re-routed one does not run on top of one of them. */
	readonly legs: readonly IScratchLeg[];
}

/** What elbows on a board route around: its shapes, text, notes, cards, images and icons (not frames). */
export function routeObstacles(elements: readonly ScratchElement[]): IScratchObstacle[] {
	const out: IScratchObstacle[] = [];
	for (const el of elements) {
		if (isBindable(el) && el.type !== 'frame') {
			out.push({ id: el.id, bounds: geometricBounds(el) });
		}
	}
	return out;
}

/** The straight stretches of a right-angled line, as legs of `id`. */
export function legsOf(id: string, world: readonly Vec[]): IScratchLeg[] {
	const legs: IScratchLeg[] = [];
	for (let i = 1; i < world.length; i++) {
		const a = world[i - 1], b = world[i];
		const axis = Math.abs(a[1] - b[1]) < EPS ? 1 : Math.abs(a[0] - b[0]) < EPS ? 0 : undefined;
		if (axis !== undefined) {
			legs.push({ id, axis, at: a[axis], lo: Math.min(a[1 - axis], b[1 - axis]), hi: Math.max(a[1 - axis], b[1 - axis]) });
		}
	}
	return legs;
}

/** The boxes elbows on a board route around and the legs of the elbows already there. */
export function routeContext(elements: readonly ScratchElement[]): IScratchRouteContext {
	const legs: IScratchLeg[] = [];
	for (const el of elements) {
		if (isLinear(el) && el.arrowType === 'elbow') {
			legs.push(...legsOf(el.id, linearWorldPoints(el)));
		}
	}
	return { boxes: routeObstacles(elements), legs };
}

/**
 * `context` with the line `id` where it now runs. Lines re-routed one after another record
 * themselves, so each keeps off the ones before it; two that both dodged the same spot would
 * otherwise swap back and forth on every frame of a drag.
 */
export function withLegs(context: IScratchRouteContext, id: string, world: readonly Vec[] | undefined): IScratchRouteContext {
	return { boxes: context.boxes, legs: [...context.legs.filter(leg => leg.id !== id), ...(world ? legsOf(id, world) : [])] };
}

/**
 * Re-places a connector's bound ends after the elements it joins moved, resized or rotated.
 * Returns undefined when nothing changes. A binding whose element is gone is dropped and that end
 * stays where it is. Elbow connectors are re-routed end to end, around `around` when given.
 */
export function rebindConnector(el: IScratchLinearElement, lookup: (id: string) => ScratchElement | undefined, gap = SCRATCH_BINDING_GAP, around?: IScratchRouteContext): ScratchRebindPatch | undefined {
	const world = linearWorldPoints(el);
	if (world.length < 2) {
		return undefined;
	}
	const startTarget = el.startBinding ? lookup(el.startBinding.elementId) : undefined;
	const endTarget = el.endBinding ? lookup(el.endBinding.elementId) : undefined;
	const startBinding = startTarget ? el.startBinding : null;
	const endBinding = endTarget ? el.endBinding : null;
	if (!startBinding && !endBinding && !el.startBinding && !el.endBinding) {
		return undefined;
	}

	let next: Vec[];
	if (el.arrowType === 'elbow') {
		next = elbowRoute(el.id, world, startTarget, startBinding, endTarget, endBinding, gap, around);
	} else {
		next = world.slice();
		const last = next.length - 1;
		const two = next.length === 2;
		const startToward = two ? (endTarget ? elementCenter(endTarget) : world[last]) : world[1];
		const endToward = two ? (startTarget ? elementCenter(startTarget) : world[0]) : world[last - 1];
		if (startTarget && startBinding) {
			next[0] = bindingEndpoint(startTarget, startBinding, startToward, gap);
		}
		if (endTarget && endBinding) {
			next[last] = bindingEndpoint(endTarget, endBinding, endToward, gap);
		}
	}

	const sameBindings = startBinding === el.startBinding && endBinding === el.endBinding;
	if (sameBindings && el.angle === 0 && next.length === world.length && next.every((p, i) => pointsEqual(p, world[i], 1e-6))) {
		return undefined;
	}
	return { ...normalizeLinear(next), startBinding, endBinding, angle: 0 };
}

/**
 * A connector whose arrow type just changed: an elbow is routed end to end, and one leaving elbow
 * keeps only its ends (the bends were the router's, not the user's). Undefined when nothing moves.
 */
export function retypeConnector(el: IScratchLinearElement, previous: IScratchLinearElement['arrowType'], lookup: (id: string) => ScratchElement | undefined, gap = SCRATCH_BINDING_GAP, around?: IScratchRouteContext): ScratchRebindPatch | undefined {
	const world = linearWorldPoints(el);
	if (el.arrowType === previous || world.length < 2) {
		return undefined;
	}
	const first = world[0], last = world[world.length - 1];
	if (el.arrowType === 'elbow') {
		if (el.startBinding || el.endBinding) {
			return rebindConnector(el, lookup, gap, around);
		}
		return { ...normalizeLinear(routeElbow(first, undefined, last, undefined, [])), startBinding: null, endBinding: null, angle: 0 };
	}
	if (previous !== 'elbow' || world.length === 2) {
		return undefined;
	}
	const ends = { ...normalizeLinear([first, last]), angle: 0 };
	return rebindConnector({ ...el, ...ends }, lookup, gap) ?? { ...ends, startBinding: el.startBinding, endBinding: el.endBinding };
}

/** Sides of a box, as `SHAPE_PORTS` numbers them: 0 top, 1 right, 2 bottom, 3 left. */
export type ScratchSide = 0 | 1 | 2 | 3;

/**
 * The side of `box` an elbow leaves from towards `other`, like draw.io. Between two boxes that is
 * the side across the wider gap between them, so the steps of a laid-out diagram join bottom to top
 * (or side to side) instead of round a corner; towards a point (or an overlapping box) it is the
 * side the direction points through.
 */
export function facingSide(box: IScratchBounds, other: IScratchBounds): ScratchSide {
	const w = box.maxX - box.minX, h = box.maxY - box.minY;
	const ow = other.maxX - other.minX, oh = other.maxY - other.minY;
	const dx = (other.minX + other.maxX) / 2 - (box.minX + box.maxX) / 2;
	const dy = (other.minY + other.maxY) / 2 - (box.minY + box.maxY) / 2;
	const gapX = Math.abs(dx) - (w + ow) / 2;
	const gapY = Math.abs(dy) - (h + oh) / 2;
	let horizontal: boolean;
	if ((ow > 0 || oh > 0) && (gapX > 0 || gapY > 0)) {
		horizontal = gapX >= gapY;
	} else {
		const nx = w > 1e-6 ? dx / (w / 2) : 0;
		const ny = h > 1e-6 ? dy / (h / 2) : 0;
		horizontal = Math.abs(nx) >= Math.abs(ny);
	}
	return horizontal ? (dx >= 0 ? 1 : 3) : (dy >= 0 ? 2 : 0);
}

/** How far an unanchored end slides along its side to get off another line's end. */
const PORT_STEP = 24;

/**
 * Where an elbow end anchored on a side of the box sits: straight out from the outline at the
 * anchor's place along that side, pushed `gap` out. Two ends at the same place along facing sides
 * then join with a straight line, whatever the shapes (a centre ray would pull a diamond's end in).
 * Undefined for an anchor inside the box.
 */
function sideEndpoint(target: ScratchElement, anchor: ScratchPoint, gap: number): { point: Vec; dir: Vec } | undefined {
	const side = anchor[1] <= 1e-6 ? 0 : anchor[0] >= 1 - 1e-6 ? 1 : anchor[1] >= 1 - 1e-6 ? 2 : anchor[0] <= 1e-6 ? 3 : undefined;
	if (side === undefined) {
		return undefined;
	}
	const box = elementBox(target);
	const normal: Vec = side === 0 ? [0, -1] : side === 1 ? [1, 0] : side === 2 ? [0, 1] : [-1, 0];
	const local: Vec = [anchor[0] * box.width, anchor[1] * box.height];
	const reach = Math.max(box.width, box.height) + 10;
	const outside = localToWorld(target, add(local, scale(normal, reach)));
	// Towards the middle line of the box, along the side's normal.
	const inside = localToWorld(target, side === 0 || side === 2 ? [local[0], box.height / 2] : [box.width / 2, local[1]]);
	const hit = nearestOutlineHit(elementOutline(target), outside, inside);
	if (!hit) {
		return undefined;
	}
	// Out of the side it is anchored on, even where a slanted outline (a diamond's) faces more sideways.
	const out = rotate(normal, [0, 0], target.angle);
	return { point: add(hit, scale(out, gap)), dir: axisOf(out) };
}

function elbowEnd(target: ScratchElement | undefined, binding: IScratchBinding | null, free: Vec, other: IScratchBounds, gap: number, legs: readonly IScratchLeg[] = []): { point: Vec; dir: Vec | undefined } {
	if (!target || !binding) {
		return { point: free, dir: undefined };
	}
	const otherCenter: Vec = [(other.minX + other.maxX) / 2, (other.minY + other.maxY) / 2];
	if (binding.anchor) {
		const onSide = sideEndpoint(target, binding.anchor, gap);
		if (onSide) {
			return onSide;
		}
		const point = bindingEndpoint(target, binding, otherCenter, gap);
		return { point, dir: axisOf(outwardDirection(target, point)) };
	}
	// No anchor: leave from the middle of the side that faces the other end, in the target's own frame.
	const box = elementBox(target);
	const local = worldToLocal(target, otherCenter);
	const ow = other.maxX - other.minX, oh = other.maxY - other.minY;
	const side = facingSide({ minX: 0, minY: 0, maxX: box.width, maxY: box.height }, { minX: local[0] - ow / 2, minY: local[1] - oh / 2, maxX: local[0] + ow / 2, maxY: local[1] + oh / 2 });
	const at = (anchor: ScratchPoint): { point: Vec; dir: Vec } => {
		const onSide = sideEndpoint(target, anchor, gap);
		if (onSide) {
			return onSide;
		}
		const point = bindingEndpoint(target, { elementId: binding.elementId, anchor }, otherCenter, gap);
		return { point, dir: axisOf(outwardDirection(target, point)) };
	};
	let end = at(SHAPE_PORTS[side]);
	// Another line already ends there: slide along the side, towards the other end first, to a free spot.
	const stub: 0 | 1 = end.dir[0] !== 0 ? 1 : 0;
	const taken = (p: Vec) => legs.some(leg => leg.axis === stub && Math.abs(leg.at - p[stub]) < TRACK_SPACING / 2 && (Math.abs(leg.lo - p[1 - stub]) < 2 || Math.abs(leg.hi - p[1 - stub]) < 2));
	if (target.angle === 0 && taken(end.point)) {
		const alongSide = side === 0 || side === 2 ? 0 : 1;
		const length = alongSide === 0 ? box.width : box.height;
		const toward = Math.sign(local[alongSide] - length / 2) || 1;
		for (const step of [1, -1, 2, -2, 3, -3]) {
			const f = 0.5 + step * toward * PORT_STEP / Math.max(1, length);
			if (f < 0.15 || f > 0.85) {
				continue;
			}
			const candidate = at(side === 0 ? [f, 0] : side === 2 ? [f, 1] : side === 1 ? [1, f] : [0, f]);
			if (!taken(candidate.point)) {
				end = candidate;
				break;
			}
		}
	}
	return end;
}

function elbowRoute(id: string, world: readonly Vec[], startTarget: ScratchElement | undefined, startBinding: IScratchBinding | null, endTarget: ScratchElement | undefined, endBinding: IScratchBinding | null, gap: number, around: IScratchRouteContext | undefined): Vec[] {
	const first = world[0], last = world[world.length - 1];
	const startBox = startTarget && startBinding ? geometricBounds(startTarget) : undefined;
	const endBox = endTarget && endBinding ? geometricBounds(endTarget) : undefined;
	const legs = around?.legs.filter(leg => leg.id !== id) ?? [];
	const start = elbowEnd(startTarget, startBinding, first, endBox ?? boundsOfPoints([last]), gap, legs);
	const end = elbowEnd(endTarget, endBinding, last, startBox ?? boundsOfPoints([first]), gap, legs);
	const obstacles: IScratchBounds[] = [];
	if (startBox) {
		obstacles.push(startBox);
	}
	if (endBox && endTarget !== startTarget) {
		obstacles.push(endBox);
	}
	const others = around?.boxes.length ? boxesInTheWay(around.boxes, start.point, end.point, obstacles, new Set([startTarget?.id, endTarget?.id].filter((id): id is string => !!id))) : [];
	// A route that still joins the same two points cleanly (round every box, on top of no other
	// line) stays as it is: one a diagram laid out with its lines kept apart survives being placed,
	// pasted or moved as a whole.
	if (elbowStillFits(world, start, end, [...obstacles, ...others], legs)) {
		return world.slice();
	}
	return routeElbow(start.point, start.dir, end.point, end.dir, obstacles, ELBOW_MARGIN, others, legs);
}

/**
 * An elbow from `start` to `end` through `via` (a layered layout's waypoints), passing each along
 * `flow`: a long edge keeps to the lane the layout kept for it instead of the shortest way past
 * the steps it skips. `own` are the boxes of its two ends.
 */
export function routeElbowThrough(start: Vec, startDir: Vec, via: readonly Vec[], flow: Vec, end: Vec, endDir: Vec, own: readonly [IScratchBounds, IScratchBounds], others: readonly IScratchBounds[], legs: readonly IScratchLeg[] = []): Vec[] {
	const stops = [start, ...via, end];
	const out: Vec[] = [];
	for (let i = 0; i + 1 < stops.length; i++) {
		const first = i === 0, last = i + 2 === stops.length;
		const leg = routeElbow(stops[i], first ? startDir : flow, stops[i + 1], last ? endDir : [-flow[0], -flow[1]], [...(first ? [own[0]] : []), ...(last ? [own[1]] : [])], ELBOW_MARGIN, others, legs);
		out.push(...(first ? leg : leg.slice(1)));
	}
	return straightenJogs(simplifyOrthogonal(out), [...own, ...others]);
}

/** Below this, a step sideways between two lines going the same way reads as a kink, not a turn. */
const JOG = 28;

/**
 * Short sideways steps taken out: where a route steps aside a few pixels and carries on the same
 * way (a lane a little off its port), the leg before or after the step moves over to line up, if
 * that stays clear. The first and last legs stay on their ports.
 */
function straightenJogs(route: readonly Vec[], boxes: readonly IScratchBounds[]): Vec[] {
	let out = route.slice();
	const inflate = LINE_CLEARANCE - 1;
	const blocks = boxes.map(o => ({ minX: o.minX - inflate, minY: o.minY - inflate, maxX: o.maxX + inflate, maxY: o.maxY + inflate }));
	const clear = (points: readonly Vec[]) => points.every((p, i) => i === 0 || !segmentBlocked(points[i - 1], p,
		blocks.filter(b => !(i === 1 && strictlyInside(b, points[0])) && !(i === points.length - 1 && strictlyInside(b, points[points.length - 1])))));
	for (let changed = true; changed;) {
		changed = false;
		for (let i = 1; i + 2 < out.length; i++) {
			// Leg i (points i..i+1) is the step; legs i-1 and i+1 run the same way on either side of it.
			const a = out[i - 1], b = out[i], c = out[i + 1], d = out[i + 2];
			const axis = Math.abs(b[1] - c[1]) < EPS ? 0 : 1;
			if (Math.abs(b[axis] - c[axis]) >= JOG || Math.sign(b[1 - axis] - a[1 - axis]) !== Math.sign(d[1 - axis] - c[1 - axis])) {
				continue;
			}
			// Move the leg before onto the leg after's line, or the other way round; never a leg on a port.
			const tries: Vec[][] = [];
			if (i - 1 >= 1) {
				tries.push(out.map((p, k) => k === i - 1 || k === i ? (axis === 0 ? [c[0], p[1]] : [p[0], c[1]]) : p));
			}
			if (i + 2 <= out.length - 2) {
				tries.push(out.map((p, k) => k === i + 1 || k === i + 2 ? (axis === 0 ? [b[0], p[1]] : [p[0], b[1]]) : p));
			}
			const fixed = tries.map(t => simplifyOrthogonal(t)).find(t => isOrthogonal(t) && clear(t));
			if (fixed) {
				out = fixed;
				changed = true;
				break;
			}
		}
	}
	return out;
}

/** Room between lines that run side by side through one gap. */
const TRACK_SPACING = 12;
/** A track closer than this to a grid line already there is left out. */
const TRACK_SNAP = 8;
/** Two parallel lines closer than a track read as one. */
const PARALLEL_NEAR = TRACK_SPACING - 0.5;
/** How close a line may come to a box once placed (routing keeps `ELBOW_MARGIN`). */
const LINE_CLEARANCE = 10;
/** Brute force orders up to this many lines in one gap; more are sorted pairwise. */
const MAX_TRACK_PERMUTE = 6;

interface ITrackLeg {
	readonly route: number;
	/** The leg runs from point `index` to `index + 1`. */
	readonly index: number;
	/** The coordinate that is the same along the leg: 1 for a horizontal leg, 0 for a vertical one. */
	readonly axis: 0 | 1;
	readonly at: number;
	readonly lo: number;
	readonly hi: number;
	/** Where the legs before and after it join, and which way they go (+1 towards larger `axis`). */
	readonly joins: readonly { readonly pos: number; readonly way: number }[];
}

/**
 * Right-angled routes whose middle legs run on top of each other in the same gap (three lines
 * turning in the space between two rows) moved onto tracks of their own, side by side, in the
 * order that crosses least. Lines with labels (`labels`, each route's label box) get tracks far
 * enough apart for two labels. A move that would bring a line onto a box is not made.
 */
export function separateElbowLegs(routes: readonly (readonly Vec[])[], boxes: readonly IScratchBounds[], labels: readonly ({ readonly width: number; readonly height: number } | undefined)[] = []): Vec[][] {
	const out = routes.map(route => route.map((p): Vec => [p[0], p[1]]));
	const legs: ITrackLeg[] = [];
	out.forEach((route, r) => {
		// Only legs between two bends move: the first and last stay on their ports.
		for (let i = 1; i + 2 < route.length; i++) {
			const a = route[i], b = route[i + 1];
			const axis = Math.abs(a[1] - b[1]) < EPS ? 1 : 0;
			const along = 1 - axis;
			legs.push({
				route: r, index: i, axis, at: a[axis], lo: Math.min(a[along], b[along]), hi: Math.max(a[along], b[along]),
				joins: [{ pos: a[along], way: Math.sign(route[i - 1][axis] - a[axis]) }, { pos: b[along], way: Math.sign(route[i + 2][axis] - b[axis]) }],
			});
		}
	});
	// Legs on one line whose spans overlap share a gap.
	const parent = legs.map((_, i) => i);
	const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
	for (let i = 0; i < legs.length; i++) {
		for (let j = i + 1; j < legs.length; j++) {
			const a = legs[i], b = legs[j];
			// Two level lines with labels share a gap while their labels would touch.
			const la = labels[a.route], lb = labels[b.route];
			const near = la && lb && a.axis === 1 ? Math.max(PARALLEL_NEAR, Math.max(la.height, lb.height) + 3.5) : PARALLEL_NEAR;
			if (a.route !== b.route && a.axis === b.axis && Math.abs(a.at - b.at) < near && a.lo < b.hi - EPS && b.lo < a.hi - EPS) {
				parent[find(i)] = find(j);
			}
		}
	}
	const clusters = new Map<number, ITrackLeg[]>();
	legs.forEach((leg, i) => clusters.set(find(i), [...clusters.get(find(i)) ?? [], leg]));
	const inflate = LINE_CLEARANCE - 1;
	const blocks = boxes.map(o => ({ minX: o.minX - inflate, minY: o.minY - inflate, maxX: o.maxX + inflate, maxY: o.maxY + inflate }));
	for (const cluster of clusters.values()) {
		if (cluster.length < 2) {
			continue;
		}
		const order = trackOrder(cluster);
		const base = cluster.reduce((sum, leg) => sum + leg.at, 0) / cluster.length;
		// A label sits across its line: its height on a level leg, its width on an upright one.
		const labelled = cluster.map(leg => labels[leg.route]).filter((l): l is { width: number; height: number } => !!l);
		const spacing = labelled.length > 1 ? Math.max(TRACK_SPACING, ...labelled.map(l => (cluster[0].axis === 1 ? l.height : l.width) + 4)) : TRACK_SPACING;
		const before = order.map(leg => out[leg.route].map((p): Vec => [p[0], p[1]]));
		let ok = true;
		order.forEach((leg, j) => {
			const at = base + (j - (order.length - 1) / 2) * spacing;
			const route = out[leg.route];
			const move = (p: Vec): Vec => leg.axis === 0 ? [at, p[1]] : [p[0], at];
			route[leg.index] = move(route[leg.index]);
			route[leg.index + 1] = move(route[leg.index + 1]);
			// The leg and the two it joins: still clear, and the joins still run the way they did, at least a little.
			for (let s = leg.index - 1; s <= leg.index + 1 && ok; s++) {
				const a = route[s], b = route[s + 1];
				const own = blocks.filter(o => !(s === 0 && strictlyInside(o, route[0])) && !(s + 2 === route.length && strictlyInside(o, route[route.length - 1])));
				ok = segmentBlocked(a, b, own) ? false : s === leg.index || Math.sign(b[leg.axis] - a[leg.axis]) === Math.sign(before[j][s + 1][leg.axis] - before[j][s][leg.axis]) && Math.abs(b[leg.axis] - a[leg.axis]) >= 8;
			}
		});
		if (!ok) {
			order.forEach((leg, j) => { out[leg.route] = before[j]; });
		}
	}
	return out;
}

/** Lines crossing when `first` takes the track before `second` (smaller `axis` coordinate). */
function trackCrossings(first: ITrackLeg, second: ITrackLeg): number {
	const inside = (pos: number, leg: ITrackLeg) => pos > leg.lo + EPS && pos < leg.hi - EPS;
	// A join of the second line going back past the first's track, or of the first going on past the second's.
	return second.joins.filter(j => j.way < 0 && inside(j.pos, first)).length + first.joins.filter(j => j.way > 0 && inside(j.pos, second)).length;
}

/** The legs of one gap in track order (smaller coordinate first), crossing as little as possible. */
function trackOrder(legs: readonly ITrackLeg[]): ITrackLeg[] {
	const cost = (order: readonly ITrackLeg[]) => {
		let total = 0;
		for (let i = 0; i < order.length; i++) {
			for (let j = i + 1; j < order.length; j++) {
				total += trackCrossings(order[i], order[j]);
			}
		}
		return total;
	};
	if (legs.length > MAX_TRACK_PERMUTE) {
		return [...legs].sort((a, b) => trackCrossings(a, b) - trackCrossings(b, a));
	}
	let best = [...legs];
	let bestCost = cost(best);
	const permute = (done: ITrackLeg[], rest: ITrackLeg[]) => {
		if (!rest.length) {
			const c = cost(done);
			if (c < bestCost) {
				bestCost = c;
				best = done;
			}
			return;
		}
		rest.forEach((leg, i) => permute([...done, leg], [...rest.slice(0, i), ...rest.slice(i + 1)]));
	};
	permute([], [...legs]);
	return best;
}

/** Whether `route` is a right-angled path from `start` to `end`, leaving and arriving the right way, clear of every box and off every one of `legs`. */
function elbowStillFits(route: readonly Vec[], start: { point: Vec; dir: Vec | undefined }, end: { point: Vec; dir: Vec | undefined }, boxes: readonly IScratchBounds[], legs: readonly IScratchLeg[] = []): boolean {
	const last = route.length - 1;
	if (last < 1 || !isOrthogonal(route) || !pointsEqual(route[0], start.point, 0.5) || !pointsEqual(route[last], end.point, 0.5)) {
		return false;
	}
	const leaves = normalize(sub(route[1], route[0]));
	const arrives = normalize(sub(route[last - 1], route[last]));
	if ((start.dir && !pointsEqual(leaves, start.dir, 1e-3)) || (end.dir && !pointsEqual(arrives, end.dir, 1e-3))) {
		return false;
	}
	const inflate = LINE_CLEARANCE - 1;
	const blocks = boxes.map(o => ({ minX: o.minX - inflate, minY: o.minY - inflate, maxX: o.maxX + inflate, maxY: o.maxY + inflate }));
	for (let i = 1; i <= last; i++) {
		// The first and last legs start inside their own box's margin.
		const own = blocks.filter(b => !(i === 1 && strictlyInside(b, route[0])) && !(i === last && strictlyInside(b, route[last])));
		if (segmentBlocked(route[i - 1], route[i], own)) {
			return false;
		}
	}
	return routeOverlap(route, legs) < 1;
}

/**
 * The boxes near a route's ends it should go round: not its own ends, nor a box either end sits
 * in (a shape drawn behind a group, an image drawn on), nearest first.
 */
function boxesInTheWay(around: readonly IScratchObstacle[], start: Vec, end: Vec, own: readonly IScratchBounds[], skip: ReadonlySet<string>): IScratchBounds[] {
	const region = expandBounds(unionBounds([...own, boundsOfPoints([start, end])])!, ROUTE_REACH);
	const mid: Vec = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
	const contains = (b: IScratchBounds, p: Vec) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
	const hits: { bounds: IScratchBounds; distance: number }[] = [];
	for (const o of around) {
		const b = o.bounds;
		if (skip.has(o.id) || !boundsIntersect(b, region) || contains(b, start) || contains(b, end) || own.some(box => contains(b, [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2]))) {
			continue;
		}
		const dx = Math.max(b.minX - mid[0], 0, mid[0] - b.maxX);
		const dy = Math.max(b.minY - mid[1], 0, mid[1] - b.maxY);
		hits.push({ bounds: b, distance: Math.hypot(dx, dy) });
	}
	hits.sort((a, b) => a.distance - b.distance);
	return hits.slice(0, MAX_ROUTE_OBSTACLES).map(h => h.bounds);
}

// ---- Orthogonal routing ----------------------------------------------------------------------

const EPS = 1e-6;
/** Directions: 0 +x, 1 +y, 2 -x, 3 -y. */
const DIRS: readonly Vec[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const BEND_PENALTY = 200;
/** How far an elbow keeps from boxes, and how far it runs straight out of its ends before turning. */
const ELBOW_MARGIN = 24;

function dirIndex(d: Vec): number {
	if (Math.abs(d[0]) >= Math.abs(d[1])) {
		return d[0] >= 0 ? 0 : 2;
	}
	return d[1] >= 0 ? 1 : 3;
}

function strictlyInside(b: IScratchBounds, p: Vec): boolean {
	return p[0] > b.minX + EPS && p[0] < b.maxX - EPS && p[1] > b.minY + EPS && p[1] < b.maxY - EPS;
}

function segmentBlocked(a: Vec, b: Vec, obstacles: readonly IScratchBounds[]): boolean {
	for (const o of obstacles) {
		if (Math.abs(a[1] - b[1]) < EPS) {
			const y = a[1];
			if (y > o.minY + EPS && y < o.maxY - EPS && Math.max(a[0], b[0]) > o.minX + EPS && Math.min(a[0], b[0]) < o.maxX - EPS) {
				return true;
			}
		} else {
			const x = a[0];
			if (x > o.minX + EPS && x < o.maxX - EPS && Math.max(a[1], b[1]) > o.minY + EPS && Math.min(a[1], b[1]) < o.maxY - EPS) {
				return true;
			}
		}
	}
	return false;
}

/** Steps from `p` along an axis direction until it is outside every box (or the step limit). */
function leaveObstacles(p: Vec, dir: Vec, obstacles: readonly IScratchBounds[]): Vec {
	let point = p;
	for (let guard = 0; guard < obstacles.length + 1; guard++) {
		const inside = obstacles.find(o => strictlyInside(o, point));
		if (!inside) {
			break;
		}
		if (dir[0] > 0) { point = [inside.maxX, point[1]]; }
		else if (dir[0] < 0) { point = [inside.minX, point[1]]; }
		else if (dir[1] > 0) { point = [point[0], inside.maxY]; }
		else { point = [point[0], inside.minY]; }
	}
	return point;
}

function uniqueSorted(values: number[]): number[] {
	values.sort((a, b) => a - b);
	const out: number[] = [];
	for (const v of values) {
		if (!out.length || v - out[out.length - 1] > EPS) {
			out.push(v);
		}
	}
	return out;
}

/** Removes repeated points and middle points of straight runs. */
function simplifyOrthogonal(points: readonly Vec[]): Vec[] {
	const deduped: Vec[] = [];
	for (const p of points) {
		if (!deduped.length || !pointsEqual(deduped[deduped.length - 1], p, 1e-6)) {
			deduped.push(p);
		}
	}
	const out: Vec[] = [];
	for (const p of deduped) {
		if (out.length >= 2) {
			const a = out[out.length - 2], b = out[out.length - 1];
			const sameX = Math.abs(a[0] - b[0]) < EPS && Math.abs(b[0] - p[0]) < EPS;
			const sameY = Math.abs(a[1] - b[1]) < EPS && Math.abs(b[1] - p[1]) < EPS;
			if (sameX || sameY) {
				out[out.length - 1] = p;
				continue;
			}
		}
		out.push(p);
	}
	return out;
}

function isOrthogonal(points: readonly Vec[]): boolean {
	for (let i = 1; i < points.length; i++) {
		if (Math.abs(points[i][0] - points[i - 1][0]) > EPS && Math.abs(points[i][1] - points[i - 1][1]) > EPS) {
			return false;
		}
	}
	return true;
}

function fallbackRoute(start: Vec, s1: Vec, e1: Vec, end: Vec, startDir: Vec): Vec[] {
	let middle: Vec[];
	if (Math.abs(s1[0] - e1[0]) < EPS || Math.abs(s1[1] - e1[1]) < EPS) {
		middle = [];
	} else if (startDir[0] !== 0) {
		const mx = (s1[0] + e1[0]) / 2;
		middle = [[mx, s1[1]], [mx, e1[1]]];
	} else {
		const my = (s1[1] + e1[1]) / 2;
		middle = [[s1[0], my], [e1[0], my]];
	}
	return simplifyOrthogonal([start, s1, ...middle, e1, end]);
}

/**
 * A Z-shaped route (three legs) gets its middle leg in the middle of a free band between the rows
 * (or columns) of boxes it passes, nearest the middle: a layered diagram's lines turn between its
 * steps, not beside them where other lines leave a step's side. Without such a band the leg is
 * centred between the ends, the way draw.io lays out elbows; the search alone may put it at either end.
 * It moves a track or a few off any of `legs` it would run on, so two lines never read as one.
 */
function centreZ(route: Vec[], blocks: readonly IScratchBounds[], margin: number, legs: readonly IScratchLeg[] = []): Vec[] {
	if (route.length !== 4) {
		return route;
	}
	const [p0, p1, p2, p3] = route;
	const horizontalFirst = Math.abs(p0[1] - p1[1]) < EPS && Math.abs(p1[0] - p2[0]) < EPS && Math.abs(p2[1] - p3[1]) < EPS;
	const verticalFirst = Math.abs(p0[0] - p1[0]) < EPS && Math.abs(p1[1] - p2[1]) < EPS && Math.abs(p2[0] - p3[0]) < EPS;
	if (!horizontalFirst && !verticalFirst) {
		return route;
	}
	// The axis the middle leg sits on: x when it runs up or down, y when it runs across.
	const k = horizontalFirst ? 0 : 1;
	const across = 1 - k;
	if (Math.sign(p1[k] - p0[k]) !== Math.sign(p3[k] - p2[k])) {
		return route;
	}
	const lo = Math.min(p0[k], p3[k]) + margin, hi = Math.max(p0[k], p3[k]) - margin;
	if (lo > hi) {
		return route;
	}
	// Boxes level with the route (and a little past it) mark the rows; the bands between them are free.
	const spanLo = Math.min(p0[across], p3[across]) - ROUTE_REACH, spanHi = Math.max(p0[across], p3[across]) + ROUTE_REACH;
	const rows = blocks
		.filter(b => (across === 0 ? b.maxX > spanLo && b.minX < spanHi : b.maxY > spanLo && b.minY < spanHi))
		.map(b => k === 0 ? [b.minX, b.maxX] : [b.minY, b.maxY])
		.filter(([a, b]) => b > lo && a < hi)
		.sort((a, b) => a[0] - b[0]);
	const bands: number[] = [];
	let cursor = lo;
	for (const [a, b] of rows) {
		if (a > cursor) {
			bands.push((cursor + a) / 2);
		}
		cursor = Math.max(cursor, b);
	}
	if (cursor < hi) {
		bands.push((cursor + hi) / 2);
	}
	const mid = (p0[k] + p3[k]) / 2;
	bands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || Math.abs(a - p0[k]) - Math.abs(b - p0[k]));
	// The first and last legs start inside their own box's margin.
	const startClear = blocks.filter(b => !strictlyInside(b, p0));
	const endClear = blocks.filter(b => !strictlyInside(b, p3));
	const spanFrom = Math.min(p1[across], p2[across]), spanTo = Math.max(p1[across], p2[across]);
	const onALine = (v: number) => legs.some(leg => leg.axis === k && !leg.crossOnly && Math.abs(leg.at - v) < TRACK_SPACING && Math.min(leg.hi, spanTo) - Math.max(leg.lo, spanFrom) > 1);
	const nudges = [0, 1, -1, 2, -2, 3, -3].map(n => n * TRACK_SPACING);
	// Never onto more of the other lines than the search found: it may have turned early to stay off one.
	const found = routeLineCost(route, legs);
	for (const base of [...bands, mid]) {
		for (const v of nudges.map(n => base + n).filter(v => v >= lo && v <= hi && !onALine(v))) {
			const next: Vec[] = horizontalFirst ? [p0, [v, p1[1]], [v, p2[1]], p3] : [p0, [p1[0], v], [p2[0], v], p3];
			if (!segmentBlocked(next[0], next[1], startClear) && !segmentBlocked(next[1], next[2], blocks) && !segmentBlocked(next[2], next[3], endClear) && routeLineCost(next, legs) <= found) {
				return next;
			}
		}
	}
	return route;
}

/** How good a right-angled route is, lower is better: its length, its bends and the lines it runs along or crosses. */
export function elbowRouteScore(route: readonly Vec[], legs: readonly IScratchLeg[]): number {
	let length = 0;
	for (let i = 1; i < route.length; i++) {
		length += distance(route[i - 1], route[i]);
	}
	return length + Math.max(0, route.length - 2) * BEND_PENALTY + routeLineCost(route, legs);
}

/** What a route costs for the other lines it runs along or crosses (see `legCosts`). */
function routeLineCost(route: readonly Vec[], legs: readonly IScratchLeg[]): number {
	return routeOverlap(route, legs) * OVERLAP_COST + routeCrossings(route, legs) * CROSS_COST;
}

/** How far a right-angled route runs on top of (within a track of) `legs`, in pixels. */
export function routeOverlap(route: readonly Vec[], legs: readonly IScratchLeg[]): number {
	let total = 0;
	for (let i = 1; i < route.length; i++) {
		const a = route[i - 1], b = route[i];
		const axis = Math.abs(a[1] - b[1]) < EPS ? 1 : 0;
		const from = Math.min(a[1 - axis], b[1 - axis]), to = Math.max(a[1 - axis], b[1 - axis]);
		for (const leg of legs) {
			if (leg.axis === axis && !leg.crossOnly && Math.abs(leg.at - a[axis]) < PARALLEL_NEAR) {
				total += Math.max(0, Math.min(to, leg.hi) - Math.max(from, leg.lo));
			}
		}
	}
	return total;
}

/** How many times a right-angled route crosses `legs`. */
export function routeCrossings(route: readonly Vec[], legs: readonly IScratchLeg[]): number {
	let total = 0;
	for (let i = 1; i < route.length; i++) {
		const a = route[i - 1], b = route[i];
		const axis = Math.abs(a[1] - b[1]) < EPS ? 1 : 0;
		const from = Math.min(a[1 - axis], b[1 - axis]), to = Math.max(a[1 - axis], b[1 - axis]);
		for (const leg of legs) {
			if (leg.axis !== axis && leg.at > from + EPS && leg.at < to - EPS && a[axis] > leg.lo + EPS && a[axis] < leg.hi - EPS) {
				total++;
			}
		}
	}
	return total;
}

/** Cost per pixel of running along another line: 20px of it costs a bend, so a line takes a detour rather than share one. */
const OVERLAP_COST = 10;
/** Cost of crossing another line: a bend is worth about three crossings. */
const CROSS_COST = 60;
/** The nearest this many other lines count: each adds grid lines. */
const MAX_ROUTE_LEGS = 32;

/** Other lines that pass through `region`, nearest its middle first. */
function legsNear(legs: readonly IScratchLeg[], region: IScratchBounds): IScratchLeg[] {
	const mid: Vec = [(region.minX + region.maxX) / 2, (region.minY + region.maxY) / 2];
	return legs
		.filter(leg => leg.axis === 0
			? leg.at > region.minX && leg.at < region.maxX && leg.hi > region.minY && leg.lo < region.maxY
			: leg.at > region.minY && leg.at < region.maxY && leg.hi > region.minX && leg.lo < region.maxX)
		.map(leg => ({ leg, distance: Math.abs(leg.at - mid[leg.axis]) }))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, MAX_ROUTE_LEGS)
		.map(entry => entry.leg);
}

/**
 * What a step between neighbouring grid points costs for the lines it runs along or crosses.
 * The lines are sorted onto grid rows and columns once, so a step looks at a handful at most.
 */
function legCosts(legs: readonly IScratchLeg[], gx: readonly number[], gy: readonly number[]): (i: number, j: number, ni: number, nj: number) => number {
	if (!legs.length) {
		return () => 0;
	}
	const along = (values: readonly number[], axis: 0 | 1) => values.map(v => legs.filter(leg => leg.axis === axis && !leg.crossOnly && Math.abs(leg.at - v) < PARALLEL_NEAR));
	const across = (values: readonly number[], axis: 0 | 1) => values.map(v => legs.filter(leg => leg.axis !== axis && leg.lo < v - EPS && leg.hi > v + EPS));
	// Level steps run along row j (y = gy[j]); upright ones along column i.
	const rowAlong = along(gy, 1), rowAcross = across(gy, 1);
	const colAlong = along(gx, 0), colAcross = across(gx, 0);
	return (i, j, ni, nj) => {
		const level = j === nj;
		const from = level ? Math.min(gx[i], gx[ni]) : Math.min(gy[j], gy[nj]);
		const to = level ? Math.max(gx[i], gx[ni]) : Math.max(gy[j], gy[nj]);
		let total = 0;
		for (const leg of level ? rowAlong[j] : colAlong[i]) {
			total += Math.max(0, Math.min(to, leg.hi) - Math.max(from, leg.lo)) * OVERLAP_COST;
		}
		for (const leg of level ? rowAcross[j] : colAcross[i]) {
			if (leg.at >= from && leg.at < to) {
				total += CROSS_COST;
			}
		}
		return total;
	};
}

/**
 * An orthogonal route from `start` to `end` that leaves along `startDir` and arrives against
 * `endDir` (the direction pointing away from the end, out of its element), keeping `margin` clear
 * of the obstacles (the ends' own boxes) and of `others` (boxes in the way). It keeps off `legs`
 * (other lines): running along one costs like a detour and crossing one a little, and it may run
 * a track beside one. Shortest path on a sparse grid with a large penalty per bend. When `others`
 * leave no way through, the route goes round the ends' boxes only.
 */
export function routeElbow(start: Vec, startDir: Vec | undefined, end: Vec, endDir: Vec | undefined, obstacles: readonly IScratchBounds[], margin = ELBOW_MARGIN, others: readonly IScratchBounds[] = [], legs: readonly IScratchLeg[] = []): Vec[] {
	if (pointsEqual(start, end, 1e-6)) {
		return [start, end];
	}
	const sd = DIRS[dirIndex(startDir ?? sub(end, start))];
	const ed = DIRS[dirIndex(endDir ?? sub(start, end))];
	const inflate = Math.max(0, margin - 1);
	const grow = (o: IScratchBounds) => ({ minX: o.minX - inflate, minY: o.minY - inflate, maxX: o.maxX + inflate, maxY: o.maxY + inflate });
	const own = obstacles.map(grow);
	const blocks = [...own, ...others.map(grow)];
	const s1 = leaveObstacles(add(start, scale(sd, margin)), sd, own);
	const e1 = leaveObstacles(add(end, scale(ed, margin)), ed, own);
	const near = legsNear(legs, expandBounds(unionBounds([...own, boundsOfPoints([start, end])])!, ROUTE_REACH));

	const xs: number[] = [s1[0], e1[0], (s1[0] + e1[0]) / 2];
	const ys: number[] = [s1[1], e1[1], (s1[1] + e1[1]) / 2];
	for (const b of blocks) {
		xs.push(b.minX, b.maxX);
		ys.push(b.minY, b.maxY);
	}
	const xsSorted = uniqueSorted(xs.slice());
	const ysSorted = uniqueSorted(ys.slice());
	// A track either side of each line nearby, so the route can run beside it instead of on it
	// (no midpoints between tracks: they would square the grid for little).
	// A track a hair off a port's or a box's line would only add a kink of a pixel or two.
	const tracks = (axis: 0 | 1) => near.filter(leg => leg.axis === axis && !leg.crossOnly).flatMap(leg => [leg.at - TRACK_SPACING, leg.at + TRACK_SPACING])
		.filter(t => !(axis === 0 ? xsSorted : ysSorted).some(v => Math.abs(v - t) < TRACK_SNAP));
	const gx = uniqueSorted([...xsSorted, ...xsSorted.slice(1).map((x, i) => (x + xsSorted[i]) / 2), ...tracks(0)]);
	const gy = uniqueSorted([...ysSorted, ...ysSorted.slice(1).map((y, i) => (y + ysSorted[i]) / 2), ...tracks(1)]);

	const nx = gx.length, ny = gy.length;
	const indexOf = (values: number[], v: number) => values.findIndex(x => Math.abs(x - v) < EPS);
	const si = indexOf(gx, s1[0]), sj = indexOf(gy, s1[1]);
	const ei = indexOf(gx, e1[0]), ej = indexOf(gy, e1[1]);
	const valid = (i: number, j: number) => (i === si && j === sj) || (i === ei && j === ej) || !blocks.some(b => strictlyInside(b, [gx[i], gy[j]]));
	const lineCost = legCosts(near, gx, gy);

	// Dijkstra over (node, heading) states.
	const stateCount = nx * ny * 4;
	const cost = new Float64Array(stateCount).fill(Infinity);
	const prev = new Int32Array(stateCount).fill(-1);
	const done = new Uint8Array(stateCount);
	const key = (i: number, j: number, d: number) => ((j * nx + i) << 2) | d;
	const heap: number[] = [];
	const push = (k: number) => {
		heap.push(k);
		let c = heap.length - 1;
		while (c > 0) {
			const p = (c - 1) >> 1;
			if (cost[heap[p]] <= cost[heap[c]]) { break; }
			[heap[p], heap[c]] = [heap[c], heap[p]];
			c = p;
		}
	};
	const pop = (): number => {
		const top = heap[0];
		const lastItem = heap.pop()!;
		if (heap.length) {
			heap[0] = lastItem;
			let c = 0;
			for (; ;) {
				const l = c * 2 + 1, r = l + 1;
				let m = c;
				if (l < heap.length && cost[heap[l]] < cost[heap[m]]) { m = l; }
				if (r < heap.length && cost[heap[r]] < cost[heap[m]]) { m = r; }
				if (m === c) { break; }
				[heap[m], heap[c]] = [heap[c], heap[m]];
				c = m;
			}
		}
		return top;
	};

	let best = -1;
	let bestCost = Infinity;
	if (si >= 0 && sj >= 0 && ei >= 0 && ej >= 0) {
		const startState = key(si, sj, dirIndex(sd));
		cost[startState] = 0;
		push(startState);
		const arrive = dirIndex([-ed[0], -ed[1]]);
		while (heap.length) {
			const k = pop();
			if (done[k]) { continue; }
			done[k] = 1;
			const d = k & 3;
			const node = k >> 2;
			const i = node % nx, j = Math.floor(node / nx);
			if (i === ei && j === ej) {
				// The last leg runs from e1 to the end against endDir; a reversal there is not allowed.
				const extra = d === arrive ? 0 : d === dirIndex(ed) ? Infinity : BEND_PENALTY;
				if (cost[k] + extra < bestCost) {
					bestCost = cost[k] + extra;
					best = k;
				}
				continue;
			}
			if (cost[k] >= bestCost) {
				continue;
			}
			for (let nd = 0; nd < 4; nd++) {
				if (nd === ((d + 2) & 3)) {
					continue;
				}
				const ni = i + (nd === 0 ? 1 : nd === 2 ? -1 : 0);
				const nj = j + (nd === 1 ? 1 : nd === 3 ? -1 : 0);
				if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || !valid(ni, nj)) {
					continue;
				}
				const a: Vec = [gx[i], gy[j]], b: Vec = [gx[ni], gy[nj]];
				if (segmentBlocked(a, b, blocks)) {
					continue;
				}
				const nk = key(ni, nj, nd);
				const c = cost[k] + distance(a, b) + (nd === d ? 0 : BEND_PENALTY) + lineCost(i, j, ni, nj);
				if (c < cost[nk]) {
					cost[nk] = c;
					prev[nk] = k;
					push(nk);
				}
			}
		}
	}

	if (best < 0) {
		return others.length ? routeElbow(start, startDir, end, endDir, obstacles, margin, [], legs) : fallbackRoute(start, s1, e1, end, sd);
	}
	const path: Vec[] = [];
	for (let k = best; k >= 0; k = prev[k]) {
		const node = k >> 2;
		path.push([gx[node % nx], gy[Math.floor(node / nx)]]);
	}
	path.reverse();
	const route = centreZ(simplifyOrthogonal([start, ...path, end]), blocks, margin, legs);
	return isOrthogonal(route) ? route : others.length ? routeElbow(start, startDir, end, endDir, obstacles, margin, [], legs) : fallbackRoute(start, s1, e1, end, sd);
}

