/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { freehandOptionsFor, freehandOutline, outlineToSvgPath } from './scratchFreehand.js';
import { catmullRomSegments, clamp, distance, normalize, sampleCubics, svgNum, Vec } from './scratchMath.js';
import { cleanCurve, IRoughOptions, roughCurve, roughPolyline, roughShape } from './scratchRough.js';
import { pathToSvg, shapeGeometry } from './scratchShapes.js';
import type { IScratchDrawElement, IScratchLinearElement, IScratchShapeElement, ScratchArrowhead, ScratchStrokeStyle } from './scratchTypes.js';

/**
 * An element as SVG paths in its own unrotated box. The DOM renderer and the SVG/PNG exporter
 * both draw from these, so the board and its exports always match.
 */

export interface IScratchPathSpec {
	readonly d: string;
	/** A colour or `none`. */
	readonly fill: string;
	/** A colour or `none`. */
	readonly stroke: string;
	readonly strokeWidth: number;
	readonly dash?: string;
	readonly lineCap?: 'round' | 'butt' | 'square';
	readonly lineJoin?: 'round' | 'miter';
	readonly fillRule?: 'nonzero' | 'evenodd';
	readonly opacity?: number;
}

export interface IArrowheadDrawing {
	readonly d: string;
	readonly filled: boolean;
	/** The head is a closed outline (triangle, circle, diamond): the line stops at its back. */
	readonly closed: boolean;
}

/**
 * Excalidraw's dashes. Dots keep the look of its extra-bold dotted line at every width (round
 * dots a little longer than wide, about two and a half widths apart), so a thin dotted connector
 * reads as a row of dots instead of scattered specks.
 */
export function strokeDash(style: ScratchStrokeStyle, strokeWidth: number): string | undefined {
	switch (style) {
		case 'dashed': return `8 ${svgNum(8 + strokeWidth)}`;
		case 'dotted': return `${svgNum(strokeWidth / 3)} ${svgNum(strokeWidth * 7 / 3)}`;
		default: return undefined;
	}
}

function visible(color: string): boolean {
	return !!color && color !== 'transparent' && color !== 'none';
}

