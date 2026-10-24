/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { catmullRomSegments, seededRandom, svgNum, Vec } from './scratchMath.js';
import { IShapeGeometry, PathCommand, pathToSvg } from './scratchShapes.js';
import type { ScratchFillStyle, ScratchShapeKind } from './scratchTypes.js';

/**
 * The hand-drawn look: a port of rough.js's line, curve, ellipse and hachure generators. Every
 * random number comes from one seeded stream per call, so an element paints the same wobble every
 * time. Roughness 0 skips the wobble and returns crisp paths.
 */

export interface IRoughOptions {
	readonly roughness: number;
	readonly strokeWidth: number;
	readonly seed: number;
	readonly bowing?: number;
	/** Dashed and dotted strokes draw a single pass. */
	readonly singleStroke?: boolean;
}

export interface IRoughDrawable {
	/** SVG path data, stroked. */
	readonly stroke: string;
	/** SVG path data of the solid fill region (filled, no stroke). */
	readonly fill?: string;
	/** SVG path data of the fill lines, stroked with the fill colour. */
	readonly hachure?: string;
	readonly hachureWidth?: number;
}

/** rough.js draws hachure at -41 degrees; cross-hatch adds the perpendicular. */
const HACHURE_ANGLE = -41;

interface IOp {
	readonly op: 'move' | 'lineTo' | 'bcurveTo';
	readonly data: readonly number[];
}

interface IResolved {
	readonly roughness: number;
	readonly strokeWidth: number;
	readonly bowing: number;
	readonly maxRandomnessOffset: number;
	readonly curveFitting: number;
	readonly curveTightness: number;
	readonly curveStepCount: number;
	readonly disableMultiStroke: boolean;
	/** Corners stay where they are, so joined lines meet (rough.js below cartoonist roughness). */
	readonly preserveVertices: boolean;
	readonly random: () => number;
}

