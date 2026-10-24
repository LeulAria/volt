/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import { randomSeed } from './scratchMath.js';
import {
	DEFAULT_SCRATCH_STYLE, IScratchCardElement, IScratchDrawElement, IScratchElementBase, IScratchFrameElement, IScratchIconElement,
	IScratchImageElement, IScratchLabel, IScratchLinearElement, IScratchNoteElement, IScratchShapeElement, IScratchStyleDefaults,
	IScratchTextElement, ScratchElement, ScratchPoint, ScratchPressurePoint, ScratchShapeKind,
} from './scratchTypes.js';

/** Short ids keep saved boards compact; uuids keep them unique across windows. */
export function newElementId(): string {
	return generateUuid().replace(/-/g, '').slice(0, 20);
}

type BaseInput = Partial<Omit<IScratchElementBase, 'type'>> & { readonly x: number; readonly y: number };

function base(type: ScratchElement['type'], input: BaseInput, style: IScratchStyleDefaults): IScratchElementBase {
	return {
		id: input.id ?? newElementId(),
		type,
		x: input.x,
		y: input.y,
		width: input.width ?? 0,
		height: input.height ?? 0,
		angle: input.angle ?? 0,
		stroke: input.stroke ?? style.stroke,
		fill: input.fill ?? style.fill,
		fillStyle: input.fillStyle ?? style.fillStyle,
		strokeWidth: input.strokeWidth ?? style.strokeWidth,
		strokeStyle: input.strokeStyle ?? style.strokeStyle,
		roughness: input.roughness ?? style.roughness,
		opacity: input.opacity ?? style.opacity,
		roundness: input.roundness ?? style.roundness,
		seed: input.seed ?? randomSeed(),
		version: input.version ?? 1,
		updated: input.updated ?? Date.now(),
		groupIds: input.groupIds ?? [],
		frameId: input.frameId ?? null,
		locked: input.locked ?? false,
		link: input.link ?? null,
	};
}

export function createLabel(html: string, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE, overrides: Partial<IScratchLabel> = {}): IScratchLabel {
	return {
		html,
		fontFamily: overrides.fontFamily ?? style.fontFamily,
		fontSize: overrides.fontSize ?? style.fontSize,
		textAlign: overrides.textAlign ?? 'center',
		verticalAlign: overrides.verticalAlign ?? 'middle',
	};
}