/** Small shapes wobble less, or the wobble swallows them (Excalidraw's adjustRoughness). */
function adjustedRoughness(roughness: number, width: number, height: number, rounded: boolean): number {
	const maxSize = Math.max(Math.abs(width), Math.abs(height));
	const minSize = Math.min(Math.abs(width), Math.abs(height));
	if ((minSize >= 20 && maxSize >= 50) || minSize >= 15 || (rounded && minSize >= 10)) {
		return roughness;
	}
	return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

function strokeSpecs(d: string, color: string, strokeWidth: number, style: ScratchStrokeStyle, reference?: string): IScratchPathSpec[] {
	// Excalidraw draws dashes a touch heavier so they hold up next to solid lines.
	const width = style === 'solid' ? strokeWidth : strokeWidth + 0.5;
	const base = { fill: 'none', stroke: color, strokeWidth: width, lineCap: 'round', lineJoin: 'round' } as const;
	const dash = strokeDash(style, width);
	if (!dash) {
		return [{ ...base, d }];
	}
	const [on, off] = dash.split(' ').map(Number);
	return fitDashes(d, on, off, reference).map(run => ({ ...base, d: run.d, dash: run.dash }));
}

interface IPathSegment {
	readonly from: Vec;
	readonly c1?: Vec;
	readonly c2?: Vec;
	readonly to: Vec;
}

/** The M/L/C/Q/Z paths the drawing code writes, as segments per subpath. */
function parsePath(d: string): IPathSegment[][] {
	const subpaths: IPathSegment[][] = [];
	let current: IPathSegment[] | undefined;
	let pen: Vec = [0, 0];
	let start: Vec = [0, 0];
	for (const match of d.matchAll(/([MLCQZ])([^MLCQZ]*)/gi)) {
		const n = (match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
		switch (match[1].toUpperCase()) {
			case 'M':
				pen = [n[0], n[1]];
				start = pen;
				current = [];
				subpaths.push(current);
				break;
			case 'L':
				for (let i = 0; i + 1 < n.length; i += 2) {
					const to: Vec = [n[i], n[i + 1]];
					current?.push({ from: pen, to });
					pen = to;
				}
				break;
			case 'C':
				for (let i = 0; i + 5 < n.length; i += 6) {
					const to: Vec = [n[i + 4], n[i + 5]];
					current?.push({ from: pen, c1: [n[i], n[i + 1]], c2: [n[i + 2], n[i + 3]], to });
					pen = to;
				}
				break;
			case 'Q':
				// A rounded elbow's corner, as the cubic it equals.
				for (let i = 0; i + 3 < n.length; i += 4) {
					const q: Vec = [n[i], n[i + 1]];
					const to: Vec = [n[i + 2], n[i + 3]];
					const from = pen;
					current?.push({ from, c1: [from[0] + (q[0] - from[0]) * 2 / 3, from[1] + (q[1] - from[1]) * 2 / 3], c2: [to[0] + (q[0] - to[0]) * 2 / 3, to[1] + (q[1] - to[1]) * 2 / 3], to });
					pen = to;
				}
				break;
			case 'Z':
				if (distance(pen, start) > 1e-6) {
					current?.push({ from: pen, to: start });
				}
				pen = start;
				break;
		}
	}
	return subpaths.filter(sub => sub.length);
}

function segmentLength(seg: IPathSegment): number {
	if (!seg.c1 || !seg.c2) {
		return distance(seg.from, seg.to);
	}
	let length = 0;
	let prev = seg.from;
	for (let i = 1; i <= 12; i++) {
		const t = i / 12, u = 1 - t;
		const p: Vec = [
			u * u * u * seg.from[0] + 3 * u * u * t * seg.c1[0] + 3 * u * t * t * seg.c2[0] + t * t * t * seg.to[0],
			u * u * u * seg.from[1] + 3 * u * u * t * seg.c1[1] + 3 * u * t * t * seg.c2[1] + t * t * t * seg.to[1],
		];
		length += distance(prev, p);
		prev = p;
	}
	return length;
}

function startDirection(seg: IPathSegment): Vec {
	const toward = [seg.c1, seg.c2, seg.to].find(p => p && distance(p, seg.from) > 1e-6) ?? seg.to;
	return normalize([toward[0] - seg.from[0], toward[1] - seg.from[1]]);
}

function endDirection(seg: IPathSegment): Vec {
	const from = [seg.c2, seg.c1, seg.from].find(p => p && distance(p, seg.to) > 1e-6) ?? seg.from;
	return normalize([seg.to[0] - from[0], seg.to[1] - from[1]]);
}

/** Turns sharper than this start a new side: a star's points, a rectangle's corners. */
const CORNER_COS = Math.cos(30 * Math.PI / 180);

/**
 * A dashed or dotted outline, side by side: each side's pattern is stretched a little so it starts
 * and ends on a dash, the way design tools draw them. Corners stay crisp instead of falling in a
 * gap, and a smooth closed outline (an ellipse) tiles with no seam.
 */
export function fitDashes(d: string, on: number, off: number, reference?: string): { readonly d: string; readonly dash: string }[] {
	const period = on + off;
	const subpaths = parsePath(d);
	// Corners are read off the clean outline when there is one: the hand-drawn path has the same
	// segments, but its wobble blurs a small corner's direction.
	const drawn = subpaths.flat();
	const clean = reference ? parsePath(reference).flat() : [];
	const guide = new Map<IPathSegment, IPathSegment>();
	if (clean.length === drawn.length) {
		drawn.forEach((seg, i) => guide.set(seg, clean[i]));
	}
	const g = (seg: IPathSegment) => guide.get(seg) ?? seg;
	// A small rounded corner (a star's point) is still a corner: its side ends with it.
	const isCorner = (seg: IPathSegment) => !!g(seg).c1 && segmentLength(g(seg)) < period * 1.5 && dot(startDirection(g(seg)), endDirection(g(seg))) < CORNER_COS;
	const joins = (a: IPathSegment, b: IPathSegment) => distance(a.to, b.from) < 0.5 && !isCorner(a) && dot(endDirection(g(a)), startDirection(g(b))) >= CORNER_COS;
	const runs: IPathSegment[][] = [];
	for (const sub of subpaths) {
		const own: IPathSegment[][] = [];
		let run: IPathSegment[] = [];
		for (const seg of sub) {
			const last = run[run.length - 1];
			if (last && !joins(last, seg)) {
				own.push(run);
				run = [];
			}
			run.push(seg);
		}
		if (run.length) {
			own.push(run);
		}
		// A closed outline that starts mid-side: its last piece and its first are one side.
		if (own.length > 1) {
			const head = own[0], tail = own[own.length - 1];
			if (joins(tail[tail.length - 1], head[0])) {
				own[0] = [...tail, ...head];
				own.pop();
			}
		}
		runs.push(...own);
	}
	return runs.map(run => {
		const first = run[0];
		const last = run[run.length - 1];
		let path = `M${svgNum(first.from[0])} ${svgNum(first.from[1])}`;
		let length = 0;
		for (const seg of run) {
			path += seg.c1 && seg.c2
				? `C${svgNum(seg.c1[0])} ${svgNum(seg.c1[1])} ${svgNum(seg.c2[0])} ${svgNum(seg.c2[1])} ${svgNum(seg.to[0])} ${svgNum(seg.to[1])}`
				: `L${svgNum(seg.to[0])} ${svgNum(seg.to[1])}`;
			length += segmentLength(seg);
		}
		const loop = run.length > 1 && joins(last, first);
		if (loop) {
			// Whole periods round the loop: no doubled dash where it starts.
			const k = length / (Math.max(1, Math.round(length / period)) * period);
			return { d: path, dash: `${svgNum(on * k)} ${svgNum(off * k)}` };
		}
		const n = Math.max(1, Math.round((length + off) / period));
		if (n === 1) {
			// Shorter than a dash and a gap: one dash end to end.
			return { d: path, dash: `${svgNum(Math.max(length, on))} ${svgNum(off)}` };
		}
		const k = length / (n * on + (n - 1) * off);
		return { d: path, dash: `${svgNum(on * k)} ${svgNum(off * k)}` };
	});
}

function dot(a: Vec, b: Vec): number {
	return a[0] * b[0] + a[1] * b[1];
}

export function shapeDrawing(el: IScratchShapeElement, mapColor: (c: string) => string): IScratchPathSpec[] {
	const geometry = shapeGeometry(el.shape, el.width, el.height, el.roundness);
	const roughness = el.roughness > 0 ? adjustedRoughness(el.roughness, el.width, el.height, el.roundness === 'round') : 0;
	const options: IRoughOptions = { roughness, strokeWidth: el.strokeWidth, seed: el.seed, singleStroke: el.strokeStyle !== 'solid' };
	const fillVisible = visible(el.fill);
	const drawable = roughShape(el.shape, geometry, { style: el.fillStyle, visible: fillVisible }, options);
	const specs: IScratchPathSpec[] = [];
	if (fillVisible) {
		const fillColor = mapColor(el.fill);
		if (drawable.fill) {
			specs.push({ d: drawable.fill, fill: fillColor, stroke: 'none', strokeWidth: 0 });
		}
		if (drawable.hachure) {
			specs.push({ d: drawable.hachure, fill: 'none', stroke: fillColor, strokeWidth: drawable.hachureWidth ?? Math.max(0.5, el.strokeWidth / 2), lineCap: 'round', lineJoin: 'round' });
		}
	}
	if (visible(el.stroke) && el.strokeWidth > 0 && drawable.stroke) {
		const clean = el.shape === 'ellipse' ? undefined : geometry.strokes.map(stroke => pathToSvg(stroke)).join('');
		specs.push(...strokeSpecs(drawable.stroke, mapColor(el.stroke), el.strokeWidth, el.strokeStyle, clean));
	}
	return specs;
}

/** Points with consecutive duplicates removed (a doubled point has no direction). */
function distinctPoints(points: readonly Vec[]): Vec[] {
	const out: Vec[] = [];
	for (const p of points) {
		if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
			continue;
		}
		const last = out[out.length - 1];
		if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) {
			out.push([p[0], p[1]]);
		}
	}
	return out;
}

