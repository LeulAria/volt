/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clamp, cubicPoint, svgNum, Vec } from './scratchMath.js';
import type { ScratchRoundness, ScratchShapeKind } from './scratchTypes.js';

/**
 * Shape outlines in the element's own box (0..width, 0..height), before rotation. The clean
 * renderer draws these commands as they are; the hand-drawn renderer roughens them; hit tests
 * and connector landings use the flattened outline.
 */

export type PathCommand =
	| { readonly kind: 'M'; readonly p: Vec }
	| { readonly kind: 'L'; readonly p: Vec }
	| { readonly kind: 'C'; readonly c1: Vec; readonly c2: Vec; readonly p: Vec }
	| { readonly kind: 'Z' };

export interface IShapeGeometry {
	/** Closed outline with curves flattened: fills, hit tests and where connectors land. */
	readonly outline: readonly Vec[];
	/** The filled region. */
	readonly fill: readonly PathCommand[];
	/** Subpaths to stroke. The first is the outline; others are inner details (a cylinder's rim). */
	readonly strokes: readonly (readonly PathCommand[])[];
}

/** Ellipse quarter-arc control distance. */
const KAPPA = 0.5522847498;

/** Corner radius that grows with the shape up to 32px, like Excalidraw's adaptive radius. */
export function adaptiveRadius(width: number, height: number): number {
	const x = Math.min(Math.abs(width), Math.abs(height));
	return x <= 128 ? x * 0.25 : 32;
}

export function pathToSvg(commands: readonly PathCommand[]): string {
	let d = '';
	for (const c of commands) {
		switch (c.kind) {
			case 'M': d += `M${svgNum(c.p[0])} ${svgNum(c.p[1])}`; break;
			case 'L': d += `L${svgNum(c.p[0])} ${svgNum(c.p[1])}`; break;
			case 'C': d += `C${svgNum(c.c1[0])} ${svgNum(c.c1[1])} ${svgNum(c.c2[0])} ${svgNum(c.c2[1])} ${svgNum(c.p[0])} ${svgNum(c.p[1])}`; break;
			case 'Z': d += 'Z'; break;
		}
	}
	return d;
}

/** Flattens path commands into polylines, one per subpath. */
export function flattenPath(commands: readonly PathCommand[], curveSteps = 10): Vec[][] {
	const out: Vec[][] = [];
	let current: Vec[] = [];
	let start: Vec | undefined;
	let last: Vec = [0, 0];
	for (const c of commands) {
		switch (c.kind) {
			case 'M':
				if (current.length > 1) {
					out.push(current);
				}
				current = [c.p];
				start = c.p;
				last = c.p;
				break;
			case 'L':
				current.push(c.p);
				last = c.p;
				break;
			case 'C':
				for (let i = 1; i <= curveSteps; i++) {
					current.push(cubicPoint(last, c.c1, c.c2, c.p, i / curveSteps));
				}
				last = c.p;
				break;
			case 'Z':
				if (start && (last[0] !== start[0] || last[1] !== start[1])) {
					current.push(start);
				}
				if (start) {
					last = start;
				}
				break;
		}
	}
	if (current.length > 1) {
		out.push(current);
	}
	return out;
}

function polygonPath(points: readonly Vec[]): PathCommand[] {
	const cmds: PathCommand[] = [{ kind: 'M', p: points[0] }];
	for (let i = 1; i < points.length; i++) {
		cmds.push({ kind: 'L', p: points[i] });
	}
	cmds.push({ kind: 'Z' });
	return cmds;
}

