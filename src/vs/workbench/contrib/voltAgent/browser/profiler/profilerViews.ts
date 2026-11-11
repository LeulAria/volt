/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatMs, formatValue, IProfileCounter, IVoltProfile, VoltProfileUnit } from '../../../../services/voltRuntime/common/profiler/profile.js';
import { firstEndingAfter, ITimeRange } from '../../../../services/voltRuntime/common/profiler/profileAnalysis.js';

/**
 * The Profiler's canvases. Each view draws from the profile and a viewport, skips what is smaller
 * than a pixel or off screen (a lane is binary-searched to its first visible slice, a subtree is
 * dropped with its parent), and answers "what is under this point" for hover and click. Nothing
 * here keeps state between frames except caches keyed by the profile.
 */

export const RULER_HEIGHT = 20;
export const ROW_HEIGHT = 18;

export interface IProfilerPalette {
	readonly dark: boolean;
	readonly background: string;
	readonly foreground: string;
	readonly muted: string;
	readonly grid: string;
	/** Selection outline. */
	readonly accent: string;
	/** Search matches. */
	readonly match: string;
	/** The agent's notes. */
	readonly note: string;
	readonly font: string;
}

export interface IDrawTarget {
	readonly ctx: CanvasRenderingContext2D;
	readonly width: number;
	readonly height: number;
}

// --- Colors --------------------------------------------------------------------------------------

const CATEGORY_HUES: Readonly<Record<string, number>> = { app: 205, node: 140, trace: 265, python: 50 };

function hash(text: string): number {
	let value = 2166136261;
	for (let i = 0; i < text.length; i++) {
		value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
	}
	return value;
}

/**
 * A frame's color by where its code lives: app code blue, the runtime green, each package its own
 * hue, GC orange, native and idle gray. Frames of one category vary a little in lightness so
 * neighbors stay apart.
 */
export function categoryColor(palette: IProfilerPalette, category: string, frameName: string): string {
	const jitter = (hash(frameName) % 9) - 4;
	const light = (palette.dark ? 36 : 74) + jitter;
	switch (category) {
		case 'gc': return `hsl(28, 85%, ${light}%)`;
		case 'native': return `hsl(220, 6%, ${light}%)`;
		case 'idle':
		case 'program':
		case 'root': return `hsl(220, 4%, ${palette.dark ? 26 : 86}%)`;
	}
	const hue = CATEGORY_HUES[category] ?? (hash(category) % 300 + 30) % 360;
	return `hsl(${hue}, ${category === 'app' ? 62 : 48}%, ${light}%)`;
}

/** 0 (cool) to 1 (hot): yellow through orange to red, for "where the time is" coloring. */
export function heatColor(palette: IProfilerPalette, t: number): string {
	const v = Math.max(0, Math.min(1, t));
	return `hsl(${Math.round(55 - 55 * v)}, ${Math.round(70 + 25 * v)}%, ${palette.dark ? 30 + 18 * v : 82 - 30 * v}%)`;
}

/** -1 (faster or smaller) to 1 (slower or bigger), gray near zero: the diff graph. */
export function diffColor(palette: IProfilerPalette, delta: number): string {
	const v = Math.max(-1, Math.min(1, delta));
	const strength = Math.min(1, Math.abs(v) * 2.5);
	if (Math.abs(v) < 0.02) {
		return `hsl(220, 5%, ${palette.dark ? 32 : 80}%)`;
	}
	return v > 0
		? `hsl(4, ${30 + 55 * strength}%, ${palette.dark ? 30 + 14 * strength : 80 - 22 * strength}%)`
		: `hsl(212, ${30 + 55 * strength}%, ${palette.dark ? 30 + 14 * strength : 80 - 22 * strength}%)`;
}

/** A heat map cell: the hot color over the background, stronger with the value. */
export function cellColor(t: number): string {
	const v = Math.max(0, Math.min(1, t));
	return `hsla(${Math.round(50 - 50 * v)}, 90%, 52%, ${(0.06 + 0.94 * Math.sqrt(v)).toFixed(3)})`;
}

