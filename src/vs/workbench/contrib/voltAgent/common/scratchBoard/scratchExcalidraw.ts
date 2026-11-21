/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isValidColor } from './scratchColor.js';
import { createDraw, createFrame, createImage, createLabel, createLinear, createShape, createText } from './scratchFactory.js';
import { plainTextToHtml } from './scratchHtml.js';
import {
	DEFAULT_SCRATCH_STYLE, IScratchBinding, IScratchLabel, ScratchArrowhead, ScratchElement, ScratchFillStyle, ScratchFontFamily, ScratchPoint,
	ScratchPressurePoint, ScratchShapeKind, ScratchStrokeStyle, ScratchTextAlign, ScratchVerticalAlign,
} from './scratchTypes.js';

/**
 * Excalidraw scenes on a board: what Excalidraw puts on the clipboard (`excalidraw/clipboard`) and
 * what a `.excalidraw` file holds (`excalidraw`). Both carry the same elements; they become the
 * board's own, drawn the same way (same palette, roughness, Excalifont), with text in a shape or
 * on an arrow turned into that element's label and arrows kept on the shapes they were bound to.
 */

type Json = Record<string, unknown>;

export interface IExcalidrawScene {
	readonly elements: readonly Json[];
	/** fileId → image data, for image elements. */
	readonly files: Readonly<Record<string, IExcalidrawFile>>;
}

export interface IExcalidrawFile {
	readonly id: string;
	readonly mimeType: string;
	readonly dataURL: string;
}

/** An image of the scene saved in the board's assets. */
export interface IExcalidrawAsset {
	readonly assetId: string;
	readonly mime: string;
	readonly width: number;
	readonly height: number;
}

export interface IExcalidrawImport {
	readonly elements: ScratchElement[];
	/** Images whose pixels were not in the scene (Excalidraw leaves them out of some copies). */
	readonly missingImages: number;
}

function isObject(v: unknown): v is Json {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function color(v: unknown, fallback: string): string {
	return typeof v === 'string' && isValidColor(v) ? v : fallback;
}

/** The scene in Excalidraw clipboard or file JSON; undefined for any other text. */
export function readExcalidrawScene(text: string | undefined): IExcalidrawScene | undefined {
	if (!text || !text.trimStart().startsWith('{') || !text.includes('excalidraw')) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || (parsed.type !== 'excalidraw/clipboard' && parsed.type !== 'excalidraw') || !Array.isArray(parsed.elements)) {
		return undefined;
	}
	const elements = parsed.elements.filter((el): el is Json => isObject(el) && typeof el.id === 'string' && typeof el.type === 'string' && el.isDeleted !== true);
	if (!elements.length) {
		return undefined;
	}
	const files: Record<string, IExcalidrawFile> = {};
	if (isObject(parsed.files)) {
		for (const [id, file] of Object.entries(parsed.files)) {
			if (isObject(file) && typeof file.dataURL === 'string' && file.dataURL.startsWith('data:image/')) {
				const mimeType = typeof file.mimeType === 'string' && file.mimeType.startsWith('image/') ? file.mimeType : file.dataURL.slice(5, file.dataURL.indexOf(';'));
				files[id] = { id, mimeType, dataURL: file.dataURL };
			}
		}
	}
	return { elements, files };
}

/** The files the scene's image elements draw, each once. */
export function excalidrawImageFiles(scene: IExcalidrawScene): IExcalidrawFile[] {
	const out = new Map<string, IExcalidrawFile>();
	for (const el of scene.elements) {
		const file = el.type === 'image' && typeof el.fileId === 'string' ? scene.files[el.fileId] : undefined;
		if (file) {
			out.set(file.id, file);
		}
	}
	return [...out.values()];
}

const FILL_STYLES: Readonly<Record<string, ScratchFillStyle>> = { hachure: 'hachure', 'cross-hatch': 'cross-hatch', zigzag: 'hachure', solid: 'solid' };
const STROKE_STYLES: Readonly<Record<string, ScratchStrokeStyle>> = { solid: 'solid', dashed: 'dashed', dotted: 'dotted' };
const SHAPES: Readonly<Record<string, ScratchShapeKind>> = { rectangle: 'rectangle', diamond: 'diamond', ellipse: 'ellipse' };
const ARROWHEADS: Readonly<Record<string, ScratchArrowhead>> = {
	arrow: 'arrow', bar: 'bar',
	// Excalidraw's `circle` (and the older `dot`) is filled; the board's filled one is `dot`.
	dot: 'dot', circle: 'dot', circle_outline: 'circle',
	triangle: 'triangle', triangle_outline: 'triangle-outline',
	diamond: 'diamond', diamond_outline: 'diamond-outline',
	crowfoot_one: 'crowfoot-one', crowfoot_many: 'crowfoot-many', crowfoot_one_or_many: 'crowfoot-one-or-many',
};
const ALIGNS: readonly ScratchTextAlign[] = ['left', 'center', 'right'];
const VERTICAL_ALIGNS: Readonly<Record<string, ScratchVerticalAlign>> = { top: 'top', middle: 'middle', bottom: 'bottom' };

