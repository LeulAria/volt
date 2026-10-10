/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentDotLoader.css';
import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Color, RGBA } from '../../../../../base/common/color.js';

/**
 * The outline of what is on its way: `wide` fills the reply column (charts, pages, wide diagrams),
 * `square` and `tall` hold an image or a phone screen, `circle` a pie, donut or gauge.
 */
export type DotLoaderShape = 'wide' | 'square' | 'tall' | 'circle';

export interface IDotLoaderOptions {
	readonly shape?: DotLoaderShape;
	/** Height in px; the width follows the shape. Otherwise the CSS default (240px). */
	readonly height?: number;
	/** Shimmering caption in the corner ("Creating chart"), as ChatGPT labels a picture it is making. */
	readonly caption?: string;
	/** Screen-reader status; defaults to the caption. */
	readonly ariaLabel?: string;
}

/** Grid pitch in CSS px: dense enough to read as a halftone, sparse enough to draw every frame. */
const PITCH = 13;
/** Dots are batched by brightness, one fill per step instead of one per dot. */
const LEVELS = 12;
const TAU = Math.PI * 2;
/** One sweep of light across the field, in seconds. */
const SWEEP = 2.8;
const CAPTION_SWEEP_MS = 2200;
const FALLBACK_COLOR = new Color(new RGBA(77, 125, 255));
const FALLBACK_HIGHLIGHT = new Color(new RGBA(170, 192, 255));

/**
 * A halftone placeholder for a picture on its way (chart, page, diagram, mockup, image): a grid of
 * dots whose size and brightness follow slow drifting blobs, a diagonal sweep of light and a
 * per-dot shiver, inside the shape of what is coming, with 8px corners.
 *
 * The phase comes from the page clock, not the element's age: a transcript that redraws a streaming
 * block every frame makes a new loader each time, and it carries on exactly where the last one
 * was. The first frame is drawn from a ResizeObserver (after layout, before paint), so a new loader
 * never flashes empty. It stops itself once it leaves the document.
 */
export function renderDotLoader(parent: HTMLElement, options: IDotLoaderOptions = {}): HTMLElement {
	const shape = options.shape ?? 'wide';
	const root = append(parent, $(`.volt-dot-loader.${shape}`));
	root.setAttribute('role', 'status');
	const label = options.ariaLabel ?? options.caption;
	if (label) {
		root.setAttribute('aria-label', label);
	}
	if (options.height) {
		root.style.setProperty('--volt-dot-loader-height', `${Math.round(options.height)}px`);
	}
	const field = append(root, $('.volt-dot-loader-field'));
	const canvas = append(field, $('canvas.volt-dot-loader-canvas')) as HTMLCanvasElement;
	canvas.setAttribute('aria-hidden', 'true');
	if (options.caption) {
		const caption = append(root, $('span.volt-dot-loader-caption'));
		caption.setAttribute('aria-hidden', 'true');
		caption.textContent = options.caption;
		// On the same clock as the dots, so a redrawn loader's caption does not restart its sweep.
		caption.style.animationDelay = `-${Math.round(getWindow(parent).performance.now() % CAPTION_SWEEP_MS)}ms`;
	}
	animateDots(field, canvas, shape === 'circle');
	return root;
}

/** A single round chart (pie, donut, gauge, rings, radar…) in a chart spec, even half streamed. */
export function chartLoaderShape(source: string): DotLoaderShape {
	const types = Array.from(source.matchAll(/"type"\s*:\s*"([^"]+)"/g), match => match[1].toLowerCase());
	return types.length && types.every(type => ROUND_CHARTS.has(type)) ? 'circle' : 'wide';
}

const ROUND_CHARTS = new Set(['pie', 'donut', 'ring', 'gauge', 'meter', 'rings', 'progress', 'activity', 'sunburst', 'radar', 'spider']);

/** What a mermaid diagram usually comes out as: a pie is round, a top-down flow squarish, the rest wide. */
export function mermaidLoaderShape(source: string): { readonly shape: DotLoaderShape; readonly height: number } {
	const head = source.replace(/^\s*(?:%%[^\n]*\n\s*)*/, '').split('\n', 1)[0].trim().toLowerCase();
	if (/^pie\b/.test(head)) {
		return { shape: 'circle', height: 220 };
	}
	if (/^(?:graph|flowchart)\s+(?:td|tb|bt)\b/.test(head) || /^(?:statediagram|classdiagram|erdiagram|mindmap)/.test(head)) {
		return { shape: 'square', height: 280 };
	}
	if (/^(?:gantt|timeline|gitgraph|journey)/.test(head)) {
		return { shape: 'wide', height: 180 };
	}
	return { shape: 'wide', height: 220 };
}