/** The polyline actually drawn, in the element's own coordinates. */
export function linearCenterline(el: IScratchLinearElement): Vec[] {
	const points = distinctPoints(el.points);
	if (el.arrowType === 'round' && points.length > 2) {
		return sampleCubics(catmullRomSegments(points), 12);
	}
	return points;
}

/** Head size grows a little with stroke width (Excalidraw's sizes at width 2). */
function headScale(strokeWidth: number): number {
	return clamp(0.75 + strokeWidth * 0.125, 0.8, 1.25);
}

function headBaseSize(kind: ScratchArrowhead): number {
	switch (kind) {
		case 'arrow': return 25;
		case 'diamond': case 'diamond-outline': return 12;
		case 'crowfoot-one': case 'crowfoot-many': case 'crowfoot-one-or-many': return 20;
		default: return 15;
	}
}

function headSize(kind: ScratchArrowhead, strokeWidth: number, segmentLength: number): number {
	const multiplier = kind === 'diamond' || kind === 'diamond-outline' ? 0.25 : 0.5;
	const size = headBaseSize(kind) * headScale(strokeWidth);
	return Math.max(0, Math.min(size, segmentLength * multiplier));
}

/** How far back from the tip a closed head reaches; the line stops there. */
function headDepth(kind: ScratchArrowhead, strokeWidth: number, segmentLength: number): number {
	const size = headSize(kind, strokeWidth, segmentLength);
	switch (kind) {
		case 'triangle': case 'triangle-outline': return size * Math.cos(25 * Math.PI / 180);
		case 'dot': case 'circle': return size;
		case 'diamond': case 'diamond-outline': return size * 2;
		default: return 0;
	}
}