/** Excalidraw's font ids: Virgil and Excalifont are the hand, then its sans, code and comic fonts. */
function fontFamily(v: unknown): ScratchFontFamily {
	switch (v) {
		case 2: case 6: case 7: case 9: return 'sans';
		case 3: case 8: return 'mono';
		default: return 'hand';
	}
}

function arrowhead(v: unknown): ScratchArrowhead {
	return typeof v === 'string' ? ARROWHEADS[v] ?? 'arrow' : 'none';
}

function textOf(el: Json): string {
	// `text` holds Excalidraw's own wrapping of a fixed-width box; `originalText` is what was typed.
	return typeof el.originalText === 'string' ? el.originalText : typeof el.text === 'string' ? el.text : '';
}

/**
 * A bound end. Excalidraw's `fixedPoint` is where on the target's box the arrow aims; one on the
 * box's edge (a side's midpoint, a corner) stays there, one inside it aims at the middle like the
 * board's unanchored ends, so the arrow lands on the outline facing the other end.
 */
function binding(v: unknown, labelOwner: ReadonlyMap<string, string>): IScratchBinding | null {
	if (!isObject(v) || typeof v.elementId !== 'string' || !v.elementId) {
		return null;
	}
	const elementId = labelOwner.get(v.elementId) ?? v.elementId;
	const fixed = v.fixedPoint;
	if (Array.isArray(fixed) && typeof fixed[0] === 'number' && typeof fixed[1] === 'number') {
		const fx = Math.min(1, Math.max(0, fixed[0])), fy = Math.min(1, Math.max(0, fixed[1]));
		const edge = 0.02;
		if (fx <= edge || fx >= 1 - edge || fy <= edge || fy >= 1 - edge) {
			// Excalidraw nudges side midpoints to 0.5001 so they keep a direction.
			const snap = (n: number) => Math.abs(n - 0.5) < 0.001 ? 0.5 : n;
			return { elementId, anchor: [snap(fx), snap(fy)] };
		}
	}
	return { elementId, anchor: null };
}

/**
 * Points in world space with the element's rotation applied (the board keeps connectors and
 * strokes unrotated), turning around the middle of their box like Excalidraw does.
 */
function worldPoints(el: Json, angle: number): [number, number][] | undefined {
	if (!Array.isArray(el.points)) {
		return undefined;
	}
	const local = el.points.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
	if (!local.length) {
		return undefined;
	}
	const x = num(el.x, 0), y = num(el.y, 0);
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [px, py] of local) {
		minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
	}
	const cx = x + (minX + maxX) / 2, cy = y + (minY + maxY) / 2;
	const cos = Math.cos(angle), sin = Math.sin(angle);
	return local.map(([px, py]) => {
		const dx = x + px - cx, dy = y + py - cy;
		return angle ? [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] : [x + px, y + py];
	});
}

