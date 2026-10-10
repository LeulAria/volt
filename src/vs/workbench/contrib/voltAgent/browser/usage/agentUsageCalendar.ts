/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { IVoltUsageSnapshot } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { formatCost, formatTokens } from './agentUsageFormat.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IUsageCalendarDay {
	/** Local midnight. */
	readonly start: number;
	readonly cost: number;
	readonly tokens: number;
	/** 0 is no usage; 1-4 are the quartiles of the active days, like GitHub's contribution graph. */
	readonly level: 0 | 1 | 2 | 3 | 4;
}

export interface IUsageCalendar {
	/** Week columns, Sunday first. Days before the history or after today are `undefined`. */
	readonly weeks: readonly (readonly (IUsageCalendarDay | undefined)[])[];
	readonly totalDays: number;
	readonly activeDays: number;
	readonly totalCost: number;
	/** Active days in a row ending today (or yesterday, when today has nothing yet). */
	readonly currentStreak: number;
	readonly longestStreak: number;
	readonly busiest?: IUsageCalendarDay;
	/** The weekday (0 = Sunday) and hour with the most spend over the whole history. */
	readonly peak?: { readonly weekday: number; readonly hour: number };
}

function localMidnight(ms: number): number {
	const date = new Date(ms);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The next local midnight; DST days are 23 or 25 hours, so step by calendar date, not 24h. */
function nextDay(midnight: number): number {
	const date = new Date(midnight);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** Every day of the usage history, laid out as GitHub's contribution calendar. */
export function usageCalendar(snapshot: IVoltUsageSnapshot, now: number): IUsageCalendar {
	// The snapshot reaches one extra day back so the oldest day is whole; start the day after it.
	const first = nextDay(localMidnight(snapshot.sinceMs));
	const today = localMidnight(now);
	const byDay = new Map<number, { cost: number; tokens: number }>();
	const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
	for (const bucket of snapshot.buckets) {
		const day = localMidnight(bucket.hour);
		const entry = byDay.get(day) ?? { cost: 0, tokens: 0 };
		entry.cost += bucket.costUsd;
		entry.tokens += bucket.uncached + bucket.cached + bucket.cacheWrite + bucket.output;
		byDay.set(day, entry);
		const date = new Date(bucket.hour);
		hours[date.getDay()][date.getHours()] += bucket.costUsd;
	}

	const days: { start: number; cost: number; tokens: number }[] = [];
	for (let day = first; day <= today; day = nextDay(day)) {
		const entry = byDay.get(day);
		days.push({ start: day, cost: entry?.cost ?? 0, tokens: entry?.tokens ?? 0 });
	}
	// Quartiles of the active days: one huge day must not wash every other day out to level 1.
	const active = days.filter(day => day.tokens > 0).map(day => day.cost).sort((a, b) => a - b);
	const quartile = (q: number) => active.length ? active[Math.floor(q * (active.length - 1))] : 0;
	const cuts = [quartile(0.25), quartile(0.5), quartile(0.75)];
	const levelOf = (day: { cost: number; tokens: number }): IUsageCalendarDay['level'] => {
		if (day.tokens <= 0) {
			return 0;
		}
		return day.cost <= cuts[0] ? 1 : day.cost <= cuts[1] ? 2 : day.cost <= cuts[2] ? 3 : 4;
	};
	const calendarDays: IUsageCalendarDay[] = days.map(day => ({ ...day, level: levelOf(day) }));

	const weeks: (IUsageCalendarDay | undefined)[][] = [];
	let week: (IUsageCalendarDay | undefined)[] = Array(new Date(first).getDay()).fill(undefined);
	for (const day of calendarDays) {
		week.push(day);
		if (week.length === 7) {
			weeks.push(week);
			week = [];
		}
	}
	if (week.length) {
		weeks.push([...week, ...Array(7 - week.length).fill(undefined)]);
	}

	let longestStreak = 0;
	let run = 0;
	for (const day of calendarDays) {
		run = day.level ? run + 1 : 0;
		longestStreak = Math.max(longestStreak, run);
	}
	let currentStreak = 0;
	let at = calendarDays.length - 1;
	if (at >= 0 && !calendarDays[at].level) {
		at--;
	}
	for (; at >= 0 && calendarDays[at].level; at--) {
		currentStreak++;
	}

	let busiest: IUsageCalendarDay | undefined;
	for (const day of calendarDays) {
		if (day.level && (!busiest || day.cost > busiest.cost)) {
			busiest = day;
		}
	}
	let peak: IUsageCalendar['peak'];
	hours.forEach((line, weekday) => line.forEach((value, hour) => {
		if (value > 0 && (!peak || value > hours[peak.weekday][peak.hour])) {
			peak = { weekday, hour };
		}
	}));

	return {
		weeks,
		totalDays: calendarDays.length,
		activeDays: active.length,
		totalCost: calendarDays.reduce((sum, day) => sum + day.cost, 0),
		currentStreak,
		longestStreak,
		busiest,
		peak,
	};
}

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const monthName = new Intl.DateTimeFormat(undefined, { month: 'short' });

function weekdayName(day: number, long: boolean): string {
	// 2023-01-01 was a Sunday.
	return new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday: long ? 'long' : 'short' });
}

