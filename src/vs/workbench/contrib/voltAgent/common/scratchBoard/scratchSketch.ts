/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { colorOf } from './scratchArchitecture.js';
import { createDraw, createIcon, createLabel, createLinear, createNote, createShape, createText, newElementId } from './scratchFactory.js';
import { escapeHtml } from './scratchHtml.js';
import {
	AGENT_DIAGRAM_STYLE, IScratchBinding, IScratchStyleDefaults, SCRATCH_FONT_SIZES, ScratchArrowhead, ScratchArrowType, ScratchElement, ScratchFillStyle,
	ScratchFontFamily, ScratchPoint, ScratchShapeKind, ScratchStrokeStyle, ScratchTextAlign,
} from './scratchTypes.js';

/**
 * Free-form sketches: an agent places the board's own pieces wherever it likes (shapes, arrows,
 * lines, freehand strokes, text, sticky notes, icons) in any of the board's styles, the way someone
 * draws in Excalidraw. For pictures no layout covers: an illustrated explainer, a timeline, a mind
 * map, a hand-drawn chart, a wireframe, an annotated idea.
 */

const SHAPES: ReadonlySet<string> = new Set<ScratchShapeKind>(['rectangle', 'diamond', 'ellipse', 'triangle', 'hexagon', 'parallelogram', 'cylinder', 'pill', 'document', 'cloud', 'star']);
const ARROWHEADS: ReadonlySet<string> = new Set<ScratchArrowhead>(['none', 'arrow', 'triangle', 'triangle-outline', 'dot', 'circle', 'bar', 'diamond', 'diamond-outline', 'crowfoot-one', 'crowfoot-many', 'crowfoot-one-or-many']);
const MAX_ELEMENTS = 400;
const MAX_POINTS = 400;

/** Fill colours by name: the board's light fills (a dark board darkens them). */
const FILLS: Readonly<Record<string, string>> = {
	red: '#ffc9c9', pink: '#fcc2d7', purple: '#eebefa', grape: '#eebefa', violet: '#d0bfff', indigo: '#bac8ff',
	blue: '#a5d8ff', cyan: '#99e9f2', teal: '#96f2d7', green: '#b2f2bb', lime: '#d8f5a2', yellow: '#ffec99',
	orange: '#ffd8a8', brown: '#eaddd7', gray: '#e9ecef', grey: '#e9ecef', white: '#ffffff', ink: '#1e1e1e', black: '#1e1e1e',
};

/** Sticky note papers by name. */
const NOTES: Readonly<Record<string, string>> = {
	yellow: '#fff3bf', orange: '#ffd8a8', red: '#ffc9c9', pink: '#fcc2d7', violet: '#d0bfff', purple: '#d0bfff', blue: '#a5d8ff', green: '#b2f2bb', gray: '#e9ecef', grey: '#e9ecef',
};

export interface ISketchOptions {
	readonly style?: IScratchStyleDefaults;
	/** Width of `text` at `fontSize` in the hand font; an estimate when not given. */
	readonly measure?: (text: string, fontSize: number) => number;
	/** Markdown to the board's rich text; plain text with line breaks when not given. */
	readonly rich?: (markdown: string) => string;
	/** An icon already fetched for an `icon` value. */
	readonly icon?: (name: string) => { readonly iconId: string; readonly svg: string; readonly tintable: boolean } | undefined;
}

export interface ISketchResult {
	readonly elements: ScratchElement[];
	readonly warnings: string[];
}

