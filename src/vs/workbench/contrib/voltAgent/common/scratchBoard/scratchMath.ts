/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IScratchBounds, IScratchRect, ScratchPoint } from './scratchTypes.js';

export type Vec = readonly [number, number];

export function add(a: Vec, b: Vec): Vec { return [a[0] + b[0], a[1] + b[1]]; }
export function sub(a: Vec, b: Vec): Vec { return [a[0] - b[0], a[1] - b[1]]; }
export function scale(a: Vec, s: number): Vec { return [a[0] * s, a[1] * s]; }
export function dot(a: Vec, b: Vec): number { return a[0] * b[0] + a[1] * b[1]; }
export function cross(a: Vec, b: Vec): number { return a[0] * b[1] - a[1] * b[0]; }
export function length(a: Vec): number { return Math.hypot(a[0], a[1]); }
export function distance(a: Vec, b: Vec): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
export function distanceSq(a: Vec, b: Vec): number { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }
export function lerp(a: Vec, b: Vec, t: number): Vec { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
export function midpoint(a: Vec, b: Vec): Vec { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
export function normalize(a: Vec): Vec { const l = length(a); return l > 1e-9 ? [a[0] / l, a[1] / l] : [0, 0]; }
/** Perpendicular, turned a quarter clockwise on screen (y down). */
export function perpendicular(a: Vec): Vec { return [-a[1], a[0]]; }
export function clamp(value: number, min: number, max: number): number { return value < min ? min : value > max ? max : value; }
export function pointsEqual(a: Vec, b: Vec, epsilon = 1e-6): boolean { return Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon; }

export function rotate(point: Vec, center: Vec, angle: number): Vec {
	if (!angle) {
		return point;
	}
	const cos = Math.cos(angle), sin = Math.sin(angle);
	const dx = point[0] - center[0], dy = point[1] - center[1];
	return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
}

/** Angle normalised to [0, 2*pi). */
export function normalizeAngle(angle: number): number {
	const full = Math.PI * 2;
	const a = angle % full;
	return a < 0 ? a + full : a;
}

export function rectCenter(rect: IScratchRect): Vec {
	return [rect.x + rect.width / 2, rect.y + rect.height / 2];
}

export function boundsOfPoints(points: readonly Vec[]): IScratchBounds {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) { minX = x; }
		if (y < minY) { minY = y; }
		if (x > maxX) { maxX = x; }
		if (y > maxY) { maxY = y; }
	}
	if (minX === Infinity) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}
	return { minX, minY, maxX, maxY };
}

export function unionBounds(bounds: readonly IScratchBounds[]): IScratchBounds | undefined {
	if (!bounds.length) {
		return undefined;
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const b of bounds) {
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	return { minX, minY, maxX, maxY };
}

export function boundsToRect(b: IScratchBounds): IScratchRect {
	return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

export function rectToBounds(r: IScratchRect): IScratchBounds {
	return { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
}

export function expandBounds(b: IScratchBounds, by: number): IScratchBounds {
	return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

export function boundsIntersect(a: IScratchBounds, b: IScratchBounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Whether segment a-b enters `box` (Liang-Barsky clipping). */
export function segmentEntersBounds(a: Vec, b: Vec, box: IScratchBounds): boolean {
	let t0 = 0, t1 = 1;
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const edges: [number, number][] = [[-dx, a[0] - box.minX], [dx, box.maxX - a[0]], [-dy, a[1] - box.minY], [dy, box.maxY - a[1]]];
	for (const [p, q] of edges) {
		if (Math.abs(p) < 1e-9) {
			if (q < 0) {
				return false;
			}
			continue;
		}
		const t = q / p;
		if (p < 0) {
			t0 = Math.max(t0, t);
		} else {
			t1 = Math.min(t1, t);
		}
		if (t0 > t1) {
			return false;
		}
	}
	return true;
}

/** `inner` lies entirely inside `outer`. */
export function boundsContain(outer: IScratchBounds, inner: IScratchBounds): boolean {
	return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function boundsContainPoint(b: IScratchBounds, p: Vec): boolean {
	return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
}

export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
	const abx = b[0] - a[0], aby = b[1] - a[1];
	const lenSq = abx * abx + aby * aby;
	if (lenSq < 1e-12) {
		return distance(p, a);
	}
	const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq, 0, 1);
	return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/** Closest point on segment ab to p, and its parameter t in [0, 1]. */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number } {
	const abx = b[0] - a[0], aby = b[1] - a[1];
	const lenSq = abx * abx + aby * aby;
	if (lenSq < 1e-12) {
		return { point: a, t: 0 };
	}
	const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq, 0, 1);
	return { point: [a[0] + abx * t, a[1] + aby * t], t };
}

export function distanceToPolyline(p: Vec, points: readonly Vec[], closed = false): number {
	if (points.length === 0) {
		return Infinity;
	}
	if (points.length === 1) {
		return distance(p, points[0]);
	}
	let best = Infinity;
	for (let i = 1; i < points.length; i++) {
		best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]));
	}
	if (closed) {
		best = Math.min(best, distanceToSegment(p, points[points.length - 1], points[0]));
	}
	return best;
}