function hourName(hour: number): string {
	return new Date(2023, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' }).replace(/\s/g, '').toLowerCase();
}

function streakText(days: number): string {
	return days === 1 ? localize('voltUsage.calendar.oneDay', "1 day") : localize('voltUsage.calendar.days', "{0} days", days);
}

/**
 * The Activity card, laid out like GitHub's contribution graph: one square per day, weeks as
 * columns, month names along the top, four greens by quartile, Less/More underneath. Streaks,
 * the busiest day and the busiest hour sit beside it.
 */
export function renderUsageCalendar(parent: HTMLElement, calendar: IUsageCalendar, animate: boolean): HTMLElement {
	const card = append(parent, $('.volt-usage-calendar'));
	const head = append(card, $('.volt-usage-calendar-head'));
	append(head, $('span.title')).textContent = calendar.activeDays === 1
		? localize('voltUsage.calendar.titleOne', "1 active day in the last {0} days", calendar.totalDays)
		: localize('voltUsage.calendar.title', "{0} active days in the last {1} days", calendar.activeDays, calendar.totalDays);
	append(head, $('span.total')).textContent = localize('voltUsage.calendar.total', "{0} at API prices", formatCost(calendar.totalCost));

	const body = append(card, $('.volt-usage-calendar-body'));
	const graph = append(body, $('.volt-usage-calendar-graph'));
	graph.style.setProperty('--volt-usage-weeks', String(calendar.weeks.length));

	// Month names over the first full week that starts in each month, as GitHub places them.
	const months = append(graph, $('.months'));
	let lastMonth = -1;
	let lastLabel = -Infinity;
	calendar.weeks.forEach((week, column) => {
		const firstDay = week.find(day => day);
		if (!firstDay) {
			return;
		}
		const month = new Date(firstDay.start).getMonth();
		if (month !== lastMonth) {
			lastMonth = month;
			// A name needs about three columns; skip one that would run into the previous name.
			if (column - lastLabel >= 3) {
				lastLabel = column;
				const label = append(months, $('span'));
				label.style.gridColumn = String(column + 1);
				label.textContent = monthName.format(firstDay.start);
			}
		}
	});

	const labels = append(graph, $('.weekdays'));
	for (let weekday = 0; weekday < 7; weekday++) {
		// Mon, Wed and Fri, like GitHub; the other rows stay unlabeled.
		append(labels, $('span')).textContent = weekday % 2 === 1 ? weekdayName(weekday, false) : '';
	}

	const cells = append(graph, $('.cells'));
	cells.setAttribute('role', 'grid');
	calendar.weeks.forEach((week, column) => {
		week.forEach((day, row) => {
			const cell = append(cells, $('span.cell'));
			cell.style.gridColumn = String(column + 1);
			cell.style.gridRow = String(row + 1);
			if (!day) {
				cell.classList.add('outside');
				return;
			}
			cell.dataset.level = String(day.level);
			cell.classList.toggle('animate', animate);
			cell.style.setProperty('--volt-usage-col', String(column));
			const date = longDay.format(day.start);
			const text = day.tokens > 0
				? localize('voltUsage.calendar.cell', "{0} · {1} tokens on {2}", formatCost(day.cost), formatTokens(day.tokens), date)
				: localize('voltUsage.calendar.cellEmpty', "No usage on {0}", date);
			cell.setAttribute('aria-label', text);
			setAgentTooltip(cell, text);
		});
	});

	const stats = append(body, $('.volt-usage-calendar-stats'));
	const stat = (label: string, value: string, detail?: string) => {
		const item = append(stats, $('.stat'));
		append(item, $('.label')).textContent = label;
		append(item, $('.value')).textContent = value;
		if (detail) {
			append(item, $('.detail')).textContent = detail;
		}
	};
	stat(localize('voltUsage.calendar.current', "Current streak"), streakText(calendar.currentStreak));
	stat(localize('voltUsage.calendar.longest', "Longest streak"), streakText(calendar.longestStreak));
	if (calendar.busiest) {
		stat(localize('voltUsage.calendar.busiest', "Busiest day"), formatCost(calendar.busiest.cost), shortDay.format(calendar.busiest.start));
	}
	if (calendar.peak) {
		stat(localize('voltUsage.calendar.peak', "Busiest hour"), localize('voltUsage.calendar.peakValue', "{0} around {1}", weekdayName(calendar.peak.weekday, false), hourName(calendar.peak.hour)), localize('voltUsage.calendar.peakDetail', "in your time zone"));
	}

	const foot = append(card, $('.volt-usage-calendar-foot'));
	append(foot, $('span.note')).textContent = localize('voltUsage.calendar.note', "Spend per day in your time zone.");
	const legend = append(foot, $('span.legend'));
	append(legend, $('span')).textContent = localize('voltUsage.calendar.less', "Less");
	for (let level = 0; level <= 4; level++) {
		append(legend, $('span.cell')).dataset.level = String(level);
	}
	append(legend, $('span')).textContent = localize('voltUsage.calendar.more', "More");
	return card;
}