function resolve(options: IRoughOptions): IResolved {
	const roughness = Math.max(0, options.roughness);
	return {
		roughness,
		strokeWidth: options.strokeWidth,
		bowing: options.bowing ?? 1,
		maxRandomnessOffset: 2,
		curveFitting: 0.95,
		curveTightness: 0,
		curveStepCount: 9,
		disableMultiStroke: !!options.singleStroke,
		preserveVertices: roughness < 2,
		random: seededRandom(options.seed),
	};
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function opsToPath(ops: readonly IOp[]): string {
	let d = '';
	let pen: Vec | undefined;
	for (const { op, data } of ops) {
		switch (op) {
			case 'move': {
				// A side that starts where the last one ended continues the path: a dashed outline then
				// runs on round the corner instead of starting its dashes over on every side.
				const at: Vec = [finite(data[0]), finite(data[1])];
				if (!pen || Math.abs(pen[0] - at[0]) > 1e-3 || Math.abs(pen[1] - at[1]) > 1e-3) {
					d += `M${svgNum(at[0])} ${svgNum(at[1])}`;
				}
				pen = at;
				break;
			}
			case 'lineTo':
				d += `L${svgNum(finite(data[0]))} ${svgNum(finite(data[1]))}`;
				pen = [finite(data[0]), finite(data[1])];
				break;
			case 'bcurveTo':
				d += `C${data.map(v => svgNum(finite(v))).join(' ')}`;
				pen = [finite(data[4]), finite(data[5])];
				break;
		}
	}
	return d;
}

// ---- rough.js primitives ------------------------------------------------------------------

function offset(min: number, max: number, o: IResolved, roughnessGain = 1): number {
	return o.roughness * roughnessGain * ((o.random() * (max - min)) + min);
}

function offsetOpt(x: number, o: IResolved, roughnessGain = 1): number {
	return offset(-x, x, o, roughnessGain);
}

function line(x1: number, y1: number, x2: number, y2: number, o: IResolved, move: boolean, overlay: boolean): IOp[] {
	const lengthSq = (x1 - x2) ** 2 + (y1 - y2) ** 2;
	const length = Math.sqrt(lengthSq);
	let roughnessGain: number;
	if (length < 200) {
		roughnessGain = 1;
	} else if (length > 500) {
		roughnessGain = 0.4;
	} else {
		roughnessGain = (-0.0016668) * length + 1.233334;
	}
	let off = o.maxRandomnessOffset || 0;
	if ((off * off * 100) > lengthSq) {
		off = length / 10;
	}
	const halfOffset = off / 2;
	const divergePoint = 0.2 + o.random() * 0.2;
	let midDispX = o.bowing * o.maxRandomnessOffset * (y2 - y1) / 200;
	let midDispY = o.bowing * o.maxRandomnessOffset * (x1 - x2) / 200;
	midDispX = offsetOpt(midDispX, o, roughnessGain);
	midDispY = offsetOpt(midDispY, o, roughnessGain);
	const ops: IOp[] = [];
	const randomHalf = () => offsetOpt(halfOffset, o, roughnessGain);
	const randomFull = () => offsetOpt(off, o, roughnessGain);
	const preserve = o.preserveVertices;
	if (move) {
		if (overlay) {
			ops.push({ op: 'move', data: [x1 + (preserve ? 0 : randomHalf()), y1 + (preserve ? 0 : randomHalf())] });
		} else {
			ops.push({ op: 'move', data: [x1 + (preserve ? 0 : randomFull()), y1 + (preserve ? 0 : randomFull())] });
		}
	}
	const jitter = overlay ? randomHalf : randomFull;
	ops.push({
		op: 'bcurveTo', data: [
			midDispX + x1 + (x2 - x1) * divergePoint + jitter(),
			midDispY + y1 + (y2 - y1) * divergePoint + jitter(),
			midDispX + x1 + 2 * (x2 - x1) * divergePoint + jitter(),
			midDispY + y1 + 2 * (y2 - y1) * divergePoint + jitter(),
			x2 + (preserve ? 0 : jitter()),
			y2 + (preserve ? 0 : jitter()),
		],
	});
	return ops;
}

function doubleLine(x1: number, y1: number, x2: number, y2: number, o: IResolved, filling = false): IOp[] {
	const first = line(x1, y1, x2, y2, o, true, false);
	// rough.js keeps the second pass for fills even when strokes are single.
	if (o.disableMultiStroke && !filling) {
		return first;
	}
	return first.concat(line(x1, y1, x2, y2, o, true, true));
}

function curve(points: readonly Vec[], closePoint: Vec | null, o: IResolved): IOp[] {
	const len = points.length;
	const ops: IOp[] = [];
	if (len > 3) {
		const s = 1 - o.curveTightness;
		ops.push({ op: 'move', data: [points[1][0], points[1][1]] });
		for (let i = 1; (i + 2) < len; i++) {
			const cached = points[i];
			ops.push({
				op: 'bcurveTo', data: [
					cached[0] + (s * points[i + 1][0] - s * points[i - 1][0]) / 6,
					cached[1] + (s * points[i + 1][1] - s * points[i - 1][1]) / 6,
					points[i + 1][0] + (s * points[i][0] - s * points[i + 2][0]) / 6,
					points[i + 1][1] + (s * points[i][1] - s * points[i + 2][1]) / 6,
					points[i + 1][0],
					points[i + 1][1],
				],
			});
		}
		if (closePoint) {
			const ro = o.maxRandomnessOffset;
			ops.push({ op: 'lineTo', data: [closePoint[0] + offsetOpt(ro, o), closePoint[1] + offsetOpt(ro, o)] });
		}
	} else if (len === 3) {
		ops.push({ op: 'move', data: [points[1][0], points[1][1]] });
		ops.push({ op: 'bcurveTo', data: [points[1][0], points[1][1], points[2][0], points[2][1], points[2][0], points[2][1]] });
	} else if (len === 2) {
		ops.push(...line(points[0][0], points[0][1], points[1][0], points[1][1], o, true, true));
	}
	return ops;
}

function curveWithOffset(points: readonly Vec[], off: number, o: IResolved): IOp[] {
	if (!points.length) {
		return [];
	}
	const ps: Vec[] = [];
	ps.push([points[0][0] + offsetOpt(off, o), points[0][1] + offsetOpt(off, o)]);
	ps.push([points[0][0] + offsetOpt(off, o), points[0][1] + offsetOpt(off, o)]);
	for (let i = 1; i < points.length; i++) {
		ps.push([points[i][0] + offsetOpt(off, o), points[i][1] + offsetOpt(off, o)]);
		if (i === points.length - 1) {
			ps.push([points[i][0] + offsetOpt(off, o), points[i][1] + offsetOpt(off, o)]);
		}
	}
	return curve(ps, null, o);
}

/** rough.js `curve`: two passes through jittered copies of the points. */
function curveOps(points: readonly Vec[], o: IResolved): IOp[] {
	const first = curveWithOffset(points, 1 * (1 + o.roughness * 0.2), o);
	if (o.disableMultiStroke) {
		return first;
	}
	return first.concat(curveWithOffset(points, 1.5 * (1 + o.roughness * 0.22), o));
}

/** rough.js `_bezierTo`: a cubic drawn twice with jittered control points. */
function bezierTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number, current: Vec, o: IResolved): IOp[] {
	const ops: IOp[] = [];
	// A short curve (a rounded corner) wobbles in proportion, as rough.js does for short lines;
	// a full-size wobble on it draws a hook.
	const span = Math.hypot(x - current[0], y - current[1]);
	const shrink = Math.min(1, span / (10 * (o.maxRandomnessOffset || 1)));
	const ros = [(o.maxRandomnessOffset || 1) * shrink, ((o.maxRandomnessOffset || 1) + 0.3) * shrink];
	const iterations = o.disableMultiStroke ? 1 : 2;
	const preserve = o.preserveVertices;
	for (let i = 0; i < iterations; i++) {
		if (i === 0) {
			ops.push({ op: 'move', data: [current[0], current[1]] });
		} else {
			ops.push({ op: 'move', data: [current[0] + (preserve ? 0 : offsetOpt(ros[0], o)), current[1] + (preserve ? 0 : offsetOpt(ros[0], o))] });
		}
		const end = preserve ? [x, y] : [x + offsetOpt(ros[i], o), y + offsetOpt(ros[i], o)];
		ops.push({
			op: 'bcurveTo', data: [
				x1 + offsetOpt(ros[i], o), y1 + offsetOpt(ros[i], o),
				x2 + offsetOpt(ros[i], o), y2 + offsetOpt(ros[i], o),
				end[0], end[1],
			],
		});
	}
	return ops;
}

