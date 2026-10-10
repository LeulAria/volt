/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Five-field cron (`minute hour day-of-month month day-of-week`) in local time: lists, ranges,
 * steps, month and weekday names, `7` for Sunday, and the `@hourly`-style macros. Day-of-month
 * and day-of-week combine as in Vixie cron: when both are restricted, either one matching is
 * enough. The next run walks days, then the allowed hours and minutes of a matching day, so a
 * yearly expression costs a few hundred cheap checks, not half a million minutes.
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

function dayMatches(schedule: ICronSchedule, date: Date): boolean {
	if (!schedule.months.has(date.getMonth() + 1)) {
		return false;
	}
	const byDay = schedule.days.has(date.getDate());
	const byWeekday = schedule.weekdays.has(date.getDay());
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

/** The first minute strictly after `after` the schedule allows, or undefined within ~5 years. */
export function nextCronRun(schedule: ICronSchedule, after: number): number | undefined {
	const start = new Date(after);
	for (let offset = 0; offset < 366 * 5; offset++) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
		if (!dayMatches(schedule, day)) {
			continue;
		}
		for (const hour of schedule.hours) {
			for (const minute of schedule.minutes) {
				const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime();
				// Daylight saving can move a wall-clock time; the hour check drops the skipped one.
				if (at > after && new Date(at).getHours() === hour) {
					return at;
				}
			}
		}
	}
	return undefined;
}

/** "Every 15 minutes", "At 09:00 on weekdays", else the expression itself. */
export function describeCron(expression: string): string {
	const text = expression.trim();
	const parsed = parseCron(text);
	if (!parsed.schedule) {
		return text;
	}
	const parts = (MACROS[text.toLowerCase()] ?? text).split(/\s+/);
	const [minute, hour, dom, month, dow] = parts;
	const everyMinute = /^\*\/(\d+)$/.exec(minute);
	if (everyMinute && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return everyMinute[1] === '1' ? 'Every minute' : `Every ${everyMinute[1]} minutes`;
	}
	if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return `Every hour at :${minute.padStart(2, '0')}`;
	}
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*') {
		const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
		if (dow === '*') {
			return `Every day at ${time}`;
		}
		if (dow === '1-5') {
			return `Weekdays at ${time}`;
		}
		if (dow === '0,6' || dow === '6,0') {
			return `Weekends at ${time}`;
		}
	}
	return `Cron ${text}`;
}
