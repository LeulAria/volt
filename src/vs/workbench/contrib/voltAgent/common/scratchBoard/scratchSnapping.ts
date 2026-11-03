/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Vec } from './scratchMath.js';
import { IScratchBounds } from './scratchTypes.js';

/**
 * Smart guides: while something moves, its edges and centre line up with the edges and centres
 * of the boxes around it, and a guide line shows what it lined up with.
 */

/** `axis: 'x'` is a vertical line at x = value spanning y from..to; `'y'` a horizontal one. */
export interface ISnapGuide {
	readonly axis: 'x' | 'y';
	readonly value: number;
	readonly from: number;
	readonly to: number;
}

export interface ISnapResult {
	readonly dx: number;
	readonly dy: number;
	readonly guides: ISnapGuide[];
}

/** Matches within this after snapping draw a guide (all equal lines show, not just the winner). */
const GUIDE_EPSILON = 0.5;

function xLines(b: IScratchBounds): number[] {
	return [b.minX, (b.minX + b.maxX) / 2, b.maxX];
}

function yLines(b: IScratchBounds): number[] {
	return [b.minY, (b.minY + b.maxY) / 2, b.maxY];
}

/** The smallest offset (within threshold) that lines one of `moving` up with one of `targets`. */
function bestOffset(moving: readonly number[], targets: readonly number[], threshold: number): number | undefined {
	let best: number | undefined;
	for (const m of moving) {
		for (const t of targets) {
			const d = t - m;
			if (Math.abs(d) <= threshold && (best === undefined || Math.abs(d) < Math.abs(best))) {
				best = d;
			}
		}
	}
	return best;
}

function mergeGuides(guides: ISnapGuide[]): ISnapGuide[] {
	const merged = new Map<string, ISnapGuide>();
	for (const g of guides) {
		const key = `${g.axis}:${Math.round(g.value * 100)}`;
		const existing = merged.get(key);
		merged.set(key, existing ? { ...existing, from: Math.min(existing.from, g.from), to: Math.max(existing.to, g.to) } : g);
	}
	return [...merged.values()];
}

/** Snaps a moving box to the others' edges and centres, per axis, within `threshold`. */
export function snapBounds(moving: IScratchBounds, others: readonly IScratchBounds[], threshold: number): ISnapResult {
	const otherX = others.flatMap(xLines);
	const otherY = others.flatMap(yLines);
	const dx = bestOffset(xLines(moving), otherX, threshold) ?? 0;
	const dy = bestOffset(yLines(moving), otherY, threshold) ?? 0;
	const snapped: IScratchBounds = { minX: moving.minX + dx, minY: moving.minY + dy, maxX: moving.maxX + dx, maxY: moving.maxY + dy };
	const guides: ISnapGuide[] = [];
	for (const other of others) {
		for (const m of xLines(snapped)) {
			for (const o of xLines(other)) {
				if (Math.abs(m - o) < GUIDE_EPSILON) {
					guides.push({ axis: 'x', value: o, from: Math.min(snapped.minY, other.minY), to: Math.max(snapped.maxY, other.maxY) });
				}
			}
		}
		for (const m of yLines(snapped)) {
			for (const o of yLines(other)) {
				if (Math.abs(m - o) < GUIDE_EPSILON) {
					guides.push({ axis: 'y', value: o, from: Math.min(snapped.minX, other.minX), to: Math.max(snapped.maxX, other.maxX) });
				}
			}
		}
	}
	return { dx, dy, guides: mergeGuides(guides) };
}

/** Snaps a single point (a drawing corner, a connector end) to the others' edges and centres. */
export function snapPoint(p: Vec, others: readonly IScratchBounds[], threshold: number): { readonly point: Vec; readonly guides: ISnapGuide[] } {
	const result = snapBounds({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, others, threshold);
	return { point: [p[0] + result.dx, p[1] + result.dy], guides: result.guides };
}

export function snapToGrid(value: number, size: number): number {
	return size > 0 ? Math.round(value / size) * size : value;
}
