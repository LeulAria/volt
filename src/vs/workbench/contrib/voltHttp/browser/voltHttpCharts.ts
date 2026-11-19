/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

/**
 * Small chart primitives for the Volt Client (performance results): plain SVG built node by node,
 * coloured from the theme (`var(--vscode-charts-*)` set as styles, never as attributes, which
 * would not read the variables). Every chart follows its container's width; hover shows exact
 * values. One y axis per chart: a second measure gets its own chart under the first.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attributes: Readonly<Record<string, string | number>> = {}, className?: string): SVGElementTagNameMap[K] {
	const element = parent.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attributes)) {
		element.setAttribute(key, String(value));
	}
	if (className) {
		element.setAttribute('class', className);
	}
	parent.appendChild(element);
	return element;
}

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten at or above `value`. */
export function httpChartNiceMax(value: number): number {
	if (!(value > 0) || !Number.isFinite(value)) {
		return 1;
	}
	const power = 10 ** Math.floor(Math.log10(value));
	for (const step of [1, 2, 2.5, 5, 10]) {
		if (step * power >= value * 0.9999) {
			return step * power;
		}
	}
	return 10 * power;
}

/** Calls `redraw` when the element's width changes (it is drawn for one width). */
function watchWidth(element: HTMLElement, redraw: () => void): IDisposable {
	const Observer = getWindow(element).ResizeObserver;
	if (!Observer) {
		return Disposable.None;
	}
	let width = -1;
	const observer = new Observer(entries => {
		const next = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
		if (next !== width) {
			width = next;
			redraw();
		}
	});
	observer.observe(element);
	return toDisposable(() => observer.disconnect());
}

/** The hover box of a chart: inside the plot, kept within its width. */
class ChartTooltip {
	readonly element: HTMLElement;
	constructor(parent: HTMLElement) {
		this.element = append(parent, $('.volt-http-chart-tip'));
		this.element.setAttribute('aria-hidden', 'true');
		this.hide();
	}
	show(x: number, y: number, width: number, fill: (box: HTMLElement) => void): void {
		clearNode(this.element);
		fill(this.element);
		this.element.style.display = 'block';
		const box = this.element.offsetWidth;
		const left = x + 12 + box > width ? Math.max(0, x - 12 - box) : x + 12;
		this.element.style.left = `${left}px`;
		this.element.style.top = `${Math.max(0, y)}px`;
	}
	hide(): void {
		this.element.style.display = 'none';
	}
}

function tipRow(parent: HTMLElement, color: string | undefined, label: string, value: string, dashed?: boolean): void {
	const row = append(parent, $('.volt-http-chart-tip-row'));
	const swatch = append(row, $('span.volt-http-chart-swatch'));
	if (color) {
		swatch.style.background = color;
		swatch.classList.toggle('dashed', !!dashed);
	} else {
		swatch.classList.add('none');
	}
	append(row, $('span.volt-http-chart-tip-label')).textContent = label;
	append(row, $('span.volt-http-chart-tip-value')).textContent = value;
}

// --- Lines over time -----------------------------------------------------------------------------

export interface IHttpChartSeries {
	readonly id: string;
	readonly label: string;
	/** A CSS colour, usually `var(--vscode-charts-...)`. */
	readonly color: string;
	readonly dashed?: boolean;
	/** Filled down to the axis. */
	readonly area?: boolean;
	/** Starts hidden (the legend shows it again). */
	readonly hidden?: boolean;
}

export interface IHttpLineChartOptions {
	readonly ariaLabel: string;
	readonly series: readonly IHttpChartSeries[];
	readonly formatY: (value: number) => string;
	readonly formatX: (value: number) => string;
	/** The x axis's ticks fall on multiples of this (1 for whole seconds), never between them. */
	readonly stepX?: number;
	/** The plot's height in px (180 when absent). */
	readonly height?: number;
	/** A legend with toggles: on when there are two series or more. */
	readonly legend?: boolean;
	/** Values hold until the next point (users, a profile) instead of a straight line between points. */
	readonly step?: boolean;
	/** The least the y axis goes up to (so a quiet chart does not blow noise up). */
	readonly minMax?: number;
	/** Fewer ticks: a preview. */
	readonly compact?: boolean;
}

