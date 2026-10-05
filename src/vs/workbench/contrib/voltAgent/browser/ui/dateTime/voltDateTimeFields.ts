/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './voltDateTime.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import {
	addDays,
	addMonths,
	calendarWeeks,
	formatDayLabel,
	formatDayLong,
	formatMonthLabel,
	formatTimeLabel,
	localeWeekStart,
	parseTimeInput,
	sameDay,
	sameMonth,
	startOfDay,
	startOfMonth,
	timeSlots,
	weekdayLabels,
} from './voltDateTime.js';

let popoverIds = 0;

/**
 * A panel under a field, inside the field's own box so it rides along with whatever holds the
 * field (a dialog, a menu). Opaque, so it is safe over the see-through agent window. Closes on a
 * click outside the field, on Escape (without letting Escape reach the dialog), and when focus
 * leaves the field.
 */
abstract class VoltPopoverField extends Disposable {

	readonly element: HTMLElement;
	protected popover: HTMLElement | undefined;
	private readonly open = this._register(new MutableDisposable<DisposableStore>());

	constructor(parent: HTMLElement, className: string) {
		super();
		this.element = append(parent, $(`.volt-dt-field.${className}`));
		this._register(toDisposable(() => this.element.remove()));
		this._register(addDisposableListener(this.element, EventType.FOCUS_OUT, e => {
			if (!(e.relatedTarget instanceof Node && this.element.contains(e.relatedTarget))) {
				this.element.classList.remove('quiet');
			}
		}));
	}

	/** Called after a pick: the field keeps focus without its focus highlight. */
	protected quiet(): void {
		this.element.classList.add('quiet');
	}

	get isOpen(): boolean {
		return !!this.popover;
	}

	protected openPopover(className: string, role: string): HTMLElement {
		if (this.popover) {
			return this.popover;
		}
		const store = new DisposableStore();
		const popover = append(this.element, $(`.volt-dt-popover.${className}`));
		popover.id = `volt-dt-popover-${++popoverIds}`;
		popover.setAttribute('role', role);
		this.popover = popover;
		this.element.classList.add('open');
		store.add(toDisposable(() => {
			popover.remove();
			this.popover = undefined;
			this.element.classList.remove('open');
			this.onDidClosePopover();
		}));
		store.add(addDisposableListener(getWindow(this.element).document, EventType.MOUSE_DOWN, e => {
			if (!(e.target instanceof Node) || !this.element.contains(e.target)) {
				this.closePopover();
			}
		}, true));
		store.add(addDisposableListener(this.element, EventType.FOCUS_OUT, e => {
			const next = e.relatedTarget;
			if (next instanceof Node && this.element.contains(next)) {
				return;
			}
			// A click inside the popover moves focus to nothing for a moment; only a real move away closes it.
			if (next !== null) {
				this.closePopover();
			}
		}));
		store.add(addDisposableListener(this.element, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.closePopover();
				this.focusTrigger();
			}
		}));
		this.open.value = store;
		return popover;
	}

	/** Flip above the field, or toward the left, when the panel would leave the window. */
	protected placePopover(): void {
		const popover = this.popover;
		if (!popover) {
			return;
		}
		popover.classList.remove('above', 'end');
		const window = getWindow(popover);
		const rect = popover.getBoundingClientRect();
		const field = this.element.getBoundingClientRect();
		if (rect.bottom > window.innerHeight - 8 && field.top - rect.height - 8 > 0) {
			popover.classList.add('above');
		}
		if (rect.right > window.innerWidth - 8) {
			popover.classList.add('end');
		}
	}

	closePopover(): void {
		this.open.clear();
	}

	protected onDidClosePopover(): void { }

	protected abstract focusTrigger(): void;
}

export interface IVoltDateFieldOptions {
	/** Any moment on the day shown first. */
	readonly value: number;
	/** Earliest day that can be picked. */
	readonly min?: number;
	readonly ariaLabel: string;
	readonly locale?: string;
}

/**
 * A date picker: a field that reads "Oct 4, 2026" and a month calendar under it. Arrow keys move
 * by day and week, Page Up / Page Down by month, Home / End to the ends of the week; Enter picks.
 */
export class VoltDateField extends VoltPopoverField {

	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange: Event<number> = this._onDidChange.event;

	private readonly trigger: HTMLButtonElement;
	private readonly label: HTMLElement;
	private readonly weekStart: number;
	private day: number;
	/** The focused day while the calendar is open; it can sit in another month than {@link day}. */
	private cursor: number;
	private min: number | undefined;
	private readonly renderStore = this._register(new DisposableStore());