export function createShape(input: BaseInput & { readonly shape: ScratchShapeKind; readonly label?: IScratchLabel | null }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchShapeElement {
	return { ...base('shape', input, style), type: 'shape', shape: input.shape, label: input.label ?? null };
}

export function createLinear(input: BaseInput & {
	readonly type: 'line' | 'arrow';
	readonly points: readonly ScratchPoint[];
	readonly arrowType?: IScratchLinearElement['arrowType'];
	readonly startArrowhead?: IScratchLinearElement['startArrowhead'];
	readonly endArrowhead?: IScratchLinearElement['endArrowhead'];
	readonly startBinding?: IScratchLinearElement['startBinding'];
	readonly endBinding?: IScratchLinearElement['endBinding'];
	readonly label?: IScratchLabel | null;
	readonly closed?: boolean;
}, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchLinearElement {
	const isArrow = input.type === 'arrow';
	const el: IScratchLinearElement = {
		...base(input.type, input, style),
		type: input.type,
		points: input.points,
		arrowType: input.arrowType ?? (isArrow ? style.arrowType : 'sharp'),
		startArrowhead: input.startArrowhead ?? (isArrow ? style.startArrowhead : 'none'),
		endArrowhead: input.endArrowhead ?? (isArrow ? style.endArrowhead : 'none'),
		startBinding: input.startBinding ?? null,
		endBinding: input.endBinding ?? null,
		label: input.label ?? null,
		closed: input.closed ?? false,
	};
	return withLinearBox(el);
}

/** Recomputes width and height from the points (x, y stay the first point). */
export function withLinearBox<T extends IScratchLinearElement | IScratchDrawElement>(el: T): T {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of el.points) {
		minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
	}
	if (minX === Infinity) {
		return { ...el, width: 0, height: 0 };
	}
	return { ...el, width: maxX - minX, height: maxY - minY };
}

export function createDraw(input: BaseInput & { readonly points: readonly ScratchPressurePoint[]; readonly pen?: IScratchDrawElement['pen']; readonly simulatePressure: boolean }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchDrawElement {
	const el: IScratchDrawElement = {
		...base('draw', input, style),
		type: 'draw',
		points: input.points,
		pen: input.pen ?? style.pen,
		simulatePressure: input.simulatePressure,
		fill: 'transparent',
	};
	return withLinearBox(el);
}

export function createText(input: BaseInput & { readonly html: string; readonly autoSize?: boolean; readonly fontFamily?: IScratchTextElement['fontFamily']; readonly fontSize?: number; readonly textAlign?: IScratchTextElement['textAlign'] }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchTextElement {
	return {
		...base('text', input, style),
		type: 'text',
		fill: 'transparent',
		html: input.html,
		fontFamily: input.fontFamily ?? style.fontFamily,
		fontSize: input.fontSize ?? style.fontSize,
		textAlign: input.textAlign ?? style.textAlign,
		autoSize: input.autoSize ?? true,
	};
}

export function createNote(input: BaseInput & { readonly html?: string; readonly fontFamily?: IScratchNoteElement['fontFamily']; readonly fontSize?: number; readonly textAlign?: IScratchNoteElement['textAlign'] }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchNoteElement {
	return {
		...base('note', { width: 220, height: 220, ...input }, style),
		type: 'note',
		fill: input.fill ?? style.noteColor,
		fillStyle: 'solid',
		html: input.html ?? '',
		fontFamily: input.fontFamily ?? style.fontFamily,
		fontSize: input.fontSize ?? SCRATCH_NOTE_FONT_SIZE,
		textAlign: input.textAlign ?? 'left',
	};
}

export const SCRATCH_NOTE_FONT_SIZE = 20;
export const SCRATCH_CARD_FONT_SIZE = 15;

export function createCard(input: BaseInput & { readonly html?: string; readonly fontFamily?: IScratchCardElement['fontFamily']; readonly fontSize?: number }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchCardElement {
	return {
		...base('card', { width: 420, height: 240, ...input }, style),
		type: 'card',
		fill: input.fill ?? '#ffffff',
		fillStyle: 'solid',
		roughness: input.roughness ?? 0,
		strokeWidth: input.strokeWidth ?? 1,
		html: input.html ?? '',
		fontFamily: input.fontFamily ?? 'sans',
		fontSize: input.fontSize ?? SCRATCH_CARD_FONT_SIZE,
		textAlign: 'left',
	};
}

export function createImage(input: BaseInput & { readonly assetId: string; readonly mime: string; readonly naturalWidth: number; readonly naturalHeight: number }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchImageElement {
	return {
		...base('image', input, style),
		type: 'image',
		fill: 'transparent',
		strokeWidth: input.strokeWidth ?? 0,
		assetId: input.assetId,
		mime: input.mime,
		naturalWidth: input.naturalWidth,
		naturalHeight: input.naturalHeight,
	};
}

export function createIcon(input: BaseInput & { readonly iconId: string; readonly svg: string; readonly tintable: boolean; readonly label?: IScratchLabel | null }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchIconElement {
	return {
		...base('icon', { width: 64, height: 64, ...input }, style),
		type: 'icon',
		fill: 'transparent',
		iconId: input.iconId,
		svg: input.svg,
		tintable: input.tintable,
		label: input.label ?? null,
	};
}

export function createFrame(input: BaseInput & { readonly name?: string }, style: IScratchStyleDefaults = DEFAULT_SCRATCH_STYLE): IScratchFrameElement {
	return {
		...base('frame', input, style),
		type: 'frame',
		stroke: input.stroke ?? '#868e96',
		fill: input.fill ?? 'transparent',
		strokeWidth: 1,
		roughness: 0,
		roundness: 'round',
		name: input.name ?? 'Frame',
	};
}

/** A change to an element: the fields to replace. `id`, `type`, `version` and `updated` are managed. */
export type ScratchPatch<T extends ScratchElement = ScratchElement> = T extends ScratchElement ? Partial<Omit<T, 'id' | 'type' | 'version' | 'updated'>> : never;

export function applyPatch<T extends ScratchElement>(el: T, patch: ScratchPatch<T> | ScratchPatch, now = Date.now()): T {
	return { ...el, ...patch, id: el.id, type: el.type, version: el.version + 1, updated: now };
}

/** Copies with fresh ids (and fresh group ids), keeping links between the copies. */
export function duplicateElements(elements: readonly ScratchElement[], offset: ScratchPoint = [0, 0], now = Date.now()): { readonly elements: ScratchElement[]; readonly idMap: Map<string, string> } {
	const idMap = new Map<string, string>();
	const groupMap = new Map<string, string>();
	for (const el of elements) {
		idMap.set(el.id, newElementId());
	}
	const remapGroup = (g: string) => {
		let next = groupMap.get(g);
		if (!next) {
			next = newElementId();
			groupMap.set(g, next);
		}
		return next;
	};
	const out = elements.map(el => {
		const copy: Record<string, unknown> = {
			...el,
			id: idMap.get(el.id)!,
			x: el.x + offset[0],
			y: el.y + offset[1],
			seed: randomSeed(),
			version: 1,
			updated: now,
			groupIds: el.groupIds.map(remapGroup),
			frameId: el.frameId && idMap.has(el.frameId) ? idMap.get(el.frameId)! : el.frameId,
		};
		if (el.type === 'line' || el.type === 'arrow') {
			// A copied connector keeps its ends only on shapes that were copied with it.
			copy.startBinding = el.startBinding && idMap.has(el.startBinding.elementId) ? { ...el.startBinding, elementId: idMap.get(el.startBinding.elementId)! } : null;
			copy.endBinding = el.endBinding && idMap.has(el.endBinding.elementId) ? { ...el.endBinding, elementId: idMap.get(el.endBinding.elementId)! } : null;
		}
		return copy as unknown as ScratchElement;
	});
	return { elements: out, idMap };
}