/** Even-odd test. */
export function pointInPolygon(p: Vec, polygon: readonly Vec[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i];
		const [xj, yj] = polygon[j];
		if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) {
			inside = !inside;
		}
	}
	return inside;
}

/** Intersection of segments p1p2 and p3p4, with t along p1p2, or undefined. */
export function segmentIntersection(p1: Vec, p2: Vec, p3: Vec, p4: Vec): { point: Vec; t: number } | undefined {
	const d1 = sub(p2, p1);
	const d2 = sub(p4, p3);
	const denom = cross(d1, d2);
	if (Math.abs(denom) < 1e-12) {
		return undefined;
	}
	const diff = sub(p3, p1);
	const t = cross(diff, d2) / denom;
	const u = cross(diff, d1) / denom;
	if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) {
		return undefined;
	}
	return { point: [p1[0] + d1[0] * t, p1[1] + d1[1] * t], t };
}

export function segmentsIntersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): boolean {
	return segmentIntersection(p1, p2, p3, p4) !== undefined;
}

export function polylineLength(points: readonly Vec[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += distance(points[i - 1], points[i]);
	}
	return total;
}

/** The point at `fraction` of the polyline's length, and the direction of the segment it is on. */
export function pointAlongPolyline(points: readonly Vec[], fraction: number): { point: Vec; direction: Vec } {
	if (points.length === 0) {
		return { point: [0, 0], direction: [1, 0] };
	}
	if (points.length === 1) {
		return { point: points[0], direction: [1, 0] };
	}
	const total = polylineLength(points);
	let remaining = clamp(fraction, 0, 1) * total;
	for (let i = 1; i < points.length; i++) {
		const segment = distance(points[i - 1], points[i]);
		if (remaining <= segment || i === points.length - 1) {
			const t = segment > 0 ? clamp(remaining / segment, 0, 1) : 0;
			return { point: lerp(points[i - 1], points[i], t), direction: normalize(sub(points[i], points[i - 1])) };
		}
		remaining -= segment;
	}
	return { point: points[points.length - 1], direction: [1, 0] };
}

export function cubicPoint(p0: Vec, c1: Vec, c2: Vec, p1: Vec, t: number): Vec {
	const mt = 1 - t;
	const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
	return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

/** One cubic segment of a Catmull-Rom spline through `points` (tension 0.5), per span. */
export interface ICubicSegment {
	readonly from: Vec;
	readonly c1: Vec;
	readonly c2: Vec;
	readonly to: Vec;
}

/** Smooth curve through every point: a Catmull-Rom spline as cubic Beziers. */
export function catmullRomSegments(points: readonly Vec[], tension = 0.5): ICubicSegment[] {
	const segments: ICubicSegment[] = [];
	if (points.length < 2) {
		return segments;
	}
	const k = tension / 3 * 2; // 1/3 of the tangent, scaled by tension (0.5 → classic Catmull-Rom).
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i - 1] ?? points[i];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[i + 2] ?? p2;
		segments.push({
			from: p1,
			c1: [p1[0] + (p2[0] - p0[0]) * k / 2, p1[1] + (p2[1] - p0[1]) * k / 2],
			c2: [p2[0] - (p3[0] - p1[0]) * k / 2, p2[1] - (p3[1] - p1[1]) * k / 2],
			to: p2,
		});
	}
	return segments;
}

/** Samples a list of cubic segments into a polyline (for hit tests and bounds). */
export function sampleCubics(segments: readonly ICubicSegment[], stepsPerSegment = 12): Vec[] {
	const out: Vec[] = [];
	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];
		for (let i = s === 0 ? 0 : 1; i <= stepsPerSegment; i++) {
			out.push(cubicPoint(seg.from, seg.c1, seg.c2, seg.to, i / stepsPerSegment));
		}
	}
	return out;
}

/** Deterministic PRNG (mulberry32) so a seed always draws the same wobble. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function randomSeed(): number {
	return Math.floor(Math.random() * 2 ** 31);
}

export function toPoint(v: Vec): ScratchPoint {
	return [v[0], v[1]];
}

/** Rounds for compact JSON and SVG without visible loss. */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** SVG number: two decimals, no trailing zeros, never `-0`. */
export function svgNum(value: number): string {
	const r = Math.round(value * 100) / 100;
	return Object.is(r, -0) ? '0' : String(r);
}