	constructor(parent: HTMLElement, private readonly options: IVoltDateFieldOptions) {
		super(parent, 'date');
		this.day = startOfDay(options.value);
		this.cursor = this.day;
		this.min = options.min === undefined ? undefined : startOfDay(options.min);
		this.weekStart = localeWeekStart(options.locale);

		this.trigger = append(this.element, $('button.volt-dt-control')) as HTMLButtonElement;
		this.trigger.type = 'button';
		this.trigger.setAttribute('aria-haspopup', 'dialog');
		this.trigger.setAttribute('aria-expanded', 'false');
		this.label = append(this.trigger, $('span.volt-dt-value'));
		append(this.trigger, $('span.volt-dt-icon')).appendChild(renderIcon(Codicon.calendar));
		this.syncTrigger();

		this._register(addDisposableListener(this.trigger, EventType.CLICK, () => this.isOpen ? this.closePopover() : this.openCalendar()));
		this._register(addDisposableListener(this.trigger, EventType.KEY_DOWN, e => {
			if (!this.isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
				e.preventDefault();
				this.openCalendar();
			}
		}));
	}

	get value(): number {
		return this.day;
	}

	setValue(value: number): void {
		const day = startOfDay(value);
		if (day === this.day) {
			return;
		}
		this.day = day;
		this.syncTrigger();
		this._onDidChange.fire(day);
	}

	private syncTrigger(): void {
		this.label.textContent = formatDayLabel(this.day, this.options.locale);
		this.trigger.setAttribute('aria-label', `${this.options.ariaLabel}, ${formatDayLong(this.day, this.options.locale)}`);
	}

	private openCalendar(): void {
		this.cursor = this.day;
		const popover = this.openPopover('calendar', 'dialog');
		popover.setAttribute('aria-label', this.options.ariaLabel);
		this.trigger.setAttribute('aria-expanded', 'true');
		this.renderCalendar(true);
		this.placePopover();
	}

	protected override onDidClosePopover(): void {
		this.renderStore.clear();
		this.trigger.setAttribute('aria-expanded', 'false');
	}

	protected focusTrigger(): void {
		this.trigger.focus();
	}

	private pick(day: number): void {
		if (this.min !== undefined && day < this.min) {
			return;
		}
		this.setValue(day);
		this.closePopover();
		this.quiet();
		this.trigger.focus();
	}

	/** Moves the focused day, never before the earliest pickable one. */
	private moveCursor(day: number): void {
		const next = this.min !== undefined && day < this.min ? this.min : day;
		const monthChanged = !sameMonth(next, this.cursor);
		this.cursor = next;
		if (monthChanged) {
			this.renderCalendar(true);
		} else {
			this.focusCursor();
		}
	}

	private focusCursor(): void {
		const buttons = this.popover?.querySelectorAll<HTMLButtonElement>('button.volt-dt-day') ?? [];
		for (const button of buttons) {
			const isCursor = Number(button.dataset.date) === this.cursor;
			button.tabIndex = isCursor ? 0 : -1;
			if (isCursor) {
				button.focus();
			}
		}
	}

