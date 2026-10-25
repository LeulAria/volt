/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { svgNum, Vec } from './scratchMath.js';
import type { IScratchDrawElement, ScratchPressurePoint } from './scratchTypes.js';

/**
 * Pen strokes: a port of perfect-freehand v1. A stroke is drawn as a filled outline whose width
 * follows pen pressure (or speed, for a mouse), with round caps and smoothed corners.
 */

export interface IFreehandOptions {
	readonly size: number;
	readonly thinning: number;
	readonly smoothing: number;
	readonly streamline: number;
	readonly simulatePressure: boolean;
	/** The stroke is finished, so its last point is drawn exactly where it was put down. */
	readonly last: boolean;
	readonly easing?: (t: number) => number;
	readonly taperStart?: number;
	readonly taperEnd?: number;
	readonly capStart?: boolean;
	readonly capEnd?: boolean;
}

interface IStrokePoint {
	readonly point: Vec;
	readonly pressure: number;
	readonly vector: Vec;
	readonly distance: number;
	readonly runningLength: number;
}

const RATE_OF_PRESSURE_CHANGE = 0.275;
const FIXED_PI = Math.PI + 0.0001;

const vAdd = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const vSub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const vMul = (a: Vec, n: number): Vec => [a[0] * n, a[1] * n];
const vNeg = (a: Vec): Vec => [-a[0], -a[1]];
const vPer = (a: Vec): Vec => [a[1], -a[0]];
const vDpr = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1];
const vLen = (a: Vec): number => Math.hypot(a[0], a[1]);
const vDist = (a: Vec, b: Vec): number => Math.hypot(a[1] - b[1], a[0] - b[0]);
const vDist2 = (a: Vec, b: Vec): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const vUni = (a: Vec): Vec => { const l = vLen(a); return l === 0 ? [0, 0] : [a[0] / l, a[1] / l]; };
const vLrp = (a: Vec, b: Vec, t: number): Vec => vAdd(a, vMul(vSub(b, a), t));
const vPrj = (a: Vec, b: Vec, c: number): Vec => vAdd(a, vMul(b, c));
const vIsEqual = (a: Vec, b: Vec): boolean => a[0] === b[0] && a[1] === b[1];

function vRotAround(a: Vec, c: Vec, r: number): Vec {
	const s = Math.sin(r), co = Math.cos(r);
	const px = a[0] - c[0], py = a[1] - c[1];
	return [px * co - py * s + c[0], px * s + py * co + c[1]];
}

function strokeRadius(size: number, thinning: number, pressure: number, easing: (t: number) => number = t => t): number {
	return size * easing(0.5 - thinning * (0.5 - pressure));
}

function strokePoints(input: readonly ScratchPressurePoint[], options: IFreehandOptions): IStrokePoint[] {
	const { streamline, size, last: isComplete } = options;
	if (input.length === 0) {
		return [];
	}
	const t = 0.15 + (1 - streamline) * 0.85;
	let pts: ScratchPressurePoint[] = input.slice();
	// Two points become a short line of five, so the outline has room for its caps.
	if (pts.length === 2) {
		const last = pts[1];
		pts = pts.slice(0, -1);
		for (let i = 1; i < 5; i++) {
			const p = vLrp([pts[0][0], pts[0][1]], [last[0], last[1]], i / 4);
			pts.push([p[0], p[1], last[2]]);
		}
	}
	if (pts.length === 1) {
		pts = [...pts, [pts[0][0] + 1, pts[0][1] + 1, pts[0][2]]];
	}
	const out: IStrokePoint[] = [{
		point: [pts[0][0], pts[0][1]],
		pressure: pts[0][2] >= 0 ? pts[0][2] : 0.25,
		vector: [1, 1],
		distance: 0,
		runningLength: 0,
	}];
	let hasReachedMinimumLength = false;
	let runningLength = 0;
	let prev = out[0];
	const max = pts.length - 1;
	for (let i = 1; i < pts.length; i++) {
		const target: Vec = [pts[i][0], pts[i][1]];
		const point = isComplete && i === max ? target : vLrp(prev.point, target, t);
		if (vIsEqual(prev.point, point)) {
			continue;
		}
		const distance = vDist(point, prev.point);
		runningLength += distance;
		if (i < max && !hasReachedMinimumLength) {
			if (runningLength < size) {
				continue;
			}
			hasReachedMinimumLength = true;
		}
		prev = { point, pressure: pts[i][2] >= 0 ? pts[i][2] : 0.5, vector: vUni(vSub(prev.point, point)), distance, runningLength };
		out.push(prev);
	}
	out[0] = { ...out[0], vector: out[1]?.vector ?? [0, 0] };
	return out;
}

