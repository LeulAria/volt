/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	boundsContain, boundsContainPoint, boundsIntersect, boundsOfPoints, catmullRomSegments, distance, distanceToPolyline,
	distanceToSegment, expandBounds, pointInPolygon, rotate, sampleCubics, segmentsIntersect, unionBounds, Vec,
} from './scratchMath.js';
import { shapeGeometry } from './scratchShapes.js';
import { IScratchBounds, IScratchDrawElement, IScratchFrameElement, IScratchLinearElement, ScratchElement } from './scratchTypes.js';

/**
 * Where elements are and what a point or a drag touches. World coordinates throughout; an
 * element's box rotates by `angle` around its centre. Elements are immutable, so derived
 * outlines are cached per element object.
 */

/** An element's box before rotation, in world coordinates. */
export interface IElementBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Height of the name tab drawn above a frame. */
export const FRAME_TAB_HEIGHT = 24;
const FRAME_TAB_MAX_WIDTH = 200;

const boxCache = new WeakMap<ScratchElement, IElementBox>();
const outlineCache = new WeakMap<ScratchElement, Vec[]>();
const polylineCache = new WeakMap<ScratchElement, Vec[]>();
const geometricBoundsCache = new WeakMap<ScratchElement, IScratchBounds>();

function isPointElement(el: ScratchElement): el is IScratchLinearElement | IScratchDrawElement {
	return el.type === 'line' || el.type === 'arrow' || el.type === 'draw';
}