interface IDotGrid {
	readonly width: number;
	readonly height: number;
	readonly count: number;
	readonly x: Float32Array;
	readonly y: Float32Array;
	/** Position in half-short-side units from the center, so blobs stay round in any shape. */
	readonly u: Float32Array;
	readonly v: Float32Array;
	/** 0 at the rim, 1 well inside: dots shrink toward the edge, so the shape reads softly. */
	readonly edge: Float32Array;
	/** 0..1 per dot, the same for the same cell every time (a redraw must not reshuffle). */
	readonly seed: Float32Array;
	/** Shiver rate per dot, rad/s. */
	readonly rate: Float32Array;
	/** Half extents in u/v units. */
	readonly spanU: number;
	readonly spanV: number;
	/** Per-frame scratch. */
	readonly radius: Float32Array;
	readonly level: Uint8Array;
	readonly order: Uint32Array;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

function cellSeed(column: number, row: number): number {
	const value = Math.sin(column * 12.9898 + row * 78.233) * 43758.5453;
	return value - Math.floor(value);
}

function layoutGrid(width: number, height: number, round: boolean): IDotGrid {
	const columns = Math.max(1, Math.floor(width / PITCH));
	const rows = Math.max(1, Math.floor(height / PITCH));
	const offsetX = (width - (columns - 1) * PITCH) / 2;
	const offsetY = (height - (rows - 1) * PITCH) / 2;
	const half = Math.max(1, Math.min(width, height) / 2);
	const centerX = width / 2;
	const centerY = height / 2;
	const fade = Math.min(64, Math.max(PITCH * 2, half * 0.42));
	const radius = half - PITCH * 0.35;
	const total = columns * rows;
	const x = new Float32Array(total);
	const y = new Float32Array(total);
	const u = new Float32Array(total);
	const v = new Float32Array(total);
	const edge = new Float32Array(total);
	const seed = new Float32Array(total);
	const rate = new Float32Array(total);
	let count = 0;
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const px = offsetX + column * PITCH;
			const py = offsetY + row * PITCH;
			let inset: number;
			if (round) {
				inset = radius - Math.hypot(px - centerX, py - centerY);
				if (inset < 0) {
					continue;
				}
			} else {
				inset = Math.min(px, width - px, py, height - py);
			}
			const s = cellSeed(column, row);
			x[count] = px;
			y[count] = py;
			u[count] = (px - centerX) / half;
			v[count] = (py - centerY) / half;
			edge[count] = 0.14 + 0.86 * smoothstep(0, fade, inset);
			seed[count] = s;
			rate[count] = 5 + 6 * cellSeed(row + 17, column + 31);
			count++;
		}
	}
	return {
		width, height, count, x, y, u, v, edge, seed, rate,
		spanU: centerX / half,
		spanV: centerY / half,
		radius: new Float32Array(count),
		level: new Uint8Array(count),
		order: new Uint32Array(count),
	};
}

function readColor(style: CSSStyleDeclaration, name: string, fallback: Color): Color {
	const value = style.getPropertyValue(name).trim();
	return (value && Color.Format.CSS.parse(value)) || fallback;
}