/** A polygon with each corner cut by up to `radius` and replaced by a curve. */
/** `radius` for every corner, or per corner (0 keeps that one sharp). */
export function roundedPolygonPath(points: readonly Vec[], radius: number | readonly number[]): PathCommand[] {
	const n = points.length;
	const radiusAt = (i: number) => typeof radius === 'number' ? radius : radius[i] ?? 0;
	if (n < 3 || points.every((_, i) => radiusAt(i) <= 0.5)) {
		return polygonPath(points);
	}
	const corners: { a: Vec; b: Vec; v: Vec }[] = [];
	for (let i = 0; i < n; i++) {
		const prev = points[(i - 1 + n) % n];
		const v = points[i];
		const next = points[(i + 1) % n];
		const lenPrev = Math.hypot(prev[0] - v[0], prev[1] - v[1]);
		const lenNext = Math.hypot(next[0] - v[0], next[1] - v[1]);
		// Never cut more than 45% of either edge, so neighbouring corners do not overlap.
		const r = Math.min(radiusAt(i), lenPrev * 0.45, lenNext * 0.45);
		const sharp = r <= 0.5;
		const a: Vec = !sharp && lenPrev > 0 ? [v[0] + (prev[0] - v[0]) * r / lenPrev, v[1] + (prev[1] - v[1]) * r / lenPrev] : v;
		const b: Vec = !sharp && lenNext > 0 ? [v[0] + (next[0] - v[0]) * r / lenNext, v[1] + (next[1] - v[1]) * r / lenNext] : v;
		corners.push({ a, b, v });
	}
	const cmds: PathCommand[] = [{ kind: 'M', p: corners[0].b }];
	for (let i = 1; i <= n; i++) {
		const corner = corners[i % n];
		cmds.push({ kind: 'L', p: corner.a });
		if (corner.a === corner.v) {
			continue;
		}
		// A quadratic through the corner, written as a cubic.
		cmds.push({
			kind: 'C',
			c1: [corner.a[0] + (corner.v[0] - corner.a[0]) * 2 / 3, corner.a[1] + (corner.v[1] - corner.a[1]) * 2 / 3],
			c2: [corner.b[0] + (corner.v[0] - corner.b[0]) * 2 / 3, corner.b[1] + (corner.v[1] - corner.b[1]) * 2 / 3],
			p: corner.b,
		});
	}
	cmds.push({ kind: 'Z' });
	return cmds;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
	const kx = rx * KAPPA, ky = ry * KAPPA;
	return [
		{ kind: 'M', p: [cx + rx, cy] },
		{ kind: 'C', c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], p: [cx, cy + ry] },
		{ kind: 'C', c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], p: [cx - rx, cy] },
		{ kind: 'C', c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], p: [cx, cy - ry] },
		{ kind: 'C', c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], p: [cx + rx, cy] },
		{ kind: 'Z' },
	];
}

function ellipseOutline(cx: number, cy: number, rx: number, ry: number, steps = 48): Vec[] {
	const out: Vec[] = [];
	for (let i = 0; i < steps; i++) {
		const a = (i / steps) * Math.PI * 2;
		out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
	}
	return out;
}

function outlineOf(commands: readonly PathCommand[]): Vec[] {
	const polys = flattenPath(commands, 8);
	const outline = polys[0] ?? [];
	// Drop the closing duplicate.
	if (outline.length > 1) {
		const first = outline[0], last = outline[outline.length - 1];
		if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
			outline.pop();
		}
	}
	return outline;
}

function fromFill(fill: PathCommand[], extraStrokes: PathCommand[][] = []): IShapeGeometry {
	return { outline: outlineOf(fill), fill, strokes: [fill, ...extraStrokes] };
}

/** The cylinder's ellipse height for a box. */
export function cylinderRimHeight(width: number, height: number): number {
	return clamp(Math.min(width * 0.18, height * 0.16), 3, 40);
}