// --- Text ----------------------------------------------------------------------------------------

/** Average character width at the canvas's font, measured once per font. */
const charWidths = new Map<string, number>();

function charWidth(ctx: CanvasRenderingContext2D): number {
	let width = charWidths.get(ctx.font);
	if (width === undefined) {
		width = ctx.measureText('abcdefghijklmnopqrstuvwxyz_ABCDEF().').width / 36;
		charWidths.set(ctx.font, width);
	}
	return width;
}

/** `text` cut to fit `width` px with an ellipsis; empty when not even a few characters fit. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
	const max = Math.floor(width / charWidth(ctx));
	if (max >= text.length) {
		return text;
	}
	return max >= 4 ? `${text.slice(0, max - 1)}\u2026` : '';
}

// --- Time axis -----------------------------------------------------------------------------------

/** A tick step of 1, 2 or 5 times a power of ten that gives about one tick per `px` pixels. */
export function niceStep(span: number, width: number, px = 110): number {
	const raw = span / Math.max(1, width / px);
	const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
	const unit = raw / power;
	return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

export function timeToX(time: number, range: ITimeRange, width: number): number {
	return ((time - range.start) / Math.max(1e-9, range.end - range.start)) * width;
}

export function xToTime(x: number, range: ITimeRange, width: number): number {
	return range.start + (x / Math.max(1, width)) * (range.end - range.start);
}

export function drawRuler(target: IDrawTarget, range: ITimeRange, palette: IProfilerPalette, top = 0, height = RULER_HEIGHT, left = 0): void {
	const { ctx } = target;
	const width = target.width - left;
	const step = niceStep(range.end - range.start, width);
	ctx.fillStyle = palette.background;
	ctx.fillRect(left, top, width, height);
	ctx.font = `10px ${palette.font}`;
	ctx.textBaseline = 'middle';
	ctx.fillStyle = palette.muted;
	ctx.strokeStyle = palette.grid;
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let tick = Math.ceil(range.start / step) * step; tick <= range.end; tick += step) {
		const x = Math.round(left + timeToX(tick, range, width)) + 0.5;
		ctx.moveTo(x, top + height - 6);
		ctx.lineTo(x, top + height);
		ctx.fillText(formatMs(tick), x + 3, top + height / 2 - 1);
	}
	ctx.moveTo(left, top + height - 0.5);
	ctx.lineTo(left + width, top + height - 0.5);
	ctx.stroke();
}

/** Faint vertical lines at the ruler's ticks, under a view's content. */
export function drawGrid(target: IDrawTarget, range: ITimeRange, palette: IProfilerPalette, top: number, left = 0): void {
	const { ctx } = target;
	const width = target.width - left;
	const step = niceStep(range.end - range.start, width);
	ctx.strokeStyle = palette.grid;
	ctx.globalAlpha = 0.5;
	ctx.beginPath();
	for (let tick = Math.ceil(range.start / step) * step; tick <= range.end; tick += step) {
		const x = Math.round(left + timeToX(tick, range, width)) + 0.5;
		ctx.moveTo(x, top);
		ctx.lineTo(x, target.height);
	}
	ctx.stroke();
	ctx.globalAlpha = 1;
}

// --- Slices (shared by the chart and the graph) --------------------------------------------------

export interface ISliceStyle {
	/** Fill for a node. */
	readonly colorOf: (node: number) => string;
	/** Drawn faded (not matching the search, or an ancestor above a zoomed graph). */
	readonly isDimmed: (node: number) => boolean;
	readonly selectedFrame?: number;
	readonly hoveredNode?: number;
	/** Frames the agent pinned a note on, with the note's number. */
	readonly notes: ReadonlyMap<number, number>;
}

