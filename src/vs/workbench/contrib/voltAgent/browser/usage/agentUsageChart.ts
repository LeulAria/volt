/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { formatAxis, formatCost, formatCostTick, formatDay, formatTime, formatTokens, formatWeekday } from './agentUsageFormat.js';
import { IUsageSummary, metricValue, UsageMetric } from './agentUsageModel.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Plot height, x labels included. The readout sits above it. */
/** Plot height when nothing beside the chart sets it, x labels included. The readout sits above. */
const DEFAULT_HEIGHT = 260;
const PAD_TOP = 14;
const PAD_BOTTOM = 30;
const AXIS_GAP = 14;
const TICKS = 4;
/** The dot grid behind the plot and inside the areas: pitch and dot radius, in px. */
const DOT_PITCH = 5;
const DOT_RADIUS = 0.8;

export interface IUsageChartSeriesStyle {
	readonly label: string;
	/** CSS color, may be a `var()`. */
	readonly color: string;
}

let ids = 0;

/** 1, 2, 2.5 or 5 times a power of ten, so axis labels stay round. */
function niceStep(max: number): number {
	const raw = max / TICKS;
	if (raw <= 0) {
		return 1;
	}
	const power = Math.pow(10, Math.floor(Math.log10(raw)));
	for (const factor of [1, 2, 2.5, 5, 10]) {
		if (raw <= factor * power) {
			return factor * power;
		}
	}
	return 10 * power;
}

/**
 * Monotone cubic (Fritsch-Carlson) through the points: smooth like a hand-drawn curve but
 * never overshooting, so a quiet day never dips below zero.
 */
