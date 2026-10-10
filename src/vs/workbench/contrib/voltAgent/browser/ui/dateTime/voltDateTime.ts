/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../../../../base/common/date.js';
import dayjs from '../vendor/dayjs.js';

/**
 * Calendar and clock arithmetic for the date and time fields (voltDateTimeFields.ts). Days are
 * local midnights in ms; times are minutes after midnight. dayjs does the calendar steps, so a
 * month or a day is a calendar unit, never 30 × 24 hours, and DST days come out right.
 */

export const MINUTES_PER_DAY = 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale and options; the fields format on every render. */
export function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale ?? ''}|${JSON.stringify(options)}`;
	let format = formatters.get(key);
	if (!format) {
		format = safeIntl.DateTimeFormat(locale, options).value;
		formatters.set(key, format);
	}
	return format;
}

export interface IVoltCalendarDay {
	/** Local midnight of the day. */
	readonly date: number;
	/** Day of the month, 1-31. */
	readonly day: number;
	/** Belongs to the month on show; the grid pads with the weeks around it. */
	readonly inMonth: boolean;
	readonly today: boolean;
	/** Before the earliest day that can be picked. */
	readonly disabled: boolean;
}

/** Local midnight of the day `at` falls on. */
export function startOfDay(at: number): number {
	return dayjs(at).startOf('day').valueOf();
}

/** Local midnight `delta` calendar days after `day`. */
export function addDays(day: number, delta: number): number {
	return dayjs(day).add(delta, 'day').startOf('day').valueOf();
}

/** The same day of the month `delta` months on, clamped to that month's last day (Jan 31 + 1 → Feb 28). */
export function addMonths(day: number, delta: number): number {
	return dayjs(day).add(delta, 'month').startOf('day').valueOf();
}

export function sameDay(a: number, b: number): boolean {
	return dayjs(a).isSame(b, 'day');
}

export function sameMonth(a: number, b: number): boolean {
	return dayjs(a).isSame(b, 'month');
}

/** Local midnight of the first day of the month `at` falls in. */
export function startOfMonth(at: number): number {
	return dayjs(at).startOf('month').valueOf();
}

/**
 * The month containing `month` as six full weeks starting on `weekStart` (0 = Sunday). Always 42
 * days, so the popover keeps one height while paging through months.
 */
export function calendarWeeks(month: number, options: { readonly now: number; readonly min?: number; readonly weekStart: number }): IVoltCalendarDay[][] {
	const first = dayjs(month).startOf('month');
	const lead = (first.day() - options.weekStart + 7) % 7;
	const start = first.subtract(lead, 'day');
	const min = options.min === undefined ? undefined : startOfDay(options.min);
	const weeks: IVoltCalendarDay[][] = [];
	for (let week = 0; week < 6; week++) {
		const days: IVoltCalendarDay[] = [];
		for (let index = 0; index < 7; index++) {
			const day = start.add(week * 7 + index, 'day');
			const date = day.valueOf();
			days.push({
				date,
				day: day.date(),
				inMonth: day.month() === first.month(),
				today: day.isSame(options.now, 'day'),
				disabled: min !== undefined && date < min,
			});
		}
		weeks.push(days);
	}
	return weeks;
}

/** The moment `minutes` after midnight on `day`, in local time. A time skipped by DST lands just after the gap. */
export function combineDayAndTime(day: number, minutes: number): number {
	return dayjs(day).startOf('day').hour(Math.floor(minutes / 60)).minute(minutes % 60).second(0).millisecond(0).valueOf();
}

/** Minutes after local midnight of `at`. */
export function minutesOfDay(at: number): number {
	const value = dayjs(at);
	return value.hour() * 60 + value.minute();
}

/** `at` moved up to the next multiple of `step` minutes (unchanged when already on one). */
export function roundUpToStep(at: number, step: number): number {
	const value = dayjs(at).second(0).millisecond(0);
	const minutes = value.hour() * 60 + value.minute();
	const extra = (step - (minutes % step)) % step;
	const rounded = value.add(extra, 'minute');
	// Seconds past the minute still count as later than the minute itself.
	return rounded.valueOf() < at ? rounded.add(step, 'minute').valueOf() : rounded.valueOf();
}

/** Every `step` minutes of a day, plus `extra` (a picked time between steps) in order. */
export function timeSlots(step: number, extra?: number): number[] {
	const slots: number[] = [];
	for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += step) {
		slots.push(minutes);
	}
	if (extra !== undefined && extra >= 0 && extra < MINUTES_PER_DAY && extra % step !== 0) {
		slots.push(extra);
		slots.sort((a, b) => a - b);
	}
	return slots;
}

/**
 * Minutes after midnight for what someone types into a time field: "9", "930", "9:30", "09.30",
 * "21:30", "9pm", "9:30 p.m.", "11:16 AM" (with the narrow space Intl puts before AM), "noon",
 * "midnight". Undefined for anything else; never guesses past 23:59.
 */
export function parseTimeInput(text: string): number | undefined {
	let value = text.toLowerCase().replace(/[\s\u00a0\u202f]+/g, ' ').trim();
	if (value === 'noon') {
		return 12 * 60;
	}
	if (value === 'midnight') {
		return 0;
	}
	let meridiem: 'am' | 'pm' | undefined;
	const suffix = /\s*([ap])\.?\s*(?:m\.?)?$/.exec(value);
	if (suffix && /\d/.test(value.slice(0, suffix.index))) {
		meridiem = suffix[1] === 'a' ? 'am' : 'pm';
		value = value.slice(0, suffix.index).trim();
	}
	let hours: number;
	let minutes: number;
	const separated = /^(\d{1,2})\s*[:.h]\s*(\d{2})$/.exec(value);
	const digits = /^\d{1,4}$/.exec(value);
	if (separated) {
		hours = Number(separated[1]);
		minutes = Number(separated[2]);
	} else if (digits) {
		// "9" and "21" are hours; "930" and "2130" end in their minutes.
		hours = Number(value.length <= 2 ? value : value.slice(0, -2));
		minutes = value.length <= 2 ? 0 : Number(value.slice(-2));
	} else {
		return undefined;
	}
	if (minutes > 59) {
		return undefined;
	}
	if (meridiem) {
		if (hours < 1 || hours > 12) {
			return undefined;
		}
		hours = hours % 12 + (meridiem === 'pm' ? 12 : 0);
	} else if (hours > 23) {
		return undefined;
	}
	return hours * 60 + minutes;
}

/** First day of the week for a locale, 0 = Sunday. Falls back to Sunday where Intl cannot say. */
export function localeWeekStart(locale?: string): number {
	try {
		const intlLocale = safeIntl.Locale(locale ?? dateTimeFormat(undefined, {}).resolvedOptions().locale).value as Intl.Locale & {
			getWeekInfo?(): { firstDay: number };
			weekInfo?: { firstDay: number };
		};
		const firstDay = intlLocale.getWeekInfo?.().firstDay ?? intlLocale.weekInfo?.firstDay;
		return typeof firstDay === 'number' ? firstDay % 7 : 0;
	} catch {
		return 0;
	}
}

/** "Oct 4, 2026" */
export function formatDayLabel(day: number, locale?: string): string {
	return dateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(day);
}

/** "Sunday, October 4, 2026", for screen readers. */
export function formatDayLong(day: number, locale?: string): string {
	return dateTimeFormat(locale, { dateStyle: 'full' }).format(day);
}

/** "October 2026" */
export function formatMonthLabel(month: number, locale?: string): string {
	return dateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month);
}

/** "10:55 AM", or "10:55" where the locale keeps a 24-hour clock. */
export function formatTimeLabel(minutes: number, locale?: string): string {
	return dateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(combineDayAndTime(startOfDay(Date.now()), minutes));
}

/** Narrow weekday headers ("M", "T", ...) and their full names, starting on `weekStart`. */
export function weekdayLabels(weekStart: number, locale?: string): { readonly short: string; readonly long: string }[] {
	const narrow = dateTimeFormat(locale, { weekday: 'narrow' });
	const long = dateTimeFormat(locale, { weekday: 'long' });
	// 2023-01-01 was a Sunday.
	const sunday = dayjs(new Date(2023, 0, 1));
	return Array.from({ length: 7 }, (_, index) => {
		const day = sunday.add((weekStart + index) % 7, 'day').valueOf();
		return { short: narrow.format(day), long: long.format(day) };
	});
}