interface IEllipseParams {
	readonly increment: number;
	readonly rx: number;
	readonly ry: number;
}

function ellipseParams(width: number, height: number, o: IResolved): IEllipseParams {
	const psq = Math.sqrt(Math.PI * 2 * Math.sqrt(((width / 2) ** 2 + (height / 2) ** 2) / 2));
	const stepCount = Math.ceil(Math.max(o.curveStepCount, (o.curveStepCount / Math.sqrt(200)) * psq));
	const increment = (Math.PI * 2) / stepCount;
	let rx = Math.abs(width / 2);
	let ry = Math.abs(height / 2);
	const curveFitRandomness = 1 - o.curveFitting;
	rx += offsetOpt(rx * curveFitRandomness, o);
	ry += offsetOpt(ry * curveFitRandomness, o);
	return { increment, rx, ry };
}

function computeEllipsePoints(increment: number, cx: number, cy: number, rx: number, ry: number, off: number, overlap: number, o: IResolved): [Vec[], Vec[]] {
	const corePoints: Vec[] = [];
	const allPoints: Vec[] = [];
	const radOffset = offsetOpt(0.5, o) - (Math.PI / 2);
	allPoints.push([offsetOpt(off, o) + cx + 0.9 * rx * Math.cos(radOffset - increment), offsetOpt(off, o) + cy + 0.9 * ry * Math.sin(radOffset - increment)]);
	const endAngle = Math.PI * 2 + radOffset - 0.01;
	for (let angle = radOffset; angle < endAngle; angle = angle + increment) {
		const p: Vec = [offsetOpt(off, o) + cx + rx * Math.cos(angle), offsetOpt(off, o) + cy + ry * Math.sin(angle)];
		corePoints.push(p);
		allPoints.push(p);
	}
	allPoints.push([offsetOpt(off, o) + cx + rx * Math.cos(radOffset + Math.PI * 2 + overlap * 0.5), offsetOpt(off, o) + cy + ry * Math.sin(radOffset + Math.PI * 2 + overlap * 0.5)]);
	allPoints.push([offsetOpt(off, o) + cx + 0.98 * rx * Math.cos(radOffset + overlap), offsetOpt(off, o) + cy + 0.98 * ry * Math.sin(radOffset + overlap)]);
	allPoints.push([offsetOpt(off, o) + cx + 0.9 * rx * Math.cos(radOffset + overlap * 0.5), offsetOpt(off, o) + cy + 0.9 * ry * Math.sin(radOffset + overlap * 0.5)]);
	return [allPoints, corePoints];
}