function monotonePath(points: readonly [number, number][]): string {
	const n = points.length;
	if (n === 0) {
		return '';
	}
	if (n === 1) {
		return `M${points[0][0]},${points[0][1]}`;
	}
	const dx: number[] = [];
	const slopes: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		dx.push(points[i + 1][0] - points[i][0]);
		slopes.push((points[i + 1][1] - points[i][1]) / (dx[i] || 1));
	}
	const tangents: number[] = [slopes[0]];
	for (let i = 1; i < n - 1; i++) {
		tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
	}
	tangents.push(slopes[n - 2]);
	for (let i = 0; i < n - 1; i++) {
		if (slopes[i] === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const a = tangents[i] / slopes[i];
		const b = tangents[i + 1] / slopes[i];
		const h = a * a + b * b;
		if (h > 9) {
			const t = 3 / Math.sqrt(h);
			tangents[i] = t * a * slopes[i];
			tangents[i + 1] = t * b * slopes[i];
		}
	}
	let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
	for (let i = 0; i < n - 1; i++) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[i + 1];
		const step = dx[i] / 3;
		d += `C${(x0 + step).toFixed(2)},${(y0 + tangents[i] * step).toFixed(2)} ${(x1 - step).toFixed(2)},${(y1 - tangents[i + 1] * step).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
	}
	return d;
}

/** The curve through each run of slots that touches a non-zero value, as separate subpaths. */
function activeRuns(points: readonly [number, number][], data: readonly number[]): string {
	let d = '';
	let run: [number, number][] = [];
	const flush = () => {
		if (run.length > 1) {
			d += monotonePath(run);
		}
		run = [];
	};
	for (let index = 0; index < points.length; index++) {
		const active = data[index] > 0 || data[index - 1] > 0 || data[index + 1] > 0;
		if (active) {
			run.push(points[index]);
		} else {
			flush();
		}
	}
	flush();
	return d;
}

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const node = parent.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, String(value));
	}
	parent.appendChild(node);
	return node;
}

/** Which slots get an x label and a dotted gridline: every 6 hours, every day, or every week back from today. */
function labelIndexes(summary: IUsageSummary): number[] {
	const slots = summary.slots;
	const last = slots.length - 1;
	if (summary.hourly) {
		return slots.map((slot, index) => new Date(slot.start).getHours() % 6 === 0 ? index : -1).filter(index => index >= 0);
	}
	const every = slots.length <= 7 ? 1 : slots.length <= 31 ? 7 : 14;
	const indexes: number[] = [];
	for (let index = last; index >= 0; index -= every) {
		indexes.unshift(index);
	}
	return indexes;
}

/** `12AM`, `MON`, `SEP 4`: the compact uppercase labels a weather chart uses. */
function axisLabel(summary: IUsageSummary, index: number): string {
	const start = summary.slots[index].start;
	if (summary.hourly) {
		return formatAxis(start, true).replace(/\s+/g, '').toUpperCase();
	}
	if (summary.slots.length <= 7) {
		return formatWeekday(start).toUpperCase();
	}
	return formatAxis(start, false).toUpperCase();
}

/**
 * Usage over the range, drawn like Apple Weather's wind chart: thick dashed curves over soft
 * fills, a white cursor line with a knob on the busiest provider, and a readout above the
 * cursor. With no pointer the cursor rests on the newest slot, the way Weather rests on now.
 */
export class UsageChart extends Disposable {

	readonly element: HTMLElement;
	private readonly readout: HTMLElement;
	private readonly readoutLabel: HTMLElement;
	private readonly readoutValue: HTMLElement;
	private readonly readoutDetail: HTMLElement;
	private readonly plot: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private summary: IUsageSummary | undefined;
	private metric: UsageMetric = 'cost';
	private styles: ReadonlyMap<VoltUsageProvider, IUsageChartSeriesStyle> = new Map();
	private width = 0;
	private height = 0;
	private moveTo: ((index: number, glide: boolean) => void) | undefined;

	constructor(parent: HTMLElement) {
		super();
		this.element = append(parent, $('.volt-usage-chart'));
		this.readout = append(this.element, $('.volt-usage-readout'));
		this.readoutLabel = append(this.readout, $('.label'));
		this.readoutValue = append(this.readout, $('.value'));
		this.readoutDetail = append(this.readout, $('.detail'));
		this.plot = append(this.element, $('.volt-usage-chart-plot'));
		// The plot fills whatever height its column gives it (the agents list beside it, on the
		// usage page), so it re-renders when that changes, not only the width.
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout());
		observer.observe(this.plot);
		this._register(toDisposable(() => observer.disconnect()));
		this.plot.tabIndex = 0;
		this.plot.setAttribute('role', 'img');
	}

	update(summary: IUsageSummary, metric: UsageMetric, styles: ReadonlyMap<VoltUsageProvider, IUsageChartSeriesStyle>, animate: boolean): void {
		this.summary = summary;
		this.metric = metric;
		this.styles = styles;
		this.render(animate);
	}

	layout(): void {
		const width = this.plot.clientWidth;
		const height = this.plot.clientHeight;
		if (width && (width !== this.width || height !== this.height)) {
			this.render(false);
		}
	}

	private format(value: number): string {
		return this.metric === 'cost' ? formatCost(value) : formatTokens(value);
	}

	private render(animate: boolean): void {
		this.renderStore.clear();
		this.plot.replaceChildren();
		const summary = this.summary;
		const width = this.plot.clientWidth;
		const HEIGHT = this.plot.clientHeight || DEFAULT_HEIGHT;
		this.width = width;
		this.height = this.plot.clientHeight;
		if (!summary || !width) {
			return;
		}
		const slots = summary.slots;
		const last = slots.length - 1;
		const providers = summary.providers.map(row => row.provider).filter(provider => this.styles.has(provider));
		const values = new Map(providers.map(provider => [provider, slots.map(slot => {
			const totals = slot.byProvider.get(provider);
			return totals ? metricValue(totals, this.metric) : 0;
		})]));
		let max = 0;
		for (const series of values.values()) {
			for (const value of series) {
				max = Math.max(max, value);
			}
		}
		const step = niceStep(max || (this.metric === 'cost' ? 1 : 1000));
		const top = step * TICKS;
		const tickLabels = Array.from({ length: TICKS + 1 }, (_, index) => this.metric === 'cost' ? formatCostTick(step * index, step) : formatTokens(step * index));

		// The y axis sits on the right, as in Weather; measure its widest label.
		const measure = append(this.plot, $('span.volt-usage-chart-measure'));
		let labelWidth = 0;
		for (const label of tickLabels) {
			measure.textContent = label;
			labelWidth = Math.max(labelWidth, measure.offsetWidth);
		}
		measure.remove();
		// Values on the left, like a ledger; the plot runs to the right edge.
		const left = labelWidth + AXIS_GAP;
		const right = width - 6;
		const plotWidth = Math.max(10, right - left);
		const plotBottom = HEIGHT - PAD_BOTTOM;
		const plotHeight = plotBottom - PAD_TOP;
		const x = (index: number) => left + (slots.length === 1 ? plotWidth / 2 : (index / last) * plotWidth);
		const y = (value: number) => PAD_TOP + plotHeight - (value / top) * plotHeight;

		const root = svg(this.plot, 'svg', { width, height: HEIGHT, class: 'volt-usage-chart-svg' });
		const defs = svg(root, 'defs');

		const grid = svg(root, 'g', { class: 'grid' });
		for (let index = 0; index <= TICKS; index++) {
			const lineY = Math.round(y(step * index)) + 0.5;
			if (index === 0) {
				svg(grid, 'line', { x1: left, x2: right, y1: lineY, y2: lineY, class: 'baseline' });
			}
			const label = svg(grid, 'text', { x: labelWidth, y: lineY, class: 'tick y', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
			label.textContent = tickLabels[index];
		}
		for (const index of labelIndexes(summary)) {
			const lineX = Math.round(x(index)) + 0.5;
			const label = svg(grid, 'text', { x: lineX + 5, y: HEIGHT - 6, class: 'tick x', 'text-anchor': 'start' });
			label.textContent = axisLabel(summary, index);
			if (lineX + 5 + label.getComputedTextLength() > right) {
				label.remove();
			}
		}

		const clipId = `volt-usage-clip-${++ids}`;
		const clip = svg(defs, 'clipPath', { id: clipId });
		const clipRect = svg(clip, 'rect', { x: left - 4, y: 0, width: right - left + 10, height: HEIGHT });
		if (animate) {
			clipRect.classList.add('reveal');
		}
		// Brighter dots under the curves, on the background grid, so the areas read as the dot-matrix
		// meters on the Limits page. Each area's dots fade from its curve down to the baseline: the mask
		// works in the shape's own box, so a low hump fades as gently as a tall peak.
		const fadeGradientId = `volt-usage-dot-fade-${++ids}`;
		const fadeGradient = svg(defs, 'linearGradient', { id: fadeGradientId, x1: 0, x2: 0, y1: 0, y2: 1 });
		const fadeTop = svg(fadeGradient, 'stop', { offset: '0%' });
		fadeTop.style.stopColor = '#fff';
		fadeTop.style.stopOpacity = '1';
		const fadeBottom = svg(fadeGradient, 'stop', { offset: '100%' });
		fadeBottom.style.stopColor = '#fff';
		fadeBottom.style.stopOpacity = '0.06';
		const fadeMaskId = `volt-usage-dot-mask-${++ids}`;
		const fadeMask = svg(defs, 'mask', { id: fadeMaskId, maskContentUnits: 'objectBoundingBox' });
		svg(fadeMask, 'rect', { x: 0, y: 0, width: 1, height: 1, fill: `url(#${fadeGradientId})` });

		// A faint dot grid across the whole plot, behind the curves. The areas light the same grid.
		const gridId = `volt-usage-grid-${++ids}`;
		const gridPattern = svg(defs, 'pattern', { id: gridId, width: DOT_PITCH, height: DOT_PITCH, patternUnits: 'userSpaceOnUse' });
		svg(gridPattern, 'circle', { cx: DOT_PITCH / 2, cy: DOT_PITCH / 2, r: DOT_RADIUS, class: 'grid-dot' });
		svg(root, 'rect', { x: left, y: PAD_TOP, width: plotWidth, height: plotHeight, fill: `url(#${gridId})`, class: 'dot-grid' });

		const series = svg(root, 'g', { 'clip-path': `url(#${clipId})` });
		// Smallest last, so the quieter providers draw on top and stay visible.
		providers.forEach((provider, order) => {
			const style = this.styles.get(provider)!;
			const data = values.get(provider)!;
			const points = data.map((value, index) => [x(index), y(value)] as [number, number]);
			const line = monotonePath(points);
			const gradientId = `volt-usage-fill-${++ids}`;
			const gradient = svg(defs, 'linearGradient', { id: gradientId, x1: 0, x2: 0, y1: 0, y2: 1 });
			const stopTop = svg(gradient, 'stop', { offset: '0%' });
			stopTop.style.stopColor = style.color;
			stopTop.style.stopOpacity = order === 0 ? '0.22' : '0.12';
			const stopBottom = svg(gradient, 'stop', { offset: '100%' });
			stopBottom.style.stopColor = style.color;
			stopBottom.style.stopOpacity = '0';
			const area = `${line}L${points[last][0]},${plotBottom}L${points[0][0]},${plotBottom}Z`;
			svg(series, 'path', { d: area, fill: `url(#${gradientId})`, class: 'area' });
			const dotsId = `volt-usage-dots-${++ids}`;
			const dots = svg(defs, 'pattern', { id: dotsId, width: DOT_PITCH, height: DOT_PITCH, patternUnits: 'userSpaceOnUse' });
			const dot = svg(dots, 'circle', { cx: DOT_PITCH / 2, cy: DOT_PITCH / 2, r: DOT_RADIUS });
			dot.style.fill = style.color;
			svg(series, 'path', { d: area, fill: `url(#${dotsId})`, mask: `url(#${fadeMaskId})`, class: order === 0 ? 'area-dots primary' : 'area-dots' });
			// Drawn only where the provider was used: idle days would stack every series on the baseline.
			const stroke = svg(series, 'path', { d: activeRuns(points, data), class: order === 0 ? 'line primary' : 'line' });
			stroke.style.stroke = style.color;
			if (order === 0) {
				// A soft glow in the line's own color lifts the busiest provider off its fill.
				stroke.style.filter = `drop-shadow(0 2px 5px color-mix(in srgb, ${style.color} 40%, transparent))`;
			}
		});

		// Cursor: a rule that fades in from the readout down to the baseline, a knob with a soft
		// halo on the busiest series, small dots on the others.
		const ruleId = `volt-usage-rule-${++ids}`;
		const ruleGradient = svg(defs, 'linearGradient', { id: ruleId, x1: 0, x2: 0, y1: 0, y2: plotBottom, gradientUnits: 'userSpaceOnUse' });
		svg(ruleGradient, 'stop', { offset: '0%', class: 'rule-stop fade' });
		svg(ruleGradient, 'stop', { offset: '22%', class: 'rule-stop' });
		svg(ruleGradient, 'stop', { offset: '100%', class: 'rule-stop' });
		const cursor = svg(root, 'g', { class: 'cursor' });
		svg(cursor, 'line', { x1: 0, x2: 0, y1: 0, y2: plotBottom, class: 'rule', stroke: `url(#${ruleId})` });
		const rings = providers.map(provider => {
			const ring = svg(cursor, 'circle', { cx: 0, r: 3.5, class: 'ring' });
			ring.style.fill = this.styles.get(provider)!.color;
			return ring;
		});
		const halo = svg(cursor, 'circle', { cx: 0, r: 13, class: 'halo' });
		const knob = svg(cursor, 'circle', { cx: 0, r: 6, class: 'knob' });

		let current = -1;
		this.moveTo = (index: number, glide: boolean) => {
			index = Math.max(0, Math.min(last, index));
			const cx = x(index);
			cursor.classList.toggle('glide', glide);
			this.readout.classList.toggle('glide', glide);
			cursor.style.transform = `translateX(${cx}px)`;
			let busiest = 0;
			let busiestValue = -1;
			providers.forEach((provider, order) => {
				const value = values.get(provider)![index];
				rings[order].style.cy = `${y(value)}px`;
				rings[order].style.opacity = value > 0 ? '1' : '0';
				if (value > busiestValue) {
					busiestValue = value;
					busiest = order;
				}
			});
			knob.style.cy = `${y(Math.max(0, busiestValue))}px`;
			halo.style.cy = knob.style.cy;
			halo.style.fill = this.styles.get(providers[busiest])?.color ?? '';
			providers.forEach((_, order) => rings[order].classList.toggle('hidden', order === busiest));
			if (index !== current) {
				current = index;
				this.renderReadout(index, providers, values);
			}
			const readoutWidth = this.readout.offsetWidth;
			const offset = Math.max(0, Math.min(width - readoutWidth, cx - readoutWidth / 2));
			this.readout.style.transform = `translateX(${offset}px)`;
			this.plot.setAttribute('aria-label', `${this.readoutLabel.textContent}: ${this.readoutValue.textContent}`);
		};
		this.moveTo(last, false);
		getWindow(this.plot).requestAnimationFrame(() => this.moveTo?.(current < 0 ? last : current, false));

		const hit = svg(root, 'rect', { x: left - 6, y: 0, width: right - left + 12, height: HEIGHT, class: 'hit' });
		const indexAt = (clientX: number) => {
			const bounds = hit.getBoundingClientRect();
			const ratio = Math.min(1, Math.max(0, (clientX - bounds.left - 6) / plotWidth));
			return Math.round(ratio * last);
		};
		this.renderStore.add(addDisposableListener(hit, 'pointermove', e => this.moveTo?.(indexAt(e.clientX), true)));
		this.renderStore.add(addDisposableListener(hit, 'pointerleave', () => this.moveTo?.(last, true)));
		this.renderStore.add(addDisposableListener(this.plot, 'keydown', e => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				e.preventDefault();
				this.moveTo?.(current + (e.key === 'ArrowLeft' ? -1 : 1), true);
			} else if (e.key === 'End' || e.key === 'Home') {
				e.preventDefault();
				this.moveTo?.(e.key === 'End' ? last : 0, true);
			}
		}));
	}

	private renderReadout(index: number, providers: readonly VoltUsageProvider[], values: ReadonlyMap<VoltUsageProvider, number[]>): void {
		const summary = this.summary!;
		const start = summary.slots[index].start;
		const last = summary.slots.length - 1;
		if (summary.hourly) {
			this.readoutLabel.textContent = index === last
				? localize('voltUsage.thisHour', "This hour")
				: formatTime(start);
		} else {
			this.readoutLabel.textContent = index === last
				? localize('voltUsage.today', "Today")
				: index === last - 1 ? localize('voltUsage.yesterday', "Yesterday") : formatDay(start);
		}
		let total = 0;
		const parts: [number, string][] = [];
		for (const provider of providers) {
			const value = values.get(provider)![index];
			total += value;
			if (value > 0) {
				parts.push([value, `${this.styles.get(provider)!.label} ${this.format(value)}`]);
			}
		}
		this.readoutValue.textContent = this.format(total);
		this.readoutDetail.textContent = parts.length
			? parts.sort((a, b) => b[0] - a[0]).map(([, text]) => text).join('  ·  ')
			: localize('voltUsage.noUsageSlot', "No usage");
	}
}