function pt(p: Vec): string {
	return `${svgNum(p[0])} ${svgNum(p[1])}`;
}

function rotateDir(v: Vec, angle: number): Vec {
	const c = Math.cos(angle), s = Math.sin(angle);
	return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/**
 * An arrowhead whose point sits exactly on `tip`. `direction` is the unit vector pointing into
 * the tip (along the line, towards its end).
 */
export function arrowheadDrawing(kind: ScratchArrowhead, tip: Vec, direction: Vec, strokeWidth: number, segmentLength: number): IArrowheadDrawing | undefined {
	if (kind === 'none') {
		return undefined;
	}
	const dir = normalize(direction);
	if ((dir[0] === 0 && dir[1] === 0) || !Number.isFinite(tip[0]) || !Number.isFinite(tip[1])) {
		return undefined;
	}
	const size = headSize(kind, strokeWidth, segmentLength);
	if (!(size > 0.5)) {
		return undefined;
	}
	const back: Vec = [-dir[0], -dir[1]];
	const perp: Vec = [-dir[1], dir[0]];
	const along = (d: number): Vec => [tip[0] + back[0] * d, tip[1] + back[1] * d];
	const wing = (angleDeg: number, length: number): Vec => {
		const v = rotateDir(back, angleDeg * Math.PI / 180);
		return [tip[0] + v[0] * length, tip[1] + v[1] * length];
	};
	switch (kind) {
		case 'arrow': {
			const a = wing(20, size), b = wing(-20, size);
			return { d: `M${pt(a)}L${pt(tip)}L${pt(b)}`, filled: false, closed: false };
		}
		case 'triangle':
		case 'triangle-outline': {
			const a = wing(25, size), b = wing(-25, size);
			return { d: `M${pt(tip)}L${pt(a)}L${pt(b)}Z`, filled: kind === 'triangle', closed: true };
		}
		case 'dot':
		case 'circle': {
			const r = size / 2;
			const far = along(size);
			return { d: `M${pt(tip)}A${svgNum(r)} ${svgNum(r)} 0 1 0 ${pt(far)}A${svgNum(r)} ${svgNum(r)} 0 1 0 ${pt(tip)}Z`, filled: kind === 'dot', closed: true };
		}
		case 'bar': {
			const h = size * 0.6;
			const a: Vec = [tip[0] + perp[0] * h, tip[1] + perp[1] * h];
			const b: Vec = [tip[0] - perp[0] * h, tip[1] - perp[1] * h];
			return { d: `M${pt(a)}L${pt(b)}`, filled: false, closed: false };
		}
		case 'diamond':
		case 'diamond-outline': {
			const a = wing(25, size), b = wing(-25, size);
			const opposite = along(size * 2);
			return { d: `M${pt(tip)}L${pt(a)}L${pt(opposite)}L${pt(b)}Z`, filled: kind === 'diamond', closed: true };
		}
		case 'crowfoot-one': {
			const c = along(size * 0.5);
			const h = size * 0.5;
			return { d: `M${pt([c[0] + perp[0] * h, c[1] + perp[1] * h])}L${pt([c[0] - perp[0] * h, c[1] - perp[1] * h])}M${pt(c)}L${pt(tip)}`, filled: false, closed: false };
		}
		case 'crowfoot-many':
		case 'crowfoot-one-or-many': {
			// Three prongs spread at the tip and meet back along the line.
			const h = size * 0.5;
			const join = along(size);
			const left: Vec = [tip[0] + perp[0] * h, tip[1] + perp[1] * h];
			const right: Vec = [tip[0] - perp[0] * h, tip[1] - perp[1] * h];
			let d = `M${pt(left)}L${pt(join)}L${pt(right)}M${pt(join)}L${pt(tip)}`;
			if (kind === 'crowfoot-one-or-many') {
				const c = along(size * 1.35);
				d += `M${pt([c[0] + perp[0] * h, c[1] + perp[1] * h])}L${pt([c[0] - perp[0] * h, c[1] - perp[1] * h])}`;
			}
			return { d, filled: false, closed: false };
		}
	}
}

interface IEnd {
	readonly tip: Vec;
	/** Into the tip. */
	readonly direction: Vec;
	readonly segmentLength: number;
}

/** Tip, incoming direction and last-segment length at each end of the drawn line. */
function endsOf(points: readonly Vec[], round: boolean): { readonly start: IEnd; readonly end: IEnd } | undefined {
	if (points.length < 2) {
		return undefined;
	}
	const n = points.length;
	if (round && n > 2) {
		const segments = catmullRomSegments(points);
		const first = segments[0];
		const last = segments[segments.length - 1];
		// Tangent at the ends of a cubic is towards its neighbouring control point.
		const startDir = distance(first.from, first.c1) > 1e-6 ? normalize([first.from[0] - first.c1[0], first.from[1] - first.c1[1]]) : normalize([first.from[0] - first.to[0], first.from[1] - first.to[1]]);
		const endDir = distance(last.to, last.c2) > 1e-6 ? normalize([last.to[0] - last.c2[0], last.to[1] - last.c2[1]]) : normalize([last.to[0] - last.from[0], last.to[1] - last.from[1]]);
		return {
			start: { tip: first.from, direction: startDir, segmentLength: distance(first.from, first.to) },
			end: { tip: last.to, direction: endDir, segmentLength: distance(last.from, last.to) },
		};
	}
	return {
		start: { tip: points[0], direction: normalize([points[0][0] - points[1][0], points[0][1] - points[1][1]]), segmentLength: distance(points[0], points[1]) },
		end: { tip: points[n - 1], direction: normalize([points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]]), segmentLength: distance(points[n - 2], points[n - 1]) },
	};
}