/** Both passes of a rough ellipse, plus the first pass alone (its fill follows the stroke). */
function ellipseOps(cx: number, cy: number, width: number, height: number, o: IResolved): { readonly ops: IOp[]; readonly firstPass: IOp[] } {
	const params = ellipseParams(width, height, o);
	const [ap1] = computeEllipsePoints(params.increment, cx, cy, params.rx, params.ry, 1, params.increment * offset(0.1, offset(0.4, 1, o), o), o);
	const first = curve(ap1, null, o);
	if (o.disableMultiStroke || o.roughness === 0) {
		return { ops: first, firstPass: first };
	}
	const [ap2] = computeEllipsePoints(params.increment, cx, cy, params.rx, params.ry, 1.5, 0, o);
	return { ops: first.concat(curve(ap2, null, o)), firstPass: first };
}

function pathOps(commands: readonly PathCommand[], o: IResolved): IOp[] {
	const ops: IOp[] = [];
	let current: Vec = [0, 0];
	let start: Vec = [0, 0];
	for (const c of commands) {
		switch (c.kind) {
			case 'M':
				current = c.p;
				start = c.p;
				break;
			case 'L':
				ops.push(...doubleLine(current[0], current[1], c.p[0], c.p[1], o));
				current = c.p;
				break;
			case 'C':
				ops.push(...bezierTo(c.c1[0], c.c1[1], c.c2[0], c.c2[1], c.p[0], c.p[1], current, o));
				current = c.p;
				break;
			case 'Z':
				if (Math.abs(current[0] - start[0]) > 1e-6 || Math.abs(current[1] - start[1]) > 1e-6) {
					ops.push(...doubleLine(current[0], current[1], start[0], start[1], o));
				}
				current = start;
				break;
		}
	}
	return ops;
}

// ---- Clean paths (roughness 0) ------------------------------------------------------------

function cleanPolyline(points: readonly Vec[], closed: boolean): string {
	if (!points.length) {
		return '';
	}
	let d = `M${svgNum(finite(points[0][0]))} ${svgNum(finite(points[0][1]))}`;
	for (let i = 1; i < points.length; i++) {
		d += `L${svgNum(finite(points[i][0]))} ${svgNum(finite(points[i][1]))}`;
	}
	return closed ? d + 'Z' : d;
}

/** A smooth curve through every point (Catmull-Rom as cubics), no wobble. */
export function cleanCurve(points: readonly Vec[]): string {
	if (points.length < 3) {
		return cleanPolyline(points, false);
	}
	const segments = catmullRomSegments(points);
	let d = `M${svgNum(finite(points[0][0]))} ${svgNum(finite(points[0][1]))}`;
	for (const s of segments) {
		d += `C${svgNum(finite(s.c1[0]))} ${svgNum(finite(s.c1[1]))} ${svgNum(finite(s.c2[0]))} ${svgNum(finite(s.c2[1]))} ${svgNum(finite(s.to[0]))} ${svgNum(finite(s.to[1]))}`;
	}
	return d;
}