export function shapeGeometry(kind: ScratchShapeKind, width: number, height: number, roundness: ScratchRoundness): IShapeGeometry {
	const w = Math.max(1, Math.abs(width));
	const h = Math.max(1, Math.abs(height));
	const round = roundness === 'round';
	switch (kind) {
		case 'rectangle': {
			const fill = round ? roundedPolygonPath([[0, 0], [w, 0], [w, h], [0, h]], adaptiveRadius(w, h)) : polygonPath([[0, 0], [w, 0], [w, h], [0, h]]);
			return fromFill(fill);
		}
		case 'diamond': {
			const pts: Vec[] = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
			return fromFill(round ? roundedPolygonPath(pts, adaptiveRadius(w, h) * 0.6) : polygonPath(pts));
		}
		case 'ellipse': {
			const fill = ellipsePath(w / 2, h / 2, w / 2, h / 2);
			return { outline: ellipseOutline(w / 2, h / 2, w / 2, h / 2), fill, strokes: [fill] };
		}
		case 'triangle': {
			const pts: Vec[] = [[w / 2, 0], [w, h], [0, h]];
			return fromFill(round ? roundedPolygonPath(pts, adaptiveRadius(w, h) * 0.5) : polygonPath(pts));
		}
		case 'hexagon': {
			const inset = Math.min(w * 0.25, h * 0.5);
			const pts: Vec[] = [[inset, 0], [w - inset, 0], [w, h / 2], [w - inset, h], [inset, h], [0, h / 2]];
			return fromFill(round ? roundedPolygonPath(pts, adaptiveRadius(w, h) * 0.4) : polygonPath(pts));
		}
		case 'parallelogram': {
			const skew = Math.min(w * 0.25, h * 0.6);
			const pts: Vec[] = [[skew, 0], [w, 0], [w - skew, h], [0, h]];
			return fromFill(round ? roundedPolygonPath(pts, adaptiveRadius(w, h) * 0.5) : polygonPath(pts));
		}
		case 'pill': {
			return fromFill(roundedPolygonPathExact(w, h, Math.min(w, h) / 2));
		}
		case 'cylinder': {
			const ry = cylinderRimHeight(w, h);
			const rx = w / 2;
			const kx = rx * KAPPA, ky = ry * KAPPA;
			// Body: left side down, bottom front arc, right side up, top back arc.
			const fill: PathCommand[] = [
				{ kind: 'M', p: [0, ry] },
				{ kind: 'L', p: [0, h - ry] },
				{ kind: 'C', c1: [0, h - ry + ky], c2: [rx - kx, h], p: [rx, h] },
				{ kind: 'C', c1: [rx + kx, h], c2: [w, h - ry + ky], p: [w, h - ry] },
				{ kind: 'L', p: [w, ry] },
				{ kind: 'C', c1: [w, ry - ky], c2: [rx + kx, 0], p: [rx, 0] },
				{ kind: 'C', c1: [rx - kx, 0], c2: [0, ry - ky], p: [0, ry] },
				{ kind: 'Z' },
			];
			// The near half of the top rim.
			const rim: PathCommand[] = [
				{ kind: 'M', p: [0, ry] },
				{ kind: 'C', c1: [0, ry + ky], c2: [rx - kx, 2 * ry], p: [rx, 2 * ry] },
				{ kind: 'C', c1: [rx + kx, 2 * ry], c2: [w, ry + ky], p: [w, ry] },
			];
			return fromFill(fill, [rim]);
		}
		case 'document': {
			const a = Math.min(h * 0.09, 16);
			// Classic flowchart document: the bottom edge dips on the left and lifts on the right.
			const fill: PathCommand[] = [
				{ kind: 'M', p: [0, 0] },
				{ kind: 'L', p: [w, 0] },
				{ kind: 'L', p: [w, h - a] },
				{ kind: 'C', c1: [w * 0.75, h - 3.2 * a], c2: [w * 0.55, h - 2.2 * a], p: [w / 2, h - a] },
				{ kind: 'C', c1: [w * 0.45, h + 0.2 * a], c2: [w * 0.25, h + 1.2 * a], p: [0, h - a] },
				{ kind: 'Z' },
			];
			return fromFill(fill);
		}
		case 'cloud': {
			return fromFill(cloudPath(w, h));
		}
		case 'star': {
			const pts: Vec[] = [];
			for (let i = 0; i < 10; i++) {
				const angle = -Math.PI / 2 + i * Math.PI / 5;
				const r = i % 2 === 0 ? 1 : 0.42;
				pts.push([Math.cos(angle) * r, Math.sin(angle) * r]);
			}
			// Fit the unit star to the box.
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const [x, y] of pts) {
				minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
			}
			const fitted = pts.map(([x, y]): Vec => [(x - minX) / (maxX - minX) * w, (y - minY) / (maxY - minY) * h]);
			// Round edges soften the five points; the inner corners stay sharp (rounded, they curl).
			return fromFill(round ? roundedPolygonPath(fitted, fitted.map((_, i) => i % 2 === 0 ? Math.min(w, h) * 0.04 : 0)) : polygonPath(fitted));
		}
	}
}

