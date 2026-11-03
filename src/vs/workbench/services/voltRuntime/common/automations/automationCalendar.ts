/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cronSlotsOnDay, parseCron } from './automationCron.js';
import { AutomationSchedule, IAutomation, IAutomationRun, IAutomationTrigger, isActiveRun, parseTimeOfDay } from './automations.js';

/**
 * What the Automations calendar draws: the schedule slots still ahead in a range of days, and the
 * runs that happened in it. Slots are computed per day straight from the schedule (an hour list, a
 * cron day match, an interval's arithmetic), never by walking minute after minute, so a month of
 * an every-minute automation costs as much as its slot count, and a day can be capped.
 */

const HOUR = 3_600_000;

/** More slots than this in a day: the trigger repeats, and views draw it as one band, not blocks. */
export const CALENDAR_FREQUENT_PER_DAY = 12;

export interface ICalendarSlot {
	readonly automationId: string;
	readonly triggerId: string;
	readonly at: number;
}

export interface ICalendarDaySlots {
	/** Slots of the triggers that fire at most `CALENDAR_FREQUENT_PER_DAY` times on the day. */
	readonly slots: readonly ICalendarSlot[];
	/** Triggers that fire more often: how many times on the day (after `now` on today), and the first. */
	readonly repeats: readonly ICalendarRepeat[];
}

export interface ICalendarRepeat {
	readonly automationId: string;
	readonly triggerId: string;
	readonly count: number;
	readonly first: number;
	/** Typical gap between two slots, for drawing ticks. */
	readonly every: number;
}

export interface ICalendarRun {
	readonly automationId: string;
	readonly run: IAutomationRun;
	/** When it was triggered. */
	readonly at: number;
	readonly startedAt: number;
	/** `now` while it is still going. */
	readonly endedAt: number;
}

/**
 * A schedule's local wall-clock slots on the day starting at `dayStart` (a local midnight), in
 * order, after `after` (slots before it are skipped, not counted), at most `cap`. `anchor` places
 * an interval: one of its runs (the next one planned), from which every slot is a whole number of
 * intervals away.
 */
export function scheduleSlotsOnDay(spec: AutomationSchedule, dayStart: number, cap: number, anchor?: number, after = -Infinity): number[] {
	const day = new Date(dayStart);
	const at = (hour: number, minute: number): number | undefined => {
		const value = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
		// A wall-clock time skipped by daylight saving does not happen that day.
		return value.getHours() === hour ? value.getTime() : undefined;
	};
	const out: number[] = [];
	const push = (value: number | undefined) => {
		if (value !== undefined && value > after && out.length < cap) {
			out.push(value);
		}
	};
	switch (spec.type) {
		case 'hourly':
			for (let hour = 0; hour < 24 && out.length < cap; hour++) {
				push(at(hour, spec.minute));
			}
			return out;
		case 'daily':
		case 'weekly': {
			const minutes = parseTimeOfDay(spec.time);
			if (minutes === undefined) {
				return out;
			}
			if (spec.type === 'weekly' && spec.weekdays.length && spec.weekdays.length < 7 && !spec.weekdays.includes(day.getDay())) {
				return out;
			}
			push(at(Math.floor(minutes / 60), minutes % 60));
			return out;
		}
		case 'cron': {
			const parsed = parseCron(spec.expr).schedule;
			return parsed ? cronSlotsOnDay(parsed, dayStart, cap, after) : out;
		}
		case 'interval': {
			if (spec.everyMs < 60_000) {
				return out;
			}
			const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
			const base = anchor ?? dayStart;
			const from = Math.max(dayStart, after + 1);
			const steps = Math.ceil((from - base) / spec.everyMs);
			for (let value = base + steps * spec.everyMs; value < dayEnd && out.length < cap; value += spec.everyMs) {
				out.push(value);
			}
			return out;
		}
	}
}

/** The typical gap between a schedule's slots. A cron is measured over four weeks, so a monthly one is not taken for a daily one. */
export function scheduleCadence(spec: AutomationSchedule): number {
	switch (spec.type) {
		case 'interval': return spec.everyMs;
		case 'hourly': return HOUR;
		case 'daily': return 24 * HOUR;
		case 'weekly': return 7 / Math.max(1, Math.min(7, spec.weekdays.length || 7)) * 24 * HOUR;
		case 'cron': {
			const parsed = parseCron(spec.expr).schedule;
			if (!parsed) {
				return 24 * HOUR;
			}
			const start = new Date();
			let days = 0;
			for (let offset = 0; offset < 28; offset++) {
				if (cronSlotsOnDay(parsed, new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset).getTime(), 1).length) {
					days++;
				}
			}
			const perDay = parsed.minutes.length * parsed.hours.length;
			return days ? Math.max(60_000, Math.round(28 * 24 * HOUR / (days * perDay))) : 28 * 24 * HOUR;
		}
	}
}

/** Runs about daily or more often (weekdays count): a calendar shows it as a mark, not as news. */
export function isRoutineSchedule(spec: AutomationSchedule): boolean {
	return scheduleCadence(spec) <= 1.5 * 24 * HOUR;
}

/** Fires more than `CALENDAR_FREQUENT_PER_DAY` times a day: views draw it as a band and count its runs. */
export function isFrequentSchedule(spec: AutomationSchedule): boolean {
	return scheduleCadence(spec) < 24 * HOUR / CALENDAR_FREQUENT_PER_DAY;
}

function scheduleTriggers(automation: IAutomation): IAutomationTrigger[] {
	return automation.triggers.filter(trigger => trigger.provider === 'schedule' && !!trigger.schedule);
}

