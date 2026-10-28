/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { localize } from '../../../../../nls.js';
import { chartsGreen, editorBackground, focusBorder, foreground } from '../../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { colorRegistry, historyItemRefColor } from '../../../scm/browser/scmHistory.js';

const DAY = 24 * 60 * 60 * 1000;
const HEIGHT = 64;
const PAD_X = 12;
/** Month labels under the bars. */
const AXIS = 14;
/** The track at the very bottom: where the rows on screen sit in history. */
const TRACK = 8;
/** How close (px) to a selection edge counts as grabbing its handle. */
const HANDLE_REACH = 6;
/** A press that moves less than this is a click (go to that day), not a drag. */
const CLICK_SLOP = 3;

/** One local day: its midnight (epoch ms), commits, and commits whose trailers name a coding agent. */
export type ActivityDay = readonly [day: number, commits: number, agents: number];

/** A selected span of days: from the first day's midnight to the end of the last day. */
export interface IActivityRange {
	readonly start: number;
	readonly end: number;
}

/** A pixel column of the strip: the days that fall in it, summed. */
interface IColumn {
	readonly x: number;
	readonly first: number;
	readonly last: number;
	readonly commits: number;
	readonly agents: number;
}

interface ITimeRange {
	readonly first: number;
	readonly last: number;
	readonly clipped: boolean;
}

type Drag =
	| { readonly kind: 'new'; readonly anchor: number; readonly startX: number }
	| { readonly kind: 'left' | 'right'; readonly startX: number }
	| { readonly kind: 'move'; readonly startX: number; readonly from: IActivityRange };

/**
 * The history at a glance, with the overview of Chrome DevTools' Network panel: a bar per day (or
 * per pixel column on a long history), its agent share tinted, month ticks, and a track at the
 * bottom whose thumb is the rows on screen. Drag across it to select a range (the graph dims
 * commits outside it), drag the handles to resize, drag inside to move it, double-click or Esc
 * to clear. A click without dragging goes to that day. One canvas, redrawn at most once a frame.
 */
export class GitGraphActivity extends Disposable {

	readonly element: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly readout: HTMLElement;
	private days: readonly ActivityDay[] = [];
	private columns: IColumn[] = [];
	private columnsWidth = -1;
	private width = 0;
	private viewport: { newest: number; oldest: number } | undefined;
	private selectedDay: number | undefined;
	private matches: ReadonlySet<number> | undefined;
	private hoverX: number | undefined;
	private selection: IActivityRange | undefined;
	private drag: Drag | undefined;
	private readonly frame = this._register(new MutableDisposable());
	private readonly dragListeners = this._register(new MutableDisposable());
	private readonly dayFormat = safeIntl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
	private readonly shortFormat = safeIntl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
	private readonly monthFormat = safeIntl.DateTimeFormat(language, { month: 'short' });

	private readonly _onDidChangeRange = this._register(new Emitter<IActivityRange | undefined>());
	/** The selected range changed (undefined: cleared). Fires once a drag ends, not while it moves. */
	readonly onDidChangeRange: Event<IActivityRange | undefined> = this._onDidChangeRange.event;