export function elementBox(el: ScratchElement): IElementBox {
	let box = boxCache.get(el);
	if (!box) {
		if (isPointElement(el)) {
			const b = boundsOfPoints(el.points as readonly Vec[]);
			box = { x: el.x + b.minX, y: el.y + b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
		} else {
			const w = el.width, h = el.height;
			box = { x: w < 0 ? el.x + w : el.x, y: h < 0 ? el.y + h : el.y, width: Math.abs(w), height: Math.abs(h) };
		}
		boxCache.set(el, box);
	}
	return box;
}

export function elementCenter(el: ScratchElement): Vec {
	const box = elementBox(el);
	return [box.x + box.width / 2, box.y + box.height / 2];
}

/** Into the unrotated box, with the origin at its top-left corner. */
export function worldToLocal(el: ScratchElement, p: Vec): Vec {
	const box = elementBox(el);
	const unrotated = rotate(p, [box.x + box.width / 2, box.y + box.height / 2], -el.angle);
	return [unrotated[0] - box.x, unrotated[1] - box.y];
}

export function localToWorld(el: ScratchElement, p: Vec): Vec {
	const box = elementBox(el);
	return rotate([box.x + p[0], box.y + p[1]], [box.x + box.width / 2, box.y + box.height / 2], el.angle);
}

/** The four rotated corners: top-left, top-right, bottom-right, bottom-left. */
export function elementCorners(el: ScratchElement): Vec[] {
	const box = elementBox(el);
	return [
		localToWorld(el, [0, 0]),
		localToWorld(el, [box.width, 0]),
		localToWorld(el, [box.width, box.height]),
		localToWorld(el, [0, box.height]),
	];
}

/** Points of a connector or a stroke in world coordinates, as stored (no curve sampling). */
export function linearWorldPoints(el: IScratchLinearElement | IScratchDrawElement): Vec[] {
	const box = elementBox(el);
	const center: Vec = [box.x + box.width / 2, box.y + box.height / 2];
	return el.points.map(p => rotate([el.x + p[0], el.y + p[1]], center, el.angle));
}

/** The connector as drawn: round connectors follow a Catmull-Rom curve through their points. */
export function linearHitPolyline(el: IScratchLinearElement): Vec[] {
	let poly = polylineCache.get(el);
	if (!poly) {
		const world = linearWorldPoints(el);
		if (el.arrowType === 'round' && world.length > 2) {
			const through = el.closed ? [...world, world[0]] : world;
			poly = sampleCubics(catmullRomSegments(through), 10);
		} else {
			poly = el.closed && world.length > 2 ? [...world, world[0]] : world;
		}
		polylineCache.set(el, poly);
	}
	return poly;
}

/** Closed outline in world coordinates. Open connectors and strokes give their rotated box. */
export function elementOutline(el: ScratchElement): Vec[] {
	let outline = outlineCache.get(el);
	if (!outline) {
		if (el.type === 'shape') {
			const box = elementBox(el);
			outline = shapeGeometry(el.shape, box.width, box.height, el.roundness).outline.map(p => localToWorld(el, p));
		} else if ((el.type === 'line' || el.type === 'arrow') && el.closed && el.points.length > 2) {
			const poly = linearHitPolyline(el);
			outline = poly.slice(0, poly.length - 1);
		} else {
			outline = elementCorners(el);
		}
		outlineCache.set(el, outline);
	}
	return outline;
}

/** Axis-aligned bounds of what is drawn, without stroke padding. Selection boxes and alignment use this. */
export function geometricBounds(el: ScratchElement): IScratchBounds {
	let bounds = geometricBoundsCache.get(el);
	if (!bounds) {
		if (el.type === 'line' || el.type === 'arrow') {
			bounds = boundsOfPoints(linearHitPolyline(el));
		} else if (el.type === 'draw') {
			bounds = boundsOfPoints(linearWorldPoints(el));
		} else if (el.type === 'shape') {
			bounds = boundsOfPoints(elementOutline(el));
		} else {
			bounds = boundsOfPoints(elementCorners(el));
		}
		geometricBoundsCache.set(el, bounds);
	}
	return bounds;
}

function hasArrowheads(el: ScratchElement): boolean {
	return (el.type === 'arrow' || el.type === 'line') && (el.startArrowhead !== 'none' || el.endArrowhead !== 'none');
}

/** Half the drawn thickness of a freehand stroke (see scratchFreehand: pen and highlighter sizes). */
function drawHalfWidth(el: IScratchDrawElement): number {
	return el.pen === 'highlighter' ? el.strokeWidth * 3.5 + 3 : el.strokeWidth * 2.2;
}

/**
 * Bounds of everything an element paints: stroke, hand-drawn wobble, arrowheads and a frame's
 * name tab. Culling uses it, so it errs on the large side.
 */
export function elementBounds(el: ScratchElement): IScratchBounds {
	const geometric = geometricBounds(el);
	let pad = el.strokeWidth / 2 + 1;
	if (el.type === 'shape' || el.type === 'line' || el.type === 'arrow') {
		pad += el.roughness * 3;
	}
	if (hasArrowheads(el)) {
		pad += el.strokeWidth * 4 + 12;
	}
	if (el.type === 'draw') {
		pad = drawHalfWidth(el) + 2;
	}
	let bounds = expandBounds(geometric, pad);
	if (el.type === 'frame') {
		const tab = frameTabPolygon(el);
		bounds = unionBounds([bounds, boundsOfPoints(tab)])!;
	}
	return bounds;
}

/** Room between a container frame's outline and its header row. */
export const FRAME_HEADER_INSET_X = 20;
export const FRAME_HEADER_INSET_Y = 16;

/** How tall a container frame's header strip is (its handle, like a plain frame's tab), insets included. */
export function frameHeaderHeight(el: IScratchFrameElement): number {
	const header = el.header;
	if (!header) {
		return 0;
	}
	return FRAME_HEADER_INSET_Y * 2 + Math.max(header.icon?.size ?? 0, header.fontSize * 1.25);
}

/** The frame's name tab: a strip above the top edge (a container's header strip inside it), in world coordinates. */
function frameTabPolygon(el: ScratchElement): Vec[] {
	const box = elementBox(el);
	if (el.type === 'frame' && el.header) {
		const h = Math.min(box.height, frameHeaderHeight(el));
		return [localToWorld(el, [0, 0]), localToWorld(el, [box.width, 0]), localToWorld(el, [box.width, h]), localToWorld(el, [0, h])];
	}
	const w = Math.min(box.width, FRAME_TAB_MAX_WIDTH);
	return [
		localToWorld(el, [0, -FRAME_TAB_HEIGHT]),
		localToWorld(el, [w, -FRAME_TAB_HEIGHT]),
		localToWorld(el, [w, 0]),
		localToWorld(el, [0, 0]),
	];
}

function insideLocalBox(el: ScratchElement, p: Vec, margin: number): boolean {
	const box = elementBox(el);
	const local = worldToLocal(el, p);
	return local[0] >= -margin && local[0] <= box.width + margin && local[1] >= -margin && local[1] <= box.height + margin;
}

/** Whether `p` touches the element. `tolerance` is in world units (screen slop divided by zoom). */
export function hitTestElement(el: ScratchElement, p: Vec, tolerance: number, selected: boolean): boolean {
	switch (el.type) {
		case 'shape': {
			const outline = elementOutline(el);
			if (distanceToPolyline(p, outline, true) <= tolerance + el.strokeWidth / 2) {
				return true;
			}
			return (el.fill !== 'transparent' || !!el.label || selected) && pointInPolygon(p, outline);
		}
		case 'line':
		case 'arrow': {
			const poly = linearHitPolyline(el);
			if (distanceToPolyline(p, poly) <= tolerance + el.strokeWidth / 2) {
				return true;
			}
			return el.closed && el.fill !== 'transparent' && poly.length > 2 && pointInPolygon(p, poly);
		}
		case 'draw': {
			const points = linearWorldPoints(el);
			return distanceToPolyline(p, points) <= tolerance + drawHalfWidth(el);
		}
		case 'frame': {
			if (pointInPolygon(p, frameTabPolygon(el))) {
				return true;
			}
			const outline = elementOutline(el);
			if (distanceToPolyline(p, outline, true) <= tolerance + el.strokeWidth / 2) {
				return true;
			}
			return selected && insideLocalBox(el, p, 0);
		}
		default:
			return insideLocalBox(el, p, tolerance);
	}
}

/** A closed outline counts as solid inside (a marquee or eraser inside it touches it). */
function isSolid(el: ScratchElement): boolean {
	switch (el.type) {
		case 'shape': return el.fill !== 'transparent' || !!el.label;
		case 'line':
		case 'arrow': return el.closed && el.fill !== 'transparent';
		case 'text':
		case 'note':
		case 'card':
		case 'image':
		case 'icon': return true;
		default: return false;
	}
}

/** The segments to test against for intersections: a closed outline or an open polyline. */
function hitSegments(el: ScratchElement): { readonly points: Vec[]; readonly closed: boolean } {
	switch (el.type) {
		case 'line':
		case 'arrow': return { points: linearHitPolyline(el), closed: false };
		case 'draw': return { points: linearWorldPoints(el), closed: false };
		default: return { points: elementOutline(el), closed: true };
	}
}

function marqueePolygon(m: IScratchBounds): Vec[] {
	return [[m.minX, m.minY], [m.maxX, m.minY], [m.maxX, m.maxY], [m.minX, m.maxY]];
}

function polylineTouchesBox(points: readonly Vec[], closed: boolean, box: IScratchBounds): boolean {
	for (const p of points) {
		if (boundsContainPoint(box, p)) {
			return true;
		}
	}
	const rect = marqueePolygon(box);
	const count = closed ? points.length : points.length - 1;
	for (let i = 0; i < count; i++) {
		const a = points[i], b = points[(i + 1) % points.length];
		for (let j = 0; j < 4; j++) {
			if (segmentsIntersect(a, b, rect[j], rect[(j + 1) % 4])) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Elements a marquee selects: `contain` wants the drawn bounds fully inside, `intersect` any
 * touch. A marquee drawn inside an empty shape or frame does not touch it.
 */
export function elementsInMarquee(elements: readonly ScratchElement[], marquee: IScratchBounds, mode: 'contain' | 'intersect'): ScratchElement[] {
	const out: ScratchElement[] = [];
	for (const el of elements) {
		const bounds = geometricBounds(el);
		if (mode === 'contain') {
			if (boundsContain(marquee, bounds)) {
				out.push(el);
			}
			continue;
		}
		if (!boundsIntersect(marquee, bounds)) {
			continue;
		}
		const { points, closed } = hitSegments(el);
		if (points.length === 1 ? boundsContainPoint(marquee, points[0]) : polylineTouchesBox(points, closed, marquee)) {
			out.push(el);
			continue;
		}
		if (closed && isSolid(el) && pointInPolygon([marquee.minX, marquee.minY], points)) {
			out.push(el);
		}
	}
	return out;
}

function segmentToSegmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
	if (segmentsIntersect(a, b, c, d)) {
		return 0;
	}
	return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

/** Whether the segment a→b (an eraser stroke) touches the element. */
export function elementIntersectsSegment(el: ScratchElement, a: Vec, b: Vec, tolerance: number): boolean {
	const reach = tolerance + (el.type === 'draw' ? drawHalfWidth(el) : el.strokeWidth / 2);
	const segBounds = expandBounds(boundsOfPoints([a, b]), reach);
	if (!boundsIntersect(segBounds, elementBounds(el))) {
		return false;
	}
	if (el.type === 'frame') {
		const tab = frameTabPolygon(el);
		if (pointInPolygon(a, tab) || pointInPolygon(b, tab)) {
			return true;
		}
	}
	const { points, closed } = hitSegments(el);
	if (points.length === 1) {
		return distanceToSegment(points[0], a, b) <= reach;
	}
	const count = closed ? points.length : points.length - 1;
	for (let i = 0; i < count; i++) {
		if (segmentToSegmentDistance(a, b, points[i], points[(i + 1) % points.length]) <= reach) {
			return true;
		}
	}
	return closed && isSolid(el) && (pointInPolygon(a, points) || pointInPolygon(b, points));
}

/**
 * The element under the pointer: the last (topmost) hit, skipping locked ones. A selected element
 * hit inside the selection's box wins over anything above it, so a selection can be dragged.
 */
export function topmostHit(elements: readonly ScratchElement[], p: Vec, tolerance: number, selectedIds: ReadonlySet<string>): ScratchElement | undefined {
	if (selectedIds.size) {
		const selected = elements.filter(el => selectedIds.has(el.id) && !el.locked);
		const box = unionBounds(selected.map(geometricBounds));
		if (box && boundsContainPoint(expandBounds(box, tolerance), p)) {
			for (let i = selected.length - 1; i >= 0; i--) {
				if (hitTestElement(selected[i], p, tolerance, true)) {
					return selected[i];
				}
			}
		}
	}
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i];
		if (el.locked || !boundsContainPoint(expandBounds(elementBounds(el), tolerance), p)) {
			continue;
		}
		if (hitTestElement(el, p, tolerance, selectedIds.has(el.id))) {
			return el;
		}
	}
	return undefined;
}

/** Distance from a point to the element's outline (or polyline). */
export function distanceToElementOutline(el: ScratchElement, p: Vec): number {
	const { points, closed } = hitSegments(el);
	return points.length === 1 ? distance(p, points[0]) : distanceToPolyline(p, points, closed);
}

/** `ids` and everything inside the frames among them, frames in frames included (mutates and returns `ids`). */
export function withFrameContents(elements: readonly ScratchElement[], ids: Set<string>): Set<string> {
	for (let grew = true; grew;) {
		grew = false;
		for (const el of elements) {
			if (el.frameId && ids.has(el.frameId) && !ids.has(el.id)) {
				ids.add(el.id);
				grew = true;
			}
		}
	}
	return ids;
}