function drawSlice(ctx: CanvasRenderingContext2D, profile: IVoltProfile, palette: IProfilerPalette, style: ISliceStyle, node: number, x: number, y: number, w: number, h: number): void {
	const frame = profile.nodes[node].frame;
	// A slice that starts left of the view keeps its label in view.
	const left = Math.max(x, -2);
	const width = Math.max(1, x + w - left);
	ctx.globalAlpha = style.isDimmed(node) ? 0.28 : 1;
	ctx.fillStyle = style.colorOf(node);
	ctx.fillRect(left, y, width - (width > 3 ? 1 : 0), h - 1);
	if (frame === style.selectedFrame || node === style.hoveredNode) {
		ctx.strokeStyle = frame === style.selectedFrame ? palette.accent : palette.foreground;
		ctx.lineWidth = frame === style.selectedFrame ? 2 : 1;
		ctx.strokeRect(left + 0.5, y + 0.5, Math.max(1, width - 2), h - 2);
	}
	if (width > 26) {
		const text = fitText(ctx, profile.frames[frame].name, width - 8);
		if (text) {
			ctx.fillStyle = palette.dark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.86)';
			ctx.fillText(text, left + 4, y + h / 2);
		}
	}
	const note = style.notes.get(frame);
	if (note !== undefined && width > 6) {
		ctx.globalAlpha = 1;
		ctx.fillStyle = palette.note;
		ctx.beginPath();
		ctx.arc(Math.min(left + width - 6, left + 6), y + 4, 3.5, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
}

// --- Flame chart: time on x, call depth on y -----------------------------------------------------

export interface IChartModel extends ISliceStyle {
	readonly profile: IVoltProfile;
	readonly range: ITimeRange;
	readonly scrollTop: number;
}

/** The timeline as Chrome's Performance panel draws it. Returns the content height (for scrolling). */
export function drawFlameChart(target: IDrawTarget, model: IChartModel, palette: IProfilerPalette): number {
	const { ctx, width, height } = target;
	const { profile, range } = model;
	const lanes = profile.timeline?.lanes ?? [];
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, width, height);
	drawGrid(target, range, palette, RULER_HEIGHT);
	ctx.font = `11px ${palette.font}`;
	ctx.textBaseline = 'middle';
	const scale = width / Math.max(1e-9, range.end - range.start);
	const firstLane = Math.max(0, Math.floor(model.scrollTop / ROW_HEIGHT));
	const lastLane = Math.min(lanes.length - 1, Math.ceil((model.scrollTop + height - RULER_HEIGHT) / ROW_HEIGHT));
	for (let depth = firstLane; depth <= lastLane; depth++) {
		const lane = lanes[depth];
		const y = RULER_HEIGHT + depth * ROW_HEIGHT - model.scrollTop;
		// Slices under a pixel are drawn once per pixel: thousands of tiny calls stay one mark.
		let lastPixel = -1;
		for (let i = firstEndingAfter(lane.end, range.start); i < lane.start.length && lane.start[i] < range.end; i++) {
			const x = (lane.start[i] - range.start) * scale;
			const w = (lane.end[i] - lane.start[i]) * scale;
			if (w < 1) {
				const pixel = Math.floor(x);
				if (pixel === lastPixel) {
					continue;
				}
				lastPixel = pixel;
			}
			drawSlice(ctx, profile, palette, model, lane.node[i], x, y, Math.max(w, 1), ROW_HEIGHT);
		}
	}
	drawRuler(target, range, palette);
	return lanes.length * ROW_HEIGHT + RULER_HEIGHT + 8;
}

export interface IChartHit {
	readonly node: number;
	readonly start: number;
	readonly end: number;
}

export function hitFlameChart(model: IChartModel, width: number, x: number, y: number): IChartHit | undefined {
	const lanes = model.profile.timeline?.lanes ?? [];
	const depth = Math.floor((y - RULER_HEIGHT + model.scrollTop) / ROW_HEIGHT);
	const lane = lanes[depth];
	if (y < RULER_HEIGHT || !lane) {
		return undefined;
	}
	const time = xToTime(x, model.range, width);
	// A sub-pixel slice is hit within half a pixel.
	const slack = (model.range.end - model.range.start) / Math.max(1, width) / 2;
	const index = firstEndingAfter(lane.end, time - slack);
	if (index < lane.start.length && lane.start[index] <= time + slack) {
		return { node: lane.node[index], start: lane.start[index], end: lane.end[index] };
	}
	return undefined;
}