function num(v: unknown): number | undefined {
	const n = typeof v === 'string' && v.trim() ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown, max = 2000): string {
	return typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function fillOf(v: unknown): string | undefined {
	if (typeof v !== 'string' || !v.trim()) {
		return undefined;
	}
	const name = v.trim().toLowerCase();
	if (name === 'none' || name === 'transparent') {
		return 'transparent';
	}
	return FILLS[name] ?? colorOf(name);
}

function fontOf(v: unknown): ScratchFontFamily | undefined {
	return v === 'hand' || v === 'sans' || v === 'serif' || v === 'mono' ? v : undefined;
}

function fontSizeOf(v: unknown): number | undefined {
	if (typeof v === 'string' && v in SCRATCH_FONT_SIZES) {
		return SCRATCH_FONT_SIZES[v as keyof typeof SCRATCH_FONT_SIZES];
	}
	const n = num(v);
	return n === undefined ? undefined : Math.min(160, Math.max(8, n));
}

function pointsOf(v: unknown): ScratchPoint[] {
	if (!Array.isArray(v)) {
		return [];
	}
	return v.slice(0, MAX_POINTS).flatMap(p => {
		const x = Array.isArray(p) ? num(p[0]) : p && typeof p === 'object' ? num((p as Record<string, unknown>).x) : undefined;
		const y = Array.isArray(p) ? num(p[1]) : p && typeof p === 'object' ? num((p as Record<string, unknown>).y) : undefined;
		return x === undefined || y === undefined ? [] : [[x, y] as const];
	});
}

/**
 * The agent's elements on the board, in its own coordinates (the caller moves them into place).
 * Unknown kinds and broken references are skipped and named in `warnings`.
 */
export function sketchToElements(value: unknown, options: ISketchOptions = {}): ISketchResult | { readonly error: string } {
	if (!Array.isArray(value)) {
		return { error: '`elements` must be an array of { type, x, y, ... }.' };
	}
	const style = options.style ?? AGENT_DIAGRAM_STYLE;
	const measure = options.measure ?? ((text: string, size: number) => text.length * size * 0.56);
	const rich = options.rich ?? ((text: string) => `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`);
	const warnings: string[] = [];
	const elements: ScratchElement[] = [];
	const byId = new Map<string, ScratchElement>();
	const groups = new Map<string, string>();
	const linked: { readonly index: number; readonly from?: string; readonly to?: string }[] = [];
	if (value.length > MAX_ELEMENTS) {
		warnings.push(`only the first ${MAX_ELEMENTS} elements were drawn`);
	}

	value.slice(0, MAX_ELEMENTS).forEach((raw, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return;
		}
		const v = raw as Record<string, unknown>;
		const type = str(v.type, 40).toLowerCase();
		const x = num(v.x) ?? 0;
		const y = num(v.y) ?? 0;
		const stroke = colorOf(v.stroke ?? v.color) ?? style.stroke;
		const fill = fillOf(v.fill ?? v.background);
		const fillStyle: ScratchFillStyle | undefined = v.fillStyle === 'hachure' || v.fillStyle === 'cross-hatch' || v.fillStyle === 'solid' ? v.fillStyle : undefined;
		const strokeStyle: ScratchStrokeStyle | undefined = v.strokeStyle === 'dashed' || v.strokeStyle === 'dotted' || v.strokeStyle === 'solid' ? v.strokeStyle : undefined;
		const strokeWidth = num(v.strokeWidth);
		const roughness = num(v.roughness);
		const opacity = num(v.opacity);
		const angle = num(v.angle);
		const group = str(v.group, 80);
		let groupId: string | undefined;
		if (group) {
			groupId = groups.get(group) ?? newElementId();
			groups.set(group, groupId);
		}
		const base = {
			x, y, stroke,
			...(fillStyle ? { fillStyle } : {}),
			...(strokeStyle ? { strokeStyle } : {}),
			...(strokeWidth !== undefined ? { strokeWidth: Math.min(16, Math.max(0.5, strokeWidth)) } : {}),
			...(roughness !== undefined ? { roughness: Math.min(2, Math.max(0, roughness)) } : {}),
			...(opacity !== undefined ? { opacity: Math.min(100, Math.max(5, opacity <= 1 ? opacity * 100 : opacity)) } : {}),
			...(angle !== undefined ? { angle: angle * Math.PI / 180 } : {}),
			...(v.roundness === 'sharp' || v.roundness === 'round' ? { roundness: v.roundness } : {}),
			...(groupId ? { groupIds: [groupId] } : {}),
		};
		const fontFamily = fontOf(v.font ?? v.fontFamily) ?? style.fontFamily;
		const fontSize = fontSizeOf(v.fontSize) ?? style.fontSize;
		const textColor = colorOf(v.textColor);
		const text = str(v.text ?? v.label);
		let el: ScratchElement | undefined;

		if (SHAPES.has(type) || type === 'rect' || type === 'circle' || type === 'box') {
			const shape = (type === 'rect' || type === 'box' ? 'rectangle' : type === 'circle' ? 'ellipse' : type) as ScratchShapeKind;
			const width = Math.max(4, num(v.width) ?? num(v.size) ?? 160);
			const height = Math.max(4, num(v.height) ?? num(v.size) ?? (type === 'circle' ? width : 80));
			const align: ScratchTextAlign = v.align === 'left' || v.align === 'right' ? v.align : 'center';
			el = createShape({
				...base, width, height, shape,
				fill: fill ?? 'transparent',
				label: text ? createLabel(rich(text), style, { fontFamily, fontSize, textAlign: align, verticalAlign: v.valign === 'top' || v.valign === 'bottom' ? v.valign : 'middle', ...(textColor ? { color: textColor } : {}) }) : null,
			}, style);
		} else if (type === 'text') {
			if (!text) {
				return;
			}
			const lines = text.split('\n');
			const width = num(v.width);
			const align: ScratchTextAlign = v.align === 'center' || v.align === 'right' ? v.align : 'left';
			el = createText({
				...base,
				// The board measures text once drawn; this first size is what the frame is fitted to.
				width: Math.ceil(width ?? Math.max(...lines.map(line => measure(line, fontSize))) + 4),
				height: Math.ceil(lines.length * fontSize * (fontFamily === 'hand' ? 1.25 : 1.35)),
				html: rich(text), autoSize: width === undefined, fontFamily, fontSize, textAlign: align,
			}, style);
		} else if (type === 'arrow' || type === 'line') {
			const from = str(v.from ?? v.start, 120);
			const to = str(v.to ?? v.end, 120);
			const points = pointsOf(v.points);
			if (points.length < 2 && !(from && to)) {
				warnings.push(`${type} ${index} needs \`points\` (two or more [x, y]) or \`from\` and \`to\``);
				return;
			}
			const start = points[0] ?? [0, 0];
			const arrowType: ScratchArrowType | undefined = v.arrowType === 'elbow' || v.arrowType === 'sharp' || v.arrowType === 'round' ? v.arrowType : v.curved === true ? 'round' : undefined;
			const head = (h: unknown, fallback: ScratchArrowhead): ScratchArrowhead => typeof h === 'string' && ARROWHEADS.has(h) ? h as ScratchArrowhead : h === false || h === null ? 'none' : fallback;
			el = createLinear({
				...base, type: type === 'arrow' ? 'arrow' : 'line',
				x: start[0], y: start[1],
				points: (points.length >= 2 ? points : [start, [start[0] + 1, start[1]]]).map(p => [p[0] - start[0], p[1] - start[1]] as const),
				...(arrowType ? { arrowType } : { arrowType: points.length > 2 ? 'round' : 'sharp' }),
				...(type === 'arrow' ? { startArrowhead: head(v.startArrowhead, 'none'), endArrowhead: head(v.endArrowhead, 'arrow') } : {}),
				closed: type === 'line' && v.closed === true,
				...(type === 'line' && v.closed === true && fill ? { fill } : {}),
				label: text ? createLabel(rich(text), style, { fontFamily, fontSize: fontSizeOf(v.fontSize) ?? 16, verticalAlign: v.labelSide === 'top' || v.labelSide === 'bottom' ? v.labelSide : 'middle', ...(textColor ? { color: textColor } : {}) }) : null,
			}, style);
			if (from || to) {
				linked.push({ index: elements.length, from: from || undefined, to: to || undefined });
			}
		} else if (type === 'freehand' || type === 'draw' || type === 'pen' || type === 'highlighter') {
			const points = pointsOf(v.points);
			if (points.length < 2) {
				warnings.push(`${type} ${index} needs two or more \`points\``);
				return;
			}
			const highlighter = type === 'highlighter' || v.pen === 'highlighter';
			el = createDraw({
				...base, x: points[0][0], y: points[0][1],
				points: points.map(p => [p[0] - points[0][0], p[1] - points[0][1], 0.5] as const),
				pen: highlighter ? 'highlighter' : 'pen',
				simulatePressure: true,
				...(highlighter && !colorOf(v.stroke ?? v.color) ? { stroke: '#ffd43b' } : {}),
				...(strokeWidth === undefined ? { strokeWidth: highlighter ? 14 : 3 } : {}),
			}, style);
		} else if (type === 'note' || type === 'sticky') {
			const paper = typeof v.fill === 'string' ? NOTES[v.fill.toLowerCase()] ?? fillOf(v.fill) : undefined;
			el = createNote({
				...base,
				width: Math.max(80, num(v.width) ?? 220),
				height: Math.max(60, num(v.height) ?? 160),
				html: rich(text), fontFamily, fontSize: fontSizeOf(v.fontSize) ?? 18,
				fill: paper ?? NOTES.yellow,
			}, style);
		} else if (type === 'icon') {
			const name = str(v.icon ?? v.name, 120);
			const icon = name ? options.icon?.(name) : undefined;
			if (!icon) {
				warnings.push(`no icon was found for "${name || '(none)'}"`);
				return;
			}
			const size = Math.max(8, num(v.size) ?? num(v.width) ?? 48);
			el = createIcon({
				...base, width: size, height: num(v.height) ?? size,
				iconId: icon.iconId, svg: icon.svg, tintable: icon.tintable,
				label: text ? createLabel(rich(text), style, { fontFamily, fontSize: fontSizeOf(v.fontSize) ?? 16, verticalAlign: 'bottom' }) : null,
			}, style);
		} else {
			warnings.push(`"${type || '(no type)'}" is not something the board draws, so element ${index} was left out`);
			return;
		}
		elements.push(el);
		const id = str(v.id, 120);
		if (id) {
			byId.set(id, el);
		}
	});

	// Arrows tied to shapes: they start and end on them, and stay attached when the user moves them.
	for (const link of linked) {
		const arrow = elements[link.index];
		if (arrow.type !== 'arrow' && arrow.type !== 'line') {
			continue;
		}
		const centre = (id: string | undefined): readonly [number, number] | undefined => {
			const target = id ? byId.get(id) : undefined;
			return target ? [target.x + target.width / 2, target.y + target.height / 2] : undefined;
		};
		const binding = (id: string | undefined): IScratchBinding | null => id && byId.has(id) ? { elementId: byId.get(id)!.id, anchor: null } : null;
		for (const id of [link.from, link.to]) {
			if (id && !byId.has(id)) {
				warnings.push(`no element has the id "${id}", so that end of the ${arrow.type} is loose`);
			}
		}
		const absolute = arrow.points.map(p => [arrow.x + p[0], arrow.y + p[1]] as const);
		const start = centre(link.from) ?? absolute[0];
		const end = centre(link.to) ?? absolute[absolute.length - 1];
		// Points in between (a bend the agent asked for) stay.
		const middle = absolute.length > 2 ? absolute.slice(1, -1) : [];
		const all = [start, ...middle, end];
		elements[link.index] = createLinear({
			...arrow, x: start[0], y: start[1],
			points: all.map(p => [p[0] - start[0], p[1] - start[1]] as const),
			startBinding: binding(link.from), endBinding: binding(link.to),
		}, style);
	}
	if (!elements.length) {
		return { error: `Nothing in \`elements\` could be drawn${warnings.length ? `: ${warnings.join('; ')}` : ''}.` };
	}
	return { elements, warnings };
}

/** Every icon name the elements ask for, to fetch before drawing. */
export function sketchIconNames(value: unknown): string[] {
	return Array.isArray(value)
		? value.flatMap(v => v && typeof v === 'object' && (v as Record<string, unknown>).type === 'icon' ? [str((v as Record<string, unknown>).icon ?? (v as Record<string, unknown>).name, 120)] : []).filter(Boolean)
		: [];
}