function outlinePoints(points: readonly IStrokePoint[], options: IFreehandOptions): Vec[] {
	const { size, smoothing, thinning, simulatePressure, last: isComplete } = options;
	const easing = options.easing ?? (t => t);
	const capStart = options.capStart ?? true;
	const capEnd = options.capEnd ?? true;
	const taperStartEase = (t: number) => t * (2 - t);
	const taperEndEase = (t: number) => --t * t * t + 1;
	if (points.length === 0 || size <= 0) {
		return [];
	}
	const totalLength = points[points.length - 1].runningLength;
	const taperStart = options.taperStart ?? 0;
	const taperEnd = options.taperEnd ?? 0;
	const minDistance = (size * smoothing) ** 2;
	const leftPts: Vec[] = [];
	const rightPts: Vec[] = [];

	let prevPressure = points.slice(0, 10).reduce((acc, curr) => {
		let pressure = curr.pressure;
		if (simulatePressure) {
			const sp = Math.min(1, curr.distance / size);
			const rp = Math.min(1, 1 - sp);
			pressure = Math.min(1, acc + (rp - acc) * (sp * RATE_OF_PRESSURE_CHANGE));
		}
		return (acc + pressure) / 2;
	}, points[0].pressure);

	let radius = strokeRadius(size, thinning, points[points.length - 1].pressure, easing);
	let firstRadius: number | undefined;
	let prevVector = points[0].vector;
	let pl = points[0].point;
	let pr = pl;
	let tl = pl;
	let tr = pr;
	let isPrevPointSharpCorner = false;

	for (let i = 0; i < points.length; i++) {
		let { pressure } = points[i];
		const { point, vector, distance, runningLength } = points[i];
		// The last few pixels make a messy end; skip them.
		if (i < points.length - 1 && totalLength - runningLength < 3) {
			continue;
		}
		if (thinning) {
			if (simulatePressure) {
				const sp = Math.min(1, distance / size);
				const rp = Math.min(1, 1 - sp);
				pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
			}
			radius = strokeRadius(size, thinning, pressure, easing);
		} else {
			radius = size / 2;
		}
		if (firstRadius === undefined) {
			firstRadius = radius;
		}
		const ts = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;
		const te = totalLength - runningLength < taperEnd ? taperEndEase((totalLength - runningLength) / taperEnd) : 1;
		radius = Math.max(0.01, radius * Math.min(ts, te));

		const nextVector = (i < points.length - 1 ? points[i + 1] : points[i]).vector;
		const nextDpr = i < points.length - 1 ? vDpr(vector, nextVector) : 1.0;
		const prevDpr = vDpr(vector, prevVector);
		const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
		const isNextPointSharpCorner = nextDpr < 0;

		if (isPointSharpCorner || isNextPointSharpCorner) {
			// Sharp turn: draw a half circle around the corner.
			const off = vMul(vPer(prevVector), radius);
			for (let step = 1 / 13, t = 0; t <= 1; t += step) {
				tl = vRotAround(vSub(point, off), point, FIXED_PI * t);
				leftPts.push(tl);
				tr = vRotAround(vAdd(point, off), point, FIXED_PI * -t);
				rightPts.push(tr);
			}
			pl = tl;
			pr = tr;
			if (isNextPointSharpCorner) {
				isPrevPointSharpCorner = true;
			}
			continue;
		}
		isPrevPointSharpCorner = false;

		if (i === points.length - 1) {
			const off = vMul(vPer(vector), radius);
			leftPts.push(vSub(point, off));
			rightPts.push(vAdd(point, off));
			continue;
		}

		const off = vMul(vPer(vLrp(nextVector, vector, nextDpr)), radius);
		tl = vSub(point, off);
		if (i <= 1 || vDist2(pl, tl) > minDistance) {
			leftPts.push(tl);
			pl = tl;
		}
		tr = vAdd(point, off);
		if (i <= 1 || vDist2(pr, tr) > minDistance) {
			rightPts.push(tr);
			pr = tr;
		}
		prevPressure = pressure;
		prevVector = vector;
	}

	const firstPoint: Vec = [points[0].point[0], points[0].point[1]];
	const lastPoint: Vec = points.length > 1 ? [points[points.length - 1].point[0], points[points.length - 1].point[1]] : vAdd(points[0].point, [1, 1]);
	const startCap: Vec[] = [];
	const endCap: Vec[] = [];

	if (points.length === 1) {
		if (!(taperStart || taperEnd) || isComplete) {
			// A dot.
			const start = vPrj(firstPoint, vUni(vPer(vSub(firstPoint, lastPoint))), -(firstRadius ?? radius));
			const dotPts: Vec[] = [];
			for (let step = 1 / 13, t = step; t <= 1; t += step) {
				dotPts.push(vRotAround(start, firstPoint, FIXED_PI * 2 * t));
			}
			return dotPts;
		}
	} else {
		if (taperStart || (taperEnd && points.length === 1)) {
			// Tapered start: no cap.
		} else if (capStart) {
			for (let step = 1 / 13, t = step; t <= 1; t += step) {
				startCap.push(vRotAround(rightPts[0], firstPoint, FIXED_PI * t));
			}
		} else {
			const cornersVector = vSub(leftPts[0], rightPts[0]);
			const offsetA = vMul(cornersVector, 0.5);
			const offsetB = vMul(cornersVector, 0.51);
			startCap.push(vSub(firstPoint, offsetA), vSub(firstPoint, offsetB), vAdd(firstPoint, offsetB), vAdd(firstPoint, offsetA));
		}
		const direction = vPer(vNeg(points[points.length - 1].vector));
		if (taperEnd || (taperStart && points.length === 1)) {
			endCap.push(lastPoint);
		} else if (capEnd) {
			const start = vPrj(lastPoint, direction, radius);
			for (let step = 1 / 29, t = step; t < 1; t += step) {
				endCap.push(vRotAround(start, lastPoint, FIXED_PI * 3 * t));
			}
		} else {
			endCap.push(vAdd(lastPoint, vMul(direction, radius)), vAdd(lastPoint, vMul(direction, radius * 0.99)), vSub(lastPoint, vMul(direction, radius * 0.99)), vSub(lastPoint, vMul(direction, radius)));
		}
	}
	return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

/** The filled outline of a stroke, as polygon points. */
export function freehandOutline(points: readonly ScratchPressurePoint[], options: IFreehandOptions): Vec[] {
	const clean = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
	return outlinePoints(strokePoints(clean, options), options).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** Smooth SVG path through the outline: quadratic curves between midpoints (Excalidraw's getSvgPathFromStroke). */
export function outlineToSvgPath(outline: readonly Vec[], closed = true): string {
	const len = outline.length;
	if (len < 4) {
		return '';
	}
	const avg = (a: number, b: number) => (a + b) / 2;
	let a = outline[0];
	let b = outline[1];
	const c = outline[2];
	let d = `M${svgNum(a[0])} ${svgNum(a[1])}Q${svgNum(b[0])} ${svgNum(b[1])} ${svgNum(avg(b[0], c[0]))} ${svgNum(avg(b[1], c[1]))}T`;
	for (let i = 2, max = len - 1; i < max; i++) {
		a = outline[i];
		b = outline[i + 1];
		d += `${svgNum(avg(a[0], b[0]))} ${svgNum(avg(a[1], b[1]))} `;
	}
	if (closed) {
		d += 'Z';
	}
	return d;
}

/** Excalidraw's pen; the highlighter is wide, even and flat. */
export function freehandOptionsFor(el: Pick<IScratchDrawElement, 'strokeWidth' | 'pen' | 'simulatePressure'>, last: boolean): IFreehandOptions {
	if (el.pen === 'highlighter') {
		return {
			size: el.strokeWidth * 6 + 10,
			thinning: 0,
			smoothing: 0.6,
			streamline: 0.6,
			simulatePressure: false,
			last,
			capStart: true,
			capEnd: true,
		};
	}
	return {
		size: el.strokeWidth * 4.25,
		thinning: 0.6,
		smoothing: 0.5,
		streamline: 0.5,
		simulatePressure: el.simulatePressure,
		last,
		easing: t => Math.sin((t * Math.PI) / 2),
	};
}

function perpendicularDistance(p: ScratchPressurePoint, a: ScratchPressurePoint, b: ScratchPressurePoint): number {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-12) {
		return Math.hypot(p[0] - a[0], p[1] - a[1]);
	}
	// Distance to the segment, so points past either end still count.
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
	return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** Ramer-Douglas-Peucker on x and y. Endpoints stay; kept points keep their pressure. */
export function simplifyStroke(points: readonly ScratchPressurePoint[], tolerance: number): ScratchPressurePoint[] {
	if (points.length <= 2 || !(tolerance > 0)) {
		return points.slice();
	}
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	// Iterative, so a long stroke cannot overflow the stack.
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [first, last] = stack.pop()!;
		let maxDistance = 0;
		let index = -1;
		for (let i = first + 1; i < last; i++) {
			const d = perpendicularDistance(points[i], points[first], points[last]);
			if (d > maxDistance) {
				maxDistance = d;
				index = i;
			}
		}
		if (index !== -1 && maxDistance > tolerance) {
			keep[index] = 1;
			stack.push([first, index], [index, last]);
		}
	}
	const out: ScratchPressurePoint[] = [];
	for (let i = 0; i < points.length; i++) {
		if (keep[i]) {
			out.push(points[i]);
		}
	}
	return out;
}