/** Pulls an end point back by `by` along its segment, never past the neighbouring point. */
function pullBack(points: Vec[], index: number, neighbour: number, by: number): void {
	if (!(by > 0)) {
		return;
	}
	const p = points[index], q = points[neighbour];
	const len = distance(p, q);
	if (len < 1e-6) {
		return;
	}
	const t = Math.min(by, len * 0.9) / len;
	points[index] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Orthogonal polyline with its corners rounded (clean elbow connectors). */
function roundedElbow(points: readonly Vec[], radius: number): string {
	if (points.length < 3) {
		return points.length ? `M${pt(points[0])}` + points.slice(1).map(p => `L${pt(p)}`).join('') : '';
	}
	let d = `M${pt(points[0])}`;
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1], corner = points[i], next = points[i + 1];
		const r = Math.min(radius, distance(prev, corner) / 2, distance(corner, next) / 2);
		if (r < 0.5) {
			d += `L${pt(corner)}`;
			continue;
		}
		const a = normalize([prev[0] - corner[0], prev[1] - corner[1]]);
		const b = normalize([next[0] - corner[0], next[1] - corner[1]]);
		const enter: Vec = [corner[0] + a[0] * r, corner[1] + a[1] * r];
		const exit: Vec = [corner[0] + b[0] * r, corner[1] + b[1] * r];
		d += `L${pt(enter)}Q${pt(corner)} ${pt(exit)}`;
	}
	d += `L${pt(points[points.length - 1])}`;
	return d;
}