/**
 * Every automation's schedule slots on one day that are still ahead of `now`. Inactive
 * automations are included (the view greys them); an interval of an inactive automation counts
 * from `now`, as it would once switched on.
 */
export function daySlots(automations: readonly IAutomation[], dayStart: number, now: number): ICalendarDaySlots {
	const slots: ICalendarSlot[] = [];
	const repeats: ICalendarRepeat[] = [];
	const nextDay = new Date(dayStart);
	nextDay.setDate(nextDay.getDate() + 1);
	if (nextDay.getTime() <= now) {
		return { slots, repeats };
	}
	for (const automation of automations) {
		for (const trigger of scheduleTriggers(automation)) {
			const spec = trigger.schedule!;
			const anchor = spec.type === 'interval' ? (automation.enabled ? automation.nextRuns[trigger.id] : undefined) ?? now + spec.everyMs : undefined;
			// One more than the frequent cut tells "repeats" from "a few"; the count of a repeating one is worked out below.
			const found = scheduleSlotsOnDay(spec, dayStart, CALENDAR_FREQUENT_PER_DAY + 1, anchor, now);
			if (!found.length) {
				continue;
			}
			if (found.length <= CALENDAR_FREQUENT_PER_DAY) {
				for (const at of found) {
					slots.push({ automationId: automation.id, triggerId: trigger.id, at });
				}
				continue;
			}
			const all = scheduleSlotsOnDay(spec, dayStart, 1440, anchor, now);
			repeats.push({ automationId: automation.id, triggerId: trigger.id, count: all.length, first: all[0], every: scheduleCadence(spec) });
		}
	}
	slots.sort((a, b) => a.at - b.at);
	return { slots, repeats };
}

/** Every slot of one trigger on a day, ahead of `now` (for drawing a repeating trigger's dots). */
export function triggerSlotsOnDay(automation: IAutomation, triggerId: string, dayStart: number, now: number, cap = 1440): number[] {
	const spec = automation.triggers.find(entry => entry.id === triggerId)?.schedule;
	if (!spec) {
		return [];
	}
	const anchor = spec.type === 'interval' ? (automation.enabled ? automation.nextRuns[triggerId] : undefined) ?? now + spec.everyMs : undefined;
	return scheduleSlotsOnDay(spec, dayStart, cap, anchor, now);
}

/** Runs that were triggered in [from, to), oldest first; a run still going ends at `now`. */
export function runsBetween(automations: readonly IAutomation[], from: number, to: number, now: number): ICalendarRun[] {
	const out: ICalendarRun[] = [];
	for (const automation of automations) {
		for (const run of automation.runs) {
			if (run.at < from || run.at >= to) {
				continue;
			}
			const startedAt = run.startedAt ?? run.at;
			const endedAt = isActiveRun(run) ? Math.max(now, startedAt) : run.finishedAt ?? startedAt;
			out.push({ automationId: automation.id, run, at: run.at, startedAt, endedAt });
		}
	}
	return out.sort((a, b) => a.at - b.at);
}

/** "#132" from a pull request URL (GitHub /pull/132, GitLab /merge_requests/132, Bitbucket /pull-requests/132). */
export function pullRequestNumber(detail: string | undefined): string | undefined {
	const match = detail ? /\/(?:pull|pulls|merge_requests|pull-requests)\/(\d+)/.exec(detail) ?? /(?:^|\s)#(\d+)\b/.exec(detail) : undefined;
	return match ? `#${match[1]}` : undefined;
}

/** A run's pull request, when it opened one: its number and URL. */
export function runPullRequest(run: IAutomationRun): { readonly label: string; readonly url?: string } | undefined {
	const tool = run.tools?.find(entry => entry.kind === 'pull_request' && entry.status !== 'failed' && entry.detail);
	const label = pullRequestNumber(tool?.detail);
	return tool && label ? { label, ...(/^https?:\/\//.test(tool.detail!) ? { url: tool.detail } : {}) } : undefined;
}

/**
 * Side-by-side columns for blocks in one day column, as calendars lay out overlapping events:
 * blocks that overlap share the width, and each block then widens to the right over the columns
 * that are free for its whole time. Returns, per block, its column, how many columns its group
 * has, and how many of them it spans.
 */
export function packColumns(blocks: readonly { readonly start: number; readonly end: number }[]): { readonly column: number; readonly columns: number; readonly span: number }[] {
	const order = blocks.map((block, index) => ({ ...block, index })).sort((a, b) => a.start - b.start || b.end - a.end);
	const result: { column: number; columns: number; span: number }[] = blocks.map(() => ({ column: 0, columns: 1, span: 1 }));
	let group: typeof order = [];
	let groupEnd = -Infinity;
	let ends: number[] = [];
	const close = () => {
		const columns = Math.max(1, ends.length);
		for (const block of group) {
			const placed = result[block.index];
			placed.columns = columns;
			let span = 1;
			for (let column = placed.column + 1; column < columns; column++) {
				if (group.some(other => result[other.index].column === column && other.start < block.end && block.start < other.end)) {
					break;
				}
				span++;
			}
			placed.span = span;
		}
		group = [];
		ends = [];
	};
	for (const block of order) {
		if (block.start >= groupEnd) {
			close();
			groupEnd = -Infinity;
		}
		let column = ends.findIndex(end => end <= block.start);
		if (column === -1) {
			column = ends.length;
			ends.push(block.end);
		} else {
			ends[column] = block.end;
		}
		result[block.index].column = column;
		group.push(block);
		groupEnd = Math.max(groupEnd, block.end);
	}
	close();
	return result;
}