// --- Flame graph: the call tree aggregated, widest left ------------------------------------------

export interface IGraphModel extends ISliceStyle {
	readonly profile: IVoltProfile;
	/** The node the graph is zoomed into; its ancestors stay on top as context. */
	readonly focusNode: number;
	/** A horizontal zoom inside the focus node, in fractions of its width. */
	readonly zoom: { readonly start: number; readonly end: number };
	readonly scrollTop: number;
}

export interface IGraphRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly node: number;
}

/** Children of every node, heaviest first (computed once per profile). */
const sortedChildren = new WeakMap<IVoltProfile, readonly (readonly number[])[]>();

export function heaviestFirst(profile: IVoltProfile): readonly (readonly number[])[] {
	let sorted = sortedChildren.get(profile);
	if (!sorted) {
		sorted = profile.nodes.map(node => [...node.children].sort((a, b) => profile.nodes[b].total - profile.nodes[a].total));
		sortedChildren.set(profile, sorted);
	}
	return sorted;
}

/** Draws the icicle graph and returns every drawn rectangle, for hit testing. */
export function drawFlameGraph(target: IDrawTarget, model: IGraphModel, palette: IProfilerPalette): { readonly rects: IGraphRect[]; readonly contentHeight: number } {
	const { ctx, width, height } = target;
	const { profile } = model;
	const rects: IGraphRect[] = [];
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, width, height);
	ctx.font = `11px ${palette.font}`;
	ctx.textBaseline = 'middle';
	const focus = profile.nodes[model.focusNode];
	const focusTotal = Math.max(1e-12, focus.total);
	const span = Math.max(1e-6, model.zoom.end - model.zoom.start);
	const toX = (units: number) => ((units / focusTotal - model.zoom.start) / span) * width;
	const rowY = (depth: number) => 4 + (depth - 1) * ROW_HEIGHT - model.scrollTop;
	// Ancestors of the focus, full width: where this part of the program sits.
	const ancestors: number[] = [];
	for (let up = model.focusNode; up > 0; up = profile.nodes[up].parent) {
		ancestors.push(up);
	}
	for (const node of ancestors.reverse()) {
		const y = rowY(profile.nodes[node].depth);
		if (y > -ROW_HEIGHT && y < height) {
			drawSlice(ctx, profile, palette, { ...model, isDimmed: candidate => candidate !== model.focusNode || model.isDimmed(candidate) }, node, 0, y, width, ROW_HEIGHT);
			rects.push({ x: 0, y, w: width, node });
		}
	}
	const children = heaviestFirst(profile);
	let maxDepth = focus.depth;
	// Depth-first from the focus; a subtree narrower than a pixel or off screen is skipped whole.
	const stack: { node: number; offset: number }[] = [];
	const pushChildren = (node: number, offset: number) => {
		let at = offset;
		for (const child of children[node]) {
			stack.push({ node: child, offset: at });
			at += profile.nodes[child].total;
		}
	};
	pushChildren(model.focusNode, 0);
	while (stack.length) {
		const { node, offset } = stack.pop()!;
		const x = toX(offset);
		const w = (profile.nodes[node].total / focusTotal / span) * width;
		if (w < 0.4 || x > width || x + w < 0) {
			continue;
		}
		const depth = profile.nodes[node].depth;
		maxDepth = Math.max(maxDepth, depth);
		const y = rowY(depth);
		if (y > -ROW_HEIGHT && y < height) {
			drawSlice(ctx, profile, palette, model, node, x, y, w, ROW_HEIGHT);
			rects.push({ x, y, w, node });
		}
		pushChildren(node, offset);
	}
	return { rects, contentHeight: 8 + maxDepth * ROW_HEIGHT };
}