export function linearDrawing(el: IScratchLinearElement, mapColor: (c: string) => string): IScratchPathSpec[] {
	const points = distinctPoints(el.points);
	if (points.length < 2) {
		return [];
	}
	const strokeVisible = visible(el.stroke) && el.strokeWidth > 0;
	const strokeColor = strokeVisible ? mapColor(el.stroke) : 'none';
	const round = el.arrowType === 'round';
	const closed = el.closed && points.length > 2;
	const roughness = el.roughness > 0 ? adjustedRoughness(el.roughness, el.width, el.height, false) : 0;
	const options: IRoughOptions = { roughness, strokeWidth: el.strokeWidth, seed: el.seed, singleStroke: el.strokeStyle !== 'solid' };
	const specs: IScratchPathSpec[] = [];

	if (closed && visible(el.fill)) {
		const fillD = round ? cleanCurve([...points, points[0]]) + 'Z' : `M${pt(points[0])}${points.slice(1).map(p => `L${pt(p)}`).join('')}Z`;
		specs.push({ d: fillD, fill: mapColor(el.fill), stroke: 'none', strokeWidth: 0 });
	}

	// Heads sit on the real ends; the body stops at the back of closed heads.
	const ends = closed ? undefined : endsOf(points, round);
	const startHead = ends ? arrowheadDrawing(el.startArrowhead, ends.start.tip, ends.start.direction, el.strokeWidth, ends.start.segmentLength) : undefined;
	const endHead = ends ? arrowheadDrawing(el.endArrowhead, ends.end.tip, ends.end.direction, el.strokeWidth, ends.end.segmentLength) : undefined;
	const body = points.slice();
	if (ends && startHead?.closed) {
		// A filled head hides a little overlap; an outline head gets the line right up to its edge.
		const depth = headDepth(el.startArrowhead, el.strokeWidth, ends.start.segmentLength) - (startHead.filled ? el.strokeWidth : 0);
		pullBack(body, 0, 1, depth);
	}
	if (ends && endHead?.closed) {
		const depth = headDepth(el.endArrowhead, el.strokeWidth, ends.end.segmentLength) - (endHead.filled ? el.strokeWidth : 0);
		pullBack(body, body.length - 1, body.length - 2, depth);
	}

	if (strokeVisible) {
		let d: string;
		if (el.arrowType === 'elbow') {
			d = roughness > 0 ? roughPolyline(body, options, closed) : roundedElbow(closed ? [...body, body[0]] : body, 8) + (closed ? 'Z' : '');
		} else if (round && body.length > 2) {
			const through = closed ? [...body, body[0]] : body;
			d = roughness > 0 ? roughCurve(through, options) : cleanCurve(through) + (closed ? 'Z' : '');
		} else {
			d = roughPolyline(body, options, closed);
		}
		specs.push(...strokeSpecs(d, strokeColor, el.strokeWidth, el.strokeStyle));
		for (const head of [startHead, endHead]) {
			if (head) {
				specs.push({
					d: head.d,
					fill: head.filled ? strokeColor : 'none',
					stroke: strokeColor,
					strokeWidth: el.strokeWidth,
					lineCap: 'round',
					lineJoin: 'round',
				});
			}
		}
	}
	return specs;
}

export function freehandDrawing(el: IScratchDrawElement, mapColor: (c: string) => string): IScratchPathSpec[] {
	if (!visible(el.stroke) || !el.points.length) {
		return [];
	}
	const outline = freehandOutline(el.points, freehandOptionsFor(el, true));
	const d = outlineToSvgPath(outline, true);
	if (!d) {
		return [];
	}
	return [{
		d,
		fill: mapColor(el.stroke),
		stroke: 'none',
		strokeWidth: 0,
		fillRule: 'nonzero',
		opacity: el.pen === 'highlighter' ? 0.45 : undefined,
	}];
}