function cleanEllipse(cx: number, cy: number, width: number, height: number): string {
	const rx = Math.abs(width / 2), ry = Math.abs(height / 2);
	const k = 0.5522847498;
	const kx = rx * k, ky = ry * k;
	return pathToSvg([
		{ kind: 'M', p: [cx + rx, cy] },
		{ kind: 'C', c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], p: [cx, cy + ry] },
		{ kind: 'C', c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], p: [cx - rx, cy] },
		{ kind: 'C', c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], p: [cx, cy - ry] },
		{ kind: 'C', c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], p: [cx + rx, cy] },
		{ kind: 'Z' },
	]);
}

// ---- Public API ---------------------------------------------------------------------------

export function roughPath(commands: readonly PathCommand[], options: IRoughOptions): string {
	if (options.roughness <= 0) {
		return pathToSvg(commands);
	}
	return opsToPath(pathOps(commands, resolve(options)));
}

export function roughPolyline(points: readonly Vec[], options: IRoughOptions, closed = false): string {
	if (options.roughness <= 0 || points.length < 2) {
		return cleanPolyline(points, closed && points.length > 2);
	}
	const o = resolve(options);
	const ops: IOp[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		ops.push(...doubleLine(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], o));
	}
	if (closed && points.length > 2) {
		const last = points[points.length - 1];
		ops.push(...doubleLine(last[0], last[1], points[0][0], points[0][1], o));
	}
	return opsToPath(ops);
}

export function roughCurve(points: readonly Vec[], options: IRoughOptions): string {
	if (options.roughness <= 0) {
		return cleanCurve(points);
	}
	if (points.length < 2) {
		return cleanPolyline(points, false);
	}
	return opsToPath(curveOps(points, resolve(options)));
}

export function roughEllipse(cx: number, cy: number, width: number, height: number, options: IRoughOptions): string {
	if (options.roughness <= 0) {
		return cleanEllipse(cx, cy, width, height);
	}
	return opsToPath(ellipseOps(cx, cy, width, height, resolve(options)).ops);
}

/**
 * Parallel lines filling a polygon, `gap` apart, at `angleDegrees` from horizontal (screen
 * coordinates, y down: -41 degrees rises to the right). Scan-line fill on the polygon rotated so the
 * lines run horizontally, then rotated back.
 */
export function hachureLines(polygon: readonly Vec[], gap: number, angleDegrees: number): [Vec, Vec][] {
	const lines: [Vec, Vec][] = [];
	if (polygon.length < 3 || !(gap > 0)) {
		return lines;
	}
	const angle = angleDegrees * Math.PI / 180;
	const cos = Math.cos(angle), sin = Math.sin(angle);
	// Rotate by -angle so lines at `angle` become horizontal.
	const rotated: Vec[] = polygon.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
	let minY = Infinity, maxY = -Infinity;
	for (const [, y] of rotated) {
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	if (!Number.isFinite(minY) || maxY - minY < 1e-6) {
		return lines;
	}
	const n = rotated.length;
	for (let y = minY + gap / 2; y < maxY; y += gap) {
		const xs: number[] = [];
		for (let i = 0; i < n; i++) {
			const a = rotated[i];
			const b = rotated[(i + 1) % n];
			// Half-open rule: a vertex on the scan line counts once.
			if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
				xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
			}
		}
		xs.sort((p, q) => p - q);
		for (let i = 0; i + 1 < xs.length; i += 2) {
			if (xs[i + 1] - xs[i] < 1e-6) {
				continue;
			}
			// Rotate back by +angle.
			const back = (x: number): Vec => [x * cos - y * sin, x * sin + y * cos];
			lines.push([back(xs[i]), back(xs[i + 1])]);
		}
	}
	return lines;
}