export function hitFlameGraph(rects: readonly IGraphRect[], x: number, y: number): number | undefined {
	for (let i = rects.length - 1; i >= 0; i--) {
		const rect = rects[i];
		if (y >= rect.y && y < rect.y + ROW_HEIGHT && x >= rect.x && x < rect.x + Math.max(rect.w, 1)) {
			return rect.node;
		}
	}
	return undefined;
}

// --- Heat map: rows by time buckets (or any matrix) ----------------------------------------------

export interface IHeatModel {
	readonly rows: readonly string[];
	/** Column labels for a matrix; a function heat map has a time axis instead. */
	readonly columns?: readonly string[];
	readonly range?: ITimeRange;
	readonly values: readonly ArrayLike<number>[];
	readonly max: number;
	readonly unit: VoltProfileUnit | 'percent';
	readonly selectedRow?: number;
	readonly hovered?: { readonly row: number; readonly column: number };
	readonly scrollTop: number;
}

export interface IHeatLayout {
	readonly labelWidth: number;
	readonly top: number;
	readonly cellWidth: number;
	readonly cellHeight: number;
	readonly rows: number;
	readonly columns: number;
}

export function heatLayout(model: IHeatModel, width: number): IHeatLayout {
	const columns = model.values[0]?.length ?? 0;
	const labelWidth = Math.min(260, Math.max(120, Math.round(width * 0.24)));
	return { labelWidth, top: RULER_HEIGHT, cellWidth: (width - labelWidth) / Math.max(1, columns), cellHeight: 20, rows: model.rows.length, columns };
}

export function drawHeatmap(target: IDrawTarget, model: IHeatModel, palette: IProfilerPalette): IHeatLayout {
	const { ctx, width, height } = target;
	const layout = heatLayout(model, width);
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, width, height);
	ctx.font = `11px ${palette.font}`;
	ctx.textBaseline = 'middle';
	for (let row = 0; row < layout.rows; row++) {
		const y = layout.top + row * layout.cellHeight - model.scrollTop;
		if (y + layout.cellHeight < layout.top || y > height) {
			continue;
		}
		const values = model.values[row];
		for (let column = 0; column < layout.columns; column++) {
			const value = values[column];
			if (value > 0) {
				ctx.fillStyle = cellColor(value / Math.max(1e-12, model.max));
				ctx.fillRect(layout.labelWidth + column * layout.cellWidth, y, Math.max(1, layout.cellWidth - (layout.cellWidth > 4 ? 1 : 0)), layout.cellHeight - 1);
			}
		}
		ctx.fillStyle = row === model.selectedRow ? palette.accent : palette.foreground;
		ctx.fillText(fitText(ctx, model.rows[row], layout.labelWidth - 12), 6, y + layout.cellHeight / 2);
		if (row === model.selectedRow) {
			ctx.strokeStyle = palette.accent;
			ctx.strokeRect(layout.labelWidth + 0.5, y + 0.5, width - layout.labelWidth - 1, layout.cellHeight - 2);
		}
	}
	if (model.hovered) {
		const x = layout.labelWidth + model.hovered.column * layout.cellWidth;
		const y = layout.top + model.hovered.row * layout.cellHeight - model.scrollTop;
		ctx.strokeStyle = palette.foreground;
		ctx.strokeRect(x + 0.5, y + 0.5, Math.max(2, layout.cellWidth - 1), layout.cellHeight - 2);
	}
	// The axis: time for a function heat map, column labels for a matrix.
	if (model.range) {
		drawRuler(target, model.range, palette, 0, RULER_HEIGHT, layout.labelWidth);
	} else if (model.columns) {
		ctx.fillStyle = palette.background;
		ctx.fillRect(layout.labelWidth, 0, width - layout.labelWidth, RULER_HEIGHT);
		ctx.font = `10px ${palette.font}`;
		ctx.fillStyle = palette.muted;
		const every = Math.max(1, Math.ceil(60 / Math.max(1, layout.cellWidth)));
		for (let column = 0; column < layout.columns; column += every) {
			ctx.fillText(fitText(ctx, model.columns[column] ?? '', layout.cellWidth * every - 4), layout.labelWidth + column * layout.cellWidth + 2, RULER_HEIGHT / 2);
		}
	}
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, layout.labelWidth, RULER_HEIGHT);
	return layout;
}

