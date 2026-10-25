/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { boundsOfPoints, normalizeAngle, rotate, round2, unionBounds, Vec } from './scratchMath.js';
import { ScratchPatch } from './scratchFactory.js';
import { elementBox, elementCenter, geometricBounds, linearWorldPoints } from './scratchGeometry.js';
import { IScratchBinding, IScratchBounds, IScratchDrawElement, IScratchLinearElement, ScratchElement, ScratchPoint, ScratchPressurePoint, ScratchShapeKind } from './scratchTypes.js';

/**
 * Selection transforms: resize, rotate, move, flip, align and distribute. Each returns patches
 * keyed by element id; nothing is mutated. Connectors bound to what moved are re-placed by the
 * caller (scratchBinding.rebindConnector).
 */

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type ScratchPatchMap = Map<string, ScratchPatch>;

const EPS = 1e-6;
const MIN_FONT_SIZE = 4;

/** Where each handle sits on the box, 0..1 per axis. */
export const RESIZE_HANDLE_POSITIONS: Readonly<Record<ResizeHandle, Vec>> = {
	n: [0.5, 0], s: [0.5, 1], e: [1, 0.5], w: [0, 0.5],
	ne: [1, 0], nw: [0, 0], se: [1, 1], sw: [0, 1],
};

interface IExtent {
	/** New box origin in the old box's own frame. */
	readonly min: Vec;
	readonly width: number;
	readonly height: number;
	readonly sx: number;
	readonly sy: number;
}

/**
 * The new box for dragging `handle` to `local` (pointer in the old box's frame). The opposite
 * side stays put (the centre with `fromCenter`); a size never drops below `minSize` and never flips.
 * An axis with no size (a straight line) keeps none.
 */
function resizeExtent(w: number, h: number, handle: ResizeHandle, local: Vec, keepAspect: boolean, fromCenter: boolean, minSize: number): IExtent {
	const [hx, hy] = RESIZE_HANDLE_POSITIONS[handle];
	const horizontal = hx !== 0.5 && w > EPS;
	const vertical = hy !== 0.5 && h > EPS;
	let newW = w, newH = h;
	if (horizontal) {
		const reach = hx === 1 ? local[0] - (fromCenter ? w / 2 : 0) : (fromCenter ? w / 2 : w) - local[0];
		newW = fromCenter ? reach * 2 : reach;
	}
	if (vertical) {
		const reach = hy === 1 ? local[1] - (fromCenter ? h / 2 : 0) : (fromCenter ? h / 2 : h) - local[1];
		newH = fromCenter ? reach * 2 : reach;
	}
	if (keepAspect && w > EPS && h > EPS && (horizontal || vertical)) {
		let s = horizontal && vertical ? Math.max(newW / w, newH / h) : horizontal ? newW / w : newH / h;
		s = Math.max(s, minSize / w, minSize / h);
		newW = w * s;
		newH = h * s;
	} else {
		if (w > EPS) {
			newW = Math.max(minSize, newW);
		}
		if (h > EPS) {
			newH = Math.max(minSize, newH);
		}
	}
	const placeX = fromCenter || (!horizontal && hx === 0.5) ? (w - newW) / 2 : hx === 1 ? 0 : w - newW;
	const placeY = fromCenter || (!vertical && hy === 0.5) ? (h - newH) / 2 : hy === 1 ? 0 : h - newH;
	return {
		min: [w > EPS ? placeX : 0, h > EPS ? placeY : 0],
		width: newW,
		height: newH,
		sx: w > EPS ? newW / w : 1,
		sy: h > EPS ? newH / h : 1,
	};
}

function isPointElement(el: ScratchElement): el is IScratchLinearElement | IScratchDrawElement {
	return el.type === 'line' || el.type === 'arrow' || el.type === 'draw';
}

/** World points (pressure kept for strokes) to x, y, width, height and relative points. */
function pointsPatch(el: IScratchLinearElement | IScratchDrawElement, world: readonly Vec[]): ScratchPatch {
	const [x, y] = world[0] ?? [el.x, el.y];
	const b = boundsOfPoints(world.map((p): Vec => [p[0] - x, p[1] - y]));
	if (el.type === 'draw') {
		const points = world.map((p, i): ScratchPressurePoint => [round2(p[0] - x), round2(p[1] - y), el.points[i]?.[2] ?? 0.5]);
		return { x, y, width: b.maxX - b.minX, height: b.maxY - b.minY, points };
	}
	const points = world.map((p): ScratchPoint => [p[0] - x, p[1] - y]);
	return { x, y, width: b.maxX - b.minX, height: b.maxY - b.minY, points };
}

/**
 * Resizes one element by a handle. The opposite handle stays where it is on screen, rotation
 * included. Text: side handles fix its width, corners scale the type, top and bottom do nothing.
 */
