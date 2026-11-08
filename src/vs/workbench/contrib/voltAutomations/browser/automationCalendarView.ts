/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentAutomationsCalendar.css';
import { $, addDisposableListener, append, clearNode, disposableWindowInterval, getActiveDocument, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import {
	AutomationSchedule, describeSchedule, describeTrigger, formatDuration, gmtOffsetLabel, IAutomation, IAutomationRun, IAutomationService, isActiveRun, scheduleKindOf, weekdayName,
} from '../../../services/voltRuntime/common/automations/automations.js';
import { daySlots, ICalendarDaySlots, ICalendarRepeat, ICalendarRun, ICalendarSlot, isFrequentSchedule, isRoutineSchedule, packColumns, runPullRequest, runsBetween, triggerSlotsOnDay } from '../../../services/voltRuntime/common/automations/automationCalendar.js';
import { AUTOMATION_TEMPLATES } from '../../../services/voltRuntime/common/automations/automationTemplates.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { OPEN_AGENT_COMMAND_ID } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { addDays, addMonths, calendarWeeks, combineDayAndTime, dateTimeFormat, minutesOfDay, startOfDay, startOfMonth } from '../../voltAgent/browser/ui/dateTime/voltDateTime.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { AutomationsView, IAutomationsHost } from '../../voltAgent/browser/automations/automationRoutes.js';
import { button, iconButton } from '../../voltAgent/browser/automations/automationUi.js';

export type CalendarView = Exclude<AutomationsView, 'list'>;

export interface IAutomationCalendarOptions {
	readonly view: CalendarView;
	readonly date: number;
	/** The automations to show (the page's search applied). */
	readonly automations: () => readonly IAutomation[];
	readonly host: IAutomationsHost;
	/** The calendar moved itself (a day header, "+3 more", a key): the page keeps its tabs and route in step. */
	readonly onDidNavigate: (view: CalendarView, date: number) => void;
}

const HOUR = 3_600_000;
/** Weeks start on Monday, as the weekday pickers list them. */
const WEEK_START = 1;
const DAY_PAD = 18;
/** Hour widths; 0 fits the whole day to the width. Every hour keeps its label from the second step on. */
const DAY_ZOOMS = [0, 56, 88, 128, 192];
const WEEK_HOUR_HEIGHT = 48;
/** About fourteen hours on screen; the rest of the day scrolls. */
const WEEK_VIEWPORT = 672;
const MONTH_LINES = 3;
const MONTH_DOTS = 9;

/** Automation colours, given in creation order. Not green or red: those are outcomes. Light themes get deeper shades. */
const HUES = ['#a78bfa', '#60a5fa', '#2dd4bf', '#fbbf24', '#f0abfc', '#fb923c', '#7dd3fc', '#818cf8'];
const HUES_LIGHT = ['#7c3aed', '#2563eb', '#0d9488', '#b45309', '#c026d3', '#ea580c', '#0284c7', '#4f46e5'];
const SNAP_DAY = 15;
const SNAP_WEEK = 30;

/** Kept across pages and redraws, like the template category. */
let dayZoom = 2;
let showInactive = true;
/** Automations switched off in the filter. */
const hiddenIds = new Set<string>();

type Tone = 'ok' | 'fail' | 'run' | 'stop' | 'skip' | 'plan';

interface ICalendarItem {
	readonly title: string;
	readonly lines: readonly string[];
	readonly tone: Tone;
	readonly open?: () => void;
}

type CreatePick =
	| { readonly kind: 'new'; readonly schedule: AutomationSchedule; readonly templateId?: string }
	| { readonly kind: 'add'; readonly automationId: string; readonly schedule: AutomationSchedule }
	| { readonly kind: 'open'; readonly automationId: string };

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** "09:30": the calendar keeps a 24-hour clock, like the schedule chips. */
function clock(at: number): string {
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ordinal(day: number): string {
	const tens = day % 100;
	const suffix = tens >= 11 && tens <= 13 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
	return `${day}${suffix}`;
}

function startOfWeek(at: number): number {
	const day = startOfDay(at);
	return addDays(day, -((new Date(day).getDay() - WEEK_START + 7) % 7));
}

function toneOf(run: IAutomationRun): Tone {
	switch (run.status) {
		case 'succeeded': return 'ok';
		case 'failed': return 'fail';
		case 'queued':
		case 'running': return 'run';
		case 'cancelled': return 'stop';
		case 'skipped': return 'skip';
	}
}

function statusLabel(run: IAutomationRun): string {
	switch (run.status) {
		case 'succeeded': return localize('voltAutomations.cal.succeeded', "Succeeded");
		case 'failed': return localize('voltAutomations.cal.failed', "Failed");
		case 'queued': return localize('voltAutomations.cal.queued', "Queued");
		case 'running': return run.limited ? localize('voltAutomations.cal.limited', "Waiting for a usage limit") : localize('voltAutomations.cal.running', "Running");
		case 'cancelled': return localize('voltAutomations.cal.stopped', "Stopped");
		case 'skipped': return localize('voltAutomations.cal.skipped', "Skipped");
	}
}

/** Typical run length, from the last few runs that finished: drawn as a ghost after a planned slot. */
function expectedDuration(automation: IAutomation): number {
	const finished = automation.runs.filter(run => run.finishedAt && run.status !== 'skipped').slice(-5);
	if (!finished.length) {
		return 0;
	}
	const total = finished.reduce((sum, run) => sum + (run.finishedAt! - (run.startedAt ?? run.at)), 0);
	return Math.min(3 * HOUR, Math.max(0, total / finished.length));
}

/** A template's schedule moved to the picked time (its kind kept: weekly stays weekly, on the picked day). */
function adaptSchedule(spec: AutomationSchedule | undefined, at: number): AutomationSchedule {
	const date = new Date(at);
	const time = clock(at);
	switch (spec?.type) {
		case 'weekly': return { type: 'weekly', weekdays: [date.getDay()], time };
		case 'hourly': return { type: 'hourly', minute: date.getMinutes() };
		case 'interval':
		case 'cron': return spec;
		default: return { type: 'daily', time };
	}
}

type SvgPart =
	| readonly ['path', string]
	| readonly ['circle', number, number, number]
	| readonly ['line', number, number, number, number];

/** A line icon in the text colour, drawn from a few parts (Lucide's 24px grid unless told otherwise). */
function lineIcon(parts: readonly SvgPart[], size: number, strokeWidth: number, viewBox = '0 0 24 24'): SVGSVGElement {
	const doc = getActiveDocument();
	const ns = 'http://www.w3.org/2000/svg';
	const svg = doc.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', String(strokeWidth));
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-auto-cal-icon');
	for (const part of parts) {
		const element = doc.createElementNS(ns, part[0]);
		switch (part[0]) {
			case 'path':
				element.setAttribute('d', part[1]);
				break;
			case 'circle':
				element.setAttribute('cx', String(part[1]));
				element.setAttribute('cy', String(part[2]));
				element.setAttribute('r', String(part[3]));
				break;
			case 'line':
				element.setAttribute('x1', String(part[1]));
				element.setAttribute('y1', String(part[2]));
				element.setAttribute('x2', String(part[3]));
				element.setAttribute('y2', String(part[4]));
				break;
		}
		svg.appendChild(element);
	}
	return svg;
}

function moonIcon(): SVGSVGElement {
	return lineIcon([['path', 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z']], 14, 1.3, '0 0 16 16');
}

function sunIcon(): SVGSVGElement {
	return lineIcon([['path', 'M8 5.2a2.8 2.8 0 1 1 0 5.6a2.8 2.8 0 0 1 0-5.6zM8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1']], 14, 1.3, '0 0 16 16');
}

function zoomInIcon(): SVGSVGElement {
	return lineIcon([['circle', 11, 11, 8], ['line', 21, 21, 16.65, 16.65], ['line', 11, 8, 11, 14], ['line', 8, 11, 14, 11]], 18, 1);
}

function zoomOutIcon(): SVGSVGElement {
	return lineIcon([['circle', 11, 11, 8], ['line', 21, 21, 16.65, 16.65], ['line', 8, 11, 14, 11]], 18, 1);
}

function filterIcon(): SVGSVGElement {
	return lineIcon([['path', 'M2 5h20'], ['path', 'M6 12h12'], ['path', 'M9 19h6']], 15, 1.6);
}

function repeatIcon(): SVGSVGElement {
	return lineIcon([['path', 'm17 2 4 4-4 4'], ['path', 'M3 11v-1a4 4 0 0 1 4-4h14'], ['path', 'm7 22-4-4 4-4'], ['path', 'M21 13v1a4 4 0 0 1-4 4H3']], 12, 1.6);
}

/** The small mark at a week block's corner: how the run went. */
const STATE_GLYPHS: Readonly<Partial<Record<Tone, ThemeIcon>>> = {
	ok: Codicon.check,
	fail: Codicon.close,
	run: Codicon.circleFilled,
	stop: Codicon.debugStop,
};

function isWeekend(day: number): boolean {
	const weekday = new Date(day).getDay();
	return weekday === 0 || weekday === 6;
}

/** Triggers that fire more than a dozen times a day: hourly, every few minutes, busy crons. */
function frequentTriggers(automations: readonly IAutomation[]): ReadonlySet<string> {
	return new Set(automations.flatMap(automation => automation.triggers.filter(trigger => trigger.schedule && isFrequentSchedule(trigger.schedule)).map(trigger => trigger.id)));
}

/** A run of a repeating trigger: views count it with its trigger instead of drawing it alone. */
function isFolded(entry: ICalendarRun, frequent: ReadonlySet<string>): boolean {
	return !!entry.run.triggerId && frequent.has(entry.run.triggerId);
}

/**
 * Automations on a calendar: Day is a timeline (hours across, one lane per automation, trigger
 * diamonds, run bars coloured by outcome, queued time dashed, pull requests after the bar, a now
 * line), Week a 7-day hour grid, Month a 6-week grid. Clicking an empty time offers to schedule a
 * new automation there, or to add that time to the automation whose lane was clicked.
 *
 * Drawn as plain absolutely positioned elements in one pass per redraw; hover cards, clicks and
 * the time ghost are delegated from the root, so a month of an every-minute automation is a
 * handful of elements (repeating triggers are one band, not one block per slot).
 */
export class AutomationCalendarView extends Disposable {

	private view: CalendarView;
	private date: number;
	private readonly root: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly body: HTMLElement;
	private readonly tip: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly toolbarStore = this._register(new DisposableStore());
	private readonly filterMenu = this._register(new MutableDisposable<IVoltMenuHandle>());
	private readonly hues = new Map<string, string>();
	private filterButton: HTMLButtonElement | undefined;
	/** Where the day timeline was scrolled, kept across redraws (a run finishing must not throw the view back to now). */
	private dayScroll: { readonly day: number; readonly zoom: number; left: number } | undefined;
	/** The hour to keep under the pointer (or the middle) across a zoom. */
	private dayAnchor: { readonly hour: number; readonly offset: number } | undefined;
	private weekScroll: { readonly start: number; top: number } | undefined;
	private lastWheelZoom = 0;
	private readonly menu = this._register(new MutableDisposable<IVoltMenuHandle>());
	private items: ICalendarItem[] = [];
	private tick: (() => void) | undefined;

	constructor(
		parent: HTMLElement,
		private readonly options: IAutomationCalendarOptions,
		@IAutomationService private readonly automations: IAutomationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super();
		this.view = options.view;
		this.date = startOfDay(options.date);
		this.root = append(parent, $('.volt-auto-cal'));
		this.root.tabIndex = 0;
		this.root.setAttribute('role', 'region');
		this.toolbar = append(this.root, $('.volt-auto-cal-toolbar'));
		this.body = append(this.root, $('.volt-auto-cal-body'));
		this.tip = append(this.root, $('.volt-auto-cal-tip'));
		this.tip.setAttribute('aria-hidden', 'true');

		this._register(addDisposableListener(this.root, 'mouseover', e => this.onHover(e)));
		this._register(addDisposableListener(this.root, 'mouseleave', () => this.hideTip()));
		this._register(addDisposableListener(this.root, 'click', e => {
			const item = this.itemAt(e.target);
			if (item?.open) {
				e.stopPropagation();
				this.hideTip();
				item.open();
			}
		}));
		this._register(addDisposableListener(this.root, 'keydown', e => this.onKey(e)));
		// The now line moves on its own; a redraw follows only while something is running (its bar grows).
		this._register(disposableWindowInterval(getWindow(parent), () => this.tick?.(), 30_000));
		this.render();
	}

	get element(): HTMLElement {
		return this.root;
	}

	show(view: CalendarView, date?: number): void {
		this.view = view;
		if (date !== undefined) {
			this.date = startOfDay(date);
		}
		this.render();
	}

	/** Automations changed (or the search did): same view, new data. */
	refresh(): void {
		this.hues.clear();
		this.syncFilter();
		this.renderBody();
		this.renderStats();
	}

	focus(): void {
		this.root.focus();
	}

	private visible(): readonly IAutomation[] {
		return this.options.automations().filter(automation => (showInactive || automation.enabled) && !hiddenIds.has(automation.id));
	}

	private navigate(view: CalendarView, date: number): void {
		this.view = view;
		this.date = startOfDay(date);
		this.render();
		this.options.onDidNavigate(view, this.date);
	}

	private step(delta: number): void {
		const next = this.view === 'month' ? addMonths(startOfMonth(this.date), delta) : addDays(this.date, delta * (this.view === 'week' ? 7 : 1));
		this.navigate(this.view, next);
	}

	private render(): void {
		this.root.dataset.view = this.view;
		this.root.setAttribute('aria-label', localize('voltAutomations.cal.aria', "Automations calendar"));
		this.hues.clear();
		this.renderToolbar();
		this.renderBody();
		this.renderStats();
	}

	//#region Toolbar

	private rangeTitle(): string {
		switch (this.view) {
			case 'day':
				return dateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(this.date);
			case 'week': {
				const start = startOfWeek(this.date);
				const end = addDays(start, 6);
				const startDate = new Date(start);
				const endDate = new Date(end);
				if (startDate.getMonth() === endDate.getMonth()) {
					return `${dateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(start)} \u2013 ${endDate.getDate()}, ${endDate.getFullYear()}`;
				}
				return `${dateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(start)} \u2013 ${dateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(end)}`;
			}
			case 'month':
				return dateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(this.date);
		}
	}

	private range(): { readonly from: number; readonly to: number; readonly days: number[] } {
		const days: number[] = [];
		let from: number;
		let count: number;
		switch (this.view) {
			case 'day': from = this.date; count = 1; break;
			case 'week': from = startOfWeek(this.date); count = 7; break;
			case 'month': from = calendarWeeks(this.date, { now: Date.now(), weekStart: WEEK_START })[0][0].date; count = 42; break;
		}
		for (let index = 0; index < count; index++) {
			days.push(addDays(from, index));
		}
		return { from, to: addDays(from, count), days };
	}

	private renderToolbar(): void {
		this.toolbarStore.clear();
		clearNode(this.toolbar);
		const nav = append(this.toolbar, $('.nav'));
		const unit = this.view === 'day' ? localize('voltAutomations.cal.day', "day") : this.view === 'week' ? localize('voltAutomations.cal.week', "week") : localize('voltAutomations.cal.month', "month");
		iconButton(nav, Codicon.chevronLeft, localize('voltAutomations.cal.previous', "Previous {0} (←)", unit), this.toolbarStore, () => this.step(-1));
		iconButton(nav, Codicon.chevronRight, localize('voltAutomations.cal.next', "Next {0} (→)", unit), this.toolbarStore, () => this.step(1));
		const today = button(nav, 'volt-auto-outline-button.small.today', localize('voltAutomations.cal.today', "Today"), this.toolbarStore, () => this.navigate(this.view, Date.now()));
		today.title = localize('voltAutomations.cal.todayKey', "Today (T)");
		const heading = append(this.toolbar, $('h2.title'));
		heading.textContent = this.rangeTitle();
		heading.setAttribute('aria-live', 'polite');
		append(this.toolbar, $('span.tz')).textContent = gmtOffsetLabel(this.date + 12 * HOUR);
		append(this.toolbar, $('span.volt-auto-spacer'));
		append(this.toolbar, $('.stats'));
		this.filterButton = append(this.toolbar, $('button.volt-auto-cal-filter')) as HTMLButtonElement;
		this.filterButton.type = 'button';
		this.filterButton.setAttribute('aria-haspopup', 'menu');
		this.toolbarStore.add(addDisposableListener(this.filterButton, 'click', () => this.showFilter()));
		this.syncFilter();
		if (this.view === 'day') {
			const zoom = append(this.toolbar, $('.zoom'));
			const zoomOut = iconButton(zoom, zoomOutIcon, localize('voltAutomations.cal.zoomOut', "Zoom out (-)"), this.toolbarStore, () => this.zoom(-1));
			const zoomIn = iconButton(zoom, zoomInIcon, localize('voltAutomations.cal.zoomIn', "Zoom in (+)"), this.toolbarStore, () => this.zoom(1));
			zoomOut.disabled = dayZoom === 0;
			zoomIn.disabled = dayZoom === DAY_ZOOMS.length - 1;
		}
	}

	private zoom(delta: number, anchor?: { readonly hour: number; readonly offset: number }): void {
		const next = Math.max(0, Math.min(DAY_ZOOMS.length - 1, dayZoom + delta));
		if (next !== dayZoom) {
			dayZoom = next;
			this.dayAnchor = anchor ?? this.dayCentre();
			this.render();
		}
	}

	/** The hour at the middle of the day timeline as it is scrolled now. */
	private dayCentre(): { readonly hour: number; readonly offset: number } | undefined {
		const canvas = this.body.querySelector<HTMLElement>('.volt-auto-cal-day');
		const viewport = canvas?.parentElement;
		const hourWidth = canvas ? parseFloat(canvas.style.getPropertyValue('--volt-auto-cal-hour')) : NaN;
		if (!canvas || !viewport || !hourWidth) {
			return undefined;
		}
		const offset = viewport.clientWidth / 2;
		return { hour: (viewport.scrollLeft + offset - DAY_PAD) / hourWidth, offset };
	}

	/** The toolbar's legend doubles as the range's numbers: upcoming slots and runs by outcome. */
	private renderStats(): void {
		const stats = this.toolbar.querySelector<HTMLElement>('.stats');
		if (!stats) {
			return;
		}
		clearNode(stats);
		const now = Date.now();
		const { from, to, days } = this.range();
		const automations = this.visible();
		let upcoming = 0;
		for (const day of days) {
			if (addDays(day, 1) <= now) {
				continue;
			}
			const { slots, repeats } = daySlots(automations, day, now);
			upcoming += slots.length + repeats.reduce((sum, repeat) => sum + repeat.count, 0);
		}
		const runs = runsBetween(automations, from, to, now);
		const count = (tone: Tone) => runs.filter(entry => toneOf(entry.run) === tone).length;
		const legend: [Tone, number, string][] = [
			['plan', upcoming, localize('voltAutomations.cal.upcoming', "upcoming")],
			['ok', count('ok'), localize('voltAutomations.cal.succeededShort', "succeeded")],
			['fail', count('fail'), localize('voltAutomations.cal.failedShort', "failed")],
			['run', count('run'), localize('voltAutomations.cal.runningShort', "running")],
		];
		for (const [tone, value, label] of legend) {
			if (!value && tone !== 'plan') {
				continue;
			}
			const entry = append(stats, $(`span.stat.${tone}`));
			append(entry, $('span.mark'));
			append(entry, $('span.value')).textContent = String(value);
			append(entry, $('span.label')).textContent = label;
		}
	}

	//#endregion

	//#region Items, hover, keys

	private item(element: HTMLElement, item: ICalendarItem): HTMLElement {
		element.dataset.i = String(this.items.length);
		this.items.push(item);
		if (item.open) {
			element.classList.add('clickable');
		}
		return element;
	}

	private itemAt(target: EventTarget | null): ICalendarItem | undefined {
		const element = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-i]');
		return element && this.root.contains(element) ? this.items[Number(element.dataset.i)] : undefined;
	}

	private onHover(e: MouseEvent): void {
		const element = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-i]');
		const item = element ? this.items[Number(element.dataset.i)] : undefined;
		if (!element || !item) {
			this.hideTip();
			return;
		}
		clearNode(this.tip);
		this.tip.className = `volt-auto-cal-tip visible ${item.tone}`;
		const head = append(this.tip, $('.head'));
		append(head, $('span.mark'));
		append(head, $('span.name')).textContent = item.title;
		for (const line of item.lines) {
			if (line) {
				append(this.tip, $('.line')).textContent = line;
			}
		}
		if (item.open) {
			append(this.tip, $('.hint')).textContent = localize('voltAutomations.cal.clickToOpen', "Click to open");
		}
		const box = element.getBoundingClientRect();
		const host = this.root.getBoundingClientRect();
		const width = this.tip.offsetWidth;
		const height = this.tip.offsetHeight;
		let left = box.left - host.left + box.width / 2 - width / 2;
		left = Math.max(8, Math.min(host.width - width - 8, left));
		let top = box.top - host.top - height - 8;
		if (top < 4) {
			top = box.bottom - host.top + 8;
		}
		this.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}

	private hideTip(): void {
		this.tip.classList.remove('visible');
	}

	private onKey(e: KeyboardEvent): void {
		const target = e.target as HTMLElement;
		if (e.metaKey || e.ctrlKey || e.altKey || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
			return;
		}
		const run = (action: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			action();
		};
		switch (e.key) {
			case 'ArrowLeft': return run(() => this.step(-1));
			case 'ArrowRight': return run(() => this.step(1));
			case 't': case 'T': return run(() => this.navigate(this.view, Date.now()));
			case 'd': case 'D': return run(() => this.navigate('day', this.date));
			case 'w': case 'W': return run(() => this.navigate('week', this.date));
			case 'm': case 'M': return run(() => this.navigate('month', this.date));
			case '+': case '=': return this.view === 'day' ? run(() => this.zoom(1)) : undefined;
			case '-': return this.view === 'day' ? run(() => this.zoom(-1)) : undefined;
		}
	}

	private runItem(automation: IAutomation, entry: ICalendarRun): ICalendarItem {
		const { run } = entry;
		const duration = isActiveRun(run) || run.finishedAt ? formatDuration(Math.max(0, entry.endedAt - entry.startedAt)) : '';
		const when = `${dateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(run.at)} · ${clock(entry.startedAt)}${run.finishedAt ? `\u2013${clock(run.finishedAt)}` : ''}`;
		const pr = runPullRequest(run);
		return {
			title: automation.name,
			tone: toneOf(run),
			lines: [
				[statusLabel(run), duration].filter(Boolean).join(' · '),
				when,
				run.label,
				entry.startedAt - entry.at > 60_000 ? localize('voltAutomations.cal.waited', "Queued {0}", formatDuration(entry.startedAt - entry.at)) : '',
				run.error ?? run.note ?? '',
				pr ? localize('voltAutomations.cal.openedPr', "Opened PR {0}", pr.label) : '',
				...(run.repository ? [run.repository] : []),
			],
			open: () => run.threadId
				? void this.commands.executeCommand(OPEN_AGENT_COMMAND_ID, run.threadId)
				: this.options.host.navigate({ page: 'detail', id: automation.id, tab: 'runs' }),
		};
	}

	private slotItem(automation: IAutomation, slot: ICalendarSlot): ICalendarItem {
		const trigger = automation.triggers.find(entry => entry.id === slot.triggerId);
		return {
			title: automation.name,
			tone: 'plan',
			lines: [
				`${localize('voltAutomations.cal.scheduled', "Scheduled")} · ${dateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(slot.at)} ${clock(slot.at)}`,
				trigger ? describeTrigger(trigger) : '',
				automation.enabled ? '' : localize('voltAutomations.cal.inactiveNote', "Inactive: switch it on to run"),
			],
			open: () => this.options.host.navigate({ page: 'detail', id: automation.id, tab: 'settings' }),
		};
	}

	private repeatItem(automation: IAutomation, repeat: ICalendarRepeat): ICalendarItem {
		const trigger = automation.triggers.find(entry => entry.id === repeat.triggerId);
		return {
			title: automation.name,
			tone: 'plan',
			lines: [
				trigger ? describeTrigger(trigger) : '',
				localize('voltAutomations.cal.repeatCount', "{0} more runs on this day, from {1}", repeat.count, clock(repeat.first)),
				automation.enabled ? '' : localize('voltAutomations.cal.inactiveNote', "Inactive: switch it on to run"),
			],
			open: () => this.options.host.navigate({ page: 'detail', id: automation.id, tab: 'settings' }),
		};
	}

	//#endregion

	//#region Body

	private renderBody(): void {
		this.renderStore.clear();
		this.menu.clear();
		this.hideTip();
		this.items = [];
		this.tick = undefined;
		clearNode(this.body);
		switch (this.view) {
			case 'day': this.renderDay(); break;
			case 'week': this.renderWeek(); break;
			case 'month': this.renderMonth(); break;
		}
		this.options.host.relayout();
	}

	/** Redraws when the clock passes midnight or a run is going; otherwise only moves the now marks. */
	private keepTime(move: (now: number) => void): void {
		const today = startOfDay(Date.now());
		this.tick = () => {
			const now = Date.now();
			if (startOfDay(now) !== today || this.visible().some(automation => automation.runs.some(isActiveRun))) {
				this.refresh();
			} else {
				move(now);
			}
		};
	}

	private hasContent(automation: IAutomation, runs: readonly ICalendarRun[], slots: ICalendarDaySlots): boolean {
		return runs.some(entry => entry.automationId === automation.id)
			|| slots.slots.some(slot => slot.automationId === automation.id)
			|| slots.repeats.some(repeat => repeat.automationId === automation.id);
	}

	//#region Colours and legend

	/** Each automation's colour, given in the order they were made, so a colour stays with its automation. */
	private hue(id: string): string {
		if (!this.hues.size) {
			const workbench = this.root.closest('.monaco-workbench');
			const palette = workbench?.classList.contains('vs') || workbench?.classList.contains('hc-light') ? HUES_LIGHT : HUES;
			const all = [...this.automations.list()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
			all.forEach((automation, index) => this.hues.set(automation.id, palette[index % palette.length]));
		}
		return this.hues.get(id) ?? HUES[0];
	}

	private paint<T extends HTMLElement>(element: T, automationId: string): T {
		element.style.setProperty('--volt-auto-cal-hue', this.hue(automationId));
		return element;
	}

	private filterable(): IAutomation[] {
		return this.options.automations()
			.filter(automation => showInactive || automation.enabled)
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	/** The toolbar's Filter: how many automations are shown, with the colours of the first few. */
	private syncFilter(): void {
		const button = this.filterButton;
		if (!button) {
			return;
		}
		const all = this.filterable();
		const shown = all.filter(automation => !hiddenIds.has(automation.id));
		button.replaceChildren();
		button.appendChild(filterIcon());
		const dots = append(button, $('span.dots'));
		for (const automation of shown.slice(0, 4)) {
			this.paint(append(dots, $('span.dot')), automation.id);
		}
		append(button, $('span.label')).textContent = shown.length === all.length
			? localize('voltAutomations.cal.filterAll', "All automations")
			: localize('voltAutomations.cal.filterSome', "{0} of {1}", shown.length, all.length);
		button.appendChild(renderIcon(Codicon.chevronDown));
		button.classList.toggle('filtered', shown.length !== all.length || !showInactive);
		button.setAttribute('aria-label', localize('voltAutomations.cal.filterAria', "Filter automations: {0} of {1} shown", shown.length, all.length));
	}

	/** Which automations the calendar shows: a check per automation in its colour, Only to show one, and inactive ones in or out. */
	private showFilter(): void {
		const button = this.filterButton;
		if (!button) {
			return;
		}
		type FilterPick = { readonly kind: 'all' | 'inactive' } | { readonly kind: 'one' | 'only'; readonly id: string };
		const changed = () => {
			this.syncFilter();
			this.renderBody();
			this.renderStats();
			handle.refresh();
		};
		const handle: IVoltMenuHandle = showVoltMenu<FilterPick>(this.contextView, {
			anchor: button,
			align: 'right',
			gap: 6,
			width: 300,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.cal.filter', "Filter automations"),
			...(this.filterable().length > 8 ? { search: { placeholder: localize('voltAutomations.cal.searchAutomations', "Search automations") } } : {}),
			sections: () => {
				const all = this.filterable();
				return [
					{
						id: 'show',
						items: [
							{ id: 'all', label: localize('voltAutomations.cal.showAll', "Show all"), icon: Codicon.eye, keepOpen: true, disabled: !all.some(automation => hiddenIds.has(automation.id)), data: { kind: 'all' as const } },
							{ id: 'inactive', label: localize('voltAutomations.cal.includeInactive', "Include inactive automations"), checked: showInactive, keepOpen: true, data: { kind: 'inactive' as const } },
						],
					},
					{
						id: 'automations',
						title: localize('voltAutomations.cal.automations', "Automations"),
						emptyMessage: localize('voltAutomations.cal.noAutomations', "No automations"),
						items: all.map((automation): IVoltMenuItem<FilterPick> => ({
							id: automation.id,
							label: automation.name,
							...(automation.enabled ? {} : { description: localize('voltAutomations.inactive', "Inactive") }),
							icon: () => {
								const dot = $('span.volt-auto-cal-menu-dot');
								dot.style.backgroundColor = this.hue(automation.id);
								dot.classList.toggle('off', hiddenIds.has(automation.id));
								return dot;
							},
							checked: !hiddenIds.has(automation.id),
							keepOpen: true,
							action: { icon: Codicon.target, tooltip: localize('voltAutomations.cal.only', "Show only {0}", automation.name), data: { kind: 'only', id: automation.id }, keepOpen: true },
							data: { kind: 'one', id: automation.id },
						})),
					},
				];
			},
			onPick: item => {
				const pick = item.data;
				switch (pick.kind) {
					case 'all':
						hiddenIds.clear();
						break;
					case 'inactive':
						showInactive = !showInactive;
						break;
					case 'one':
						if (hiddenIds.has(pick.id)) {
							hiddenIds.delete(pick.id);
						} else {
							hiddenIds.add(pick.id);
						}
						break;
					case 'only':
						hiddenIds.clear();
						for (const automation of this.options.automations()) {
							if (automation.id !== pick.id) {
								hiddenIds.add(automation.id);
							}
						}
						break;
				}
				changed();
			},
			onHide: () => button.classList.remove('open'),
		});
		button.classList.add('open');
		this.filterMenu.value = handle;
	}

	//#endregion

	//#region Day

	private renderDay(): void {
		const day = this.date;
		const next = addDays(day, 1);
		const now = Date.now();
		const isToday = startOfDay(now) === day;
		// Zoomed out, the whole day fits the width; each step in gives an hour more room.
		const viewport = Math.max(480, this.body.clientWidth || 1100);
		const fit = Math.max(30, Math.floor((viewport - DAY_PAD * 2) / 24));
		const hourWidth = dayZoom === 0 ? fit : Math.max(fit + 8, DAY_ZOOMS[dayZoom]);
		const anchor = this.dayAnchor;
		this.dayAnchor = undefined;
		const kept = this.dayScroll?.day === day && this.dayScroll.zoom === dayZoom ? this.dayScroll.left : undefined;
		const automations = this.visible();
		const slots = daySlots(automations, day, now);
		const runs = runsBetween(automations, day, next, now);
		const frequent = frequentTriggers(automations);
		const x = (at: number) => DAY_PAD + Math.max(0, Math.min(24, (at - day) / HOUR)) * hourWidth;
		const width = DAY_PAD * 2 + 24 * hourWidth;

		// The scrollable is the viewport; the canvas inside it is the whole day wide.
		const viewportElement = $('.volt-auto-cal-day-viewport');
		const canvas = append(viewportElement, $('.volt-auto-cal-day'));
		canvas.style.width = `${width}px`;
		canvas.style.setProperty('--volt-auto-cal-hour', `${hourWidth}px`);
		canvas.style.setProperty('--volt-auto-cal-pad', `${DAY_PAD}px`);
		const scroll = this.renderStore.add(new DomScrollableElement(viewportElement, {
			className: 'volt-auto-cal-hscroll',
			horizontal: hourWidth > fit ? ScrollbarVisibility.Visible : ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Hidden,
			horizontalScrollbarSize: 10,
			useShadows: false,
			handleMouseWheel: true,
			alwaysConsumeMouseWheel: false,
		}));
		this.body.appendChild(scroll.getDomNode());
		canvas.classList.toggle('scrolls', hourWidth > fit);
		this.renderStore.add(scroll.onScroll(() => this.dayScroll = { day, zoom: dayZoom, left: scroll.getScrollPosition().scrollLeft }));

		const past = isToday ? append(canvas, $('.past')) : undefined;
		const axis = append(canvas, $('.axis'));
		const every = hourWidth >= 42 ? 1 : hourWidth >= 26 ? 2 : 3;
		const hours: { readonly element: HTMLElement; readonly left: number }[] = [];
		for (let hour = 0; hour <= 24; hour += every) {
			const label = append(axis, $('span.hour'));
			const left = DAY_PAD + hour * hourWidth;
			label.textContent = `${pad(hour % 24)}:00`;
			label.style.left = `${left}px`;
			label.classList.toggle('first', hour === 0);
			label.classList.toggle('last', hour === 24);
			hours.push({ element: label, left });
		}

		const lanes = append(canvas, $('.lanes'));
		const firstAt = (automation: IAutomation) => Math.min(
			...runs.filter(entry => entry.automationId === automation.id).map(entry => entry.at),
			...slots.slots.filter(slot => slot.automationId === automation.id).map(slot => slot.at),
			...slots.repeats.filter(repeat => repeat.automationId === automation.id).map(repeat => repeat.first),
		);
		const shown = automations.filter(automation => this.hasContent(automation, runs, slots))
			.map(automation => ({ automation, first: firstAt(automation) }))
			.sort((a, b) => a.first - b.first || a.automation.name.localeCompare(b.automation.name));

		for (const { automation } of shown) {
			const own = runs.filter(entry => entry.automationId === automation.id);
			const repeats = slots.repeats.filter(repeat => repeat.automationId === automation.id);
			const dense = repeats.length > 0 || own.some(entry => isFolded(entry, frequent));
			const lane = this.paint(append(lanes, $('.lane')), automation.id);
			lane.dataset.id = automation.id;
			lane.classList.toggle('inactive', !automation.enabled);
			lane.classList.toggle('dense', dense);
			const head = append(lane, $('.lane-name'));
			append(head, $('span.dot'));
			append(head, $('span.name')).textContent = automation.name;
			const schedule = automation.triggers.map(describeTrigger);
			append(head, $('span.sum')).textContent = !automation.enabled
				? localize('voltAutomations.cal.paused', "Inactive")
				: schedule.length > 1 ? `${schedule[0]} +${schedule.length - 1}` : schedule[0] ?? '';
			if (dense) {
				// A repeating automation reads as a tally: what ran, what failed, what is still to come.
				const folded = own.filter(entry => isFolded(entry, frequent));
				const ok = folded.filter(entry => toneOf(entry.run) === 'ok').length;
				const failed = folded.filter(entry => toneOf(entry.run) === 'fail').length;
				const ahead = repeats.reduce((sum, repeat) => sum + repeat.count, 0);
				const parts: [string, string][] = [];
				if (ok) {
					parts.push(['', localize('voltAutomations.cal.nRan', "{0} ran", ok)]);
				}
				if (failed) {
					parts.push(['fail', localize('voltAutomations.cal.nFailed', "{0} failed", failed)]);
				}
				if (ahead) {
					parts.push(['', isToday ? localize('voltAutomations.cal.nLeft', "{0} to go", ahead) : localize('voltAutomations.cal.nPlanned', "{0} planned", ahead)]);
				}
				const tally = append(head, $('span.tally'));
				parts.forEach(([tone, text], index) => {
					if (index) {
						append(tally, $('span.sep')).textContent = '·';
					}
					const part = append(tally, $(tone ? `span.${tone}` : 'span'));
					part.textContent = text;
				});
			}
			this.drawLane(lane, automation, own, slots, x, hourWidth, day, now, frequent);
		}

		const add = append(lanes, $('.lane.add'));
		const hint = append(add, $('.lane-name'));
		hint.appendChild(renderIcon(Codicon.add));
		append(hint, $('span.sum')).textContent = shown.length
			? localize('voltAutomations.cal.addHint', "Click any time to schedule an automation")
			: localize('voltAutomations.cal.emptyDay', "Nothing scheduled this day. Click any time to schedule an automation");

		const ghost = append(canvas, $('.ghost'));
		const ghostLabel = append(ghost, $('span.badge'));
		let ghostAt: number | undefined;
		const timeAt = (clientX: number) => {
			const left = canvas.getBoundingClientRect().left;
			const minutes = Math.round(((clientX - left - DAY_PAD) / hourWidth) * 60 / SNAP_DAY) * SNAP_DAY;
			return Math.max(0, Math.min(24 * 60 - SNAP_DAY, minutes));
		};
		this.renderStore.add(addDisposableListener(lanes, 'mousemove', e => {
			if (this.root.classList.contains('picking')) {
				return;
			}
			const onItem = !!(e.target as HTMLElement).closest('[data-i]');
			ghost.classList.toggle('visible', !onItem);
			if (onItem) {
				return;
			}
			const minutes = timeAt(e.clientX);
			ghostAt = combineDayAndTime(day, minutes);
			ghost.style.transform = `translateX(${DAY_PAD + minutes / 60 * hourWidth}px)`;
			ghostLabel.textContent = `+ ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
		}));
		this.renderStore.add(addDisposableListener(lanes, 'mouseleave', () => {
			if (!this.root.classList.contains('picking')) {
				ghost.classList.remove('visible');
			}
		}));
		// Moving through the day: drag the timeline, scroll over the hours (or with Shift), Ctrl/Cmd+scroll to zoom where the pointer is.
		let drag: { readonly x: number; readonly left: number; moved: boolean } | undefined;
		let dragged = false;
		const window = getWindow(canvas);
		this.renderStore.add(addDisposableListener(canvas, 'mousedown', e => {
			if (e.button === 0 && hourWidth > fit && !(e.target as HTMLElement).closest('[data-i]')) {
				drag = { x: e.clientX, left: scroll.getScrollPosition().scrollLeft, moved: false };
			}
		}));
		this.renderStore.add(addDisposableListener(window, 'mousemove', e => {
			if (!drag) {
				return;
			}
			const dx = e.clientX - drag.x;
			if (!drag.moved && Math.abs(dx) < 4) {
				return;
			}
			drag.moved = true;
			canvas.classList.add('panning');
			ghost.classList.remove('visible');
			scroll.setScrollPosition({ scrollLeft: drag.left - dx });
		}));
		this.renderStore.add(addDisposableListener(window, 'mouseup', () => {
			if (drag?.moved) {
				// The click that ends a drag is not a click on the timeline.
				dragged = true;
				window.setTimeout(() => dragged = false);
			}
			drag = undefined;
			canvas.classList.remove('panning');
		}));
		this.renderStore.add(addDisposableListener(axis, 'wheel', e => {
			if (hourWidth > fit && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				scroll.setScrollPosition({ scrollLeft: scroll.getScrollPosition().scrollLeft + e.deltaY });
			}
		}, { passive: false }));
		this.renderStore.add(addDisposableListener(canvas, 'wheel', e => {
			if (!e.ctrlKey && !e.metaKey) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const at = Date.now();
			if (Math.abs(e.deltaY) < 2 || at - this.lastWheelZoom < 140) {
				return;
			}
			this.lastWheelZoom = at;
			const offset = e.clientX - scroll.getDomNode().getBoundingClientRect().left;
			this.zoom(e.deltaY < 0 ? 1 : -1, { hour: (scroll.getScrollPosition().scrollLeft + offset - DAY_PAD) / hourWidth, offset });
		}, { passive: false }));

		this.renderStore.add(addDisposableListener(lanes, 'click', e => {
			if (dragged || (e.target as HTMLElement).closest('[data-i]')) {
				return;
			}
			const at = ghostAt ?? combineDayAndTime(day, timeAt(e.clientX));
			const lane = (e.target as HTMLElement).closest<HTMLElement>('.lane');
			this.showCreateMenu(e, at, lane?.dataset.id, () => ghost.classList.remove('visible'));
		}));

		if (isToday) {
			const line = append(canvas, $('.now'));
			const badge = append(line, $('span.badge'));
			const move = (at: number) => {
				const left = x(at);
				line.style.transform = `translateX(${left}px)`;
				if (past) {
					past.style.width = `${left}px`;
				}
				// The clock covers the hour labels beside it; hide those instead of overlapping them.
				for (const hour of hours) {
					hour.element.classList.toggle('covered', Math.abs(hour.left - left) < 46);
				}
				const time = $('span');
				time.textContent = clock(at);
				const hour = new Date(at).getHours();
				badge.replaceChildren(hour < 6 || hour >= 19 ? moonIcon() : sunIcon(), time);
			};
			move(now);
			this.keepTime(move);
		} else {
			this.keepTime(() => { });
		}

		scroll.scanDomNode();
		if (hourWidth > fit) {
			// Where to open: the hour under the pointer across a zoom, where it was before a redraw, else now a third of the way
			// across on today, and another day at its first item (or 08:00).
			const viewportWidth = scroll.getDomNode().clientWidth || viewport;
			const left = anchor ? DAY_PAD + anchor.hour * hourWidth - anchor.offset
				: kept !== undefined ? kept
					: isToday ? x(now) - viewportWidth * 0.38
						: x(shown.length ? Math.min(...shown.map(entry => entry.first)) : combineDayAndTime(day, 8 * 60)) - 80;
			scroll.setScrollPosition({ scrollLeft: Math.max(0, left) });
		}
		this.dayScroll = { day, zoom: dayZoom, left: scroll.getScrollPosition().scrollLeft };
		getWindow(this.root).requestAnimationFrame(() => scroll.scanDomNode());
	}

	/**
	 * One automation's lane, on one line through its middle. A repeating trigger is a row of dots:
	 * filled in the outcome's colour for what ran, small rings in the automation's colour for what
	 * is ahead. Other runs are a diamond where they were triggered, the queued time dashed, a
	 * rounded bar in the outcome's colour (or one diamond when too short for a bar) and the pull
	 * request after it; planned ones are rings with the usual run length dashed behind them.
	 */
	private drawLane(lane: HTMLElement, automation: IAutomation, runs: readonly ICalendarRun[], slots: ICalendarDaySlots, x: (at: number) => number, hourWidth: number, day: number, now: number, frequent: ReadonlySet<string>): void {
		const track = append(lane, $('.track'));
		const under = append(lane, $('.under'));
		let underEnd = -Infinity;
		const underLabel = (left: number, text: string, className = '') => {
			if (!text || left < underEnd + 12) {
				return;
			}
			const label = append(under, $(`span${className}`));
			label.textContent = text;
			label.style.left = `${left}px`;
			underEnd = left + Math.min(240, text.length * 6.3);
		};

		for (const repeat of slots.repeats.filter(entry => entry.automationId === automation.id)) {
			const item = this.repeatItem(automation, repeat);
			if (repeat.every / HOUR * hourWidth >= 7) {
				for (const at of triggerSlotsOnDay(automation, repeat.triggerId, day, now)) {
					this.item(append(track, $('.pip.plan')), item).style.left = `${x(at)}px`;
				}
			} else {
				const line = this.item(append(track, $('.pipline')), item);
				line.style.left = `${x(repeat.first)}px`;
				line.style.width = `${Math.max(4, x(addDays(day, 1)) - x(repeat.first))}px`;
			}
		}

		const expected = expectedDuration(automation) / HOUR * hourWidth;
		for (const slot of slots.slots.filter(entry => entry.automationId === automation.id)) {
			const left = x(slot.at);
			if (expected >= 10) {
				const ghost = append(track, $('.bar.expected'));
				ghost.style.left = `${left}px`;
				ghost.style.width = `${expected}px`;
			}
			this.item(append(track, $('.dia.plan')), this.slotItem(automation, slot)).style.left = `${left}px`;
		}

		let chipEnd = -Infinity;
		// Where the next run of the lane starts: a pull request chip must end before it.
		const starts = runs.map(entry => x(entry.at));
		for (const [index, entry] of runs.entries()) {
			const item = this.runItem(automation, entry);
			const tone = toneOf(entry.run);
			const start = x(entry.at);
			if (isFolded(entry, frequent)) {
				this.item(append(track, $(`.pip.${tone}`)), item).style.left = `${start}px`;
				continue;
			}
			if (entry.run.status === 'skipped') {
				this.item(append(track, $('.dia.skip')), item).style.left = `${start}px`;
				continue;
			}
			const began = x(entry.startedAt);
			const end = Math.max(began, x(entry.endedAt));
			if (end - start < 12) {
				this.item(append(track, $(`.dia.status.${tone}`)), item).style.left = `${start}px`;
			} else {
				if (began - start >= 6) {
					const queued = append(track, $('.queue'));
					queued.style.left = `${start}px`;
					queued.style.width = `${began - start}px`;
					if (began - start >= 52) {
						underLabel(start + 8, localize('voltAutomations.cal.queuedCaps', "QUEUED"), '.caps');
					}
				}
				const bar = this.item(append(track, $(`.bar.${tone}`)), item);
				bar.style.left = `${began}px`;
				bar.style.width = `${Math.max(6, end - began)}px`;
				this.item(append(track, $('.dia.trigger')), item).style.left = `${start}px`;
			}
			const pr = runPullRequest(entry.run);
			const chipLeft = Math.max(end, start + 6) + 8;
			const room = (starts.slice(index + 1).find(next => next > start) ?? Infinity) - 8 - chipLeft;
			// "PR #135" where it fits, "#135" where it is tight, and in the label row where there is no room at all.
			const chipText = pr ? [`PR ${pr.label}`, pr.label].find(text => 18 + text.length * 7.2 <= room) : undefined;
			if (pr && chipText && chipLeft > chipEnd + 6) {
				const chip = append(track, $('span.pr'));
				chip.textContent = chipText;
				chip.style.left = `${chipLeft}px`;
				chipEnd = chipLeft + 18 + chipText.length * 7.2;
				this.item(chip, {
					title: automation.name,
					tone: 'ok',
					lines: [localize('voltAutomations.cal.prTip', "Pull request {0}", pr.label), pr.url ?? ''],
					...(pr.url ? { open: () => void this.opener.open(URI.parse(pr.url!)) } : {}),
				});
			}
			// "Pull request opened · #128 Login loops": the lane already names the trigger, so keep the subject;
			// a pull request with no room for its chip leads the label instead.
			const subject = entry.run.provider === 'manual'
				? localize('voltAutomations.cal.manual', "Run now")
				: entry.run.provider !== 'schedule' ? entry.run.label.split(' \u00b7 ').slice(1).join(' \u00b7 ') || entry.run.label : '';
			underLabel(start, [pr && !chipText ? `PR ${pr.label}` : '', subject].filter(Boolean).join(' \u00b7 '));
		}
	}

	//#endregion

	//#region Week

	private renderWeek(): void {
		const start = startOfWeek(this.date);
		const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
		const now = Date.now();
		const today = startOfDay(now);
		const automations = this.visible();
		const byId = new Map(automations.map(automation => [automation.id, automation]));
		const runs = runsBetween(automations, start, addDays(start, 7), now);
		const perDay = days.map(day => daySlots(automations, day, now));
		const frequent = frequentTriggers(automations);
		const dayLabel = dateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

		const grid = append(this.body, $('.volt-auto-cal-week'));
		const head = append(grid, $('.wk-head'));
		append(head, $('.gutter')).textContent = gmtOffsetLabel(start + 12 * HOUR);
		const weekday = dateTimeFormat(undefined, { weekday: 'short' });
		days.forEach(day => {
			const cell = append(head, $('button.wk-day')) as HTMLButtonElement;
			cell.type = 'button';
			cell.classList.toggle('today', day === today);
			cell.classList.toggle('past', day < today);
			cell.classList.toggle('weekend', isWeekend(day));
			append(cell, $('span.dow')).textContent = weekday.format(day);
			append(cell, $('span.num')).textContent = String(new Date(day).getDate());
			cell.title = localize('voltAutomations.cal.openDay', "Open {0}", dayLabel.format(day));
			this.renderStore.add(addDisposableListener(cell, 'click', () => this.navigate('day', day)));
		});

		// A repeating automation (hourly, every few minutes) is one bar across the days it runs, like an all-day event;
		// each day of it answers on hover, and a day with failures carries a red count.
		const rows = automations
			.filter(automation => automation.triggers.some(trigger => frequent.has(trigger.id)))
			.map(automation => ({
				automation,
				trigger: automation.triggers.find(trigger => frequent.has(trigger.id))!,
				days: days.map((day, index) => {
					const repeat = perDay[index].repeats.find(entry => entry.automationId === automation.id);
					let ok = 0;
					let fail = 0;
					for (const entry of runs) {
						if (entry.automationId === automation.id && entry.at >= day && entry.at < addDays(day, 1) && isFolded(entry, frequent)) {
							const tone = toneOf(entry.run);
							ok += tone === 'ok' ? 1 : 0;
							fail += tone === 'fail' ? 1 : 0;
						}
					}
					return { repeat, ok, fail };
				}),
			}))
			.filter(row => row.days.some(entry => entry.repeat || entry.ok || entry.fail));
		if (rows.length) {
			const band = append(grid, $('.wk-spans'));
			const label = append(band, $('.gutter'));
			label.appendChild(repeatIcon());
			setAgentTooltip(label, localize('voltAutomations.cal.repeatsHelp', "Automations that run every hour or every few minutes"));
			const area = append(band, $('.area'));
			for (const row of rows) {
				const active = row.days.map((entry, index) => entry.repeat || entry.ok || entry.fail ? index : -1).filter(index => index >= 0);
				const first = active[0];
				const last = active[active.length - 1];
				const span = last - first + 1;
				const line = append(area, $('.span-row'));
				const pill = this.paint(append(line, $('.span')), row.automation.id);
				pill.classList.toggle('inactive', !row.automation.enabled);
				pill.style.left = `calc(${first / 7 * 100}% + 3px)`;
				pill.style.width = `calc(${span / 7 * 100}% - 6px)`;
				for (let index = first; index <= last; index++) {
					const entry = row.days[index];
					const done = entry.ok + entry.fail;
					const segment = this.item(append(pill, $('.seg')), {
						title: `${row.automation.name} · ${dayLabel.format(days[index])}`,
						tone: entry.fail ? 'fail' : entry.repeat ? 'plan' : 'ok',
						lines: [
							describeTrigger(row.trigger),
							done ? localize('voltAutomations.cal.ranCount', "Ran {0} times: {1} succeeded, {2} failed", done, entry.ok, entry.fail) : '',
							entry.repeat ? localize('voltAutomations.cal.plannedCount', "{0} planned", entry.repeat.count) : '',
						],
						open: () => this.navigate('day', days[index]),
					});
					segment.style.left = `${(index - first) / span * 100}%`;
					segment.style.width = `${100 / span}%`;
					segment.classList.toggle('done', days[index] < today);
					// A day with failures is tinted red and underlined; its count is in the hover card, clear of the label.
					segment.classList.toggle('fail', entry.fail > 0);
				}
				const name = append(pill, $('.label'));
				append(name, $('span.dot'));
				append(name, $('span.name')).textContent = row.automation.name;
				append(name, $('span.sum')).textContent = describeTrigger(row.trigger);
			}
		}

		// The scrollable is the viewport (a fixed height); the grid inside it is the whole day tall.
		const scrollBody = $('.wk-body');
		scrollBody.style.height = `${WEEK_VIEWPORT}px`;
		const scroll = this.renderStore.add(new DomScrollableElement(scrollBody, {
			className: 'volt-auto-cal-vscroll',
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			verticalScrollbarSize: 8,
			useShadows: false,
			handleMouseWheel: true,
			alwaysConsumeMouseWheel: false,
		}));
		grid.appendChild(scroll.getDomNode());
		const inner = append(scrollBody, $('.wk-grid'));
		inner.style.height = `${24 * WEEK_HOUR_HEIGHT}px`;
		inner.style.setProperty('--volt-auto-cal-hour', `${WEEK_HOUR_HEIGHT}px`);
		const gutter = append(inner, $('.gutter'));
		for (let hour = 1; hour < 24; hour++) {
			const label = append(gutter, $('span'));
			label.textContent = `${pad(hour)}:00`;
			label.style.top = `${hour * WEEK_HOUR_HEIGHT}px`;
		}
		const ghost = append(inner, $('.wk-ghost'));
		const minuteHeight = WEEK_HOUR_HEIGHT / 60;
		const minHeight = 22;
		days.forEach((day, index) => {
			const column = append(inner, $('.wk-col'));
			column.dataset.day = String(day);
			column.classList.toggle('today', day === today);
			column.classList.toggle('past', day < today);
			column.classList.toggle('weekend', isWeekend(day));
			type Block = { start: number; end: number; tone: Tone; item: ICalendarItem; automation: IAutomation; time: string };
			const blocks: Block[] = [];
			const minuteOf = (at: number) => Math.max(0, Math.min(24 * 60, (at - day) / 60_000));
			for (const slot of perDay[index].slots) {
				const automation = byId.get(slot.automationId)!;
				const top = minuteOf(slot.at);
				blocks.push({ start: top, end: top + minHeight / minuteHeight, tone: 'plan', item: this.slotItem(automation, slot), automation, time: clock(slot.at) });
			}
			// A repeating automation's runs are on its bar above; a failed one still gets a block, so failures stand out.
			for (const entry of runs.filter(run => run.at >= day && run.at < addDays(day, 1) && (!isFolded(run, frequent) || toneOf(run.run) === 'fail'))) {
				const automation = byId.get(entry.automationId)!;
				const top = minuteOf(entry.at);
				const end = Math.max(top + minHeight / minuteHeight, minuteOf(entry.endedAt));
				const time = entry.run.finishedAt && entry.endedAt - entry.at >= 30 * 60_000 ? `${clock(entry.at)}\u2013${clock(entry.endedAt)}` : clock(entry.at);
				blocks.push({ start: top, end, tone: toneOf(entry.run), item: this.runItem(automation, entry), automation, time });
			}
			const layout = packColumns(blocks);
			blocks.forEach((block, blockIndex) => {
				const { column: lane, columns: lanes, span } = layout[blockIndex];
				const element = this.paint(this.item(append(column, $(`.wk-ev.${block.tone}`)), block.item), block.automation.id);
				element.classList.toggle('inactive', !block.automation.enabled && block.tone === 'plan');
				const height = Math.max(minHeight, (block.end - block.start) * minuteHeight) - 2;
				element.style.top = `${block.start * minuteHeight + 1}px`;
				element.style.height = `${height}px`;
				// Overlapping blocks sit side by side, never on top of each other; each widens over the columns free beside it.
				element.style.left = `calc(${lane / lanes * 100}% + ${lane ? 1 : 3}px)`;
				element.style.width = `calc(${span / lanes * 100}% - ${lane ? 3 : 5}px)`;
				element.classList.toggle('tall', height >= 38);
				const text = append(element, $('span.text'));
				append(text, $('span.name')).textContent = block.automation.name;
				append(text, $('span.time')).textContent = block.time;
				const glyph = STATE_GLYPHS[block.tone];
				if (glyph) {
					append(element, $('span.state')).appendChild(renderIcon(glyph));
				}
			});
		});

		let ghostAt: number | undefined;
		const place = (e: MouseEvent) => {
			const column = (e.target as HTMLElement).closest<HTMLElement>('.wk-col');
			if (!column || (e.target as HTMLElement).closest('[data-i]')) {
				ghost.classList.remove('visible');
				ghostAt = undefined;
				return;
			}
			const top = column.getBoundingClientRect().top;
			const minutes = Math.max(0, Math.min(24 * 60 - SNAP_WEEK, Math.floor((e.clientY - top) / minuteHeight / SNAP_WEEK) * SNAP_WEEK));
			ghostAt = combineDayAndTime(Number(column.dataset.day), minutes);
			ghost.classList.add('visible');
			ghost.style.left = `${column.offsetLeft + 3}px`;
			ghost.style.width = `${column.offsetWidth - 6}px`;
			ghost.style.top = `${minutes * minuteHeight + 1}px`;
			ghost.style.height = `${SNAP_WEEK * minuteHeight - 2}px`;
			ghost.textContent = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
		};
		this.renderStore.add(addDisposableListener(inner, 'mousemove', e => {
			if (!this.root.classList.contains('picking')) {
				place(e);
			}
		}));
		this.renderStore.add(addDisposableListener(inner, 'mouseleave', () => {
			if (!this.root.classList.contains('picking')) {
				ghost.classList.remove('visible');
			}
		}));
		this.renderStore.add(addDisposableListener(inner, 'click', e => {
			if ((e.target as HTMLElement).closest('[data-i]') || !(e.target as HTMLElement).closest('.wk-col')) {
				return;
			}
			place(e);
			if (ghostAt !== undefined) {
				this.showCreateMenu(e, ghostAt, undefined, () => ghost.classList.remove('visible'));
			}
		}));

		const todayIndex = days.indexOf(today);
		if (todayIndex >= 0) {
			const line = append(inner.querySelectorAll<HTMLElement>('.wk-col')[todayIndex], $('.wk-now'));
			const move = (at: number) => line.style.top = `${minutesOfDay(at) * minuteHeight}px`;
			move(now);
			this.keepTime(move);
		} else {
			this.keepTime(() => { });
		}

		scroll.scanDomNode();
		const firstMinute = todayIndex >= 0 ? minutesOfDay(now) - 150 : 8 * 60 - 30;
		scroll.setScrollPosition({ scrollTop: this.weekScroll?.start === start ? this.weekScroll.top : Math.max(0, firstMinute * minuteHeight) });
		this.weekScroll = { start, top: scroll.getScrollPosition().scrollTop };
		this.renderStore.add(scroll.onScroll(() => this.weekScroll = { start, top: scroll.getScrollPosition().scrollTop }));
	}

	//#endregion

	//#region Month

	private renderMonth(): void {
		const now = Date.now();
		const today = startOfDay(now);
		const weeks = calendarWeeks(this.date, { now, weekStart: WEEK_START });
		const automations = this.visible();
		const byId = new Map(automations.map(automation => [automation.id, automation]));
		const first = weeks[0][0].date;
		const runs = runsBetween(automations, first, addDays(first, 42), now);
		const routine = new Set(automations.flatMap(automation => automation.triggers.filter(trigger => trigger.schedule && isRoutineSchedule(trigger.schedule)).map(trigger => trigger.id)));
		const order = new Map([...automations].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((automation, index) => [automation.id, index]));
		const dayLabel = dateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

		const grid = append(this.body, $('.volt-auto-cal-month'));
		const head = append(grid, $('.mo-head'));
		const weekday = dateTimeFormat(undefined, { weekday: 'short' });
		for (const day of weeks[0]) {
			const label = append(head, $('span'));
			label.textContent = weekday.format(day.date);
			label.classList.toggle('weekend', isWeekend(day.date));
		}
		const cells = append(grid, $('.mo-grid'));
		let runIndex = 0;
		for (const week of weeks) {
			for (const day of week) {
				const cell = append(cells, $('.mo-cell'));
				cell.dataset.day = String(day.date);
				cell.classList.toggle('out', !day.inMonth);
				cell.classList.toggle('today', day.today);
				cell.classList.toggle('past', day.date < today);
				cell.classList.toggle('weekend', isWeekend(day.date));
				const number = append(cell, $('button.mo-num')) as HTMLButtonElement;
				number.type = 'button';
				// The first day of a month says which month, as calendars do.
				number.textContent = day.day === 1 ? dateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(day.date) : String(day.day);
				number.title = localize('voltAutomations.cal.openDay', "Open {0}", dayLabel.format(day.date));
				this.renderStore.add(addDisposableListener(number, 'click', e => {
					e.stopPropagation();
					this.navigate('day', day.date);
				}));

				// Runs are sorted by time: walk them once across the whole grid.
				const end = addDays(day.date, 1);
				const dayRuns: ICalendarRun[] = [];
				while (runIndex < runs.length && runs[runIndex].at < end) {
					if (runs[runIndex].at >= day.date) {
						dayRuns.push(runs[runIndex]);
					}
					runIndex++;
				}
				const { slots, repeats } = daySlots(automations, day.date, now);

				// Every automation of the day, for its dot and the dots' card.
				type Tally = { readonly automation: IAutomation; ok: number; fail: number; running: number; planned: number };
				const tallies = new Map<string, Tally>();
				const tally = (automation: IAutomation) => {
					let entry = tallies.get(automation.id);
					if (!entry) {
						entry = { automation, ok: 0, fail: 0, running: 0, planned: 0 };
						tallies.set(automation.id, entry);
					}
					return entry;
				};
				// What gets a line of its own: failures, pull requests, events, and schedules rarer than daily.
				type Line = { readonly rank: number; readonly at: number; readonly tone: Tone; readonly automation: IAutomation; readonly item: ICalendarItem; readonly right: string; readonly pr?: string };
				const lines: Line[] = [];
				const failures = new Map<string, { at: number; count: number; item: ICalendarItem }>();
				for (const entry of dayRuns) {
					const automation = byId.get(entry.automationId)!;
					const tone = toneOf(entry.run);
					const counts = tally(automation);
					counts.ok += tone === 'ok' ? 1 : 0;
					counts.fail += tone === 'fail' ? 1 : 0;
					counts.running += tone === 'run' ? 1 : 0;
					const item = this.runItem(automation, entry);
					const pr = runPullRequest(entry.run);
					if (tone === 'fail') {
						const failure = failures.get(automation.id);
						failures.set(automation.id, failure ? { ...failure, count: failure.count + 1 } : { at: entry.at, count: 1, item });
					} else if (pr) {
						lines.push({ rank: 1, at: entry.at, tone, automation, item, right: '', pr: pr.label });
					} else if (tone === 'run' || entry.run.provider !== 'schedule' || !(entry.run.triggerId && routine.has(entry.run.triggerId))) {
						lines.push({ rank: 2, at: entry.at, tone, automation, item, right: clock(entry.at) });
					}
				}
				for (const [automationId, failure] of failures) {
					lines.push({ rank: 0, at: failure.at, tone: 'fail', automation: byId.get(automationId)!, item: failure.item, right: failure.count > 1 ? `\u00d7${failure.count}` : clock(failure.at) });
				}
				for (const slot of slots) {
					const automation = byId.get(slot.automationId)!;
					tally(automation).planned++;
					if (!routine.has(slot.triggerId)) {
						lines.push({ rank: 3, at: slot.at, tone: 'plan', automation, item: this.slotItem(automation, slot), right: clock(slot.at) });
					}
				}
				for (const repeat of repeats) {
					tally(byId.get(repeat.automationId)!).planned += repeat.count;
				}

				const list = append(cell, $('.mo-list'));
				lines.sort((a, b) => a.rank - b.rank || a.at - b.at);
				const shownLines = lines.length > MONTH_LINES ? lines.slice(0, MONTH_LINES - 1) : lines;
				for (const line of shownLines) {
					const element = this.paint(this.item(append(list, $(`.mo-line.${line.tone}`)), line.item), line.automation.id);
					element.classList.toggle('inactive', !line.automation.enabled && line.tone === 'plan');
					append(element, $('span.mark'));
					append(element, $('span.name')).textContent = line.automation.name;
					if (line.pr) {
						append(element, $('span.pr')).textContent = line.pr;
					} else {
						append(element, $('span.time')).textContent = line.right;
					}
				}
				if (lines.length > shownLines.length) {
					const more = append(list, $('button.mo-more')) as HTMLButtonElement;
					more.type = 'button';
					more.textContent = localize('voltAutomations.cal.more', "+{0} more", lines.length - shownLines.length);
					this.renderStore.add(addDisposableListener(more, 'click', e => {
						e.stopPropagation();
						this.navigate('day', day.date);
					}));
				}

				// One dot per automation of the day, in its colour: filled when it ran, a ring when it is still ahead, red when it failed.
				if (tallies.size) {
					const entries = [...tallies.values()].sort((a, b) => (order.get(a.automation.id) ?? 0) - (order.get(b.automation.id) ?? 0));
					const fails = entries.reduce((sum, entry) => sum + entry.fail, 0);
					const dots = this.item(append(cell, $('.mo-dots')), {
						title: dayLabel.format(day.date),
						tone: fails ? 'fail' : day.date < today ? 'ok' : 'plan',
						lines: entries.map(entry => {
							const ran = entry.ok + entry.fail + entry.running;
							const parts = [
								ran ? localize('voltAutomations.cal.nRan', "{0} ran", ran) : '',
								entry.fail ? localize('voltAutomations.cal.nFailed', "{0} failed", entry.fail) : '',
								entry.planned ? localize('voltAutomations.cal.nPlanned', "{0} planned", entry.planned) : '',
							].filter(Boolean);
							return `${entry.automation.name}: ${parts.join(', ')}`;
						}),
						open: () => this.navigate('day', day.date),
					});
					for (const entry of entries.slice(0, MONTH_DOTS)) {
						const dot = this.paint(append(dots, $('span.dot')), entry.automation.id);
						dot.classList.add(entry.fail ? 'fail' : entry.ok || entry.running ? 'ran' : 'plan');
						dot.classList.toggle('inactive', !entry.automation.enabled);
					}
					if (entries.length > MONTH_DOTS) {
						append(dots, $('span.extra')).textContent = `+${entries.length - MONTH_DOTS}`;
					}
				}
			}
		}
		this.renderStore.add(addDisposableListener(cells, 'click', e => {
			const cell = (e.target as HTMLElement).closest<HTMLElement>('.mo-cell');
			if (!cell || (e.target as HTMLElement).closest('[data-i]')) {
				return;
			}
			const day = Number(cell.dataset.day);
			// Today offers the next round hour; any other day starts at 09:00.
			const minutes = day === today ? Math.min(23 * 60, (new Date(now).getHours() + 1) * 60) : 9 * 60;
			cell.classList.add('picked');
			this.showCreateMenu(e, combineDayAndTime(day, minutes), undefined, () => cell.classList.remove('picked'));
		}));
		this.keepTime(() => { });
	}

	//#endregion

	//#region Create

	/**
	 * Clicked an empty time: schedule a new automation there (blank or from a scheduled template),
	 * or add the time to an automation (the lane's, or one picked from a list).
	 */
	private showCreateMenu(e: MouseEvent, at: number, automationId: string | undefined, onHide: () => void): void {
		const host = this.root.getBoundingClientRect();
		const anchor = append(this.root, $('.volt-auto-cal-anchor'));
		anchor.style.transform = `translate(${Math.round(e.clientX - host.left)}px, ${Math.round(e.clientY - host.top)}px)`;
		this.root.classList.add('picking');
		this.hideTip();

		const date = new Date(at);
		const time = clock(at);
		const choices: { readonly id: string; readonly label: string; readonly schedule: AutomationSchedule }[] = [
			{ id: 'daily', label: localize('voltAutomations.cal.everyDayAt', "Every day at {0}", time), schedule: { type: 'daily', time } },
			{ id: 'weekly', label: localize('voltAutomations.cal.everyWeekdayAt', "Every {0} at {1}", weekdayName(date.getDay()), time), schedule: { type: 'weekly', weekdays: [date.getDay()], time } },
			{ id: 'weekdays', label: localize('voltAutomations.cal.weekdaysAt', "Weekdays at {0}", time), schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time } },
			{ id: 'hourly', label: localize('voltAutomations.cal.hourlyAt', "Every hour at :{0}", pad(date.getMinutes())), schedule: { type: 'hourly', minute: date.getMinutes() } },
			{ id: 'minutes', label: localize('voltAutomations.cal.every15', "Every 15 minutes"), schedule: { type: 'interval', everyMs: 15 * 60_000 } },
			{ id: 'monthly', label: localize('voltAutomations.cal.monthlyAt', "Monthly on the {0} at {1}", ordinal(date.getDate()), time), schedule: { type: 'cron', expr: `${date.getMinutes()} ${date.getHours()} ${date.getDate()} * *` } },
		];
		const addItems = (automation: IAutomation): IVoltMenuItem<CreatePick>[] => choices.slice(0, 4).map(choice => ({
			id: `add:${automation.id}:${choice.id}`,
			label: choice.label,
			data: { kind: 'add', automationId: automation.id, schedule: choice.schedule },
		}));
		const templates = AUTOMATION_TEMPLATES.filter(template => template.triggers[0]?.provider === 'schedule');
		const sections: IVoltMenuSection<CreatePick>[] = [];
		const lane = automationId ? this.automations.get(automationId) : undefined;
		if (lane) {
			sections.push({
				id: 'lane',
				title: localize('voltAutomations.cal.addTo', "Add to {0}", lane.name),
				items: [...addItems(lane), { id: 'open', label: localize('voltAutomations.cal.openAutomation', "Open {0}", lane.name), icon: Codicon.linkExternal, data: { kind: 'open', automationId: lane.id } }],
			});
		}
		const all = this.automations.list();
		const existing: IVoltMenuItem<CreatePick> = {
			id: 'existing',
			label: localize('voltAutomations.cal.addToExisting', "Add to an automation"),
			icon: Codicon.add,
			data: { kind: 'new' as const, schedule: choices[0].schedule },
			submenu: {
				width: 260,
				...(all.length > 8 ? { search: { placeholder: localize('voltAutomations.cal.searchAutomations', "Search automations") } } : {}),
				sections: [{
					id: 'automations',
					items: [...all].sort((a, b) => a.name.localeCompare(b.name)).map((automation): IVoltMenuItem<CreatePick> => ({
						id: `to:${automation.id}`,
						label: automation.name,
						...(automation.enabled ? {} : { detail: localize('voltAutomations.inactive', "Inactive") }),
						data: { kind: 'open', automationId: automation.id },
						submenu: { width: 230, sections: [{ id: `to:${automation.id}`, items: addItems(automation) }] },
					})),
				}],
			},
		};
		sections.push({
			id: 'new',
			title: localize('voltAutomations.cal.newAt', "New automation · {0}", `${dateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(at)} ${time}`),
			items: [
				...choices.map((choice): IVoltMenuItem<CreatePick> => ({ id: `new:${choice.id}`, label: choice.label, data: { kind: 'new', schedule: choice.schedule } })),
				{
					id: 'template',
					label: localize('voltAutomations.cal.fromTemplate', "From a template"),
					icon: Codicon.library,
					data: { kind: 'new', schedule: choices[0].schedule },
					submenu: {
						width: 300,
						sections: [{
							id: 'templates',
							items: templates.map(template => {
								const schedule = adaptSchedule(template.triggers[0].schedule, at);
								return { id: `tpl:${template.id}`, label: template.title, detail: describeSchedule(schedule), data: { kind: 'new' as const, schedule, templateId: template.id } };
							}),
						}],
					},
				},
				...(!lane && all.length ? [existing] : []),
			],
		});

		this.menu.value = showVoltMenu<CreatePick>(this.contextView, {
			anchor,
			gap: 4,
			width: 280,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.cal.schedule', "Schedule at {0}", time),
			sections,
			onPick: item => this.pickCreate(item.data),
			onHide: () => {
				anchor.remove();
				this.root.classList.remove('picking');
				onHide();
			},
		});
	}

	private async pickCreate(pick: CreatePick): Promise<void> {
		switch (pick.kind) {
			case 'new':
				this.options.host.navigate({ page: 'detail', tab: 'settings', seed: { schedule: pick.schedule, ...(pick.templateId ? { templateId: pick.templateId } : {}) } });
				return;
			case 'open':
				this.options.host.navigate({ page: 'detail', id: pick.automationId, tab: 'settings' });
				return;
			case 'add': {
				const automation = this.automations.get(pick.automationId);
				if (!automation) {
					return;
				}
				const trigger = { id: `tr-${generateUuid().replace(/-/g, '').slice(0, 10)}`, provider: 'schedule' as const, event: scheduleKindOf(pick.schedule), schedule: pick.schedule };
				await this.automations.update(automation.id, { triggers: [...automation.triggers, trigger] });
				this.notifications.info(automation.enabled
					? localize('voltAutomations.cal.added', "{0} now also runs {1}.", automation.name, describeSchedule(pick.schedule).toLowerCase())
					: localize('voltAutomations.cal.addedInactive', "Added {1} to {0}. It is inactive: switch it on to run.", automation.name, describeSchedule(pick.schedule).toLowerCase()));
				return;
			}
		}
	}

	//#endregion
}