export function hitHeatmap(layout: IHeatLayout, scrollTop: number, x: number, y: number): { readonly row: number; readonly column: number } | undefined {
	if (y < layout.top) {
		return undefined;
	}
	const row = Math.floor((y - layout.top + scrollTop) / layout.cellHeight);
	if (row < 0 || row >= layout.rows) {
		return undefined;
	}
	const column = x < layout.labelWidth ? -1 : Math.floor((x - layout.labelWidth) / layout.cellWidth);
	return column < layout.columns ? { row, column } : undefined;
}

// --- Counters: values over time, one band each ---------------------------------------------------

export function drawCounters(target: IDrawTarget, counters: readonly IProfileCounter[], range: ITimeRange, palette: IProfilerPalette, hoverTime?: number): void {
	const { ctx, width, height } = target;
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, width, height);
	drawGrid(target, range, palette, RULER_HEIGHT);
	const bandHeight = Math.max(60, (height - RULER_HEIGHT) / Math.max(1, counters.length));
	counters.forEach((counter, index) => {
		const top = RULER_HEIGHT + index * bandHeight;
		let min = 0;
		let max = 0;
		for (const point of counter.points) {
			max = Math.max(max, point[1]);
			min = Math.min(min, point[1]);
		}
		const scaleY = (value: number) => top + bandHeight - 6 - ((value - min) / Math.max(1e-9, max - min)) * (bandHeight - 26);
		const hue = (hash(counter.name) % 300 + 30) % 360;
		ctx.strokeStyle = `hsl(${hue}, 65%, ${palette.dark ? 62 : 42}%)`;
		ctx.fillStyle = `hsla(${hue}, 65%, ${palette.dark ? 62 : 42}%, 0.18)`;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		let started = false;
		let firstX = 0;
		let lastX = 0;
		for (const [time, value] of counter.points) {
			const x = timeToX(time, range, width);
			if (!started) {
				ctx.moveTo(x, scaleY(value));
				firstX = x;
				started = true;
			} else {
				ctx.lineTo(x, scaleY(value));
			}
			lastX = x;
		}
		ctx.stroke();
		ctx.lineTo(lastX, scaleY(min));
		ctx.lineTo(firstX, scaleY(min));
		ctx.closePath();
		ctx.fill();
		ctx.font = `11px ${palette.font}`;
		ctx.textBaseline = 'top';
		ctx.fillStyle = palette.foreground;
		let label = `${counter.name}  max ${formatValue(max, counter.unit)}`;
		if (hoverTime !== undefined) {
			const at = counter.points.reduce((best, point) => Math.abs(point[0] - hoverTime) < Math.abs(best[0] - hoverTime) ? point : best, counter.points[0] ?? [0, 0]);
			label = `${counter.name}  ${formatValue(at[1], counter.unit)} at ${formatMs(at[0])}`;
		}
		ctx.fillText(label, 6, top + 4);
		ctx.strokeStyle = palette.grid;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, top + bandHeight - 0.5);
		ctx.lineTo(width, top + bandHeight - 0.5);
		ctx.stroke();
	});
	if (hoverTime !== undefined) {
		const x = Math.round(timeToX(hoverTime, range, width)) + 0.5;
		ctx.strokeStyle = palette.foreground;
		ctx.globalAlpha = 0.5;
		ctx.beginPath();
		ctx.moveTo(x, RULER_HEIGHT);
		ctx.lineTo(x, height);
		ctx.stroke();
		ctx.globalAlpha = 1;
	}
	drawRuler(target, range, palette);
}

// --- Overview: how busy each moment is, over the whole run ---------------------------------------

