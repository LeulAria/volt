/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';

const DAY = 24 * 60 * 60 * 1000;

/** A span of whole local days: the first day's midnight to the last day's end. */
export interface IDateRange {
	readonly start: number;
	readonly end: number;
}

export interface IDateRangePickerOptions {
	readonly initial?: IDateRange;
	/** Commits in a range, for the footer ("412 commits"); undefined hides it. */
	readonly count?: (range: IDateRange) => number | undefined;
	readonly onApply: (range: IDateRange) => void;
	readonly onCancel: () => void;
}

function midnight(time: number): number {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function endOfDay(time: number): number {
	return midnight(time) + DAY - 1;
}

/** Ranges from today back, in local time; the presets column. */
export function dateRangePresets(now: Date): { label: string; range: IDateRange }[] {
	const today = midnight(now.getTime());
	const daysBack = (days: number) => ({ start: today - days * DAY, end: endOfDay(today) });
	const monthStart = new Date(today);
	monthStart.setDate(1);
	const lastMonthStart = new Date(monthStart);
	lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
	const yearStart = new Date(today);
	yearStart.setMonth(0, 1);
	return [
		{ label: localize('voltGitGraph.pickToday', "Today"), range: { start: today, end: endOfDay(today) } },
		{ label: localize('voltGitGraph.pickYesterday', "Yesterday"), range: { start: today - DAY, end: today - 1 } },
		{ label: localize('voltGitGraph.pickWeek', "Last 7 days"), range: daysBack(6) },
		{ label: localize('voltGitGraph.pickMonth', "Last 30 days"), range: daysBack(29) },
		{ label: localize('voltGitGraph.pickThisMonth', "This month"), range: { start: monthStart.getTime(), end: endOfDay(today) } },
		{ label: localize('voltGitGraph.pickLastMonth', "Last month"), range: { start: lastMonthStart.getTime(), end: monthStart.getTime() - 1 } },
		{ label: localize('voltGitGraph.pickQuarter', "Last 90 days"), range: daysBack(89) },
		{ label: localize('voltGitGraph.pickYear', "This year"), range: { start: yearStart.getTime(), end: endOfDay(today) } },
	];
}

/**
 * A two-month range calendar (shadcn's look in the theme's colours): presets on the left, months
 * on the right with previous / next buttons to page, click a start day then an end day (the band follows the pointer
 * in between), and Apply. Days after today are disabled; today has a ring. Opaque, for a context view.
 */
export class DateRangePicker extends Disposable {

	readonly element: HTMLElement;
	private readonly monthsHost: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly apply: HTMLButtonElement;
	private readonly presetButtons: { button: HTMLButtonElement; range: IDateRange }[] = [];
	private readonly monthStore = this._register(new DisposableStore());
	/** First of the left month. */
	private month: Date;
	private start: number | undefined;
	private end: number | undefined;
	private hover: number | undefined;
	private cells: { cell: HTMLElement; button: HTMLButtonElement; day: number; outside: boolean }[] = [];
	private readonly today = midnight(Date.now());
	private readonly titleFormat = safeIntl.DateTimeFormat(language, { month: 'long', year: 'numeric' });
	private readonly longFormat = safeIntl.DateTimeFormat(language, { month: 'short', day: 'numeric', year: 'numeric' });
	private readonly dayLabelFormat = safeIntl.DateTimeFormat(language, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

	constructor(private readonly options: IDateRangePickerOptions) {
		super();
		this.start = options.initial ? midnight(options.initial.start) : undefined;
		this.end = options.initial ? midnight(options.initial.end) : undefined;
		const anchor = new Date(this.end ?? this.today);
		anchor.setDate(1);
		anchor.setMonth(anchor.getMonth() - 1);
		this.month = anchor;

		this.element = $('.vgg-datepicker');
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltGitGraph.pickerAria', "Choose a date range"));

		const body = append(this.element, $('.vgg-datepicker-body'));
		const presets = append(body, $('.vgg-datepicker-presets'));
		for (const preset of dateRangePresets(new Date())) {
			const button = append(presets, $('button.vgg-datepicker-preset')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = preset.label;
			this.presetButtons.push({ button, range: preset.range });
			this._register(addDisposableListener(button, EventType.CLICK, () => {
				this.start = midnight(preset.range.start);
				this.end = midnight(preset.range.end);
				const month = new Date(this.end);
				month.setDate(1);
				month.setMonth(month.getMonth() - 1);
				this.month = month;
				this.render();
			}));
		}
		this.monthsHost = append(body, $('.vgg-datepicker-months'));

		const footer = append(this.element, $('.vgg-datepicker-footer'));
		this.summary = append(footer, $('.vgg-datepicker-summary'));
		const actions = append(footer, $('.vgg-datepicker-actions'));
		const cancel = append(actions, $('button.vgg-datepicker-button')) as HTMLButtonElement;
		cancel.type = 'button';
		cancel.textContent = localize('voltGitGraph.pickCancel', "Cancel");
		this.apply = append(actions, $('button.vgg-datepicker-button.primary')) as HTMLButtonElement;
		this.apply.type = 'button';
		this.apply.textContent = localize('voltGitGraph.pickApply', "Apply");
		this._register(addDisposableListener(cancel, EventType.CLICK, () => options.onCancel()));
		this._register(addDisposableListener(this.apply, EventType.CLICK, () => this.commit()));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				options.onCancel();
			} else if (e.key === 'Enter' && this.start !== undefined && this.end !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.commit();
			}
		}));
		this.render();
	}

	focus(): void {
		(this.element.querySelector<HTMLElement>('.vgg-day.selected, .vgg-day.today') ?? this.apply).focus();
	}

	private commit(): void {
		if (this.start === undefined || this.end === undefined) {
			return;
		}
		this.options.onApply({ start: Math.min(this.start, this.end), end: endOfDay(Math.max(this.start, this.end)) });
	}

	private pick(day: number): void {
		if (this.start === undefined || this.end !== undefined) {
			// A new range starts.
			this.start = day;
			this.end = undefined;
		} else {
			this.end = day;
			if (this.end < this.start) {
				[this.start, this.end] = [this.end, this.start];
			}
		}
		this.hover = undefined;
		this.paint();
		this.renderSummary();
	}

	private render(): void {
		this.monthStore.clear();
		this.monthsHost.replaceChildren();
		this.cells = [];
		for (let offset = 0; offset < 2; offset++) {
			const month = new Date(this.month);
			month.setMonth(month.getMonth() + offset);
			this.renderMonth(month, offset === 0, offset === 1);
		}
		this.paint();
		this.renderSummary();
	}

	private renderMonth(month: Date, prev: boolean, next: boolean): void {
		const store = this.monthStore;
		const host = append(this.monthsHost, $('.vgg-month'));
		const head = append(host, $('.vgg-month-head'));
		const nav = (show: boolean, icon: typeof Codicon.chevronLeft, delta: number, label: string) => {
			const button = append(head, $('button.vgg-month-nav')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-label', label);
			button.appendChild(renderIcon(icon));
			button.style.visibility = show ? '' : 'hidden';
			// The right month already holds today: no paging into the future.
			if (delta > 0 && new Date(this.month).setMonth(this.month.getMonth() + 2) > this.today) {
				button.disabled = true;
			}
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				const moved = new Date(this.month);
				moved.setMonth(moved.getMonth() + delta);
				this.month = moved;
				this.render();
			}));
		};
		nav(prev, Codicon.chevronLeft, -1, localize('voltGitGraph.pickPrev', "Previous month"));
		append(head, $('.vgg-month-title')).textContent = this.titleFormat.value.format(month);
		nav(next, Codicon.chevronRight, 1, localize('voltGitGraph.pickNext', "Next month"));

		const grid = append(host, $('.vgg-month-grid'));
		grid.setAttribute('role', 'grid');
		const weekday = new Date(2026, 0, 4); // a Sunday
		const weekdayFormat = safeIntl.DateTimeFormat(language, { weekday: 'short' }).value;
		for (let i = 0; i < 7; i++) {
			append(grid, $('.vgg-weekday')).textContent = weekdayFormat.format(new Date(weekday.getTime() + i * DAY)).slice(0, 2);
		}

		const first = new Date(month);
		first.setDate(1);
		const cursor = new Date(first);
		cursor.setDate(1 - first.getDay());
		for (let i = 0; i < 42; i++) {
			const day = midnight(cursor.getTime());
			const outside = cursor.getMonth() !== month.getMonth();
			const cell = append(grid, $('.vgg-day-cell'));
			const button = append(cell, $('button.vgg-day')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = String(cursor.getDate());
			button.setAttribute('aria-label', this.dayLabelFormat.value.format(day));
			cell.classList.toggle('outside', outside);
			button.classList.toggle('today', day === this.today);
			button.disabled = day > this.today;
			this.cells.push({ cell, button, day, outside });
			store.add(addDisposableListener(button, EventType.CLICK, () => this.pick(day)));
			store.add(addDisposableListener(button, EventType.MOUSE_ENTER, () => {
				if (this.start !== undefined && this.end === undefined && this.hover !== day) {
					this.hover = day;
					this.paint();
				}
			}));
			cursor.setDate(cursor.getDate() + 1);
		}
	}

	/** Selection classes only: hovering paints the band without rebuilding the months. */
	private paint(): void {
		const low = this.start !== undefined ? Math.min(this.start, this.end ?? this.hover ?? this.start) : undefined;
		const high = this.start !== undefined ? Math.max(this.start, this.end ?? this.hover ?? this.start) : undefined;
		const preview = this.end === undefined;
		for (const { cell, button, day, outside } of this.cells) {
			const isStart = low !== undefined && day === low;
			const isEnd = high !== undefined && day === high;
			const inRange = low !== undefined && high !== undefined && day > low && day < high;
			button.classList.toggle('selected', !outside && (isStart || isEnd));
			cell.classList.toggle('in-range', inRange && !outside);
			cell.classList.toggle('range-start', isStart && high !== low && !outside);
			cell.classList.toggle('range-end', isEnd && high !== low && !outside);
			cell.classList.toggle('preview', preview);
		}
	}

	private renderSummary(): void {
		this.summary.replaceChildren();
		this.apply.disabled = this.start === undefined || this.end === undefined;
		for (const { button, range } of this.presetButtons) {
			button.classList.toggle('active', this.start === midnight(range.start) && this.end === midnight(range.end));
		}
		if (this.start === undefined) {
			append(this.summary, $('span.vgg-datepicker-hint')).textContent = localize('voltGitGraph.pickHintStart', "Pick the first day");
			return;
		}
		const low = Math.min(this.start, this.end ?? this.start);
		const high = Math.max(this.start, this.end ?? this.start);
		append(this.summary, $('span.vgg-datepicker-range')).textContent = this.end === undefined
			// allow-any-unicode-next-line
			? `${this.longFormat.value.format(low)} – …`
			// allow-any-unicode-next-line
			: low === high ? this.longFormat.value.format(low) : `${this.longFormat.value.format(low)} – ${this.longFormat.value.format(high)}`;
		if (this.end === undefined) {
			append(this.summary, $('span.vgg-datepicker-hint')).textContent = localize('voltGitGraph.pickHintEnd', "then the last day");
			return;
		}
		const days = Math.round((high - low) / DAY) + 1;
		const count = this.options.count?.({ start: low, end: endOfDay(high) });
		append(this.summary, $('span.vgg-datepicker-hint')).textContent = count === undefined
			? (days === 1 ? localize('voltGitGraph.pickOneDay', "1 day") : localize('voltGitGraph.pickDays', "{0} days", days))
			: localize('voltGitGraph.pickDaysCommits', "{0} days · {1} commits", days, count);
	}
}
