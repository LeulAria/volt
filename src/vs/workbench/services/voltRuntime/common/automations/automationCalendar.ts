/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cronDaysBetween, cronRunsOn, formatSimpleCron, parseCron, simpleCronParts } from './automationCron.js';
import { AutomationSchedule, describeSchedule, IAutomation, IAutomationRun, IAutomationTrigger, isActiveRun, nextScheduleAt } from './automations.js';
import { wallClock } from './automationTime.js';
import { AutomationProvider, eventLabel } from './automationTriggers.js';

/**
 * The automations calendar: what will run (each schedule trigger's coming occurrences) and what
 * ran (runs), for one visible range in local time. A run that serves an occurrence's slot takes
 * its place. A schedule that runs more than `dense` times in a day (every 5 minutes) becomes one
 * band for that day ("Every 5 minutes · 288 runs") instead of hundreds of events, and is counted
 * without being listed: intervals by arithmetic, cron by its matching days. Pure.
 */

/** More runs than this in one day collapse into a band (the week and day views). */
export const CALENDAR_DENSE_PER_DAY = 24;
/** Occurrences one trigger may add to a range (bands do not count). */
export const CALENDAR_TRIGGER_CAP = 400;

export type CalendarEntryKind = 'occurrence' | 'run' | 'band';
export type CalendarEntryStatus = 'upcoming' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface IAutomationCalendarEntry {
	/** Stable across redraws: kind, automation, trigger or run, and time or day. */
	readonly id: string;
	readonly kind: CalendarEntryKind;
	readonly automationId: string;
	readonly name: string;
	readonly triggerId?: string;
	readonly provider: AutomationProvider | 'manual';
	/** Epoch ms. A band's is its first run that day. */
	readonly start: number;
	/** When a run finished (or now, while it runs); `start` for occurrences and bands. */
	readonly end: number;
	/** Local midnight of the day it is drawn on. */
	readonly day: number;
	readonly status: CalendarEntryStatus;
	/** The automation is off: this is when its schedule would run. */
	readonly disabled: boolean;
	/** "Every day at 09:00", "Pull request opened". */
	readonly label: string;
	/** The trigger's schedule and zone (occurrences and schedule bands), for moving it. */
	readonly schedule?: AutomationSchedule;
	readonly timezone?: string;
	readonly runId?: string;
	readonly threadId?: string;
	readonly error?: string;
	/** Bands: runs that day (done and to come), and how many succeeded, failed, run now. */
	readonly count?: number;
	readonly succeeded?: number;
	readonly failed?: number;
	readonly running?: number;
}

export interface ICalendarRange {
	/** Local midnight of the first day shown. */
	readonly from: number;
	/** Local midnight after the last day shown. */
	readonly to: number;
	readonly now: number;
	readonly dense?: number;
	readonly cap?: number;
}

/** Local midnight of the day `at` falls on. */
export function localDayOf(at: number): number {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The local midnights of [from, to). */
export function localDays(from: number, to: number): number[] {
	const days: number[] = [];
	const start = new Date(localDayOf(from));
	for (let offset = 0; offset < 400; offset++) {
		const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset).getTime();
		if (day >= to) {
			break;
		}
		days.push(day);
	}
	return days;
}