export interface IOverviewColumn {
	/** 0 (idle) to 1 (busy all of the column's time). */
	readonly busy: number;
	readonly color: string;
}

/** One column per pixel: the share of non-idle time, colored by the category that took most of it. */
export function overviewColumns(profile: IVoltProfile, columns: number, colorOf: (category: string, name: string) => string): IOverviewColumn[] {
	const timeline = profile.timeline;
	if (!timeline || timeline.duration <= 0 || columns <= 0) {
		return [];
	}
	const span = timeline.duration / columns;
	const busy = new Float64Array(columns);
	const byCategory: Map<string, number>[] = Array.from({ length: columns }, () => new Map());
	const add = (start: number, end: number, category: string) => {
		for (let column = Math.max(0, Math.floor(start / span)); column < columns && column * span < end; column++) {
			const piece = Math.min(end, (column + 1) * span) - Math.max(start, column * span);
			if (piece > 0) {
				busy[column] += piece;
				byCategory[column].set(category, (byCategory[column].get(category) ?? 0) + piece);
			}
		}
	};
	if (timeline.sampleTimes.length) {
		for (let i = 0; i < timeline.sampleTimes.length; i++) {
			const category = profile.frames[profile.nodes[timeline.sampleNodes[i]].frame].category;
			if (category !== 'idle' && category !== 'program') {
				add(timeline.sampleTimes[i], timeline.sampleTimes[i] + timeline.sampleDurations[i], category);
			}
		}
	} else {
		const lane = timeline.lanes[0];
		for (let i = 0; i < (lane?.start.length ?? 0); i++) {
			add(lane.start[i], lane.end[i], profile.frames[profile.nodes[lane.node[i]].frame].category);
		}
	}
	return Array.from({ length: columns }, (_, column) => {
		let top = 'app';
		let most = -1;
		for (const [category, value] of byCategory[column]) {
			if (value > most) {
				most = value;
				top = category;
			}
		}
		return { busy: Math.min(1, busy[column] / span), color: colorOf(top, top) };
	});
}

export function drawOverview(target: IDrawTarget, columns: readonly IOverviewColumn[], counters: readonly IProfileCounter[], duration: number, view: ITimeRange, palette: IProfilerPalette): void {
	const { ctx, width, height } = target;
	ctx.fillStyle = palette.background;
	ctx.fillRect(0, 0, width, height);
	const scale = width / Math.max(1, columns.length);
	columns.forEach((column, index) => {
		if (column.busy > 0) {
			ctx.fillStyle = column.color;
			const h = Math.max(1, column.busy * (height - 6));
			ctx.fillRect(index * scale, height - h, Math.max(1, scale), h);
		}
	});
	const counter = counters[0];
	if (counter?.points.length) {
		let max = 0;
		for (const point of counter.points) {
			max = Math.max(max, point[1]);
		}
		ctx.strokeStyle = palette.foreground;
		ctx.globalAlpha = 0.7;
		ctx.lineWidth = 1;
		ctx.beginPath();
		counter.points.forEach(([time, value], index) => {
			const x = (time / Math.max(1e-9, duration)) * width;
			const y = height - 3 - (value / Math.max(1e-9, max)) * (height - 8);
			if (index === 0) {
				ctx.moveTo(x, y);
			} else {
				ctx.lineTo(x, y);
			}
		});
		ctx.stroke();
		ctx.globalAlpha = 1;
	}
	// The window the main view shows; the rest is shaded.
	const x0 = (view.start / Math.max(1e-9, duration)) * width;
	const x1 = (view.end / Math.max(1e-9, duration)) * width;
	ctx.fillStyle = palette.dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.6)';
	ctx.fillRect(0, 0, Math.max(0, x0), height);
	ctx.fillRect(x1, 0, Math.max(0, width - x1), height);
	ctx.strokeStyle = palette.accent;
	ctx.lineWidth = 1;
	ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(2, Math.round(x1 - x0) - 1), height - 1);
}