/** The scene's elements as the board's, in the same stacking order. */
export function excalidrawToScratch(scene: IExcalidrawScene, assets: ReadonlyMap<string, IExcalidrawAsset> = new Map()): IExcalidrawImport {
	const byId = new Map(scene.elements.map(el => [el.id as string, el]));
	// Text written in a shape or on an arrow is that element's label.
	const labelOf = new Map<string, Json>();
	const labelOwner = new Map<string, string>();
	for (const el of scene.elements) {
		if (el.type === 'text' && typeof el.containerId === 'string' && byId.has(el.containerId) && textOf(el).trim()) {
			labelOf.set(el.containerId, el);
			labelOwner.set(el.id as string, el.containerId);
		}
	}

	const out: ScratchElement[] = [];
	let missingImages = 0;
	for (const el of scene.elements) {
		const id = el.id as string;
		if (labelOwner.has(id)) {
			continue;
		}
		const angle = num(el.angle, 0);
		const stroke = color(el.strokeColor, DEFAULT_SCRATCH_STYLE.stroke);
		const base = {
			id,
			x: num(el.x, 0),
			y: num(el.y, 0),
			width: Math.max(0, num(el.width, 0)),
			height: Math.max(0, num(el.height, 0)),
			angle,
			stroke,
			fill: color(el.backgroundColor, 'transparent'),
			fillStyle: FILL_STYLES[el.fillStyle as string] ?? 'hachure',
			strokeWidth: Math.min(64, Math.max(0, num(el.strokeWidth, 2))),
			strokeStyle: STROKE_STYLES[el.strokeStyle as string] ?? 'solid',
			roughness: Math.min(3, Math.max(0, num(el.roughness, 1))),
			opacity: Math.min(100, Math.max(0, num(el.opacity, 100))),
			roundness: isObject(el.roundness) ? 'round' as const : 'sharp' as const,
			seed: Math.floor(Math.abs(num(el.seed, 1))) % 2 ** 31,
			groupIds: Array.isArray(el.groupIds) ? el.groupIds.filter((g): g is string => typeof g === 'string' && !!g) : [],
			frameId: typeof el.frameId === 'string' && el.frameId ? el.frameId : null,
			locked: el.locked === true,
			link: typeof el.link === 'string' && el.link ? el.link : null,
		};
		const textLabel = labelOf.get(id);
		const label = (verticalDefault: ScratchVerticalAlign): IScratchLabel | null => {
			if (!textLabel) {
				return null;
			}
			const textColor = color(textLabel.strokeColor, stroke);
			return createLabel(plainTextToHtml(textOf(textLabel)), DEFAULT_SCRATCH_STYLE, {
				fontFamily: fontFamily(textLabel.fontFamily),
				fontSize: Math.min(400, Math.max(4, num(textLabel.fontSize, 20))),
				textAlign: ALIGNS.includes(textLabel.textAlign as ScratchTextAlign) ? textLabel.textAlign as ScratchTextAlign : 'center',
				verticalAlign: VERTICAL_ALIGNS[textLabel.verticalAlign as string] ?? verticalDefault,
				...(textColor.toLowerCase() !== stroke.toLowerCase() ? { color: textColor } : {}),
			});
		};

		switch (el.type) {
			case 'rectangle':
			case 'diamond':
			case 'ellipse':
				out.push(createShape({ ...base, shape: SHAPES[el.type], label: label('middle') }));
				break;
			case 'embeddable':
			case 'iframe': {
				// Web embeds have no counterpart: a box that links to the page.
				const href = base.link ?? '';
				out.push(createShape({ ...base, shape: 'rectangle', label: href ? createLabel(plainTextToHtml(href)) : label('middle') }));
				break;
			}
			case 'text': {
				const text = textOf(el);
				if (!text.trim()) {
					break;
				}
				const autoSize = el.autoResize !== false;
				out.push(createText({
					...base,
					html: plainTextToHtml(text),
					autoSize,
					fontFamily: fontFamily(el.fontFamily),
					fontSize: Math.min(400, Math.max(4, num(el.fontSize, 20))),
					textAlign: ALIGNS.includes(el.textAlign as ScratchTextAlign) ? el.textAlign as ScratchTextAlign : 'left',
				}));
				break;
			}
			case 'arrow':
			case 'line': {
				const world = worldPoints(el, angle);
				if (!world) {
					break;
				}
				// Excalidraw sometimes keeps a repeated point (a click without a drag).
				const deduped = world.filter((p, i) => i === 0 || Math.hypot(p[0] - world[i - 1][0], p[1] - world[i - 1][1]) > 0.01);
				if (deduped.length < 2) {
					break;
				}
				const [x0, y0] = deduped[0];
				const points = deduped.map((p): ScratchPoint => [p[0] - x0, p[1] - y0]);
				const first = points[0], last = points[points.length - 1];
				const closed = el.type === 'line' && (el.polygon === true || (points.length > 2 && Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.5));
				out.push(createLinear({
					...base,
					x: x0,
					y: y0,
					angle: 0,
					// Only a closed line fills, as in Excalidraw.
					fill: closed ? base.fill : 'transparent',
					type: el.type,
					points,
					arrowType: el.elbowed === true ? 'elbow' : isObject(el.roundness) ? 'round' : 'sharp',
					startArrowhead: arrowhead(el.startArrowhead),
					endArrowhead: arrowhead(el.endArrowhead),
					startBinding: binding(el.startBinding, labelOwner),
					endBinding: binding(el.endBinding, labelOwner),
					label: label('middle'),
					closed,
				}));
				break;
			}
			case 'freedraw': {
				const world = worldPoints(el, angle);
				if (!world) {
					break;
				}
				const pressures = Array.isArray(el.pressures) ? el.pressures : [];
				const simulatePressure = el.simulatePressure !== false || !pressures.length;
				const [x0, y0] = world[0];
				const points = world.map((p, i): ScratchPressurePoint => {
					const pressure = simulatePressure ? 0.5 : num(pressures[i], 0.5);
					return [p[0] - x0, p[1] - y0, Math.min(1, Math.max(0, pressure))];
				});
				out.push(createDraw({ ...base, x: x0, y: y0, angle: 0, points, simulatePressure, pen: 'pen' }));
				break;
			}
			case 'image': {
				const asset = typeof el.fileId === 'string' ? assets.get(el.fileId) : undefined;
				if (!asset) {
					missingImages++;
					break;
				}
				out.push(createImage({ ...base, strokeWidth: 0, assetId: asset.assetId, mime: asset.mime, naturalWidth: asset.width, naturalHeight: asset.height }));
				break;
			}
			case 'frame':
			case 'magicframe':
				out.push(createFrame({ id, x: base.x, y: base.y, width: base.width, height: base.height, groupIds: base.groupIds, locked: base.locked, name: typeof el.name === 'string' && el.name ? el.name : undefined }));
				break;
		}
	}

	// Elements whose frame was not copied with them are loose.
	const ids = new Set(out.map(el => el.id));
	const elements = out.map(el => el.frameId && !ids.has(el.frameId) ? { ...el, frameId: null } : el);
	return { elements, missingImages };
}