	constructor(
		parent: HTMLElement,
		private readonly onPickDay: (day: number) => void,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this.element = append(parent, $('.vgg-activity'));
		this.element.setAttribute('role', 'group');
		this.element.tabIndex = 0;
		this.canvas = append(this.element, $('canvas')) as HTMLCanvasElement;
		this.readout = append(this.element, $('.vgg-activity-readout'));
		this._register(this.themeService.onDidColorThemeChange(() => this.schedule()));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_DOWN, e => this.onPointerDown(e)));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_MOVE, e => {
			if (this.drag) {
				return;
			}
			this.hoverX = e.offsetX;
			this.canvas.style.cursor = this.cursorAt(e.offsetX);
			this.showReadout(this.columnAt(e.offsetX));
			this.schedule();
		}));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_LEAVE, () => {
			if (this.drag) {
				return;
			}
			this.hoverX = undefined;
			this.showReadout(undefined);
			this.schedule();
		}));
		this._register(addDisposableListener(this.canvas, EventType.DBLCLICK, () => this.setRange(undefined, true)));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && this.selection) {
				e.preventDefault();
				e.stopPropagation();
				this.setRange(undefined, true);
			}
		}));
	}

	get range(): IActivityRange | undefined {
		return this.selection;
	}

	/** The whole history's days (from git), oldest first. */
	setDays(days: readonly ActivityDay[]): void {
		this.days = days;
		this.columnsWidth = -1;
		const commits = days.reduce((sum, day) => sum + day[1], 0);
		this.element.setAttribute('aria-label', localize('voltGitGraph.activityAria', "Commit activity: {0} commits over {1} days. Drag to select a range.", commits, days.length));
		this.schedule();
	}

	/** The rows on screen, as their newest and oldest commit times. */
	setViewport(newest: number | undefined, oldest: number | undefined): void {
		const next = newest !== undefined && oldest !== undefined ? { newest, oldest } : undefined;
		if (next?.newest !== this.viewport?.newest || next?.oldest !== this.viewport?.oldest) {
			this.viewport = next;
			this.schedule();
		}
	}

	/** Days with search results, marked above their bars; undefined outside a search. */
	setMatches(days: ReadonlySet<number> | undefined): void {
		this.matches = days;
		this.schedule();
	}

	select(timestamp: number | undefined): void {
		const day = timestamp ? startOfDay(timestamp) : undefined;
		if (day !== this.selectedDay) {
			this.selectedDay = day;
			this.schedule();
		}
	}

	/** Sets (or clears) the selected range; `notify` fires onDidChangeRange. */
	setRange(range: IActivityRange | undefined, notify: boolean): void {
		const same = range?.start === this.selection?.start && range?.end === this.selection?.end;
		this.selection = range;
		this.schedule();
		if (notify && !same) {
			this._onDidChangeRange.fire(range);
		}
	}

	layout(width: number): void {
		if (width !== this.width) {
			this.width = width;
			this.schedule();
		}
	}

	//#region Pointer: click, select, resize, move

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !this.timeRange()) {
			return;
		}
		e.preventDefault();
		this.element.focus();
		const x = e.offsetX;
		const edges = this.selectionEdges();
		if (edges && Math.abs(x - edges.x1) <= HANDLE_REACH) {
			this.drag = { kind: 'left', startX: x };
		} else if (edges && Math.abs(x - edges.x2) <= HANDLE_REACH) {
			this.drag = { kind: 'right', startX: x };
		} else if (edges && this.selection && x > edges.x1 && x < edges.x2) {
			this.drag = { kind: 'move', startX: x, from: this.selection };
		} else {
			this.drag = { kind: 'new', anchor: this.timeAt(x), startX: x };
		}
		this.canvas.setPointerCapture(e.pointerId);
		const targetWindow = getWindow(this.element);
		const left = this.canvas.getBoundingClientRect().left;
		const move = (event: PointerEvent) => this.onDragMove(event.clientX - left);
		const up = (event: PointerEvent) => this.onDragEnd(event.clientX - left);
		targetWindow.addEventListener('pointermove', move);
		targetWindow.addEventListener('pointerup', up);
		this.dragListeners.value = {
			dispose: () => {
				targetWindow.removeEventListener('pointermove', move);
				targetWindow.removeEventListener('pointerup', up);
			}
		};
	}

	private onDragMove(x: number): void {
		const drag = this.drag;
		if (!drag) {
			return;
		}
		this.hoverX = x;
		const t = this.timeAt(x);
		if (drag.kind === 'new') {
			if (Math.abs(x - drag.startX) >= CLICK_SLOP) {
				this.selection = toRange(drag.anchor, t);
			}
		} else if (drag.kind === 'move') {
			const span = drag.from.end - drag.from.start;
			const range = this.timeRange()!;
			const delta = this.timeAt(x) - this.timeAt(drag.startX);
			const start = Math.max(range.first, Math.min(range.last + DAY - span, drag.from.start + delta));
			this.selection = toRange(start, start + span);
		} else if (this.selection) {
			this.selection = drag.kind === 'left' ? toRange(t, this.selection.end) : toRange(this.selection.start, t);
		}
		if (this.selection) {
			this.showRangeReadout(this.selection);
		}
		this.schedule();
	}

	private onDragEnd(x: number): void {
		const drag = this.drag;
		this.drag = undefined;
		this.dragListeners.clear();
		if (!drag) {
			return;
		}
		if (drag.kind === 'new' && Math.abs(x - drag.startX) < CLICK_SLOP) {
			// A click: go to that day; a click outside the selection also clears it, as in DevTools.
			const column = this.columnAt(x);
			if (this.selection) {
				this.setRange(undefined, true);
			}
			if (column) {
				this.onPickDay(column.last);
			}
			return;
		}
		this.showReadout(undefined);
		this._onDidChangeRange.fire(this.selection);
		this.schedule();
	}

	private cursorAt(x: number): string {
		const edges = this.selectionEdges();
		if (edges && (Math.abs(x - edges.x1) <= HANDLE_REACH || Math.abs(x - edges.x2) <= HANDLE_REACH)) {
			return 'ew-resize';
		}
		if (edges && x > edges.x1 && x < edges.x2) {
			return 'grab';
		}
		return 'crosshair';
	}

	private selectionEdges(): { x1: number; x2: number } | undefined {
		const range = this.timeRange();
		if (!this.selection || !range) {
			return undefined;
		}
		return { x1: this.xFor(this.selection.start, range, this.width), x2: this.xFor(this.selection.end, range, this.width) };
	}

	//#endregion

	private schedule(): void {
		if (!this.frame.value) {
			this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.frame.clear();
				this.draw();
			});
		}
	}

	/**
	 * The span drawn: from the day the oldest 5% of commits end (so an imported base or a quiet
	 * year doesn't squash a busy month into a sliver) to today. Older days fold into the first column.
	 */
	private timeRange(): ITimeRange | undefined {
		if (!this.days.length) {
			return undefined;
		}
		const total = this.days.reduce((sum, day) => sum + day[1], 0);
		let seen = 0;
		let first = this.days[0][0];
		for (const [day, commits] of this.days) {
			seen += commits;
			if (seen >= total * 0.05) {
				first = day;
				break;
			}
		}
		const last = Math.max(this.days[this.days.length - 1][0], startOfDay(Date.now()));
		first = Math.min(first, last - 14 * DAY);
		return { first, last, clipped: this.days[0][0] < first };
	}

	private xFor(time: number, range: ITimeRange, width: number): number {
		const clamped = Math.max(range.first, Math.min(range.last + DAY, time));
		return PAD_X + ((clamped - range.first) / (range.last + DAY - range.first)) * (width - PAD_X * 2);
	}

	private timeAt(x: number): number {
		const range = this.timeRange()!;
		const ratio = Math.max(0, Math.min(1, (x - PAD_X) / Math.max(1, this.width - PAD_X * 2)));
		return range.first + ratio * (range.last + DAY - range.first);
	}

	/** Bars as wide as a day allows: 2px on a long history, up to 10px on a short one. */
	private barWidth(range: ITimeRange, width: number): number {
		const perDay = (width - PAD_X * 2) / Math.max(1, (range.last + DAY - range.first) / DAY);
		return Math.max(2, Math.min(10, Math.floor(perDay * 0.7)));
	}

	/** Days grouped by the pixel column they land in (each at its day's middle), so a long history is one bar per pixel. */
	private ensureColumns(width: number): IColumn[] {
		if (this.columnsWidth === width) {
			return this.columns;
		}
		const range = this.timeRange();
		const columns: IColumn[] = [];
		if (range) {
			let current: { x: number; first: number; last: number; commits: number; agents: number } | undefined;
			for (const [day, commits, agents] of this.days) {
				const x = Math.round(this.xFor(day + DAY / 2, range, width));
				if (current && current.x === x) {
					current.last = day;
					current.commits += commits;
					current.agents += agents;
				} else {
					if (current) {
						columns.push(current);
					}
					current = { x, first: day, last: day, commits, agents };
				}
			}
			if (current) {
				columns.push(current);
			}
		}
		this.columns = columns;
		this.columnsWidth = width;
		return columns;
	}

	private columnAt(x: number): IColumn | undefined {
		let best: IColumn | undefined;
		let distance = Infinity;
		for (const column of this.columns) {
			const d = Math.abs(column.x - x);
			if (d < distance) {
				distance = d;
				best = column;
			}
		}
		return distance <= 6 ? best : undefined;
	}

	private placeReadout(x: number): void {
		const width = this.readout.offsetWidth;
		this.readout.style.left = `${Math.max(4, Math.min(this.width - width - 4, x - width / 2))}px`;
	}

	private showReadout(column: IColumn | undefined): void {
		if (!column) {
			this.readout.classList.remove('visible');
			return;
		}
		const when = column.first === column.last
			? this.dayFormat.value.format(column.first)
			// allow-any-unicode-next-line
			: `${this.dayFormat.value.format(column.first)}– ${this.dayFormat.value.format(column.last)}`;
		this.readout.textContent = `${when} · ${this.countText(column.commits, column.agents)}`;
		this.readout.classList.add('visible');
		this.placeReadout(column.x);
	}

	private showRangeReadout(range: IActivityRange): void {
		const { commits, agents } = this.countIn(range);
		this.readout.textContent = `${this.rangeLabel(range)} · ${this.countText(commits, agents)}`;
		this.readout.classList.add('visible');
		const edges = this.selectionEdges();
		if (edges) {
			this.placeReadout((edges.x1 + edges.x2) / 2);
		}
	}

	/** "Sep 21 - Oct 3" (an en dash), or one day. */
	rangeLabel(range: IActivityRange): string {
		const first = startOfDay(range.start);
		const last = startOfDay(range.end);
		// allow-any-unicode-next-line
		return first === last ? this.shortFormat.value.format(first) : `${this.shortFormat.value.format(first)} – ${this.shortFormat.value.format(last)}`;
	}

	countIn(range: IActivityRange): { commits: number; agents: number } {
		let commits = 0;
		let agents = 0;
		for (const [day, count, agentCount] of this.days) {
			if (day >= range.start && day <= range.end) {
				commits += count;
				agents += agentCount;
			}
		}
		return { commits, agents };
	}

	private countText(commits: number, agents: number): string {
		const count = commits === 1 ? localize('voltGitGraph.activityOne', "1 commit") : localize('voltGitGraph.activityMany', "{0} commits", commits);
		return agents ? `${count}${localize('voltGitGraph.activityAgentsShort', ", {0} with agents", agents)}` : count;
	}

	private draw(): void {
		const width = this.width || this.element.clientWidth;
		const height = this.element.clientHeight || HEIGHT;
		const ratio = getWindow(this.element).devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(width * ratio));
		this.canvas.height = Math.max(1, Math.round(height * ratio));
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		const context = this.canvas.getContext('2d');
		const range = this.timeRange();
		if (!context) {
			return;
		}
		context.scale(ratio, ratio);
		context.clearRect(0, 0, width, height);
		if (!range) {
			return;
		}
		const theme = this.themeService.getColorTheme();
		// The graph's own branch blue, so the strip reads as part of it (focusBorder is grey in some themes).
		const blue = theme.getColor(historyItemRefColor) ?? theme.getColor(focusBorder);
		const accent = blue?.toString() ?? '#3794ff';
		// The graph's first lane colour (amber) for agents: charts.orange is faint or not orange in some themes.
		const agentColor = theme.getColor(colorRegistry[0])?.toString() ?? '#FFB000';
		const matchColor = theme.getColor(chartsGreen)?.toString() ?? '#89d185';
		const fg = theme.getColor(foreground);
		const muted = fg?.transparent(0.5).toString() ?? 'rgba(128,128,128,0.5)';
		const hairline = fg?.transparent(0.1).toString() ?? 'rgba(128,128,128,0.15)';
		const top = 8;
		const bottom = height - AXIS - TRACK;
		const columns = this.ensureColumns(width);
		const max = Math.max(1, ...columns.map(column => column.commits));
		const barHeight = (commits: number) => Math.max(2, (Math.sqrt(commits) / Math.sqrt(max)) * (bottom - top));
		const selection = this.selection;
		const inSelection = (column: IColumn) => !selection || (column.last >= startOfDay(selection.start) && column.first <= selection.end);

		// Baseline.
		context.fillStyle = hairline;
		context.fillRect(PAD_X, bottom, width - PAD_X * 2, 1);

		// Bars: commits, the agent share on the same bar. Outside a selection they go grey (not a faded
		// tint, which turns amber and blue muddy), so the range reads at a glance.
		const outside = fg?.transparent(0.16).toString() ?? 'rgba(128,128,128,0.2)';
		const matchedX = this.matches ? new Set([...this.matches].map(day => Math.round(this.xFor(day + DAY / 2, range, width)))) : undefined;
		const bar = this.barWidth(range, width);
		for (const column of columns) {
			const h = barHeight(column.commits);
			const left = Math.round(column.x - bar / 2);
			if (!inSelection(column)) {
				roundTop(context, left, bottom - h, bar, h, outside);
				continue;
			}
			roundTop(context, left, bottom - h, bar, h, accent);
			if (column.agents) {
				const share = Math.max(1, h * (column.agents / column.commits));
				roundTop(context, left, bottom - share, bar, share, agentColor);
			}
			if (matchedX?.has(column.x)) {
				context.fillStyle = matchColor;
				context.beginPath();
				context.arc(column.x, Math.max(top - 2, bottom - h - 4), 2, 0, Math.PI * 2);
				context.fill();
			}
		}

		// The selected commit's day, and the hovered column.
		for (const [time, color] of [[this.selectedDay, accent], [!this.drag && this.hoverX !== undefined ? this.columnAt(this.hoverX)?.last : undefined, muted]] as const) {
			if (time === undefined) {
				continue;
			}
			const x = Math.round(this.xFor(time + DAY / 2, range, width)) + 0.5;
			context.strokeStyle = color;
			context.lineWidth = 1;
			context.setLineDash(color === muted ? [2, 2] : []);
			context.beginPath();
			context.moveTo(x, 2);
			context.lineTo(x, bottom);
			context.stroke();
		}
		context.setLineDash([]);

		// The selection: a faint wash, a 1px edge each side, and a slim grip on each edge that widens
		// under the pointer (DevTools' overview).
		if (selection) {
			const x1 = Math.round(this.xFor(selection.start, range, width));
			const x2 = Math.max(x1 + 2, Math.round(this.xFor(selection.end, range, width)));
			context.fillStyle = blue?.transparent(0.07).toString() ?? 'rgba(55,148,255,0.07)';
			context.fillRect(x1, 0, x2 - x1, bottom);
			context.fillStyle = accent;
			context.fillRect(x1, 0, 1, bottom);
			context.fillRect(x2 - 1, 0, 1, bottom);
			const background = theme.getColor(editorBackground)?.toString() ?? '#1e1e1e';
			const hoverX = this.drag ? undefined : this.hoverX;
			for (const [x, kind] of [[x1, 'left'], [x2 - 1, 'right']] as const) {
				const active = this.drag?.kind === kind || (hoverX !== undefined && Math.abs(hoverX - x) <= HANDLE_REACH);
				const gripWidth = active ? 6 : 4;
				const gripHeight = Math.min(active ? 20 : 16, bottom - 4);
				const gripTop = Math.round((bottom - gripHeight) / 2);
				// A ring of the background keeps the grip clear of the bars behind it.
				context.fillStyle = background;
				roundRect(context, x + 0.5 - gripWidth / 2 - 1, gripTop - 1, gripWidth + 2, gripHeight + 2, 3);
				context.fill();
				context.fillStyle = accent;
				roundRect(context, x + 0.5 - gripWidth / 2, gripTop, gripWidth, gripHeight, 2);
				context.fill();
			}
		}

		// Month (or week) ticks, and a note when older history is folded into the first column.
		context.fillStyle = muted;
		context.font = `10px ${getWindow(this.element).getComputedStyle(this.element).fontFamily}`;
		context.textBaseline = 'alphabetic';
		const labelY = bottom + AXIS - 3;
		if (range.clipped) {
			// allow-any-unicode-next-line
			context.fillText(localize('voltGitGraph.activityOlder', "◂ older"), 2, labelY);
		}
		let lastLabelEnd = range.clipped ? 44 : -Infinity;
		const label = (time: number, text: string) => {
			const x = this.xFor(time, range, width);
			const labelWidth = context.measureText(text).width;
			if (x - labelWidth / 2 > lastLabelEnd + 8 && x + labelWidth / 2 < width - 2) {
				context.fillText(text, x - labelWidth / 2, labelY);
				context.fillRect(Math.round(x), bottom + 1, 1, 3);
				lastLabelEnd = x + labelWidth / 2;
			}
		};
		const span = range.last - range.first;
		if (span <= 62 * DAY) {
			const tick = new Date(range.first);
			tick.setHours(0, 0, 0, 0);
			tick.setDate(tick.getDate() + ((8 - tick.getDay()) % 7 || 7));
			while (tick.getTime() <= range.last) {
				label(tick.getTime(), this.shortFormat.value.format(tick));
				tick.setDate(tick.getDate() + 7);
			}
		} else {
			const stepMonths = span > 3 * 365 * DAY ? 12 : span > 365 * DAY ? 3 : 1;
			const tick = new Date(range.first);
			tick.setDate(1);
			tick.setHours(0, 0, 0, 0);
			tick.setMonth(tick.getMonth() + 1);
			while (tick.getTime() <= range.last) {
				label(tick.getTime(), tick.getMonth() === 0 || stepMonths === 12 ? String(tick.getFullYear()) : this.monthFormat.value.format(tick));
				tick.setMonth(tick.getMonth() + stepMonths);
			}
		}

		// Bottom track: the whole span as a hairline, the rows on screen as a thumb.
		const trackY = height - TRACK / 2 - 1;
		context.fillStyle = hairline;
		roundRect(context, PAD_X, trackY - 1, width - PAD_X * 2, 2, 1);
		context.fill();
		if (this.viewport) {
			const x1 = this.xFor(startOfDay(this.viewport.oldest), range, width);
			const x2 = this.xFor(startOfDay(this.viewport.newest) + DAY, range, width);
			const left = Math.min(x1, x2);
			const thumb = Math.max(8, Math.abs(x2 - x1));
			context.fillStyle = accent;
			roundRect(context, Math.min(left, width - PAD_X - thumb), trackY - 2, thumb, 4, 2);
			context.fill();
		}
	}
}

/** A range from two instants in either order, snapped out to whole days. */
function toRange(a: number, b: number): IActivityRange {
	const start = startOfDay(Math.min(a, b));
	const end = startOfDay(Math.max(a, b)) + DAY - 1;
	return { start, end };
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const radius = Math.min(r, w / 2, h / 2);
	context.beginPath();
	context.moveTo(x + radius, y);
	context.arcTo(x + w, y, x + w, y + h, radius);
	context.arcTo(x + w, y + h, x, y + h, radius);
	context.arcTo(x, y + h, x, y, radius);
	context.arcTo(x, y, x + w, y, radius);
	context.closePath();
}

/** A bar with its top corners rounded (1px), filled. */
function roundTop(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
	context.fillStyle = color;
	if (w < 4 || h < 3) {
		context.fillRect(x, y, w, h);
		return;
	}
	context.beginPath();
	context.moveTo(x, y + h);
	context.lineTo(x, y + 1.5);
	context.arcTo(x, y, x + 1.5, y, 1.5);
	context.lineTo(x + w - 1.5, y);
	context.arcTo(x + w, y, x + w, y + 1.5, 1.5);
	context.lineTo(x + w, y + h);
	context.closePath();
	context.fill();
}

export function startOfDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