export interface IHttpChartShade {
	/** From the start of the x axis to this x (the warm-up). */
	readonly to: number;
	readonly label: string;
}

/** A line (or area) chart over time with gridlines, a crosshair with every value, and legend toggles. */
export class HttpLineChart extends Disposable {

	readonly element: HTMLElement;
	private readonly plot: HTMLElement;
	private readonly legendEl: HTMLElement | undefined;
	private readonly tooltip: ChartTooltip;
	private readonly hidden = new Set<string>();
	private xs: readonly number[] = [];
	private values: Readonly<Record<string, readonly number[]>> = {};
	private shade: IHttpChartShade | undefined;
	private svgEl: SVGSVGElement | undefined;
	private crosshair: SVGLineElement | undefined;
	private dots: SVGCircleElement[] = [];
	/** The geometry of the last drawing, for the hover. */
	private geometry: { readonly left: number; readonly width: number; readonly top: number; readonly height: number; readonly maxX: number; readonly minX: number; readonly maxY: number } | undefined;

	constructor(parent: HTMLElement, private readonly options: IHttpLineChartOptions) {
		super();
		this.element = append(parent, $('.volt-http-chart'));
		for (const series of options.series) {
			if (series.hidden) {
				this.hidden.add(series.id);
			}
		}
		if (options.legend ?? options.series.length > 1) {
			this.legendEl = append(this.element, $('.volt-http-chart-legend'));
			this.renderLegend();
		}
		this.plot = append(this.element, $('.volt-http-chart-plot'));
		this.plot.style.height = `${options.height ?? 180}px`;
		this.plot.setAttribute('role', 'img');
		this.plot.setAttribute('aria-label', options.ariaLabel);
		this.tooltip = new ChartTooltip(this.plot);
		this._register(watchWidth(this.plot, () => this.draw()));
		this._register(addDisposableListener(this.plot, EventType.MOUSE_MOVE, (event: MouseEvent) => this.hover(event)));
		this._register(addDisposableListener(this.plot, EventType.MOUSE_LEAVE, () => this.unhover()));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	setData(xs: readonly number[], values: Readonly<Record<string, readonly number[]>>, shade?: IHttpChartShade): void {
		this.xs = xs;
		this.values = values;
		this.shade = shade;
		this.draw();
	}

	private renderLegend(): void {
		const legend = this.legendEl!;
		clearNode(legend);
		for (const series of this.options.series) {
			const key = append(legend, $('button.volt-http-chart-key')) as HTMLButtonElement;
			key.type = 'button';
			const on = !this.hidden.has(series.id);
			key.classList.toggle('off', !on);
			key.setAttribute('aria-pressed', String(on));
			setAgentTooltip(key, on ? localize('voltHttp.perfChartHide', "Hide {0}", series.label) : localize('voltHttp.perfChartShow', "Show {0}", series.label));
			const swatch = append(key, $('span.volt-http-chart-swatch'));
			swatch.style.background = series.color;
			swatch.classList.toggle('dashed', !!series.dashed);
			append(key, $('span')).textContent = series.label;
			key.addEventListener('click', () => {
				if (this.hidden.has(series.id)) {
					this.hidden.delete(series.id);
				} else if (this.options.series.length - this.hidden.size > 1) {
					// The last one shown stays: an empty chart says nothing.
					this.hidden.add(series.id);
				}
				this.renderLegend();
				this.draw();
			});
		}
	}

	private visible(): readonly IHttpChartSeries[] {
		return this.options.series.filter(series => !this.hidden.has(series.id));
	}

	private draw(): void {
		this.svgEl?.remove();
		this.svgEl = undefined;
		this.crosshair = undefined;
		this.dots = [];
		this.geometry = undefined;
		this.tooltip.hide();
		const width = this.plot.clientWidth;
		const height = this.options.height ?? 180;
		if (width < 40) {
			return;
		}
		const compact = !!this.options.compact;
		const root = svg(this.plot, 'svg', { width, height, viewBox: `0 0 ${width} ${height}` }, 'volt-http-chart-svg');
		this.svgEl = root;
		const series = this.visible();
		const finite = series.flatMap(item => (this.values[item.id] ?? []).filter(Number.isFinite));
		const maxY = httpChartNiceMax(Math.max(this.options.minMax ?? 0, ...finite, 0));
		const ticksY = compact ? 2 : 4;
		const labelWidth = Math.max(...Array.from({ length: ticksY + 1 }, (_value, at) => this.options.formatY(maxY * at / ticksY).length)) * 6.2 + 8;
		const left = Math.max(compact ? 24 : 32, Math.ceil(labelWidth));
		const right = 8;
		const top = 8;
		const bottom = compact ? 18 : 22;
		const plotW = Math.max(10, width - left - right);
		const plotH = Math.max(10, height - top - bottom);
		const minX = this.xs.length ? Math.min(this.xs[0], 0) : 0;
		const maxX = Math.max(minX + 1, this.xs.length ? this.xs[this.xs.length - 1] : 1);
		const x = (value: number) => left + (value - minX) / (maxX - minX) * plotW;
		const y = (value: number) => top + plotH - Math.max(0, Math.min(1, value / maxY)) * plotH;
		this.geometry = { left, width: plotW, top, height: plotH, maxX, minX, maxY };

		if (this.shade && this.shade.to > minX) {
			const to = Math.min(maxX, this.shade.to);
			const band = svg(root, 'rect', { x: x(minX), y: top, width: Math.max(0, x(to) - x(minX)), height: plotH }, 'volt-http-chart-shade');
			svg(band, 'title').textContent = this.shade.label;
			if (x(to) - x(minX) > 50 && !compact) {
				svg(root, 'text', { x: x(minX) + 4, y: top + 11 }, 'volt-http-chart-shade-label').textContent = this.shade.label;
			}
		}
		for (let at = 0; at <= ticksY; at++) {
			const value = maxY * at / ticksY;
			const lineY = Math.round(y(value)) + 0.5;
			svg(root, 'line', { x1: left, x2: left + plotW, y1: lineY, y2: lineY }, at === 0 ? 'volt-http-chart-axis' : 'volt-http-chart-grid');
			svg(root, 'text', { x: left - 6, y: lineY + 3.5, 'text-anchor': 'end' }, 'volt-http-chart-label').textContent = this.options.formatY(value);
		}
		const ticksX = Math.max(2, Math.min(compact ? 3 : 6, Math.floor(plotW / 70)));
		const values: number[] = [];
		const unit = this.options.stepX;
		if (unit && unit > 0 && maxX > minX) {
			// Whole steps only: a 2 s run is marked 0s, 1s, 2s at their own places, not 0s 0s 1s 1s.
			const step = unit * Math.max(1, Math.ceil((maxX - minX) / ticksX / unit));
			for (let value = Math.ceil(minX / step) * step; value <= maxX + 1e-9; value += step) {
				values.push(value);
			}
		} else {
			for (let at = 0; at <= ticksX; at++) {
				values.push(minX + (maxX - minX) * at / ticksX);
			}
		}
		// A tick whose label reads like the one before it says nothing.
		let lastLabel: string | undefined;
		for (const [index, value] of values.entries()) {
			const label = this.options.formatX(value);
			if (label === lastLabel) {
				continue;
			}
			lastLabel = label;
			const px = x(value);
			const anchor = px - left < 12 ? 'start' : left + plotW - px < 12 || index === values.length - 1 && !unit ? 'end' : 'middle';
			svg(root, 'text', { x: px, y: height - (compact ? 4 : 6), 'text-anchor': anchor }, 'volt-http-chart-label').textContent = label;
		}
		if (!this.xs.length) {
			return;
		}
		for (const item of series) {
			const values = this.values[item.id] ?? [];
			const points: string[] = [];
			for (let index = 0; index < this.xs.length; index++) {
				const value = Number.isFinite(values[index]) ? values[index] : 0;
				if (this.options.step && index > 0) {
					const before = Number.isFinite(values[index - 1]) ? values[index - 1] : 0;
					points.push(`${x(this.xs[index]).toFixed(1)},${y(before).toFixed(1)}`);
				}
				points.push(`${x(this.xs[index]).toFixed(1)},${y(value).toFixed(1)}`);
			}
			if (item.area && points.length) {
				const area = svg(root, 'polygon', { points: `${x(this.xs[0]).toFixed(1)},${y(0).toFixed(1)} ${points.join(' ')} ${x(this.xs[this.xs.length - 1]).toFixed(1)},${y(0).toFixed(1)}` }, 'volt-http-chart-area');
				area.style.fill = item.color;
			}
			if (points.length === 1) {
				const dot = svg(root, 'circle', { cx: x(this.xs[0]), cy: y(Number.isFinite(values[0]) ? values[0] : 0), r: 3 }, 'volt-http-chart-point');
				dot.style.fill = item.color;
				continue;
			}
			const line = svg(root, 'polyline', { points: points.join(' ') }, 'volt-http-chart-line');
			line.style.stroke = item.color;
			if (item.dashed) {
				line.setAttribute('stroke-dasharray', '4 3');
			}
		}
		this.crosshair = svg(root, 'line', { x1: 0, x2: 0, y1: top, y2: top + plotH }, 'volt-http-chart-crosshair');
		this.crosshair.style.display = 'none';
		this.dots = series.map(item => {
			const dot = svg(root, 'circle', { r: 3.5 }, 'volt-http-chart-dot');
			dot.style.fill = item.color;
			dot.style.display = 'none';
			return dot;
		});
	}

	private hover(event: MouseEvent): void {
		const geometry = this.geometry;
		if (!geometry || !this.xs.length || !this.crosshair) {
			return;
		}
		const box = this.plot.getBoundingClientRect();
		const px = event.clientX - box.left;
		const value = geometry.minX + (px - geometry.left) / geometry.width * (geometry.maxX - geometry.minX);
		let index = 0;
		for (let at = 1; at < this.xs.length; at++) {
			if (Math.abs(this.xs[at] - value) < Math.abs(this.xs[index] - value)) {
				index = at;
			}
		}
		const cx = geometry.left + (this.xs[index] - geometry.minX) / (geometry.maxX - geometry.minX) * geometry.width;
		this.crosshair.setAttribute('x1', cx.toFixed(1));
		this.crosshair.setAttribute('x2', cx.toFixed(1));
		this.crosshair.style.display = '';
		const series = this.visible();
		series.forEach((item, at) => {
			const raw = this.values[item.id]?.[index];
			const v = Number.isFinite(raw) ? raw : 0;
			const dot = this.dots[at];
			if (dot) {
				dot.setAttribute('cx', cx.toFixed(1));
				dot.setAttribute('cy', (geometry.top + geometry.height - Math.max(0, Math.min(1, v / geometry.maxY)) * geometry.height).toFixed(1));
				dot.style.display = '';
			}
		});
		this.tooltip.show(cx, geometry.top, this.plot.clientWidth, tip => {
			append(tip, $('.volt-http-chart-tip-title')).textContent = this.options.formatX(this.xs[index]);
			for (const item of series) {
				const raw = this.values[item.id]?.[index];
				tipRow(tip, item.color, item.label, Number.isFinite(raw) ? this.options.formatY(raw) : '-', item.dashed);
			}
		});
	}

	private unhover(): void {
		if (this.crosshair) {
			this.crosshair.style.display = 'none';
		}
		for (const dot of this.dots) {
			dot.style.display = 'none';
		}
		this.tooltip.hide();
	}
}

// --- A distribution ------------------------------------------------------------------------------

export interface IHttpHistogramBin {
	readonly from: number;
	readonly to: number;
	readonly count: number;
}

export interface IHttpHistogramMarker {
	readonly label: string;
	readonly value: number;
}

export interface IHttpHistogramOptions {
	readonly ariaLabel: string;
	readonly formatX: (value: number) => string;
	readonly color: string;
	readonly height?: number;
}

/** Bars of a distribution (bins left to right, as given) with markers at the percentiles. */
export class HttpHistogramChart extends Disposable {