	private renderCalendar(focus: boolean): void {
		const popover = this.popover;
		if (!popover) {
			return;
		}
		this.renderStore.clear();
		popover.replaceChildren();
		const now = Date.now();
		const month = startOfMonth(this.cursor);

		const header = append(popover, $('.volt-dt-calendar-header'));
		const title = append(header, $('span.volt-dt-calendar-title'));
		title.textContent = formatMonthLabel(month, this.options.locale);
		title.id = `${popover.id}-title`;
		title.setAttribute('aria-live', 'polite');
		const nav = append(header, $('.volt-dt-calendar-nav'));
		const previous = append(nav, $('button.volt-dt-icon-button')) as HTMLButtonElement;
		previous.type = 'button';
		previous.tabIndex = -1;
		previous.setAttribute('aria-label', localize('voltDateTime.previousMonth', "Previous month"));
		previous.appendChild(renderIcon(Codicon.chevronLeft));
		previous.disabled = this.min !== undefined && month <= startOfMonth(this.min);
		const next = append(nav, $('button.volt-dt-icon-button')) as HTMLButtonElement;
		next.type = 'button';
		next.tabIndex = -1;
		next.setAttribute('aria-label', localize('voltDateTime.nextMonth', "Next month"));
		next.appendChild(renderIcon(Codicon.chevronRight));
		this.renderStore.add(addDisposableListener(previous, EventType.CLICK, () => this.moveCursor(addMonths(this.cursor, -1))));
		this.renderStore.add(addDisposableListener(next, EventType.CLICK, () => this.moveCursor(addMonths(this.cursor, 1))));

		const grid = append(popover, $('.volt-dt-calendar-grid'));
		grid.setAttribute('role', 'grid');
		grid.setAttribute('aria-labelledby', title.id);
		const head = append(grid, $('.volt-dt-calendar-row.head'));
		head.setAttribute('role', 'row');
		for (const weekday of weekdayLabels(this.weekStart, this.options.locale)) {
			const cell = append(head, $('span.volt-dt-weekday'));
			cell.setAttribute('role', 'columnheader');
			cell.setAttribute('aria-label', weekday.long);
			cell.textContent = weekday.short;
		}
		for (const week of calendarWeeks(month, { now, min: this.min, weekStart: this.weekStart })) {
			const row = append(grid, $('.volt-dt-calendar-row'));
			row.setAttribute('role', 'row');
			for (const day of week) {
				const cell = append(row, $('span.volt-dt-cell'));
				cell.setAttribute('role', 'gridcell');
				const button = append(cell, $('button.volt-dt-day')) as HTMLButtonElement;
				button.type = 'button';
				button.textContent = String(day.day);
				button.dataset.date = String(day.date);
				button.tabIndex = day.date === this.cursor ? 0 : -1;
				button.disabled = day.disabled;
				button.classList.toggle('outside', !day.inMonth);
				button.classList.toggle('today', day.today);
				const selected = sameDay(day.date, this.day);
				button.classList.toggle('selected', selected);
				cell.setAttribute('aria-selected', String(selected));
				button.setAttribute('aria-label', formatDayLong(day.date, this.options.locale));
				if (day.today) {
					button.setAttribute('aria-current', 'date');
				}
				this.renderStore.add(addDisposableListener(button, EventType.CLICK, () => this.pick(day.date)));
			}
		}
		this.renderStore.add(addDisposableListener(grid, EventType.KEY_DOWN, e => this.onGridKey(e)));

		const footer = append(popover, $('.volt-dt-calendar-footer'));
		const today = append(footer, $('button.volt-dt-link')) as HTMLButtonElement;
		today.type = 'button';
		today.textContent = localize('voltDateTime.today', "Today");
		today.disabled = this.min !== undefined && startOfDay(now) < this.min;
		const tomorrow = append(footer, $('button.volt-dt-link')) as HTMLButtonElement;
		tomorrow.type = 'button';
		tomorrow.textContent = localize('voltDateTime.tomorrow', "Tomorrow");
		this.renderStore.add(addDisposableListener(today, EventType.CLICK, () => this.pick(startOfDay(now))));
		this.renderStore.add(addDisposableListener(tomorrow, EventType.CLICK, () => this.pick(addDays(startOfDay(now), 1))));

		if (focus) {
			this.focusCursor();
		}
	}

	private onGridKey(e: KeyboardEvent): void {
		const weekdayIndex = (new Date(this.cursor).getDay() - this.weekStart + 7) % 7;
		let next: number | undefined;
		switch (e.key) {
			case 'ArrowLeft': next = addDays(this.cursor, -1); break;
			case 'ArrowRight': next = addDays(this.cursor, 1); break;
			case 'ArrowUp': next = addDays(this.cursor, -7); break;
			case 'ArrowDown': next = addDays(this.cursor, 7); break;
			case 'PageUp': next = addMonths(this.cursor, e.shiftKey ? -12 : -1); break;
			case 'PageDown': next = addMonths(this.cursor, e.shiftKey ? 12 : 1); break;
			case 'Home': next = addDays(this.cursor, -weekdayIndex); break;
			case 'End': next = addDays(this.cursor, 6 - weekdayIndex); break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				e.stopPropagation();
				this.pick(this.cursor);
				return;
			default:
				return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.moveCursor(next);
	}
}

export interface IVoltTimeFieldOptions {
	/** Minutes after midnight. */
	readonly value: number;
	/** Minutes between the times listed; typing can still set any minute. */
	readonly step?: number;
	readonly ariaLabel: string;
	readonly locale?: string;
}

/**
 * A time picker: a text field that takes typed times ("9:30", "930", "6pm") and a list of times
 * every 15 minutes under it. Up / Down walk the list, Enter keeps the highlighted time or what was
 * typed, and leaving the field keeps a typed time or puts back the last good one.
 */
export class VoltTimeField extends VoltPopoverField {

	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange: Event<number> = this._onDidChange.event;