export function resizeSingle(el: ScratchElement, handle: ResizeHandle, pointer: Vec, options: { readonly keepAspect: boolean; readonly fromCenter: boolean; readonly minSize?: number }): ScratchPatch {
	const box = elementBox(el);
	const center: Vec = [box.x + box.width / 2, box.y + box.height / 2];
	const unrotated = rotate(pointer, center, -el.angle);
	const local: Vec = [unrotated[0] - box.x, unrotated[1] - box.y];
	const corner = handle.length === 2;
	if (el.type === 'text' && (handle === 'n' || handle === 's')) {
		return {};
	}
	const keepAspect = options.keepAspect || (el.type === 'text' && corner);
	const ext = resizeExtent(box.width, box.height, handle, local, keepAspect, options.fromCenter, options.minSize ?? 1);
	const newCenter = rotate([box.x + ext.min[0] + ext.width / 2, box.y + ext.min[1] + ext.height / 2], center, el.angle);
	const origin: Vec = [newCenter[0] - ext.width / 2, newCenter[1] - ext.height / 2];

	if (isPointElement(el)) {
		const world = el.points.map((p): Vec => [
			origin[0] + (el.x + p[0] - box.x) * ext.sx,
			origin[1] + (el.y + p[1] - box.y) * ext.sy,
		]);
		return pointsPatch(el, world);
	}
	if (el.type === 'text') {
		if (corner) {
			return { x: origin[0], y: origin[1], width: ext.width, height: ext.height, fontSize: Math.max(MIN_FONT_SIZE, round2(el.fontSize * ext.sx)) };
		}
		return { x: origin[0], y: origin[1], width: ext.width, autoSize: false };
	}
	return { x: origin[0], y: origin[1], width: ext.width, height: ext.height };
}

/** How much a rotated box's own width and height stretch under a world-axis scale. */
function rotatedScale(angle: number, sx: number, sy: number): Vec {
	const cos = Math.cos(angle), sin = Math.sin(angle);
	return [Math.hypot(sx * cos, sy * sin), Math.hypot(sx * sin, sy * cos)];
}

/** Scales a whole selection inside its bounds. Uniform scaling also scales text and labels. */
export function resizeMany(elements: readonly ScratchElement[], startBounds: IScratchBounds, handle: ResizeHandle, pointer: Vec, options: { readonly keepAspect: boolean; readonly fromCenter: boolean }): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	const W = startBounds.maxX - startBounds.minX;
	const H = startBounds.maxY - startBounds.minY;
	const ext = resizeExtent(W, H, handle, [pointer[0] - startBounds.minX, pointer[1] - startBounds.minY], options.keepAspect, options.fromCenter, 1);
	const newMin: Vec = [startBounds.minX + ext.min[0], startBounds.minY + ext.min[1]];
	const map = (p: Vec): Vec => [newMin[0] + (p[0] - startBounds.minX) * ext.sx, newMin[1] + (p[1] - startBounds.minY) * ext.sy];
	const uniform = Math.abs(ext.sx - ext.sy) < 1e-6;
	for (const el of elements) {
		if (isPointElement(el)) {
			out.set(el.id, { ...pointsPatch(el, linearWorldPoints(el).map(map)), angle: 0 });
			continue;
		}
		const box = elementBox(el);
		const c = map(elementCenter(el));
		const [fw, fh] = el.angle ? rotatedScale(el.angle, ext.sx, ext.sy) : [ext.sx, ext.sy];
		let w = box.width * fw, h = box.height * fh;
		if (el.type === 'text' && !uniform) {
			// Stretching one way does not distort type: an auto-sized text only moves.
			w = el.autoSize ? box.width : w;
			h = box.height;
			out.set(el.id, { x: c[0] - w / 2, y: c[1] - h / 2, width: w, height: h });
			continue;
		}
		const patch: Record<string, unknown> = { x: c[0] - w / 2, y: c[1] - h / 2, width: w, height: h };
		if (uniform) {
			if (el.type === 'text' || el.type === 'note' || el.type === 'card') {
				patch.fontSize = Math.max(MIN_FONT_SIZE, round2(el.fontSize * ext.sx));
			} else if ((el.type === 'shape' || el.type === 'icon') && el.label) {
				patch.label = { ...el.label, fontSize: Math.max(MIN_FONT_SIZE, round2(el.label.fontSize * ext.sx)) };
			}
		}
		out.set(el.id, patch as ScratchPatch);
	}
	return out;
}

/** Turns each element around `center` by `delta` radians (and turns the element itself). */
export function rotateMany(elements: readonly ScratchElement[], center: Vec, delta: number): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	for (const el of elements) {
		const c = elementCenter(el);
		const nc = rotate(c, center, delta);
		out.set(el.id, { x: el.x + nc[0] - c[0], y: el.y + nc[1] - c[1], angle: normalizeAngle(el.angle + delta) });
	}
	return out;
}

