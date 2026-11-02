/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { civilDay, wallClock } from './automationTime.js';

/**
 * Five-field cron (`minute hour day-of-month month day-of-week`) in local time or an IANA zone:
 * lists, ranges, steps, month and weekday names, `7` for Sunday, and the `@hourly`-style macros.
 * Day-of-month and day-of-week combine as in Vixie cron: when both are restricted, either one
 * matching is enough. The next run walks days, then the allowed hours and minutes of a matching
 * day, so a yearly expression costs a few hundred cheap checks, not half a million minutes.
 */

export interface ICronSchedule {
	readonly minutes: readonly number[];
	readonly hours: readonly number[];
	readonly days: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly weekdays: ReadonlySet<number>;
	/** The field was `*` (or a step over everything): the other day field decides alone. */
	readonly anyDay: boolean;
	readonly anyWeekday: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface IFieldRule {
	readonly name: string;
	readonly min: number;
	readonly max: number;
	readonly names?: readonly string[];
	/** Where `names[0]` sits (months start at 1). */
	readonly nameBase?: number;
}

const FIELDS: readonly IFieldRule[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
	{ name: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

export function parseCron(expression: string): { readonly schedule?: ICronSchedule; readonly error?: string } {
	const text = expression.trim().toLowerCase();
	const source = MACROS[text] ?? text;
	const parts = source.split(/\s+/).filter(Boolean);
	if (parts.length !== 5) {
		return { error: 'A cron expression has five fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5").' };
	}
	const sets: number[][] = [];
	for (let index = 0; index < 5; index++) {
		const parsed = parseField(parts[index], FIELDS[index]);
		if ('error' in parsed) {
			return { error: parsed.error };
		}
		sets.push(parsed.values);
	}
	const weekdays = new Set(sets[4].map(day => day === 7 ? 0 : day));
	return {
		schedule: {
			minutes: sets[0],
			hours: sets[1],
			days: new Set(sets[2]),
			months: new Set(sets[3]),
			weekdays,
			anyDay: parts[2] === '*' || parts[2] === '?',
			anyWeekday: parts[4] === '*' || parts[4] === '?',
		},
	};
}

function parseField(field: string, rule: IFieldRule): { readonly values: number[] } | { readonly error: string } {
	const values = new Set<number>();
	for (const item of field.split(',')) {
		const [range, stepText] = item.split('/');
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) {
			return { error: `Bad step "${item}" in the ${rule.name} field.` };
		}
		let from: number;
		let to: number;
		if (range === '*' || range === '?') {
			from = rule.min;
			to = rule.max === 7 ? 6 : rule.max;
		} else {
			const [startText, endText] = range.split('-');
			const start = fieldValue(startText, rule);
			const end = endText === undefined ? (stepText === undefined ? start : rule.max) : fieldValue(endText, rule);
			if (start === undefined || end === undefined || start > end) {
				return { error: `"${item}" is not valid in the ${rule.name} field (${rule.min}-${rule.max}).` };
			}
			from = start;
			to = end;
		}
		for (let value = from; value <= to; value += step) {
			values.add(value);
		}
	}
	return { values: [...values].sort((a, b) => a - b) };
}

function fieldValue(text: string | undefined, rule: IFieldRule): number | undefined {
	if (!text) {
		return undefined;
	}
	const named = rule.names?.indexOf(text.slice(0, 3)) ?? -1;
	const value = named >= 0 && /^[a-z]+$/.test(text) ? named + (rule.nameBase ?? 0) : /^\d+$/.test(text) ? Number(text) : Number.NaN;
	return Number.isInteger(value) && value >= rule.min && value <= rule.max ? value : undefined;
}

function dayMatches(schedule: ICronSchedule, month: number, day: number, weekday: number): boolean {
	if (!schedule.months.has(month)) {
		return false;
	}
	const byDay = schedule.days.has(day);
	const byWeekday = schedule.weekdays.has(weekday);
	if (schedule.anyDay && schedule.anyWeekday) {
		return true;
	}
	if (schedule.anyDay) {
		return byWeekday;
	}
	if (schedule.anyWeekday) {
		return byDay;
	}
	return byDay || byWeekday;
}

/**
 * The first minute strictly after `after` the schedule allows, or undefined within ~5 years.
 * `zone` is the IANA zone the fields are read in; local time when absent.
 */
export function nextCronRun(schedule: ICronSchedule, after: number, zone?: string): number | undefined {
	const clock = wallClock(zone);
	const start = clock.parts(after);
	for (let offset = 0; offset < 366 * 5; offset++) {
		const day = civilDay(start.year, start.month, start.day + offset);
		if (!dayMatches(schedule, day.month, day.day, day.weekday)) {
			continue;
		}
		for (const hour of schedule.hours) {
			// Hours and minutes before `after` on its own day cannot be later than it.
			if (offset === 0 && hour < start.hour) {
				continue;
			}
			for (const minute of schedule.minutes) {
				if (offset === 0 && hour === start.hour && minute < start.minute) {
					continue;
				}
				const at = clock.epoch(day.year, day.month, day.day, hour, minute);
				// Daylight saving can move a wall-clock time; the hour check drops the skipped one.
				if (at > after && clock.parts(at).hour === hour) {
					return at;
				}
			}
		}
	}
	return undefined;
}

/** A day the schedule runs on, in its zone, and how many runs it has there. */
export interface ICronDay {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	/** Hours × minutes: a dense schedule shows without listing its runs (a day that skips an hour for daylight saving has fewer). */
	readonly count: number;
}

/** The days in [from, to) the schedule runs on, read in `zone`. Walks days, never minutes. */
export function cronDaysBetween(schedule: ICronSchedule, from: number, to: number, zone?: string): ICronDay[] {
	const clock = wallClock(zone);
	const first = clock.parts(from);
	const last = clock.parts(Math.max(from, to - 1));
	const end = Date.UTC(last.year, last.month - 1, last.day);
	const perDay = schedule.hours.length * schedule.minutes.length;
	const days: ICronDay[] = [];
	for (let offset = 0; offset < 366 * 5; offset++) {
		const day = civilDay(first.year, first.month, first.day + offset);
		if (Date.UTC(day.year, day.month - 1, day.day) > end) {
			break;
		}
		if (dayMatches(schedule, day.month, day.day, day.weekday)) {
			days.push({ year: day.year, month: day.month, day: day.day, count: perDay });
		}
	}
	return days;
}

/** The runs of one day (from `cronDaysBetween`) in [from, to), at most `cap`. */
export function cronRunsOn(schedule: ICronSchedule, day: Pick<ICronDay, 'year' | 'month' | 'day'>, from: number, to: number, zone?: string, cap = Number.POSITIVE_INFINITY): number[] {
	const clock = wallClock(zone);
	const runs: number[] = [];
	for (const hour of schedule.hours) {
		for (const minute of schedule.minutes) {
			const at = clock.epoch(day.year, day.month, day.day, hour, minute);
			if (at >= from && at < to && clock.parts(at).hour === hour) {
				runs.push(at);
				if (runs.length >= cap) {
					return runs;
				}
			}
		}
	}
	return runs;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** " on weekdays", " on Mondays", " on Mon, Wed, Fri", "" for every day; undefined when it cannot be said simply. */
function weekdayPhrase(field: string, schedule: ICronSchedule): string | undefined {
	if (field === '*' || field === '?') {
		return '';
	}
	const days = [...schedule.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
	const key = [...days].sort((a, b) => a - b).join(',');
	if (key === '1,2,3,4,5') {
		return ' on weekdays';
	}
	if (key === '0,6') {
		return ' on weekends';
	}
	if (days.length === 7) {
		return '';
	}
	return days.length === 1 ? ` on ${WEEKDAYS[days[0]]}s` : ` on ${days.map(day => WEEKDAYS_SHORT[day]).join(', ')}`;
}

/** "09:00", "09:00 and 17:00", "09:00, 12:00 and 15:00"; undefined past four times. */
function timeList(hours: readonly number[], minutes: readonly number[]): string | undefined {
	if (hours.length * minutes.length > 4) {
		return undefined;
	}
	const times = hours.flatMap(hour => minutes.map(minute => `${pad(hour)}:${pad(minute)}`));
	return times.length === 1 ? times[0] : `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
}

/** "9:00-17:59" for an hour range, "9:00-9:59" for one hour; undefined for anything else. */
function hourWindow(field: string, lastMinute: number): string | undefined {
	const range = /^(\d{1,2})-(\d{1,2})$/.exec(field);
	if (range) {
		return `${Number(range[1])}:00\u2013${Number(range[2])}:${pad(lastMinute)}`;
	}
	return /^\d{1,2}$/.test(field) ? `${Number(field)}:00\u2013${Number(field)}:${pad(lastMinute)}` : undefined;
}

/**
 * Plain words for the usual shapes: "Every 5 minutes", "Every 15 minutes, 9:00-17:59 on
 * weekdays", "At :30 every hour", "Every 2 hours", "Weekdays at 09:00", "Monthly on day 1 at
 * 09:00"; else "Cron <expression>". An invalid expression comes back as typed.
 */
export function describeCron(expression: string): string {
	const text = expression.trim();
	const parsed = parseCron(text).schedule;
	if (!parsed) {
		return text;
	}
	const [minute, hour, dom, month, dow] = (MACROS[text.toLowerCase()] ?? text).split(/\s+/);
	const fallback = `Cron ${text}`;
	const days = weekdayPhrase(dow, parsed);
	if (month !== '*' || days === undefined) {
		return fallback;
	}
	const domPhrase = dom === '*' || dom === '?' ? '' : /^\d{1,2}$/.test(dom) && days === '' ? ` on day ${Number(dom)} of the month` : undefined;
	if (domPhrase === undefined) {
		return fallback;
	}
	const step = /^\*\/(\d+)$/.exec(minute);
	if (minute === '*' || step) {
		const every = step && step[1] !== '1' ? `Every ${step[1]} minutes` : 'Every minute';
		if (hour === '*') {
			return `${every}${days}${domPhrase}`;
		}
		const window = hourWindow(hour, 59);
		return window ? `${every}, ${window}${days}${domPhrase}` : fallback;
	}
	if (/^\d{1,2}$/.test(minute)) {
		const at = Number(minute);
		if (hour === '*') {
			return `${at === 0 ? 'Every hour' : `At :${pad(at)} every hour`}${days}${domPhrase}`;
		}
		const hourStep = /^\*\/(\d+)$/.exec(hour);
		if (hourStep) {
			return `Every ${hourStep[1]} hours${at ? ` at :${pad(at)}` : ''}${days}${domPhrase}`;
		}
		const window = /^\d{1,2}-\d{1,2}$/.test(hour) ? hourWindow(hour, at) : undefined;
		if (window) {
			return `At :${pad(at)} every hour, ${window}${days}${domPhrase}`;
		}
	}
	const times = /^[\d,]+$/.test(minute) && /^[\d,-]+$/.test(hour) ? timeList(parsed.hours, parsed.minutes) : undefined;
	if (!times) {
		return fallback;
	}
	if (domPhrase) {
		return `Monthly on day ${Number(dom)} at ${times}`;
	}
	switch (days) {
		case '': return `Every day at ${times}`;
		case ' on weekdays': return `Weekdays at ${times}`;
		case ' on weekends': return `Weekends at ${times}`;
	}
	return parsed.weekdays.size === 1 ? `Every ${WEEKDAYS[[...parsed.weekdays][0]]} at ${times}` : `${[...parsed.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(day => WEEKDAYS_SHORT[day]).join(', ')} at ${times}`;
}

/**
 * The parts of a plain `m h * * dow` expression (single minute and hour, every day of the month
 * and month), which the calendar can move by dragging; undefined for anything else.
 */
export function simpleCronParts(expression: string): { readonly minute: number; readonly hour: number; readonly weekdays: readonly number[] | undefined } | undefined {
	const text = expression.trim();
	const parsed = parseCron(text).schedule;
	const fields = (MACROS[text.toLowerCase()] ?? text).split(/\s+/);
	if (!parsed || fields.length !== 5 || !/^\d{1,2}$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1]) || !parsed.anyDay || fields[3] !== '*') {
		return undefined;
	}
	return { minute: Number(fields[0]), hour: Number(fields[1]), weekdays: parsed.anyWeekday ? undefined : [...parsed.weekdays].sort((a, b) => a - b) };
}

/** `m h * * dow` back to text; weekdays Monday to Friday as "1-5". */
export function formatSimpleCron(minute: number, hour: number, weekdays: readonly number[] | undefined): string {
	const days = !weekdays || weekdays.length === 7 ? '*' : [...new Set(weekdays)].sort((a, b) => a - b).join(',');
	return `${minute} ${hour} * * ${days === '1,2,3,4,5' ? '1-5' : days}`;
}
