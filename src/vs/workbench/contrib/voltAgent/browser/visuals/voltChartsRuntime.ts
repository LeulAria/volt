/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Volt Charts: the chart engine behind agent visuals and the Usage page. Native SVG and DOM,
 * no chart library.
 *
 * All of it lives inside `voltChartsRuntime` so the same code runs in two places: called
 * directly in the workbench, and injected into a sandboxed agent page as
 * `(${voltChartsRuntime})(window)`, the way notebook preloads are. The function body must
 * therefore never reference anything outside itself: no imports, no module-level helpers,
 * no `localize` (the host passes strings in).
 */

//#region Spec (what agents and the Usage page send)

/** How values print. Custom units take a prefix and/or suffix. */
export type VoltChartUnit = 'number' | 'count' | 'percent' | 'ratio' | 'usd' | 'tokens' | 'ms' | 's' | 'bytes' | IVoltChartCustomUnit;

export interface IVoltChartCustomUnit {
	readonly prefix?: string;
	readonly suffix?: string;
	readonly decimals?: number;
}

export type VoltChartX = number | string;

export interface IVoltChartPointSpec {
	readonly x?: VoltChartX;
	readonly y: number | null;
	/** Names the point in the tooltip, e.g. "Session #1842". */
	readonly label?: string;
	/** Extra tooltip rows, e.g. `{ "Model": "Claude Sonnet 4.5", "Tool calls": 37 }`. */
	readonly detail?: Readonly<Record<string, string | number>>;
	/** Opened on click or Enter: `volt://session/<id>`, `volt://file/<path>#L12`, or an http(s) URL. */
	readonly href?: string;
	/** Scatter only: drives the dot's area. */
	readonly size?: number;
}

export type VoltChartDatum = number | null | readonly [VoltChartX, number | null] | IVoltChartPointSpec;

export interface IVoltChartSeriesSpec {
	readonly name: string;
	readonly data: readonly VoltChartDatum[];
	/** `accent`, `blue`, `green`, `orange`, `purple`, `yellow`, `red`, `pink`, `teal`, `muted`, 1-8, a CSS color or a `--var`. */
	readonly color?: string | number;
	readonly unit?: VoltChartUnit;
	readonly dashed?: boolean;
	/** A reference series (previous period, target): drawn muted and dashed, left out of totals. */
	readonly reference?: boolean;
	readonly hidden?: boolean;
	/** In a bar chart, draw this series as a line over the bars (a trend or an average): a composed chart. */
	readonly type?: 'line';
}

export type VoltChartStep = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | number;

export interface IVoltChartXSpec {
	readonly type?: 'time' | 'category' | 'number';
	readonly label?: string;
	readonly unit?: VoltChartUnit;
	/** With plain number arrays: the first x and the step between points (`day`, `hour`, ms or a number). */
	readonly start?: VoltChartX;
	readonly step?: VoltChartStep;
	/** `UTC` aligns and prints times in UTC; anything else is the reader's local time. */
	readonly timeZone?: string;
}

export interface IVoltChartYSpec {
	readonly label?: string;
	readonly unit?: VoltChartUnit;
	readonly min?: number;
	readonly max?: number;
	/** Force (true) or drop (false) zero from the scale. Default: bars and areas always start at zero. */
	readonly zero?: boolean;
}

export interface IVoltChartHeadlineSpec {
	readonly value?: number;
	readonly label?: string;
	readonly aggregate?: 'sum' | 'avg' | 'last' | 'max' | 'min';
	/** Compare with the previous period of the same length (default true with ranges). */
	readonly compare?: boolean;
	/** Which direction is good news; colors the change. Default neutral. */
	readonly good?: 'up' | 'down';
}

export interface IVoltChartMetricSpec {
	readonly id?: string;
	readonly label: string;
	readonly unit?: VoltChartUnit;
	readonly series: readonly IVoltChartSeriesSpec[];
	readonly headline?: boolean | IVoltChartHeadlineSpec;
}

export interface IVoltChartAnnotationSpec {
	readonly x: VoltChartX;
	readonly label?: string;
}

export interface IVoltChartRuleSpec {
	readonly y: number;
	readonly label?: string;
}

export interface IVoltChartCalloutSpec {
	readonly x: VoltChartX;
	readonly y: number;
	readonly label: string;
}

interface IVoltChartCommonSpec {
	readonly title?: string;
	readonly subtitle?: string;
	/** Footnote under the chart. */
	readonly note?: string;
	/** Plot height in px (the chart keeps it at any width). */
	readonly height?: number;
	readonly unit?: VoltChartUnit;
	readonly empty?: { readonly title?: string; readonly message?: string };
}

export type VoltCartesianType = 'line' | 'area' | 'bar' | 'stacked-area' | 'stacked-bar' | 'share' | 'grouped-bar' | 'scatter';

export interface IVoltCartesianSpec extends IVoltChartCommonSpec {
	readonly type: VoltCartesianType;
	readonly x?: IVoltChartXSpec;
	readonly y?: IVoltChartYSpec;
	readonly categories?: readonly string[];
	readonly series?: readonly IVoltChartSeriesSpec[];
	/** Several metrics over the same x: a switcher above the chart animates between them. */
	readonly metrics?: readonly IVoltChartMetricSpec[];
	readonly headline?: boolean | IVoltChartHeadlineSpec;
	/** A 1D / 7D / 30D / 3M / 1Y / All picker for time charts (true picks what the data spans). */
	readonly ranges?: boolean | readonly string[];
	readonly range?: string;
	readonly annotations?: readonly IVoltChartAnnotationSpec[];
	readonly rules?: readonly IVoltChartRuleSpec[];
	readonly callouts?: readonly IVoltChartCalloutSpec[];
	/** Series names and last values at the right edge (wide charts). */
	readonly endLabels?: boolean;
	/** Mark the peak, the low or the latest value. */
	readonly highlight?: 'max' | 'min' | 'last' | 'none';
	readonly curve?: 'smooth' | 'linear' | 'step';
	readonly legend?: boolean;
	/** Dots on every point (default: only for sparse lines). */
	readonly points?: boolean;
}

export interface IVoltHeatmapSpec extends IVoltChartCommonSpec {
	readonly type: 'heatmap';
	readonly rows: readonly string[];
	readonly columns: readonly string[];
	/** `values[row][column]`. */
	readonly values: readonly (readonly (number | null)[])[];
	/** Words at the ends of the color key, default `fewer` / `more`. */
	readonly scale?: readonly [string, string];
}

export interface IVoltTreemapNode {
	readonly name: string;
	/** Area. Groups sum their children when left out. */
	readonly value?: number;
	/** Drives the color ramp (edits, errors, latency...). */
	readonly color?: number;
	readonly href?: string;
	readonly detail?: Readonly<Record<string, string | number>>;
	readonly children?: readonly IVoltTreemapNode[];
}

export interface IVoltTreemapSpec extends IVoltChartCommonSpec {
	readonly type: 'treemap';
	readonly data: IVoltTreemapNode | readonly IVoltTreemapNode[];
	/** What `value` counts, e.g. "lines". */
	readonly sizeLabel?: string;
	/** What `color` counts, e.g. "edits in 60 days". */
	readonly colorLabel?: string;
	readonly colorUnit?: VoltChartUnit;
}

export interface IVoltPartSpec {
	readonly label: string;
	readonly value: number;
	readonly color?: string | number;
	readonly href?: string;
	readonly detail?: string;
}

export interface IVoltDonutSpec extends IVoltChartCommonSpec {
	readonly type: 'donut';
	readonly data: readonly IVoltPartSpec[];
	readonly centerLabel?: string;
}

export interface IVoltRankedSpec extends IVoltChartCommonSpec {
	readonly type: 'ranked';
	readonly data: readonly IVoltPartSpec[];
	/** Rows shown before "Show all". Default 10. */
	readonly limit?: number;
	/** Labels are paths or code: monospace, directory dimmed. */
	readonly mono?: boolean;
}

export interface IVoltCumulativeSpec extends IVoltChartCommonSpec {
	readonly type: 'cumulative';
	/** One value per entity (install, user, file); order does not matter. */
	readonly values: readonly number[];
	/** Plural noun for the entities, e.g. "installs". */
	readonly entity?: string;
	/** Plural noun for the values, e.g. "turns". */
	readonly measure?: string;
	/** Shares to call out, default [0.01, 0.1, 0.25]. */
	readonly marks?: readonly number[];
}

export interface IVoltStatSpec {
	readonly label: string;
	readonly value: number | string;
	readonly unit?: VoltChartUnit;
	/** Change in percent (or percentage points for percent units). */
	readonly delta?: number;
	readonly deltaLabel?: string;
	readonly good?: 'up' | 'down';
	/** A sparkline under the number. */
	readonly trend?: readonly number[];
}

export interface IVoltStatsSpec {
	readonly type: 'stats';
	readonly title?: string;
	readonly items: readonly IVoltStatSpec[];
}

export interface IVoltRowSpec {
	readonly type: 'row';
	readonly title?: string;
	readonly charts: readonly VoltChartSpec[];
}

export interface IVoltMeterSpec {
	readonly label: string;
	readonly value: number;
	/** Full scale. Default 100 for percents, 1 for ratios, else the largest value. */
	readonly max?: number;
	readonly color?: string | number;
	readonly detail?: string;
	readonly href?: string;
}

export interface IVoltGaugeSpec extends IVoltChartCommonSpec {
	readonly type: 'gauge';
	readonly value?: number;
	readonly max?: number;
	readonly label?: string;
	/** Several readings: a switcher picks the one the gauge shows. */
	readonly data?: readonly IVoltMeterSpec[];
	readonly notches?: number;
}

export interface IVoltRingSpec extends IVoltChartCommonSpec {
	/** Concentric progress rings ("ring" alone means a donut). */
	readonly type: 'rings';
	/** One concentric ring per item, outermost first. */
	readonly data: readonly IVoltMeterSpec[];
}

export interface IVoltRadarSpec extends IVoltChartCommonSpec {
	readonly type: 'radar';
	/** 3-12 measures; each is scaled to its largest value unless it (or the chart) sets `max`. */
	readonly axes: readonly (string | { readonly label: string; readonly unit?: VoltChartUnit; readonly max?: number })[];
	readonly series: readonly { readonly name: string; readonly data: readonly number[]; readonly color?: string | number }[];
	readonly max?: number;
}

export interface IVoltFunnelSpec extends IVoltChartCommonSpec {
	readonly type: 'funnel';
	/** Stages in order, widest first. */
	readonly data: readonly IVoltPartSpec[];
	/** `log` when stages span orders of magnitude (picked automatically past 40x). */
	readonly scale?: 'linear' | 'log';
	readonly color?: string;
}

export interface IVoltSunburstSpec extends IVoltChartCommonSpec {
	readonly type: 'sunburst';
	readonly data: IVoltTreemapNode | readonly IVoltTreemapNode[];
	readonly sizeLabel?: string;
	/** Rings shown at once. Default 4. */
	readonly depth?: number;
}

export interface IVoltSankeySpec extends IVoltChartCommonSpec {
	readonly type: 'sankey';
	readonly links: readonly { readonly source: string; readonly target: string; readonly value: number }[];
	readonly nodes?: readonly { readonly name: string; readonly color?: string | number; readonly href?: string }[];
	/** Which stage carries color (others are gray). Default the middle one. */
	readonly colorColumn?: number;
}

export interface IVoltCandleSpec {
	readonly x: VoltChartX;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly label?: string;
	readonly detail?: Readonly<Record<string, string | number>>;
}

export interface IVoltCandlestickSpec extends IVoltChartCommonSpec {
	readonly type: 'candlestick';
	readonly data: readonly (IVoltCandleSpec | readonly [VoltChartX, number, number, number, number])[];
	readonly x?: IVoltChartXSpec;
}

export type VoltChartSpec = IVoltCartesianSpec | IVoltHeatmapSpec | IVoltTreemapSpec | IVoltDonutSpec | IVoltRankedSpec | IVoltCumulativeSpec | IVoltStatsSpec | IVoltRowSpec
	| IVoltGaugeSpec | IVoltRingSpec | IVoltRadarSpec | IVoltFunnelSpec | IVoltSunburstSpec | IVoltSankeySpec | IVoltCandlestickSpec;

/** A whole visual: a title and charts stacked top to bottom. A single chart spec is accepted too. */
export interface IVoltVisualSpec {
	readonly title?: string;
	readonly subtitle?: string;
	readonly charts: readonly VoltChartSpec[];
}

//#endregion

//#region API

export interface IVoltChartsStrings {
	readonly emptyTitle: string;
	readonly emptyMessage: string;
	readonly loading: string;
	readonly all: string;
	readonly fewer: string;
	readonly more: string;
	readonly showAll: string;
	readonly showLess: string;
	readonly zoomHint: string;
	readonly open: string;
	readonly total: string;
	readonly other: string;
	readonly vsPrevious: string;
	readonly chart: string;
	readonly zoomIn: string;
	/** `{0}` is the whole, e.g. "of apps" or "of Julius's flow". */
	readonly ofParent: string;
	readonly ofPrevious: string;
	readonly ofFirst: string;
	readonly logScale: string;
	readonly candleOpen: string;
	readonly candleHigh: string;
	readonly candleLow: string;
	readonly candleClose: string;
	readonly rising: string;
	readonly falling: string;
}

export interface IVoltChartsRenderOptions {
	readonly strings?: Partial<IVoltChartsStrings>;
	/** A point, tile or row with an `href` was activated (click, Enter). */
	readonly onOpen?: (href: string) => void;
	/** Plays the entry animation (default true). Off for re-mounts and screenshots. */
	readonly animate?: boolean;
	/** BCP 47 locale for numbers and dates; default the page's. */
	readonly locale?: string;
}

export interface IVoltChartsHandle {
	readonly element: HTMLElement;
	update(visual: unknown, animate?: boolean): void;
	/** Shows the skeleton until the next `update`. */
	setLoading(loading: boolean): void;
	/** Re-measures (the container changed size without a resize the observer saw). */
	layout(): void;
	dispose(): void;
}

export interface IVoltChartsApi {
	readonly version: number;
	render(container: HTMLElement, visual: unknown, options?: IVoltChartsRenderOptions): IVoltChartsHandle;
	/** Problems an agent should fix, empty when the visual renders as intended. */
	validate(visual: unknown): string[];
	/** The visual's data as CSV, one table per chart. */
	toCsv(visual: unknown): string;
	/** One line per chart: what it shows and its headline numbers. */
	describe(visual: unknown): string;
	/** Renders every `<script type="application/volt-chart+json">` and `[data-volt-chart]` under `root`. */
	mountAll(root?: ParentNode, options?: IVoltChartsRenderOptions): IVoltChartsHandle[];
}

//#endregion

export function voltChartsRuntime(win: Window & typeof globalThis): IVoltChartsRuntime {

	//#region Basics

	const doc = win.document;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const VERSION = 1;
	const DRAW_MS = 460;
	const TWEEN_MS = 420;
	const FADE_MS = 200;
	const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
	const MAX_POINTS = 50_000;

	const DEFAULT_STRINGS: IVoltChartsStrings = {
		emptyTitle: 'No data yet',
		emptyMessage: 'Values will appear here once there is something to show.',
		loading: 'Loading',
		all: 'All',
		fewer: 'fewer',
		more: 'more',
		showAll: 'Show all',
		showLess: 'Show less',
		zoomHint: 'Click to zoom in. Right click or Esc to zoom out.',
		open: 'Click to open',
		total: 'Total',
		other: 'Other',
		vsPrevious: 'vs previous',
		chart: 'Chart',
		zoomIn: 'Click to zoom in',
		ofParent: 'of {0}',
		ofPrevious: 'of the previous stage',
		ofFirst: 'Share of the first stage',
		logScale: 'Widths are log-scaled; the numbers are exact.',
		candleOpen: 'Open',
		candleHigh: 'High',
		candleLow: 'Low',
		candleClose: 'Close',
		rising: 'Up',
		falling: 'Down',
	};

	let uid = 0;
	const nextId = (prefix: string) => `vc-${prefix}-${(++uid).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

	type Attrs = Record<string, string | number | undefined>;

	function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, parent?: Element, text?: string): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		parent?.appendChild(node);
		return node;
	}

	function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, parent?: Element): SVGElementTagNameMap[K] {
		const node = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
		if (attrs) {
			setAttrs(node, attrs);
		}
		parent?.appendChild(node);
		return node;
	}

	function setAttrs(node: Element, attrs: Attrs): void {
		for (const key in attrs) {
			const value = attrs[key];
			if (value === undefined) {
				node.removeAttribute(key);
			} else {
				node.setAttribute(key, typeof value === 'number' ? num(value) : value);
			}
		}
	}

	/** Coordinates to two decimals: short path strings, no visible loss. */
	function num(value: number): string {
		return String(Math.round(value * 100) / 100);
	}

	const clamp = (value: number, lo: number, hi: number) => value < lo ? lo : value > hi ? hi : value;
	const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

	function dpr(): number {
		return Math.max(1, Math.min(3, win.devicePixelRatio || 1));
	}

	/** A hairline's center on the device pixel grid, so 1px lines never blur across two pixels. */
	function crisp(value: number): number {
		const ratio = dpr();
		return (Math.round(value * ratio - 0.5) + 0.5) / ratio;
	}

	function reducedMotion(): boolean {
		return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function str(value: unknown, max = 200): string | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(value);
		}
		if (typeof value !== 'string') {
			return undefined;
		}
		const clean = value.replace(/\s+/g, ' ').trim();
		return clean ? clean.slice(0, max) : undefined;
	}

	/** Text width in px for a CSS font, measured on one shared canvas. */
	let measureContext: CanvasRenderingContext2D | null | undefined;
	function textWidth(text: string, font: string): number {
		if (measureContext === undefined) {
			measureContext = doc.createElement('canvas').getContext('2d');
		}
		if (!measureContext) {
			return text.length * 6.5;
		}
		measureContext.font = font;
		return measureContext.measureText(text).width;
	}

	/** The resolved monospace family (`--vc-mono` can hold var() chains a canvas cannot read). */
	/** Axis numbers and times are set in the mono face, small and quiet, like a terminal readout. */
	function axisFont(host: Element): string {
		return `400 10.5px ${monoFamily(host)}`;
	}

	function monoFamily(host: Element): string {
		const probe = doc.createElement('span');
		probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--vc-mono)';
		host.appendChild(probe);
		const family = win.getComputedStyle(probe).fontFamily || 'monospace';
		probe.remove();
		return family;
	}

	function ellipsize(text: string, font: string, max: number): string {
		if (max <= 0) {
			return '';
		}
		if (textWidth(text, font) <= max) {
			return text;
		}
		let lo = 0;
		let hi = text.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (textWidth(`${text.slice(0, mid)}…`, font) <= max) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
	}

	/** A path that fits `max` px: leading folders give way first (`…/components/ChatView.tsx`), the file name last. */
	function fitPath(path: string, font: string, max: number): string {
		if (!max || textWidth(path, font) <= max) {
			return path;
		}
		const parts = path.split(/(?<=[\\/])/);
		for (let drop = 1; drop < parts.length; drop++) {
			const candidate = `…/${parts.slice(drop).join('')}`;
			if (textWidth(candidate, font) <= max) {
				return candidate;
			}
		}
		return ellipsize(parts[parts.length - 1], font, max);
	}

	/** The median distance between neighbouring sorted values, 0 with fewer than two. */
	function medianGap(sorted: readonly number[]): number {
		const gaps: number[] = [];
		for (let index = 1; index < sorted.length && gaps.length < 2000; index++) {
			const gap = sorted[index] - sorted[index - 1];
			if (gap > 0) {
				gaps.push(gap);
			}
		}
		gaps.sort((a, b) => a - b);
		return gaps[gaps.length >> 1] ?? 0;
	}

	/** Index of the value in a sorted array closest to `target`. */
	function nearestIndex(sorted: readonly number[], target: number): number {
		const n = sorted.length;
		if (n === 0) {
			return -1;
		}
		let lo = 0;
		let hi = n - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid] < target) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		if (lo > 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(sorted[lo] - target)) {
			return lo - 1;
		}
		return lo;
	}

	//#endregion

	//#region Units and number formatting

	type UnitKind = 'number' | 'count' | 'percent' | 'ratio' | 'usd' | 'tokens' | 'ms' | 's' | 'bytes' | 'custom';

	interface IUnit {
		readonly kind: UnitKind;
		readonly prefix: string;
		readonly suffix: string;
		readonly decimals?: number;
	}

	const UNIT_KINDS: readonly UnitKind[] = ['number', 'count', 'percent', 'ratio', 'usd', 'tokens', 'ms', 's', 'bytes'];
	const SAFE_AFFIX = /^[^<>{};]{0,12}$/;

	/** The unit an agent named, or one guessed from the words around the numbers. */
	function resolveUnit(value: unknown, hint?: string, values?: readonly number[]): IUnit {
		if (typeof value === 'string') {
			const key = value.toLowerCase().trim();
			const alias: Record<string, UnitKind> = { '$': 'usd', dollars: 'usd', cost: 'usd', currency: 'usd', '%': 'percent', pct: 'percent', seconds: 's', sec: 's', milliseconds: 'ms', duration: 'ms', integer: 'count', int: 'count', bytes: 'bytes', size: 'bytes' };
			const kind = (UNIT_KINDS as readonly string[]).includes(key) ? key as UnitKind : alias[key];
			if (kind) {
				return { kind, prefix: '', suffix: '' };
			}
			// "$k", "EUR M", "$bn": a currency in thousands or millions reads "$148k", not "148 $k".
			// allow-any-unicode-next-line
			const scaled = /^\s*([$€£¥₹])\s*(k|m|mm|b|bn|t)\s*$/i.exec(value);
			if (scaled) {
				return { kind: 'custom', prefix: scaled[1], suffix: scaled[2].length > 1 ? scaled[2] : scaled[2].toUpperCase() === 'K' ? 'k' : scaled[2].toUpperCase() };
			}
			if (SAFE_AFFIX.test(value)) {
				return { kind: 'custom', prefix: '', suffix: value.startsWith(' ') || value.length > 1 ? ` ${value.trim()}` : value };
			}
		}
		if (isRecord(value)) {
			const prefix = typeof value.prefix === 'string' && SAFE_AFFIX.test(value.prefix) ? value.prefix : '';
			const suffix = typeof value.suffix === 'string' && SAFE_AFFIX.test(value.suffix) ? value.suffix : '';
			const decimals = isNum(value.decimals) ? clamp(Math.round(value.decimals), 0, 6) : undefined;
			return { kind: 'custom', prefix, suffix, decimals };
		}
		const words = (hint ?? '').toLowerCase();
		let max = 0;
		for (const v of values ?? []) {
			max = Math.max(max, Math.abs(v));
		}
		if (/\bcost|spend|price|\$|usd|dollar|bill/.test(words)) {
			return { kind: 'usd', prefix: '', suffix: '' };
		}
		if (/token/.test(words)) {
			return { kind: 'tokens', prefix: '', suffix: '' };
		}
		if (/latency|duration|ttft|time to first|response time|\bms\b/.test(words)) {
			return { kind: 'ms', prefix: '', suffix: '' };
		}
		if (/percent|share|%|utili[sz]|\brate\b|ratio|coverage/.test(words)) {
			return { kind: max <= 1 && max > 0 ? 'ratio' : 'percent', prefix: '', suffix: '' };
		}
		if (/\bbytes?\b|\b(kb|mb|gb|tb)\b|memory|disk usage|bundle size|file size/.test(words)) {
			return { kind: 'bytes', prefix: '', suffix: '' };
		}
		return { kind: 'number', prefix: '', suffix: '' };
	}

	const PERCENT_UNIT: IUnit = { kind: 'percent', prefix: '', suffix: '' };

	let locale: string | undefined;
	const numberFormats = new Map<string, Intl.NumberFormat>();
	function numberFormat(min: number, max: number): Intl.NumberFormat {
		const key = `${min}:${max}`;
		let format = numberFormats.get(key);
		if (!format) {
			try {
				// eslint-disable-next-line no-restricted-syntax -- runs inside agent pages too, so no imports; formats are cached per runtime
				format = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
			} catch {
				// eslint-disable-next-line no-restricted-syntax -- runs inside agent pages too, so no imports; formats are cached per runtime
				format = new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max });
			}
			numberFormats.set(key, format);
		}
		return format;
	}

	/** Decimals for a number at `step` resolution (axis ticks): 2.5 → 1, 0.25 → 2, 50 → 0. */
	function stepDecimals(step: number): number {
		if (!isNum(step) || step <= 0) {
			return 0;
		}
		let decimals = 0;
		while (decimals < 6 && Math.abs(Math.round(step * Math.pow(10, decimals)) - step * Math.pow(10, decimals)) > 1e-6) {
			decimals++;
		}
		return decimals;
	}

	const SCALES: readonly [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

	/** Three significant digits with a scale letter: 850K, 1.36M, 24M. Below 1,000 the number itself. */
	function compact(value: number): string {
		const abs = Math.abs(value);
		for (const [size, letter] of SCALES) {
			if (abs >= size * 0.9995) {
				const scaled = value / size;
				const a = Math.abs(scaled);
				const digits = a >= 99.95 ? 0 : a >= 9.995 ? 1 : 2;
				return `${numberFormat(0, digits).format(Number(scaled.toFixed(digits)))}${letter}`;
			}
		}
		return small(value);
	}

	/** Numbers under 1,000: up to two decimals, three significant digits under 1. */
	function small(value: number): string {
		const abs = Math.abs(value);
		if (abs === 0) {
			return '0';
		}
		if (abs < 1) {
			const digits = clamp(2 - Math.floor(Math.log10(abs)), 2, 6);
			return numberFormat(0, digits).format(Number(value.toPrecision(3)));
		}
		return numberFormat(0, abs >= 100 ? 1 : 2).format(value);
	}

	/** An axis label: every tick shares the decimals of the step, so labels line up. */
	function formatTick(value: number, step: number, unit: IUnit): string {
		const clean = Math.abs(value) < step * 1e-9 ? 0 : value;
		switch (unit.kind) {
			case 'percent':
				return `${numberFormat(0, stepDecimals(step)).format(clean)}%`;
			case 'ratio':
				return `${numberFormat(0, stepDecimals(step * 100)).format(clean * 100)}%`;
			case 'ms':
				return formatDuration(clean, true);
			case 's':
				return formatDuration(clean * 1000, true);
			case 'bytes':
				return formatBytes(clean, true);
			case 'usd':
				return `${clean < 0 ? '-' : ''}$${tickNumber(Math.abs(clean), step)}`;
			case 'custom':
				// "200 commits" on every tick is noise; a word unit belongs in the title and the tooltip.
				return `${unit.prefix}${unit.decimals !== undefined ? numberFormat(unit.decimals, unit.decimals).format(clean) : tickNumber(clean, step)}${/[a-z]{2,}/i.test(unit.suffix) ? '' : unit.suffix}`;
			default:
				return tickNumber(clean, step);
		}
	}

	function tickNumber(value: number, step: number): string {
		if (value === 0) {
			return '0';
		}
		const abs = Math.max(Math.abs(value), step);
		for (const [size, letter] of SCALES) {
			if (abs >= size) {
				return `${numberFormat(0, stepDecimals(step / size)).format(value / size)}${letter}`;
			}
		}
		return numberFormat(0, stepDecimals(step)).format(value);
	}

	/** A value read on its own (tooltips, headlines): `$18.42`, `2.1M tokens`, `42 ms`, `51.2%`. */
	function formatValue(value: number | null | undefined, unit: IUnit, long = false): string {
		if (!isNum(value)) {
			// allow-any-unicode-next-line
			return '—';
		}
		switch (unit.kind) {
			case 'usd': {
				const abs = Math.abs(value);
				const sign = value < 0 ? '-' : '';
				if (abs === 0) {
					return '$0.00';
				}
				if (abs < 0.0001) {
					return `${sign}<$0.0001`;
				}
				if (abs < 1) {
					return `${sign}$${numberFormat(2, clamp(2 - Math.floor(Math.log10(abs)), 2, 4)).format(Number(abs.toPrecision(2)))}`;
				}
				if (abs < 10_000) {
					return `${sign}$${numberFormat(2, 2).format(abs)}`;
				}
				return `${sign}$${compact(abs)}`;
			}
			case 'percent':
				return formatPercent(value);
			case 'ratio':
				return formatPercent(value * 100);
			case 'tokens':
				return long ? `${compact(value)} tokens` : compact(value);
			case 'count':
				return Math.abs(value) < 10_000 ? numberFormat(0, Number.isInteger(value) ? 0 : 1).format(value) : compact(value);
			case 'ms':
				return formatDuration(value, false);
			case 's':
				return formatDuration(value * 1000, false);
			case 'bytes':
				return formatBytes(value, false);
			case 'custom':
				return `${unit.prefix}${unit.decimals !== undefined ? numberFormat(unit.decimals, unit.decimals).format(value) : (Math.abs(value) < 10_000 ? small(value) : compact(value))}${unit.suffix}`;
			default:
				return Math.abs(value) < 10_000 ? small(value) : compact(value);
		}
	}

	function formatPercent(value: number): string {
		const abs = Math.abs(value);
		if (abs > 0 && abs < 0.1) {
			return value < 0 ? '>-0.1%' : '<0.1%';
		}
		return `${numberFormat(0, abs < 10 ? 1 : 0).format(value)}%`;
	}

	function formatDuration(ms: number, tick: boolean): string {
		const abs = Math.abs(ms);
		const sign = ms < 0 ? '-' : '';
		if (abs === 0) {
			return tick ? '0' : '0 ms';
		}
		if (abs < 1) {
			return `${sign}${numberFormat(0, 2).format(abs)} ms`;
		}
		if (abs < 1000) {
			return `${sign}${numberFormat(0, 0).format(abs)} ms`;
		}
		if (abs < 60_000) {
			return `${sign}${numberFormat(0, abs < 10_000 ? 1 : 0).format(abs / 1000)}s`;
		}
		if (abs < 3_600_000) {
			const minutes = Math.floor(abs / 60_000);
			const seconds = Math.round((abs % 60_000) / 1000);
			return tick || seconds === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${String(seconds).padStart(2, '0')}s`;
		}
		const hours = Math.floor(abs / 3_600_000);
		const minutes = Math.round((abs % 3_600_000) / 60_000);
		return tick || minutes === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${minutes}m`;
	}

	function formatBytes(bytes: number, tick: boolean): string {
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let value = Math.abs(bytes);
		let index = 0;
		while (value >= 1024 && index < units.length - 1) {
			value /= 1024;
			index++;
		}
		const digits = index === 0 || value >= 100 || (tick && Number.isInteger(value)) ? 0 : 1;
		return `${bytes < 0 ? '-' : ''}${numberFormat(0, digits).format(value)} ${units[index]}`;
	}

	/** `↑ 12.4%`, or percentage points for percent units, where a relative change misleads. */
	function formatDelta(current: number, previous: number, unit: IUnit): { text: string; direction: -1 | 0 | 1 } | undefined {
		if (!isNum(current) || !isNum(previous)) {
			return undefined;
		}
		if (unit.kind === 'percent' || unit.kind === 'ratio') {
			const points = (current - previous) * (unit.kind === 'ratio' ? 100 : 1);
			const direction = Math.abs(points) < 0.05 ? 0 : points > 0 ? 1 : -1;
			return { text: `${direction > 0 ? '↑' : direction < 0 ? '↓' : '→'} ${numberFormat(0, 1).format(Math.abs(points))} pts`, direction };
		}
		if (previous === 0) {
			return current === 0 ? { text: '→ 0%', direction: 0 } : undefined;
		}
		const change = ((current - previous) / Math.abs(previous)) * 100;
		const direction = Math.abs(change) < 0.05 ? 0 : change > 0 ? 1 : -1;
		const abs = Math.abs(change);
		return { text: `${direction > 0 ? '↑' : direction < 0 ? '↓' : '→'} ${numberFormat(0, abs >= 100 ? 0 : 1).format(abs)}%`, direction };
	}

	//#endregion

	//#region Time

	type Grain = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	interface ITimeZone {
		readonly utc: boolean;
		/** For Intl formatting; undefined is the reader's zone. */
		readonly name: string | undefined;
	}

	function timeZoneOf(value: unknown): ITimeZone {
		if (typeof value === 'string' && value.trim()) {
			const name = value.trim();
			if (/^(utc|gmt|z)$/i.test(name)) {
				return { utc: true, name: 'UTC' };
			}
			try {
				// eslint-disable-next-line no-restricted-syntax -- runs inside agent pages too, so no imports; formats are cached per runtime
				new Intl.DateTimeFormat(undefined, { timeZone: name });
				return { utc: false, name };
			} catch {
				// unknown zone: the reader's own
			}
		}
		return { utc: false, name: undefined };
	}

	/** Epoch ms from a number (ms or seconds) or a date string. Date-only strings are midnights in the chart's zone. */
	function parseTime(value: unknown, zone: ITimeZone): number | undefined {
		if (isNum(value)) {
			return Math.abs(value) >= 1e11 ? value : value * 1000;
		}
		if (typeof value !== 'string') {
			return undefined;
		}
		const text = value.trim();
		const dateOnly = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
		if (dateOnly) {
			const year = Number(dateOnly[1]);
			const month = Number(dateOnly[2]) - 1;
			const day = dateOnly[3] ? Number(dateOnly[3]) : 1;
			return zone.utc ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
		}
		if (/^\d{4}$/.test(text)) {
			return zone.utc ? Date.UTC(Number(text), 0, 1) : new Date(Number(text), 0, 1).getTime();
		}
		if (!/^\d{4}-\d{2}-\d{2}[T ]\d/.test(text) && !/^[A-Za-z]{3,9},? /.test(text)) {
			return undefined;
		}
		const parsed = Date.parse(zone.utc && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	function looksLikeTime(value: unknown): boolean {
		return typeof value === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}.*)?$/.test(value.trim());
	}

	function parts(t: number, zone: ITimeZone): { y: number; m: number; d: number; hh: number; mm: number; wd: number } {
		const date = new Date(t);
		return zone.utc
			? { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), hh: date.getUTCHours(), mm: date.getUTCMinutes(), wd: date.getUTCDay() }
			: { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), hh: date.getHours(), mm: date.getMinutes(), wd: date.getDay() };
	}

	function makeTime(zone: ITimeZone, y: number, m: number, d = 1, hh = 0, mm = 0): number {
		return zone.utc ? Date.UTC(y, m, d, hh, mm) : new Date(y, m, d, hh, mm).getTime();
	}

	function addStep(t: number, step: VoltChartStep, count: number, zone: ITimeZone): number {
		if (isNum(step)) {
			return t + step * count;
		}
		const p = parts(t, zone);
		switch (step) {
			case 'minute': return t + count * MINUTE;
			case 'hour': return t + count * HOUR;
			case 'day': return makeTime(zone, p.y, p.m, p.d + count, p.hh, p.mm);
			case 'week': return makeTime(zone, p.y, p.m, p.d + count * 7, p.hh, p.mm);
			case 'month': return makeTime(zone, p.y, p.m + count, p.d, p.hh, p.mm);
			case 'year': return makeTime(zone, p.y + count, p.m, p.d, p.hh, p.mm);
		}
	}

	/** The spacing of the data: the median gap, read as minutes, hours, days, weeks, months or years. */
	function grainOf(xs: readonly number[]): Grain {
		if (xs.length < 2) {
			return 'day';
		}
		const gaps: number[] = [];
		for (let index = 1; index < xs.length && gaps.length < 2000; index++) {
			const gap = xs[index] - xs[index - 1];
			if (gap > 0) {
				gaps.push(gap);
			}
		}
		gaps.sort((a, b) => a - b);
		const median = gaps[gaps.length >> 1] ?? DAY;
		if (median < 50 * MINUTE) {
			return 'minute';
		}
		if (median < 20 * HOUR) {
			return 'hour';
		}
		if (median < 5 * DAY) {
			return 'day';
		}
		if (median < 25 * DAY) {
			return 'week';
		}
		if (median < 300 * DAY) {
			return 'month';
		}
		return 'year';
	}

	const dateFormats = new Map<string, Intl.DateTimeFormat>();
	function dateFormat(options: Intl.DateTimeFormatOptions, zone: ITimeZone): Intl.DateTimeFormat {
		const key = `${zone.name ?? ''}|${JSON.stringify(options)}`;
		let format = dateFormats.get(key);
		if (!format) {
			try {
				// eslint-disable-next-line no-restricted-syntax -- runs inside agent pages too, so no imports; formats are cached per runtime
				format = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone.name });
			} catch {
				// eslint-disable-next-line no-restricted-syntax -- runs inside agent pages too, so no imports; formats are cached per runtime
				format = new Intl.DateTimeFormat(undefined, options);
			}
			dateFormats.set(key, format);
		}
		return format;
	}

	function formatTimePoint(t: number, grain: Grain, zone: ITimeZone): string {
		const sameYear = parts(t, zone).y === parts(Date.now(), zone).y;
		switch (grain) {
			case 'minute':
			case 'hour':
				return dateFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t);
			case 'day':
				return dateFormat({ weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t);
			case 'week':
				return `Week of ${dateFormat({ month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t)}`;
			case 'month':
				return dateFormat({ month: 'long', year: 'numeric' }, zone).format(t);
			case 'year':
				return dateFormat({ year: 'numeric' }, zone).format(t);
		}
	}

	interface ITimeInterval {
		readonly unit: 'minute' | 'hour' | 'day' | 'month' | 'year';
		readonly count: number;
		readonly ms: number;
	}

	const TIME_INTERVALS: readonly ITimeInterval[] = [
		{ unit: 'minute', count: 1, ms: MINUTE },
		{ unit: 'minute', count: 5, ms: 5 * MINUTE },
		{ unit: 'minute', count: 15, ms: 15 * MINUTE },
		{ unit: 'minute', count: 30, ms: 30 * MINUTE },
		{ unit: 'hour', count: 1, ms: HOUR },
		{ unit: 'hour', count: 3, ms: 3 * HOUR },
		{ unit: 'hour', count: 6, ms: 6 * HOUR },
		{ unit: 'hour', count: 12, ms: 12 * HOUR },
		{ unit: 'day', count: 1, ms: DAY },
		{ unit: 'day', count: 2, ms: 2 * DAY },
		{ unit: 'day', count: 7, ms: 7 * DAY },
		{ unit: 'day', count: 14, ms: 14 * DAY },
		{ unit: 'month', count: 1, ms: 30 * DAY },
		{ unit: 'month', count: 3, ms: 91 * DAY },
		{ unit: 'month', count: 6, ms: 182 * DAY },
		{ unit: 'year', count: 1, ms: 365 * DAY },
		{ unit: 'year', count: 2, ms: 730 * DAY },
		{ unit: 'year', count: 5, ms: 1826 * DAY },
		{ unit: 'year', count: 10, ms: 3652 * DAY },
	];

	interface ITick {
		readonly value: number;
		readonly label: string;
	}

	/**
	 * Calendar-aligned ticks between `lo` and `hi`, at most `maxCount`: midnights, month starts,
	 * and day steps counted from the first day shown (Jul 6, Jul 20, Aug 3...).
	 */
	function timeTicks(lo: number, hi: number, maxCount: number, zone: ITimeZone): ITick[] {
		const span = Math.max(1, hi - lo);
		const interval = TIME_INTERVALS.find(candidate => span / candidate.ms <= maxCount) ?? TIME_INTERVALS[TIME_INTERVALS.length - 1];
		const values: number[] = [];
		const p = parts(lo, zone);
		let t: number;
		switch (interval.unit) {
			case 'minute':
			case 'hour': {
				const size = interval.unit === 'minute' ? interval.count : interval.count * 60;
				const minutes = p.hh * 60 + p.mm;
				const first = Math.ceil(minutes / size) * size;
				t = makeTime(zone, p.y, p.m, p.d, 0, first);
				for (; t <= hi && values.length < 500; t += size * MINUTE) {
					values.push(t);
				}
				break;
			}
			case 'day': {
				t = makeTime(zone, p.y, p.m, p.d);
				if (t < lo) {
					t = makeTime(zone, p.y, p.m, p.d + 1);
				}
				while (t <= hi && values.length < 500) {
					values.push(t);
					const q = parts(t, zone);
					t = makeTime(zone, q.y, q.m, q.d + interval.count);
				}
				break;
			}
			case 'month': {
				let month = Math.ceil((p.m + (p.d > 1 || p.hh > 0 ? 1 : 0)) / interval.count) * interval.count;
				for (t = makeTime(zone, p.y, month); t <= hi && values.length < 500; month += interval.count, t = makeTime(zone, p.y, month)) {
					if (t >= lo) {
						values.push(t);
					}
				}
				break;
			}
			case 'year': {
				let year = Math.ceil((p.y + (p.m > 0 || p.d > 1 ? 1 : 0)) / interval.count) * interval.count;
				for (t = makeTime(zone, year, 0); t <= hi && values.length < 500; year += interval.count, t = makeTime(zone, year, 0)) {
					values.push(t);
				}
				break;
			}
		}
		const spansYears = parts(lo, zone).y !== parts(hi, zone).y;
		return values.map((value, index) => {
			const q = parts(value, zone);
			let label: string;
			if (interval.unit === 'minute' || interval.unit === 'hour') {
				label = q.hh === 0 && q.mm === 0
					? dateFormat({ month: 'short', day: 'numeric' }, zone).format(value)
					: dateFormat({ hour: 'numeric', ...(q.mm ? { minute: '2-digit' } : {}) }, zone).format(value);
			} else if (interval.unit === 'day') {
				label = dateFormat({ month: 'short', day: 'numeric' }, zone).format(value);
			} else if (interval.unit === 'month') {
				label = q.m === 0 || (index === 0 && spansYears)
					? dateFormat({ month: 'short', year: 'numeric' }, zone).format(value)
					: dateFormat({ month: 'short' }, zone).format(value);
			} else {
				label = String(q.y);
			}
			return { value, label };
		});
	}

	const RANGE_LENGTHS: Readonly<Record<string, number>> = { '1H': HOUR, '6H': 6 * HOUR, '1D': DAY, '24H': DAY, '7D': 7 * DAY, '1W': 7 * DAY, '14D': 14 * DAY, '30D': 30 * DAY, '1M': 30 * DAY, '90D': 90 * DAY, '3M': 90 * DAY, '6M': 182 * DAY, '1Y': 365 * DAY };

	function rangeNoun(key: string): string {
		switch (key) {
			case '1H': return 'hour';
			case '6H': return '6 hours';
			case '1D': case '24H': return 'day';
			case '7D': case '1W': return '7 days';
			case '14D': return '14 days';
			case '30D': case '1M': return '30 days';
			case '90D': case '3M': return '3 months';
			case '6M': return '6 months';
			case '1Y': return 'year';
		}
		return 'period';
	}

	//#endregion

	//#region Scales and ticks

	interface INiceScale {
		readonly lo: number;
		readonly hi: number;
		readonly step: number;
		readonly values: readonly number[];
	}

	/** 1, 2, 2.5 or 5 times a power of ten, so tick labels stay round. Counts never get 2.5. */
	function niceStep(raw: number, integer: boolean): number {
		if (!(raw > 0) || !Number.isFinite(raw)) {
			return 1;
		}
		const power = Math.pow(10, Math.floor(Math.log10(raw)));
		for (const factor of [1, 2, 2.5, 5, 10]) {
			if (integer && factor === 2.5 && power < 10) {
				continue;
			}
			if (raw <= factor * power * (1 + 1e-9)) {
				return integer ? Math.max(1, factor * power) : factor * power;
			}
		}
		return 10 * power;
	}

	/** Round ticks covering [min, max], about `count` of them; a fixed end stays where the spec put it. */
	function niceScale(min: number, max: number, count: number, integer: boolean, fixedLo?: number, fixedHi?: number): INiceScale {
		let lo = min;
		let hi = max;
		if (!(hi > lo)) {
			if (lo === 0) {
				hi = 1;
			} else {
				const pad = Math.abs(lo) * 0.1 || 1;
				lo -= pad;
				hi += pad;
			}
		}
		const step = niceStep((hi - lo) / Math.max(1, count), integer);
		const decimals = stepDecimals(step);
		const niceLo = fixedLo ?? Math.floor(lo / step + 1e-9) * step;
		const niceHi = fixedHi ?? Math.ceil(hi / step - 1e-9) * step;
		const values: number[] = [];
		const first = Math.ceil(niceLo / step - 1e-9) * step;
		for (let value = first; value <= niceHi + step * 1e-6 && values.length < 50; value += step) {
			values.push(Number(value.toFixed(decimals)));
		}
		return { lo: niceLo, hi: niceHi > niceLo ? niceHi : niceLo + step, step, values };
	}

	//#endregion

	//#region Paths

	type Pt = readonly [number, number];

	/**
	 * Monotone cubic (Fritsch-Carlson) through the points: as smooth as a hand-drawn curve, but it
	 * never overshoots, so a quiet day never dips below zero and a peak is never taller than it was.
	 */
	function monotonePath(points: readonly Pt[], move: boolean): string {
		const n = points.length;
		if (n === 0) {
			return '';
		}
		const start = `${move ? 'M' : 'L'}${num(points[0][0])},${num(points[0][1])}`;
		if (n === 1) {
			return start;
		}
		if (n === 2) {
			return `${start}L${num(points[1][0])},${num(points[1][1])}`;
		}
		const dx: number[] = [];
		const slopes: number[] = [];
		for (let index = 0; index < n - 1; index++) {
			dx.push(points[index + 1][0] - points[index][0]);
			slopes.push((points[index + 1][1] - points[index][1]) / (dx[index] || 1));
		}
		const tangents: number[] = [slopes[0]];
		for (let index = 1; index < n - 1; index++) {
			tangents.push(slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2);
		}
		tangents.push(slopes[n - 2]);
		for (let index = 0; index < n - 1; index++) {
			if (slopes[index] === 0) {
				tangents[index] = 0;
				tangents[index + 1] = 0;
				continue;
			}
			const a = tangents[index] / slopes[index];
			const b = tangents[index + 1] / slopes[index];
			const sum = a * a + b * b;
			if (sum > 9) {
				const t = 3 / Math.sqrt(sum);
				tangents[index] = t * a * slopes[index];
				tangents[index + 1] = t * b * slopes[index];
			}
		}
		let d = start;
		for (let index = 0; index < n - 1; index++) {
			const [x0, y0] = points[index];
			const [x1, y1] = points[index + 1];
			const third = dx[index] / 3;
			d += `C${num(x0 + third)},${num(y0 + tangents[index] * third)} ${num(x1 - third)},${num(y1 - tangents[index + 1] * third)} ${num(x1)},${num(y1)}`;
		}
		return d;
	}

	function linearPath(points: readonly Pt[], move: boolean): string {
		let d = '';
		points.forEach((point, index) => {
			d += `${index === 0 && move ? 'M' : 'L'}${num(point[0])},${num(point[1])}`;
		});
		return d;
	}

	function stepPath(points: readonly Pt[], move: boolean): string {
		let d = '';
		points.forEach((point, index) => {
			if (index === 0) {
				d += `${move ? 'M' : 'L'}${num(point[0])},${num(point[1])}`;
			} else {
				const mid = (points[index - 1][0] + point[0]) / 2;
				d += `H${num(mid)}V${num(point[1])}H${num(point[0])}`;
			}
		});
		return d;
	}

	type Curve = 'smooth' | 'linear' | 'step';

	function curvePath(points: readonly Pt[], curve: Curve, move: boolean): string {
		return curve === 'step' ? stepPath(points, move) : curve === 'linear' ? linearPath(points, move) : monotonePath(points, move);
	}

	/** Runs of finite points; a gap (missing bucket) breaks the line. */
	function runs(points: readonly Pt[]): Pt[][] {
		const out: Pt[][] = [];
		let run: Pt[] = [];
		for (const point of points) {
			if (Number.isFinite(point[1])) {
				run.push(point);
			} else if (run.length) {
				out.push(run);
				run = [];
			}
		}
		if (run.length) {
			out.push(run);
		}
		return out;
	}

	/** Area between `top` and `bottom` (same x), each run closed on its own. */
	function areaPath(top: readonly Pt[], bottom: readonly Pt[], curve: Curve): string {
		let d = '';
		let start = -1;
		const flush = (end: number) => {
			if (start < 0) {
				return;
			}
			const upper = top.slice(start, end);
			const lower = bottom.slice(start, end).reverse();
			if (upper.length > 1) {
				d += `${curvePath(upper, curve, true)}${curvePath(lower, curve, false)}Z`;
			}
			start = -1;
		};
		for (let index = 0; index < top.length; index++) {
			const ok = Number.isFinite(top[index][1]) && Number.isFinite(bottom[index][1]);
			if (ok && start < 0) {
				start = index;
			} else if (!ok) {
				flush(index);
			}
		}
		flush(top.length);
		return d;
	}

	/** A bar with rounded far corners (top for positive values, bottom for negative). */
	function barPath(x: number, y0: number, y1: number, width: number, radius: number): string {
		const top = Math.min(y0, y1);
		const bottom = Math.max(y0, y1);
		const height = bottom - top;
		if (height <= 0.01 || width <= 0) {
			return '';
		}
		const r = Math.min(radius, width / 2, height);
		if (y1 <= y0) {
			return `M${num(x)},${num(bottom)}V${num(top + r)}Q${num(x)},${num(top)} ${num(x + r)},${num(top)}H${num(x + width - r)}Q${num(x + width)},${num(top)} ${num(x + width)},${num(top + r)}V${num(bottom)}Z`;
		}
		return `M${num(x)},${num(top)}V${num(bottom - r)}Q${num(x)},${num(bottom)} ${num(x + r)},${num(bottom)}H${num(x + width - r)}Q${num(x + width)},${num(bottom)} ${num(x + width)},${num(bottom - r)}V${num(top)}Z`;
	}

	/**
	 * Picks which points to draw when there are more than pixels: per pixel column the first,
	 * lowest, highest and last (M4). Every spike and dip survives; gaps stay gaps.
	 */
	function m4(px: readonly number[], ys: readonly number[]): number[] {
		const out: number[] = [];
		let column = Number.NaN;
		let first = -1;
		let low = -1;
		let high = -1;
		let last = -1;
		const flush = () => {
			if (first < 0) {
				return;
			}
			const keep = [first, low, high, last].filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b);
			out.push(...keep);
			first = -1;
		};
		for (let index = 0; index < px.length; index++) {
			if (!Number.isFinite(ys[index])) {
				flush();
				out.push(index);
				column = Number.NaN;
				continue;
			}
			const col = Math.floor(px[index]);
			if (col !== column || first < 0) {
				flush();
				column = col;
				first = low = high = last = index;
			} else {
				last = index;
				if (ys[index] < ys[low]) {
					low = index;
				}
				if (ys[index] > ys[high]) {
					high = index;
				}
			}
		}
		flush();
		return out;
	}

	//#endregion

	//#region Color

	const PALETTE = [1, 2, 3, 4, 5, 6, 7, 8].map(index => `var(--vc-c${index})`);
	const NAMED_COLORS: Readonly<Record<string, string>> = {
		accent: 'var(--vc-accent)', primary: 'var(--vc-accent)', blue: 'var(--vc-blue)', green: 'var(--vc-green)', orange: 'var(--vc-orange)',
		purple: 'var(--vc-purple)', yellow: 'var(--vc-yellow)', red: 'var(--vc-red)', pink: 'var(--vc-pink)', teal: 'var(--vc-teal)', cyan: 'var(--vc-teal)',
		gray: 'var(--vc-other)', grey: 'var(--vc-other)', muted: 'var(--vc-other)', other: 'var(--vc-other)', foreground: 'var(--vc-fg)',
		success: 'var(--vc-good)', good: 'var(--vc-good)', error: 'var(--vc-bad)', bad: 'var(--vc-bad)', warning: 'var(--vc-yellow)',
	};
	const OTHER_NAME = /^(other|others|rest|remaining|misc|everything else|unknown)\b/i;

	/** A CSS color the agent may pass through, or undefined. Anything that could break out of a property is refused. */
	function cssColor(value: unknown): string | undefined {
		if (isNum(value) && value >= 1 && value <= 8) {
			return PALETTE[Math.round(value) - 1];
		}
		if (typeof value !== 'string') {
			return undefined;
		}
		const text = value.trim();
		const lower = text.toLowerCase();
		if (NAMED_COLORS[lower]) {
			return NAMED_COLORS[lower];
		}
		const chart = /^(?:chart-?|c)([1-8])$/.exec(lower);
		if (chart) {
			return PALETTE[Number(chart[1]) - 1];
		}
		if (/^--[a-z0-9-]+$/i.test(text)) {
			return `var(${text})`;
		}
		if (/[;{}<>\\]/.test(text) || text.length > 120) {
			return undefined;
		}
		if (/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|var)\(.*\))$/i.test(text)) {
			return text;
		}
		return /^[a-z]{3,20}$/i.test(text) ? text : undefined;
	}

	function seriesColor(value: unknown, index: number, name: string | undefined): string {
		return cssColor(value) ?? (name && OTHER_NAME.test(name) ? 'var(--vc-other)' : PALETTE[index % PALETTE.length]);
	}

	/** One hue from faint to the theme accent, for heatmaps: steps so neighbouring cells read apart. */
	function heatColor(t: number, steps = 10): string {
		const q = Math.round(clamp(t, 0, 1) * (steps - 1)) / (steps - 1);
		if (q > 0.72) {
			// The busiest cells lift past the accent toward the foreground, so the peak reads at a glance.
			return `color-mix(in oklab, var(--vc-fg) ${Math.round(((q - 0.72) / 0.28) * 45)}%, var(--vc-accent))`;
		}
		return `color-mix(in oklab, var(--vc-accent) ${Math.round(8 + (q / 0.72) * 92)}%, var(--vc-heat-low))`;
	}

	const SPECTRUM = ['var(--vc-cold)', 'var(--vc-teal)', 'var(--vc-green)', 'var(--vc-yellow)', 'var(--vc-orange)', 'var(--vc-red)'];

	/** Cold to hot across the theme's own hues, for treemaps and ranked bars (churn, errors, latency). */
	function spectrumColor(t: number): string {
		const value = clamp(t, 0, 1) * (SPECTRUM.length - 1);
		const index = Math.min(SPECTRUM.length - 2, Math.floor(value));
		const f = Math.round((value - index) * 100);
		return f <= 0 ? SPECTRUM[index] : `color-mix(in oklab, ${SPECTRUM[index + 1]} ${f}%, ${SPECTRUM[index]})`;
	}

	/** Light or dark, read from the theme classes the workbench and webviews set. */
	function isLightTheme(element: Element): boolean {
		const workbench = element.closest('.monaco-workbench');
		if (workbench) {
			return workbench.classList.contains('vs') || workbench.classList.contains('hc-light');
		}
		const body = element.ownerDocument.body;
		if (body?.classList.contains('vscode-light') || body?.classList.contains('vscode-high-contrast-light')) {
			return true;
		}
		if (body?.classList.contains('vscode-dark') || body?.classList.contains('vscode-high-contrast')) {
			return false;
		}
		const scheme = element.ownerDocument.documentElement.style.colorScheme || win.getComputedStyle(element.ownerDocument.documentElement).colorScheme;
		if (scheme === 'light') {
			return true;
		}
		if (scheme === 'dark') {
			return false;
		}
		return !!win.matchMedia?.('(prefers-color-scheme: light)').matches;
	}

	//#endregion

	//#region Motion

	interface ISpring {
		value: number;
		velocity: number;
		target: number;
	}

	/**
	 * Critically-damped-ish springs for the hover cursor and tooltip: they settle in ~200ms with
	 * no visible overshoot, and run only while something moves.
	 */
	class Springs {
		private readonly items = new Map<string, ISpring>();
		private frame = 0;
		private last = 0;

		constructor(private readonly apply: () => void, private readonly stiffness = 620, private readonly dampingRatio = 0.9) { }

		set(key: string, target: number, jump = false): void {
			const spring = this.items.get(key);
			if (!spring || jump || reducedMotion()) {
				this.items.set(key, { value: target, velocity: 0, target });
			} else {
				spring.target = target;
			}
			this.kick();
		}

		get(key: string): number {
			return this.items.get(key)?.value ?? 0;
		}

		private kick(): void {
			if (!this.frame) {
				this.last = win.performance.now();
				this.frame = win.requestAnimationFrame(now => this.tick(now));
			}
		}

		private tick(now: number): void {
			const dt = Math.min(0.034, Math.max(0.001, (now - this.last) / 1000));
			this.last = now;
			const damping = 2 * Math.sqrt(this.stiffness) * this.dampingRatio;
			let moving = false;
			for (const spring of this.items.values()) {
				for (let sub = 0; sub < 2; sub++) {
					const h2 = dt / 2;
					const force = -this.stiffness * (spring.value - spring.target) - damping * spring.velocity;
					spring.velocity += force * h2;
					spring.value += spring.velocity * h2;
				}
				if (Math.abs(spring.value - spring.target) < 0.05 && Math.abs(spring.velocity) < 0.5) {
					spring.value = spring.target;
					spring.velocity = 0;
				} else {
					moving = true;
				}
			}
			this.apply();
			this.frame = moving ? win.requestAnimationFrame(next => this.tick(next)) : 0;
		}

		dispose(): void {
			if (this.frame) {
				win.cancelAnimationFrame(this.frame);
				this.frame = 0;
			}
		}
	}

	interface ITween {
		cancel(): void;
	}

	/** Calls `frame` with an eased 0..1 for `ms`, then 1. With reduced motion, only 1. */
	function tween(ms: number, frame: (t: number) => void, done?: () => void): ITween {
		if (ms <= 0 || reducedMotion()) {
			frame(1);
			done?.();
			return { cancel: () => { } };
		}
		let handle = 0;
		const start = win.performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			frame(easeOut(t));
			if (t < 1) {
				handle = win.requestAnimationFrame(step);
			} else {
				handle = 0;
				done?.();
			}
		};
		handle = win.requestAnimationFrame(step);
		return { cancel: () => handle && win.cancelAnimationFrame(handle) };
	}

	//#endregion

	//#region Styles

	const CSS = `
.vc-root{
	--vc-fg:var(--foreground,var(--vscode-foreground,#cccccc));
	--vc-muted:var(--muted-foreground,var(--vscode-descriptionForeground,color-mix(in srgb,var(--vc-fg) 62%,transparent)));
	--vc-bg:var(--background,var(--volt-agent-window-bg-base,var(--vscode-editor-background,#1e1e1e)));
	--vc-surface:var(--popover,var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,var(--vc-bg))));
	--vc-hair:color-mix(in srgb,var(--vc-fg) 10%,transparent);
	--vc-grid:color-mix(in srgb,var(--vc-fg) 6%,transparent);
	--vc-grid-dot:color-mix(in srgb,var(--vc-fg) 13%,transparent);
	--vc-axis-ink:color-mix(in srgb,var(--vc-fg) 42%,transparent);
	--vc-zero:color-mix(in srgb,var(--vc-fg) 18%,transparent);
	--vc-focus:var(--ring,var(--vscode-focusBorder,var(--vc-accent)));
	--vc-mono:var(--font-mono,var(--volt-code-font,var(--vscode-editor-font-family,ui-monospace,Menlo,monospace)));
	--vc-accent:var(--volt-chart-accent,var(--chart-1,var(--vscode-textLink-foreground,#3794ff)));
	--vc-blue:var(--volt-chart-blue,var(--vscode-charts-blue,#3794ff));
	--vc-green:var(--volt-chart-green,var(--vscode-charts-green,#89d185));
	--vc-orange:var(--volt-chart-orange,var(--vscode-charts-orange,#d18616));
	--vc-purple:var(--volt-chart-purple,var(--vscode-charts-purple,#b180d7));
	--vc-yellow:var(--volt-chart-yellow,var(--vscode-charts-yellow,#cca700));
	--vc-red:var(--volt-chart-red,var(--vscode-charts-red,#f14c4c));
	--vc-teal:var(--volt-chart-teal,var(--vscode-terminal-ansiCyan,#29b8db));
	--vc-pink:var(--volt-chart-pink,var(--vscode-terminal-ansiBrightMagenta,#d670d6));
	--vc-good:var(--success,var(--vc-green));
	--vc-bad:var(--destructive,var(--vc-red));
	--vc-other:color-mix(in srgb,var(--vc-fg) 30%,var(--vc-bg));
	--vc-cold:color-mix(in oklab,var(--vc-blue) 55%,var(--vc-bg));
	--vc-heat-low:color-mix(in srgb,var(--vc-fg) 5%,var(--vc-bg));
	--vc-c1:var(--vc-accent);
	--vc-c2:var(--chart-2,var(--vc-orange));
	--vc-c3:var(--chart-3,var(--vc-green));
	--vc-c4:var(--chart-4,var(--vc-purple));
	--vc-c5:var(--chart-5,var(--vc-yellow));
	--vc-c6:var(--chart-6,var(--vc-teal));
	--vc-c7:var(--chart-7,var(--vc-pink));
	--vc-c8:var(--chart-8,var(--vc-red));
	--vc-seg-track:color-mix(in srgb,var(--vc-fg) 7%,transparent);
	--vc-seg-on:color-mix(in srgb,var(--vc-fg) 16%,var(--vc-bg));
	--vc-tip-bg:var(--vc-surface);
	--vc-tip-border:color-mix(in srgb,var(--vc-fg) 13%,transparent);
	--vc-shadow:0 10px 28px -8px rgba(0,0,0,.5),0 2px 8px -2px rgba(0,0,0,.3);
	position:relative;color:var(--vc-fg);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;min-width:0;
}
.vc-root.vc-light{--vc-seg-on:var(--vc-bg);--vc-seg-track:color-mix(in srgb,var(--vc-fg) 8%,transparent);--vc-shadow:0 10px 28px -8px rgba(0,0,0,.18),0 2px 8px -2px rgba(0,0,0,.1);--vc-grid:color-mix(in srgb,var(--vc-fg) 7%,transparent);--vc-grid-dot:color-mix(in srgb,var(--vc-fg) 16%,transparent);--vc-axis-ink:color-mix(in srgb,var(--vc-fg) 50%,transparent);}
.vc-root *{box-sizing:border-box}
.vc-root button{font:inherit}
.vc-visual-head{margin:0 0 18px}
.vc-visual-title{font-size:15px;line-height:21px;font-weight:600;letter-spacing:-.01em;margin:0}
.vc-visual-subtitle{color:var(--vc-muted);margin:2px 0 0}
.vc-blocks{display:flex;flex-direction:column;gap:34px}
.vc-block{min-width:0;position:relative}
.vc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:28px 24px}
.vc-head{margin:0 0 12px}
.vc-variant-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin:0 0 12px}
.vc-variant-head .vc-head{margin:0;flex:1 1 240px;min-width:0}
.vc-variant-head .vc-seg{flex:none}
.vc-title{font-size:14px;line-height:20px;font-weight:600;letter-spacing:-.005em;margin:0}
.vc-subtitle{color:var(--vc-muted);line-height:18px;margin:2px 0 0}
.vc-note{color:var(--vc-muted);font-size:12px;margin-top:10px}
.vc-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;margin:0 0 14px}
.vc-top:empty{display:none}
.vc-metric{min-width:0}
.vc-metric-value{font-size:30px;line-height:34px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap}
.vc-metric-label{font-size:12px;color:var(--vc-muted);margin-top:3px}
.vc-delta{font-size:12px;color:var(--vc-muted);margin-top:5px;font-variant-numeric:tabular-nums}
.vc-delta b{font-weight:600;color:var(--vc-fg)}
.vc-delta.vc-good b{color:var(--vc-good)}
.vc-delta.vc-bad b{color:var(--vc-bad)}
.vc-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.vc-seg{position:relative;display:inline-flex;padding:2px;border-radius:8px;background:var(--vc-seg-track);isolation:isolate}
.vc-seg-pill{position:absolute;top:2px;bottom:2px;left:0;width:0;border-radius:6px;background:var(--vc-seg-on);box-shadow:0 0 0 .5px var(--vc-hair),0 1px 2px rgba(0,0,0,.14);transition:transform 280ms ${EASE_OUT},width 280ms ${EASE_OUT};z-index:-1}
.vc-seg button{appearance:none;border:0;background:none;color:var(--vc-muted);font-size:12px;font-weight:500;line-height:18px;padding:2px 9px;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap;transition:color 160ms}
.vc-seg button:hover{color:var(--vc-fg)}
.vc-seg button[aria-pressed=true]{color:var(--vc-fg)}
.vc-seg button:focus-visible{outline:1px solid var(--vc-focus);outline-offset:-1px}
.vc-legend{display:flex;flex-wrap:wrap;gap:2px 14px;margin:0 0 10px}
.vc-legend-item{appearance:none;border:0;background:none;padding:2px 0;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--vc-fg);cursor:pointer;border-radius:4px;transition:opacity 160ms}
.vc-legend-item.vc-off{opacity:.42}
.vc-legend-item.vc-off .vc-swatch{background:transparent!important;box-shadow:inset 0 0 0 1.5px currentColor}
.vc-legend-item:focus-visible{outline:1px solid var(--vc-focus);outline-offset:2px}
.vc-swatch{width:9px;height:9px;border-radius:2.5px;flex:none}
.vc-swatch.vc-dash{height:2px;width:12px;border-radius:1px;background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 7px)!important}
.vc-plot{position:relative;width:100%;user-select:none;-webkit-user-select:none;outline:none;border-radius:6px;touch-action:pan-y}
.vc-plot:focus-visible{box-shadow:0 0 0 1px var(--vc-focus)}
.vc-svg{display:block;overflow:visible}
.vc-grid line{stroke:var(--vc-grid);shape-rendering:crispEdges}
.vc-grid line.vc-zero{stroke:var(--vc-zero)}
.vc-tick{transition:opacity ${TWEEN_MS}ms ease}
.vc-axis text,.vc-tick text{fill:var(--vc-axis-ink);font-family:var(--vc-mono);font-size:10.5px;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.vc-axis text.vc-cat{fill:var(--vc-muted);font-family:inherit;font-size:11px;letter-spacing:0}
.vc-s{transition:opacity 180ms ease}
.vc-dim .vc-s:not(.vc-on){opacity:.18}
.vc-line{fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.vc-line.vc-dashed{stroke-dasharray:3 4;stroke-width:1.5}
.vc-line.vc-ref{stroke-dasharray:3 4;stroke-width:1.25;opacity:.75}
.vc-band{stroke:var(--vc-bg);stroke-width:1;stroke-linejoin:round}
.vc-band-hatched{stroke:none}
.vc-dot{stroke:var(--vc-bg);stroke-width:1.5}
.vc-scatter{stroke:var(--vc-bg);stroke-width:1;fill-opacity:.78;transition:opacity 160ms}
.vc-anno line{stroke:color-mix(in srgb,var(--vc-fg) 55%,transparent);stroke-width:1;shape-rendering:crispEdges}
.vc-rule line{stroke:color-mix(in srgb,var(--vc-fg) 40%,transparent);stroke-dasharray:2 3;stroke-width:1}
.vc-anno text,.vc-rule text,.vc-callout text,.vc-mark text{font-size:11px;font-weight:600;fill:var(--vc-fg);paint-order:stroke;stroke:var(--vc-bg);stroke-width:3px;stroke-linejoin:round}
.vc-callout circle,.vc-mark circle{stroke:var(--vc-bg);stroke-width:1.5}
.vc-end text{font-size:12px;fill:var(--vc-muted);font-variant-numeric:tabular-nums}
.vc-end text tspan.vc-end-value{fill:var(--vc-fg);font-weight:500}
.vc-cursor{pointer-events:none;opacity:0;transition:opacity 140ms ease}
.vc-cursor.vc-shown{opacity:1}
.vc-crosshair{stroke:color-mix(in srgb,var(--vc-fg) 30%,transparent);stroke-width:1;shape-rendering:crispEdges}
.vc-band-hover{fill:color-mix(in srgb,var(--vc-fg) 6%,transparent)}
.vc-knob{stroke:var(--vc-bg);stroke-width:2}
.vc-knob-halo{opacity:.16}
.vc-hit{fill:transparent}
.vc-hit.vc-link{cursor:pointer}
.vc-tip{position:absolute;left:0;top:0;z-index:3;pointer-events:none;min-width:128px;max-width:min(280px,calc(100% - 8px));padding:8px 10px 9px;border-radius:10px;background:var(--vc-tip-bg);border:.5px solid var(--vc-tip-border);box-shadow:var(--vc-shadow);font-size:12px;line-height:17px;opacity:0;transition:opacity 120ms ease;will-change:transform,opacity}
.vc-tip.vc-shown{opacity:1}
.vc-tip-title{color:var(--vc-muted);font-size:11px;line-height:15px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-tip-hero{font-size:17px;line-height:22px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.vc-tip-sub{color:var(--vc-fg);margin:1px 0 0}
.vc-tip-row{display:flex;align-items:center;gap:7px;min-height:18px}
.vc-tip-name{flex:1;min-width:0;color:var(--vc-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-tip-value{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}
.vc-tip-row.vc-strong .vc-tip-name{color:var(--vc-fg)}
.vc-tip-row.vc-strong .vc-tip-value{font-weight:600}
.vc-tip-meta{margin-top:5px;padding-top:5px;border-top:.5px solid var(--vc-hair)}
.vc-tip-hint{margin-top:5px;color:var(--vc-muted);font-size:11px}
.vc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.vc-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3px;pointer-events:none;padding:0 16px}
.vc-empty-title{font-size:13px;font-weight:500}
.vc-empty-message{font-size:12px;color:var(--vc-muted);max-width:300px}
.vc-loading .vc-skel{animation:vc-pulse 1.5s ease-in-out infinite}
.vc-skel-bar{background:color-mix(in srgb,var(--vc-fg) 8%,transparent);border-radius:6px}
@keyframes vc-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.vc-fade-in{animation:vc-fade ${FADE_MS}ms ease both}
@keyframes vc-fade{from{opacity:0}to{opacity:1}}
.vc-stats{overflow:hidden;border-top:1px solid var(--vc-hair);border-bottom:1px solid var(--vc-hair)}
.vc-stats-inner{display:flex;flex-wrap:wrap;margin-left:-17px}
.vc-stat{flex:1 1 128px;min-width:0;padding:14px 16px 13px;border-left:1px solid var(--vc-hair);margin-bottom:-1px;border-bottom:1px solid var(--vc-hair)}
.vc-stat-value{font-size:26px;line-height:32px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-stat-label{color:var(--vc-muted);font-size:12.5px;line-height:17px;margin-top:2px}
.vc-stat-delta{font-size:11.5px;font-weight:500;margin-top:4px;color:var(--vc-muted);font-variant-numeric:tabular-nums}
.vc-stat-delta.vc-good{color:var(--vc-good)}
.vc-stat-delta.vc-bad{color:var(--vc-bad)}
.vc-stat-trend{display:block;margin-top:8px;overflow:visible}
.vc-heat-cell{transition:opacity 140ms}
.vc-heat-hover{fill:none;stroke:var(--vc-fg);stroke-width:1.5;pointer-events:none;transition:opacity 120ms}
.vc-heat-key{display:flex;align-items:center;gap:6px;color:var(--vc-muted);font-size:12px;margin-top:10px}
.vc-heat-key span.vc-heat-step{width:12px;height:12px;border-radius:2.5px}
.vc-tree-crumbs{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--vc-muted);margin:0 0 8px;min-height:18px;font-family:var(--vc-mono)}
.vc-tree-crumbs button{appearance:none;border:0;background:none;padding:0;color:var(--vc-muted);cursor:pointer;font:inherit}
.vc-tree-crumbs button:hover{color:var(--vc-fg)}
.vc-tree-crumbs .vc-current{color:var(--vc-fg)}
.vc-tile{stroke:var(--vc-bg);stroke-width:1;transition:opacity 160ms}
.vc-tile-label{font-size:11px;fill:var(--vc-tile-ink,#fff);pointer-events:none;font-family:var(--vc-mono)}
.vc-group-label{font-size:11px;fill:var(--vc-fg);pointer-events:none;font-family:var(--vc-mono);font-weight:600}
.vc-group-sub{font-weight:400;fill:var(--vc-muted)}
.vc-tile-hover{fill:none;stroke:var(--vc-fg);stroke-width:1.5;pointer-events:none}
.vc-tree-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--vc-muted)}
.vc-ramp{display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
.vc-ramp i{display:block;width:120px;height:6px;border-radius:3px}
.vc-ranked{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(64px,1fr) auto;align-items:center;gap:0 14px}
.vc-ranked-row{display:contents;cursor:default}
.vc-ranked-row>*{padding:4px 0;transition:background-color 120ms}
.vc-ranked-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.vc-ranked.vc-mono .vc-ranked-label{font-family:var(--vc-mono);font-size:12px}
.vc-ranked-label .vc-dir{color:var(--vc-muted)}
.vc-ranked-bar{height:100%;display:flex;align-items:center}
.vc-ranked-bar i{display:block;height:7px;border-radius:3.5px;transform-origin:left center;transition:transform 520ms ${EASE_OUT}}
.vc-ranked-value{text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:var(--vc-muted);white-space:nowrap}
.vc-ranked-row:hover .vc-ranked-label,.vc-ranked-row.vc-active .vc-ranked-label{color:var(--vc-fg)}
.vc-ranked-row.vc-link{cursor:pointer}
.vc-ranked-row.vc-link:hover .vc-ranked-label{text-decoration:underline;text-underline-offset:2px}
.vc-ranked-row:focus-visible .vc-ranked-label{outline:1px solid var(--vc-focus);outline-offset:1px;border-radius:2px}
.vc-more{appearance:none;border:0;background:none;color:var(--vc-muted);font-size:12px;padding:6px 0 0;cursor:pointer}
.vc-more:hover{color:var(--vc-fg)}
.vc-donut{display:flex;align-items:center;gap:20px 28px;flex-wrap:wrap}
.vc-donut svg{flex:none;overflow:visible}
.vc-arc{transition:transform 220ms ${EASE_OUT},opacity 160ms;cursor:default}
.vc-donut-list{flex:1;min-width:180px;display:flex;flex-direction:column;gap:3px}
.vc-donut-item{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;padding:1px 6px;margin:0 -6px;border-radius:5px;cursor:default}
.vc-donut-item.vc-active{background:color-mix(in srgb,var(--vc-fg) 6%,transparent)}
.vc-donut-item .vc-tip-name{color:var(--vc-fg)}
.vc-donut-share{color:var(--vc-muted);font-variant-numeric:tabular-nums;min-width:42px;text-align:right;font-size:12px}
.vc-donut-center-value{font-size:20px;font-weight:600;letter-spacing:-.02em;fill:var(--vc-fg);font-variant-numeric:tabular-nums}
.vc-donut-center-label{font-size:11px;fill:var(--vc-muted)}
@media (prefers-reduced-motion:reduce){.vc-root *,.vc-root *::before{transition:none!important;animation:none!important}}
`;

	function ensureStyles(target: Document): void {
		if (target.getElementById('vc-styles')) {
			return;
		}
		const style = target.createElement('style');
		style.id = 'vc-styles';
		style.textContent = CSS + SHOWCASE_CSS;
		(target.head ?? target.documentElement).appendChild(style);
	}

	//#endregion

	//#region Shared parts: blocks, tooltip, legend, segmented control, metric header

	interface IContext {
		readonly strings: IVoltChartsStrings;
		readonly onOpen?: (href: string) => void;
		/** Whether the next first draw animates. */
		animate: boolean;
		readonly root: HTMLElement;
	}

	interface IBlock {
		readonly element: HTMLElement;
		layout(width: number): void;
		setLoading?(loading: boolean): void;
		dispose(): void;
	}

	function safeHref(value: unknown): string | undefined {
		const text = typeof value === 'string' ? value.trim() : '';
		return /^(volt:|https?:\/\/|file:\/\/|\/)/i.test(text) && text.length < 2048 && !/[\s<>"]/.test(text) ? text : undefined;
	}

	function detailRows(value: unknown): [string, string][] | undefined {
		if (!isRecord(value)) {
			return undefined;
		}
		const rows: [string, string][] = [];
		for (const [key, raw] of Object.entries(value)) {
			const text = isNum(raw) ? (Math.abs(raw) < 10_000 ? small(raw) : compact(raw)) : str(raw, 80);
			const label = str(key, 40);
			if (label && text !== undefined) {
				rows.push([label, text]);
			}
			if (rows.length >= 8) {
				break;
			}
		}
		return rows.length ? rows : undefined;
	}

	function blockHead(parent: HTMLElement, title: unknown, subtitle: unknown): void {
		const titleText = str(title, 160);
		const subtitleText = str(subtitle, 300);
		if (!titleText && !subtitleText) {
			return;
		}
		const head = h('div', 'vc-head', parent);
		if (titleText) {
			h('div', 'vc-title', head, titleText).setAttribute('role', 'heading');
		}
		if (subtitleText) {
			h('div', 'vc-subtitle', head, subtitleText);
		}
	}

	interface ITipRow {
		readonly name: string;
		readonly value: string;
		readonly color?: string;
		readonly dashed?: boolean;
		readonly strong?: boolean;
	}

	interface ITipModel {
		readonly title?: string;
		readonly hero?: string;
		readonly sub?: string;
		readonly rows?: readonly ITipRow[];
		readonly meta?: readonly (readonly [string, string])[];
		readonly hint?: string;
	}

	/**
	 * A small popover beside the hovered point. It glides on a spring rather than tracking raw
	 * pointer pixels, flips to the other side near an edge, and never leaves its chart.
	 */
	class Tip {
		readonly element: HTMLElement;
		private width = 0;
		private height = 0;
		private shown = false;
		private side: 1 | -1 = 1;
		private readonly springs: Springs;

		constructor(parent: HTMLElement) {
			this.element = h('div', 'vc-tip', parent);
			this.element.setAttribute('aria-hidden', 'true');
			this.springs = new Springs(() => {
				this.element.style.transform = `translate3d(${Math.round(this.springs.get('x'))}px,${Math.round(this.springs.get('y'))}px,0)`;
			}, 700, 0.95);
		}

		set(model: ITipModel): void {
			const el = this.element;
			el.replaceChildren();
			if (model.title) {
				h('div', 'vc-tip-title', el, model.title);
			}
			if (model.hero) {
				h('div', 'vc-tip-hero', el, model.hero);
			}
			if (model.sub) {
				h('div', 'vc-tip-sub', el, model.sub);
			}
			const rows = model.rows ?? [];
			if (rows.length) {
				const list = h('div', model.hero ? 'vc-tip-meta' : '', el);
				for (const row of rows) {
					const line = h('div', `vc-tip-row${row.strong ? ' vc-strong' : ''}`, list);
					if (row.color) {
						const swatch = h('span', `vc-swatch${row.dashed ? ' vc-dash' : ''}`, line);
						swatch.style.background = row.color;
						swatch.style.color = row.color;
					}
					h('span', 'vc-tip-name', line, row.name);
					h('span', 'vc-tip-value', line, row.value);
				}
			}
			const meta = model.meta ?? [];
			if (meta.length) {
				const list = h('div', 'vc-tip-meta', el);
				for (const [name, value] of meta) {
					const line = h('div', 'vc-tip-row', list);
					h('span', 'vc-tip-name', line, name);
					h('span', 'vc-tip-value', line, value);
				}
			}
			if (model.hint) {
				h('div', 'vc-tip-hint', el, model.hint);
			}
			this.width = el.offsetWidth;
			this.height = el.offsetHeight;
		}

		/** Beside (x, y), inside a `width` x `height` box, between `top` and `bottom`. */
		place(x: number, y: number, width: number, top: number, bottom: number, gap = 14): void {
			const fitsRight = x + gap + this.width <= width - 2;
			const fitsLeft = x - gap - this.width >= 2;
			if (this.side === 1 && !fitsRight && fitsLeft) {
				this.side = -1;
			} else if (this.side === -1 && !fitsLeft && fitsRight) {
				this.side = 1;
			} else if (!this.shown) {
				this.side = fitsRight || !fitsLeft ? 1 : -1;
			}
			const left = clamp(this.side === 1 ? x + gap : x - gap - this.width, 2, Math.max(2, width - this.width - 2));
			const topEdge = clamp(y - this.height / 2, top, Math.max(top, bottom - this.height));
			const jump = !this.shown;
			this.springs.set('x', left, jump);
			this.springs.set('y', topEdge, jump);
		}

		show(): void {
			if (!this.shown) {
				this.shown = true;
				this.element.classList.add('vc-shown');
			}
		}

		hide(): void {
			this.shown = false;
			this.element.classList.remove('vc-shown');
		}

		dispose(): void {
			this.springs.dispose();
		}
	}

	interface ISegmented {
		readonly element: HTMLElement;
		select(id: string): void;
		refresh(): void;
	}

	/** A segmented control with a pill that slides to the selected option. */
	function segmented(parent: HTMLElement, label: string, options: readonly { readonly id: string; readonly label: string }[], selected: string, onSelect: (id: string) => void): ISegmented {
		const element = h('div', 'vc-seg', parent);
		element.setAttribute('role', 'group');
		element.setAttribute('aria-label', label);
		const pill = h('span', 'vc-seg-pill', element);
		const buttons = new Map<string, HTMLButtonElement>();
		let current = selected;
		let placed = false;
		const position = () => {
			const button = buttons.get(current);
			if (!button || !button.offsetWidth) {
				return;
			}
			if (!placed) {
				pill.style.transition = 'none';
			}
			pill.style.width = `${button.offsetWidth}px`;
			pill.style.transform = `translateX(${button.offsetLeft - 2}px)`;
			if (!placed) {
				void pill.offsetWidth;
				pill.style.transition = '';
				placed = true;
			}
		};
		const select = (id: string) => {
			current = id;
			for (const [key, button] of buttons) {
				button.setAttribute('aria-pressed', String(key === id));
			}
			position();
		};
		for (const option of options) {
			const button = h('button', '', element, option.label);
			button.type = 'button';
			button.addEventListener('click', () => {
				if (current !== option.id) {
					select(option.id);
					onSelect(option.id);
				}
			});
			button.addEventListener('keydown', event => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
					return;
				}
				event.preventDefault();
				const index = options.findIndex(item => item.id === current);
				const next = options[clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, options.length - 1)];
				if (next && next.id !== current) {
					select(next.id);
					onSelect(next.id);
					buttons.get(next.id)?.focus();
				}
			});
			buttons.set(option.id, button);
		}
		select(selected);
		win.requestAnimationFrame(position);
		return { element, select, refresh: position };
	}

	interface ILegendItem {
		readonly key: string;
		readonly name: string;
		readonly color: string;
		readonly dashed: boolean;
	}

	class Legend {
		readonly element: HTMLElement;
		private readonly buttons = new Map<string, HTMLButtonElement>();

		constructor(parent: HTMLElement, items: readonly ILegendItem[], private readonly handlers: { hover(key: string | undefined): void; toggle(key: string): void }) {
			this.element = h('div', 'vc-legend', parent);
			for (const item of items) {
				const button = h('button', 'vc-legend-item', this.element);
				button.type = 'button';
				const swatch = h('span', `vc-swatch${item.dashed ? ' vc-dash' : ''}`, button);
				swatch.style.background = item.color;
				swatch.style.color = item.color;
				h('span', '', button, item.name);
				button.setAttribute('aria-pressed', 'true');
				button.addEventListener('pointerenter', () => this.handlers.hover(item.key));
				button.addEventListener('pointerleave', () => this.handlers.hover(undefined));
				button.addEventListener('focus', () => this.handlers.hover(item.key));
				button.addEventListener('blur', () => this.handlers.hover(undefined));
				button.addEventListener('click', () => this.handlers.toggle(item.key));
				this.buttons.set(item.key, button);
			}
		}

		setHidden(hidden: ReadonlySet<string>): void {
			for (const [key, button] of this.buttons) {
				const off = hidden.has(key);
				button.classList.toggle('vc-off', off);
				button.setAttribute('aria-pressed', String(!off));
			}
		}
	}

	/** The big number above a chart, its label, and the change against the previous period. */
	class MetricHeader {
		readonly element: HTMLElement;
		private readonly value: HTMLElement;
		private readonly label: HTMLElement;
		private readonly delta: HTMLElement;
		private shownValue: number | undefined;
		private counting: ITween | undefined;

		constructor(parent: HTMLElement) {
			this.element = h('div', 'vc-metric', parent);
			this.value = h('div', 'vc-metric-value', this.element);
			this.label = h('div', 'vc-metric-label', this.element);
			this.delta = h('div', 'vc-delta', this.element);
		}

		set(value: number | undefined, unit: IUnit, label: string | undefined, delta: { text: string; direction: -1 | 0 | 1 } | undefined, deltaLabel: string, good: 'up' | 'down' | undefined, animate: boolean): void {
			this.counting?.cancel();
			const from = this.shownValue;
			this.shownValue = value;
			if (animate && isNum(from) && isNum(value) && from !== value) {
				this.counting = tween(TWEEN_MS, t => this.value.textContent = formatValue(lerp(from, value, t), unit, false));
			} else {
				this.value.textContent = formatValue(value, unit, false);
			}
			this.label.textContent = label ?? '';
			this.label.style.display = label ? '' : 'none';
			this.delta.replaceChildren();
			this.delta.className = 'vc-delta';
			if (delta) {
				h('b', '', this.delta, delta.text);
				this.delta.append(` ${deltaLabel}`);
				if (good && delta.direction !== 0) {
					this.delta.classList.add((delta.direction > 0) === (good === 'up') ? 'vc-good' : 'vc-bad');
				}
			}
			this.delta.style.display = delta ? '' : 'none';
		}

		dispose(): void {
			this.counting?.cancel();
		}
	}

	//#endregion

	//#region Cartesian charts: line, area, bar, stacked, share, scatter

	interface ICPoint {
		readonly x: number;
		readonly y: number;
		readonly label?: string;
		readonly href?: string;
		readonly detail?: readonly (readonly [string, string])[];
		readonly size?: number;
	}

	interface ICSeries {
		readonly key: string;
		readonly name: string;
		readonly color: string;
		readonly dashed: boolean;
		readonly reference: boolean;
		/** A bar chart series drawn as a solid line over the bars; kept out of stacks and totals like a reference. */
		readonly overlay?: boolean;
		readonly unit: IUnit;
		readonly hidden: boolean;
		readonly points: readonly ICPoint[];
	}

	interface IHeadline {
		readonly value?: number;
		readonly label?: string;
		readonly aggregate: 'sum' | 'avg' | 'last' | 'max' | 'min';
		readonly compare: boolean;
		readonly good?: 'up' | 'down';
	}

	interface ICMetric {
		readonly id: string;
		readonly label: string;
		readonly unit: IUnit;
		readonly series: readonly ICSeries[];
		readonly headline?: IHeadline;
	}

	type XKind = 'time' | 'category' | 'number';

	interface ICModel {
		readonly type: VoltCartesianType;
		readonly xKind: XKind;
		readonly zone: ITimeZone;
		readonly grain: Grain;
		readonly categories: readonly string[];
		readonly xUnit: IUnit;
		readonly xLabel?: string;
		readonly yLabel?: string;
		readonly metrics: readonly ICMetric[];
		readonly yMin?: number;
		readonly yMax?: number;
		readonly yZero?: boolean;
		readonly annotations: readonly { readonly x: number; readonly label?: string }[];
		readonly rules: readonly { readonly y: number; readonly label?: string }[];
		readonly callouts: readonly { readonly x: number; readonly y: number; readonly label: string }[];
		readonly ranges: readonly string[];
		readonly range: string;
		readonly endLabels?: boolean;
		readonly highlight: 'max' | 'min' | 'last' | 'none';
		readonly curve: Curve;
		readonly legend?: boolean;
		readonly points?: boolean;
		readonly look: ILook;
		readonly height: number;
		readonly title?: string;
		readonly subtitle?: string;
		readonly note?: string;
		readonly emptyTitle?: string;
		readonly emptyMessage?: string;
		/** Set by the cumulative chart: its tooltip text per point. */
		readonly tooltip?: (point: ICPoint) => ITipModel;
	}

	const CARTESIAN_TYPES: readonly VoltCartesianType[] = ['line', 'area', 'bar', 'stacked-area', 'stacked-bar', 'share', 'grouped-bar', 'scatter'];
	const STEP_NAMES: readonly string[] = ['minute', 'hour', 'day', 'week', 'month', 'year'];

	function additive(unit: IUnit): boolean {
		return unit.kind === 'usd' || unit.kind === 'tokens' || unit.kind === 'count';
	}

	function parseHeadline(value: unknown, unit: IUnit): IHeadline | undefined {
		if (!value) {
			return undefined;
		}
		const spec = isRecord(value) ? value : {};
		const aggregate = (['sum', 'avg', 'last', 'max', 'min'] as const).find(item => item === spec.aggregate)
			?? (additive(unit) ? 'sum' : unit.kind === 'number' || unit.kind === 'custom' ? 'last' : 'avg');
		return {
			value: isNum(spec.value) ? spec.value : undefined,
			label: str(spec.label, 80),
			aggregate,
			compare: spec.compare !== false,
			good: spec.good === 'up' || spec.good === 'down' ? spec.good : undefined,
		};
	}

	/** Reads a line/area/bar spec into series of numeric points, collecting what an agent should fix. */
	function parseCartesian(spec: Record<string, unknown>, problems: string[], where: string): ICModel {
		const type = (CARTESIAN_TYPES as readonly string[]).includes(spec.type as string) ? spec.type as VoltCartesianType : 'line';
		const bars = type === 'bar' || type === 'grouped-bar' || type === 'stacked-bar';
		const xSpec = isRecord(spec.x) ? spec.x : {};
		const ySpec = isRecord(spec.y) ? spec.y : {};
		const zone = timeZoneOf(xSpec.timeZone);
		const categories: string[] = Array.isArray(spec.categories) ? spec.categories.map(item => str(item, 80) ?? '').slice(0, 2000) : [];
		const rawMetrics: Record<string, unknown>[] = Array.isArray(spec.metrics) && spec.metrics.length
			? spec.metrics.filter(isRecord).slice(0, 12)
			: [{ label: str(ySpec.label, 60) ?? str(spec.title, 60) ?? '', unit: ySpec.unit ?? spec.unit, series: spec.series, headline: spec.headline }];
		if (!rawMetrics.some(metric => Array.isArray(metric.series) && metric.series.length)) {
			problems.push(`${where}: give "series": [{ "name": "...", "data": [...] }] (or "metrics").`);
		}

		// What kind of x axis: explicit, categories, date strings, epoch numbers, or plain numbers.
		let sawString = false;
		let allTimeStrings = true;
		let sawNumber = false;
		let allEpochs = true;
		for (const metric of rawMetrics) {
			for (const series of Array.isArray(metric.series) ? metric.series : []) {
				const data = isRecord(series) && Array.isArray(series.data) ? series.data : [];
				for (let index = 0; index < Math.min(data.length, 400); index++) {
					const datum = data[index];
					const x = Array.isArray(datum) ? datum[0] : isRecord(datum) ? datum.x : undefined;
					if (typeof x === 'string') {
						sawString = true;
						allTimeStrings &&= looksLikeTime(x);
					} else if (isNum(x)) {
						sawNumber = true;
						allEpochs &&= Math.abs(x) >= 1e11;
					}
				}
			}
		}
		const declared = xSpec.type === 'time' || xSpec.type === 'category' || xSpec.type === 'number' ? xSpec.type : undefined;
		const startTime = xSpec.start !== undefined ? parseTime(xSpec.start, zone) : undefined;
		const xKind: XKind = declared
			?? (categories.length ? 'category'
				: sawString ? (allTimeStrings ? 'time' : 'category')
					: sawNumber ? (allEpochs ? 'time' : 'number')
						: startTime !== undefined && (typeof xSpec.start === 'string' || STEP_NAMES.includes(xSpec.step as string) || (isNum(xSpec.start) && Math.abs(xSpec.start) >= 1e11)) ? 'time'
							: categories.length ? 'category' : 'number');
		const step: VoltChartStep = isNum(xSpec.step) && xSpec.step > 0 ? xSpec.step : STEP_NAMES.includes(xSpec.step as string) ? xSpec.step as VoltChartStep : (xKind === 'time' ? 'day' : 1);
		const numericStart = isNum(xSpec.start) ? xSpec.start : 0;
		const categoryIndex = new Map<string, number>(categories.map((label, index) => [label, index]));
		const implicitX = (index: number): number => {
			if (xKind === 'time') {
				return addStep(startTime ?? 0, step, index, zone);
			}
			if (xKind === 'number') {
				return numericStart + index * (isNum(step) ? step : 1);
			}
			return index;
		};
		const readX = (raw: unknown, index: number): number | undefined => {
			if (raw === undefined || raw === null) {
				return implicitX(index);
			}
			if (xKind === 'time') {
				return parseTime(raw, zone);
			}
			if (xKind === 'number') {
				return isNum(raw) ? raw : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
			}
			const label = str(raw, 80) ?? String(index);
			let at = categoryIndex.get(label);
			if (at === undefined) {
				at = categories.length;
				categories.push(label);
				categoryIndex.set(label, at);
			}
			return at;
		};
		if (xKind === 'time' && !sawString && !sawNumber && startTime === undefined) {
			problems.push(`${where}: time charts need x values or "x": { "start": "2026-07-06", "step": "day" }.`);
		}

		let seriesIndex = 0;
		const metrics: ICMetric[] = rawMetrics.map((metric, metricIndex) => {
			const rawSeries = (Array.isArray(metric.series) ? metric.series : []).filter(isRecord).slice(0, 24);
			const allValues: number[] = [];
			const hintWords = [metric.label, ySpec.label, spec.title, spec.subtitle, ...rawSeries.map(series => series.name)].filter(item => typeof item === 'string').join(' ');
			const parsed = rawSeries.map((series, index) => {
				const name = str(series.name, 80) ?? `Series ${index + 1}`;
				const data = Array.isArray(series.data) ? series.data.slice(0, MAX_POINTS) : [];
				if (!Array.isArray(series.data)) {
					problems.push(`${where}: series "${name}" has no "data" array.`);
				}
				const points: ICPoint[] = [];
				let badX = 0;
				data.forEach((datum, at) => {
					let rawX: unknown;
					let rawY: unknown;
					let extra: Record<string, unknown> | undefined;
					if (Array.isArray(datum)) {
						rawX = datum[0];
						rawY = datum[1];
					} else if (isRecord(datum)) {
						rawX = datum.x;
						rawY = datum.y ?? datum.value;
						extra = datum;
					} else {
						rawY = datum;
					}
					const x = readX(rawX, at);
					if (x === undefined) {
						badX++;
						return;
					}
					const y = isNum(rawY) ? rawY : typeof rawY === 'string' && rawY.trim() !== '' && Number.isFinite(Number(rawY)) ? Number(rawY) : Number.NaN;
					if (Number.isFinite(y)) {
						allValues.push(y);
					}
					points.push({
						x, y,
						label: extra ? str(extra.label, 120) : undefined,
						href: extra ? safeHref(extra.href) : undefined,
						detail: extra ? detailRows(extra.detail) : undefined,
						size: extra && isNum(extra.size) ? extra.size : undefined,
					});
				});
				if (badX) {
					problems.push(`${where}: series "${name}" has ${badX} x value(s) that are not ${xKind === 'time' ? 'dates (ISO strings or epoch ms)' : 'numbers'}.`);
				}
				if (series.data && Array.isArray(series.data) && series.data.length > MAX_POINTS) {
					problems.push(`${where}: series "${name}" has more than ${MAX_POINTS} points; only the first ${MAX_POINTS} are drawn.`);
				}
				if (xKind !== 'category') {
					points.sort((a, b) => a.x - b.x);
				}
				const color = series.reference === true && series.color === undefined ? 'var(--vc-other)' : seriesColor(series.color, seriesIndex++, name);
				if (series.color !== undefined && !cssColor(series.color)) {
					problems.push(`${where}: series "${name}" color ${JSON.stringify(series.color)} is not a palette name or CSS color.`);
				}
				return { series, name, points, color };
			});
			// A share chart's own values are counts of something; "share" in its title says nothing about them.
			const unit = resolveUnit(metric.unit ?? ySpec.unit ?? spec.unit, type === 'share' ? hintWords.replace(/share|percent|%/gi, '') : hintWords, allValues);
			const result: ICSeries[] = parsed.map(({ series, name, points, color }, index) => ({
				key: `${metricIndex}:${index}:${name}`,
				name,
				color,
				dashed: series.dashed === true || series.reference === true,
				reference: series.reference === true || (bars && series.type === 'line'),
				overlay: bars && series.type === 'line',
				unit: series.unit !== undefined ? resolveUnit(series.unit) : unit,
				hidden: series.hidden === true,
				points,
			}));
			return {
				id: str(metric.id, 40) ?? String(metricIndex),
				label: str(metric.label, 60) ?? `Metric ${metricIndex + 1}`,
				unit: type === 'share' ? PERCENT_UNIT : unit,
				series: result,
				headline: parseHeadline(metric.headline ?? spec.headline, type === 'share' ? PERCENT_UNIT : unit),
			};
		});

		const allX: number[] = [];
		for (const metric of metrics) {
			for (const series of metric.series) {
				for (const point of series.points) {
					allX.push(point.x);
				}
			}
		}
		allX.sort((a, b) => a - b);
		const span = allX.length ? allX[allX.length - 1] - allX[0] : 0;
		let ranges: string[] = [];
		if (spec.ranges && xKind === 'time') {
			const wanted = Array.isArray(spec.ranges) ? spec.ranges.map(item => String(item).toUpperCase()) : ['1D', '7D', '30D', '3M', '1Y'];
			ranges = wanted.filter(key => RANGE_LENGTHS[key] !== undefined && RANGE_LENGTHS[key] < span * 0.98);
			if (ranges.length) {
				ranges.push('ALL');
			}
		} else if (spec.ranges) {
			problems.push(`${where}: "ranges" needs a time x axis.`);
		}
		const wantedRange = typeof spec.range === 'string' ? spec.range.toUpperCase() : 'ALL';

		const readXValue = (value: unknown) => readX(value, 0);
		const annotations = (Array.isArray(spec.annotations) ? spec.annotations : []).filter(isRecord).slice(0, 12).flatMap(item => {
			const x = readXValue(item.x);
			return x === undefined ? [] : [{ x, label: str(item.label, 60) }];
		});
		const callouts = (Array.isArray(spec.callouts) ? spec.callouts : []).filter(isRecord).slice(0, 12).flatMap(item => {
			const x = readXValue(item.x);
			const label = str(item.label, 60);
			return x === undefined || !isNum(item.y) || !label ? [] : [{ x, y: item.y, label }];
		});
		const rules = (Array.isArray(spec.rules) ? spec.rules : []).filter(isRecord).slice(0, 8).flatMap(item => isNum(item.y) ? [{ y: item.y, label: str(item.label, 60) }] : []);

		return {
			type,
			xKind,
			zone,
			grain: xKind === 'time' ? grainOf(allX.filter((value, index) => index === 0 || value !== allX[index - 1])) : 'day',
			categories,
			xUnit: resolveUnit(xSpec.unit, str(xSpec.label)),
			xLabel: str(xSpec.label, 60),
			yLabel: str(ySpec.label, 60),
			metrics,
			yMin: isNum(ySpec.min) ? ySpec.min : undefined,
			yMax: isNum(ySpec.max) ? ySpec.max : undefined,
			yZero: typeof ySpec.zero === 'boolean' ? ySpec.zero : undefined,
			annotations,
			rules,
			callouts,
			ranges,
			range: ranges.includes(wantedRange) ? wantedRange : (ranges.length ? 'ALL' : 'ALL'),
			endLabels: typeof spec.endLabels === 'boolean' ? spec.endLabels : undefined,
			highlight: spec.highlight === 'max' || spec.highlight === 'min' || spec.highlight === 'last' ? spec.highlight : 'none',
			curve: spec.curve === 'linear' || spec.curve === 'step' ? spec.curve : 'smooth',
			legend: typeof spec.legend === 'boolean' ? spec.legend : undefined,
			points: typeof spec.points === 'boolean' ? spec.points : undefined,
			look: readLook(spec),
			height: isNum(spec.height) ? clamp(Math.round(spec.height), 100, 720) : 240,
			title: str(spec.title, 160),
			subtitle: str(spec.subtitle, 300),
			note: str(spec.note, 300),
			emptyTitle: isRecord(spec.empty) ? str(spec.empty.title, 80) : undefined,
			emptyMessage: isRecord(spec.empty) ? str(spec.empty.message, 200) : undefined,
		};
	}

	interface IFrameSeries {
		readonly source: ICSeries;
		readonly visible: boolean;
		/** Sorted x of this series' points (all series share one for stacks and bars). */
		readonly xs: readonly number[];
		/** Drawn top (stack top, or the value) and bottom (stack base, or the baseline). NaN is a gap. */
		readonly top: readonly number[];
		readonly bot: readonly number[];
		/** The series' own value, for tooltips. */
		readonly raw: readonly number[];
		readonly points: readonly (ICPoint | undefined)[];
		/** Median spacing of its points: how far from a point the cursor still reads it. */
		readonly gap: number;
	}

	interface IFrame {
		readonly series: readonly IFrameSeries[];
		/** Every x a visible series has, sorted: where the cursor can stop. */
		readonly domain: readonly number[];
		readonly lo: number;
		readonly hi: number;
		readonly x0: number;
		readonly x1: number;
		readonly unit: IUnit;
		readonly empty: boolean;
	}

	interface IScale {
		(value: number): number;
		inv(px: number): number;
	}

	function linearScale(d0: number, d1: number, r0: number, r1: number): IScale {
		const span = d1 - d0 || 1;
		const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as IScale;
		scale.inv = (px: number) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
		return scale;
	}

	interface IBox {
		readonly width: number;
		readonly height: number;
		readonly left: number;
		readonly right: number;
		readonly top: number;
		readonly bottom: number;
	}

	interface ISeriesNodes {
		readonly group: SVGGElement;
		area?: SVGPathElement;
		line?: SVGPathElement;
		bars?: SVGPathElement;
		dots?: SVGGElement;
		gradient?: string;
		/** Indices drawn after downsampling, kept for the frames of a tween. */
		keep?: number[];
	}

	class CartesianChart implements IBlock {

		readonly element: HTMLElement;
		private readonly top: HTMLElement;
		private readonly legendHost: HTMLElement;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly defs: SVGDefsElement;
		private readonly bgLayer: SVGGElement;
		private readonly gridLayer: SVGGElement;
		private readonly xAxisLayer: SVGGElement;
		private readonly marksBack: SVGGElement;
		private readonly seriesLayer: SVGGElement;
		private readonly marksFront: SVGGElement;
		private readonly cursorLayer: SVGGElement;
		private readonly hit: SVGRectElement;
		private readonly tip: Tip;
		private readonly pill: AxisPill;
		private readonly live: HTMLElement;
		private readonly noteEl: HTMLElement;
		private emptyEl: HTMLElement | undefined;
		private header: MetricHeader | undefined;
		private metricControl: ISegmented | undefined;
		private rangeControl: ISegmented | undefined;
		private legend: Legend | undefined;

		private model!: ICModel;
		private metricIndex = 0;
		private range = 'ALL';
		private hidden = new Set<string>();
		private focusKey: string | undefined;
		private width = 0;
		private shown: IFrame | undefined;
		private nodes = new Map<string, ISeriesNodes>();
		private ticks = new Map<number, SVGGElement>();
		private box: IBox | undefined;
		private sx: IScale | undefined;
		private sy: IScale | undefined;
		private animation: ITween | undefined;
		private drawn = false;
		private loading = false;

		// Cursor state.
		private cursorIndex = -1;
		private primaryKey: string | undefined;
		private cursorShown = false;
		private pointer: { x: number; y: number } | undefined;
		private pointerFrame = 0;
		private readonly crosshair: SVGLineElement;
		private readonly bandHover: SVGRectElement;
		private readonly halo: SVGCircleElement;
		private readonly knob: SVGCircleElement;
		private readonly knobs = new Map<string, SVGCircleElement>();
		private readonly springs: Springs;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string, private readonly tooltip?: (point: ICPoint) => ITipModel) {
			this.element = h('div', 'vc-block vc-cartesian', parent);
			this.top = h('div', 'vc-top');
			this.legendHost = h('div', '');
			this.plot = h('div', 'vc-plot');
			this.plot.tabIndex = 0;
			this.plot.setAttribute('role', 'group');
			this.plot.setAttribute('aria-roledescription', 'interactive chart');
			this.svg = s('svg', { class: 'vc-svg' }, this.plot);
			this.defs = s('defs', {}, this.svg);
			this.bgLayer = s('g', { class: 'vc-bg' }, this.svg);
			this.gridLayer = s('g', { class: 'vc-grid' }, this.svg);
			this.xAxisLayer = s('g', { class: 'vc-axis' }, this.svg);
			this.marksBack = s('g', {}, this.svg);
			this.seriesLayer = s('g', { class: 'vc-series' }, this.svg);
			this.marksFront = s('g', {}, this.svg);
			this.cursorLayer = s('g', { class: 'vc-cursor' }, this.svg);
			this.bandHover = s('rect', { class: 'vc-band-hover', x: 0, y: 0, width: 0, height: 0, rx: 4 }, this.cursorLayer);
			this.crosshair = s('line', { class: 'vc-crosshair', x1: 0, x2: 0, y1: 0, y2: 0 }, this.cursorLayer);
			this.halo = s('circle', { class: 'vc-knob-halo', r: 9 }, this.cursorLayer);
			this.knob = s('circle', { class: 'vc-knob', r: 4.5 }, this.cursorLayer);
			this.hit = s('rect', { class: 'vc-hit' }, this.svg);
			this.tip = new Tip(this.plot);
			this.pill = new AxisPill(this.plot);
			this.live = h('div', 'vc-sr', this.plot);
			this.live.setAttribute('aria-live', 'polite');
			this.noteEl = h('div', 'vc-note');
			this.springs = new Springs(() => this.applyCursor());
			this.wire();
			this.setSpec(spec, problems, where);
		}

		setSpec(spec: Record<string, unknown>, problems: string[], where: string): void {
			const previous = this.model;
			this.model = { ...parseCartesian(spec, problems, where), tooltip: this.tooltip };
			if (!previous || previous.metrics.length !== this.model.metrics.length) {
				this.metricIndex = 0;
			} else {
				this.metricIndex = Math.min(this.metricIndex, this.model.metrics.length - 1);
			}
			this.range = previous && this.model.ranges.includes(this.range) ? this.range : this.model.range;
			this.hidden = new Set(this.model.metrics.flatMap(metric => metric.series.filter(series => series.hidden).map(series => series.key)));
			this.buildChrome();
			if (this.width) {
				this.draw(previous ? 'tween' : 'enter');
			}
		}

		private get metric(): ICMetric {
			return this.model.metrics[this.metricIndex] ?? this.model.metrics[0];
		}

		private get stacked(): boolean {
			const type = this.model.type;
			return type === 'stacked-area' || type === 'stacked-bar' || type === 'share';
		}

		private get bars(): boolean {
			const type = this.model.type;
			return type === 'bar' || type === 'stacked-bar' || type === 'grouped-bar';
		}

		/** Title, metric header, switchers and legend: rebuilt when the spec or metric changes. */
		private buildChrome(): void {
			const model = this.model;
			this.element.replaceChildren();
			blockHead(this.element, model.title, model.subtitle);
			this.top.replaceChildren();
			this.element.appendChild(this.top);
			this.header?.dispose();
			this.header = undefined;
			if (this.metric.headline) {
				this.header = new MetricHeader(this.top);
			}
			const controls = h('div', 'vc-controls');
			if (model.metrics.length > 1) {
				this.metricControl = segmented(controls, 'Metric', model.metrics.map((metric, index) => ({ id: String(index), label: metric.label })), String(this.metricIndex), id => this.selectMetric(Number(id)));
			} else {
				this.metricControl = undefined;
			}
			if (model.ranges.length) {
				this.rangeControl = segmented(controls, 'Range', model.ranges.map(key => ({ id: key, label: key === 'ALL' ? this.ctx.strings.all : key })), this.range, id => this.selectRange(id));
			} else {
				this.rangeControl = undefined;
			}
			if (controls.childElementCount) {
				this.top.appendChild(controls);
			}
			this.element.appendChild(this.legendHost);
			this.buildLegend();
			this.element.appendChild(this.plot);
			this.noteEl.textContent = model.note ?? '';
			if (model.note) {
				this.element.appendChild(this.noteEl);
			}
			this.plot.setAttribute('aria-label', this.describe());
		}

		private buildLegend(): void {
			this.legendHost.replaceChildren();
			this.legend = undefined;
			const series = this.metric.series;
			const show = this.model.legend ?? series.length > 1;
			if (!show || !series.length) {
				return;
			}
			this.legend = new Legend(this.legendHost, series.map(item => ({ key: item.key, name: item.name, color: item.color, dashed: item.dashed })), {
				hover: key => this.setFocus(key),
				toggle: key => this.toggle(key),
			});
			this.legend.setHidden(this.hidden);
		}

		private describe(): string {
			const model = this.model;
			const metric = this.metric;
			const kind = model.type === 'share' ? 'share chart' : this.bars ? 'bar chart' : model.type === 'scatter' ? 'scatter chart' : model.type.includes('area') ? 'area chart' : 'line chart';
			const names = metric.series.map(series => series.name).join(', ');
			return `${model.title ?? metric.label ?? this.ctx.strings.chart}. ${kind}${names ? `: ${names}` : ''}. Use arrow keys to read values.`;
		}

		private selectMetric(index: number): void {
			if (index === this.metricIndex) {
				return;
			}
			const before = this.metric.series.map(series => series.name).join('\u0000');
			this.metricIndex = index;
			const sameSeries = before === this.metric.series.map(series => series.name).join('\u0000');
			if (!sameSeries) {
				this.buildLegend();
			}
			if (this.metric.headline && !this.header) {
				this.buildChrome();
			}
			this.draw('tween');
		}

		private selectRange(range: string): void {
			this.range = range;
			this.draw('tween');
		}

		private setFocus(key: string | undefined): void {
			this.focusKey = key && !this.hidden.has(key) ? key : undefined;
			this.svg.classList.toggle('vc-dim', !!this.focusKey);
			for (const [nodeKey, node] of this.nodes) {
				node.group.classList.toggle('vc-on', nodeKey === this.focusKey);
			}
			if (this.cursorShown && this.focusKey) {
				this.primaryKey = this.focusKey;
				this.moveCursor(this.cursorIndex, false);
			}
		}

		private toggle(key: string): void {
			const visible = this.metric.series.filter(series => !series.reference && !this.hidden.has(series.key));
			if (!this.hidden.has(key) && visible.length <= 1 && visible[0]?.key === key) {
				return;
			}
			if (this.hidden.has(key)) {
				this.hidden.delete(key);
			} else {
				this.hidden.add(key);
			}
			this.legend?.setHidden(this.hidden);
			if (this.focusKey === key) {
				this.setFocus(undefined);
			}
			this.draw('tween');
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			const first = !this.width;
			this.width = width;
			this.metricControl?.refresh();
			this.rangeControl?.refresh();
			this.draw(first ? 'enter' : 'none');
		}

		setLoading(loading: boolean): void {
			this.loading = loading;
			this.element.classList.toggle('vc-loading', loading);
			if (this.width) {
				this.draw('none');
			}
		}

		//#region Frames

		private rangeBounds(): { lo: number; hi: number; length: number } | undefined {
			if (this.range === 'ALL' || this.model.xKind !== 'time') {
				return undefined;
			}
			const length = RANGE_LENGTHS[this.range];
			let max = -Infinity;
			for (const series of this.metric.series) {
				const last = series.points[series.points.length - 1];
				if (last && last.x > max) {
					max = last.x;
				}
			}
			return Number.isFinite(max) ? { lo: max - length + 1, hi: max, length } : undefined;
		}

		/** The data to draw: in range, stacked or normalized, with the y scale it needs. */
		private buildFrame(plotHeight: number): IFrame & { ticks: INiceScale } {
			const model = this.model;
			const metric = this.metric;
			const bounds = this.rangeBounds();
			const inRange = (x: number) => !bounds || (x >= bounds.lo && x <= bounds.hi);
			const stacked = this.stacked;
			const list = metric.series;
			let frames: IFrameSeries[];
			if (stacked || this.bars) {
				const xsSet = new Set<number>();
				for (const series of list) {
					for (const point of series.points) {
						if (inRange(point.x)) {
							xsSet.add(point.x);
						}
					}
				}
				const xs = [...xsSet].sort((a, b) => a - b);
				const index = new Map(xs.map((x, at) => [x, at]));
				const base = xs.map(() => 0);
				const negBase = xs.map(() => 0);
				const totals = xs.map(() => 0);
				const values = list.map(series => {
					const row = xs.map(() => Number.NaN);
					const points: (ICPoint | undefined)[] = xs.map(() => undefined);
					for (const point of series.points) {
						const at = index.get(point.x);
						if (at !== undefined) {
							row[at] = Number.isFinite(row[at]) ? row[at] + (Number.isFinite(point.y) ? point.y : 0) : point.y;
							points[at] = point;
						}
					}
					return { row, points };
				});
				if (model.type === 'share') {
					list.forEach((series, at) => {
						if (!this.hidden.has(series.key) && !series.reference) {
							values[at].row.forEach((value, k) => totals[k] += Number.isFinite(value) ? Math.max(0, value) : 0);
						}
					});
				}
				frames = list.map((series, at) => {
					const visible = !this.hidden.has(series.key);
					const { row, points } = values[at];
					if (!stacked || series.reference) {
						return { source: series, visible, xs, top: row, bot: xs.map(() => 0), raw: row, points, gap: 0 };
					}
					const top: number[] = [];
					const bot: number[] = [];
					const raw: number[] = [];
					row.forEach((value, k) => {
						let v = Number.isFinite(value) ? value : 0;
						if (model.type === 'share') {
							// Nothing to share out on an empty day: a gap, not every band dropping to 0% and back.
							if (!(totals[k] > 0)) {
								bot.push(Number.NaN);
								top.push(Number.NaN);
								raw.push(Number.NaN);
								return;
							}
							v = (Math.max(0, v) / totals[k]) * 100;
						}
						if (!visible) {
							v = 0;
						}
						const from = v >= 0 ? base[k] : negBase[k];
						bot.push(from);
						top.push(from + v);
						raw.push(model.type === 'share' ? v : value);
						if (v >= 0) {
							base[k] += v;
						} else {
							negBase[k] += v;
						}
					});
					return { source: series, visible, xs, top, bot, raw, points, gap: 0 };
				});
			} else {
				frames = list.map(series => {
					const points = series.points.filter(point => inRange(point.x));
					const xs = points.map(point => point.x);
					const ys = points.map(point => point.y);
					return { source: series, visible: !this.hidden.has(series.key), xs, top: ys, bot: xs.map(() => 0), raw: ys, points, gap: 0 };
				});
			}

			// The y scale: visible series, rules and callouts; zero when the chart type needs it.
			let min = Infinity;
			let max = -Infinity;
			const domainSet = new Set<number>();
			for (const frame of frames) {
				if (!frame.visible) {
					continue;
				}
				frame.xs.forEach((x, at) => {
					const top = frame.top[at];
					const bot = frame.bot[at];
					if (Number.isFinite(top)) {
						domainSet.add(x);
						min = Math.min(min, top, stacked ? bot : top);
						max = Math.max(max, top, stacked ? bot : top);
					}
				});
			}
			const empty = !Number.isFinite(min);
			for (const rule of model.rules) {
				min = Math.min(min, rule.y);
				max = Math.max(max, rule.y);
			}
			for (const callout of model.callouts) {
				min = Math.min(min, callout.y);
				max = Math.max(max, callout.y);
			}
			if (!Number.isFinite(min)) {
				min = 0;
				max = 1;
			}
			const zero = model.yZero ?? (this.bars || stacked || model.type === 'area' || model.type === 'stacked-area' || max === min || (min >= 0 && (max - min) > 0.45 * max) || (max <= 0 && (max - min) > 0.45 * -min));
			if (zero) {
				min = Math.min(min, 0);
				max = Math.max(max, 0);
			}
			const count = clamp(Math.round(plotHeight / 42), 2, 6);
			const integer = metric.unit.kind === 'count' || metric.unit.kind === 'tokens';
			const share = model.type === 'share';
			const ticks = share
				? niceScale(0, 100, count >= 4 ? 4 : 2, false, 0, 100)
				: niceScale(model.yMin ?? min, model.yMax ?? max, count, integer, model.yMin, model.yMax);
			const domain = [...domainSet].sort((a, b) => a - b);
			frames = frames.map(frame => ({ ...frame, gap: medianGap(frame.xs) }));
			const allXs = frames.flatMap(frame => frame.xs);
			let x0 = Infinity;
			let x1 = -Infinity;
			for (const x of allXs) {
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
			}
			if (model.xKind === 'category') {
				x0 = 0;
				x1 = Math.max(0, model.categories.length - 1);
			}
			if (!Number.isFinite(x0)) {
				x0 = 0;
				x1 = 1;
			}
			return { series: frames, domain, lo: ticks.lo, hi: ticks.hi, x0, x1, unit: metric.unit, empty, ticks };
		}

		/** Same series and the same x positions: the old frame can morph into the new one. */
		private compatible(a: IFrame | undefined, b: IFrame): a is IFrame {
			if (!a || a.series.length !== b.series.length || a.empty || b.empty) {
				return false;
			}
			return a.series.every((series, index) => {
				const other = b.series[index];
				return series.source.key.split(':').slice(1).join(':') === other.source.key.split(':').slice(1).join(':')
					&& series.xs.length === other.xs.length
					&& series.xs.every((x, at) => x === other.xs[at]);
			}) && a.x0 === b.x0 && a.x1 === b.x1;
		}

		private interpolate(a: IFrame, b: IFrame, t: number): IFrame {
			const mix = (from: readonly number[], to: readonly number[]) => to.map((value, index) => {
				const start = from[index];
				return Number.isFinite(value) && Number.isFinite(start) ? lerp(start, value, t) : value;
			});
			return {
				...b,
				series: b.series.map((series, index) => ({ ...series, top: mix(a.series[index].top, series.top), bot: mix(a.series[index].bot, series.bot) })),
				lo: lerp(a.lo, b.lo, t),
				hi: lerp(a.hi, b.hi, t),
			};
		}

		/** Everything at the baseline: what bars and stacks grow from on first draw. */
		private flatten(frame: IFrame): IFrame {
			const base = frame.lo <= 0 && frame.hi >= 0 ? 0 : frame.lo;
			return { ...frame, series: frame.series.map(series => ({ ...series, top: series.top.map(value => Number.isFinite(value) ? base : value), bot: series.bot.map(value => Number.isFinite(value) ? base : value) })) };
		}

		//#endregion

		//#region Drawing

		private draw(mode: 'none' | 'enter' | 'tween'): void {
			if (!this.width) {
				return;
			}
			this.animation?.cancel();
			this.animation = undefined;
			const model = this.model;
			const narrow = this.width < 420;
			const height = narrow ? Math.max(150, Math.round(model.height * 0.82)) : model.height;
			this.plot.style.height = `${height}px`;
			setAttrs(this.svg, { width: this.width, height, viewBox: `0 0 ${this.width} ${height}` });
			this.renderEmpty(false);
			if (this.loading) {
				this.renderSkeleton(height);
				return;
			}

			const top = model.annotations.length ? 24 : 10;
			const bottom = 24;
			const frame = this.buildFrame(height - top - bottom);
			const box = this.computeBox(frame, height, top, bottom);
			this.box = box;
			this.applyLook(box);
			const sx = this.xScale(frame, box);
			this.sx = sx;
			this.drawXAxis(frame, box, sx);
			this.setHeadline(mode !== 'none' && this.drawn);
			this.hit.setAttribute('class', 'vc-hit');
			setAttrs(this.hit, { x: box.left - 6, y: 0, width: Math.max(0, box.right - box.left + 12), height });

			const previous = this.shown;
			const morph = mode === 'tween' && this.compatible(previous, frame);
			const fade = mode === 'tween' && !morph && this.drawn;
			if (fade) {
				this.ghost();
			}
			const rebuild = !morph;
			if (rebuild) {
				this.buildSeriesNodes(frame);
			}
			this.planDownsampling(frame, box, sx);
			this.hideCursor();

			const finish = () => {
				this.shown = frame;
				this.renderStatic(frame, box, sx);
			};
			if (frame.empty) {
				for (const group of this.ticks.values()) {
					group.remove();
				}
				this.ticks.clear();
				this.xAxisLayer.replaceChildren();
				this.sy = linearScale(frame.lo, frame.hi, box.bottom, box.top);
				this.shown = frame;
				this.marksBack.replaceChildren();
				this.marksFront.replaceChildren();
				this.renderEmpty(true);
				this.drawn = true;
				return;
			}
			const enterGrow = mode === 'enter' && this.ctx.animate && (this.bars || this.stacked);
			const enterDraw = mode === 'enter' && this.ctx.animate && !enterGrow;
			this.marksBack.replaceChildren();
			this.marksFront.replaceChildren();
			if (morph || enterGrow) {
				const from = morph ? previous! : this.flatten(frame);
				this.renderFrame(from, box, sx, frame.ticks, true);
				this.animation = tween(TWEEN_MS + (enterGrow ? 80 : 0), t => {
					this.renderFrame(this.interpolate(from, frame, t), box, sx, frame.ticks, false);
				}, finish);
			} else {
				this.renderFrame(frame, box, sx, frame.ticks, false);
				if (enterDraw && !reducedMotion()) {
					this.playDraw();
				}
				if (fade) {
					this.seriesLayer.classList.remove('vc-fade-in');
					void this.seriesLayer.getBoundingClientRect();
					this.seriesLayer.classList.add('vc-fade-in');
				}
				finish();
			}
			this.drawn = true;
		}

		private computeBox(frame: IFrame & { ticks: INiceScale }, height: number, top: number, bottom: number): IBox {
			const width = this.width;
			const compactAxis = this.compactAxis();
			const font = axisFont(this.element);
			let labelWidth = 0;
			for (const value of frame.ticks.values) {
				labelWidth = Math.max(labelWidth, textWidth(formatTick(value, frame.ticks.step, frame.unit), font));
			}
			const left = compactAxis ? 0 : Math.ceil(labelWidth) + 16;
			let right = this.bars ? 2 : 6;
			const endLabels = this.endLabelsWanted();
			if (endLabels) {
				right = Math.ceil(Math.min(width * 0.3, this.endLabelWidth(frame) + 14));
			}
			return { width, height, left, right: Math.max(left + 20, width - right), top, bottom: height - bottom };
		}

		private endLabelsWanted(): boolean {
			const visible = this.metric.series.filter(series => !this.hidden.has(series.key));
			if (this.width < 560 || visible.length < 2 || visible.length > 8 || this.model.type === 'scatter' || this.bars) {
				return false;
			}
			return this.model.endLabels ?? (this.model.type === 'share' || this.model.type === 'stacked-area');
		}

		private endLabelWidth(frame: IFrame): number {
			const font = `500 12px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			let max = 0;
			for (const series of frame.series) {
				if (series.visible) {
					max = Math.max(max, textWidth(`${series.source.name} ${this.endValue(series)}`, font));
				}
			}
			return max;
		}

		private endValue(series: IFrameSeries): string {
			for (let index = series.raw.length - 1; index >= 0; index--) {
				if (Number.isFinite(series.raw[index])) {
					const value = series.raw[index];
					return this.model.type === 'share' ? `${Math.round(value)}%` : formatValue(value, series.source.unit);
				}
			}
			return '';
		}

		private xScale(frame: IFrame, box: IBox): IScale {
			let x0 = frame.x0;
			let x1 = frame.x1;
			if (this.bars || this.model.xKind === 'category' && this.bars) {
				const gap = this.typicalGap(frame);
				x0 -= gap / 2;
				x1 += gap / 2;
			} else if (x0 === x1) {
				x0 -= 1;
				x1 += 1;
			}
			return linearScale(x0, x1, box.left, box.right);
		}

		private typicalGap(frame: IFrame): number {
			if (this.model.xKind === 'category') {
				return 1;
			}
			const xs = frame.domain.length > 1 ? frame.domain : frame.series[0]?.xs ?? [];
			let gap = Infinity;
			for (let index = 1; index < xs.length; index++) {
				const step = xs[index] - xs[index - 1];
				if (step > 0) {
					gap = Math.min(gap, step);
				}
			}
			if (Number.isFinite(gap)) {
				return gap;
			}
			return this.model.xKind === 'time' ? ({ minute: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY })[this.model.grain] : 1;
		}

		private drawXAxis(frame: IFrame, box: IBox, sx: IScale): void {
			this.xAxisLayer.replaceChildren();
			const model = this.model;
			const category = model.xKind === 'category';
			const font = category ? `400 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}` : axisFont(this.element);
			let ticks: ITick[] = [];
			const plotWidth = box.right - box.left;
			const lo = sx.inv(box.left);
			const hi = sx.inv(box.right);
			if (model.xKind === 'time') {
				ticks = timeTicks(Math.max(lo, frame.x0 - (this.bars ? this.typicalGap(frame) / 2 : 0)), Math.min(hi, frame.x1 + (this.bars ? this.typicalGap(frame) / 2 : 0)), Math.max(2, Math.floor(plotWidth / 76)), model.zone);
			} else if (model.xKind === 'category') {
				const labels = model.categories;
				let widest = 0;
				for (const label of labels) {
					widest = Math.max(widest, textWidth(label, font));
				}
				const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / (widest + 14)))));
				for (let index = 0; index < labels.length; index += every) {
					ticks.push({ value: index, label: labels[index] });
				}
			} else {
				const scale = niceScale(frame.x0, frame.x1, Math.max(2, Math.floor(plotWidth / 90)), false);
				ticks = scale.values.filter(value => value >= frame.x0 && value <= frame.x1).map(value => ({ value, label: formatTick(value, scale.step, model.xUnit) }));
			}
			let lastEnd = -Infinity;
			const y = box.bottom + 18;
			for (const tick of ticks) {
				const x = sx(tick.value);
				if (x < box.left - 1 || x > box.right + 1) {
					continue;
				}
				const width = textWidth(tick.label, font);
				let anchor = 'middle';
				let start = x - width / 2;
				if (start < 0) {
					anchor = 'start';
					start = Math.max(0, box.left - 2);
				} else if (x + width / 2 > box.width) {
					anchor = 'end';
					start = box.width - width;
				}
				if (start < lastEnd + 12) {
					continue;
				}
				lastEnd = start + width;
				const text = s('text', { x: anchor === 'start' ? start : anchor === 'end' ? box.width : x, y, 'text-anchor': anchor, class: category ? 'vc-cat' : undefined }, this.xAxisLayer);
				text.textContent = tick.label;
				text.dataset.cx = String(x);
			}
		}

		private buildSeriesNodes(frame: IFrame): void {
			this.seriesLayer.replaceChildren();
			this.defs.replaceChildren();
			this.nodes.clear();
			this.knobs.forEach(knob => knob.remove());
			this.knobs.clear();
			const type = this.model.type;
			const visibleCount = frame.series.filter(series => series.visible && !series.source.reference).length;
			// Hatched stacks: each band is a see-through tint under diagonal lines, edged on top in its color.
			const hatchedStack = this.stacked && this.model.look.fill === 'pattern';
			frame.series.forEach((series, index) => {
				const source = series.source;
				const group = s('g', { class: 'vc-s' }, this.seriesLayer);
				group.classList.toggle('vc-on', source.key === this.focusKey);
				group.style.opacity = series.visible ? '' : '0';
				const nodes: ISeriesNodes = { group };
				if (this.bars && !source.reference) {
					nodes.bars = s('path', { class: 'vc-bar' }, group);
					const fill = this.model.look.fill;
					nodes.bars.style.fill = fill === 'pattern' ? pattern(this.defs, 'lines', source.color, { tint: 0.16, ink: 0.85 })
						: fill === 'gradient' ? verticalGradient(this.defs, source.color, source.color, 1, 0.32) : source.color;
				} else if (type === 'scatter') {
					nodes.dots = s('g', {}, group);
				} else {
					if (this.stacked && !source.reference) {
						nodes.area = s('path', { class: `vc-band${hatchedStack ? ' vc-band-hatched' : ''}` }, group);
						if (hatchedStack) {
							nodes.area.style.fill = pattern(this.defs, 'lines', source.color, { angle: [45, 135, 45, 135][index % 4], tint: 0.1, ink: 0.55 });
						} else {
							nodes.area.style.fill = source.color;
							nodes.area.style.fillOpacity = '0.9';
						}
					} else if (this.areaFill(visibleCount) !== 'none' && this.areaFill(visibleCount) !== 'gradient' && !source.reference) {
						const fill = this.areaFill(visibleCount);
						nodes.area = s('path', { class: 'vc-area' }, group);
						nodes.area.style.fill = fill === 'pattern' ? pattern(this.defs, 'lines', source.color, { tint: 0.05, ink: 0.45 }) : source.color;
						if (fill === 'solid') {
							nodes.area.style.fillOpacity = type === 'area' ? '0.3' : '0.18';
						}
					} else if (this.areaFill(visibleCount) === 'gradient' && !source.reference) {
						const id = nextId('fill');
						const gradient = s('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, this.defs);
						const strength = type === 'area' ? (index === 0 ? 0.26 : 0.14) : 0.16;
						const a = s('stop', { offset: '0%' }, gradient);
						a.style.stopColor = source.color;
						a.style.stopOpacity = String(strength);
						const b = s('stop', { offset: '100%' }, gradient);
						b.style.stopColor = source.color;
						b.style.stopOpacity = '0';
						nodes.area = s('path', { class: 'vc-area', fill: `url(#${id})` }, group);
						nodes.gradient = id;
					}
					if (!this.stacked || source.reference || hatchedStack) {
						nodes.line = s('path', { class: `vc-line${source.reference && !source.overlay ? ' vc-ref' : source.dashed ? ' vc-dashed' : ''}` }, group);
						nodes.line.style.stroke = source.color;
						nodes.line.classList.toggle('vc-nostroke', !this.model.look.stroke && !!nodes.area);
					}
					nodes.dots = s('g', {}, group);
				}
				this.nodes.set(source.key, nodes);
				if (type !== 'scatter' && !this.bars) {
					const knob = s('circle', { class: 'vc-knob', r: 3.25 }, this.cursorLayer);
					knob.style.fill = source.color;
					this.knobs.set(source.key, knob);
				}
			});
			// Hatched bands do not overlap, but their top lines do where a band is near zero (output
			// over cache reads). Lower series draw last, so the big band keeps its own edge color.
			if (hatchedStack) {
				for (const group of [...this.seriesLayer.children].reverse()) {
					this.seriesLayer.appendChild(group);
				}
			}
			// The primary knob draws over the others.
			this.cursorLayer.appendChild(this.halo);
			this.cursorLayer.appendChild(this.knob);
		}

		/** Which points each series draws: all of them, or M4-picked ones when they outnumber the pixels. */
		private planDownsampling(frame: IFrame, box: IBox, sx: IScale): void {
			const columns = Math.max(1, box.right - box.left);
			frame.series.forEach(series => {
				const nodes = this.nodes.get(series.source.key);
				if (!nodes) {
					return;
				}
				nodes.keep = series.xs.length > columns * 2 && !this.bars ? m4(series.xs.map(x => sx(x)), series.top) : undefined;
			});
		}

		/** Geometry for one frame (a tween calls this every animation frame). */
		private renderFrame(frame: IFrame, box: IBox, sx: IScale, ticks: INiceScale, enteringTicks: boolean): void {
			const sy = linearScale(frame.lo, frame.hi, box.bottom, box.top);
			this.sy = sy;
			this.renderTicks(ticks, sy, box, enteringTicks);
			const type = this.model.type;
			const curve = this.model.curve;
			const baseline = sy(frame.lo <= 0 && frame.hi >= 0 ? 0 : frame.lo);
			const visibleBars = frame.series.filter(series => series.visible && !series.source.reference);
			const gap = this.typicalGap(frame);
			const slot = Math.abs(sx(gap) - sx(0));
			const look = this.model.look;
			const groupWidth = look.barGap !== undefined ? slot * (1 - look.barGap) : Math.min(slot * (type === 'grouped-bar' ? 0.8 : 0.72), type === 'grouped-bar' ? 96 : 56);
			const barWidth = type === 'grouped-bar' ? groupWidth / Math.max(1, visibleBars.length) : groupWidth;
			const radius = look.barShape === 'square' ? 0 : look.barShape === 'pill' ? barWidth / 2 : Math.min(3, barWidth / 3);
			for (const series of frame.series) {
				const nodes = this.nodes.get(series.source.key);
				if (!nodes) {
					continue;
				}
				nodes.group.style.opacity = series.visible ? '' : '0';
				const indices = nodes.keep;
				const pick = <T,>(values: readonly T[]): T[] => indices ? indices.map(index => values[index]) : values.slice();
				const xs = pick(series.xs);
				const tops = pick(series.top);
				const bots = pick(series.bot);
				const topPts: Pt[] = xs.map((x, index) => [sx(x), Number.isFinite(tops[index]) ? sy(tops[index]) : Number.NaN]);
				const effectiveCurve: Curve = indices || xs.length > (box.right - box.left) / 2 ? 'linear' : curve;
				if (nodes.bars) {
					const order = visibleBars.indexOf(series);
					let d = '';
					xs.forEach((x, index) => {
						const value = tops[index];
						if (!Number.isFinite(value)) {
							return;
						}
						const center = sx(x);
						const left = type === 'grouped-bar' ? center - groupWidth / 2 + Math.max(0, order) * barWidth + 0.5 : center - barWidth / 2;
						const y0 = this.stacked ? sy(bots[index]) : baseline;
						d += barPath(left, y0, sy(value), type === 'grouped-bar' ? barWidth - 1 : barWidth, this.stacked && !this.isTopOfStack(frame, series, index) ? 0 : radius);
					});
					nodes.bars.setAttribute('d', d);
				}
				if (nodes.area) {
					const botPts: Pt[] = this.stacked
						? xs.map((x, index) => [sx(x), Number.isFinite(bots[index]) ? sy(bots[index]) : Number.NaN])
						: xs.map((x, index) => [sx(x), Number.isFinite(tops[index]) ? baseline : Number.NaN]);
					nodes.area.setAttribute('d', areaPath(topPts, botPts, effectiveCurve));
				}
				if (nodes.line) {
					nodes.line.setAttribute('d', runs(topPts).map(run => curvePath(run, effectiveCurve, true)).join(''));
				}
				if (nodes.dots) {
					this.renderDots(nodes.dots, series, topPts, box, type === 'scatter');
				}
			}
		}

		private isTopOfStack(frame: IFrame, series: IFrameSeries, index: number): boolean {
			const position = frame.series.indexOf(series);
			for (let next = position + 1; next < frame.series.length; next++) {
				const other = frame.series[next];
				if (other.visible && !other.source.reference && Math.abs(other.top[index] - other.bot[index]) > 1e-9) {
					return false;
				}
			}
			return true;
		}

		private renderDots(layer: SVGGElement, series: IFrameSeries, points: readonly Pt[], box: IBox, scatter: boolean): void {
			const show = scatter || this.model.points === true || (this.model.points !== false && points.length > 0 && (points.length <= Math.max(1, Math.min(14, (box.right - box.left) / 30)) || points.filter(point => Number.isFinite(point[1])).length === 1));
			if (!show) {
				if (layer.firstChild) {
					layer.replaceChildren();
				}
				return;
			}
			let sizeMax = 0;
			if (scatter) {
				for (const point of series.points) {
					sizeMax = Math.max(sizeMax, point?.size ?? 0);
				}
			}
			const circles = layer.children;
			const single = points.filter(point => Number.isFinite(point[1])).length === 1;
			let used = 0;
			points.forEach((point, index) => {
				if (!Number.isFinite(point[1])) {
					return;
				}
				let circle = circles[used] as SVGCircleElement | undefined;
				if (!circle) {
					circle = s('circle', { class: scatter ? 'vc-scatter' : 'vc-dot' }, layer);
					circle.style.fill = series.source.color;
				}
				const size = scatter ? series.points[index]?.size : undefined;
				const r = scatter ? (sizeMax > 0 && isNum(size) ? 2.5 + 9 * Math.sqrt(Math.max(0, size) / sizeMax) : 3.5) : single ? 4 : 2.75;
				setAttrs(circle, { cx: point[0], cy: point[1], r });
				used++;
			});
			while (circles.length > used) {
				circles[circles.length - 1].remove();
			}
		}

		/** Y gridlines and labels, keyed by value so a rescale slides them instead of redrawing. */
		private renderTicks(ticks: INiceScale, sy: IScale, box: IBox, entering: boolean): void {
			const compactAxis = this.compactAxis();
			const unit = this.metric.unit;
			const keep = new Set(ticks.values);
			for (const [value, group] of this.ticks) {
				if (!keep.has(value)) {
					if (!group.dataset.leaving) {
						group.dataset.leaving = '1';
						group.style.opacity = '0';
						win.setTimeout(() => {
							if (group.dataset.leaving) {
								group.remove();
								if (this.ticks.get(value) === group) {
									this.ticks.delete(value);
								}
							}
						}, TWEEN_MS);
					}
					const y = sy(value);
					group.setAttribute('transform', `translate(0,${num(crisp(y))})`);
				}
			}
			for (const value of ticks.values) {
				let group = this.ticks.get(value);
				const y = crisp(sy(value));
				const label = formatTick(value, ticks.step, unit);
				if (!group) {
					group = s('g', { class: 'vc-tick' }, this.gridLayer);
					s('line', {}, group);
					s('text', {}, group);
					this.ticks.set(value, group);
					if (entering || (this.drawn && this.animation)) {
						group.style.opacity = '0';
						void group.getBoundingClientRect();
						group.style.opacity = '';
					}
				}
				delete group.dataset.leaving;
				group.style.opacity = '';
				group.setAttribute('transform', `translate(0,${num(y)})`);
				const line = group.firstChild as SVGLineElement;
				setAttrs(line, { x1: box.left, x2: box.right, y1: 0, y2: 0 });
				line.classList.toggle('vc-zero', value === 0);
				const text = group.lastChild as SVGTextElement;
				if (text.textContent !== label) {
					text.textContent = label;
				}
				// Inside a small plot the baseline is plain enough; its "0" would sit on the first bar.
				text.style.display = compactAxis && value === 0 && ticks.values.length > 2 ? 'none' : '';
				if (compactAxis) {
					setAttrs(text, { x: box.left, y: -5, 'text-anchor': 'start', 'dominant-baseline': 'auto' });
				} else {
					setAttrs(text, { x: 0, y: 0, 'text-anchor': 'start', 'dominant-baseline': 'central' });
				}
			}
		}

		private playDraw(): void {
			const box = this.box;
			if (!box) {
				return;
			}
			// One clip grows across the plot, so lines, fills and dots arrive left to right together.
			const id = nextId('rv');
			const clip = s('clipPath', { id }, this.defs);
			const rect = s('rect', { x: box.left - 8, y: 0, width: 0, height: box.height }, clip);
			this.seriesLayer.setAttribute('clip-path', `url(#${id})`);
			const done = () => {
				if (this.seriesLayer.getAttribute('clip-path') === `url(#${id})`) {
					this.seriesLayer.removeAttribute('clip-path');
				}
				clip.remove();
			};
			const animation = rect.animate([{ width: '0px' }, { width: `${num(box.right - box.left + 16)}px` }], { duration: DRAW_MS * 2, easing: ENTER_CSS, fill: 'forwards' });
			animation.onfinish = done;
			animation.oncancel = done;
			this.marksFront.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 650, fill: 'backwards' });
		}

		private ghost(): void {
			const copy = this.seriesLayer.cloneNode(true) as SVGGElement;
			copy.removeAttribute('class');
			copy.style.pointerEvents = 'none';
			this.svg.insertBefore(copy, this.marksFront);
			const animation = copy.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
			if (animation) {
				animation.onfinish = () => copy.remove();
			} else {
				copy.remove();
			}
		}

		/** Annotations, rules, callouts, end labels and highlights: drawn once the geometry settles. */
		private renderStatic(frame: IFrame, box: IBox, sx: IScale): void {
			const sy = linearScale(frame.lo, frame.hi, box.bottom, box.top);
			this.sy = sy;
			const back = this.marksBack;
			const front = this.marksFront;
			back.replaceChildren();
			front.replaceChildren();
			drawBands(back, this.model.look.bands, box, sy, this.metric.unit);
			const font = `600 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			for (const rule of this.model.rules) {
				const y = crisp(sy(rule.y));
				const group = s('g', { class: 'vc-rule' }, back);
				s('line', { x1: box.left, x2: box.right, y1: y, y2: y }, group);
				if (rule.label) {
					const text = s('text', { x: box.right, y: y - 5, 'text-anchor': 'end' }, group);
					text.textContent = rule.label;
				}
			}
			for (const annotation of this.model.annotations) {
				const x = sx(annotation.x);
				if (x < box.left - 0.5 || x > box.right + 0.5) {
					continue;
				}
				const group = s('g', { class: 'vc-anno' }, front);
				const lineX = crisp(x);
				s('line', { x1: lineX, x2: lineX, y1: box.top - 4, y2: box.bottom }, group);
				if (annotation.label) {
					const width = textWidth(annotation.label, font);
					const onLeft = x + 6 + width > box.width;
					const text = s('text', { x: onLeft ? x - 6 : x + 6, y: box.top - 8, 'text-anchor': onLeft ? 'end' : 'start' }, group);
					text.textContent = annotation.label;
				}
			}
			for (const callout of this.model.callouts) {
				const x = sx(callout.x);
				const y = sy(callout.y);
				const group = s('g', { class: 'vc-callout' }, front);
				const circle = s('circle', { cx: x, cy: y, r: 3.5 }, group);
				circle.style.fill = this.metric.series[0]?.color ?? 'var(--vc-accent)';
				const width = textWidth(callout.label, font);
				const onLeft = x + 10 + width > box.right;
				const text = s('text', { x: onLeft ? x - 10 : x + 10, y: clamp(y + 18, box.top + 10, box.bottom - 4), 'text-anchor': onLeft ? 'end' : 'start' }, group);
				text.textContent = callout.label;
			}
			this.renderHighlight(frame, box, sx, sy, front, font);
			if (this.endLabelsWanted()) {
				this.renderEndLabels(frame, box, sy, front);
			}
		}

		private renderHighlight(frame: IFrame, box: IBox, sx: IScale, sy: IScale, layer: SVGGElement, font: string): void {
			const kind = this.model.highlight;
			if (kind === 'none') {
				return;
			}
			const series = frame.series.find(item => item.visible && !item.source.reference);
			if (!series) {
				return;
			}
			let at = -1;
			series.top.forEach((value, index) => {
				if (!Number.isFinite(value)) {
					return;
				}
				if (at < 0 || kind === 'last' || (kind === 'max' && value > series.top[at]) || (kind === 'min' && value < series.top[at])) {
					at = index;
				}
			});
			if (at < 0) {
				return;
			}
			const x = sx(series.xs[at]);
			const y = sy(series.top[at]);
			const group = s('g', { class: 'vc-mark' }, layer);
			const circle = s('circle', { cx: x, cy: y, r: 3.5 }, group);
			circle.style.fill = series.source.color;
			const label = `${kind === 'max' ? 'Peak ' : kind === 'min' ? 'Low ' : ''}${formatValue(series.raw[at], series.source.unit)}`;
			const width = textWidth(label, font);
			const below = kind === 'min' || y - 12 < box.top;
			const text = s('text', { x: clamp(x, box.left + width / 2, box.right - width / 2), y: below ? y + 18 : y - 10, 'text-anchor': 'middle' }, group);
			text.textContent = label;
		}

		private renderEndLabels(frame: IFrame, box: IBox, sy: IScale, layer: SVGGElement): void {
			const group = s('g', { class: 'vc-end' }, layer);
			const font = `500 12px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			const items: { y: number; name: string; value: string; color: string }[] = [];
			for (const series of frame.series) {
				if (!series.visible || series.source.reference) {
					continue;
				}
				let at = series.top.length - 1;
				while (at >= 0 && !Number.isFinite(series.top[at])) {
					at--;
				}
				if (at < 0) {
					continue;
				}
				// A band too thin to see gets no label; it would only crowd the ones that matter.
				if (this.stacked && Math.abs(sy(series.top[at]) - sy(series.bot[at])) < 3) {
					continue;
				}
				const y = this.stacked ? sy((series.top[at] + series.bot[at]) / 2) : sy(series.top[at]);
				items.push({ y, name: series.source.name, value: this.endValue(series), color: series.source.color });
			}
			items.sort((a, b) => a.y - b.y);
			const gap = 16;
			for (let index = 1; index < items.length; index++) {
				items[index].y = Math.max(items[index].y, items[index - 1].y + gap);
			}
			const overflow = items.length ? items[items.length - 1].y - (box.bottom - 6) : 0;
			if (overflow > 0) {
				for (let index = items.length - 1; index >= 0; index--) {
					items[index].y -= overflow;
					if (index > 0 && items[index - 1].y > items[index].y - gap) {
						items[index - 1].y = items[index].y - gap;
					}
				}
			}
			const maxWidth = box.width - box.right - 10;
			for (const item of items) {
				const text = s('text', { x: box.right + 10, y: item.y, 'dominant-baseline': 'central' }, group);
				const valueWidth = textWidth(` ${item.value}`, font);
				const name = s('tspan', {}, text);
				name.textContent = ellipsize(item.name, font, maxWidth - valueWidth);
				const value = s('tspan', { class: 'vc-end-value' }, text);
				value.textContent = ` ${item.value}`;
			}
		}

		private renderEmpty(show: boolean): void {
			if (!show) {
				this.emptyEl?.remove();
				this.emptyEl = undefined;
				return;
			}
			const box = this.box;
			if (box) {
				const y = crisp(box.bottom);
				const baseline = s('line', { x1: 0, x2: box.width, y1: y, y2: y, class: 'vc-zero' }, this.marksBack);
				baseline.style.stroke = 'var(--vc-zero)';
			}
			this.emptyEl = h('div', 'vc-empty', this.plot);
			h('div', 'vc-empty-title', this.emptyEl, this.model.emptyTitle ?? this.ctx.strings.emptyTitle);
			h('div', 'vc-empty-message', this.emptyEl, this.model.emptyMessage ?? this.ctx.strings.emptyMessage);
		}

		private renderSkeleton(height: number): void {
			this.seriesLayer.replaceChildren();
			this.marksBack.replaceChildren();
			this.marksFront.replaceChildren();
			this.xAxisLayer.replaceChildren();
			for (const group of this.ticks.values()) {
				group.remove();
			}
			this.ticks.clear();
			this.shown = undefined;
			this.hideCursor();
			const width = this.width;
			const skeleton = s('g', { class: 'vc-skel' }, this.seriesLayer);
			for (let index = 0; index < 4; index++) {
				const y = crisp(10 + ((height - 34) * index) / 3);
				const line = s('line', { x1: 0, x2: width, y1: y, y2: y }, skeleton);
				line.style.stroke = 'var(--vc-grid)';
			}
			const points: Pt[] = [];
			for (let index = 0; index <= 12; index++) {
				const x = (width * index) / 12;
				const wave = Math.sin(index * 0.9) * 0.18 + Math.sin(index * 0.37 + 1) * 0.12;
				points.push([x, (height - 34) * (0.55 - wave) + 10]);
			}
			const path = s('path', { d: monotonePath(points, true), class: 'vc-line' }, skeleton);
			path.style.stroke = 'color-mix(in srgb, var(--vc-fg) 14%, transparent)';
			if (this.header) {
				this.header.element.classList.add('vc-skel');
			}
		}

		private setHeadline(animate: boolean): void {
			const header = this.header;
			const headline = this.metric.headline;
			if (!header || !headline) {
				return;
			}
			header.element.classList.remove('vc-skel');
			const label = headline.label ?? this.metric.label;
			if (isNum(headline.value)) {
				header.set(headline.value, this.metric.unit, label, undefined, '', headline.good, animate);
				return;
			}
			const bounds = this.rangeBounds();
			const current = this.aggregate(headline, bounds ? (x: number) => x >= bounds.lo && x <= bounds.hi : () => true);
			let delta: { text: string; direction: -1 | 0 | 1 } | undefined;
			if (headline.compare && bounds) {
				const previous = this.aggregate(headline, x => x >= bounds.lo - bounds.length && x < bounds.lo);
				if (isNum(previous) && isNum(current)) {
					delta = formatDelta(current, previous, this.metric.unit);
				}
			}
			header.set(current, this.metric.unit, label, delta, `${this.ctx.strings.vsPrevious} ${rangeNoun(this.range)}`, headline.good, animate);
		}

		private aggregate(headline: IHeadline, include: (x: number) => boolean): number | undefined {
			const series = this.metric.series.filter(item => !item.reference && !this.hidden.has(item.key));
			const values: number[] = [];
			const lasts: number[] = [];
			for (const item of series) {
				let last: number | undefined;
				for (const point of item.points) {
					if (include(point.x) && Number.isFinite(point.y)) {
						values.push(point.y);
						last = point.y;
					}
				}
				if (last !== undefined) {
					lasts.push(last);
				}
			}
			if (!values.length) {
				return undefined;
			}
			const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);
			switch (headline.aggregate) {
				case 'sum': return sum(values);
				case 'avg': return sum(values) / values.length;
				case 'max': return Math.max(...values);
				case 'min': return Math.min(...values);
				case 'last': return this.stacked || additive(this.metric.unit) ? sum(lasts) : sum(lasts) / lasts.length;
			}
		}

		//#endregion

		//#region Interaction

		private wire(): void {
			const plot = this.plot;
			plot.addEventListener('pointermove', event => {
				if (event.pointerType === 'touch' && event.buttons === 0) {
					return;
				}
				const rect = this.svg.getBoundingClientRect();
				this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
				if (!this.pointerFrame) {
					this.pointerFrame = win.requestAnimationFrame(() => {
						this.pointerFrame = 0;
						if (this.pointer) {
							this.hoverAt(this.pointer.x, this.pointer.y);
						}
					});
				}
			});
			plot.addEventListener('pointerdown', event => {
				const rect = this.svg.getBoundingClientRect();
				this.hoverAt(event.clientX - rect.left, event.clientY - rect.top);
			});
			plot.addEventListener('pointerleave', () => {
				this.pointer = undefined;
				if (this.ownerDocumentActive() !== plot) {
					this.hideCursor();
				}
			});
			plot.addEventListener('click', () => {
				const href = this.currentPoint()?.href;
				if (href) {
					this.ctx.onOpen?.(href);
				}
			});
			plot.addEventListener('focus', () => {
				if (!this.cursorShown && this.shown && !this.shown.empty) {
					this.moveCursor(this.cursorIndex >= 0 ? this.cursorIndex : this.shown.domain.length - 1, true);
					this.announce();
				}
			});
			plot.addEventListener('blur', () => {
				if (!this.pointer) {
					this.hideCursor();
				}
			});
			plot.addEventListener('keydown', event => this.onKey(event));
		}

		private ownerDocumentActive(): Element | null {
			return this.plot.ownerDocument.activeElement;
		}

		private onKey(event: KeyboardEvent): void {
			const frame = this.shown;
			if (!frame || frame.empty || !frame.domain.length) {
				return;
			}
			const last = frame.domain.length - 1;
			let index = this.cursorIndex < 0 ? last : this.cursorIndex;
			const big = Math.max(1, Math.round(frame.domain.length / 10));
			switch (event.key) {
				case 'ArrowLeft': index -= event.shiftKey ? big : 1; break;
				case 'ArrowRight': index += event.shiftKey ? big : 1; break;
				case 'PageUp': index -= big; break;
				case 'PageDown': index += big; break;
				case 'Home': index = 0; break;
				case 'End': index = last; break;
				case 'ArrowUp':
				case 'ArrowDown': {
					const keys = frame.series.filter(series => series.visible && !series.source.reference).map(series => series.source.key);
					if (keys.length > 1) {
						const at = keys.indexOf(this.primaryKey ?? keys[0]);
						this.primaryKey = keys[(at + (event.key === 'ArrowUp' ? -1 : 1) + keys.length) % keys.length];
					}
					break;
				}
				case 'Enter':
				case ' ': {
					const href = this.currentPoint()?.href;
					if (href) {
						event.preventDefault();
						this.ctx.onOpen?.(href);
					}
					return;
				}
				case 'Escape':
					this.hideCursor();
					return;
				default:
					return;
			}
			event.preventDefault();
			this.moveCursor(clamp(index, 0, last), false);
			this.announce();
		}

		private hoverAt(px: number, py: number): void {
			const frame = this.shown;
			const box = this.box;
			const sx = this.sx;
			const sy = this.sy;
			if (!frame || !box || !sx || !sy || frame.empty || !frame.domain.length || this.loading) {
				return;
			}
			if (this.model.type === 'scatter') {
				this.hoverScatter(frame, px, py, sx, sy);
				return;
			}
			const index = nearestIndex(frame.domain, sx.inv(px));
			if (!this.focusKey) {
				// The series nearest the pointer leads the tooltip.
				let best: string | undefined;
				let bestDistance = Infinity;
				for (const series of frame.series) {
					if (!series.visible || series.source.reference) {
						continue;
					}
					const at = this.valueIndex(series, frame.domain[index]);
					if (at < 0) {
						continue;
					}
					const top = sy(series.top[at]);
					const bot = this.stacked ? sy(series.bot[at]) : top;
					const distance = py >= Math.min(top, bot) && py <= Math.max(top, bot) ? 0 : Math.min(Math.abs(py - top), Math.abs(py - bot));
					if (distance < bestDistance) {
						bestDistance = distance;
						best = series.source.key;
					}
				}
				this.primaryKey = best;
			}
			this.moveCursor(index, false);
		}

		private hoverScatter(frame: IFrame, px: number, py: number, sx: IScale, sy: IScale): void {
			let bestSeries: IFrameSeries | undefined;
			let bestIndex = -1;
			let bestDistance = 28 * 28;
			for (const series of frame.series) {
				if (!series.visible) {
					continue;
				}
				const center = nearestIndex(series.xs, sx.inv(px));
				for (let at = Math.max(0, center - 60); at < Math.min(series.xs.length, center + 60); at++) {
					if (!Number.isFinite(series.top[at])) {
						continue;
					}
					const dx = sx(series.xs[at]) - px;
					const dy = sy(series.top[at]) - py;
					const distance = dx * dx + dy * dy;
					if (distance < bestDistance) {
						bestDistance = distance;
						bestSeries = series;
						bestIndex = at;
					}
				}
			}
			if (!bestSeries) {
				this.hideCursor();
				return;
			}
			this.primaryKey = bestSeries.source.key;
			this.moveCursor(nearestIndex(frame.domain, bestSeries.xs[bestIndex]), false);
		}

		/** Index in `series.xs` of the point at `x`: exact, or the nearest within half a step. */
		private valueIndex(series: IFrameSeries, x: number): number {
			const at = nearestIndex(series.xs, x);
			if (at < 0 || !Number.isFinite(series.raw[at])) {
				return -1;
			}
			if (series.xs[at] === x) {
				return at;
			}
			const frame = this.shown;
			const tolerance = (series.gap > 0 ? series.gap : frame ? this.typicalGap(frame) : 0) / 2;
			return Math.abs(series.xs[at] - x) <= tolerance ? at : -1;
		}

		private currentPoint(): ICPoint | undefined {
			const frame = this.shown;
			if (!frame || this.cursorIndex < 0 || !this.cursorShown) {
				return undefined;
			}
			const x = frame.domain[this.cursorIndex];
			const series = frame.series.find(item => item.source.key === this.primaryKey) ?? frame.series.find(item => item.visible && !item.source.reference);
			if (!series) {
				return undefined;
			}
			const at = this.valueIndex(series, x);
			return at >= 0 ? series.points[at] : undefined;
		}

		private moveCursor(index: number, jump: boolean): void {
			const frame = this.shown;
			const box = this.box;
			const sx = this.sx;
			const sy = this.sy;
			if (!frame || !box || !sx || !sy || index < 0 || index >= frame.domain.length) {
				return;
			}
			const changed = index !== this.cursorIndex;
			this.cursorIndex = index;
			const x = frame.domain[index];
			const firstShow = !this.cursorShown;
			const snap = jump || firstShow;
			if (!this.primaryKey || !frame.series.some(series => series.source.key === this.primaryKey && series.visible)) {
				this.primaryKey = frame.series.find(series => series.visible && !series.source.reference)?.source.key;
			}
			this.springs.set('x', sx(x), snap);
			for (const series of frame.series) {
				const at = this.valueIndex(series, x);
				const knob = this.knobs.get(series.source.key);
				const visible = at >= 0 && series.visible && !series.source.reference;
				if (knob) {
					knob.style.opacity = visible && !this.stacked && series.source.key !== this.primaryKey ? '0.9' : '0';
				}
				if (visible) {
					this.springs.set(`y:${series.source.key}`, sy(series.top[at]), snap || knob?.style.opacity === '0');
				}
			}
			const primary = frame.series.find(series => series.source.key === this.primaryKey);
			const primaryAt = primary ? this.valueIndex(primary, x) : -1;
			const showKnob = !this.bars && primaryAt >= 0;
			this.knob.style.opacity = showKnob ? '1' : '0';
			this.halo.style.opacity = showKnob ? '' : '0';
			if (primary && primaryAt >= 0) {
				this.knob.style.fill = primary.source.color;
				this.halo.style.fill = primary.source.color;
				this.springs.set('ky', sy(primary.top[primaryAt]), snap);
			}
			const bars = this.bars;
			const slot = bars ? Math.abs(sx(this.typicalGap(frame)) - sx(0)) : 0;
			setAttrs(this.crosshair, { y1: box.top, y2: box.bottom });
			this.crosshair.style.opacity = bars || this.model.type === 'scatter' ? '0' : '1';
			setAttrs(this.bandHover, { x: -slot / 2, width: slot, y: box.top, height: box.bottom - box.top });
			this.bandHover.style.opacity = bars ? '1' : '0';
			this.hit.classList.toggle('vc-link', !!this.currentPointAt(index)?.href);
			if (changed || firstShow) {
				this.tip.set(this.tipModel(frame, index));
				if (this.model.look.pill) {
					this.pill.set(this.pillLabel(x), index);
				}
			}
			this.cursorShown = true;
			this.cursorLayer.classList.add('vc-shown');
			this.tip.show();
			if (this.model.look.pill) {
				this.pill.show();
			}
			this.applyCursor();
		}

		private currentPointAt(index: number): ICPoint | undefined {
			const frame = this.shown;
			if (!frame) {
				return undefined;
			}
			const series = frame.series.find(item => item.source.key === this.primaryKey);
			const at = series ? this.valueIndex(series, frame.domain[index]) : -1;
			return series && at >= 0 ? series.points[at] : undefined;
		}

		private applyCursor(): void {
			const box = this.box;
			if (!box || !this.cursorShown) {
				return;
			}
			const x = this.springs.get('x');
			const crossX = crisp(x);
			this.crosshair.setAttribute('transform', `translate(${num(crossX)},0)`);
			this.bandHover.setAttribute('transform', `translate(${num(x)},0)`);
			const ky = this.springs.get('ky');
			setAttrs(this.knob, { cx: x, cy: ky });
			setAttrs(this.halo, { cx: x, cy: ky });
			for (const [key, knob] of this.knobs) {
				if (knob.style.opacity !== '0') {
					setAttrs(knob, { cx: x, cy: this.springs.get(`y:${key}`) });
				}
			}
			if (this.model.look.pill) {
				this.pill.place(x, box.bottom + 3, box.width);
				fadeTicks(this.xAxisLayer, x);
			}
			const anchorY = this.bars ? box.top + (box.bottom - box.top) * 0.35 : ky;
			this.tip.place(x, anchorY, box.width, 0, box.height, this.bars ? Math.abs((this.sx?.(this.typicalGap(this.shown!)) ?? 0) - (this.sx?.(0) ?? 0)) / 2 + 8 : 14);
		}

		private hideCursor(): void {
			if (!this.cursorShown) {
				return;
			}
			this.cursorShown = false;
			this.cursorLayer.classList.remove('vc-shown');
			this.tip.hide();
			this.pill.hide();
			fadeTicks(this.xAxisLayer, undefined);
			this.hit.classList.remove('vc-link');
		}

		/** The short form of x the axis pill shows: "Sep 5", "Sep 5, 14:00", "Oct 2026". */
		private pillLabel(x: number): string {
			const model = this.model;
			if (model.xKind !== 'time') {
				return this.xLabel(x);
			}
			const options: Intl.DateTimeFormatOptions = model.grain === 'year' ? { year: 'numeric' }
				: model.grain === 'month' ? { month: 'short', year: 'numeric' }
					: model.grain === 'day' || model.grain === 'week' ? { month: 'short', day: 'numeric' }
						: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
			return dateFormat(options, model.zone).format(x);
		}

		/** Area fill for line and area charts: what the spec asks for, else a gradient under areas and lone lines. */
		private areaFill(visibleCount: number): 'gradient' | 'solid' | 'pattern' | 'none' {
			const type = this.model.type;
			if (type !== 'area' && type !== 'line') {
				return 'none';
			}
			return this.model.look.fill ?? (type === 'area' || visibleCount === 1 ? 'gradient' : 'none');
		}

		/** Grid style, backdrop and edge fade for the current box. */
		private applyLook(box: IBox): void {
			const look = this.model.look;
			this.element.classList.toggle('vc-bars', this.bars);
			this.gridLayer.classList.toggle('vc-grid-dashed', look.grid === 'dashed');
			this.gridLayer.classList.toggle('vc-grid-none', look.grid === 'none');
			drawBackdrop(this.bgLayer, look, box);
			if (look.fadeEdges) {
				this.seriesLayer.setAttribute('mask', edgeMask(this.bgLayer, box.left, box.right, box.top, box.bottom));
			} else {
				this.seriesLayer.removeAttribute('mask');
			}
		}

		/** Narrow plots put y labels inside, over the grid; bars would cover them there, so bars keep a gutter. */
		private compactAxis(): boolean {
			return this.width < 200 && !this.bars;
		}

		private xLabel(x: number): string {
			const model = this.model;
			if (model.xKind === 'time') {
				return formatTimePoint(x, model.grain, model.zone);
			}
			if (model.xKind === 'category') {
				return model.categories[Math.round(x)] ?? String(x);
			}
			return formatValue(x, model.xUnit);
		}

		private tipModel(frame: IFrame, index: number): ITipModel {
			const x = frame.domain[index];
			const title = this.xLabel(x);
			const primary = frame.series.find(series => series.source.key === this.primaryKey);
			const primaryAt = primary ? this.valueIndex(primary, x) : -1;
			const point = primary && primaryAt >= 0 ? primary.points[primaryAt] : undefined;
			if (point && this.model.tooltip) {
				return this.model.tooltip(point);
			}
			const visible = frame.series.filter(series => series.visible);
			const hint = point?.href ? this.ctx.strings.open : undefined;
			if (visible.filter(series => !series.source.reference).length <= 1 || this.model.type === 'scatter') {
				const series = primary ?? visible[0];
				const at = series ? this.valueIndex(series, x) : -1;
				const value = series && at >= 0 ? series.raw[at] : Number.NaN;
				const references = visible.filter(item => item.source.reference && item !== series).flatMap(item => {
					const refAt = this.valueIndex(item, x);
					return refAt >= 0 ? [{ name: item.source.name, value: formatValue(item.raw[refAt], item.source.unit), color: item.source.color, dashed: true }] : [];
				});
				return {
					title: point?.label ? `${point.label} · ${title}` : title,
					hero: series ? formatValue(value, series.source.unit, true) : undefined,
					sub: visible.length > 1 && series ? series.source.name : undefined,
					rows: references,
					meta: point?.detail,
					hint,
				};
			}
			const rows: (ITipRow & { order: number })[] = [];
			let total = 0;
			let summed = 0;
			visible.forEach((series, order) => {
				const at = this.valueIndex(series, x);
				if (at < 0) {
					return;
				}
				const raw = series.raw[at];
				if (this.stacked && !series.source.reference && raw === 0 && visible.length > 4) {
					return;
				}
				if (!series.source.reference && Number.isFinite(raw)) {
					total += this.model.type === 'share' ? 0 : raw;
					summed++;
				}
				let value = formatValue(raw, series.source.unit);
				if (this.model.type === 'share') {
					// The share, then what it is a share of.
					const absolute = series.points[at]?.y;
					value = isNum(absolute) ? `${formatPercent(raw)}  ·  ${formatValue(absolute, series.source.unit)}` : formatPercent(raw);
				}
				rows.push({ name: series.source.name, value, color: series.source.color, dashed: series.source.dashed, strong: series.source.key === this.primaryKey, order: this.stacked ? -order : -raw });
			});
			rows.sort((a, b) => a.order - b.order);
			const limited: ITipRow[] = rows.slice(0, 8);
			if (rows.length > 8) {
				limited.push({ name: `+${rows.length - 8} more`, value: '' });
			}
			if (summed > 1 && this.model.type !== 'share' && (this.stacked || additive(frame.unit))) {
				limited.push({ name: this.ctx.strings.total, value: formatValue(total, frame.unit), strong: false });
			}
			return { title, rows: limited, meta: point?.detail, hint };
		}

		private announce(): void {
			const frame = this.shown;
			if (!frame || this.cursorIndex < 0) {
				return;
			}
			const model = this.tipModel(frame, this.cursorIndex);
			const parts = [model.title, model.hero, model.sub, ...(model.rows ?? []).map(row => `${row.name} ${row.value}`), ...(model.meta ?? []).map(([name, value]) => `${name} ${value}`)].filter(Boolean);
			this.live.textContent = parts.join(', ');
		}

		//#endregion

		dispose(): void {
			this.animation?.cancel();
			this.springs.dispose();
			this.tip.dispose();
			this.pill.dispose();
			this.header?.dispose();
			if (this.pointerFrame) {
				win.cancelAnimationFrame(this.pointerFrame);
			}
		}
	}

	//#endregion

	//#region Stats row

	function statDelta(item: Record<string, unknown>, unit: IUnit): { text: string; direction: -1 | 0 | 1 } | undefined {
		if (!isNum(item.delta)) {
			return undefined;
		}
		const delta = item.delta;
		const direction = Math.abs(delta) < 0.05 ? 0 : delta > 0 ? 1 : -1;
		const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : '→';
		const points = unit.kind === 'percent' || unit.kind === 'ratio';
		return { text: `${arrow} ${numberFormat(0, Math.abs(delta) >= 100 ? 0 : 1).format(Math.abs(delta))}${points ? ' pts' : '%'}`, direction };
	}

	/** Headline numbers in a row of hairline-divided tiles, each with an optional change and sparkline. */
	class StatsBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly trends: { svg: SVGSVGElement; values: number[]; color: string }[] = [];

		constructor(parent: HTMLElement, spec: Record<string, unknown>, _ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const items = (Array.isArray(spec.items) ? spec.items : []).filter(isRecord).slice(0, 12);
			if (!items.length) {
				problems.push(`${where}: stats need "items": [{ "label": "...", "value": 123 }].`);
			}
			const wrap = h('div', 'vc-stats', this.element);
			const inner = h('div', 'vc-stats-inner', wrap);
			items.forEach((item, index) => {
				const tile = h('div', 'vc-stat', inner);
				const label = str(item.label, 80) ?? '';
				const unit = resolveUnit(item.unit, label, isNum(item.value) ? [item.value] : []);
				// allow-any-unicode-next-line
				const text = isNum(item.value) ? formatValue(item.value, unit) : str(item.value, 40) ?? '—';
				const value = h('div', 'vc-stat-value', tile, text);
				value.title = text;
				h('div', 'vc-stat-label', tile, label);
				const delta = statDelta(item, unit);
				if (delta) {
					const good = item.good === 'up' || item.good === 'down' ? item.good : undefined;
					const deltaEl = h('div', `vc-stat-delta${good && delta.direction ? ((delta.direction > 0) === (good === 'up') ? ' vc-good' : ' vc-bad') : ''}`, tile, delta.text);
					const deltaLabel = str(item.deltaLabel, 60);
					if (deltaLabel) {
						deltaEl.append(` ${deltaLabel}`);
					}
				}
				const trend = Array.isArray(item.trend) ? item.trend.filter(isNum).slice(0, 2000) : [];
				if (trend.length > 1) {
					const svg = s('svg', { class: 'vc-stat-trend', height: 26 }, tile);
					this.trends.push({ svg, values: trend, color: seriesColor(item.color, index, label) });
				}
				if (!label) {
					problems.push(`${where}: item ${index + 1} has no label.`);
				}
			});
		}

		layout(): void {
			for (const trend of this.trends) {
				const width = Math.max(40, (trend.svg.parentElement?.clientWidth ?? 120) - 32);
				const height = 26;
				let lo = Infinity;
				let hi = -Infinity;
				for (const value of trend.values) {
					lo = Math.min(lo, value);
					hi = Math.max(hi, value);
				}
				const span = hi - lo || 1;
				const points: Pt[] = trend.values.map((value, index) => [(index / (trend.values.length - 1)) * width, 3 + (1 - (value - lo) / span) * (height - 6)]);
				trend.svg.replaceChildren();
				setAttrs(trend.svg, { width, viewBox: `0 0 ${width} ${height}` });
				const id = nextId('spark');
				const gradient = s('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, s('defs', {}, trend.svg));
				const a = s('stop', { offset: '0%' }, gradient);
				a.style.stopColor = trend.color;
				a.style.stopOpacity = '0.2';
				const b = s('stop', { offset: '100%' }, gradient);
				b.style.stopColor = trend.color;
				b.style.stopOpacity = '0';
				const curve = trend.values.length > width / 2 ? 'linear' : 'smooth';
				s('path', { d: areaPath(points, points.map(([x]) => [x, height] as Pt), curve), fill: `url(#${id})` }, trend.svg);
				const line = s('path', { d: curvePath(points, curve, true), class: 'vc-line' }, trend.svg);
				line.style.stroke = trend.color;
				line.style.strokeWidth = '1.5';
				const lastPoint = points[points.length - 1];
				const dot = s('circle', { cx: lastPoint[0], cy: lastPoint[1], r: 2.25, class: 'vc-dot' }, trend.svg);
				dot.style.fill = trend.color;
			}
		}

		dispose(): void { }
	}

	//#endregion

	//#region Heatmap

	/**
	 * Rows, columns and values[row][column] from the documented shape or the ones models also send:
	 * `x`/`y` axes with `categories` (or label arrays), or top-level `categories` for the columns,
	 * plus a `data` matrix, one `series` per row, or `data` as `{ x, y, value }` cells.
	 */
	function heatmapGrid(spec: Record<string, unknown>): { rows: unknown[]; columns: unknown[]; values: unknown[] } {
		const labels = (...candidates: unknown[]): unknown[] | undefined => {
			for (const candidate of candidates) {
				const list = isRecord(candidate) ? candidate.categories ?? candidate.labels ?? candidate.values : candidate;
				if (Array.isArray(list) && list.length) {
					return list;
				}
			}
			return undefined;
		};
		const rows = labels(spec.rows, spec.y, spec.yLabels, spec.rowLabels);
		const columns = labels(spec.columns, spec.x, spec.categories, spec.xLabels, spec.columnLabels, spec.cols);
		const matrix = [spec.values, spec.matrix, spec.z, spec.data].find(candidate => Array.isArray(candidate) && candidate.length && candidate.every(Array.isArray));
		if (Array.isArray(matrix)) {
			return { rows: rows ?? [], columns: columns ?? [], values: matrix };
		}
		const series = Array.isArray(spec.series) ? spec.series.filter(item => isRecord(item) && Array.isArray(item.data)) as Record<string, unknown>[] : [];
		if (series.length) {
			return { rows: rows ?? series.map(item => item.name ?? item.label), columns: columns ?? [], values: series.map(item => item.data) };
		}
		const cells = (Array.isArray(spec.data) ? spec.data : Array.isArray(spec.values) ? spec.values : []).filter(isRecord);
		if (!cells.length) {
			return { rows: rows ?? [], columns: columns ?? [], values: [] };
		}
		const rowKeys = rows ? rows.map(item => String(item)) : [];
		const columnKeys = columns ? columns.map(item => String(item)) : [];
		const placed: { row: string; column: string; value: unknown }[] = [];
		for (const cell of cells) {
			const row = cell.y ?? cell.row;
			const column = cell.x ?? cell.column ?? cell.col;
			if (row === undefined || column === undefined) {
				continue;
			}
			placed.push({ row: String(row), column: String(column), value: cell.value ?? cell.v ?? cell.z ?? cell.count });
			if (!rows && !rowKeys.includes(String(row))) {
				rowKeys.push(String(row));
			}
			if (!columns && !columnKeys.includes(String(column))) {
				columnKeys.push(String(column));
			}
		}
		const values = rowKeys.map(() => columnKeys.map(() => undefined as unknown));
		for (const { row, column, value } of placed) {
			const r = rowKeys.indexOf(row);
			const c = columnKeys.indexOf(column);
			if (r >= 0 && c >= 0) {
				values[r][c] = value;
			}
		}
		return { rows: rows ?? rowKeys, columns: columns ?? columnKeys, values };
	}

	class HeatmapBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly cellsLayer: SVGGElement;
		private readonly hover: SVGRectElement;
		private readonly tip: Tip;
		private readonly live: HTMLElement;
		private readonly rows: string[];
		private readonly columns: string[];
		private readonly values: number[][];
		private readonly unit: IUnit;
		private readonly lo: number;
		private readonly hi: number;
		private geometry: { left: number; top: number; cell: number; cellH: number; gap: number; width: number; height: number } | undefined;
		private active: [number, number] | undefined;
		private width = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const grid = heatmapGrid(spec);
			this.rows = grid.rows.map(item => str(item, 40) ?? '').slice(0, 60);
			this.columns = grid.columns.map(item => str(item, 40) ?? '').slice(0, 200);
			const raw = grid.values;
			this.values = this.rows.map((_, row) => this.columns.map((__, column) => {
				const line = raw[row];
				const value = Array.isArray(line) ? line[column] : undefined;
				return isNum(value) ? value : Number.NaN;
			}));
			if (!this.rows.length || !this.columns.length) {
				problems.push(`${where}: heatmaps need "rows", "columns" and "values" (values[row][column]).`);
			} else if (raw.length !== this.rows.length || raw.some(line => !Array.isArray(line) || line.length !== this.columns.length)) {
				problems.push(`${where}: "values" must have ${this.rows.length} rows of ${this.columns.length} numbers.`);
			}
			let lo = Infinity;
			let hi = -Infinity;
			const flat: number[] = [];
			for (const line of this.values) {
				for (const value of line) {
					if (Number.isFinite(value)) {
						lo = Math.min(lo, value);
						hi = Math.max(hi, value);
						flat.push(value);
					}
				}
			}
			this.lo = Number.isFinite(lo) ? Math.min(0, lo) : 0;
			this.hi = Number.isFinite(hi) ? hi : 1;
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, flat);
			this.plot = h('div', 'vc-plot', this.element);
			this.plot.tabIndex = 0;
			this.plot.setAttribute('role', 'group');
			this.plot.setAttribute('aria-roledescription', 'heatmap');
			this.plot.setAttribute('aria-label', `${str(spec.title) ?? 'Heatmap'}. Use arrow keys to read cells.`);
			this.svg = s('svg', { class: 'vc-svg' }, this.plot);
			this.cellsLayer = s('g', {}, this.svg);
			this.hover = s('rect', { class: 'vc-heat-hover' }, this.svg);
			this.hover.style.opacity = '0';
			this.tip = new Tip(this.plot);
			this.live = h('div', 'vc-sr', this.plot);
			this.live.setAttribute('aria-live', 'polite');
			const scaleWords = Array.isArray(spec.scale) ? spec.scale.map(item => str(item, 20)) : [];
			const key = h('div', 'vc-heat-key', this.element);
			h('span', '', key, scaleWords[0] ?? ctx.strings.fewer);
			for (let step = 0; step < 10; step++) {
				h('span', 'vc-heat-step', key).style.background = heatColor(step / 9);
			}
			h('span', '', key, scaleWords[1] ?? ctx.strings.more);
			this.wire();
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const font = `400 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			let labelWidth = 0;
			for (const row of this.rows) {
				labelWidth = Math.max(labelWidth, textWidth(row, font));
			}
			const left = Math.ceil(labelWidth) + 10;
			const columns = Math.max(1, this.columns.length);
			const gap = width < 480 ? 2 : 3;
			const cell = Math.max(4, (width - left - gap * (columns - 1)) / columns);
			const cellH = clamp(cell * 0.86, 12, 34);
			const top = 0;
			const gridHeight = this.rows.length * cellH + Math.max(0, this.rows.length - 1) * gap;
			const height = gridHeight + 22;
			this.geometry = { left, top, cell, cellH, gap, width, height };
			setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
			this.plot.style.height = `${height}px`;
			this.cellsLayer.replaceChildren();
			const radius = Math.min(4, cell / 5, cellH / 5);
			const animate = !this.drawn && this.ctx.animate && !reducedMotion();
			const span = this.hi - this.lo || 1;
			this.rows.forEach((row, r) => {
				const y = top + r * (cellH + gap);
				const label = s('text', { x: left - 10, y: y + cellH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'vc-axis-label' }, this.cellsLayer);
				label.textContent = row;
				label.style.fill = 'var(--vc-muted)';
				label.style.fontSize = '11px';
				this.columns.forEach((_, c) => {
					const value = this.values[r][c];
					const rect = s('rect', { x: left + c * (cell + gap), y, width: cell, height: cellH, rx: radius, class: 'vc-heat-cell' }, this.cellsLayer);
					rect.style.fill = Number.isFinite(value) ? heatColor((value - this.lo) / span) : 'var(--vc-grid)';
					if (animate) {
						rect.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 80 + c * 14 + r * 6, easing: 'ease-out', fill: 'backwards' });
					}
				});
			});
			let widest = 0;
			for (const column of this.columns) {
				widest = Math.max(widest, textWidth(column, font));
			}
			const every = Math.max(1, Math.ceil((widest + 10) / (cell + gap)));
			for (let c = 0; c < this.columns.length; c += every) {
				const text = s('text', { x: left + c * (cell + gap) + (every > 1 ? 0 : cell / 2), y: gridHeight + 16, 'text-anchor': every > 1 ? 'start' : 'middle' }, this.cellsLayer);
				text.textContent = this.columns[c];
				text.style.fill = 'var(--vc-muted)';
				text.style.fontSize = '11px';
			}
			this.drawn = true;
			if (this.active) {
				this.activate(this.active[0], this.active[1], true);
			}
		}

		private wire(): void {
			this.plot.addEventListener('pointermove', event => {
				const g = this.geometry;
				if (!g) {
					return;
				}
				const rect = this.svg.getBoundingClientRect();
				const x = event.clientX - rect.left - g.left;
				const y = event.clientY - rect.top - g.top;
				const c = Math.floor(x / (g.cell + g.gap));
				const r = Math.floor(y / (g.cellH + g.gap));
				if (c >= 0 && c < this.columns.length && r >= 0 && r < this.rows.length) {
					this.activate(r, c, false);
				} else {
					this.deactivate();
				}
			});
			this.plot.addEventListener('pointerleave', () => this.deactivate());
			this.plot.addEventListener('blur', () => this.deactivate());
			this.plot.addEventListener('focus', () => {
				if (!this.active) {
					this.activate(0, 0, true);
				}
			});
			this.plot.addEventListener('keydown', event => {
				const [r, c] = this.active ?? [0, 0];
				const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
				const move = moves[event.key];
				if (move) {
					event.preventDefault();
					this.activate(clamp(r + move[0], 0, this.rows.length - 1), clamp(c + move[1], 0, this.columns.length - 1), true);
					this.live.textContent = `${this.rows[this.active![0]]} ${this.columns[this.active![1]]}: ${formatValue(this.values[this.active![0]][this.active![1]], this.unit, true)}`;
				} else if (event.key === 'Escape') {
					this.deactivate();
				}
			});
		}

		private activate(r: number, c: number, jump: boolean): void {
			const g = this.geometry;
			if (!g) {
				return;
			}
			const same = this.active && this.active[0] === r && this.active[1] === c;
			this.active = [r, c];
			const x = g.left + c * (g.cell + g.gap);
			const y = g.top + r * (g.cellH + g.gap);
			setAttrs(this.hover, { x: x - 1, y: y - 1, width: g.cell + 2, height: g.cellH + 2, rx: Math.min(5, g.cell / 4) });
			this.hover.style.opacity = '1';
			if (!same || jump) {
				const value = this.values[r][c];
				this.tip.set({ title: `${this.rows[r]} · ${this.columns[c]}`, hero: formatValue(value, this.unit, true) });
			}
			this.tip.show();
			this.tip.place(x + g.cell / 2, y + g.cellH / 2, g.width, 0, g.height, g.cell / 2 + 8);
		}

		private deactivate(): void {
			this.active = undefined;
			this.hover.style.opacity = '0';
			this.tip.hide();
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Treemap

	interface ITreeNode {
		readonly name: string;
		readonly value: number;
		readonly color?: number;
		readonly href?: string;
		readonly detail?: readonly (readonly [string, string])[];
		readonly children: ITreeNode[];
		parent?: ITreeNode;
		path: string;
		x0: number;
		y0: number;
		x1: number;
		y1: number;
		/** Index of its top-level group, for group colors. */
		group: number;
	}

	function readTree(raw: unknown, problems: string[], where: string): ITreeNode {
		let count = 0;
		const read = (value: unknown, depth: number): ITreeNode | undefined => {
			if (!isRecord(value) || count > 20_000 || depth > 24) {
				return undefined;
			}
			count++;
			const children = (Array.isArray(value.children) ? value.children : []).map(child => read(child, depth + 1)).filter((child): child is ITreeNode => !!child && child.value > 0);
			const own = isNum(value.value) ? Math.max(0, value.value) : 0;
			const sum = children.reduce((total, child) => total + child.value, 0);
			return {
				name: str(value.name, 120) ?? '',
				value: children.length ? Math.max(sum, own) : own,
				color: isNum(value.color) ? value.color : undefined,
				href: safeHref(value.href),
				detail: detailRows(value.detail),
				children,
				path: '',
				x0: 0, y0: 0, x1: 0, y1: 0,
				group: 0,
			};
		};
		const root = Array.isArray(raw) ? read({ name: '', children: raw }, 0) : read(raw, 0);
		if (!root || root.value <= 0) {
			problems.push(`${where}: treemaps need "data": { "name": "...", "children": [{ "name": "...", "value": 12 }] } with positive values.`);
			return { name: '', value: 0, children: [], path: '', x0: 0, y0: 0, x1: 0, y1: 0, group: 0 };
		}
		if (count > 20_000) {
			problems.push(`${where}: only the first 20,000 treemap nodes are drawn.`);
		}
		const link = (node: ITreeNode, parent: ITreeNode | undefined, group: number) => {
			node.parent = parent;
			node.group = group;
			const join = parent?.path && !parent.path.endsWith('/') ? `${parent.path}/` : parent?.path ?? '';
			node.path = parent ? `${join}${node.name}` : node.name;
			node.children.sort((a, b) => b.value - a.value);
			node.children.forEach((child, index) => link(child, node, parent ? group : index));
		};
		link(root, undefined, 0);
		return root;
	}

	/** Squarified treemap (Bruls et al.): rows of tiles whose aspect ratios stay close to 1. */
	function squarify(nodes: readonly ITreeNode[], x0: number, y0: number, x1: number, y1: number): void {
		const items = nodes.filter(node => node.value > 0);
		const total = items.reduce((sum, node) => sum + node.value, 0);
		if (total <= 0 || x1 - x0 <= 0 || y1 - y0 <= 0) {
			for (const node of nodes) {
				node.x0 = node.x1 = x0;
				node.y0 = node.y1 = y0;
			}
			return;
		}
		const scale = ((x1 - x0) * (y1 - y0)) / total;
		const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
		const worst = (row: readonly ITreeNode[], side: number) => {
			let sum = 0;
			let max = 0;
			let min = Infinity;
			for (const node of row) {
				const area = node.value * scale;
				sum += area;
				max = Math.max(max, area);
				min = Math.min(min, area);
			}
			const side2 = side * side;
			const sum2 = sum * sum;
			return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
		};
		const place = (row: readonly ITreeNode[]) => {
			const area = row.reduce((sum, node) => sum + node.value * scale, 0);
			if (rect.w >= rect.h) {
				const width = rect.h > 0 ? area / rect.h : 0;
				let y = rect.y;
				for (const node of row) {
					const height = width > 0 ? (node.value * scale) / width : 0;
					node.x0 = rect.x;
					node.x1 = rect.x + width;
					node.y0 = y;
					node.y1 = y + height;
					y += height;
				}
				rect.x += width;
				rect.w -= width;
			} else {
				const height = rect.w > 0 ? area / rect.w : 0;
				let x = rect.x;
				for (const node of row) {
					const width = height > 0 ? (node.value * scale) / height : 0;
					node.y0 = rect.y;
					node.y1 = rect.y + height;
					node.x0 = x;
					node.x1 = x + width;
					x += width;
				}
				rect.y += height;
				rect.h -= height;
			}
		};
		let row: ITreeNode[] = [];
		let index = 0;
		while (index < items.length) {
			const side = Math.min(rect.w, rect.h);
			const next = items[index];
			if (!row.length || worst([...row, next], side) <= worst(row, side)) {
				row.push(next);
				index++;
			} else {
				place(row);
				row = [];
			}
		}
		if (row.length) {
			place(row);
		}
	}

	const GROUP_HEADER = 17;

	function layoutTree(node: ITreeNode, x0: number, y0: number, x1: number, y1: number, depth: number): void {
		node.x0 = x0;
		node.y0 = y0;
		node.x1 = x1;
		node.y1 = y1;
		if (!node.children.length) {
			return;
		}
		const width = x1 - x0;
		const height = y1 - y0;
		const header = depth > 0 && width > 46 && height > GROUP_HEADER * 2.2 ? GROUP_HEADER : 0;
		const pad = depth > 0 ? (width > 24 && height > 24 ? 2 : 0) : 0;
		squarify(node.children, x0 + pad, y0 + header + (header ? 0 : pad), x1 - pad, y1 - pad);
		for (const child of node.children) {
			layoutTree(child, child.x0, child.y0, child.x1, child.y1, depth + 1);
		}
	}

	/** Resolved sRGB for CSS colors (var(), color-mix()), read in one style pass. */
	function resolveRgb(host: Element, colors: readonly string[]): ([number, number, number] | undefined)[] {
		const probe = doc.createElement('div');
		probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
		host.appendChild(probe);
		const spans = colors.map(color => {
			const span = doc.createElement('span');
			span.style.color = color;
			probe.appendChild(span);
			return span;
		});
		const out = spans.map(span => {
			const value = win.getComputedStyle(span).color;
			const match = /(?:rgba?\(|color\(srgb\s+)([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
			if (!match) {
				return undefined;
			}
			const scale = value.startsWith('color(') ? 255 : 1;
			return [Number(match[1]) * scale, Number(match[2]) * scale, Number(match[3]) * scale] as [number, number, number];
		});
		probe.remove();
		return out;
	}

	function luminance([r, g, b]: [number, number, number]): number {
		const channel = (value: number) => {
			const c = value / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
	}

	class TreemapBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly crumbs: HTMLElement;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly layer: SVGGElement;
		private readonly hover: SVGRectElement;
		private readonly tip: Tip;
		private readonly live: HTMLElement;
		private readonly root: ITreeNode;
		private readonly sizeUnit: IUnit;
		private readonly colorUnit: IUnit;
		private readonly sizeLabel?: string;
		private readonly colorLabel?: string;
		private readonly colorMax: number;
		private readonly colorMin: number;
		private readonly hasColor: boolean;
		private readonly colorCurve: number;
		private readonly heightSpec: number;
		private focus: ITreeNode;
		private leaves: ITreeNode[] = [];
		private active: ITreeNode | undefined;
		private width = 0;
		private height = 0;
		private drawn = false;
		private zooming = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.root = readTree(spec.data, problems, where);
			this.focus = this.root;
			this.sizeLabel = str(spec.sizeLabel, 40);
			this.colorLabel = str(spec.colorLabel, 60);
			this.sizeUnit = resolveUnit(spec.unit, this.sizeLabel);
			this.colorUnit = resolveUnit(spec.colorUnit, this.colorLabel);
			let min = Infinity;
			let max = -Infinity;
			const colors: number[] = [];
			const visit = (node: ITreeNode) => {
				if (!node.children.length && isNum(node.color)) {
					min = Math.min(min, node.color);
					max = Math.max(max, node.color);
					colors.push(node.color);
				}
				node.children.forEach(visit);
			};
			visit(this.root);
			this.hasColor = Number.isFinite(min);
			if (!this.hasColor && this.colorLabel) {
				problems.push(`${where}: "colorLabel" says "${this.colorLabel}" but no tile has a numeric "color", so tiles are colored by group. Put the value on each leaf: { "name", "value", "color": 24 }.`);
			}
			this.colorMin = this.hasColor ? Math.min(0, min) : 0;
			this.colorMax = this.hasColor ? max : 1;
			// A few hot files would leave everything else the coldest color; a square-root scale spreads the rest.
			colors.sort((a, b) => a - b);
			const upper = colors[Math.floor(colors.length * 0.75)] ?? 0;
			this.colorCurve = this.hasColor && upper - this.colorMin > 0 && (this.colorMax - this.colorMin) > 5 * (upper - this.colorMin) ? 0.5 : 1;
			this.heightSpec = isNum(spec.height) ? clamp(spec.height, 160, 900) : 420;
			this.crumbs = h('div', 'vc-tree-crumbs', this.element);
			this.plot = h('div', 'vc-plot', this.element);
			this.plot.tabIndex = 0;
			this.plot.setAttribute('role', 'group');
			this.plot.setAttribute('aria-roledescription', 'treemap');
			this.plot.setAttribute('aria-label', `${str(spec.title) ?? 'Treemap'}. Arrow keys move between tiles, Enter zooms in, Escape zooms out.`);
			this.svg = s('svg', { class: 'vc-svg' }, this.plot);
			this.layer = s('g', {}, this.svg);
			this.hover = s('rect', { class: 'vc-tile-hover' }, this.svg);
			this.hover.style.opacity = '0';
			this.tip = new Tip(this.plot);
			this.live = h('div', 'vc-sr', this.plot);
			this.live.setAttribute('aria-live', 'polite');
			const foot = h('div', 'vc-tree-foot', this.element);
			if (this.hasColor) {
				const ramp = h('div', 'vc-ramp', foot);
				h('span', '', ramp, formatValue(this.colorMin, this.colorUnit));
				const bar = h('i', '', ramp);
				bar.style.background = `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map(t => spectrumColor(t)).join(', ')})`;
				h('span', '', ramp, `${formatValue(this.colorMax, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}`);
			}
			h('span', 'vc-tree-hint', foot, ctx.strings.zoomHint);
			this.wire();
		}

		private fill(node: ITreeNode): string {
			if (this.hasColor) {
				return isNum(node.color) ? spectrumColor(Math.pow(clamp((node.color - this.colorMin) / ((this.colorMax - this.colorMin) || 1), 0, 1), this.colorCurve)) : 'var(--vc-cold)';
			}
			return PALETTE[node.group % PALETTE.length];
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			this.height = width < 480 ? Math.round(Math.min(this.heightSpec, Math.max(260, width * 0.9))) : this.heightSpec;
			(this.element.querySelector('.vc-tree-hint') as HTMLElement | null)?.style.setProperty('display', width < 480 ? 'none' : '');
			this.render(!this.drawn && this.ctx.animate);
			this.drawn = true;
		}

		private render(animate: boolean): void {
			const width = this.width;
			const height = this.height;
			setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
			this.plot.style.height = `${height}px`;
			layoutTree(this.focus, 0, 0, width, height, 0);
			this.layer.replaceChildren();
			this.leaves = [];
			const groups: ITreeNode[] = [];
			const walk = (node: ITreeNode, depth: number) => {
				if (node.x1 - node.x0 < 0.5 || node.y1 - node.y0 < 0.5) {
					return;
				}
				if (!node.children.length) {
					this.leaves.push(node);
					return;
				}
				if (depth > 0) {
					groups.push(node);
				}
				node.children.forEach(child => walk(child, depth + 1));
			};
			walk(this.focus, 0);
			for (const group of groups) {
				const rect = s('rect', { x: group.x0, y: group.y0, width: group.x1 - group.x0, height: group.y1 - group.y0, rx: 2 }, this.layer);
				rect.style.fill = 'color-mix(in srgb, var(--vc-fg) 4%, transparent)';
			}
			const fills = this.leaves.map(leaf => this.fill(leaf));
			const labelled = this.leaves.map(leaf => leaf.x1 - leaf.x0 > 46 && leaf.y1 - leaf.y0 > 18);
			const rgb = resolveRgb(this.plot, fills.filter((_, index) => labelled[index]));
			let rgbIndex = 0;
			const font = `400 11px ${monoFamily(this.element)}`;
			this.leaves.forEach((leaf, index) => {
				const rect = s('rect', { x: leaf.x0, y: leaf.y0, width: Math.max(0, leaf.x1 - leaf.x0), height: Math.max(0, leaf.y1 - leaf.y0), class: 'vc-tile' }, this.layer);
				rect.style.fill = fills[index];
				if (labelled[index]) {
					const color = rgb[rgbIndex++];
					const text = s('text', { x: leaf.x0 + 5, y: leaf.y0 + 13, class: 'vc-tile-label' }, this.layer);
					text.textContent = ellipsize(leaf.name, font, leaf.x1 - leaf.x0 - 9);
					text.style.fill = color && luminance(color) > 0.36 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.94)';
				}
			});
			const boldFont = `600 11px ${monoFamily(this.element)}`;
			for (const group of groups) {
				if (group.x1 - group.x0 > 46 && group.y1 - group.y0 > GROUP_HEADER * 2.2) {
					const text = s('text', { x: group.x0 + 5, y: group.y0 + 12.5, class: 'vc-group-label' }, this.layer);
					text.textContent = ellipsize(group.name.endsWith('/') ? group.name : `${group.name}/`, boldFont, group.x1 - group.x0 - 10);
				}
			}
			if (animate && !reducedMotion()) {
				this.layer.animate?.([{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
			}
			this.renderCrumbs();
			this.deactivate();
		}

		private renderCrumbs(): void {
			this.crumbs.replaceChildren();
			const chain: ITreeNode[] = [];
			for (let node: ITreeNode | undefined = this.focus; node; node = node.parent) {
				chain.unshift(node);
			}
			chain.forEach((node, index) => {
				if (index > 0) {
					h('span', '', this.crumbs, '/');
				}
				const label = node.name || 'root';
				if (index === chain.length - 1) {
					h('span', 'vc-current', this.crumbs, label);
				} else {
					const button = h('button', '', this.crumbs, label);
					button.type = 'button';
					button.addEventListener('click', () => this.zoomTo(node));
				}
			});
			this.crumbs.style.display = chain.length > 1 || this.root.name ? '' : 'none';
		}

		/** The child of the focused node on the way to `node`. */
		private stepToward(node: ITreeNode): ITreeNode | undefined {
			let current: ITreeNode | undefined = node;
			while (current && current.parent !== this.focus) {
				current = current.parent;
			}
			return current;
		}

		private zoomTo(target: ITreeNode): void {
			if (target === this.focus || this.zooming) {
				return;
			}
			const into = target.parent === this.focus || this.isAncestor(this.focus, target);
			if (into && !reducedMotion()) {
				const scaleX = this.width / Math.max(1, target.x1 - target.x0);
				const scaleY = this.height / Math.max(1, target.y1 - target.y0);
				this.zooming = true;
				const animation = this.layer.animate?.([
					{ transform: 'none', transformOrigin: '0 0' },
					{ transform: `scale(${scaleX},${scaleY}) translate(${-target.x0}px,${-target.y0}px)`, transformOrigin: '0 0', opacity: 0.4 },
				], { duration: 300, easing: EASE_OUT });
				const done = () => {
					this.zooming = false;
					this.focus = target;
					this.render(false);
					this.layer.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160 });
				};
				if (animation) {
					animation.onfinish = done;
				} else {
					done();
				}
				return;
			}
			this.focus = target;
			this.render(false);
			if (!reducedMotion()) {
				this.layer.animate?.([{ opacity: 0, transform: 'scale(1.03)', transformOrigin: '50% 50%' }, { opacity: 1, transform: 'none', transformOrigin: '50% 50%' }], { duration: 260, easing: EASE_OUT });
			}
		}

		private isAncestor(ancestor: ITreeNode, node: ITreeNode): boolean {
			for (let current: ITreeNode | undefined = node.parent; current; current = current.parent) {
				if (current === ancestor) {
					return true;
				}
			}
			return false;
		}

		private wire(): void {
			this.plot.addEventListener('pointermove', event => {
				const rect = this.svg.getBoundingClientRect();
				const leaf = this.leafAt(event.clientX - rect.left, event.clientY - rect.top);
				if (leaf) {
					this.activate(leaf);
				} else {
					this.deactivate();
				}
			});
			this.plot.addEventListener('pointerleave', () => this.deactivate());
			this.plot.addEventListener('click', event => {
				const rect = this.svg.getBoundingClientRect();
				const leaf = this.leafAt(event.clientX - rect.left, event.clientY - rect.top);
				if (leaf) {
					this.openOrZoom(leaf);
				}
			});
			this.plot.addEventListener('contextmenu', event => {
				if (this.focus.parent) {
					event.preventDefault();
					this.zoomTo(this.focus.parent);
				}
			});
			this.plot.addEventListener('focus', () => {
				if (!this.active && this.leaves.length) {
					this.activate(this.leaves[0]);
				}
			});
			this.plot.addEventListener('blur', () => this.deactivate());
			this.plot.addEventListener('keydown', event => {
				if (event.key === 'Escape' && this.focus.parent) {
					event.preventDefault();
					this.zoomTo(this.focus.parent);
					return;
				}
				if ((event.key === 'Enter' || event.key === ' ') && this.active) {
					event.preventDefault();
					this.openOrZoom(this.active);
					return;
				}
				const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
				const direction = directions[event.key];
				if (!direction) {
					return;
				}
				event.preventDefault();
				const from = this.active ?? this.leaves[0];
				if (!from) {
					return;
				}
				const cx = (from.x0 + from.x1) / 2;
				const cy = (from.y0 + from.y1) / 2;
				let best: ITreeNode | undefined;
				let bestScore = Infinity;
				for (const leaf of this.leaves) {
					if (leaf === from) {
						continue;
					}
					const dx = (leaf.x0 + leaf.x1) / 2 - cx;
					const dy = (leaf.y0 + leaf.y1) / 2 - cy;
					const along = dx * direction[0] + dy * direction[1];
					if (along <= 0.5) {
						continue;
					}
					const across = Math.abs(dx * direction[1]) + Math.abs(dy * direction[0]);
					const score = along + across * 2;
					if (score < bestScore) {
						bestScore = score;
						best = leaf;
					}
				}
				if (best) {
					this.activate(best);
					this.live.textContent = this.describe(best);
				}
			});
		}

		private openOrZoom(leaf: ITreeNode): void {
			const step = this.stepToward(leaf);
			if (step && step.children.length) {
				this.zoomTo(step);
			} else if (leaf.href) {
				this.ctx.onOpen?.(leaf.href);
			}
		}

		private leafAt(x: number, y: number): ITreeNode | undefined {
			for (const leaf of this.leaves) {
				if (x >= leaf.x0 && x < leaf.x1 && y >= leaf.y0 && y < leaf.y1) {
					return leaf;
				}
			}
			return undefined;
		}

		private describe(leaf: ITreeNode): string {
			const parts = [leaf.path, `${formatValue(leaf.value, this.sizeUnit)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`];
			if (isNum(leaf.color)) {
				parts.push(`${formatValue(leaf.color, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}`);
			}
			return parts.join(', ');
		}

		private activate(leaf: ITreeNode): void {
			if (this.active !== leaf) {
				this.active = leaf;
				setAttrs(this.hover, { x: leaf.x0 + 0.75, y: leaf.y0 + 0.75, width: Math.max(0, leaf.x1 - leaf.x0 - 1.5), height: Math.max(0, leaf.y1 - leaf.y0 - 1.5) });
				const sizeText = `${formatValue(leaf.value, this.sizeUnit)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`;
				const colorText = isNum(leaf.color) ? `${formatValue(leaf.color, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}` : undefined;
				const step = this.stepToward(leaf);
				this.tip.set({
					title: leaf.path,
					sub: colorText ? `${sizeText} · ${colorText}` : sizeText,
					meta: leaf.detail,
					hint: step && step.children.length ? undefined : leaf.href ? this.ctx.strings.open : undefined,
				});
			}
			this.hover.style.opacity = '1';
			this.tip.show();
			this.tip.place((leaf.x0 + leaf.x1) / 2, (leaf.y0 + leaf.y1) / 2, this.width, 0, this.height, Math.min(40, (leaf.x1 - leaf.x0) / 2) + 6);
			this.svg.style.cursor = leaf.href || this.stepToward(leaf)?.children.length ? 'pointer' : '';
		}

		private deactivate(): void {
			this.active = undefined;
			this.hover.style.opacity = '0';
			this.tip.hide();
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Parts of a whole: donut and ranked bars

	interface IPart {
		readonly label: string;
		readonly value: number;
		readonly color: string;
		readonly href?: string;
		readonly detail?: string;
	}

	/**
	 * The `{ label, value }` items of a part-of-whole chart (donut, ranked, funnel): `data` as
	 * documented, or the cartesian shapes models also send: one series of `{ x, y }` points or of
	 * numbers over `categories`, several series (one part each, summed), or `labels` + `values`.
	 */
	function partsData(spec: Record<string, unknown>): unknown[] {
		const names = [spec.categories, spec.labels, isRecord(spec.x) ? spec.x.categories : undefined].find(Array.isArray) as unknown[] | undefined;
		const zip = (values: unknown[]) => names ? values.map((value, index) => ({ label: names[index], value })) : [];
		if (Array.isArray(spec.data) && spec.data.length) {
			return spec.data.some(isRecord) ? spec.data : zip(spec.data);
		}
		const series = Array.isArray(spec.series) ? spec.series.filter(isRecord) : [];
		if (series.length === 1 && Array.isArray(series[0].data)) {
			return series[0].data.some(isRecord) ? series[0].data : zip(series[0].data);
		}
		if (series.length > 1) {
			return series.map(item => ({ ...item, label: item.label ?? item.name, value: isNum(item.value) ? item.value : Array.isArray(item.data) ? item.data.reduce((sum: number, datum) => sum + (isNum(datum) ? datum : isRecord(datum) && isNum(datum.y) ? datum.y : 0), 0) : undefined }));
		}
		return Array.isArray(spec.values) ? zip(spec.values) : [];
	}

	function readParts(raw: unknown, problems: string[], where: string): IPart[] {
		const list = (Array.isArray(raw) ? raw : []).filter(isRecord).slice(0, 500);
		if (!list.length) {
			problems.push(`${where}: give "data": [{ "label": "...", "value": 12 }].`);
		}
		return list.flatMap((item, index) => {
			const label = str(item.label ?? item.name ?? item.x ?? item.category, 200);
			const amount = item.value ?? item.y ?? item.count;
			const value = isNum(amount) ? amount : Number.NaN;
			if (!label || !Number.isFinite(value)) {
				problems.push(`${where}: item ${index + 1} needs a "label" and a numeric "value".`);
				return [];
			}
			return [{ label, value, color: seriesColor(item.color, index, label), href: safeHref(item.href), detail: str(item.detail, 200) }];
		});
	}

	function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
		const sweep = Math.max(0, end - start);
		if (sweep >= Math.PI * 2 - 1e-6) {
			return `M${num(cx + outer)},${num(cy)}A${num(outer)},${num(outer)} 0 1 1 ${num(cx - outer)},${num(cy)}A${num(outer)},${num(outer)} 0 1 1 ${num(cx + outer)},${num(cy)}M${num(cx + inner)},${num(cy)}A${num(inner)},${num(inner)} 0 1 0 ${num(cx - inner)},${num(cy)}A${num(inner)},${num(inner)} 0 1 0 ${num(cx + inner)},${num(cy)}Z`;
		}
		const large = sweep > Math.PI ? 1 : 0;
		const p = (radius: number, angle: number) => `${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`;
		return `M${p(outer, start)}A${num(outer)},${num(outer)} 0 ${large} 1 ${p(outer, end)}L${p(inner, end)}A${num(inner)},${num(inner)} 0 ${large} 0 ${p(inner, start)}Z`;
	}

	class DonutBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly parts: IPart[];
		private readonly unit: IUnit;
		private readonly total: number;
		private readonly svg: SVGSVGElement;
		private readonly list: HTMLElement;
		private readonly centerValue: SVGTextElement;
		private readonly centerLabel: SVGTextElement;
		private readonly centerText: string;
		private readonly hole: number;
		private readonly fillStyle: 'solid' | 'gradient' | 'pattern';
		private readonly grow: boolean;
		private readonly centerValueSpec?: string;
		/** The values are already shares of the whole (percents summing to 100). */
		private readonly sharesGiven: boolean;
		private geometry: { start: number; end: number }[] = [];
		private arcs: SVGPathElement[] = [];
		private items: HTMLElement[] = [];
		private active = -1;
		private size = 0;
		private drawn = false;
		private animation: ITween | undefined;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.parts = readParts(partsData(spec), problems, where).filter(part => part.value > 0).sort((a, b) => b.value - a.value);
			if (this.parts.length > 12) {
				const rest = this.parts.splice(11);
				this.parts.push({ label: ctx.strings.other, value: rest.reduce((sum, part) => sum + part.value, 0), color: 'var(--vc-other)' });
			}
			this.total = this.parts.reduce((sum, part) => sum + part.value, 0);
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.parts.map(part => part.value));
			this.centerText = str(spec.centerLabel, 40) ?? ctx.strings.total;
			// "pie" (or hole 0) fills the middle; the center label needs a hole to sit in.
			this.hole = isNum(spec.hole) ? clamp(spec.hole, 0, 0.9) : spec.type === 'pie' ? 0 : 0.66;
			this.fillStyle = oneOf(spec.fill, ['solid', 'gradient', 'pattern'] as const) ?? 'solid';
			this.grow = spec.hover === 'grow';
			this.centerValueSpec = str(spec.centerValue, 24);
			const wrap = h('div', 'vc-donut', this.element);
			this.svg = s('svg', { role: 'img' }, wrap);
			this.list = h('div', 'vc-donut-list', wrap);
			this.list.setAttribute('role', 'list');
			this.centerValue = s('text', { class: 'vc-donut-center-value', 'text-anchor': 'middle' });
			this.centerLabel = s('text', { class: 'vc-donut-center-label', 'text-anchor': 'middle' });
			// Values that are already shares of the whole (percents summing to 100) would print twice.
			const sharesGiven = this.sharesGiven = (this.unit.kind === 'percent' && Math.abs(this.total - 100) < 0.5) || (this.unit.kind === 'ratio' && Math.abs(this.total - 1) < 0.005);
			this.parts.forEach((part, index) => {
				const item = h('div', 'vc-donut-item', this.list);
				item.tabIndex = 0;
				item.setAttribute('role', 'listitem');
				const swatch = h('span', 'vc-swatch', item);
				swatch.style.background = part.color;
				h('span', 'vc-tip-name', item, part.label);
				h('span', 'vc-tip-value', item, formatValue(part.value, this.unit));
				if (!sharesGiven) {
					h('span', 'vc-donut-share', item, formatPercent((part.value / (this.total || 1)) * 100));
				}
				item.addEventListener('pointerenter', () => this.setActive(index));
				item.addEventListener('pointerleave', () => this.setActive(-1));
				item.addEventListener('focus', () => this.setActive(index));
				item.addEventListener('blur', () => this.setActive(-1));
				item.addEventListener('click', () => part.href && this.ctx.onOpen?.(part.href));
				item.addEventListener('keydown', event => {
					if (event.key === 'Enter' && part.href) {
						this.ctx.onOpen?.(part.href);
					} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						this.items[clamp(index + (event.key === 'ArrowDown' ? 1 : -1), 0, this.items.length - 1)]?.focus();
					}
				});
				this.items.push(item);
			});
			this.svg.setAttribute('aria-label', this.parts.map(part => `${part.label} ${formatPercent((part.value / (this.total || 1)) * 100)}`).join(', '));
		}

		layout(width: number): void {
			const size = Math.round(clamp(width < 440 ? width * 0.52 : 184, 120, 220));
			if (size === this.size && this.drawn) {
				return;
			}
			this.size = size;
			setAttrs(this.svg, { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
			this.svg.replaceChildren();
			this.arcs = this.parts.map(part => {
				const arc = s('path', { class: 'vc-arc' }, this.svg);
				arc.style.fill = this.sliceFill(part.color, this.parts.indexOf(part));
				return arc;
			});
			this.arcs.forEach((arc, index) => {
				arc.addEventListener('pointerenter', () => this.setActive(index));
				arc.addEventListener('pointerleave', () => this.setActive(-1));
				arc.addEventListener('click', () => this.parts[index].href && this.ctx.onOpen?.(this.parts[index].href!));
			});
			this.svg.appendChild(this.centerValue);
			this.svg.appendChild(this.centerLabel);
			setAttrs(this.centerValue, { x: size / 2, y: size / 2 + 2 });
			setAttrs(this.centerLabel, { x: size / 2, y: size / 2 + 19 });
			this.renderCenter();
			const animate = !this.drawn && this.ctx.animate;
			this.animation?.cancel();
			this.animation = tween(animate ? 620 : 0, t => this.draw(t));
			this.drawn = true;
		}

		private draw(progress: number): void {
			const size = this.size;
			const outer = size / 2 - (this.grow ? 10 : 4);
			const inner = outer * this.hole;
			const pad = this.parts.length > 1 ? 0.012 : 0;
			let angle = -Math.PI / 2;
			const full = Math.PI * 2 * progress;
			this.parts.forEach((part, index) => {
				const sweep = (part.value / (this.total || 1)) * full;
				const start = angle + pad / 2;
				const end = angle + sweep - pad / 2;
				this.arcs[index].setAttribute('d', arcPath(size / 2, size / 2, outer, inner, start, Math.max(start, end)));
				this.geometry[index] = { start, end: Math.max(start, end) };
				const mid = (start + end) / 2;
				this.arcs[index].dataset.dx = String(Math.cos(mid) * 3);
				this.arcs[index].dataset.dy = String(Math.sin(mid) * 3);
				angle += sweep;
			});
		}

		/** Solid, a radial gradient lit from the middle, or hatching at a different angle per slice. */
		private sliceFill(color: string, index: number): string {
			if (this.fillStyle === 'pattern') {
				return pattern(this.svg, 'lines', color, { angle: [45, 135, 0, 90, 22, 158][index % 6], tint: 0.12, ink: 0.85 });
			}
			if (this.fillStyle === 'gradient') {
				const id = nextId('rg');
				const gradient = s('radialGradient', { id, cx: '50%', cy: '50%', r: '60%' }, this.svg);
				for (const [offset, stop] of [['0%', `color-mix(in oklab, ${color} 55%, var(--vc-fg))`], ['100%', color]] as const) {
					s('stop', { offset }, gradient).style.stopColor = stop;
				}
				return `url(#${id})`;
			}
			return color;
		}

		private renderCenter(): void {
			if (this.hole < 0.45) {
				this.centerValue.textContent = '';
				this.centerLabel.textContent = '';
				return;
			}
			if (!this.parts[this.active] && this.centerValueSpec !== undefined) {
				this.centerValue.textContent = this.centerValueSpec;
				this.centerLabel.textContent = this.centerText;
				return;
			}
			// Shares always total 100%, which says nothing: at rest the middle names the largest part.
			const part = this.parts[this.active] ?? (this.sharesGiven ? this.parts[0] : undefined);
			this.centerValue.textContent = part ? formatPercent((part.value / (this.total || 1)) * 100) : formatValue(this.total, this.unit);
			this.centerLabel.textContent = part ? ellipsize(part.label, '400 11px system-ui', this.size * 0.5) : this.centerText;
		}

		private setActive(index: number): void {
			this.active = index;
			this.arcs.forEach((arc, at) => {
				arc.style.opacity = index < 0 || at === index ? '' : '0.32';
				if (this.grow) {
					// Grow: the hovered slice reaches outward instead of sliding.
					const geometry = this.geometry[at];
					const outer = this.size / 2 - 10;
					if (geometry) {
						arc.setAttribute('d', arcPath(this.size / 2, this.size / 2, outer + (at === index ? 7 : 0), outer * this.hole, geometry.start, geometry.end));
					}
				} else {
					arc.style.transform = at === index ? `translate(${arc.dataset.dx}px,${arc.dataset.dy}px)` : '';
				}
				arc.style.filter = at === index ? glow(this.parts[at].color) : '';
			});
			this.items.forEach((item, at) => item.classList.toggle('vc-active', at === index));
			this.renderCenter();
		}

		dispose(): void {
			this.animation?.cancel();
		}
	}

	/** A ranked list with bars: hottest files, top models, slowest tools. */
	class RankedBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly grid: HTMLElement;
		private readonly parts: IPart[];
		private readonly unit: IUnit;
		private readonly limit: number;
		private readonly heat: boolean;
		private readonly mono: boolean;
		private readonly tip: Tip;
		private expanded = false;
		private drawn = false;
		private width = 0;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.parts = readParts(partsData(spec), problems, where).sort((a, b) => b.value - a.value);
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.parts.map(part => part.value));
			this.limit = isNum(spec.limit) ? clamp(Math.round(spec.limit), 1, 500) : 10;
			this.heat = spec.color === 'heat' || spec.colors === 'heat';
			this.mono = spec.mono === true || (spec.mono !== false && this.parts.length > 0 && this.parts.every(part => /[/\\.]/.test(part.label) && !/\s/.test(part.label)));
			this.grid = h('div', `vc-ranked${this.mono ? ' vc-mono' : ''}`, this.element);
			this.grid.setAttribute('role', 'list');
			this.tip = new Tip(this.element);
		}

		layout(width: number): void {
			if (this.drawn && width === this.width) {
				return;
			}
			this.width = width;
			this.render(!this.drawn && this.ctx.animate);
			this.drawn = true;
		}

		private render(animate: boolean): void {
			this.grid.replaceChildren();
			this.element.querySelector('.vc-more')?.remove();
			const max = Math.max(...this.parts.map(part => Math.abs(part.value)), 0) || 1;
			const shown = this.expanded ? this.parts : this.parts.slice(0, this.limit);
			const font = this.mono ? `400 12px ${monoFamily(this.element)}` : `400 13px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			shown.forEach((part, index) => {
				const row = h('div', `vc-ranked-row${part.href ? ' vc-link' : ''}`, this.grid);
				row.setAttribute('role', 'listitem');
				row.tabIndex = 0;
				const label = h('span', 'vc-ranked-label', row);
				const shownLabel = this.mono ? fitPath(part.label, font, label.clientWidth) : part.label;
				const slash = this.mono ? Math.max(shownLabel.lastIndexOf('/'), shownLabel.lastIndexOf('\\')) : -1;
				if (slash > 0) {
					h('span', 'vc-dir', label, shownLabel.slice(0, slash + 1));
					label.append(shownLabel.slice(slash + 1));
				} else {
					label.textContent = shownLabel;
				}
				label.title = part.label;
				const barCell = h('span', 'vc-ranked-bar', row);
				const bar = h('i', '', barCell);
				const share = Math.abs(part.value) / max;
				bar.style.width = `${Math.max(1.5, share * 100)}%`;
				bar.style.background = this.heat ? spectrumColor(0.35 + share * 0.65) : part.color === PALETTE[index % PALETTE.length] ? 'var(--vc-accent)' : part.color;
				if (animate && !reducedMotion()) {
					bar.style.transform = 'scaleX(0)';
					bar.style.transitionDelay = `${index * 24}ms`;
					win.requestAnimationFrame(() => win.requestAnimationFrame(() => bar.style.transform = ''));
				}
				h('span', 'vc-ranked-value', row, formatValue(part.value, this.unit));
				const open = () => part.href && this.ctx.onOpen?.(part.href);
				row.addEventListener('click', open);
				row.addEventListener('keydown', event => {
					if (event.key === 'Enter') {
						open();
					} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						const rows = this.grid.querySelectorAll<HTMLElement>('.vc-ranked-row');
						rows[clamp(index + (event.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)]?.focus();
					}
				});
				if (part.detail || textWidth(part.label, font) > label.clientWidth) {
					row.addEventListener('pointerenter', () => {
						this.tip.set({ title: part.label, hero: formatValue(part.value, this.unit, true), sub: part.detail, hint: part.href ? this.ctx.strings.open : undefined });
						this.tip.show();
						const hostRect = this.element.getBoundingClientRect();
						const rowRect = label.getBoundingClientRect();
						this.tip.place(rowRect.left - hostRect.left + Math.min(rowRect.width, 220), rowRect.top - hostRect.top + rowRect.height / 2, this.width, 0, this.element.clientHeight);
					});
					row.addEventListener('pointerleave', () => this.tip.hide());
				}
			});
			if (this.parts.length > this.limit) {
				const more = h('button', 'vc-more', this.element, this.expanded ? this.ctx.strings.showLess : `${this.ctx.strings.showAll} ${this.parts.length}`);
				more.type = 'button';
				more.addEventListener('click', () => {
					this.expanded = !this.expanded;
					this.render(false);
				});
			}
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Showcase charts: gauge, ring, radar, funnel, sunburst, sankey, candlestick

	/*
	 * These enter the way bklit's charts do: a 1.1s ease-in-out with items staggered in turn, and
	 * hover answers on a spring with a touch of overshoot. Plain SVG, Web Animations and CSS
	 * transitions; reduced motion skips all of it.
	 */
	const ENTER_MS = 1100;
	const ENTER_CSS = 'cubic-bezier(0.85, 0, 0.15, 1)';

	/** A CSS cubic-bezier as a function of t, for frame loops that must match a CSS easing. */
	function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
		const cx = 3 * x1;
		const bx = 3 * (x2 - x1) - cx;
		const ax = 1 - cx - bx;
		const cy = 3 * y1;
		const by = 3 * (y2 - y1) - cy;
		const ay = 1 - cy - by;
		const curveX = (t: number) => ((ax * t + bx) * t + cx) * t;
		return (x: number) => {
			let lo = 0;
			let hi = 1;
			let t = x;
			for (let step = 0; step < 24; step++) {
				const value = curveX(t);
				if (Math.abs(value - x) < 1e-5) {
					break;
				}
				if (value < x) {
					lo = t;
				} else {
					hi = t;
				}
				t = (lo + hi) / 2;
			}
			return ((ay * t + by) * t + cy) * t;
		};
	}

	const enterEase = cubicBezier(0.85, 0, 0.15, 1);
	const zoomEase = cubicBezier(0.22, 1, 0.36, 1);

	interface ISpringCss {
		readonly ms: number;
		readonly easing: string;
	}

	/** A mass-1 spring sampled into a CSS `linear()` easing, so transitions get it without a frame loop. */
	function springCss(stiffness: number, damping: number): ISpringCss {
		const samples = [0];
		const dt = 1 / 240;
		let x = 0;
		let v = 0;
		let t = 0;
		let still = 0;
		while (t < 2.5 && still < 24) {
			v += (-stiffness * (x - 1) - damping * v) * dt;
			x += v * dt;
			t += dt;
			if (Math.round(t * 240) % 4 === 0) {
				samples.push(x);
			}
			still = Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02 ? still + 1 : 0;
		}
		samples.push(1);
		return { ms: Math.round(t * 1000), easing: `linear(${samples.map(value => value.toFixed(3)).join(',')})` };
	}

	const HOVER_SPRING = springCss(400, 25);
	const POP_SPRING = springCss(300, 20);
	const SOFT_SPRING = springCss(100, 15);
	const CANDLE_SPRING = springCss(62, 13.3);

	/** Plays `keyframes` once, holding the first frame through `delay`. */
	function enter(node: Element, keyframes: Keyframe[], ms: number, delay = 0, easing = ENTER_CSS): void {
		if (!reducedMotion() && typeof node.animate === 'function') {
			node.animate(keyframes, { duration: ms, delay, easing, fill: 'backwards' });
		}
	}

	/** Like `tween`, with its own easing curve. */
	function play(ms: number, ease: (t: number) => number, frame: (t: number) => void, done?: () => void): ITween {
		if (ms <= 0 || reducedMotion()) {
			frame(1);
			done?.();
			return { cancel: () => { } };
		}
		let handle = 0;
		const start = win.performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			frame(ease(t));
			if (t < 1) {
				handle = win.requestAnimationFrame(step);
			} else {
				handle = 0;
				done?.();
			}
		};
		handle = win.requestAnimationFrame(step);
		return { cancel: () => handle && win.cancelAnimationFrame(handle) };
	}

	/** Pointer position inside `element`, in CSS pixels. */
	function localPoint(event: MouseEvent, element: Element): [number, number] {
		const rect = element.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	}

	function glow(color: string): string {
		return `drop-shadow(0 0 10px color-mix(in srgb, ${color} 55%, transparent))`;
	}

	function origin(node: SVGElement | HTMLElement, x: number, y: number): void {
		node.style.transformOrigin = `${num(x)}px ${num(y)}px`;
	}

	/** Where a point at `angle` (0 = 3 o'clock, clockwise) and `radius` sits. */
	function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
		return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
	}

	//#region Looks: fills, backdrops, bands and the axis pill

	interface IBand {
		readonly from: number;
		readonly to: number;
		readonly label?: string;
		readonly pattern: boolean;
	}

	/** How an agent can style a chart: `style: { ... }` on it, or the same keys on the chart itself. */
	interface ILook {
		readonly fill?: 'gradient' | 'solid' | 'pattern' | 'none';
		readonly stroke: boolean;
		readonly fadeEdges: boolean;
		readonly background: 'none' | 'dots' | 'pattern';
		readonly grid: 'dashed' | 'solid' | 'none';
		readonly barShape: 'rounded' | 'square' | 'pill';
		/** Share of each slot left empty between bars, 0 for touching bars. */
		readonly barGap?: number;
		readonly bands: readonly IBand[];
		/** The date pill that rides the x axis under the cursor. */
		readonly pill: boolean;
	}

	function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
		return typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : undefined;
	}

	function readLook(spec: Record<string, unknown>): ILook {
		const style: Record<string, unknown> = isRecord(spec.style) ? { ...spec, ...spec.style } : spec;
		const bands = (Array.isArray(style.bands) ? style.bands : []).filter(isRecord).slice(0, 6).flatMap(band => {
			const from = isNum(band.from) ? band.from : isNum(band.y0) ? band.y0 : undefined;
			const to = isNum(band.to) ? band.to : isNum(band.y1) ? band.y1 : undefined;
			return from === undefined || to === undefined ? [] : [{ from: Math.min(from, to), to: Math.max(from, to), label: str(band.label, 60), pattern: band.pattern === true || band.fill === 'pattern' }];
		});
		const gap = style.barGap ?? style.gap;
		return {
			fill: oneOf(style.fill, ['gradient', 'solid', 'pattern', 'none'] as const),
			stroke: style.stroke !== false,
			fadeEdges: style.fadeEdges === true,
			background: oneOf(style.background, ['none', 'dots', 'pattern'] as const) ?? 'none',
			grid: oneOf(style.grid, ['dashed', 'solid', 'none'] as const) ?? 'dashed',
			barShape: oneOf(style.barShape ?? style.shape, ['rounded', 'square', 'pill'] as const) ?? 'rounded',
			barGap: isNum(gap) ? clamp(gap, 0, 0.9) : undefined,
			bands,
			pill: style.pill !== false,
		};
	}

	/** Hatching or a dot grid in `color`, defined inside `parent` so it goes away with its chart. */
	function pattern(parent: Element, kind: 'lines' | 'dots', color: string, options?: { readonly angle?: number; readonly tint?: number; readonly ink?: number }): string {
		const id = nextId('pt');
		const size = kind === 'dots' ? 10 : 6;
		const node = s('pattern', { id, patternUnits: 'userSpaceOnUse', width: size, height: size, patternTransform: kind === 'lines' ? `rotate(${options?.angle ?? 45})` : undefined }, parent);
		if (options?.tint) {
			const back = s('rect', { width: size, height: size }, node);
			back.style.fill = color;
			back.style.fillOpacity = String(options.tint);
		}
		if (kind === 'lines') {
			const line = s('line', { x1: 0, y1: 0, x2: 0, y2: size }, node);
			line.style.stroke = color;
			line.style.strokeWidth = '1.5';
			line.style.strokeOpacity = String(options?.ink ?? 0.7);
		} else {
			const dot = s('circle', { cx: size / 2, cy: size / 2, r: 1.1 }, node);
			dot.style.fill = color;
			dot.style.fillOpacity = String(options?.ink ?? 0.7);
		}
		return `url(#${id})`;
	}

	/** A top-to-bottom gradient between two colors (or one color at two opacities). */
	function verticalGradient(parent: Element, top: string, bottom: string, topOpacity = 1, bottomOpacity = 1): string {
		const id = nextId('vg');
		const gradient = s('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, parent);
		for (const [offset, color, opacity] of [['0%', top, topOpacity], ['100%', bottom, bottomOpacity]] as const) {
			const stop = s('stop', { offset }, gradient);
			stop.style.stopColor = color;
			stop.style.stopOpacity = String(opacity);
		}
		return `url(#${id})`;
	}

	/** A mask that fades its content in over the first and out over the last `edge` of [x0, x1]. */
	function edgeMask(parent: Element, x0: number, x1: number, y0: number, y1: number, edge = 0.06): string {
		const id = nextId('fm');
		const gradient = s('linearGradient', { id: `${id}g`, gradientUnits: 'userSpaceOnUse', x1: x0, x2: x1, y1: 0, y2: 0 }, parent);
		for (const [offset, opacity] of [[0, 0], [edge, 1], [1 - edge, 1], [1, 0]]) {
			const stop = s('stop', { offset: String(offset) }, gradient);
			stop.style.stopColor = '#fff';
			stop.style.stopOpacity = String(opacity);
		}
		const mask = s('mask', { id, maskUnits: 'userSpaceOnUse', x: x0 - 20, y: y0 - 60, width: x1 - x0 + 40, height: y1 - y0 + 120 }, parent);
		s('rect', { x: x0 - 20, y: y0 - 60, width: x1 - x0 + 40, height: y1 - y0 + 120, fill: `url(#${id}g)` }, mask);
		return `url(#${id})`;
	}

	/** A dot-grid or hatched backdrop behind the plot, faded at the sides. */
	function drawBackdrop(layer: SVGGElement, look: ILook, box: IBox): void {
		layer.replaceChildren();
		if (look.background === 'none') {
			return;
		}
		const fill = pattern(layer, look.background === 'dots' ? 'dots' : 'lines', 'var(--vc-fg)', { ink: look.background === 'dots' ? 0.2 : 0.07 });
		const rect = s('rect', { x: box.left, y: box.top, width: Math.max(0, box.right - box.left), height: Math.max(0, box.bottom - box.top), fill }, layer);
		rect.setAttribute('mask', edgeMask(layer, box.left, box.right, box.top, box.bottom, 0.08));
	}

	/** Horizontal reference bands (a target range, a normal band), dashed at both edges. */
	function drawBands(layer: SVGGElement, bands: readonly IBand[], box: IBox, sy: (value: number) => number, unit: IUnit): void {
		for (const band of bands) {
			const y0 = clamp(sy(band.to), box.top, box.bottom);
			const y1 = clamp(sy(band.from), box.top, box.bottom);
			if (y1 - y0 < 1) {
				continue;
			}
			const group = s('g', { class: 'vc-refband' }, layer);
			const rect = s('rect', { x: box.left, y: y0, width: Math.max(0, box.right - box.left), height: y1 - y0 }, group);
			rect.style.fill = band.pattern ? pattern(group, 'lines', 'var(--vc-fg)', { ink: 0.16 }) : 'color-mix(in srgb, var(--vc-fg) 6%, transparent)';
			rect.setAttribute('mask', edgeMask(group, box.left, box.right, y0, y1, 0.04));
			for (const y of [y0, y1]) {
				s('line', { x1: box.left, x2: box.right, y1: crisp(y), y2: crisp(y) }, group);
			}
			// allow-any-unicode-next-line
			s('text', { x: box.right - 4, y: y0 + 13, 'text-anchor': 'end' }, group).textContent = band.label ?? `${formatValue(band.from, unit)} – ${formatValue(band.to, unit)}`;
		}
	}

	const ROLL_SPRING = springCss(400, 35);

	/**
	 * The label riding the x axis under the cursor (bklit's date pill). It glides with the cursor
	 * spring and rolls only the words that change: up when the cursor moves right, down when left.
	 */
	class AxisPill {
		readonly element: HTMLElement;
		private readonly slots: HTMLElement[] = [];
		private words: string[] = [];
		private order = -1;
		private width = 0;

		constructor(parent: HTMLElement) {
			this.element = h('div', 'vc-pill', parent);
			this.element.setAttribute('aria-hidden', 'true');
		}

		set(label: string, order: number): void {
			const words = label.split(' ').filter(Boolean);
			const direction = order >= this.order ? 1 : -1;
			const roll = this.order >= 0 && !reducedMotion();
			this.order = order;
			while (this.slots.length > words.length) {
				this.slots.pop()?.remove();
			}
			words.forEach((word, index) => {
				let slot = this.slots[index];
				if (!slot) {
					slot = h('span', 'vc-pill-slot', this.element);
					this.slots.push(slot);
					this.words[index] = '';
				}
				if (this.words[index] === word) {
					return;
				}
				const previous = slot.lastElementChild;
				// Keep only the current word when a new hover interrupts the previous roll.
				for (const child of [...slot.children]) {
					for (const animation of child.getAnimations()) {
						animation.cancel();
					}
					if (child !== previous) {
						child.remove();
					}
				}
				const next = h('span', 'vc-pill-word', slot, word);
				if (previous && roll) {
					previous.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${-direction * 100}%)`, opacity: 0 }], { duration: ROLL_SPRING.ms, easing: ROLL_SPRING.easing, fill: 'forwards' }).onfinish = () => previous.remove();
					next.animate([{ transform: `translateY(${direction * 100}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: ROLL_SPRING.ms, easing: ROLL_SPRING.easing });
				} else {
					previous?.remove();
				}
				this.words[index] = word;
			});
			this.words = this.words.slice(0, words.length);
			this.width = this.element.offsetWidth;
		}

		place(x: number, top: number, width: number): void {
			const left = clamp(x - this.width / 2, 0, Math.max(0, width - this.width));
			this.element.style.transform = `translate3d(${Math.round(left)}px,${Math.round(top)}px,0)`;
		}

		show(): void {
			this.element.classList.add('vc-shown');
		}

		hide(): void {
			this.element.classList.remove('vc-shown');
			this.order = -1;
			this.dispose();
		}

		dispose(): void {
			for (const slot of this.slots) {
				for (const child of [...slot.children]) {
					for (const animation of child.getAnimations()) {
						animation.cancel();
					}
					if (child !== slot.lastElementChild) {
						child.remove();
					}
				}
			}
		}
	}

	/** Axis tick labels the pill covers fade out, and come back as it moves on. */
	function fadeTicks(layer: SVGGElement, x: number | undefined): void {
		for (const text of layer.querySelectorAll<SVGTextElement>('text')) {
			const cx = Number(text.dataset.cx);
			const distance = x === undefined || !Number.isFinite(cx) ? Infinity : Math.abs(cx - x);
			text.style.opacity = distance < 44 ? '0' : distance < 64 ? String((distance - 44) / 20) : '';
		}
	}

	//#endregion

	//#region Gauge and rings

	interface IMeter {
		readonly label: string;
		readonly value: number;
		readonly max: number;
		readonly color: string;
		readonly detail?: string;
		readonly href?: string;
	}

	/** `data: [{ label, value, max? }]`, or one meter from `value` / `max` / `label` on the spec itself. */
	function readMeters(spec: Record<string, unknown>, unit: IUnit, problems: string[], where: string): IMeter[] {
		const raw = Array.isArray(spec.data) ? spec.data.filter(isRecord) : isNum(spec.value) ? [{ label: spec.label ?? spec.title, value: spec.value, max: spec.max }] : [];
		const values = raw.map(item => item.value).filter(isNum);
		const fallbackMax = isNum(spec.max) ? spec.max
			: unit.kind === 'percent' ? 100
				: unit.kind === 'ratio' || values.every(value => value <= 1) ? 1
					: values.every(value => value <= 100) ? 100
						: Math.max(...values, 1);
		const meters = raw.slice(0, 12).flatMap((item, index) => {
			const value = item.value;
			if (!isNum(value)) {
				problems.push(`${where}: item ${index + 1} needs a numeric "value".`);
				return [];
			}
			const max = isNum(item.max) && item.max > 0 ? item.max : fallbackMax;
			return [{ label: str(item.label ?? item.name, 80) ?? '', value, max, color: seriesColor(item.color, index, str(item.label)), detail: str(item.detail, 200), href: safeHref(item.href) }];
		});
		if (!meters.length) {
			problems.push(`${where}: give "value": 72 (with "max"), or "data": [{ "label": "...", "value": 72, "max": 100 }].`);
		}
		return meters;
	}

	/**
	 * Notches that light up to the value, on a 270-degree arc or a straight track. Notches can be square
	 * wedges, soft or fully round, shallow or deep, and take a two-color ramp; several readings get
	 * a switcher.
	 */
	class GaugeBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly unit: IUnit;
		private readonly meters: IMeter[];
		private readonly notches: number;
		private readonly linear: boolean;
		private readonly notchStyle: 'square' | 'soft' | 'round';
		private readonly depth: number;
		private readonly ramp: readonly [string, string] | undefined;
		private readonly labelPlacement: 'center' | 'below' | 'none';
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly center: HTMLElement;
		private readonly valueEl: HTMLElement;
		private readonly labelEl: HTMLElement;
		private readonly caption: HTMLElement;
		private lit: SVGElement[] = [];
		private litCount = 0;
		private index = 0;
		private shown = 0;
		private width = 0;
		private drawn = false;
		private counter: ITween | undefined;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const values = (Array.isArray(spec.data) ? spec.data.filter(isRecord).map(item => item.value) : [spec.value]).filter(isNum);
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, values);
			this.meters = readMeters(spec, this.unit, problems, where);
			this.notches = isNum(spec.notches) ? clamp(Math.round(spec.notches), 8, 120) : spec.shape === 'linear' ? 64 : 40;
			this.linear = spec.shape === 'linear' || spec.orientation === 'linear' || spec.orientation === 'horizontal';
			this.notchStyle = oneOf(spec.notch ?? spec.notchStyle, ['square', 'soft', 'round'] as const) ?? (this.linear ? 'soft' : 'square');
			this.depth = isNum(spec.depth) ? clamp(spec.depth, 0.15, 1) : 1;
			const colors = (Array.isArray(spec.colors) ? spec.colors : []).map(cssColor).filter((color): color is string => !!color);
			this.ramp = colors.length ? [colors[0], colors[colors.length - 1]] : undefined;
			this.labelPlacement = oneOf(spec.labelPlacement, ['center', 'below', 'none'] as const) ?? (this.linear ? 'below' : 'center');
			if (this.meters.length > 1) {
				segmented(this.element, str(spec.title) ?? ctx.strings.chart, this.meters.map((meter, index) => ({ id: String(index), label: meter.label })), '0', id => this.select(Number(id), true));
			}
			this.plot = h('div', `vc-plot vc-gauge${this.linear ? ' vc-gauge-linear' : ''}`, this.element);
			this.svg = s('svg', { class: 'vc-svg', role: 'img' }, this.plot);
			this.center = h('div', `vc-gauge-center vc-at-${this.labelPlacement}`, this.plot);
			this.valueEl = h('div', 'vc-gauge-value', this.center);
			this.labelEl = h('div', 'vc-gauge-label', this.center);
			this.caption = h('div', 'vc-note vc-gauge-caption', this.element);
		}

		private notchColor(index: number, lit: boolean): string {
			const t = index / Math.max(1, this.notches - 1);
			if (this.ramp) {
				const color = `color-mix(in oklab, ${this.ramp[1]} ${Math.round(t * 100)}%, ${this.ramp[0]})`;
				return lit ? color : `color-mix(in srgb, ${color} 20%, transparent)`;
			}
			return lit ? `color-mix(in oklab, var(--vc-accent) ${Math.round(42 + 58 * t)}%, var(--vc-bg))` : '';
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const animate = !this.drawn && this.ctx.animate;
			this.svg.replaceChildren();
			this.lit = [];
			if (this.linear) {
				this.layoutLinear(width, animate);
			} else {
				this.layoutArc(width, animate);
			}
			this.litCount = 0;
			this.select(this.index, animate);
			this.drawn = true;
		}

		private addNotch(make: () => SVGElement, index: number, cx: number, cy: number, animate: boolean, fromCenter: boolean): void {
			const track = make();
			track.classList.add('vc-gauge-track');
			const trackColor = this.notchColor(index, false);
			if (trackColor) {
				track.style.color = trackColor;
			}
			const lit = make();
			lit.classList.add('vc-gauge-lit');
			lit.style.color = this.notchColor(index, true);
			origin(track, cx, cy);
			origin(lit, cx, cy);
			if (animate) {
				enter(track, [{ transform: fromCenter ? 'scale(0)' : 'scaleY(0)', opacity: 0 }, { transform: 'none', opacity: 1 }], POP_SPRING.ms, index * (fromCenter ? 15 : 6), POP_SPRING.easing);
			}
			this.lit.push(lit);
		}

		private layoutArc(width: number, animate: boolean): void {
			const size = Math.round(clamp(width < 440 ? width * 0.78 : width * 0.5, 170, 280));
			const cx = size / 2;
			const cy = size * 0.52;
			const outer = size * 0.46;
			const inner = outer - (outer - size * 0.31) * this.depth;
			const height = Math.round(size * 0.9);
			setAttrs(this.svg, { width: size, height, viewBox: `0 0 ${size} ${height}` });
			this.center.style.top = `${Math.round(cy - 26)}px`;
			const start = Math.PI * 0.75;
			const slot = (Math.PI * 1.5) / this.notches;
			for (let index = 0; index < this.notches; index++) {
				const a0 = start + index * slot + slot * 0.1;
				const a1 = a0 + slot * 0.8;
				this.addNotch(() => {
					if (this.notchStyle === 'square') {
						return s('path', { d: arcPath(cx, cy, outer, inner, a0, a1), class: 'vc-gauge-notch' }, this.svg);
					}
					// Soft and round notches are radial strokes with round caps, so their tips are filleted.
					const mid = (a0 + a1) / 2;
					const thick = Math.max(2, ((a1 - a0) * (outer + inner)) / 2 * (this.notchStyle === 'round' ? 1.15 : 0.8));
					let r0 = inner + thick / 2;
					let r1 = outer - thick / 2;
					if (r1 < r0) {
						r0 = r1 = (r0 + r1) / 2;
					}
					const [x0, y0] = polar(cx, cy, r0, mid);
					const [x1, y1] = polar(cx, cy, r1, mid);
					return s('line', { x1: x0, y1: y0, x2: x1, y2: y1, 'stroke-width': num(thick), class: 'vc-gauge-notch vc-gauge-cap' }, this.svg);
				}, index, cx, cy, animate, true);
			}
		}

		private layoutLinear(width: number, animate: boolean): void {
			const barHeight = Math.round(8 + 24 * this.depth);
			setAttrs(this.svg, { width, height: barHeight, viewBox: `0 0 ${width} ${barHeight}` });
			const slot = width / this.notches;
			const notchWidth = Math.max(1.5, slot * (this.notchStyle === 'round' ? 0.62 : 0.55));
			const radius = this.notchStyle === 'square' ? 0.5 : this.notchStyle === 'soft' ? Math.min(2.5, notchWidth / 2) : notchWidth / 2;
			for (let index = 0; index < this.notches; index++) {
				const x = index * slot + (slot - notchWidth) / 2;
				this.addNotch(() => s('rect', { x, y: 0, width: notchWidth, height: barHeight, rx: radius, class: 'vc-gauge-notch' }, this.svg), index, x + notchWidth / 2, barHeight, animate, false);
			}
		}

		private select(index: number, animate: boolean): void {
			const meter = this.meters[index];
			if (!meter) {
				return;
			}
			this.index = index;
			const count = Math.round(clamp(meter.value / meter.max, 0, 1) * this.notches);
			const first = !this.drawn;
			this.lit.forEach((notch, at) => {
				const on = at < count;
				if (animate && on && at >= this.litCount) {
					enter(notch, [{ opacity: 0, transform: this.linear ? 'scaleY(.4)' : 'scale(.6)' }, { opacity: 1, transform: 'none' }], POP_SPRING.ms, (first ? 300 : 0) + (at - (first ? 0 : this.litCount)) * (this.linear ? 10 : 20), POP_SPRING.easing);
				}
				notch.style.opacity = on ? '1' : '0';
			});
			this.litCount = count;
			const from = this.shown;
			this.shown = meter.value;
			this.counter?.cancel();
			this.counter = tween(animate ? 900 : 0, t => this.valueEl.textContent = formatValue(from + (meter.value - from) * t, this.unit));
			this.labelEl.textContent = meter.label;
			this.caption.textContent = meter.detail ?? `${formatValue(meter.value, this.unit, true)} / ${formatValue(meter.max, this.unit, true)}`;
			this.svg.setAttribute('aria-label', `${meter.label} ${formatValue(meter.value, this.unit, true)}`);
		}

		dispose(): void {
			this.counter?.cancel();
		}
	}

	/**
	 * Concentric progress rings, one per meter, on a full circle, three quarters or a half. Caps
	 * are round or flat; the legend is a list or a list with progress bars.
	 */
	class RingBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly unit: IUnit;
		private readonly meters: IMeter[];
		private readonly sweep: number;
		private readonly caps: 'round' | 'flat';
		private readonly thickSpec?: number;
		private readonly gapSpec?: number;
		private readonly centerValueSpec?: string;
		private readonly centerLabelSpec?: string;
		private readonly svg: SVGSVGElement;
		private readonly list: HTMLElement;
		private readonly centerValue: SVGTextElement;
		private readonly centerLabel: SVGTextElement;
		private groups: SVGGElement[] = [];
		private readonly items: HTMLElement[] = [];
		private active = -1;
		private size = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const values = (Array.isArray(spec.data) ? spec.data.filter(isRecord).map(item => item.value) : []).filter(isNum);
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, values);
			this.meters = readMeters(spec, this.unit, problems, where).slice(0, 6);
			this.sweep = spec.arc === 270 || spec.arc === '270' ? 270 : spec.arc === 180 || spec.arc === '180' ? 180 : 360;
			this.caps = spec.caps === 'flat' || spec.caps === 'butt' ? 'flat' : 'round';
			this.thickSpec = isNum(spec.thickness) ? clamp(spec.thickness, 4, 40) : undefined;
			this.gapSpec = isNum(spec.gap) ? clamp(spec.gap, 0, 30) : undefined;
			this.centerValueSpec = isNum(spec.centerValue) ? formatValue(spec.centerValue, this.unit) : str(spec.centerValue, 24);
			this.centerLabelSpec = str(spec.centerLabel, 40);
			const bars = spec.legend === 'bars';
			const wrap = h('div', `vc-donut${bars ? ' vc-ring-stack' : ''}`, this.element);
			this.svg = s('svg', { role: 'img', class: 'vc-ring' }, wrap);
			this.list = h('div', `vc-donut-list${bars ? ' vc-ring-bars' : ''}`, wrap);
			this.list.setAttribute('role', 'list');
			if (spec.legend === 'none') {
				this.list.style.display = 'none';
			}
			this.centerValue = s('text', { class: 'vc-donut-center-value', 'text-anchor': 'middle' });
			this.centerLabel = s('text', { class: 'vc-donut-center-label', 'text-anchor': 'middle' });
			this.meters.forEach((meter, index) => {
				const item = h('div', 'vc-donut-item', this.list);
				item.tabIndex = 0;
				item.setAttribute('role', 'listitem');
				const line = bars ? h('div', 'vc-ring-row', item) : item;
				h('span', 'vc-swatch', line).style.background = meter.color;
				h('span', 'vc-tip-name', line, meter.label);
				h('span', 'vc-tip-value', line, formatValue(meter.value, this.unit));
				// A percent out of 100 is already its own share.
				if (!(this.unit.kind === 'percent' && meter.max === 100)) {
					h('span', 'vc-donut-share', line, formatPercent((meter.value / meter.max) * 100));
				}
				if (bars) {
					const fill = h('i', '', h('span', 'vc-ring-progress', item));
					fill.style.width = `${clamp(meter.value / meter.max, 0, 1) * 100}%`;
					fill.style.background = meter.color;
				}
				item.addEventListener('pointerenter', () => this.setActive(index));
				item.addEventListener('pointerleave', () => this.setActive(-1));
				item.addEventListener('focus', () => this.setActive(index));
				item.addEventListener('blur', () => this.setActive(-1));
				item.addEventListener('click', () => meter.href && this.ctx.onOpen?.(meter.href));
				this.items.push(item);
			});
			this.svg.setAttribute('aria-label', this.meters.map(meter => `${meter.label} ${formatValue(meter.value, this.unit, true)}`).join(', '));
		}

		layout(width: number): void {
			const size = Math.round(clamp(width < 440 ? width * 0.56 : 196, 140, 240));
			if (size === this.size && this.drawn) {
				return;
			}
			this.size = size;
			const animate = !this.drawn && this.ctx.animate;
			const half = this.sweep === 180;
			const height = half ? Math.round(size * 0.58) : size;
			setAttrs(this.svg, { width: size, height, viewBox: `0 0 ${size} ${height}` });
			this.svg.replaceChildren();
			const c = size / 2;
			const cy = half ? height - 6 : c;
			const thick = this.thickSpec ?? clamp(size * 0.065, 8, 15);
			const gap = this.gapSpec ?? thick * 0.5;
			// Where the arc starts, in SVG degrees (0 = 3 o'clock): the top, the bottom, or the left.
			const rotation = this.sweep === 360 ? -90 : this.sweep === 270 ? 90 : 180;
			const span = this.sweep / 360;
			this.groups = [];
			this.meters.forEach((meter, index) => {
				const radius = (half ? Math.min(c, cy) : c) - 4 - thick / 2 - index * (thick + gap);
				if (radius < thick) {
					return;
				}
				const length = 2 * Math.PI * radius;
				const share = clamp(meter.value / meter.max, 0, 1);
				const group = s('g', { class: 'vc-ring-g' }, this.svg);
				origin(group, c, cy);
				const turn = `rotate(${rotation} ${num(c)} ${num(cy)})`;
				const linecap = this.caps === 'round' ? 'round' : 'butt';
				s('circle', { cx: c, cy, r: radius, class: 'vc-ring-track', 'stroke-width': thick, 'stroke-linecap': linecap, 'stroke-dasharray': `${num(length * span)} ${num(length)}`, transform: turn }, group);
				const arc = s('circle', { cx: c, cy, r: radius, class: 'vc-ring-arc', 'stroke-width': thick, 'stroke-linecap': linecap, 'stroke-dasharray': `${num(length * span * share)} ${num(length)}`, transform: turn }, group);
				arc.style.stroke = meter.color;
				s('circle', { cx: c, cy, r: radius, class: 'vc-ring-hit', 'stroke-width': thick + gap, 'stroke-dasharray': `${num(length * span)} ${num(length)}`, transform: turn }, group);
				group.addEventListener('pointerenter', () => this.setActive(index));
				group.addEventListener('pointerleave', () => this.setActive(-1));
				group.addEventListener('click', () => meter.href && this.ctx.onOpen?.(meter.href));
				if (animate) {
					enter(group, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], ENTER_MS, index * 80);
					enter(arc, [{ strokeDasharray: `0 ${num(length)}` }, { strokeDasharray: `${num(length * span * share)} ${num(length)}` }], ENTER_MS, 600 + index * 100);
				}
				this.groups.push(group);
			});
			this.svg.appendChild(this.centerValue);
			this.svg.appendChild(this.centerLabel);
			setAttrs(this.centerValue, { x: c, y: half ? cy - 22 : cy + 2 });
			setAttrs(this.centerLabel, { x: c, y: half ? cy - 5 : cy + 19 });
			this.renderCenter();
			this.drawn = true;
		}

		private renderCenter(): void {
			const meter = this.meters[this.active];
			const lead = this.meters[0];
			if (!meter && this.centerValueSpec !== undefined) {
				this.centerValue.textContent = this.centerValueSpec;
				this.centerLabel.textContent = this.centerLabelSpec ?? '';
				return;
			}
			const shown = meter ?? lead;
			this.centerValue.textContent = shown ? formatValue(shown.value, this.unit) : '';
			this.centerLabel.textContent = shown ? ellipsize(meter ? shown.label : this.centerLabelSpec ?? shown.label, '400 11px system-ui', this.size * 0.42) : '';
		}

		private setActive(index: number): void {
			this.active = index;
			this.groups.forEach((group, at) => {
				group.style.transform = index < 0 ? '' : at === index ? 'scale(1.03)' : at < index ? 'scale(1.02)' : '';
				group.style.opacity = index < 0 || at === index ? '' : '0.35';
				group.style.filter = at === index ? glow(this.meters[at].color) : '';
			});
			this.items.forEach((item, at) => item.classList.toggle('vc-active', at === index));
			this.renderCenter();
		}

		dispose(): void { }
	}

	//#endregion

	//#region Radar

	interface IRadarAxis {
		readonly label: string;
		readonly unit: IUnit;
		readonly max: number;
	}

	interface IRadarSeries {
		readonly name: string;
		readonly color: string;
		readonly values: readonly number[];
	}

	/** Several entities compared across 3-12 measures. Each axis is scaled to its largest value unless a shared `max` is given. */
	class RadarBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly axes: IRadarAxis[];
		private readonly series: IRadarSeries[];
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly tip: Tip;
		private readonly legendItems: HTMLElement[] = [];
		private areas: { group: SVGGElement; polygon: SVGPolygonElement; dots: SVGCircleElement[] }[] = [];
		private width = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const rawAxes = Array.isArray(spec.axes) ? spec.axes.slice(0, 12) : Array.isArray(spec.categories) ? spec.categories.slice(0, 12) : [];
			const rawSeries = (Array.isArray(spec.series) ? spec.series : []).filter(isRecord).slice(0, 8);
			const unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`);
			this.series = rawSeries.map((series, index) => {
				const name = str(series.name, 80) ?? `${index + 1}`;
				const values = (Array.isArray(series.data) ? series.data : []).slice(0, rawAxes.length).map(value => isNum(value) ? value : 0);
				if (values.length !== rawAxes.length) {
					problems.push(`${where}: series "${name}" needs one value per axis (${rawAxes.length}).`);
				}
				return { name, color: seriesColor(series.color, index, name), values };
			});
			this.axes = rawAxes.map((axis, index) => {
				const record: Record<string, unknown> = isRecord(axis) ? axis : { label: axis };
				const own = Math.max(...this.series.map(series => series.values[index] ?? 0), 0);
				return {
					label: str(record.label ?? record.name, 40) ?? `${index + 1}`,
					unit: record.unit !== undefined ? resolveUnit(record.unit) : unit,
					max: isNum(record.max) && record.max > 0 ? record.max : isNum(spec.max) && spec.max > 0 ? spec.max : own || 1,
				};
			});
			if (this.axes.length < 3 || !this.series.length) {
				problems.push(`${where}: radars need "axes": ["Speed", "Cost", "Quality", ...] (3 or more) and "series": [{ "name": "...", "data": [one per axis] }].`);
			}
			this.plot = h('div', 'vc-plot', this.element);
			this.svg = s('svg', { class: 'vc-svg', role: 'img' }, this.plot);
			this.svg.setAttribute('aria-label', this.series.map(series => `${series.name}: ${series.values.map((value, index) => `${this.axes[index]?.label} ${formatValue(value, this.axes[index]?.unit ?? unit, true)}`).join(', ')}`).join('; '));
			this.tip = new Tip(this.plot);
			if (this.series.length > 1) {
				const legend = h('div', 'vc-legend vc-legend-static', this.element);
				this.series.forEach((series, index) => {
					const item = h('span', 'vc-legend-item', legend);
					h('span', 'vc-swatch', item).style.background = series.color;
					item.append(series.name);
					item.addEventListener('pointerenter', () => this.highlight(index));
					item.addEventListener('pointerleave', () => this.highlight(-1));
					this.legendItems.push(item);
				});
			}
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const animate = !this.drawn && this.ctx.animate;
			const size = Math.min(width, 420);
			const cx = width / 2;
			const cy = size / 2;
			const radius = Math.max(40, size / 2 - (width < 520 ? 74 : 60));
			const n = this.axes.length;
			const angle = (index: number) => -Math.PI / 2 + (index / n) * Math.PI * 2;
			setAttrs(this.svg, { width, height: size, viewBox: `0 0 ${width} ${size}` });
			this.plot.style.height = `${size}px`;
			this.svg.replaceChildren();
			const grid = s('g', { class: 'vc-radar-grid' }, this.svg);
			for (let level = 1; level <= 5; level++) {
				const points = this.axes.map((_, index) => polar(cx, cy, (radius * level) / 5, angle(index)).map(num).join(',')).join(' ');
				const ring = s('polygon', { points, class: level === 5 ? 'vc-radar-edge' : '' }, grid);
				origin(ring, cx, cy);
				if (animate) {
					enter(ring, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], SOFT_SPRING.ms, level * 80, SOFT_SPRING.easing);
				}
			}
			const font = `600 11.5px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			this.axes.forEach((axis, index) => {
				const [x, y] = polar(cx, cy, radius, angle(index));
				const spoke = s('line', { x1: cx, y1: cy, x2: x, y2: y }, grid);
				origin(spoke, cx, cy);
				const [lx, ly] = polar(cx, cy, radius + 18, angle(index));
				const anchor = Math.abs(lx - cx) < 6 ? 'middle' : lx > cx ? 'start' : 'end';
				const room = anchor === 'middle' ? width : anchor === 'start' ? width - lx - 2 : lx - 2;
				const label = s('text', { x: lx, y: ly, 'text-anchor': anchor, 'dominant-baseline': 'central', class: 'vc-radar-label' }, this.svg);
				label.textContent = ellipsize(axis.label, font, room);
				if (animate) {
					enter(spoke, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], SOFT_SPRING.ms, index * 50, SOFT_SPRING.easing);
					enter(label, [{ transform: `translate(${num(cx - lx)}px,${num(cy - ly)}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], SOFT_SPRING.ms, 200 + index * 80, SOFT_SPRING.easing);
				}
			});
			this.areas = this.series.map((series, si) => {
				const group = s('g', { class: 'vc-radar-area' }, this.svg);
				origin(group, cx, cy);
				const points = series.values.map((value, index) => polar(cx, cy, radius * clamp(value / this.axes[index].max, 0, 1.15), angle(index)));
				const polygon = s('polygon', { points: points.map(point => point.map(num).join(',')).join(' ') }, group);
				polygon.style.fill = series.color;
				polygon.style.stroke = series.color;
				const dots = points.map(([x, y]) => {
					const dot = s('circle', { cx: x, cy: y, r: 3.5 }, group);
					dot.style.fill = series.color;
					return dot;
				});
				polygon.addEventListener('pointerenter', () => this.highlight(si));
				polygon.addEventListener('pointerleave', () => this.highlight(-1));
				if (animate) {
					enter(group, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], ENTER_MS, 600 + si * 150);
				}
				return { group, polygon, dots };
			});
			// Bigger-than-the-dot targets at each vertex compare every series on that axis.
			this.axes.forEach((axis, index) => {
				const [x, y] = polar(cx, cy, radius, angle(index));
				const hit = s('circle', { cx: x, cy: y, r: 16, class: 'vc-radar-hit' }, this.svg);
				hit.addEventListener('pointerenter', () => {
					this.tip.set({ title: axis.label, rows: this.series.map(series => ({ name: series.name, value: formatValue(series.values[index], axis.unit), color: series.color })) });
					this.tip.show();
					this.tip.place(x, y, width, 0, size);
				});
				hit.addEventListener('pointerleave', () => this.tip.hide());
			});
			this.drawn = true;
		}

		private highlight(index: number): void {
			this.areas.forEach((area, at) => {
				const on = at === index;
				area.group.classList.toggle('vc-on', on);
				area.group.style.opacity = index < 0 || on ? '' : '0.3';
				area.group.style.filter = on ? glow(this.series[at].color) : '';
			});
			this.legendItems.forEach((item, at) => item.style.opacity = index < 0 || at === index ? '' : '0.45');
			if (index >= 0) {
				const series = this.series[index];
				this.tip.set({ title: series.name, rows: this.axes.map((axis, at) => ({ name: axis.label, value: formatValue(series.values[at], axis.unit) })) });
				this.tip.show();
				this.tip.place(this.width / 2 + 40, 40, this.width, 0, this.plot.clientHeight);
			} else {
				this.tip.hide();
			}
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Funnel

	/**
	 * Stages that narrow: sign-ups to paying users, files to the hottest few. Vertical (top to
	 * bottom) or horizontal (left to right); curved or straight edges; one color, the palette, or a
	 * ramp; labels beside the funnel or grouped on it.
	 */
	class FunnelBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly parts: IPart[];
		private readonly unit: IUnit;
		private readonly color: string;
		private readonly log: boolean;
		private readonly horizontal: boolean;
		private readonly straight: boolean;
		private readonly colors: 'single' | 'palette' | 'gradient';
		private readonly patterned: boolean;
		private readonly grouped: boolean;
		private readonly grid: boolean;
		private readonly svg: SVGSVGElement;
		private readonly plot: HTMLElement;
		private readonly tip: Tip;
		private segments: { group: SVGGElement; layers: SVGPathElement[]; label: SVGGElement; anchor: [number, number] }[] = [];
		private width = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.parts = readParts(partsData(spec), problems, where).filter(part => part.value >= 0).slice(0, 12);
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.parts.map(part => part.value));
			this.color = cssColor(spec.color) ?? 'var(--vc-accent)';
			const values = this.parts.map(part => part.value).filter(value => value > 0);
			const spread = values.length ? Math.max(...values) / Math.min(...values) : 1;
			this.log = spec.scale === 'log' || (spec.scale !== 'linear' && spread > 40);
			this.horizontal = spec.orientation === 'horizontal';
			this.straight = spec.edges === 'straight';
			this.colors = oneOf(spec.colors, ['single', 'palette', 'gradient'] as const) ?? 'single';
			this.patterned = spec.fill === 'pattern';
			this.grouped = spec.labels === 'grouped';
			this.grid = spec.grid === true || spec.background === 'grid';
			this.plot = h('div', 'vc-plot', this.element);
			this.svg = s('svg', { class: 'vc-svg', role: 'img' }, this.plot);
			this.svg.setAttribute('aria-label', this.parts.map(part => `${part.label} ${formatValue(part.value, this.unit, true)}`).join(', '));
			this.tip = new Tip(this.plot);
			if (this.log) {
				h('div', 'vc-note', this.element, ctx.strings.logScale);
			}
		}

		private stageColor(index: number): string {
			if (this.colors === 'palette') {
				return PALETTE[index % PALETTE.length];
			}
			if (this.colors === 'gradient') {
				return `color-mix(in oklab, var(--vc-fg) ${Math.round((index / Math.max(1, this.parts.length - 1)) * 70)}%, ${this.color})`;
			}
			return this.color;
		}

		private norm(value: number): number {
			const first = this.parts[0]?.value || 1;
			return Math.max(0.04, this.log ? Math.log10(value + 1) / Math.log10(first + 1) : value / first);
		}

		/** A segment between two half-widths, along x (horizontal) or y (vertical). */
		private shape(a0: number, a1: number, half0: number, half1: number, center: number, k: number): string {
			const p = (along: number, across: number) => this.horizontal ? `${num(along)},${num(center + across)}` : `${num(center + across)},${num(along)}`;
			const length = a1 - a0;
			const h0 = half0 * k;
			const h1 = half1 * k;
			if (this.straight) {
				return `M${p(a0, -h0)}L${p(a1, -h1)}L${p(a1, h1)}L${p(a0, h0)}Z`;
			}
			return `M${p(a0, -h0)}C${p(a0 + length * 0.55, -h0)} ${p(a1 - length * 0.55, -h1)} ${p(a1, -h1)}L${p(a1, h1)}C${p(a1 - length * 0.55, h1)} ${p(a0 + length * 0.55, h0)} ${p(a0, h0)}Z`;
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const animate = !this.drawn && this.ctx.animate;
			const parts = this.parts;
			const n = Math.max(1, parts.length);
			const fontFamily = win.getComputedStyle(this.element).fontFamily || 'system-ui';
			const font = `400 12px ${fontFamily}`;
			const first = parts[0]?.value || 1;
			const gapAlong = 4;
			let height: number;
			let segLength: number;
			let center: number;
			let half: number;
			if (this.horizontal) {
				height = width < 440 ? 220 : 260;
				segLength = (width - gapAlong * (n - 1)) / n;
				center = height / 2;
				half = height * 0.32;
			} else {
				segLength = width < 440 ? 46 : 54;
				height = n * (segLength + gapAlong);
				center = this.grouped ? width / 2 : Math.min(width * 0.3, 150);
				half = this.grouped ? Math.min(width * 0.42, 220) : Math.min(width * 0.27, 128);
			}
			setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
			this.plot.style.height = `${height}px`;
			this.svg.replaceChildren();
			if (this.grid) {
				parts.forEach((_, index) => {
					if (index % 2 === 0) {
						const a0 = index * (segLength + gapAlong);
						s('rect', this.horizontal ? { x: a0, y: 0, width: segLength, height, class: 'vc-funnel-band' } : { x: 0, y: a0, width, height: segLength, class: 'vc-funnel-band' }, this.svg);
					}
				});
			}
			this.segments = parts.map((part, index) => {
				const a0 = index * (segLength + gapAlong);
				const a1 = a0 + segLength;
				const half0 = this.norm(part.value) * half;
				const half1 = this.norm(parts[index + 1]?.value ?? part.value * 0.6) * half;
				const color = this.stageColor(index);
				const group = s('g', { class: 'vc-funnel-seg' }, this.svg);
				const pivot: [number, number] = this.horizontal ? [a0, center] : [center, a0];
				origin(group, pivot[0], pivot[1]);
				const layers = [0, 1, 2].map(layer => {
					const path = s('path', { d: this.shape(a0, a1, half0, half1, center, 1 - (layer / 3) * 0.35) }, group);
					path.style.fill = layer === 2 && this.patterned ? pattern(group, 'lines', color, { tint: 0.35, ink: 0.9 }) : color;
					path.style.opacity = String(0.18 + (layer / 2) * 0.65);
					if (this.horizontal) {
						origin(path, (a0 + a1) / 2, center);
					} else {
						origin(path, center, a0 + segLength / 2);
					}
					const spring = springCss(300 - 60 * layer, 24 - 3 * layer);
					path.style.transition = `transform ${spring.ms}ms ${spring.easing}`;
					return path;
				});
				const label = s('g', { class: 'vc-funnel-label' }, this.svg);
				const valueText = formatValue(part.value, this.unit);
				const share = part.value / first;
				const pctText = share >= 0.995 ? '100%' : share < 0.01 ? `${(share * 100).toFixed(2)}%` : formatPercent(share * 100);
				const pillFont = `600 10.5px ${fontFamily}`;
				const pillWidth = textWidth(pctText, pillFont) + 14;
				const pill = (x: number, y: number) => {
					s('rect', { x: x - pillWidth / 2, y: y - 9, width: pillWidth, height: 18, rx: 9, class: 'vc-funnel-pill' }, label);
					s('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 'vc-funnel-pill-text' }, label).textContent = pctText;
				};
				let anchor: [number, number];
				if (this.horizontal) {
					const mid = (a0 + a1) / 2;
					const room = segLength - 8;
					if (this.grouped) {
						s('text', { x: mid, y: center - 24, 'text-anchor': 'middle', class: 'vc-funnel-big' }, label).textContent = valueText;
						pill(mid, center);
						s('text', { x: mid, y: center + 28, 'text-anchor': 'middle', class: 'vc-funnel-value' }, label).textContent = ellipsize(part.label, font, room);
					} else {
						s('text', { x: mid, y: 22, 'text-anchor': 'middle', class: 'vc-funnel-big' }, label).textContent = valueText;
						pill(mid, center);
						s('text', { x: mid, y: height - 10, 'text-anchor': 'middle', class: 'vc-funnel-value' }, label).textContent = ellipsize(part.label, font, room);
					}
					anchor = [mid, center];
				} else if (this.grouped) {
					const mid = a0 + segLength / 2;
					s('text', { x: center - 12, y: mid + 4, 'text-anchor': 'end', class: 'vc-funnel-big' }, label).textContent = valueText;
					pill(center + 12 + pillWidth / 2, mid);
					s('text', { x: width - 4, y: mid + 4, 'text-anchor': 'end', class: 'vc-funnel-value' }, label).textContent = ellipsize(part.label, font, width * 0.25);
					anchor = [center, mid];
				} else {
					const lx = center + half + 18;
					s('text', { x: lx, y: a0 + 21, class: 'vc-funnel-name' }, label).textContent = ellipsize(part.label, `600 12px ${fontFamily}`, width - lx - 4);
					s('text', { x: lx, y: a0 + 39, class: 'vc-funnel-value' }, label).textContent = valueText;
					const px = lx + textWidth(valueText, font) + 8 + pillWidth / 2;
					if (px + pillWidth / 2 < width) {
						pill(px, a0 + 35);
					}
					anchor = [center, a0 + segLength / 2];
				}
				const hit = s('rect', this.horizontal ? { x: a0, y: 0, width: segLength, height, class: 'vc-hit-rect' } : { x: 0, y: a0, width, height: segLength, class: 'vc-hit-rect' }, this.svg);
				hit.addEventListener('pointerenter', () => this.setActive(index));
				hit.addEventListener('pointerleave', () => this.setActive(-1));
				hit.addEventListener('click', () => part.href && this.ctx.onOpen?.(part.href));
				if (animate) {
					enter(group, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], ENTER_MS, index * 120);
					enter(label, [{ opacity: 0 }, { opacity: 1 }], 350, index * 120 + 250, 'ease-out');
				}
				return { group, layers, label, anchor };
			});
			this.drawn = true;
		}

		private setActive(index: number): void {
			this.segments.forEach((segment, at) => {
				const on = at === index;
				segment.group.style.opacity = index < 0 || on ? '' : '0.4';
				segment.label.style.opacity = index < 0 || on ? '' : '0.4';
				// The halo layers swell across the funnel, the inner ones most, each on its own spring.
				segment.layers.forEach((layer, l) => layer.style.transform = on ? `${this.horizontal ? 'scaleY' : 'scaleX'}(${1 + (1 - l / 2) * 0.12})` : '');
			});
			const part = this.parts[index];
			const segment = this.segments[index];
			if (!part || !segment) {
				this.tip.hide();
				return;
			}
			const previous = this.parts[index - 1];
			this.tip.set({
				title: part.label,
				hero: formatValue(part.value, this.unit, true),
				sub: previous ? `${formatPercent((part.value / (previous.value || 1)) * 100)} ${this.ctx.strings.ofPrevious}` : part.detail,
				meta: index ? [[this.ctx.strings.ofFirst, formatPercent((part.value / (this.parts[0].value || 1)) * 100)]] : undefined,
				hint: part.href ? this.ctx.strings.open : undefined,
			});
			this.tip.show();
			this.tip.place(segment.anchor[0], segment.anchor[1], this.width, 0, this.plot.clientHeight);
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Sunburst

	interface IArcState {
		a0: number;
		a1: number;
		r0: number;
		r1: number;
		color: string;
		opacity: number;
	}

	/** A tree as rings: angle is size, rings are depth. Click a ring to zoom into it, the center to go back. */
	class SunburstBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly root: ITreeNode;
		private readonly unit: IUnit;
		private readonly sizeLabel?: string;
		private readonly depth: number;
		private readonly crumbs: HTMLElement;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly arcsLayer: SVGGElement;
		private readonly labelsLayer: SVGGElement;
		private readonly hub: SVGGElement;
		private readonly tip: Tip;
		private readonly paths = new Map<ITreeNode, SVGPathElement>();
		private state = new Map<ITreeNode, IArcState>();
		private focus: ITreeNode;
		private width = 0;
		private size = 0;
		private ringWidth = 0;
		private hubRadius = 0;
		private drawn = false;
		private animation: ITween | undefined;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.root = readTree(spec.data, problems, where);
			this.focus = this.root;
			this.sizeLabel = str(spec.sizeLabel, 40);
			this.unit = resolveUnit(spec.unit, this.sizeLabel);
			this.depth = isNum(spec.depth) ? clamp(Math.round(spec.depth), 1, 6) : 4;
			this.crumbs = h('div', 'vc-tree-crumbs', this.element);
			this.plot = h('div', 'vc-plot', this.element);
			this.plot.tabIndex = 0;
			this.plot.setAttribute('role', 'group');
			this.plot.setAttribute('aria-roledescription', 'sunburst');
			this.plot.setAttribute('aria-label', `${str(spec.title) ?? 'Sunburst'}. Escape zooms out.`);
			this.svg = s('svg', { class: 'vc-svg' }, this.plot);
			this.arcsLayer = s('g', {}, this.svg);
			this.labelsLayer = s('g', { class: 'vc-sb-labels' }, this.svg);
			this.hub = s('g', { class: 'vc-sb-hub' }, this.svg);
			this.tip = new Tip(this.plot);
			this.plot.addEventListener('keydown', event => {
				if (event.key === 'Escape' && this.focus.parent) {
					event.preventDefault();
					this.zoom(this.focus.parent);
				}
			});
			this.plot.addEventListener('contextmenu', event => {
				if (this.focus.parent) {
					event.preventDefault();
					this.zoom(this.focus.parent);
				}
			});
			h('div', 'vc-tree-foot', this.element).append(h('span', 'vc-tree-hint', undefined, ctx.strings.zoomHint));
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			this.size = Math.min(width, 460);
			setAttrs(this.svg, { width, height: this.size, viewBox: `0 0 ${width} ${this.size}` });
			this.plot.style.height = `${this.size}px`;
			const animate = !this.drawn && this.ctx.animate;
			const target = this.layoutFor(this.focus);
			this.renderHub();
			this.renderCrumbs();
			this.labelsLayer.replaceChildren();
			for (const [node, path] of this.paths) {
				if (!target.has(node)) {
					path.remove();
					this.paths.delete(node);
				}
			}
			this.state = target;
			this.animation?.cancel();
			if (animate && !reducedMotion()) {
				const items = [...target];
				const delayOf = (arc: IArcState) => Math.round((arc.r0 - this.hubRadius) / (this.ringWidth || 1)) * 120 + ((arc.a0 + Math.PI / 2) / (Math.PI * 2)) * 450;
				const longest = Math.max(0, ...items.map(([, arc]) => delayOf(arc)));
				this.animation = play(longest + ENTER_MS, t => t, t => {
					const now = t * (longest + ENTER_MS);
					for (const [node, arc] of items) {
						const p = enterEase(clamp((now - delayOf(arc)) / ENTER_MS, 0, 1));
						this.paint(node, { ...arc, r0: arc.r0 * p, r1: arc.r1 * p, a1: arc.a0 + (arc.a1 - arc.a0) * p });
					}
				}, () => this.renderLabels());
			} else {
				for (const [node, arc] of target) {
					this.paint(node, arc);
				}
				this.renderLabels();
			}
			this.drawn = true;
		}

		/** Angles and radii for every visible node when `focus` fills the circle. */
		private layoutFor(focus: ITreeNode): Map<ITreeNode, IArcState> {
			const below = (node: ITreeNode, depth: number): number => node.children.length && depth < this.depth ? 1 + Math.max(...node.children.map(child => below(child, depth + 1))) : 0;
			const rings = Math.max(1, below(focus, 0));
			const outer = this.size / 2 - 6;
			this.hubRadius = outer * 0.22;
			this.ringWidth = (outer - this.hubRadius) / rings;
			const groups = focus.children;
			const colorOf = (node: ITreeNode) => {
				let top = node;
				while (top.parent && top.parent !== focus) {
					top = top.parent;
				}
				const index = groups.indexOf(top);
				return index >= 0 && index < PALETTE.length && !OTHER_NAME.test(top.name) ? PALETTE[index] : 'var(--vc-other)';
			};
			const out = new Map<ITreeNode, IArcState>();
			const walk = (node: ITreeNode, a0: number, a1: number, ring: number) => {
				if (ring > 0) {
					out.set(node, { a0, a1, r0: this.hubRadius + (ring - 1) * this.ringWidth, r1: this.hubRadius + ring * this.ringWidth - 1, color: colorOf(node), opacity: Math.max(0.45, 1 - 0.15 * (ring - 1)) });
				}
				if (ring >= rings) {
					return;
				}
				let angle = a0;
				for (const child of node.children) {
					const span = ((a1 - a0) * child.value) / (node.value || 1);
					walk(child, angle, angle + span, ring + 1);
					angle += span;
				}
			};
			walk(focus, -Math.PI / 2, Math.PI * 1.5, 0);
			return out;
		}

		private pathFor(node: ITreeNode): SVGPathElement {
			let path = this.paths.get(node);
			if (!path) {
				path = s('path', { class: 'vc-sb-arc' }, this.arcsLayer);
				path.addEventListener('pointermove', event => this.hover(node, event));
				path.addEventListener('pointerleave', () => this.hover(undefined));
				path.addEventListener('click', () => {
					if (node.children.length && node !== this.focus) {
						this.zoom(node);
					} else if (node.href) {
						this.ctx.onOpen?.(node.href);
					}
				});
				this.paths.set(node, path);
			}
			return path;
		}

		private paint(node: ITreeNode, arc: IArcState | undefined): void {
			const path = this.pathFor(node);
			if (!arc || arc.a1 - arc.a0 < 0.002 || arc.r1 <= arc.r0) {
				path.style.display = 'none';
				return;
			}
			path.style.display = '';
			path.setAttribute('d', arcPath(this.width / 2, this.size / 2, arc.r1, Math.max(0, arc.r0), arc.a0, arc.a1));
			path.style.fill = arc.color;
			path.style.fillOpacity = String(arc.opacity);
		}

		private hover(node: ITreeNode | undefined, event?: PointerEvent): void {
			const related = (a: ITreeNode, b: ITreeNode) => {
				for (let at: ITreeNode | undefined = a; at; at = at.parent) {
					if (at === b) {
						return true;
					}
				}
				return false;
			};
			for (const [other, path] of this.paths) {
				path.style.opacity = !node || related(other, node) || related(node, other) ? '' : '0.25';
			}
			if (!node || !event) {
				this.tip.hide();
				return;
			}
			const share = node.value / (this.focus.value || 1);
			this.tip.set({
				title: node.path,
				hero: `${formatValue(node.value, this.unit, true)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`,
				sub: `${formatPercent(share * 100)} ${this.ctx.strings.ofParent.replace('{0}', this.focus.name || this.ctx.strings.total)}`,
				meta: node.detail,
				hint: node.children.length && node !== this.focus ? this.ctx.strings.zoomIn : node.href ? this.ctx.strings.open : undefined,
			});
			this.tip.show();
			const [x, y] = localPoint(event, this.plot);
			this.tip.place(x, y, this.width, 0, this.size);
		}

		private zoom(target: ITreeNode): void {
			this.hover(undefined);
			this.labelsLayer.replaceChildren();
			const from = this.state;
			const to = this.layoutFor(target);
			this.focus = target;
			this.renderHub();
			this.renderCrumbs();
			const nodes = new Set([...from.keys(), ...to.keys()]);
			const collapse = (arc: IArcState, toward: IArcState | undefined): IArcState => {
				const mid = (arc.a0 + arc.a1) / 2;
				return { ...arc, a0: mid, a1: mid, r0: toward ? toward.r0 : arc.r1, r1: toward ? toward.r1 : arc.r1 };
			};
			this.animation?.cancel();
			this.animation = play(750, zoomEase, t => {
				for (const node of nodes) {
					const a = from.get(node);
					const b = to.get(node);
					const start = a ?? collapse(b!, b);
					const end = b ?? collapse(a!, undefined);
					this.paint(node, {
						a0: start.a0 + (end.a0 - start.a0) * t,
						a1: start.a1 + (end.a1 - start.a1) * t,
						r0: start.r0 + (end.r0 - start.r0) * t,
						r1: start.r1 + (end.r1 - start.r1) * t,
						color: (b ?? a)!.color,
						opacity: start.opacity + (end.opacity - start.opacity) * t,
					});
				}
			}, () => {
				for (const node of nodes) {
					if (!to.has(node)) {
						this.paths.get(node)?.remove();
						this.paths.delete(node);
					}
				}
				this.state = to;
				this.renderLabels();
			});
		}

		private renderHub(): void {
			this.hub.replaceChildren();
			const cx = this.width / 2;
			const cy = this.size / 2;
			s('circle', { cx, cy, r: Math.max(0, this.hubRadius - 3), class: 'vc-sb-hub-disc' }, this.hub);
			const name = s('text', { x: cx, y: cy - 3, 'text-anchor': 'middle', class: 'vc-sb-hub-name' }, this.hub);
			name.textContent = ellipsize(this.focus.name || this.ctx.strings.total, '600 13px system-ui', this.hubRadius * 1.7);
			const value = s('text', { x: cx, y: cy + 14, 'text-anchor': 'middle', class: 'vc-sb-hub-value' }, this.hub);
			value.textContent = `${formatValue(this.focus.value, this.unit)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`;
			this.hub.classList.toggle('vc-link', !!this.focus.parent);
			this.hub.onclick = () => this.focus.parent && this.zoom(this.focus.parent);
		}

		private renderCrumbs(): void {
			this.crumbs.replaceChildren();
			const chain: ITreeNode[] = [];
			for (let node: ITreeNode | undefined = this.focus; node; node = node.parent) {
				chain.unshift(node);
			}
			chain.forEach((node, index) => {
				if (index > 0) {
					h('span', '', this.crumbs, '/');
				}
				const label = node.name || 'root';
				if (index === chain.length - 1) {
					h('span', 'vc-current', this.crumbs, label);
				} else {
					const button = h('button', '', this.crumbs, label);
					button.type = 'button';
					button.addEventListener('click', () => this.zoom(node));
				}
			});
		}

		/** Names along the arcs wide and thick enough to hold them, turned to stay upright. */
		private renderLabels(): void {
			this.labelsLayer.replaceChildren();
			const cx = this.width / 2;
			const cy = this.size / 2;
			for (const [node, arc] of this.state) {
				const thickness = arc.r1 - arc.r0;
				const length = (arc.a1 - arc.a0) * (arc.r0 + arc.r1) / 2;
				if (length < 26 || thickness < 16) {
					continue;
				}
				const mid = (arc.a0 + arc.a1) / 2;
				const [x, y] = polar(cx, cy, (arc.r0 + arc.r1) / 2, mid);
				let rotate = (mid * 180) / Math.PI;
				if (Math.cos(mid) < 0) {
					rotate += 180;
				}
				const text = s('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', transform: `rotate(${num(rotate)} ${num(x)} ${num(y)})`, class: 'vc-sb-label' }, this.labelsLayer);
				text.textContent = ellipsize(node.name, '600 11px system-ui', thickness - 8);
			}
			if (!reducedMotion()) {
				this.labelsLayer.classList.remove('vc-fade-in');
				void this.labelsLayer.getBoundingClientRect();
				this.labelsLayer.classList.add('vc-fade-in');
			}
		}

		dispose(): void {
			this.animation?.cancel();
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Sankey

	interface ISankeyNode {
		readonly name: string;
		readonly href?: string;
		color: string;
		column: number;
		inValue: number;
		outValue: number;
		x: number;
		y: number;
		height: number;
		readonly incoming: ISankeyLink[];
		readonly outgoing: ISankeyLink[];
	}

	interface ISankeyLink {
		readonly source: ISankeyNode;
		readonly target: ISankeyNode;
		readonly value: number;
		y0: number;
		y1: number;
		path?: SVGPathElement;
	}

	/** Flows between stages: who did what, where it went. Links are as thick as their value. */
	class SankeyBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly nodes: ISankeyNode[] = [];
		private readonly links: ISankeyLink[] = [];
		private readonly unit: IUnit;
		private readonly heightSpec?: number;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly tip: Tip;
		private nodeEls = new Map<ISankeyNode, { rect: SVGRectElement; label: SVGGElement }>();
		private width = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const byName = new Map<string, ISankeyNode>();
			const declared = new Map<string, Record<string, unknown>>();
			for (const item of (Array.isArray(spec.nodes) ? spec.nodes : []).filter(isRecord)) {
				const name = str(item.name ?? item.id ?? item.label, 80);
				if (name) {
					declared.set(name, item);
				}
			}
			const node = (raw: unknown): ISankeyNode | undefined => {
				const name = str(raw, 80);
				if (!name) {
					return undefined;
				}
				let found = byName.get(name);
				if (!found) {
					const extra = declared.get(name);
					found = { name, href: safeHref(extra?.href), color: cssColor(extra?.color) ?? '', column: 0, inValue: 0, outValue: 0, x: 0, y: 0, height: 0, incoming: [], outgoing: [] };
					byName.set(name, found);
					this.nodes.push(found);
				}
				return found;
			};
			for (const raw of (Array.isArray(spec.links) ? spec.links : []).filter(isRecord).slice(0, 400)) {
				const source = node(raw.source ?? raw.from);
				const target = node(raw.target ?? raw.to);
				if (!source || !target || source === target || !isNum(raw.value) || raw.value <= 0) {
					continue;
				}
				const link: ISankeyLink = { source, target, value: raw.value, y0: 0, y1: 0 };
				source.outgoing.push(link);
				target.incoming.push(link);
				source.outValue += raw.value;
				target.inValue += raw.value;
				this.links.push(link);
			}
			if (!this.links.length) {
				problems.push(`${where}: sankeys need "links": [{ "source": "Signed up", "target": "Activated", "value": 120 }].`);
			}
			// Columns: each node sits one step right of its furthest source. Cycles stop after n passes.
			for (let pass = 0, moved = true; moved && pass < this.nodes.length; pass++) {
				moved = false;
				for (const link of this.links) {
					if (link.target.column < link.source.column + 1) {
						link.target.column = link.source.column + 1;
						moved = true;
					}
				}
			}
			const columns = Math.max(0, ...this.nodes.map(item => item.column)) + 1;
			// Color follows the middle stage (the "what"), or the first one in a two-step flow.
			const colorColumn = isNum(spec.colorColumn) ? spec.colorColumn : columns >= 3 ? 1 : 0;
			let paletteIndex = 0;
			for (const item of [...this.nodes].sort((a, b) => Math.max(b.inValue, b.outValue) - Math.max(a.inValue, a.outValue))) {
				if (!item.color) {
					item.color = item.column === colorColumn && !OTHER_NAME.test(item.name) && paletteIndex < PALETTE.length ? PALETTE[paletteIndex++] : 'var(--vc-other)';
				}
			}
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.links.map(link => link.value));
			this.heightSpec = isNum(spec.height) ? clamp(spec.height, 180, 900) : undefined;
			this.plot = h('div', 'vc-plot', this.element);
			this.svg = s('svg', { class: 'vc-svg', role: 'img' }, this.plot);
			this.svg.setAttribute('aria-label', this.links.slice(0, 40).map(link => `${link.source.name} to ${link.target.name} ${formatValue(link.value, this.unit, true)}`).join(', '));
			this.tip = new Tip(this.plot);
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const animate = !this.drawn && this.ctx.animate;
			const font = `600 12px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
			const columns: ISankeyNode[][] = [];
			for (const item of this.nodes) {
				(columns[item.column] ??= []).push(item);
			}
			const last = columns.length - 1;
			const nodeW = 14;
			const pad = 12;
			const labelRoom = (list: ISankeyNode[] | undefined) => Math.min(width * 0.24, Math.max(40, ...(list ?? []).map(item => textWidth(item.name, font))) + 12);
			const marginL = labelRoom(columns[0]);
			const marginR = last > 0 ? labelRoom(columns[last]) : 0;
			const tallest = Math.max(1, ...columns.map(list => list?.length ?? 0));
			const height = this.heightSpec ?? clamp(tallest * 46, 240, 520);
			const value = (item: ISankeyNode) => Math.max(item.inValue, item.outValue);
			const ky = Math.min(...columns.map(list => (height - 20 - ((list?.length ?? 1) - 1) * pad) / Math.max(1e-9, (list ?? []).reduce((sum, item) => sum + value(item), 0))));
			columns.forEach((list, index) => {
				if (!list) {
					return;
				}
				list.sort((a, b) => Number(OTHER_NAME.test(a.name)) - Number(OTHER_NAME.test(b.name)) || value(b) - value(a));
				const used = list.reduce((sum, item) => sum + Math.max(2, value(item) * ky), 0) + (list.length - 1) * pad;
				let y = (height - used) / 2;
				const x = last ? marginL + ((width - marginL - marginR - nodeW) * index) / last : (width - nodeW) / 2;
				for (const item of list) {
					item.x = x;
					item.y = y;
					item.height = Math.max(2, value(item) * ky);
					y += item.height + pad;
				}
			});
			for (const item of this.nodes) {
				item.outgoing.sort((a, b) => a.target.y - b.target.y);
				item.incoming.sort((a, b) => a.source.y - b.source.y);
				let offset = 0;
				for (const link of item.outgoing) {
					link.y0 = item.y + offset + (link.value * ky) / 2;
					offset += link.value * ky;
				}
				offset = 0;
				for (const link of item.incoming) {
					link.y1 = item.y + offset + (link.value * ky) / 2;
					offset += link.value * ky;
				}
			}
			setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
			this.plot.style.height = `${height}px`;
			this.svg.replaceChildren();
			const defs = s('defs', {}, this.svg);
			const linkLayer = s('g', { class: 'vc-sk-links' }, this.svg);
			const nodeLayer = s('g', {}, this.svg);
			const labelLayer = s('g', {}, this.svg);
			const ordered = [...this.links].sort((a, b) => b.value - a.value);
			ordered.forEach((link, index) => {
				const x0 = link.source.x + nodeW;
				const x1 = link.target.x;
				const xm = (x0 + x1) / 2;
				const id = nextId('sk');
				const gradient = s('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x0, x2: x1, y1: 0, y2: 0 }, defs);
				s('stop', { offset: '0%' }, gradient).style.stopColor = link.source.color;
				s('stop', { offset: '100%' }, gradient).style.stopColor = link.target.color;
				const path = s('path', { d: `M${num(x0)},${num(link.y0)}C${num(xm)},${num(link.y0)} ${num(xm)},${num(link.y1)} ${num(x1)},${num(link.y1)}`, stroke: `url(#${id})`, 'stroke-width': num(Math.max(1, link.value * ky)), class: 'vc-sk-link' }, linkLayer);
				path.addEventListener('pointermove', event => this.hover(undefined, link, event));
				path.addEventListener('pointerleave', () => this.hover());
				link.path = path;
				if (animate && !reducedMotion()) {
					const length = path.getTotalLength();
					path.style.strokeDasharray = `${num(length)} ${num(length)}`;
					const animation = path.animate([{ strokeDashoffset: num(length) }, { strokeDashoffset: '0' }], { duration: ENTER_MS, delay: 220 + (index / ordered.length) * 352, easing: ENTER_CSS, fill: 'backwards' });
					animation.onfinish = () => path.style.strokeDasharray = '';
				}
			});
			this.nodeEls.clear();
			this.nodes.forEach((item, index) => {
				const rect = s('rect', { x: item.x, y: item.y, width: nodeW, height: item.height, rx: 4, class: 'vc-sk-node' }, nodeLayer);
				rect.style.fill = item.color;
				origin(rect, item.x + nodeW / 2, item.y + item.height / 2);
				rect.addEventListener('pointermove', event => this.hover(item, undefined, event));
				rect.addEventListener('pointerleave', () => this.hover());
				rect.addEventListener('click', () => item.href && this.ctx.onOpen?.(item.href));
				const right = item.column > 0;
				const lx = right ? item.x + nodeW + 8 : item.x - 8;
				const room = right ? (item.column === last ? width - lx - 2 : (width - marginL - marginR) / Math.max(1, last) - nodeW - 16) : lx - 2;
				const label = s('g', { class: `vc-sk-label${item.column > 0 && item.column < last ? ' vc-mid' : ''}` }, labelLayer);
				const tall = item.height > 24;
				const name = s('text', { x: lx, y: item.y + item.height / 2 + (tall ? -2 : 4), 'text-anchor': right ? 'start' : 'end', class: 'vc-sk-name' }, label);
				name.textContent = ellipsize(item.name, font, room);
				if (tall) {
					const amount = s('text', { x: lx, y: item.y + item.height / 2 + 13, 'text-anchor': right ? 'start' : 'end', class: 'vc-sk-value' }, label);
					amount.textContent = formatValue(value(item), this.unit);
				}
				if (animate) {
					enter(rect, [{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], ENTER_MS, (index / this.nodes.length) * 264);
					enter(label, [{ transform: `translateX(${right ? -10 : 10}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], 700, (index / this.nodes.length) * 264 + 520, 'cubic-bezier(0.22, 1, 0.36, 1)');
				}
				this.nodeEls.set(item, { rect, label });
			});
			this.drawn = true;
		}

		private hover(item?: ISankeyNode, link?: ISankeyLink, event?: PointerEvent): void {
			const litLinks = new Set<ISankeyLink>();
			const litNodes = new Set<ISankeyNode>();
			if (item) {
				litNodes.add(item);
				for (const other of [...item.incoming, ...item.outgoing]) {
					litLinks.add(other);
					litNodes.add(other.source);
					litNodes.add(other.target);
				}
			}
			if (link) {
				litLinks.add(link);
				litNodes.add(link.source);
				litNodes.add(link.target);
			}
			const any = !!(item || link);
			for (const other of this.links) {
				other.path?.classList.toggle('vc-lit', any && litLinks.has(other));
				other.path?.classList.toggle('vc-dim', any && !litLinks.has(other));
			}
			for (const [other, els] of this.nodeEls) {
				const opacity = !any || litNodes.has(other) ? '' : '0.4';
				els.rect.style.opacity = opacity;
				els.label.style.opacity = opacity;
			}
			if (!event || !any) {
				this.tip.hide();
				return;
			}
			if (link) {
				this.tip.set({ title: `${link.source.name} → ${link.target.name}`, hero: formatValue(link.value, this.unit, true), sub: `${formatPercent((link.value / (link.source.outValue || 1)) * 100)} ${this.ctx.strings.ofParent.replace('{0}', link.source.name)}` });
			} else if (item) {
				const flows = (item.outgoing.length ? item.outgoing.map(other => [other.target, other.value] as const) : item.incoming.map(other => [other.source, other.value] as const)).slice().sort((a, b) => b[1] - a[1]).slice(0, 5);
				this.tip.set({ title: item.name, hero: formatValue(Math.max(item.inValue, item.outValue), this.unit, true), rows: flows.map(([other, amount]) => ({ name: other.name, value: formatValue(amount, this.unit), color: other.color })), hint: item.href ? this.ctx.strings.open : undefined });
			}
			this.tip.show();
			const [x, y] = localPoint(event, this.plot);
			this.tip.place(x, y, this.width, 0, this.plot.clientHeight);
		}

		dispose(): void {
			this.tip.dispose();
		}
	}

	//#endregion

	//#region Candlestick

	interface ICandle {
		readonly x: number;
		readonly open: number;
		readonly high: number;
		readonly low: number;
		readonly close: number;
		readonly label?: string;
		readonly detail?: readonly (readonly [string, string])[];
	}

	/**
	 * Open, high, low and close per period: prices, repo size, queue depth. Bodies are gradients
	 * (lime to emerald up, yellow to red down), solid or hatched, over an optional backdrop and bands.
	 */
	class CandlestickBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly candles: ICandle[];
		private readonly unit: IUnit;
		private readonly zone: ITimeZone;
		private readonly time: boolean;
		private readonly categories: string[] = [];
		private readonly heightSpec: number;
		private readonly look: ILook;
		private readonly up: string;
		private readonly down: string;
		private readonly plot: HTMLElement;
		private readonly svg: SVGSVGElement;
		private readonly tip: Tip;
		private readonly pill: AxisPill;
		private readonly cursor: SVGLineElement;
		private readonly live: HTMLElement;
		private readonly springs: Springs;
		private axis: SVGGElement | undefined;
		private groups: SVGGElement[] = [];
		private sx: ((index: number) => number) | undefined;
		private box: IBox | undefined;
		private active = -1;
		private width = 0;
		private drawn = false;

		constructor(parent: HTMLElement, spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			this.zone = timeZoneOf(isRecord(spec.x) ? spec.x.timeZone : spec.timeZone);
			this.look = readLook(spec);
			const colors = isRecord(spec.colors) ? spec.colors : {};
			this.up = cssColor(colors.up) ?? 'var(--vc-good)';
			this.down = cssColor(colors.down) ?? 'var(--vc-bad)';
			const raw = (Array.isArray(spec.data) ? spec.data : []).slice(0, 5000);
			this.time = raw.some(item => looksLikeTime(Array.isArray(item) ? item[0] : isRecord(item) ? item.x ?? item.time ?? item.date : undefined));
			this.candles = raw.flatMap((item, index) => {
				const [x, open, high, low, close] = Array.isArray(item) ? item : isRecord(item) ? [item.x ?? item.time ?? item.date, item.open ?? item.o, item.high ?? item.h, item.low ?? item.l, item.close ?? item.c] : [];
				if (!isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) {
					problems.push(`${where}: candle ${index + 1} needs numeric "open", "high", "low" and "close".`);
					return [];
				}
				let at: number | undefined = index;
				if (this.time) {
					at = parseTime(x, this.zone);
				} else {
					this.categories.push(str(x, 40) ?? String(index + 1));
				}
				if (at === undefined) {
					problems.push(`${where}: candle ${index + 1} has an "x" that is not a date.`);
					return [];
				}
				return [{ x: at, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, label: isRecord(item) ? str(item.label, 120) : undefined, detail: isRecord(item) ? detailRows(item.detail) : undefined }];
			});
			if (this.time) {
				this.candles.sort((a, b) => a.x - b.x);
			}
			if (!this.candles.length) {
				problems.push(`${where}: candlesticks need "data": [{ "x": "2026-10-01", "open": 10, "high": 12, "low": 9, "close": 11 }].`);
			}
			this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.candles.map(candle => candle.close));
			this.heightSpec = isNum(spec.height) ? clamp(spec.height, 140, 900) : 280;
			this.plot = h('div', 'vc-plot', this.element);
			this.plot.tabIndex = 0;
			this.plot.setAttribute('role', 'group');
			this.plot.setAttribute('aria-label', `${str(spec.title) ?? ctx.strings.chart}. Candlestick chart. Use arrow keys to read values.`);
			this.svg = s('svg', { class: 'vc-svg', role: 'img' }, this.plot);
			this.cursor = s('line', { class: 'vc-cs-cursor' });
			this.tip = new Tip(this.plot);
			this.pill = new AxisPill(this.plot);
			this.live = h('div', 'vc-sr', this.plot);
			this.live.setAttribute('aria-live', 'polite');
			this.live.setAttribute('aria-atomic', 'true');
			this.springs = new Springs(() => this.follow(), 300, 0.87);
			const legend = h('div', 'vc-legend vc-legend-static', this.element);
			for (const [label, color] of [[ctx.strings.rising, this.up], [ctx.strings.falling, this.down]]) {
				const item = h('span', 'vc-legend-item', legend);
				h('span', 'vc-swatch', item).style.background = color;
				item.append(label);
			}
			this.plot.addEventListener('pointermove', event => {
				const [x] = localPoint(event, this.svg);
				this.activate(this.indexAt(x));
			});
			this.plot.addEventListener('pointerleave', () => {
				if (this.plot.ownerDocument.activeElement !== this.plot) {
					this.activate(-1);
				}
			});
			this.plot.addEventListener('focus', () => {
				this.activate(this.active < 0 ? this.candles.length - 1 : this.active);
				this.announce();
			});
			this.plot.addEventListener('blur', () => this.activate(-1));
			this.plot.addEventListener('keydown', event => {
				const last = this.candles.length - 1;
				let index = this.active < 0 ? last : this.active;
				switch (event.key) {
					case 'Home': index = 0; break;
					case 'End': index = last; break;
					case 'ArrowLeft': index--; break;
					case 'ArrowRight': index++; break;
					case 'Escape': this.activate(-1); return;
					default: return;
				}
				event.preventDefault();
				this.activate(clamp(index, 0, last));
				this.announce();
			});
		}

		/** Body fill for rising or falling candles, per the chosen look. */
		private bodyFill(defs: SVGDefsElement, rising: boolean): string {
			const color = rising ? this.up : this.down;
			if (this.look.fill === 'solid') {
				return color;
			}
			if (this.look.fill === 'pattern') {
				return pattern(defs, 'lines', color, { tint: 0.25, ink: 0.95 });
			}
			// Lime into emerald for rising, yellow into red for falling.
			return rising
				? verticalGradient(defs, `color-mix(in oklab, ${color} 62%, var(--vc-yellow))`, color)
				: verticalGradient(defs, `color-mix(in oklab, ${color} 45%, var(--vc-yellow))`, color);
		}

		layout(width: number): void {
			if (width === this.width && this.drawn) {
				return;
			}
			this.width = width;
			const animate = !this.drawn && this.ctx.animate;
			const height = width < 420 ? Math.max(150, Math.round(this.heightSpec * 0.82)) : this.heightSpec;
			const n = this.candles.length;
			const lo = Math.min(...this.candles.map(candle => candle.low));
			const hi = Math.max(...this.candles.map(candle => candle.high));
			const ticks = niceScale(lo, hi, 4, false);
			const font = axisFont(this.element);
			const labelWidth = Math.max(0, ...ticks.values.map(value => textWidth(formatTick(value, ticks.step, this.unit), font)));
			const box: IBox = { width, height, left: width < 200 ? 0 : Math.ceil(labelWidth) + 16, right: width - 4, top: 10, bottom: height - 24 };
			this.box = box;
			const slot = (box.right - box.left) / Math.max(1, n);
			const sx = (index: number) => box.left + (index + 0.5) * slot;
			this.sx = sx;
			const sy = linearScale(ticks.lo, ticks.hi, box.bottom, box.top);
			setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
			this.plot.style.height = `${height}px`;
			// Reposition the active reading after a resize, even if its data index is unchanged.
			const active = this.active;
			this.activate(-1);
			this.svg.replaceChildren();
			const defs = s('defs', {}, this.svg);
			drawBackdrop(s('g', {}, this.svg), this.look, box);
			const grid = s('g', { class: `vc-grid${this.look.grid === 'dashed' ? ' vc-grid-dashed' : this.look.grid === 'none' ? ' vc-grid-none' : ''}` }, this.svg);
			const axis = s('g', { class: 'vc-axis' }, this.svg);
			this.axis = axis;
			for (const value of ticks.values) {
				const y = crisp(sy(value));
				s('line', { x1: box.left, x2: box.right, y1: y, y2: y, class: value === ticks.values[0] ? 'vc-zero' : undefined }, grid);
				if (box.left > 0) {
					s('text', { x: 0, y, 'text-anchor': 'start', 'dominant-baseline': 'central' }, axis).textContent = formatTick(value, ticks.step, this.unit);
				}
			}
			drawBands(s('g', {}, this.svg), this.look.bands, box, sy, this.unit);
			const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((box.right - box.left) / 80))));
			const grain = this.time ? grainOf(this.candles.map(candle => candle.x)) : 'day';
			for (let index = 0; index < n; index += every) {
				const label = s('text', { x: sx(index), y: height - 6, 'text-anchor': 'middle', class: this.time ? undefined : 'vc-cat' }, axis);
				label.textContent = this.time ? formatTimePoint(this.candles[index].x, grain, this.zone) : this.categories[index];
				label.dataset.cx = String(sx(index));
			}
			setAttrs(this.cursor, { x1: 0, x2: 0, y1: box.top, y2: box.bottom });
			this.svg.appendChild(this.cursor);
			const bodyWidth = Math.max(1.5, slot * 0.7);
			const fills = { up: this.bodyFill(defs, true), down: this.bodyFill(defs, false) };
			this.groups = this.candles.map((candle, index) => {
				const rising = candle.close >= candle.open;
				const group = s('g', { class: 'vc-candle' }, this.svg);
				group.style.color = rising ? this.up : this.down;
				const top = sy(candle.high);
				const bottom = sy(candle.low);
				origin(group, sx(index), (top + bottom) / 2);
				s('rect', { x: sx(index) - 0.75, y: top, width: 1.5, height: Math.max(1, bottom - top), class: 'vc-candle-wick' }, group);
				const body = s('rect', { x: sx(index) - bodyWidth / 2, y: sy(Math.max(candle.open, candle.close)), width: bodyWidth, height: Math.max(1.5, Math.abs(sy(candle.open) - sy(candle.close))), rx: 1, class: 'vc-candle-body' }, group);
				body.style.fill = rising ? fills.up : fills.down;
				if (animate) {
					enter(group, [{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], CANDLE_SPRING.ms, index * ((0.6 * 800) / Math.max(1, n)), CANDLE_SPRING.easing);
				}
				return group;
			});
			this.svg.setAttribute('aria-label', `${n} candles, ${formatValue(this.candles[0]?.open, this.unit, true)} to ${formatValue(this.candles[n - 1]?.close, this.unit, true)}`);
			this.drawn = true;
			if (active >= 0) {
				this.activate(active);
			}
		}

		private indexAt(x: number): number {
			const box = this.box;
			if (!box || x < box.left - 4 || x > box.right + 4) {
				return -1;
			}
			return clamp(Math.floor(((x - box.left) / (box.right - box.left)) * this.candles.length), 0, this.candles.length - 1);
		}

		/** Cursor line, pill and tip ride the same spring. */
		private follow(): void {
			const x = this.springs.get('x');
			this.cursor.style.transform = `translateX(${num(x)}px)`;
			if (this.box && this.look.pill && this.active >= 0) {
				this.pill.place(x, this.box.bottom + 3, this.box.width);
				if (this.axis) {
					fadeTicks(this.axis, x);
				}
			}
		}

		private activate(index: number): void {
			if (index === this.active) {
				return;
			}
			const first = this.active < 0;
			this.active = index;
			this.groups.forEach((group, at) => group.style.opacity = index < 0 || at === index ? '' : '0.3');
			const candle = this.candles[index];
			if (!candle || !this.sx || !this.box) {
				this.cursor.style.opacity = '0';
				this.tip.hide();
				this.pill.hide();
				this.live.textContent = '';
				if (this.axis) {
					fadeTicks(this.axis, undefined);
				}
				return;
			}
			const x = this.sx(index);
			const rising = candle.close >= candle.open;
			this.cursor.style.stroke = rising ? this.up : this.down;
			this.cursor.style.opacity = '1';
			if (this.look.pill) {
				this.pill.set(this.time ? dateFormat({ month: 'short', day: 'numeric' }, this.zone).format(candle.x) : this.categories[index], index);
				this.pill.show();
			}
			this.springs.set('x', x, first);
			const change = candle.close - candle.open;
			const strings = this.ctx.strings;
			this.tip.set({
				title: candle.label ?? (this.time ? formatTimePoint(candle.x, 'day', this.zone) : this.categories[index]),
				hero: formatValue(candle.close, this.unit, true),
				// allow-any-unicode-next-line
				sub: `${change >= 0 ? '+' : '−'}${formatValue(Math.abs(change), this.unit, true)}`,
				rows: [[strings.candleOpen, candle.open], [strings.candleHigh, candle.high], [strings.candleLow, candle.low], [strings.candleClose, candle.close]].map(([name, value]) => ({ name: String(name), value: formatValue(Number(value), this.unit) })),
				meta: candle.detail,
			});
			this.tip.show();
			this.tip.place(x, (this.box.top + this.box.bottom) / 2, this.width, 0, this.box.height);
		}

		private announce(): void {
			this.live.textContent = this.active < 0 ? '' : [...this.tip.element.querySelectorAll('.vc-tip-title,.vc-tip-hero,.vc-tip-sub,.vc-tip-name,.vc-tip-value')].map(element => element.textContent).join(', ');
		}

		dispose(): void {
			this.springs.dispose();
			this.tip.dispose();
			this.pill.dispose();
		}
	}

	//#endregion

	const SHOWCASE_CSS = `
.vc-gauge{display:flex;justify-content:center}
.vc-gauge-notch{fill:currentColor}
.vc-gauge-cap{fill:none;stroke:currentColor;stroke-linecap:round}
.vc-gauge-track{color:color-mix(in srgb,var(--vc-fg) 11%,transparent)}
.vc-gauge-linear{flex-direction:column;align-items:stretch;gap:10px}
.vc-gauge-linear .vc-gauge-center{position:static}
.vc-gauge-linear .vc-gauge-center.vc-at-below{order:2}
.vc-gauge-center.vc-at-none{display:none}
.vc-ring-stack{flex-direction:column;align-items:stretch}
.vc-ring-stack svg{align-self:center}
.vc-ring-bars .vc-donut-item{display:block;padding:4px 6px}
.vc-ring-row{display:flex;align-items:center;gap:8px}
.vc-ring-progress{display:block;height:4px;border-radius:2px;margin-top:6px;background:color-mix(in srgb,var(--vc-fg) 9%,transparent);overflow:hidden}
.vc-ring-progress i{display:block;height:100%;border-radius:2px}
.vc-funnel-band{fill:color-mix(in srgb,var(--vc-fg) 4%,transparent)}
.vc-funnel-big{fill:var(--vc-fg);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums}
/* Solid, never backdrop-filter: in the see-through agent window a blurred tip turns the sidebar black (volt-transparent-window). */
.vc-tip{background:var(--vc-tip-bg);border:1px solid var(--vc-tip-border);border-radius:12px;padding:9px 11px 10px;box-shadow:var(--vc-shadow),inset 0 1px 0 color-mix(in srgb,var(--vc-fg) 7%,transparent);scale:.96;transition:opacity 120ms ease,scale 240ms ${EASE_OUT}}
.vc-tip.vc-shown{scale:1}
.vc-tip-title{font-weight:500;letter-spacing:.01em}
.vc-tip-hero{font-size:18px;line-height:23px}
.vc-tip-row{gap:8px}
.vc-cartesian:not(.vc-bars) .vc-tip .vc-swatch:not(.vc-dash){width:10px;height:2.5px;border-radius:2px}
.vc-grid-dashed line:not(.vc-zero){stroke:var(--vc-grid-dot);stroke-dasharray:1 3}
.vc-grid-none line:not(.vc-zero){display:none}
.vc-line.vc-nostroke{stroke-opacity:0}
.vc-refband line{stroke:var(--vc-muted);stroke-dasharray:4 4;stroke-opacity:.6}
.vc-refband text{fill:var(--vc-muted);font-size:11px}
.vc-pill{box-sizing:border-box;max-width:100%;overflow:hidden;position:absolute;left:0;top:0;z-index:2;display:flex;gap:4px;align-items:center;height:22px;padding:0 10px;border-radius:999px;background:var(--vc-fg);color:var(--vc-bg);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px -4px rgba(0,0,0,.45);opacity:0;transition:opacity 120ms ease;will-change:transform}
.vc-pill.vc-shown{opacity:1}
.vc-pill-slot{min-width:0;display:inline-grid;overflow:hidden;line-height:22px}
.vc-pill-word{grid-area:1/1;overflow:hidden;text-overflow:ellipsis}
.vc-axis text{transition:opacity 160ms ease}
.vc-gauge-lit{transition:opacity 250ms ease}
.vc-gauge-center{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;pointer-events:none}
.vc-gauge-value{font-size:30px;line-height:36px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.vc-gauge-label{color:var(--vc-muted);font-size:12px}
.vc-gauge-caption{text-align:center;margin-top:2px}
.vc-ring{flex:none;overflow:visible}
.vc-ring-g{transition:transform ${HOVER_SPRING.ms}ms ${HOVER_SPRING.easing},opacity 150ms,filter 150ms;cursor:default}
.vc-ring-track{fill:none;stroke:color-mix(in srgb,var(--vc-fg) 9%,transparent)}
.vc-ring-arc{fill:none;stroke-linecap:round}
.vc-ring-hit{fill:none;stroke:transparent}
.vc-radar-grid polygon,.vc-radar-grid line{fill:none;stroke:var(--vc-hair)}
.vc-radar-grid polygon:not(.vc-radar-edge){stroke-dasharray:3 4}
.vc-radar-label{fill:var(--vc-fg);font-size:11.5px;font-weight:600}
.vc-radar-area{transition:transform ${HOVER_SPRING.ms}ms ${HOVER_SPRING.easing},opacity 150ms,filter 150ms}
.vc-radar-area polygon{fill-opacity:.15;stroke-width:2;stroke-linejoin:round;transition:fill-opacity 200ms,stroke-width 200ms}
.vc-radar-area circle{stroke:var(--vc-bg);stroke-width:2;transition:r 200ms}
.vc-radar-area.vc-on{transform:scale(1.05)}
.vc-radar-area.vc-on polygon{fill-opacity:.35;stroke-width:3}
.vc-radar-area.vc-on circle{r:5}
.vc-radar-hit{fill:transparent}
.vc-legend-static .vc-legend-item{cursor:default}
.vc-funnel-seg,.vc-funnel-label{transition:opacity 150ms}
.vc-funnel-name{fill:var(--vc-fg);font-size:12px;font-weight:600}
.vc-funnel-value{fill:var(--vc-muted);font-size:12px;font-variant-numeric:tabular-nums}
.vc-funnel-pill{fill:var(--vc-fg)}
.vc-funnel-pill-text{fill:var(--vc-bg);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.vc-hit-rect{fill:transparent}
.vc-sb-arc{stroke:var(--vc-bg);stroke-width:1;transition:opacity 160ms ease;cursor:pointer}
.vc-sb-label{fill:#fff;font-size:11px;font-weight:600;paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2.5px;pointer-events:none}
.vc-sb-labels.vc-fade-in{animation:vc-fade 250ms ease both}
.vc-sb-hub-disc{fill:color-mix(in srgb,var(--vc-fg) 5%,transparent);stroke:var(--vc-hair)}
.vc-sb-hub-name{fill:var(--vc-fg);font-size:13px;font-weight:600}
.vc-sb-hub-value{fill:var(--vc-muted);font-size:11px;font-variant-numeric:tabular-nums}
.vc-sb-hub.vc-link{cursor:pointer}
.vc-sk-link{fill:none;stroke-opacity:.5;transition:stroke-opacity 180ms ease-out}
.vc-sk-link.vc-lit{stroke-opacity:.65}
.vc-sk-link.vc-dim{stroke-opacity:.1}
.vc-sk-node{transition:opacity 180ms ease-out}
.vc-sk-label{transition:opacity 180ms ease-out;pointer-events:none}
.vc-sk-name{fill:var(--vc-fg);font-size:12px;font-weight:600}
.vc-sk-value{fill:var(--vc-muted);font-size:11px;font-variant-numeric:tabular-nums}
.vc-sk-label.vc-mid text{paint-order:stroke;stroke:var(--vc-bg);stroke-width:3px;stroke-linejoin:round}
.vc-candle{transition:opacity 150ms ease-in-out}
.vc-candle-wick,.vc-candle-body{fill:currentColor}
.vc-cs-cursor{stroke:var(--vc-muted);stroke-width:1;opacity:0;transition:opacity 120ms;pointer-events:none}
`;

	//#endregion

	//#region Cumulative share (Lorenz curve)

	/** Turns per-entity values into a cumulative-share line chart with callouts at the marks. */
	function cumulativeSpec(spec: Record<string, unknown>, problems: string[], where: string): { spec: Record<string, unknown>; tooltip: (point: ICPoint) => ITipModel } {
		const values = (Array.isArray(spec.values) ? spec.values : []).filter(isNum).filter(value => value >= 0).sort((a, b) => b - a);
		if (!values.length) {
			problems.push(`${where}: cumulative charts need "values": one non-negative number per ${str(spec.entity) ?? 'entity'}.`);
		}
		const entity = str(spec.entity, 40) ?? 'items';
		const measure = str(spec.measure, 40) ?? 'the total';
		const n = values.length;
		const prefix: number[] = [0];
		for (const value of values) {
			prefix.push(prefix[prefix.length - 1] + value);
		}
		const total = prefix[n] || 1;
		const shareAt = (fraction: number) => {
			const exact = fraction * n;
			const lo = Math.floor(exact);
			const hi = Math.min(n, lo + 1);
			return ((prefix[lo] + (prefix[hi] - prefix[lo]) * (exact - lo)) / total) * 100;
		};
		const samples = Math.min(400, Math.max(2, n + 1));
		const data: [number, number][] = [];
		for (let index = 0; index < samples; index++) {
			const fraction = index / (samples - 1);
			data.push([fraction * 100, shareAt(fraction)]);
		}
		const marks = (Array.isArray(spec.marks) ? spec.marks.filter(isNum) : [0.01, 0.1, 0.25]).filter(mark => mark > 0 && mark < 1 && mark * n >= 1).slice(0, 5);
		const callouts = marks.map(mark => {
			const share = shareAt(mark);
			return { x: mark * 100, y: share, label: `top ${formatPercent(mark * 100)} → ${Math.round(share)}%` };
		});
		const lead = marks.find(mark => mark >= 0.1) ?? marks[0];
		return {
			spec: {
				type: 'line',
				height: spec.height ?? 260,
				title: spec.title ?? (lead !== undefined ? `The top ${formatPercent(lead * 100)} of ${entity} account for ${Math.round(shareAt(lead))}% of ${measure}` : undefined),
				subtitle: spec.subtitle ?? `Cumulative share of ${measure}, ${entity} sorted from heaviest to lightest. The diagonal is equal use.`,
				note: spec.note,
				x: { type: 'number', unit: 'percent', label: `of ${entity}` },
				y: { unit: 'percent', min: 0, max: 100 },
				series: [
					{ name: `Share of ${measure}`, data, color: spec.color ?? 'accent' },
					{ name: 'Equal use', data: [[0, 0], [100, 100]], reference: true, color: 'muted' },
				],
				callouts,
				legend: false,
				points: false,
			},
			tooltip: point => ({ title: `Top ${formatPercent(point.x)} of ${entity}`, hero: `${numberFormat(0, 1).format(point.y)}%`, sub: `of ${measure}` }),
		};
	}

	//#endregion

	//#region Rows, the visual and its blocks

	class RowBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly children: IBlock[];

		constructor(parent: HTMLElement, spec: Record<string, unknown>, ctx: IContext, problems: string[], where: string) {
			this.element = h('div', 'vc-block', parent);
			blockHead(this.element, spec.title, spec.subtitle);
			const grid = h('div', 'vc-row', this.element);
			const charts = (Array.isArray(spec.charts) ? spec.charts : []).filter(isRecord).slice(0, 6);
			if (!charts.length) {
				problems.push(`${where}: rows need "charts": [ ... ].`);
			}
			this.children = charts.map((chart, index) => createBlock(grid, chart, ctx, problems, `${where}.charts[${index}]`));
		}

		layout(): void {
			for (const child of this.children) {
				child.layout(Math.floor(child.element.clientWidth));
			}
		}

		setLoading(loading: boolean): void {
			for (const child of this.children) {
				child.setLoading?.(loading);
			}
		}

		dispose(): void {
			for (const child of this.children) {
				child.dispose();
			}
		}
	}

	const TYPE_ALIASES: Readonly<Record<string, string>> = {
		pie: 'donut', ring: 'donut', 'bars-h': 'ranked', hbar: 'ranked', list: 'ranked', top: 'ranked', lorenz: 'cumulative', pareto: 'cumulative',
		grid: 'row', columns: 'row', kpi: 'stats', kpis: 'stats', numbers: 'stats', columnchart: 'bar', column: 'bar', 'stacked': 'stacked-area', 'stacked-column': 'stacked-bar',
		composed: 'bar', combo: 'bar', meter: 'gauge', progress: 'rings', activity: 'rings', spider: 'radar', ohlc: 'candlestick', candles: 'candlestick', flow: 'sankey', alluvial: 'sankey', 'funnel-chart': 'funnel',
		'100%': 'share', percent: 'share', 'area-share': 'share', dots: 'scatter', bubble: 'scatter', sessions: 'scatter', 'grouped': 'grouped-bar', calendar: 'heatmap', matrix: 'heatmap',
	};

	/** The chart type: what the spec says, or what its data looks like. */
	function chartType(spec: Record<string, unknown>): string {
		const declared = typeof spec.type === 'string' ? spec.type.toLowerCase().trim() : '';
		if (declared) {
			return TYPE_ALIASES[declared] ?? declared;
		}
		if (Array.isArray(spec.items)) {
			return 'stats';
		}
		if (Array.isArray(spec.charts)) {
			return 'row';
		}
		if (Array.isArray(spec.rows) && Array.isArray(spec.columns)) {
			return 'heatmap';
		}
		if (Array.isArray(spec.values) && !spec.series) {
			return 'cumulative';
		}
		if (isRecord(spec.data) || (Array.isArray(spec.data) && spec.data.some(item => isRecord(item) && Array.isArray(item.children)))) {
			return 'treemap';
		}
		if (Array.isArray(spec.data)) {
			return 'ranked';
		}
		return Array.isArray(spec.categories) ? 'bar' : 'line';
	}

	/**
	 * A single-series bar chart over many long names (files, models, endpoints) cannot label its
	 * bars; as a ranked list every name gets a line of its own. Time axes keep their bars.
	 */
	function rankedFromBars(spec: Record<string, unknown>): Record<string, unknown> | undefined {
		const series = Array.isArray(spec.series) ? spec.series.filter(isRecord) : [];
		if (series.length !== 1 || spec.metrics || spec.ranges || (isRecord(spec.x) && spec.x.type === 'time')) {
			return undefined;
		}
		const data = Array.isArray(series[0].data) ? series[0].data : [];
		const categories = Array.isArray(spec.categories) ? spec.categories : [];
		const rows: { label: string; value: number; href?: string; detail?: string }[] = [];
		data.forEach((datum, index) => {
			let label: unknown = categories[index];
			let value: unknown = datum;
			let href: string | undefined;
			if (Array.isArray(datum)) {
				label = datum[0];
				value = datum[1];
			} else if (isRecord(datum)) {
				label = datum.x ?? datum.label ?? label;
				value = datum.y ?? datum.value;
				href = safeHref(datum.href);
			}
			const text = str(label, 200);
			if (text && isNum(value) && !looksLikeTime(text)) {
				rows.push({ label: text, value, ...(href ? { href } : {}) });
			}
		});
		if (rows.length < 6 || rows.length !== data.length) {
			return undefined;
		}
		const chars = rows.reduce((sum, row) => sum + row.label.length, 0);
		if (chars / rows.length < 12 && chars < 110) {
			return undefined;
		}
		return { type: 'ranked', title: spec.title, subtitle: spec.subtitle, note: spec.note, unit: series[0].unit ?? spec.unit ?? (isRecord(spec.y) ? spec.y.unit : undefined), limit: rows.length <= 15 ? rows.length : 10, data: rows, color: series[0].color };
	}

	/** The spec a variant shows: the base with the variant's fields on top. */
	function variantSpec(spec: Record<string, unknown>, index: number): Record<string, unknown> {
		const variants = Array.isArray(spec.variants) ? spec.variants.filter(isRecord) : [];
		const { variants: _variants, variant: _variant, ...base } = spec;
		const { label: _label, ...overrides } = variants[index] ?? {};
		return { ...base, ...overrides };
	}

	function initialVariant(spec: Record<string, unknown>): number {
		const variants = Array.isArray(spec.variants) ? spec.variants.filter(isRecord) : [];
		if (isNum(spec.variant)) {
			return clamp(Math.round(spec.variant), 0, Math.max(0, variants.length - 1));
		}
		const named = variants.findIndex(variant => variant.label === spec.variant);
		return named < 0 ? 0 : named;
	}

	/**
	 * Any chart with `variants`: a switcher beside its title (Lines | Churn, Local | UTC). Line and
	 * bar variants morph into each other; other types crossfade.
	 */
	class VariantBlock implements IBlock {
		readonly element: HTMLElement;
		private readonly host: HTMLElement;
		private readonly control: ISegmented;
		private inner: IBlock;
		private index: number;
		private width = 0;

		constructor(parent: HTMLElement, private readonly spec: Record<string, unknown>, private readonly ctx: IContext, problems: string[], private readonly where: string) {
			this.element = h('div', 'vc-block vc-variants', parent);
			const variants = (spec.variants as unknown[]).filter(isRecord);
			variants.forEach((variant, index) => {
				if (!str(variant.label, 40)) {
					problems.push(`${where}.variants[${index}]: give each variant a short "label".`);
				}
			});
			const head = h('div', 'vc-variant-head', this.element);
			blockHead(head, spec.title, spec.subtitle);
			this.index = initialVariant(spec);
			this.control = segmented(head, 'View', variants.map((variant, index) => ({ id: String(index), label: str(variant.label, 40) ?? String(index + 1) })), String(this.index), id => this.select(Number(id)));
			this.host = h('div', '', this.element);
			this.inner = createBlock(this.host, this.innerSpec(this.index), ctx, problems, `${where}.variants[${this.index}]`);
		}

		private innerSpec(index: number): Record<string, unknown> {
			// The title and subtitle stay above the switcher; each variant may still bring its own note.
			return { ...variantSpec(this.spec, index), title: undefined, subtitle: undefined };
		}

		private select(index: number): void {
			this.index = index;
			const next = this.innerSpec(index);
			const nextType = chartType(next);
			if (this.inner instanceof CartesianChart && (CARTESIAN_TYPES as readonly string[]).includes(nextType) && !(nextType === 'bar' && rankedFromBars(next))) {
				this.inner.setSpec({ ...next, type: nextType }, [], this.where);
				return;
			}
			const old = this.inner;
			const animate = this.ctx.animate;
			this.ctx.animate = false;
			this.inner = createBlock(this.host, next, this.ctx, [], this.where);
			this.ctx.animate = animate;
			old.element.remove();
			old.dispose();
			if (this.width) {
				this.inner.layout(this.width);
			}
			if (!reducedMotion()) {
				this.inner.element.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
			}
		}

		layout(width: number): void {
			this.width = width;
			this.control.refresh();
			this.inner.layout(width);
		}

		setLoading(loading: boolean): void {
			this.inner.setLoading?.(loading);
		}

		dispose(): void {
			this.inner.dispose();
		}
	}

	function createBlock(parent: HTMLElement, spec: Record<string, unknown>, ctx: IContext, problems: string[], where: string): IBlock {
		if (Array.isArray(spec.variants) && spec.variants.filter(isRecord).length > 1) {
			return new VariantBlock(parent, spec, ctx, problems, where);
		}
		const type = chartType(spec);
		if (type === 'bar') {
			const ranked = rankedFromBars(spec);
			if (ranked) {
				return new RankedBlock(parent, ranked, ctx, problems, where);
			}
		}
		switch (type) {
			case 'stats': return new StatsBlock(parent, spec, ctx, problems, where);
			case 'heatmap': return new HeatmapBlock(parent, spec, ctx, problems, where);
			case 'treemap': return new TreemapBlock(parent, spec, ctx, problems, where);
			case 'donut': return new DonutBlock(parent, spec, ctx, problems, where);
			case 'ranked': return new RankedBlock(parent, spec, ctx, problems, where);
			case 'row': return new RowBlock(parent, spec, ctx, problems, where);
			case 'gauge': return new GaugeBlock(parent, spec, ctx, problems, where);
			case 'rings': return new RingBlock(parent, spec, ctx, problems, where);
			case 'radar': return new RadarBlock(parent, spec, ctx, problems, where);
			case 'funnel': return new FunnelBlock(parent, spec, ctx, problems, where);
			case 'sunburst': return new SunburstBlock(parent, spec, ctx, problems, where);
			case 'sankey': return new SankeyBlock(parent, spec, ctx, problems, where);
			case 'candlestick': return new CandlestickBlock(parent, spec, ctx, problems, where);
			case 'cumulative': {
				const { spec: lineSpec, tooltip } = cumulativeSpec(spec, problems, where);
				return new CartesianChart(parent, lineSpec, ctx, problems, where, tooltip);
			}
			default:
				if (!(CARTESIAN_TYPES as readonly string[]).includes(type)) {
					problems.push(`${where}: unknown chart type "${type}". Use one of: ${[...CARTESIAN_TYPES, 'heatmap', 'treemap', 'sunburst', 'donut', 'ranked', 'funnel', 'gauge', 'rings', 'radar', 'sankey', 'candlestick', 'cumulative', 'stats', 'row'].join(', ')}.`);
				}
				return new CartesianChart(parent, { ...spec, type: (CARTESIAN_TYPES as readonly string[]).includes(type) ? type : (spec.series || spec.metrics ? 'line' : type) }, ctx, problems, where);
		}
	}

	interface IParsedVisual {
		readonly title?: string;
		readonly subtitle?: string;
		readonly charts: readonly Record<string, unknown>[];
	}

	function parseVisual(input: unknown, problems: string[]): IParsedVisual {
		let value = input;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				problems.push('The visual is not valid JSON.');
				return { charts: [] };
			}
		}
		if (Array.isArray(value)) {
			return { charts: value.filter(isRecord) };
		}
		if (!isRecord(value)) {
			problems.push('Pass a chart spec object, or { "charts": [ ... ] }.');
			return { charts: [] };
		}
		if (Array.isArray(value.charts) && (value.type === undefined || value.type === 'visual' || value.type === 'dashboard')) {
			const charts = value.charts.filter(isRecord).slice(0, 24);
			if (!charts.length) {
				problems.push('"charts" is empty.');
			}
			return { title: str(value.title, 160), subtitle: str(value.subtitle, 300), charts };
		}
		return { charts: [value] };
	}

	class Visual implements IVoltChartsHandle {
		readonly element: HTMLElement;
		private readonly head: HTMLElement;
		private readonly body: HTMLElement;
		private blocks: IBlock[] = [];
		private types: string[] = [];
		private width = 0;
		private frame = 0;
		private readonly observer: ResizeObserver | undefined;
		private readonly themeObserver: MutationObserver | undefined;
		private disposed = false;
		private loading = false;

		constructor(container: HTMLElement, input: unknown, private readonly ctx: IContext) {
			ensureStyles(container.ownerDocument);
			this.element = ctx.root;
			this.element.classList.add('vc-root');
			container.appendChild(this.element);
			this.head = h('div', 'vc-visual-head', this.element);
			this.body = h('div', 'vc-blocks', this.element);
			this.setInput(input, []);
			this.syncTheme();
			if (typeof win.ResizeObserver === 'function') {
				this.observer = new win.ResizeObserver(() => this.schedule());
				this.observer.observe(this.element);
			}
			const themeTarget = container.closest('.monaco-workbench') ?? container.ownerDocument.body;
			if (themeTarget && typeof win.MutationObserver === 'function') {
				this.themeObserver = new win.MutationObserver(() => this.syncTheme());
				this.themeObserver.observe(themeTarget, { attributes: true, attributeFilter: ['class'] });
			}
			this.schedule();
		}

		private syncTheme(): void {
			this.element.classList.toggle('vc-light', isLightTheme(this.element));
		}

		private setInput(input: unknown, problems: string[]): void {
			const visual = parseVisual(input, problems);
			this.head.replaceChildren();
			const title = visual.title;
			const subtitle = visual.subtitle;
			if (title) {
				h('div', 'vc-visual-title', this.head, title).setAttribute('role', 'heading');
			}
			if (subtitle) {
				h('div', 'vc-visual-subtitle', this.head, subtitle);
			}
			this.head.style.display = title || subtitle ? '' : 'none';
			const types = visual.charts.map(chartType);
			const reuse = types.length === this.types.length && types.every((type, index) => type === this.types[index]);
			if (reuse) {
				visual.charts.forEach((chart, index) => {
					const block = this.blocks[index];
					if (block instanceof CartesianChart && types[index] !== 'cumulative') {
						block.setSpec({ ...chart, type: (CARTESIAN_TYPES as readonly string[]).includes(types[index]) ? types[index] : 'line' }, problems, `charts[${index}]`);
					} else {
						const next = createBlock(this.body, chart, this.ctx, problems, `charts[${index}]`);
						this.body.replaceChild(next.element, block.element);
						block.dispose();
						this.blocks[index] = next;
						if (this.width) {
							next.layout(this.width);
						}
					}
				});
			} else {
				for (const block of this.blocks) {
					block.dispose();
				}
				this.body.replaceChildren();
				this.blocks = visual.charts.map((chart, index) => createBlock(this.body, chart, this.ctx, problems, `charts[${index}]`));
				this.types = types;
				this.width = 0;
			}
			if (this.loading) {
				for (const block of this.blocks) {
					block.setLoading?.(true);
				}
			}
			this.element.setAttribute('role', 'figure');
			this.element.setAttribute('aria-label', title ?? visual.charts.map(chart => str(chart.title)).filter(Boolean).join('; ') ?? this.ctx.strings.chart);
		}

		private schedule(): void {
			if (this.frame || this.disposed) {
				return;
			}
			this.frame = win.requestAnimationFrame(() => {
				this.frame = 0;
				this.layout();
			});
		}

		layout(): void {
			if (this.disposed) {
				return;
			}
			const width = Math.floor(this.element.clientWidth);
			if (!width) {
				return;
			}
			const changed = width !== this.width;
			this.width = width;
			for (const block of this.blocks) {
				block.layout(changed ? width : Math.floor(block.element.clientWidth) || width);
			}
			this.ctx.animate = false;
		}

		update(input: unknown, animate = true): void {
			this.ctx.animate = animate;
			this.setInput(input, []);
			this.width = 0;
			this.layout();
			this.ctx.animate = false;
		}

		setLoading(loading: boolean): void {
			this.loading = loading;
			this.element.classList.toggle('vc-loading', loading);
			for (const block of this.blocks) {
				block.setLoading?.(loading);
			}
		}

		dispose(): void {
			this.disposed = true;
			if (this.frame) {
				win.cancelAnimationFrame(this.frame);
			}
			this.observer?.disconnect();
			this.themeObserver?.disconnect();
			for (const block of this.blocks) {
				block.dispose();
			}
			this.blocks = [];
			this.element.remove();
		}
	}

	//#endregion

	//#region API

	function flattenCharts(charts: readonly Record<string, unknown>[]): Record<string, unknown>[] {
		return charts.flatMap(chart => {
			if (chartType(chart) === 'row' && Array.isArray(chart.charts)) {
				return flattenCharts(chart.charts.filter(isRecord));
			}
			const variants = Array.isArray(chart.variants) ? chart.variants.filter(isRecord) : [];
			if (variants.length > 1) {
				return variants.map((variant, index) => ({ ...variantSpec(chart, index), title: [str(chart.title, 120), str(variant.label, 40)].filter(Boolean).join(' · ') }));
			}
			return [chart];
		});
	}

	/** How many values a chart would draw. */
	function countData(spec: Record<string, unknown>): number {
		if (Array.isArray(spec.variants) && spec.variants.filter(isRecord).length > 1) {
			return countData(variantSpec(spec, initialVariant(spec)));
		}
		const finite = (list: unknown) => Array.isArray(list) ? list.filter(isNum).length : 0;
		switch (chartType(spec)) {
			case 'stats':
				return Array.isArray(spec.items) ? spec.items.filter(isRecord).length : 0;
			case 'heatmap':
				return heatmapGrid(spec).values.reduce((sum: number, row) => sum + finite(row), 0);
			case 'treemap': {
				const leaves = (node: unknown): number => !isRecord(node) ? 0 : Array.isArray(node.children) && node.children.length ? node.children.reduce((sum: number, child) => sum + leaves(child), 0) : (isNum(node.value) && node.value > 0 ? 1 : 0);
				return Array.isArray(spec.data) ? spec.data.reduce((sum: number, node) => sum + leaves(node), 0) : leaves(spec.data);
			}
			case 'donut':
			case 'ranked':
			case 'funnel':
				return readParts(partsData(spec), [], '').length;
			case 'cumulative':
				return finite(spec.values);
			case 'gauge':
				return Array.isArray(spec.data) ? spec.data.filter(item => isRecord(item) && isNum(item.value)).length : isNum(spec.value) ? 1 : 0;
			case 'rings':
			case 'candlestick':
				return Array.isArray(spec.data) ? spec.data.filter(item => isRecord(item) || Array.isArray(item)).length : 0;
			case 'radar':
				return Array.isArray(spec.series) ? spec.series.filter(isRecord).reduce((sum: number, series) => sum + finite(series.data), 0) : 0;
			case 'sankey':
				return Array.isArray(spec.links) ? spec.links.filter(link => isRecord(link) && isNum(link.value) && link.value > 0).length : 0;
			case 'sunburst': {
				const leaves = (node: unknown): number => !isRecord(node) ? 0 : Array.isArray(node.children) && node.children.length ? node.children.reduce((sum: number, child) => sum + leaves(child), 0) : (isNum(node.value) && node.value > 0 ? 1 : 0);
				return Array.isArray(spec.data) ? spec.data.reduce((sum: number, node) => sum + leaves(node), 0) : leaves(spec.data);
			}
			case 'row':
				return Array.isArray(spec.charts) ? spec.charts.filter(isRecord).reduce((sum: number, chart) => sum + countData(chart), 0) : 0;
			default: {
				const model = parseCartesian(spec, [], '');
				return model.metrics.reduce((sum, metric) => sum + metric.series.reduce((count, series) => count + series.points.filter(point => Number.isFinite(point.y)).length, 0), 0);
			}
		}
	}

	function inspect(input: unknown): { problems: string[]; charts: number; points: number; empty: number } {
		const problems: string[] = [];
		const visual = parseVisual(input, problems);
		const host = doc.createElement('div');
		const ctx: IContext = { strings: DEFAULT_STRINGS, animate: false, root: host };
		let points = 0;
		visual.charts.forEach((chart, index) => {
			createBlock(host, chart, ctx, problems, `charts[${index}]`).dispose();
			const count = countData(chart);
			if (!count) {
				problems.push(`charts[${index}]${typeof chart.title === 'string' ? ` ("${chart.title}")` : ''}: has no values to draw.`);
			}
			points += count;
		});
		// Charts that would draw as an empty card, counting each chart of a row and each variant.
		const empty = flattenCharts(visual.charts).filter(chart => !countData(chart));
		for (const chart of empty) {
			if (typeof chart.title === 'string') {
				problems.push(`"${chart.title}": has no values to draw.`);
			}
		}
		return { problems: [...new Set(problems)], charts: visual.charts.length, points, empty: empty.length };
	}

	function csvCell(value: unknown): string {
		const text = value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value);
		return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	}

	function toCsv(input: unknown): string {
		const visual = parseVisual(input, []);
		const out: string[] = [];
		const table = (title: unknown, rows: readonly (readonly unknown[])[]) => {
			if (out.length) {
				out.push('');
			}
			const name = str(title, 160);
			if (name) {
				out.push(`# ${name}`);
			}
			for (const row of rows) {
				out.push(row.map(csvCell).join(','));
			}
		};
		for (const chart of flattenCharts(visual.charts)) {
			const type = chartType(chart);
			if (type === 'stats') {
				table(chart.title, [['label', 'value'], ...(Array.isArray(chart.items) ? chart.items.filter(isRecord).map(item => [item.label, item.value]) : [])]);
			} else if (type === 'heatmap') {
				const { rows, columns, values } = heatmapGrid(chart);
				table(chart.title, [['', ...columns], ...rows.map((row, index) => [row, ...(Array.isArray(values[index]) ? values[index] : [])])]);
			} else if (type === 'treemap') {
				const root = readTree(chart.data, [], '');
				const rows: unknown[][] = [['path', 'value', 'color']];
				const walk = (node: ITreeNode) => node.children.length ? node.children.forEach(walk) : rows.push([node.path, node.value, node.color]);
				walk(root);
				table(chart.title, rows);
			} else if (type === 'donut' || type === 'ranked') {
				table(chart.title, [['label', 'value'], ...readParts(partsData(chart), [], '').map(part => [part.label, part.value])]);
			} else if (type === 'sunburst') {
				const root = readTree(chart.data, [], '');
				const rows: unknown[][] = [['path', 'value']];
				const walk = (node: ITreeNode) => node.children.length ? node.children.forEach(walk) : rows.push([node.path, node.value]);
				walk(root);
				table(chart.title, rows);
			} else if (type === 'funnel' || type === 'rings' || type === 'gauge') {
				const items = Array.isArray(chart.data) ? chart.data.filter(isRecord) : [{ label: chart.label, value: chart.value, max: chart.max }];
				table(chart.title, [['label', 'value', 'max'], ...items.map(item => [item.label ?? item.name, item.value, item.max])]);
			} else if (type === 'radar') {
				const axes = (Array.isArray(chart.axes) ? chart.axes : []).map(axis => isRecord(axis) ? axis.label : axis);
				table(chart.title, [['series', ...axes], ...(Array.isArray(chart.series) ? chart.series.filter(isRecord) : []).map(series => [series.name, ...(Array.isArray(series.data) ? series.data : [])])]);
			} else if (type === 'sankey') {
				table(chart.title, [['source', 'target', 'value'], ...(Array.isArray(chart.links) ? chart.links.filter(isRecord) : []).map(link => [link.source ?? link.from, link.target ?? link.to, link.value])]);
			} else if (type === 'candlestick') {
				table(chart.title, [['x', 'open', 'high', 'low', 'close'], ...(Array.isArray(chart.data) ? chart.data : []).map(item => Array.isArray(item) ? item.slice(0, 5) : isRecord(item) ? [item.x ?? item.time ?? item.date, item.open, item.high, item.low, item.close] : [])]);
			} else if (type === 'cumulative') {
				const values = (Array.isArray(chart.values) ? chart.values : []).filter(isNum).sort((a, b) => b - a);
				table(chart.title, [['rank', 'value'], ...values.map((value, index) => [index + 1, value])]);
			} else {
				const model = parseCartesian({ ...chart, type: (CARTESIAN_TYPES as readonly string[]).includes(type) ? type : 'line' }, [], '');
				for (const metric of model.metrics) {
					const xs = [...new Set(metric.series.flatMap(series => series.points.map(point => point.x)))].sort((a, b) => a - b);
					const header = ['x', ...metric.series.map(series => series.name)];
					const lookup = metric.series.map(series => new Map(series.points.map(point => [point.x, point.y])));
					const label = (x: number) => model.xKind === 'time' ? new Date(x).toISOString() : model.xKind === 'category' ? model.categories[x] : x;
					table(model.metrics.length > 1 ? `${str(chart.title) ?? ''} · ${metric.label}` : chart.title, [header, ...xs.map(x => [label(x), ...lookup.map(map => map.get(x))])]);
				}
			}
		}
		return out.join('\n');
	}

	function describe(input: unknown): string {
		const visual = parseVisual(input, []);
		const lines = flattenCharts(visual.charts).map(chart => {
			const type = chartType(chart);
			const title = str(chart.title, 160);
			let detail = '';
			if (type === 'stats') {
				detail = (Array.isArray(chart.items) ? chart.items.filter(isRecord) : []).map(item => `${str(item.label) ?? ''} ${isNum(item.value) ? formatValue(item.value, resolveUnit(item.unit, str(item.label))) : str(item.value) ?? ''}`).join(', ');
			} else if (CARTESIAN_TYPES.includes(type as VoltCartesianType) || type === 'line') {
				const metrics = Array.isArray(chart.metrics) ? chart.metrics.filter(isRecord) : [{ series: chart.series }];
				detail = metrics.flatMap(metric => (Array.isArray(metric.series) ? metric.series : []).filter(isRecord).map(series => str(series.name) ?? '')).filter(Boolean).join(', ');
			}
			return `${title ?? type}${detail ? ` (${type}: ${detail})` : ` (${type})`}`;
		});
		return [str(visual.title, 160), ...lines].filter(Boolean).join('\n');
	}

	function render(container: HTMLElement, visual: unknown, options?: IVoltChartsRenderOptions): IVoltChartsHandle {
		if (options?.locale) {
			locale = options.locale;
		}
		const ctx: IContext = {
			strings: { ...DEFAULT_STRINGS, ...options?.strings },
			onOpen: options?.onOpen,
			animate: options?.animate !== false,
			root: doc.createElement('div'),
		};
		return new Visual(container, visual, ctx);
	}

	function mountAll(root: ParentNode = doc, options?: IVoltChartsRenderOptions): IVoltChartsHandle[] {
		const handles: IVoltChartsHandle[] = [];
		for (const script of Array.from(root.querySelectorAll<HTMLScriptElement>('script[type="application/volt-chart+json"]'))) {
			if (script.dataset.vcMounted) {
				continue;
			}
			script.dataset.vcMounted = '1';
			const host = doc.createElement('div');
			host.className = script.className;
			script.after(host);
			handles.push(render(host, script.textContent ?? '', options));
		}
		for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-volt-chart]'))) {
			if (element.dataset.vcMounted || element.tagName === 'SCRIPT') {
				continue;
			}
			element.dataset.vcMounted = '1';
			const source = element.getAttribute('data-volt-chart') || element.textContent || '';
			element.textContent = '';
			handles.push(render(element, source, options));
		}
		return handles;
	}

	const api: IVoltChartsApi & { inspect: typeof inspect } = { version: VERSION, render, validate: input => inspect(input).problems, inspect, toCsv, describe, mountAll };
	return api;

	//#endregion
}

/** What the workbench gets from `voltChartsRuntime`: the public API plus `inspect`, which the host tools use. */
export type IVoltChartsRuntime = IVoltChartsApi & {
	inspect(visual: unknown): { problems: string[]; charts: number; points: number; empty: number };
};