export function moveMany(elements: readonly ScratchElement[], dx: number, dy: number): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	for (const el of elements) {
		out.set(el.id, { x: el.x + dx, y: el.y + dy });
	}
	return out;
}

/** Shapes whose top and bottom differ: a vertical flip turns them over (when no label would turn too). */
const TOP_HEAVY_SHAPES: ReadonlySet<ScratchShapeKind> = new Set(['triangle', 'document', 'star']);

function turnsOver(el: ScratchElement, axis: 'horizontal' | 'vertical'): boolean {
	return axis === 'vertical' && el.type === 'shape' && !el.label && TOP_HEAVY_SHAPES.has(el.shape);
}

/** Where an anchor ends up on a target that was flipped with the connector. */
function mirroredBinding(binding: IScratchBinding | null, axis: 'horizontal' | 'vertical', flipped: ReadonlyMap<string, ScratchElement>): IScratchBinding | null {
	const target = binding ? flipped.get(binding.elementId) : undefined;
	if (!binding?.anchor || !target) {
		return binding;
	}
	const [ax, ay] = binding.anchor;
	const anchor: ScratchPoint = axis === 'horizontal' || turnsOver(target, axis) ? [1 - ax, ay] : [ax, 1 - ay];
	return { ...binding, anchor };
}

/** Mirrors the selection inside its bounds. Text stays readable; connectors and strokes mirror their points. */
export function flipMany(elements: readonly ScratchElement[], axis: 'horizontal' | 'vertical'): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	const b = selectionBounds(elements);
	if (!b) {
		return out;
	}
	const mirror = (p: Vec): Vec => axis === 'horizontal' ? [b.minX + b.maxX - p[0], p[1]] : [p[0], b.minY + b.maxY - p[1]];
	const byId = new Map(elements.map(el => [el.id, el]));
	for (const el of elements) {
		if (isPointElement(el)) {
			const patch = { ...pointsPatch(el, linearWorldPoints(el).map(mirror)), angle: 0 };
			if (el.type !== 'draw') {
				out.set(el.id, { ...patch, startBinding: mirroredBinding(el.startBinding, axis, byId), endBinding: mirroredBinding(el.endBinding, axis, byId) });
			} else {
				out.set(el.id, patch);
			}
			continue;
		}
		const box = elementBox(el);
		const c = mirror(elementCenter(el));
		const angle = normalizeAngle(turnsOver(el, axis) ? Math.PI - el.angle : -el.angle);
		out.set(el.id, { x: c[0] - box.width / 2, y: c[1] - box.height / 2, angle });
	}
	return out;
}

/** Lines the selection up on one edge or centre of its bounds. */
export function alignMany(elements: readonly ScratchElement[], mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	const b = selectionBounds(elements);
	if (!b || elements.length < 2) {
		return out;
	}
	for (const el of elements) {
		const g = geometricBounds(el);
		let dx = 0, dy = 0;
		switch (mode) {
			case 'left': dx = b.minX - g.minX; break;
			case 'center': dx = (b.minX + b.maxX) / 2 - (g.minX + g.maxX) / 2; break;
			case 'right': dx = b.maxX - g.maxX; break;
			case 'top': dy = b.minY - g.minY; break;
			case 'middle': dy = (b.minY + b.maxY) / 2 - (g.minY + g.maxY) / 2; break;
			case 'bottom': dy = b.maxY - g.maxY; break;
		}
		if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
			out.set(el.id, { x: el.x + dx, y: el.y + dy });
		}
	}
	return out;
}

/** Equal gaps between the boxes along an axis; the first and last stay where they are. */
export function distributeMany(elements: readonly ScratchElement[], axis: 'horizontal' | 'vertical'): ScratchPatchMap {
	const out: ScratchPatchMap = new Map();
	if (elements.length < 3) {
		return out;
	}
	const horizontal = axis === 'horizontal';
	const items = elements.map(el => {
		const g = geometricBounds(el);
		const min = horizontal ? g.minX : g.minY;
		const max = horizontal ? g.maxX : g.maxY;
		return { el, min, max, center: (min + max) / 2 };
	}).sort((a, b) => a.center - b.center);
	const first = items[0], last = items[items.length - 1];
	const span = last.max - first.min;
	const total = items.reduce((sum, item) => sum + (item.max - item.min), 0);
	const gap = (span - total) / (items.length - 1);
	let cursor = first.max + gap;
	for (let i = 1; i < items.length - 1; i++) {
		const item = items[i];
		const d = cursor - item.min;
		if (Math.abs(d) > EPS) {
			out.set(item.el.id, horizontal ? { x: item.el.x + d } : { y: item.el.y + d });
		}
		cursor += item.max - item.min + gap;
	}
	return out;
}

/** The box around everything drawn (no stroke padding): selection outline, flip and align bounds. */
export function selectionBounds(elements: readonly ScratchElement[]): IScratchBounds | undefined {
	return unionBounds(elements.map(geometricBounds));
}