	private readonly input: HTMLInputElement;
	private readonly step: number;
	private minutes: number;
	/** Times before this are listed but cannot be picked (today, before now). */
	private min: number | undefined;
	/** The highlighted time in the open list. */
	private active: number | undefined;
	private readonly listStore = this._register(new DisposableStore());

	constructor(parent: HTMLElement, private readonly options: IVoltTimeFieldOptions) {
		super(parent, 'time');
		this.minutes = options.value;
		this.step = options.step ?? 15;

		const control = append(this.element, $('.volt-dt-control.text'));
		this.input = append(control, $('input.volt-dt-input')) as HTMLInputElement;
		this.input.type = 'text';
		this.input.spellcheck = false;
		this.input.autocomplete = 'off';
		this.input.setAttribute('role', 'combobox');
		this.input.setAttribute('aria-autocomplete', 'list');
		this.input.setAttribute('aria-expanded', 'false');
		this.input.setAttribute('aria-label', options.ariaLabel);
		const icon = append(control, $('button.volt-dt-icon.volt-dt-icon-button')) as HTMLButtonElement;
		icon.type = 'button';
		icon.tabIndex = -1;
		icon.setAttribute('aria-label', localize('voltDateTime.showTimes', "Show times"));
		icon.appendChild(renderIcon(Codicon.clock));
		this.syncInput();

		this._register(addDisposableListener(this.input, EventType.MOUSE_DOWN, () => {
			if (!this.isOpen) {
				this.openList();
			}
		}));
		this._register(addDisposableListener(this.input, EventType.FOCUS, () => this.input.select()));
		this._register(addDisposableListener(icon, EventType.CLICK, () => {
			if (this.isOpen) {
				this.closePopover();
			} else {
				this.openList();
			}
			this.input.focus();
		}));
		this._register(addDisposableListener(this.input, EventType.INPUT, () => {
			this.element.classList.remove('quiet');
			this.input.classList.remove('invalid');
			const typed = parseTimeInput(this.input.value);
			if (typed === undefined) {
				return;
			}
			if (!this.isOpen) {
				this.openList();
			}
			this.highlight(this.nearestSlot(typed), true);
		}));
		this._register(addDisposableListener(this.input, EventType.KEY_DOWN, e => this.onInputKey(e)));
		this._register(addDisposableListener(this.input, EventType.BLUR, e => {
			const next = e.relatedTarget;
			if (next instanceof Node && this.element.contains(next)) {
				return;
			}
			this.commitTyped();
		}));
	}

	get value(): number {
		return this.minutes;
	}

	/** Times before `minutes` turn unpickable in the list (the day is today); undefined lifts it. */
	setMin(minutes: number | undefined): void {
		this.min = minutes;
		if (this.isOpen) {
			this.renderList();
		}
	}

	setValue(minutes: number): void {
		const value = Math.max(0, Math.min(minutes, 24 * 60 - 1));
		const changed = value !== this.minutes;
		this.minutes = value;
		this.syncInput();
		if (changed) {
			this._onDidChange.fire(value);
		}
	}

	private syncInput(): void {
		this.input.value = formatTimeLabel(this.minutes, this.options.locale);
		this.input.classList.remove('invalid');
	}

	/** Keeps a typed time; text that is not a time goes back to the last good value. */
	private commitTyped(): boolean {
		const typed = parseTimeInput(this.input.value);
		if (typed === undefined) {
			this.syncInput();
			return false;
		}
		this.setValue(typed);
		return true;
	}

	protected focusTrigger(): void {
		this.input.focus();
	}

	protected override onDidClosePopover(): void {
		this.listStore.clear();
		this.active = undefined;
		this.input.setAttribute('aria-expanded', 'false');
		this.input.removeAttribute('aria-activedescendant');
	}

	private openList(): void {
		const popover = this.openPopover('times', 'listbox');
		popover.setAttribute('aria-label', this.options.ariaLabel);
		this.input.setAttribute('aria-expanded', 'true');
		this.input.setAttribute('aria-controls', popover.id);
		this.renderList();
		this.placePopover();
		this.highlight(this.nearestSlot(this.minutes), true, 'center');
	}

	private slots(): number[] {
		return timeSlots(this.step, this.minutes);
	}

	private pickable(minutes: number): boolean {
		return this.min === undefined || minutes >= this.min;
	}

