/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRgbaImage } from './imageAnalysis.js';

/** x, y, width, height. */
export type AxBox = readonly [number, number, number, number];

export interface IAxItem {
	readonly ref: string;
	readonly role: string;
	readonly name: string;
	readonly box: AxBox;
	readonly states?: readonly string[];
	readonly value?: string;
}

export interface IAxProjection {
	/** Top-left of the captured area, in the page's CSS pixels. */
	readonly origin: { readonly x: number; readonly y: number };
	/** Image pixels per CSS pixel. */
	readonly scale: number;
	readonly width: number;
	readonly height: number;
}

/** Moves CSS-pixel boxes onto the image, clipped to it; boxes that miss the image are dropped. */
export function placeOnImage(items: readonly IAxItem[], projection: IAxProjection): IAxItem[] {
	const placed: IAxItem[] = [];
	for (const item of items) {
		const [x, y, w, h] = item.box;
		const left = Math.max(0, (x - projection.origin.x) * projection.scale);
		const top = Math.max(0, (y - projection.origin.y) * projection.scale);
		const right = Math.min(projection.width, (x + w - projection.origin.x) * projection.scale);
		const bottom = Math.min(projection.height, (y + h - projection.origin.y) * projection.scale);
		if (right - left < 1 || bottom - top < 1) {
			continue;
		}
		placed.push({ ...item, box: [Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top)] });
	}
	return placed;
}

/** Items that lie inside the viewport, in reading order (rows of 12 px, then left to right). */
export function visibleInViewport(items: readonly IAxItem[], viewport: { readonly width: number; readonly height: number }): IAxItem[] {
	return items.filter(item => {
		const [x, y, w, h] = item.box;
		return x < viewport.width && y < viewport.height && x + w > 0 && y + h > 0;
	});
}

export function readingOrder(items: readonly IAxItem[]): IAxItem[] {
	return [...items].sort((a, b) => {
		const row = Math.floor(a.box[1] / 12) - Math.floor(b.box[1] / 12);
		return row !== 0 ? row : a.box[0] - b.box[0];
	});
}

export function formatAxLine(item: IAxItem): string {
	const parts = [`- ${item.ref} ${item.role}`];
	if (item.name) {
		parts.push(JSON.stringify(item.name));
	}
	if (item.value !== undefined && item.value !== '') {
		parts.push(`value=${JSON.stringify(item.value)}`);
	}
	if (item.states?.length) {
		parts.push(`[${item.states.join(', ')}]`);
	}
	parts.push(`box=[${item.box.join(', ')}]`);
	return parts.join(' ');
}

export interface IAxDiff {
	readonly added: readonly IAxItem[];
	readonly removed: readonly IAxItem[];
	readonly changed: readonly IAxItem[];
	readonly unchanged: number;
}

/** Compares two listings of the same document by ref. Positions are ignored: the image shows them. */
export function diffAx(previous: readonly IAxItem[], current: readonly IAxItem[]): IAxDiff {
	const before = new Map(previous.map(item => [item.ref, item]));
	const added: IAxItem[] = [];
	const changed: IAxItem[] = [];
	let unchanged = 0;
	for (const item of current) {
		const old = before.get(item.ref);
		if (!old) {
			added.push(item);
			continue;
		}
		before.delete(item.ref);
		if (signature(old) === signature(item)) {
			unchanged++;
		} else {
			changed.push(item);
		}
	}
	return { added, removed: [...before.values()], changed, unchanged };
}

function signature(item: IAxItem): string {
	return JSON.stringify([item.role, item.name, item.value ?? null, item.states ?? []]);
}

const OUTLINE: readonly [number, number, number, number] = [255, 59, 48, 255];

/** Draws thin outlines on a copy of the image, one per box. */
export function strokeBoxes(image: IRgbaImage, boxes: readonly AxBox[], thickness = 2): IRgbaImage {
	const data = new Uint8ClampedArray(image.data);
	const paint = (x: number, y: number) => {
		if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
			return;
		}
		const at = (y * image.width + x) * 4;
		data.set(OUTLINE, at);
	};
	for (const [x, y, w, h] of boxes) {
		const x1 = x + w - 1;
		const y1 = y + h - 1;
		for (let t = 0; t < thickness; t++) {
			for (let i = x; i <= x1; i++) {
				paint(i, y + t);
				paint(i, y1 - t);
			}
			for (let j = y; j <= y1; j++) {
				paint(x + t, j);
				paint(x1 - t, j);
			}
		}
	}
	return { width: image.width, height: image.height, data };
}