function roundedPolygonPathExact(w: number, h: number, r: number): PathCommand[] {
	const rr = Math.min(r, w / 2, h / 2);
	const k = rr * KAPPA;
	return [
		{ kind: 'M', p: [rr, 0] },
		{ kind: 'L', p: [w - rr, 0] },
		{ kind: 'C', c1: [w - rr + k, 0], c2: [w, rr - k], p: [w, rr] },
		{ kind: 'L', p: [w, h - rr] },
		{ kind: 'C', c1: [w, h - rr + k], c2: [w - rr + k, h], p: [w - rr, h] },
		{ kind: 'L', p: [rr, h] },
		{ kind: 'C', c1: [rr - k, h], c2: [0, h - rr + k], p: [0, h - rr] },
		{ kind: 'L', p: [0, rr] },
		{ kind: 'C', c1: [0, rr - k], c2: [rr - k, 0], p: [rr, 0] },
		{ kind: 'Z' },
	];
}

/** Puffs around an inner ellipse; each puff bulges out along the ellipse normal. */
function cloudPath(w: number, h: number): PathCommand[] {
	const puffs = 9;
	const cx = w / 2, cy = h / 2;
	const bulge = Math.min(w, h) * 0.16;
	const rx = Math.max(1, w / 2 - bulge * 0.55);
	const ry = Math.max(1, h / 2 - bulge * 0.55);
	const at = (i: number): { p: Vec; n: Vec } => {
		// Start a little off the top so the puffs read as a cloud, not a flower.
		const angle = -Math.PI / 2 + 0.3 + (i / puffs) * Math.PI * 2;
		const p: Vec = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
		const nx = Math.cos(angle) / rx, ny = Math.sin(angle) / ry;
		const nl = Math.hypot(nx, ny) || 1;
		return { p, n: [nx / nl, ny / nl] };
	};
	const cmds: PathCommand[] = [];
	const first = at(0);
	cmds.push({ kind: 'M', p: first.p });
	for (let i = 0; i < puffs; i++) {
		const a = at(i);
		const b = at(i + 1);
		const k = bulge * 1.55;
		cmds.push({ kind: 'C', c1: [a.p[0] + a.n[0] * k, a.p[1] + a.n[1] * k], c2: [b.p[0] + b.n[0] * k, b.p[1] + b.n[1] * k], p: b.p });
	}
	cmds.push({ kind: 'Z' });
	// Scale into the box exactly: puffs can overshoot or fall short of the edges.
	const flat = flattenPath(cmds, 12)[0] ?? [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of flat) {
		minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
	}
	const sx = w / Math.max(1e-6, maxX - minX), sy = h / Math.max(1e-6, maxY - minY);
	const map = (p: Vec): Vec => [(p[0] - minX) * sx, (p[1] - minY) * sy];
	return cmds.map((c): PathCommand => {
		switch (c.kind) {
			case 'M': return { kind: 'M', p: map(c.p) };
			case 'L': return { kind: 'L', p: map(c.p) };
			case 'C': return { kind: 'C', c1: map(c.c1), c2: map(c.c2), p: map(c.p) };
			case 'Z': return c;
		}
	});
}

/** Ports where a connector can snap: the middle of each side of the box, in 0..1 coordinates. */
export const SHAPE_PORTS: readonly Vec[] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

/** A shape's size when it is placed with a click or from the library: each in its own proportions (a star is not squashed). */
export const SHAPE_DEFAULT_SIZE: Readonly<Record<ScratchShapeKind, readonly [number, number]>> = {
	rectangle: [180, 110], diamond: [140, 120], ellipse: [140, 120], triangle: [140, 122], hexagon: [150, 130],
	parallelogram: [180, 96], cylinder: [110, 130], pill: [180, 70], document: [160, 110], cloud: [190, 120], star: [140, 134],
};

/** Every shape the toolbar and library offer, with a label for menus. */
export const SHAPE_KINDS: readonly ScratchShapeKind[] = ['rectangle', 'diamond', 'ellipse', 'triangle', 'hexagon', 'parallelogram', 'cylinder', 'pill', 'document', 'cloud', 'star'];