	readonly element: HTMLElement;
	private readonly plot: HTMLElement;
	private readonly tooltip: ChartTooltip;
	private bins: readonly IHttpHistogramBin[] = [];
	private markers: readonly IHttpHistogramMarker[] = [];
	private svgEl: SVGSVGElement | undefined;

	constructor(parent: HTMLElement, private readonly options: IHttpHistogramOptions) {
		super();
		this.element = append(parent, $('.volt-http-chart'));
		this.plot = append(this.element, $('.volt-http-chart-plot'));
		this.plot.style.height = `${options.height ?? 180}px`;
		this.plot.setAttribute('role', 'img');
		this.plot.setAttribute('aria-label', options.ariaLabel);
		this.tooltip = new ChartTooltip(this.plot);
		this._register(watchWidth(this.plot, () => this.draw()));
		this._register(addDisposableListener(this.plot, EventType.MOUSE_LEAVE, () => this.tooltip.hide()));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	setData(bins: readonly IHttpHistogramBin[], markers: readonly IHttpHistogramMarker[]): void {
		this.bins = bins;
		this.markers = markers;
		this.draw();
	}

	private draw(): void {
		this.svgEl?.remove();
		this.svgEl = undefined;
		this.tooltip.hide();
		const width = this.plot.clientWidth;
		const height = this.options.height ?? 180;
		if (width < 40 || !this.bins.length) {
			return;
		}
		const root = svg(this.plot, 'svg', { width, height, viewBox: `0 0 ${width} ${height}` }, 'volt-http-chart-svg');
		this.svgEl = root;
		const total = this.bins.reduce((sum, bin) => sum + bin.count, 0);
		const maxY = httpChartNiceMax(Math.max(...this.bins.map(bin => bin.count)));
		const left = Math.max(32, String(maxY).length * 6.2 + 10);
		const right = 8;
		const top = 18;
		const bottom = 22;
		const plotW = Math.max(10, width - left - right);
		const plotH = Math.max(10, height - top - bottom);
		const barW = plotW / this.bins.length;
		const y = (value: number) => top + plotH - value / maxY * plotH;
		for (const value of [0, maxY / 2, maxY]) {
			const lineY = Math.round(y(value)) + 0.5;
			svg(root, 'line', { x1: left, x2: left + plotW, y1: lineY, y2: lineY }, value === 0 ? 'volt-http-chart-axis' : 'volt-http-chart-grid');
			svg(root, 'text', { x: left - 6, y: lineY + 3.5, 'text-anchor': 'end' }, 'volt-http-chart-label').textContent = Number.isInteger(value) ? String(value) : value.toFixed(1);
		}
		this.bins.forEach((bin, index) => {
			const h = bin.count / maxY * plotH;
			const x0 = left + index * barW + (barW > 4 ? 1 : 0);
			const w = Math.max(1, barW - (barW > 4 ? 2 : 0));
			// A hit target the full height of the plot: thin bars are easy to miss.
			const hit = svg(root, 'rect', { x: left + index * barW, y: top, width: barW, height: plotH }, 'volt-http-chart-hit');
			if (bin.count) {
				const radius = Math.min(2, w / 2, h);
				const yTop = top + plotH - h;
				const path = `M${x0.toFixed(1)},${(top + plotH).toFixed(1)}V${(yTop + radius).toFixed(1)}Q${x0.toFixed(1)},${yTop.toFixed(1)} ${(x0 + radius).toFixed(1)},${yTop.toFixed(1)}H${(x0 + w - radius).toFixed(1)}Q${(x0 + w).toFixed(1)},${yTop.toFixed(1)} ${(x0 + w).toFixed(1)},${(yTop + radius).toFixed(1)}V${(top + plotH).toFixed(1)}Z`;
				const bar = svg(root, 'path', { d: path }, 'volt-http-chart-bar');
				bar.style.fill = this.options.color;
			}
			hit.addEventListener('mouseenter', () => {
				this.tooltip.show(left + (index + 0.5) * barW, top, width, tip => {
					append(tip, $('.volt-http-chart-tip-title')).textContent = localize('voltHttp.perfChartRange', "{0} to {1}", this.options.formatX(bin.from), this.options.formatX(bin.to));
					tipRow(tip, this.options.color, String(bin.count), total ? `${(bin.count / total * 100).toFixed(1)}%` : '');
				});
			});
		});
		const position = (value: number) => {
			let index = this.bins.findIndex(bin => value < bin.to);
			if (index < 0) {
				index = this.bins.length - 1;
			}
			const bin = this.bins[index];
			const within = bin.to > bin.from ? Math.min(1, Math.max(0, (value - bin.from) / (bin.to - bin.from))) : 0.5;
			return left + (index + within) * barW;
		};
		let lastLabelX = -Infinity;
		for (const marker of this.markers) {
			const mx = Math.round(position(marker.value)) + 0.5;
			svg(root, 'line', { x1: mx, x2: mx, y1: top - 4, y2: top + plotH }, 'volt-http-chart-marker');
			// Labels that would overlap the one before are left to the hover.
			if (mx - lastLabelX > 30) {
				svg(root, 'text', { x: mx, y: top - 7, 'text-anchor': 'middle' }, 'volt-http-chart-marker-label').textContent = marker.label;
				lastLabelX = mx;
			}
		}
		const axis = [0, Math.floor((this.bins.length - 1) / 2), this.bins.length - 1];
		for (const [at, index] of axis.entries()) {
			const value = at === 2 ? this.bins[index].to : this.bins[index].from;
			const tx = at === 2 ? left + plotW : left + index * barW + (at === 1 ? barW / 2 : 0);
			svg(root, 'text', { x: tx, y: height - 6, 'text-anchor': at === 0 ? 'start' : at === 2 ? 'end' : 'middle' }, 'volt-http-chart-label').textContent = this.options.formatX(value);
		}
	}
}

// --- Parts of a whole ----------------------------------------------------------------------------

export interface IHttpStackSegment {
	readonly label: string;
	readonly count: number;
	readonly color: string;
}

/** One horizontal bar split by share (status classes), with a legend of counts and percentages. */
export function renderHttpStackedBar(parent: HTMLElement, segments: readonly IHttpStackSegment[], ariaLabel: string): HTMLElement {
	const element = append(parent, $('.volt-http-chart.volt-http-stack'));
	const shown = segments.filter(segment => segment.count > 0);
	const total = shown.reduce((sum, segment) => sum + segment.count, 0);
	const bar = append(element, $('.volt-http-stack-bar'));
	bar.setAttribute('role', 'img');
	bar.setAttribute('aria-label', `${ariaLabel}: ${shown.map(segment => `${segment.label} ${segment.count}`).join(', ') || localize('voltHttp.perfChartNone', "none")}`);
	bar.classList.toggle('empty', !total);
	for (const segment of shown) {
		const part = append(bar, $('span.volt-http-stack-part'));
		part.style.flexGrow = String(segment.count);
		part.style.background = segment.color;
		setAgentTooltip(part, `${segment.label}: ${segment.count} (${(segment.count / total * 100).toFixed(1)}%)`);
	}
	const legend = append(element, $('.volt-http-stack-legend'));
	for (const segment of shown) {
		const key = append(legend, $('span.volt-http-stack-key'));
		append(key, $('span.volt-http-chart-swatch')).style.background = segment.color;
		append(key, $('span')).textContent = segment.label;
		append(key, $('b')).textContent = String(segment.count);
		append(key, $('span.volt-http-stack-share')).textContent = `${(segment.count / total * 100).toFixed(1)}%`;
	}
	return element;
}