	/** The listed time at or after `minutes` that can be picked, else the last pickable one. */
	private nearestSlot(minutes: number): number | undefined {
		const pickable = this.slots().filter(slot => this.pickable(slot));
		return pickable.find(slot => slot >= minutes) ?? pickable.at(-1);
	}

	private renderList(): void {
		const popover = this.popover;
		if (!popover) {
			return;
		}
		this.listStore.clear();
		popover.replaceChildren();
		for (const slot of this.slots()) {
			const option = append(popover, $('.volt-dt-option'));
			option.id = `${popover.id}-${slot}`;
			option.dataset.minutes = String(slot);
			option.setAttribute('role', 'option');
			option.textContent = formatTimeLabel(slot, this.options.locale);
			const enabled = this.pickable(slot);
			option.classList.toggle('disabled', !enabled);
			option.setAttribute('aria-disabled', String(!enabled));
			const selected = slot === this.minutes;
			option.classList.toggle('selected', selected);
			option.setAttribute('aria-selected', String(selected));
			// Focus stays in the input (mousedown does not take it); the pick happens on click, once the
			// press is over. Removing the list during mousedown would drop focus to the page.
			this.listStore.add(addDisposableListener(option, EventType.MOUSE_DOWN, e => e.preventDefault()));
			this.listStore.add(addDisposableListener(option, EventType.CLICK, () => {
				if (enabled) {
					this.pick(slot);
				}
			}));
			this.listStore.add(addDisposableListener(option, EventType.MOUSE_MOVE, () => {
				if (enabled && this.active !== slot) {
					this.highlight(slot, false);
				}
			}));
		}
		if (this.active !== undefined) {
			this.highlight(this.active, false);
		}
	}

	private highlight(minutes: number | undefined, reveal: boolean, block: ScrollLogicalPosition = 'nearest'): void {
		this.active = minutes;
		const popover = this.popover;
		if (!popover) {
			return;
		}
		let target: HTMLElement | undefined;
		for (const option of popover.querySelectorAll<HTMLElement>('.volt-dt-option')) {
			const on = Number(option.dataset.minutes) === minutes;
			option.classList.toggle('active', on);
			if (on) {
				target = option;
			}
		}
		if (target) {
			this.input.setAttribute('aria-activedescendant', target.id);
			if (reveal) {
				scrollIntoList(popover, target, block);
			}
		} else {
			this.input.removeAttribute('aria-activedescendant');
		}
	}

	private pick(minutes: number): void {
		this.setValue(minutes);
		this.closePopover();
		this.quiet();
		this.input.focus();
		// Caret at the end, not the whole value selected: a picked time should look settled.
		const end = this.input.value.length;
		this.input.setSelectionRange(end, end);
	}

	private onInputKey(e: KeyboardEvent): void {
		switch (e.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				e.preventDefault();
				if (!this.isOpen) {
					this.openList();
					return;
				}
				const pickable = this.slots().filter(slot => this.pickable(slot));
				if (!pickable.length) {
					return;
				}
				const index = this.active === undefined ? -1 : pickable.indexOf(this.active);
				const nextIndex = e.key === 'ArrowDown'
					? Math.min(pickable.length - 1, index + 1)
					: Math.max(0, index < 0 ? pickable.length - 1 : index - 1);
				this.highlight(pickable[nextIndex], true);
				return;
			}
			case 'Enter': {
				// What was typed wins over the highlight: "9:07" means 9:07, not the 9:15 row.
				const typed = parseTimeInput(this.input.value);
				const typedChanged = typed !== undefined && this.input.value !== formatTimeLabel(this.minutes, this.options.locale);
				if (this.isOpen || typedChanged || typed === undefined) {
					e.preventDefault();
					e.stopPropagation();
				}
				if (typedChanged) {
					this.pick(typed);
				} else if (this.isOpen && this.active !== undefined) {
					this.pick(this.active);
				} else if (typed === undefined) {
					this.input.classList.add('invalid');
				}
				return;
			}
			case 'Tab':
				this.commitTyped();
				this.closePopover();
				return;
		}
	}
}

export interface IVoltSelectFieldOption<T extends string> {
	readonly id: T;
	readonly label: string;
}

/** A dropdown in the same style as the date and time fields, for short fixed lists (Minutes, Hours, ...). */
export class VoltSelectField<T extends string> extends VoltPopoverField {

	private readonly _onDidChange = this._register(new Emitter<T>());
	readonly onDidChange: Event<T> = this._onDidChange.event;

	private readonly trigger: HTMLButtonElement;
	private readonly label: HTMLElement;
	private current: T;
	private active: T | undefined;
	private readonly listStore = this._register(new DisposableStore());