function hachureFor(polygon: readonly Vec[], style: ScratchFillStyle, o: IResolved | undefined, gap: number): string {
	const sets = hachureLines(polygon, gap, HACHURE_ANGLE);
	if (style === 'cross-hatch') {
		sets.push(...hachureLines(polygon, gap, HACHURE_ANGLE + 90));
	}
	if (!o) {
		let d = '';
		for (const [a, b] of sets) {
			d += `M${svgNum(a[0])} ${svgNum(a[1])}L${svgNum(b[0])} ${svgNum(b[1])}`;
		}
		return d;
	}
	const ops: IOp[] = [];
	for (const [a, b] of sets) {
		ops.push(...doubleLine(a[0], a[1], b[0], b[1], o, true));
	}
	return opsToPath(ops);
}

/** rough.js solid fill: the outline with every vertex nudged. */
function jitteredPolygon(points: readonly Vec[], o: IResolved): string {
	if (points.length < 3) {
		return '';
	}
	const off = o.maxRandomnessOffset || 0;
	const ops: IOp[] = [{ op: 'move', data: [points[0][0] + offsetOpt(off, o), points[0][1] + offsetOpt(off, o)] }];
	for (let i = 1; i < points.length; i++) {
		ops.push({ op: 'lineTo', data: [points[i][0] + offsetOpt(off, o), points[i][1] + offsetOpt(off, o)] });
	}
	return opsToPath(ops) + 'Z';
}

function outlineBox(outline: readonly Vec[]): { readonly cx: number; readonly cy: number; readonly width: number; readonly height: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of outline) {
		minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
	}
	if (minX === Infinity) {
		return { cx: 0, cy: 0, width: 0, height: 0 };
	}
	return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
}

/**
 * A shape's stroke and fill. The stroke is drawn first from the seeded stream, so changing the
 * fill never changes the outline's wobble.
 */
export function roughShape(kind: ScratchShapeKind, geometry: IShapeGeometry, fill: { readonly style: ScratchFillStyle; readonly visible: boolean }, options: IRoughOptions): IRoughDrawable {
	const clean = options.roughness <= 0;
	const box = kind === 'ellipse' ? outlineBox(geometry.outline) : undefined;
	const gap = Math.max(4, options.strokeWidth * 4);
	const hachureWidth = Math.max(0.5, options.strokeWidth / 2);

	if (clean) {
		const stroke = box ? cleanEllipse(box.cx, box.cy, box.width, box.height) : geometry.strokes.map(s => pathToSvg(s)).join('');
		if (!fill.visible) {
			return { stroke };
		}
		if (fill.style === 'solid') {
			return { stroke, fill: pathToSvg(geometry.fill) };
		}
		return { stroke, hachure: hachureFor(geometry.outline, fill.style, undefined, gap), hachureWidth };
	}

	const o = resolve(options);
	let stroke: string;
	let ellipseFirstPass: IOp[] | undefined;
	if (box) {
		const ellipse = ellipseOps(box.cx, box.cy, box.width, box.height, o);
		stroke = opsToPath(ellipse.ops);
		ellipseFirstPass = ellipse.firstPass;
	} else {
		stroke = geometry.strokes.map(s => opsToPath(pathOps(s, o))).join('');
	}
	if (!fill.visible) {
		return { stroke };
	}
	if (fill.style === 'solid') {
		if (ellipseFirstPass) {
			return { stroke, fill: opsToPath(ellipseFirstPass) + 'Z' };
		}
		// rough.js fills curved paths with the clean path and polygons with a nudged outline.
		const curved = geometry.fill.some(c => c.kind === 'C');
		return { stroke, fill: curved ? pathToSvg(geometry.fill) : jitteredPolygon(geometry.outline, o) };
	}
	return { stroke, hachure: hachureFor(geometry.outline, fill.style, o, gap), hachureWidth };
}