/** One fill style per brightness step: from faint base color to bright highlight. */
function levelStyles(base: Color, highlight: Color): string[] {
	const styles: string[] = [];
	for (let level = 0; level < LEVELS; level++) {
		const t = level / (LEVELS - 1);
		const mix = Math.pow(t, 1.8) * 0.85;
		const r = Math.round(base.rgba.r + (highlight.rgba.r - base.rgba.r) * mix);
		const g = Math.round(base.rgba.g + (highlight.rgba.g - base.rgba.g) * mix);
		const b = Math.round(base.rgba.b + (highlight.rgba.b - base.rgba.b) * mix);
		const alpha = (0.2 + 0.8 * Math.pow(t, 0.8)) * base.rgba.a;
		styles.push(`rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
	}
	return styles;
}

/** Sizes each dot for time `t` (seconds) and draws them, batched by brightness. */
function paint(context: CanvasRenderingContext2D, grid: IDotGrid, styles: readonly string[], t: number): void {
	context.clearRect(0, 0, grid.width, grid.height);
	const { count, u, v, edge, seed, rate, radius, level, order, spanU, spanV } = grid;
	// Three soft blobs drift on slow Lissajous paths; wide fields get larger ones to fill them.
	const spread = Math.min(1.9, 1 + 0.24 * (Math.max(spanU, spanV) - 1));
	const ax = Math.max(0.15, spanU - 0.35);
	const ay = Math.max(0.15, spanV - 0.35);
	const b1x = ax * 0.8 * Math.sin(t * 0.47), b1y = ay * 0.75 * Math.sin(t * 0.61 + 1.3);
	const b2x = ax * 0.85 * Math.sin(t * 0.33 + 2.1), b2y = ay * 0.8 * Math.cos(t * 0.39 + 0.4);
	const b3x = ax * 0.7 * Math.cos(t * 0.57 + 4.0), b3y = ay * 0.85 * Math.sin(t * 0.27 + 2.6);
	const k1 = 1 / Math.pow(0.95 * spread, 2), k2 = 1 / Math.pow(0.75 * spread, 2), k3 = 1 / Math.pow(0.6 * spread, 2);
	// A band of light crossing corner to corner, then a short rest off the field.
	const sweep = -1.6 + 3.2 * ((t % SWEEP) / SWEEP);
	const maxRadius = PITCH * 0.32;
	const minRadius = 0.55;
	const counts = new Uint32Array(LEVELS);
	for (let i = 0; i < count; i++) {
		const du1 = u[i] - b1x, dv1 = v[i] - b1y;
		const du2 = u[i] - b2x, dv2 = v[i] - b2y;
		const du3 = u[i] - b3x, dv3 = v[i] - b3y;
		const g1 = 0.95 * Math.exp(-(du1 * du1 + dv1 * dv1) * k1);
		const g2 = 0.75 * Math.exp(-(du2 * du2 + dv2 * dv2) * k2);
		const g3 = 0.6 * Math.exp(-(du3 * du3 + dv3 * dv3) * k3);
		let value = 1 - (1 - g1) * (1 - g2) * (1 - g3);
		// A slow ripple, so the field breathes between blobs.
		value *= 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(u[i] * 2.6 - v[i] * 1.9 + t * 1.7));
		const diagonal = (u[i] / spanU + v[i] / spanV) * 0.5;
		const band = Math.exp(-Math.pow((diagonal - sweep) * 4.2, 2));
		value = 1 - (1 - value) * (1 - 0.6 * band);
		// The shiver: every dot pulses a little on its own beat.
		const shiver = Math.sin(t * rate[i] + seed[i] * TAU);
		value = edge[i] * (0.07 + 0.93 * value) * (1 + 0.16 * shiver);
		value = value < 0 ? 0 : value > 1 ? 1 : value;
		radius[i] = minRadius + (maxRadius - minRadius) * Math.pow(value, 1.25);
		const step = Math.min(LEVELS - 1, Math.floor(value * LEVELS));
		level[i] = step;
		counts[step]++;
	}
	const starts = new Uint32Array(LEVELS);
	for (let step = 1; step < LEVELS; step++) {
		starts[step] = starts[step - 1] + counts[step - 1];
	}
	const cursor = starts.slice();
	for (let i = 0; i < count; i++) {
		order[cursor[level[i]]++] = i;
	}
	const { x, y } = grid;
	for (let step = 0; step < LEVELS; step++) {
		if (!counts[step]) {
			continue;
		}
		context.beginPath();
		for (let n = starts[step], end = starts[step] + counts[step]; n < end; n++) {
			const i = order[n];
			// A hair of positional tremble on top of the size pulse.
			const dx = 0.3 * Math.sin(t * rate[i] * 1.37 + seed[i] * 11);
			const dy = 0.3 * Math.cos(t * rate[i] * 1.11 + seed[i] * 17);
			const r = radius[i];
			context.moveTo(x[i] + dx + r, y[i] + dy);
			context.arc(x[i] + dx, y[i] + dy, r, 0, TAU);
		}
		context.fillStyle = styles[step];
		context.fill();
	}
}

function animateDots(field: HTMLElement, canvas: HTMLCanvasElement, round: boolean): void {
	const context = canvas.getContext('2d');
	if (!context) {
		return;
	}
	let grid: IDotGrid | undefined;
	let styles: string[] = [];
	let colorKey = '';
	let frame = 0;
	let frames = 0;
	let visible = true;
	let still = false;

	const now = () => getWindow(canvas).performance.now() / 1000;
	const readColors = () => {
		const style = getWindow(field).getComputedStyle(field);
		const base = readColor(style, '--volt-dot-loader-color', FALLBACK_COLOR);
		const highlight = readColor(style, '--volt-dot-loader-highlight', FALLBACK_HIGHLIGHT);
		const key = `${base}|${highlight}`;
		if (key !== colorKey) {
			colorKey = key;
			styles = levelStyles(base, highlight);
		}
	};
	const onScreen = () => {
		const box = canvas.getBoundingClientRect();
		const view = getWindow(canvas);
		return box.bottom > 0 && box.right > 0 && box.top < view.innerHeight && box.left < view.innerWidth;
	};
	const tick = () => {
		frame = 0;
		if (!canvas.isConnected || !grid) {
			// Gone: stop. The ResizeObserver starts it again if the loader comes back.
			return;
		}
		frames++;
		if (frames % 12 === 0) {
			visible = onScreen();
		}
		if (frames % 90 === 0) {
			readColors();
		}
		if (visible) {
			paint(context, grid, styles, now());
		}
		frame = getWindow(canvas).requestAnimationFrame(tick);
	};

	const win = getWindow(field);
	const observer = new win.ResizeObserver(entries => {
		const box = entries[entries.length - 1].contentRect;
		const width = Math.round(box.width);
		const height = Math.round(box.height);
		if (!width || !height || !canvas.isConnected) {
			return;
		}
		const view = getWindow(canvas);
		const ratio = Math.min(3, view.devicePixelRatio || 1);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		grid = layoutGrid(width, height, round);
		still = view.matchMedia('(prefers-reduced-motion: reduce)').matches || !!field.closest('.monaco-workbench.reduce-motion');
		readColors();
		visible = true;
		// Reduced motion: one still frame of the same field.
		paint(context, grid, styles, still ? 2.2 : now());
		if (!still && !frame) {
			frame = view.requestAnimationFrame(tick);
		}
	});
	observer.observe(field);
}