	constructor(parent: HTMLElement, private readonly options: { readonly options: readonly IVoltSelectFieldOption<T>[]; readonly value: T; readonly ariaLabel: string }) {
		super(parent, 'select');
		this.current = options.value;
		this.trigger = append(this.element, $('button.volt-dt-control')) as HTMLButtonElement;
		this.trigger.type = 'button';
		this.trigger.setAttribute('aria-haspopup', 'listbox');
		this.trigger.setAttribute('aria-expanded', 'false');
		this.label = append(this.trigger, $('span.volt-dt-value'));
		append(this.trigger, $('span.volt-dt-icon.chevron')).appendChild(renderIcon(Codicon.chevronDown));
		this.syncTrigger();

		this._register(addDisposableListener(this.trigger, EventType.CLICK, () => this.isOpen ? this.closePopover() : this.openList()));
		this._register(addDisposableListener(this.trigger, EventType.KEY_DOWN, e => this.onKey(e)));
	}

	get value(): T {
		return this.current;
	}

	private syncTrigger(): void {
		this.label.textContent = this.options.options.find(option => option.id === this.current)?.label ?? '';
		this.trigger.setAttribute('aria-label', `${this.options.ariaLabel}, ${this.label.textContent}`);
	}

	protected focusTrigger(): void {
		this.trigger.focus();
	}

	protected override onDidClosePopover(): void {
		this.listStore.clear();
		this.trigger.setAttribute('aria-expanded', 'false');
		this.trigger.removeAttribute('aria-activedescendant');
	}

	private openList(): void {
		const popover = this.openPopover('options', 'listbox');
		popover.setAttribute('aria-label', this.options.ariaLabel);
		this.trigger.setAttribute('aria-expanded', 'true');
		this.trigger.setAttribute('aria-controls', popover.id);
		for (const option of this.options.options) {
			const row = append(popover, $('.volt-dt-option'));
			row.id = `${popover.id}-${option.id}`;
			row.dataset.id = option.id;
			row.setAttribute('role', 'option');
			row.textContent = option.label;
			row.classList.toggle('selected', option.id === this.current);
			row.setAttribute('aria-selected', String(option.id === this.current));
			this.listStore.add(addDisposableListener(row, EventType.MOUSE_DOWN, e => e.preventDefault()));
			this.listStore.add(addDisposableListener(row, EventType.CLICK, () => this.pick(option.id)));
			this.listStore.add(addDisposableListener(row, EventType.MOUSE_MOVE, () => this.highlight(option.id)));
		}
		this.placePopover();
		this.highlight(this.current);
	}

	private highlight(id: T): void {
		this.active = id;
		for (const row of this.popover?.querySelectorAll<HTMLElement>('.volt-dt-option') ?? []) {
			const on = row.dataset.id === id;
			row.classList.toggle('active', on);
			if (on) {
				this.trigger.setAttribute('aria-activedescendant', row.id);
			}
		}
	}

	private pick(id: T): void {
		const changed = id !== this.current;
		this.current = id;
		this.syncTrigger();
		this.closePopover();
		this.quiet();
		this.trigger.focus();
		if (changed) {
			this._onDidChange.fire(id);
		}
	}

	private onKey(e: KeyboardEvent): void {
		const ids = this.options.options.map(option => option.id);
		switch (e.key) {
			case 'ArrowDown':
			case 'ArrowUp': {
				e.preventDefault();
				if (!this.isOpen) {
					this.openList();
					return;
				}
				const index = ids.indexOf(this.active ?? this.current);
				const next = ids[Math.max(0, Math.min(ids.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
				this.highlight(next);
				return;
			}
			case 'Enter':
			case ' ':
				if (this.isOpen && this.active !== undefined) {
					e.preventDefault();
					e.stopPropagation();
					this.pick(this.active);
				}
				return;
		}
	}
}

/** Scrolls only the list, never the dialog or window around it. */
function scrollIntoList(list: HTMLElement, option: HTMLElement, block: ScrollLogicalPosition): void {
	const top = option.offsetTop;
	const bottom = top + option.offsetHeight;
	if (block === 'center') {
		list.scrollTop = Math.max(0, top - (list.clientHeight - option.offsetHeight) / 2);
	} else if (top < list.scrollTop) {
		list.scrollTop = top;
	} else if (bottom > list.scrollTop + list.clientHeight) {
		list.scrollTop = bottom - list.clientHeight;
	}
}