function nextLocalDay(day: number): number {
	const date = new Date(day);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

export function runStatusOf(run: Pick<IAutomationRun, 'status'>): CalendarEntryStatus {
	switch (run.status) {
		case 'queued':
		case 'running': return 'running';
		case 'succeeded': return 'succeeded';
		case 'skipped': return 'skipped';
		default: return 'failed';
	}
}

interface IBand {
	readonly key: string;
	readonly automation: IAutomation;
	readonly trigger: IAutomationTrigger | undefined;
	readonly provider: AutomationProvider | 'manual';
	readonly label: string;
	readonly day: number;
	start: number;
	count: number;
	succeeded: number;
	failed: number;
	running: number;
}

/** Everything the range shows, sorted by time (then name and id). */
export function expandCalendar(automations: readonly IAutomation[], range: ICalendarRange): IAutomationCalendarEntry[] {
	const out: IAutomationCalendarEntry[] = [];
	for (const automation of automations) {
		expandAutomation(automation, range, out);
	}
	return out.sort(compareEntries);
}

function compareEntries(a: IAutomationCalendarEntry, b: IAutomationCalendarEntry): number {
	return a.start - b.start || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function expandAutomation(automation: IAutomation, range: ICalendarRange, out: IAutomationCalendarEntry[]): void {
	const dense = range.dense ?? CALENDAR_DENSE_PER_DAY;
	const bands = new Map<string, IBand>();
	const entries: IAutomationCalendarEntry[] = [];
	const slots = new Map<string, number>();
	const disabled = !automation.enabled;

	for (const trigger of automation.triggers) {
		if (trigger.provider !== 'schedule' || !trigger.schedule) {
			continue;
		}
		const spec = trigger.schedule;
		const label = describeSchedule(spec, trigger.timezone, range.now);
		const band = (day: number, count: number, start: number) => {
			const key = `${trigger.id}:${day}`;
			const existing = bands.get(key);
			if (existing) {
				existing.count += count;
				existing.start = Math.min(existing.start, start);
			} else {
				bands.set(key, { key, automation, trigger, provider: 'schedule', label, day, start, count, succeeded: 0, failed: 0, running: 0 });
			}
		};
		const occurrence = (start: number) => {
			slots.set(`${trigger.id}:${start}`, entries.length);
			entries.push({
				id: `o:${automation.id}:${trigger.id}:${start}`, kind: 'occurrence', automationId: automation.id, name: automation.name, triggerId: trigger.id,
				provider: 'schedule', start, end: start, day: localDayOf(start), status: 'upcoming', disabled, label, schedule: spec,
				...(trigger.timezone ? { timezone: trigger.timezone } : {}),
			});
		};
		expandTrigger(automation, trigger, range, dense, occurrence, band);
	}

	// Runs: into their schedule's band, in place of the occurrence they served, or on their own.
	const loose = new Map<string, IAutomationCalendarEntry[]>();
	for (const run of automation.runs) {
		if (run.at < range.from || run.at >= range.to) {
			continue;
		}
		const day = localDayOf(run.at);
		const band = run.triggerId ? bands.get(`${run.triggerId}:${day}`) : undefined;
		if (band) {
			absorb(band, run);
			continue;
		}
		const entry = runEntry(automation, run, day, range.now);
		const slot = run.triggerId && run.slotAt !== undefined ? slots.get(`${run.triggerId}:${run.slotAt}`) : undefined;
		if (slot !== undefined) {
			entries[slot] = entry;
			continue;
		}
		const key = `${run.triggerId ?? run.provider}:${day}`;
		let group = loose.get(key);
		if (!group) {
			group = [];
			loose.set(key, group);
		}
		group.push(entry);
	}
	// A day with a storm of event runs (fifty pushes) shows as one band too.
	for (const [key, group] of loose) {
		if (group.length <= dense) {
			entries.push(...group);
			continue;
		}
		const first = group[0];
		const trigger = first.triggerId ? automation.triggers.find(entry => entry.id === first.triggerId) : undefined;
		const band: IBand = {
			key, automation, trigger, provider: first.provider, day: first.day, start: first.start, count: 0, succeeded: 0, failed: 0, running: 0,
			label: trigger?.schedule ? describeSchedule(trigger.schedule, trigger.timezone, range.now) : trigger ? eventLabel(trigger.provider, trigger.event) : first.label,
		};
		for (const entry of group) {
			band.start = Math.min(band.start, entry.start);
			band.count++;
			band.succeeded += entry.status === 'succeeded' ? 1 : 0;
			band.failed += entry.status === 'failed' ? 1 : 0;
			band.running += entry.status === 'running' ? 1 : 0;
		}
		bands.set(key, band);
	}
	out.push(...entries);
	for (const band of bands.values()) {
		out.push(bandEntry(band, disabled));
	}
}

function absorb(band: IBand, run: IAutomationRun): void {
	const status = runStatusOf(run);
	band.count++;
	band.start = Math.min(band.start, run.at);
	band.succeeded += status === 'succeeded' ? 1 : 0;
	band.failed += status === 'failed' ? 1 : 0;
	band.running += status === 'running' ? 1 : 0;
}

function bandEntry(band: IBand, disabled: boolean): IAutomationCalendarEntry {
	const status: CalendarEntryStatus = band.running ? 'running' : band.failed ? 'failed' : band.succeeded && band.succeeded === band.count ? 'succeeded' : 'upcoming';
	return {
		id: `b:${band.automation.id}:${band.key}`, kind: 'band', automationId: band.automation.id, name: band.automation.name,
		...(band.trigger ? { triggerId: band.trigger.id } : {}),
		provider: band.provider, start: band.start, end: band.start, day: band.day, status, disabled, label: band.label,
		...(band.trigger?.schedule ? { schedule: band.trigger.schedule } : {}),
		...(band.trigger?.timezone ? { timezone: band.trigger.timezone } : {}),
		count: band.count, succeeded: band.succeeded, failed: band.failed, running: band.running,
	};
}

function runEntry(automation: IAutomation, run: IAutomationRun, day: number, now: number): IAutomationCalendarEntry {
	const trigger = run.triggerId ? automation.triggers.find(entry => entry.id === run.triggerId) : undefined;
	return {
		id: `r:${automation.id}:${run.id}`, kind: 'run', automationId: automation.id, name: automation.name,
		...(run.triggerId ? { triggerId: run.triggerId } : {}),
		provider: run.provider, start: run.at, end: run.finishedAt ?? (isActiveRun(run) ? Math.max(run.at, now) : run.at), day,
		status: runStatusOf(run), disabled: !automation.enabled, label: run.label, runId: run.id,
		...(trigger?.schedule ? { schedule: trigger.schedule } : {}),
		...(run.threadId ? { threadId: run.threadId } : {}),
		...(run.error ? { error: run.error } : {}),
	};
}

/**
 * One schedule trigger's occurrences in the range. The first is the automation's planned next
 * run (when on; a slot a moment overdue still shows), the rest follow from the schedule. Days
 * with more than `dense` runs go to `band` with their count, never listed.
 */
function expandTrigger(automation: IAutomation, trigger: IAutomationTrigger, range: ICalendarRange, dense: number, occurrence: (start: number) => void, band: (day: number, count: number, start: number) => void): void {
	const spec = trigger.schedule!;
	const zone = trigger.timezone;
	const planned = automation.enabled ? automation.nextRuns[trigger.id] : undefined;
	// An automation that is on keeps its plan; one that is off shows what it would do from now. A one-time run with no plan already ran.
	const first = planned ?? (automation.enabled && spec.type === 'once' ? undefined : nextScheduleAt(spec, range.now, zone));
	if (first === undefined || first >= range.to) {
		return;
	}
	const cap = range.cap ?? CALENDAR_TRIGGER_CAP;
	let listed = 0;
	const emit = (at: number) => {
		if (at >= range.from && at < range.to && listed < cap) {
			listed++;
			occurrence(at);
		}
	};
	// A slot already due (the clock has not fired yet) shows once; the schedule goes on from now.
	const overdue = first <= range.now;
	if (overdue) {
		emit(first);
	}
	const base = overdue ? nextScheduleAt(spec, range.now, zone) : first;
	if (base === undefined || spec.type === 'once') {
		if (!overdue && base !== undefined) {
			emit(base);
		}
		return;
	}
	const lo = Math.max(range.from, base);
	if (spec.type === 'interval' || spec.type === 'hourly') {
		expandArithmetic(base, spec.type === 'interval' ? spec.everyMs : 3_600_000, lo, range.to, dense, emit, band);
		return;
	}
	if (spec.type === 'cron') {
		const parsed = parseCron(spec.expr).schedule;
		if (!parsed) {
			return;
		}
		const clock = wallClock(zone);
		for (const day of cronDaysBetween(parsed, lo, range.to, zone)) {
			if (day.count > dense) {
				// Counted, not listed: the runs left that day from `lo` on, by hour and minute.
				const since = clock.parts(lo);
				const opens = clock.parts(Math.max(lo, clock.epoch(day.year, day.month, day.day, 0, 0)));
				const sameDay = opens.year === since.year && opens.month === since.month && opens.day === since.day;
				let count = day.count;
				if (sameDay) {
					count = 0;
					for (const hour of parsed.hours) {
						count += hour > since.hour ? parsed.minutes.length : hour === since.hour ? parsed.minutes.filter(minute => minute >= since.minute).length : 0;
					}
				}
				const start = cronRunsOn(parsed, day, lo, range.to, zone, 1)[0];
				if (count > 0 && start !== undefined) {
					band(localDayOf(start), count, start);
				}
				continue;
			}
			for (const at of cronRunsOn(parsed, day, lo, range.to, zone)) {
				emit(at);
			}
		}
		return;
	}
	// Daily and weekly: at most one a day.
	let at: number | undefined = base < lo ? nextScheduleAt(spec, lo - 1, zone) : base;
	for (let guard = 0; at !== undefined && at < range.to && guard < 400; guard++) {
		emit(at);
		at = nextScheduleAt(spec, at, zone);
	}
}

/** `base + k × step` (k >= 0) in [lo, to): counted per day by arithmetic; sparse days listed. */
function expandArithmetic(base: number, step: number, lo: number, to: number, dense: number, emit: (at: number) => void, band: (day: number, count: number, start: number) => void): void {
	if (step <= 0) {
		return;
	}
	for (let day = localDayOf(lo); day < to; day = nextLocalDay(day)) {
		const from = Math.max(day, lo);
		const until = Math.min(nextLocalDay(day), to);
		if (from >= until) {
			continue;
		}
		const firstK = Math.max(0, Math.ceil((from - base) / step));
		const lastK = Math.ceil((until - base) / step) - 1;
		const count = lastK - firstK + 1;
		if (count <= 0) {
			continue;
		}
		if (count > dense) {
			band(day, count, base + firstK * step);
			continue;
		}
		for (let k = firstK; k <= lastK; k++) {
			emit(base + k * step);
		}
	}
}

/**
 * Why an entry cannot be dragged to another slot, or undefined when it can. `acrossDays`: the
 * drop changes the day only (the month view), which a daily or hourly schedule has no say in.
 */
export type CalendarMoveBlock = 'run' | 'band' | 'interval' | 'cron' | 'everyDay';

export function moveBlocker(entry: Pick<IAutomationCalendarEntry, 'kind' | 'schedule'>, acrossDays: boolean): CalendarMoveBlock | undefined {
	if (entry.kind === 'run') {
		return 'run';
	}
	if (entry.kind === 'band') {
		return 'band';
	}
	switch (entry.schedule?.type) {
		case 'once':
		case 'weekly': return undefined;
		case 'daily':
		case 'hourly': return acrossDays ? 'everyDay' : undefined;
		case 'cron': {
			const parts = simpleCronParts(entry.schedule.expr);
			return !parts ? 'cron' : acrossDays && !parts.weekdays ? 'everyDay' : undefined;
		}
		default: return 'interval';
	}
}

/**
 * The schedule after dragging the occurrence at `from` to `to`, read in the trigger's zone: a
 * one-time run moves; a daily one takes the new time; an hourly one the new minute; a weekly one
 * (and a plain `m h * * dow` cron) swaps the dragged weekday for the new one and takes the time.
 * Undefined when it cannot move or nothing changes.
 */
export function movedSchedule(spec: AutomationSchedule, zone: string | undefined, from: number, to: number): AutomationSchedule | undefined {
	const clock = wallClock(zone);
	const source = clock.parts(from);
	const target = clock.parts(to);
	const time = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`;
	const swapDay = (days: readonly number[]) => [...new Set([...days.filter(day => day !== source.weekday), target.weekday])].sort((a, b) => a - b);
	let moved: AutomationSchedule | undefined;
	switch (spec.type) {
		case 'once': moved = { type: 'once', at: to }; break;
		case 'daily': moved = { type: 'daily', time }; break;
		case 'hourly': moved = { type: 'hourly', minute: target.minute }; break;
		case 'weekly': moved = { type: 'weekly', weekdays: swapDay(spec.weekdays), time }; break;
		case 'cron': {
			const parts = simpleCronParts(spec.expr);
			moved = parts ? { type: 'cron', expr: formatSimpleCron(target.minute, target.hour, parts.weekdays ? swapDay(parts.weekdays) : undefined) } : undefined;
			break;
		}
	}
	return moved && JSON.stringify(moved) !== JSON.stringify(spec) ? moved : undefined;
}

export interface ILaneLayout<T> {
	readonly entry: T;
	/** 0-based column within its group of overlapping entries. */
	readonly lane: number;
	/** Columns the group needs: the entry is 1/lanes wide. */
	readonly lanes: number;
}

/**
 * Side-by-side columns for timed entries that overlap (the week and day views). `endOf` is how
 * far an entry reaches when drawn (at least its minimum height). Entries that overlap, directly
 * or through others, share one lane count; each takes the first free lane.
 */
export function layoutLanes<T extends { readonly start: number }>(entries: readonly T[], endOf: (entry: T) => number): ILaneLayout<T>[] {
	const sorted = [...entries].sort((a, b) => a.start - b.start || endOf(b) - endOf(a));
	const out: { entry: T; lane: number; lanes: number }[] = [];
	let group: { entry: T; lane: number; lanes: number }[] = [];
	let laneEnds: number[] = [];
	let groupEnd = Number.NEGATIVE_INFINITY;
	const close = () => {
		for (const item of group) {
			item.lanes = laneEnds.length;
		}
		out.push(...group);
		group = [];
		laneEnds = [];
	};
	for (const entry of sorted) {
		if (entry.start >= groupEnd && group.length) {
			close();
		}
		const end = Math.max(endOf(entry), entry.start + 1);
		let lane = laneEnds.findIndex(laneEnd => laneEnd <= entry.start);
		if (lane < 0) {
			lane = laneEnds.length;
			laneEnds.push(end);
		} else {
			laneEnds[lane] = end;
		}
		group.push({ entry, lane, lanes: 1 });
		groupEnd = group.length === 1 ? end : Math.max(groupEnd, end);
	}
	if (group.length) {
		close();
	}
	return out;
}

//#region Day slots (the Day, Week and Month views)

/*
 * The Day, Week and Month views draw per day: the schedule slots still ahead and the runs that
 * happened. Slots are computed per day straight from the schedule (the scheduler's own next-run
 * steps, a cron's matching day, an interval's arithmetic), never by walking minute after minute,
 * so a month of an every-minute automation costs as much as its slot count, and a day can be capped.
 * Times are read in each trigger's zone and placed on local days.
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
 * A schedule's slots on the local day starting at `dayStart`, in order, after `after` (slots before
 * it are skipped, not counted), at most `cap`. `anchor` places an interval: one of its runs (the
 * next one planned), from which every slot is a whole number of intervals away. `zone` is the
 * trigger's IANA zone; a wall time skipped by daylight saving moves forward, as the scheduler does.
 */
export function scheduleSlotsOnDay(spec: AutomationSchedule, dayStart: number, cap: number, anchor?: number, after = Number.NEGATIVE_INFINITY, zone?: string): number[] {
	const dayEnd = nextLocalDay(dayStart);
	const from = Math.max(dayStart, after + 1);
	const out: number[] = [];
	if (from >= dayEnd || cap <= 0) {
		return out;
	}
	switch (spec.type) {
		case 'once':
			return spec.at >= from && spec.at < dayEnd ? [spec.at] : out;
		case 'interval': {
			if (spec.everyMs < 60_000) {
				return out;
			}
			const base = anchor ?? dayStart;
			const steps = Math.ceil((from - base) / spec.everyMs);
			for (let value = base + steps * spec.everyMs; value < dayEnd && out.length < cap; value += spec.everyMs) {
				out.push(value);
			}
			return out;
		}
		case 'cron': {
			const parsed = parseCron(spec.expr).schedule;
			if (!parsed) {
				return out;
			}
			for (const day of cronDaysBetween(parsed, from, dayEnd, zone)) {
				out.push(...cronRunsOn(parsed, day, from, dayEnd, zone, cap - out.length));
				if (out.length >= cap) {
					break;
				}
			}
			return out;
		}
		default: {
			// Hourly, daily and weekly: at most 25 steps of the scheduler's own next run.
			for (let value = nextScheduleAt(spec, from - 1, zone); value !== undefined && value < dayEnd && out.length < cap; value = nextScheduleAt(spec, value, zone)) {
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
		case 'once': return Number.POSITIVE_INFINITY;
		case 'hourly': return HOUR;
		case 'daily': return 24 * HOUR;
		case 'weekly': return 7 / Math.max(1, Math.min(7, spec.weekdays.length || 7)) * 24 * HOUR;
		case 'cron': {
			const parsed = parseCron(spec.expr).schedule;
			if (!parsed) {
				return 24 * HOUR;
			}
			const start = localDayOf(Date.now());
			const days = cronDaysBetween(parsed, start, start + 28 * 24 * HOUR).length;
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

function scheduleTriggersOf(automation: IAutomation): IAutomationTrigger[] {
	return automation.triggers.filter(trigger => trigger.provider === 'schedule' && !!trigger.schedule);
}

/** An interval's anchor: the planned next run of an automation that is on, else one interval from now (as it would once switched on). */
function intervalAnchor(automation: IAutomation, trigger: IAutomationTrigger, now: number): number | undefined {
	const spec = trigger.schedule!;
	return spec.type === 'interval' ? (automation.enabled ? automation.nextRuns[trigger.id] : undefined) ?? now + spec.everyMs : undefined;
}

/** A one-time run of an automation that is on and has no plan left already ran: nothing to draw ahead. */
function ranOnce(automation: IAutomation, trigger: IAutomationTrigger): boolean {
	return trigger.schedule?.type === 'once' && automation.enabled && automation.nextRuns[trigger.id] === undefined;
}

/**
 * Every automation's schedule slots on one day that are still ahead of `now`. Inactive
 * automations are included (the view greys them); an interval of an inactive automation counts
 * from `now`, as it would once switched on.
 */
export function daySlots(automations: readonly IAutomation[], dayStart: number, now: number): ICalendarDaySlots {
	const slots: ICalendarSlot[] = [];
	const repeats: ICalendarRepeat[] = [];
	if (nextLocalDay(dayStart) <= now) {
		return { slots, repeats };
	}
	for (const automation of automations) {
		for (const trigger of scheduleTriggersOf(automation)) {
			if (ranOnce(automation, trigger)) {
				continue;
			}
			const spec = trigger.schedule!;
			const anchor = intervalAnchor(automation, trigger, now);
			// One more than the frequent cut tells "repeats" from "a few"; the count of a repeating one is worked out below.
			const found = scheduleSlotsOnDay(spec, dayStart, CALENDAR_FREQUENT_PER_DAY + 1, anchor, now, trigger.timezone);
			if (!found.length) {
				continue;
			}
			if (found.length <= CALENDAR_FREQUENT_PER_DAY) {
				for (const at of found) {
					slots.push({ automationId: automation.id, triggerId: trigger.id, at });
				}
				continue;
			}
			repeats.push({ automationId: automation.id, triggerId: trigger.id, count: countSlotsOnDay(spec, dayStart, anchor, now, trigger.timezone), first: found[0], every: scheduleCadence(spec) });
		}
	}
	slots.sort((a, b) => a.at - b.at);
	return { slots, repeats };
}

/** How many slots a repeating schedule has on a day, counted without listing them where the arithmetic allows. */
function countSlotsOnDay(spec: AutomationSchedule, dayStart: number, anchor: number | undefined, after: number, zone: string | undefined): number {
	const dayEnd = nextLocalDay(dayStart);
	const from = Math.max(dayStart, after + 1);
	if (spec.type === 'interval' && spec.everyMs >= 60_000) {
		const base = anchor ?? dayStart;
		return Math.max(0, Math.ceil((dayEnd - base) / spec.everyMs) - Math.ceil((from - base) / spec.everyMs));
	}
	return scheduleSlotsOnDay(spec, dayStart, 1440, anchor, after, zone).length;
}

/** Every slot of one trigger on a day, ahead of `now` (for drawing a repeating trigger's dots). */
export function triggerSlotsOnDay(automation: IAutomation, triggerId: string, dayStart: number, now: number, cap = 1440): number[] {
	const trigger = automation.triggers.find(entry => entry.id === triggerId);
	if (!trigger?.schedule || ranOnce(automation, trigger)) {
		return [];
	}
	return scheduleSlotsOnDay(trigger.schedule, dayStart, cap, intervalAnchor(automation, trigger, now), now, trigger.timezone);
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
	let groupEnd = Number.NEGATIVE_INFINITY;
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
			groupEnd = Number.NEGATIVE_INFINITY;
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

//#endregion
