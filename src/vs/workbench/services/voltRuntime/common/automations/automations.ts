/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { describeCron, nextCronRun, parseCron } from './automationCron.js';
import { civilDay, formatGmtOffset, isLocalTimeZone, timeZoneLabel, wallClock } from './automationTime.js';
import { AUTOMATION_PROVIDERS, AutomationProvider, AutomationTriggerGroup, eventLabel, triggerGroupOf } from './automationTriggers.js';
import { IAgentWebhookTrigger, parseWebhookTrigger } from './automationWebhooks.js';

/**
 * Automations: an agent with instructions, a repository, a model and tools, started by triggers
 * (a clock, or an event from GitHub, Slack, Teams, Sentry, Linear, PagerDuty or any webhook).
 * Each run goes through the orchestrator into a new chat in the repository, is tracked until its
 * turn settles (running, succeeded, failed, stopped), and records the tools it used.
 *
 * Built on T3 Code's webhook-triggered scheduled tasks (secret URLs, HMAC, relay holding while
 * offline, delivery ids against double runs), widened to Cursor's automations: many triggers per
 * automation, provider events instead of raw payloads, tools and memory. Everything here is pure;
 * the clock, the store, the relay and the orchestrator live in the services.
 */

export const AUTOMATIONS_STATE_VERSION = 1;

/** Runs kept per automation (skipped ones have their own, smaller budget so noise cannot evict runs). */
export const AUTOMATION_RUNS_KEPT = 100;
export const AUTOMATION_SKIPPED_RUNS_KEPT = 30;

/**
 * A fixed-time run missed while Volt was closed or the machine slept still runs once when Volt is
 * back within this long (Temporal's catch-up window); a slot missed by more is skipped. Several
 * missed slots of one trigger run once.
 */
export const SCHEDULE_MISSED_GRACE_MS = 12 * 3_600_000;
/** A run that was late by more than this says so ("Ran late: scheduled for 9:00"). */
export const SCHEDULE_LATE_NOTE_MS = 2 * 60_000;
/** Deleted automations are remembered this long, so another Volt window does not write them back. */
export const AUTOMATION_TOMBSTONE_TTL_MS = 30 * 86_400_000;
export const MIN_INTERVAL_MS = 60_000;
/** One automation fans out to at most this many repositories per run. */
export const MAX_REPOSITORIES_PER_RUN = 5;

//#region Types

export type AutomationSchedule =
	| { readonly type: 'hourly'; readonly minute: number }
	/** `time` is local 24-hour "HH:MM". */
	| { readonly type: 'daily'; readonly time: string }
	/** `weekdays` 0 (Sunday) to 6. */
	| { readonly type: 'weekly'; readonly weekdays: readonly number[]; readonly time: string }
	| { readonly type: 'cron'; readonly expr: string }
	| { readonly type: 'interval'; readonly everyMs: number }
	/** Runs once at `at` (epoch ms); after that it has no next run. */
	| { readonly type: 'once'; readonly at: number };

export interface IAutomationTrigger {
	readonly id: string;
	readonly provider: AutomationProvider;
	/** An event of `AUTOMATION_EVENTS[provider]`; schedules use their kind (`daily`). */
	readonly event: string;
	readonly schedule?: AutomationSchedule;
	/** Event triggers: their own secret URL, signing secret and payload filters. */
	readonly hook?: IAgentWebhookTrigger;
	/** Narrows the event: a branch, a channel, a label, an emoji. */
	readonly option?: string;
	/** Schedules: the IANA zone the times are in (`Europe/Berlin`); local time when absent. */
	readonly timezone?: string;
}

export type AutomationToolKind = 'memories' | 'mcp' | 'slack_send' | 'slack_read' | 'teams_send' | 'teams_read';

export interface IAutomationTool {
	readonly id: string;
	readonly kind: AutomationToolKind;
	/** `mcp`: the server's name in the user's or project's MCP config. */
	readonly server?: string;
	/** Send tools: the incoming webhook URL (a secret). */
	readonly url?: string;
	/** Read tools: a Slack bot token, or a Microsoft Graph token. */
	readonly token?: string;
	/** Read tools: the default channel (Slack id, or Teams `teamId/channelId`). */
	readonly channel?: string;
}

/** What a run used, for the Tools column and its filter. Pull request tools come with a repository. */
export type AutomationRunToolKind = 'pr_comment' | 'slack' | 'slack_read' | 'teams' | 'teams_read' | 'pull_request' | 'reviewers' | 'mcp' | 'memories';
export const AUTOMATION_RUN_TOOLS: readonly AutomationRunToolKind[] = ['pr_comment', 'slack', 'slack_read', 'teams', 'teams_read', 'pull_request', 'reviewers', 'mcp'];
export type AutomationToolStatus = 'success' | 'failed' | 'pending' | 'skipped';
export const AUTOMATION_TOOL_STATUSES: readonly AutomationToolStatus[] = ['success', 'failed', 'pending', 'skipped'];

export interface IAutomationRunTool {
	readonly kind: AutomationRunToolKind;
	readonly status: AutomationToolStatus;
	/** A server name, a channel, a pull request URL. */
	readonly detail?: string;
	readonly at: number;
}

export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface IAutomationRun {
	readonly id: string;
	readonly at: number;
	readonly status: AutomationRunStatus;
	readonly provider: AutomationProvider | 'manual';
	readonly event?: string;
	/** "Every day at 15:00", "Pull request opened · #12 Fix login". */
	readonly label: string;
	readonly triggerId?: string;
	readonly threadId?: string;
	/** The orchestrator turn the run sent; its settling ends the run. */
	readonly turnId?: string;
	readonly repository?: string;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly error?: string;
	readonly note?: string;
	readonly deliveryId?: string;
	readonly tools?: readonly IAutomationRunTool[];
	/** Schedule runs: the slot it serves (epoch ms), which keys it across Volt windows. */
	readonly slotAt?: number;
	/** Times Volt tried to send it; a send that failed for a passing reason is tried again. */
	readonly attempts?: number;
	/** The run's chat is parked at a provider usage limit; the run continues when the chat does. */
	readonly limited?: boolean;
}

export interface IAutomationRepository {
	/** The folder (a stored URI string). */
	readonly root: string;
	readonly name: string;
	/** The remote's owner (`Falcon-System`), when it has one on a known host. */
	readonly owner?: string;
}

/** What the editor changes; the rest is state. */
export interface IAutomationDraft {
	readonly name: string;
	readonly instructions: string;
	readonly enabled: boolean;
	readonly triggers: readonly IAutomationTrigger[];
	readonly repositories: readonly IAutomationRepository[];
	readonly modelRef?: string;
	readonly mode?: string;
	readonly tools: readonly IAutomationTool[];
	/** Listed under Team. */
	readonly shared?: boolean;
	readonly templateId?: string;
	/** Runs go into this chat instead of a new chat each time (scheduled from a chat). */
	readonly threadId?: string;
	/** Runs execute this saved workflow (`IWorkflowService`) with the instructions as its `task` input. */
	readonly workflowId?: string;
}

export interface IAutomation extends IAutomationDraft {
	readonly id: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** The signed-in account that made it ("LeulAria"), else "You". */
	readonly createdBy: string;
	readonly createdByAgent?: boolean;
	/** The chat an agent created it from. */
	readonly sourceThreadId?: string;
	/** Schedule trigger id → its next run. */
	readonly nextRuns: Readonly<Record<string, number>>;
	/**
	 * Hook id → the relay URL issued for it (a secret; the relay keeps only its hash). State, not
	 * draft: the relay sync writes it while the editor may hold unsaved changes.
	 */
	readonly relayUrls?: Readonly<Record<string, { readonly url: string; readonly relayId: string }>>;
	readonly runs: readonly IAutomationRun[];
	readonly runCount: number;
}

//#endregion

//#region Schedules

/** "09:30" → minutes after midnight, or undefined. */
export function parseTimeOfDay(value: string): number | undefined {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
	return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

export function formatTimeOfDay(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A new trigger's schedule for a kind of the Scheduled menu; a one-time run starts at the next full hour. */
export function defaultSchedule(kind: string, now = Date.now()): AutomationSchedule {
	switch (kind) {
		case 'minutes':
		case 'interval': return { type: 'interval', everyMs: 5 * 60_000 };
		case 'hourly': return { type: 'hourly', minute: 0 };
		case 'weekly': return { type: 'weekly', weekdays: [1], time: '09:00' };
		case 'cron': return { type: 'cron', expr: '0 9 * * 1-5' };
		case 'once': {
			const next = new Date(now);
			next.setMinutes(0, 0, 0);
			next.setHours(next.getHours() + 1);
			return { type: 'once', at: next.getTime() };
		}
		default: return { type: 'daily', time: '09:00' };
	}
}

/**
 * What is wrong with a schedule, if anything. With `now`, a one-time run at or before it is an
 * error too: pass it when saving what the user just set, not for one that already ran.
 */
export function validateSchedule(spec: AutomationSchedule, now?: number): string | undefined {
	switch (spec.type) {
		case 'hourly': return Number.isInteger(spec.minute) && spec.minute >= 0 && spec.minute < 60 ? undefined : 'Minute must be 0-59.';
		case 'daily': return parseTimeOfDay(spec.time) === undefined ? 'Time must be HH:MM.' : undefined;
		case 'weekly': return parseTimeOfDay(spec.time) === undefined ? 'Time must be HH:MM.' : spec.weekdays.length ? undefined : 'Pick at least one day.';
		case 'cron': return parseCron(spec.expr).error;
		case 'interval': return spec.everyMs >= MIN_INTERVAL_MS ? undefined : 'Runs at most once a minute.';
		case 'once': return !Number.isFinite(spec.at) ? 'Pick a date and time.' : now !== undefined && spec.at <= now ? 'This time has passed.' : undefined;
	}
}

/**
 * A schedule trigger's problem on Save: like `validateSchedule`, and a one-time run that is new
 * or was moved must be in the future (one that already ran may stay as it is).
 */
export function scheduleSaveError(trigger: IAutomationTrigger, saved: readonly IAutomationTrigger[] | undefined, now: number): string | undefined {
	if (!trigger.schedule) {
		return undefined;
	}
	const before = saved?.find(entry => entry.id === trigger.id);
	const unchanged = !!before && JSON.stringify(before.schedule) === JSON.stringify(trigger.schedule);
	return validateSchedule(trigger.schedule, unchanged ? undefined : now);
}

/** The first run strictly after `after`. `zone` is the IANA zone the times are in; local time when absent. */
export function nextScheduleAt(spec: AutomationSchedule, after: number, zone?: string): number | undefined {
	switch (spec.type) {
		case 'interval':
			return spec.everyMs >= MIN_INTERVAL_MS ? after + spec.everyMs : undefined;
		case 'once':
			return Number.isFinite(spec.at) && spec.at > after ? spec.at : undefined;
		case 'hourly': {
			const clock = wallClock(zone);
			const start = clock.parts(after);
			let candidate = clock.epoch(start.year, start.month, start.day, start.hour, spec.minute);
			// An absolute hour on: across a daylight saving change the wall hour repeats or jumps, the run does not.
			while (candidate <= after) {
				candidate += 3_600_000;
			}
			return candidate;
		}
		case 'cron': {
			const parsed = parseCron(spec.expr).schedule;
			return parsed ? nextCronRun(parsed, after, zone) : undefined;
		}
		case 'daily':
		case 'weekly': {
			const minutes = parseTimeOfDay(spec.time);
			if (minutes === undefined) {
				return undefined;
			}
			const days = spec.type === 'weekly' && spec.weekdays.length && spec.weekdays.length < 7 ? new Set(spec.weekdays) : undefined;
			const clock = wallClock(zone);
			const start = clock.parts(after);
			for (let offset = 0; offset <= 7; offset++) {
				const day = civilDay(start.year, start.month, start.day + offset);
				if (days && !days.has(day.weekday)) {
					continue;
				}
				const candidate = clock.epoch(day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60);
				if (candidate > after) {
					return candidate;
				}
			}
			return undefined;
		}
	}
}

/** The next `count` runs after `after`, for previews ("Next: Tue 09:00, Wed 09:00, …"). */
export function nextRunsPreview(spec: AutomationSchedule, after: number, count: number, zone?: string): number[] {
	const runs: number[] = [];
	if (spec.type === 'interval') {
		for (let index = 1; index <= count && spec.everyMs >= MIN_INTERVAL_MS; index++) {
			runs.push(after + index * spec.everyMs);
		}
		return runs;
	}
	let at = after;
	while (runs.length < count) {
		const next = nextScheduleAt(spec, at, zone);
		if (next === undefined) {
			break;
		}
		runs.push(next);
		at = next;
	}
	return runs;
}

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayName(day: number, short = false): string {
	return (short ? WEEKDAY_SHORT : WEEKDAY_LONG)[day] ?? '';
}

/**
 * "Every hour at :00", "Every day at 15:00", "Every Monday at 09:00", "Weekdays at 09:00",
 * "Once on Tue, Nov 4 at 09:00" (read in `zone`; the year shows when it is not `now`'s).
 */
export function describeSchedule(spec: AutomationSchedule, zone?: string, now = Date.now()): string {
	switch (spec.type) {
		case 'hourly': return `Every hour at :${String(spec.minute).padStart(2, '0')}`;
		case 'daily': return `Every day at ${spec.time}`;
		case 'cron': return describeCron(spec.expr);
		case 'once': {
			if (!Number.isFinite(spec.at)) {
				return 'Once';
			}
			const clock = wallClock(zone);
			const at = clock.parts(spec.at);
			const year = at.year !== clock.parts(now).year ? `, ${at.year}` : '';
			return `Once on ${WEEKDAY_SHORT[at.weekday]}, ${MONTH_SHORT[at.month - 1]} ${at.day}${year} at ${formatTimeOfDay(at.hour * 60 + at.minute)}`;
		}
		case 'interval': {
			const minutes = Math.round(spec.everyMs / 60_000);
			if (minutes % 1440 === 0) {
				return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
			}
			if (minutes % 60 === 0) {
				return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
			}
			return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
		}
		case 'weekly': {
			const days = [...new Set(spec.weekdays)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
			const key = [...days].sort((a, b) => a - b).join(',');
			if (days.length === 7 || !days.length) {
				return `Every day at ${spec.time}`;
			}
			if (key === '1,2,3,4,5') {
				return `Weekdays at ${spec.time}`;
			}
			if (key === '0,6') {
				return `Weekends at ${spec.time}`;
			}
			return days.length === 1 ? `Every ${WEEKDAY_LONG[days[0]]} at ${spec.time}` : `${days.map(day => WEEKDAY_SHORT[day]).join(', ')} at ${spec.time}`;
		}
	}
}

/** "Every day at 15:00", "Every day at 09:00 (GMT+1 · Berlin)", "Pull request opened", "New push to main". */
export function describeTrigger(trigger: IAutomationTrigger, now = Date.now()): string {
	if (trigger.provider === 'schedule') {
		if (!trigger.schedule) {
			return 'Scheduled';
		}
		const text = describeSchedule(trigger.schedule, trigger.timezone, now);
		// An interval is the same in every zone.
		return isLocalTimeZone(trigger.timezone) || trigger.schedule.type === 'interval' ? text : `${text} (${timeZoneLabel(trigger.timezone!, now)})`;
	}
	const label = eventLabel(trigger.provider, trigger.event);
	return trigger.option?.trim() ? `${label} (${trigger.option.trim()})` : label;
}

function scheduleTriggers(automation: Pick<IAutomation, 'triggers'>): IAutomationTrigger[] {
	return automation.triggers.filter(trigger => trigger.provider === 'schedule' && !!trigger.schedule);
}

/**
 * The next run of every schedule trigger. A trigger whose schedule (and zone) did not change and
 * whose next run is still ahead keeps it; a new or edited one counts from `now`. A one-time run
 * that already ran has no next run, so editing the automation never runs it again.
 */
export function planNextRuns(automation: Pick<IAutomation, 'enabled' | 'triggers'>, now: number, previous?: { readonly triggers: readonly IAutomationTrigger[]; readonly nextRuns: Readonly<Record<string, number>> }): Record<string, number> {
	const next: Record<string, number> = {};
	if (!automation.enabled) {
		return next;
	}
	for (const trigger of scheduleTriggers(automation)) {
		const before = previous?.triggers.find(candidate => candidate.id === trigger.id);
		const kept = previous?.nextRuns[trigger.id];
		if (before && kept !== undefined && kept > now - SCHEDULE_MISSED_GRACE_MS && JSON.stringify(before.schedule) === JSON.stringify(trigger.schedule) && before.timezone === trigger.timezone) {
			next[trigger.id] = kept;
			continue;
		}
		const at = nextScheduleAt(trigger.schedule!, now, trigger.timezone);
		if (at !== undefined) {
			next[trigger.id] = at;
		}
	}
	return next;
}

export interface IScheduleDecision {
	readonly triggerId: string;
	readonly kind: 'run' | 'skip';
	/** The trigger's run after this one. */
	readonly next: number | undefined;
	readonly due: number;
}

/**
 * Which schedule triggers are due at `now`. An interval missed while Volt was closed runs once; a
 * fixed time (a one-time run too) missed by more than the grace is skipped (T3 does the same).
 * Two triggers due at the same minute run once: the second is recorded as a skip. A one-time run
 * has no next run after this.
 */
export function dueSchedules(automation: IAutomation, now: number): IScheduleDecision[] {
	if (!automation.enabled) {
		return [];
	}
	const decisions: IScheduleDecision[] = [];
	let ran = false;
	for (const trigger of scheduleTriggers(automation)) {
		const due = automation.nextRuns[trigger.id];
		if (due === undefined || due > now) {
			continue;
		}
		const spec = trigger.schedule!;
		const late = now - due;
		const next = nextScheduleAt(spec, spec.type === 'interval' ? now : Math.max(now, due), trigger.timezone);
		const kind: IScheduleDecision['kind'] = (spec.type !== 'interval' && late > SCHEDULE_MISSED_GRACE_MS) || ran ? 'skip' : 'run';
		ran ||= kind === 'run';
		decisions.push({ triggerId: trigger.id, kind, next, due });
	}
	return decisions;
}

export function nextRunOf(automation: Pick<IAutomation, 'enabled' | 'nextRuns'>): number | undefined {
	if (!automation.enabled) {
		return undefined;
	}
	let next: number | undefined;
	for (const at of Object.values(automation.nextRuns)) {
		if (next === undefined || at < next) {
			next = at;
		}
	}
	return next;
}

/** The soonest scheduled run among all automations, for the service's timer. */
export function nextDueAt(automations: readonly IAutomation[]): number | undefined {
	let next: number | undefined;
	for (const automation of automations) {
		const at = nextRunOf(automation);
		if (at !== undefined && (next === undefined || at < next)) {
			next = at;
		}
	}
	return next;
}

/**
 * A schedule from an agent's words: "hourly", "hourly at :15", "daily at 09:00", "weekdays at
 * 18:30", "mondays at 9:00", "mon, wed at 08:15", "every 2 hours", "every 5 minutes", "once at
 * 2026-11-04 09:00", "tomorrow at 9:00", "in 30 minutes", "cron 0 9 * * 1-5", or a bare
 * five-field cron expression. One-time runs are in local time and must be after `now`.
 */
export function parseScheduleText(input: string, now = Date.now()): { readonly schedule?: AutomationSchedule; readonly error?: string } {
	const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
	const fail = { error: `Could not read the schedule "${input}". Try "daily at 09:00", "weekdays at 18:30", "hourly at :15", "every 5 minutes", "once at 2026-11-04 09:00", "in 30 minutes" or a cron expression like "0 9 * * 1-5".` };
	const once = (at: number) => {
		const spec: AutomationSchedule = { type: 'once', at };
		const error = validateSchedule(spec, now);
		return error ? { error: error === 'This time has passed.' ? `${input.trim()} has already passed.` : error } : { schedule: spec };
	};
	const hourly = /^(?:hourly|every hour)(?: at :?(\d{1,2}))?$/.exec(text);
	if (hourly) {
		const minute = hourly[1] ? Number(hourly[1]) : 0;
		return minute < 60 ? { schedule: { type: 'hourly', minute } } : fail;
	}
	if (text === 'every minute') {
		return { schedule: { type: 'interval', everyMs: 60_000 } };
	}
	const every = /^every (\d+) ?(minute|min|m|hour|hr|h|day|d)s?$/.exec(text);
	if (every) {
		const unit = every[2].startsWith('m') ? 60_000 : every[2].startsWith('h') ? 3_600_000 : 86_400_000;
		const spec: AutomationSchedule = { type: 'interval', everyMs: Number(every[1]) * unit };
		return validateSchedule(spec) ? { error: validateSchedule(spec) } : { schedule: spec };
	}
	const after = /^(?:once )?in (\d+) ?(minute|min|m|hour|hr|h|day|d)s?$/.exec(text);
	if (after) {
		const unit = after[2].startsWith('m') ? 60_000 : after[2].startsWith('h') ? 3_600_000 : 86_400_000;
		// On a whole minute, like every other schedule.
		return once(Math.ceil((now + Number(after[1]) * unit) / 60_000) * 60_000);
	}
	const dated = /^(?:once )?(?:on |at )?(\d{4})-(\d{2})-(\d{2})(?:t| at | )(\d{1,2}:\d{2})$/.exec(text);
	if (dated) {
		const minutes = parseTimeOfDay(dated[4]);
		const [year, month, day] = [Number(dated[1]), Number(dated[2]), Number(dated[3])];
		// "2026-02-30" would roll into March.
		if (minutes === undefined || month < 1 || month > 12 || new Date(year, month - 1, day).getDate() !== day) {
			return fail;
		}
		return once(new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60).getTime());
	}
	const relative = /^(?:once )?(today|tomorrow) at (\d{1,2}:\d{2})$/.exec(text);
	if (relative) {
		const minutes = parseTimeOfDay(relative[2]);
		const base = new Date(now);
		return minutes === undefined ? fail : once(new Date(base.getFullYear(), base.getMonth(), base.getDate() + (relative[1] === 'tomorrow' ? 1 : 0), Math.floor(minutes / 60), minutes % 60).getTime());
	}
	const at = /^(daily|every day|weekdays|weekends|(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[, ]*(?:and )?)+) at (\d{1,2}:\d{2})$/.exec(text);
	if (at) {
		const minutes = parseTimeOfDay(at[2]);
		if (minutes === undefined) {
			return fail;
		}
		const time = formatTimeOfDay(minutes);
		const days = at[1];
		if (days === 'daily' || days === 'every day') {
			return { schedule: { type: 'daily', time } };
		}
		const weekdays = days === 'weekdays' ? [1, 2, 3, 4, 5] : days === 'weekends' ? [0, 6]
			: [...new Set((days.match(/mon|tue|wed|thu|fri|sat|sun/g) ?? []).map(day => WEEKDAY_SHORT.findIndex(name => name.toLowerCase() === day)))];
		return weekdays.length ? { schedule: { type: 'weekly', weekdays: weekdays.sort((a, b) => a - b), time } } : fail;
	}
	const cron = text.replace(/^cron /, '');
	if (/^(@\w+|(\S+ ){4}\S+)$/.test(cron)) {
		const error = parseCron(cron).error;
		return error ? { error } : { schedule: { type: 'cron', expr: cron } };
	}
	return fail;
}

/** The trigger's event for a schedule: its kind in the Scheduled menu (an interval is "Every few minutes"). */
export function scheduleKindOf(spec: AutomationSchedule): string {
	return spec.type === 'interval' ? 'minutes' : spec.type;
}

/** "GMT+4", "GMT-5:30", "GMT": the offset at `at` in `zone` (local when absent). */
export function gmtOffsetLabel(at: number, zone?: string): string {
	return formatGmtOffset(wallClock(zone).offset(at));
}

//#endregion

//#region Runs

export function isActiveRun(run: Pick<IAutomationRun, 'status'>): boolean {
	return run.status === 'queued' || run.status === 'running';
}

/** Appends a run; non-skipped and skipped runs are capped separately, newest kept. */
export function recordRun(automation: IAutomation, run: IAutomationRun): IAutomation {
	return { ...automation, runs: capRuns([...automation.runs, run]), runCount: automation.runCount + (run.status === 'skipped' ? 0 : 1) };
}

/** Non-skipped and skipped runs are capped separately, newest kept; active runs are never dropped. */
function capRuns(runs: readonly IAutomationRun[]): IAutomationRun[] {
	let skipped = runs.filter(entry => entry.status === 'skipped').length - AUTOMATION_SKIPPED_RUNS_KEPT;
	let other = runs.length - Math.max(0, runs.filter(entry => entry.status === 'skipped').length) - AUTOMATION_RUNS_KEPT;
	const kept = runs.filter(entry => {
		if (entry.status === 'skipped' && skipped > 0) {
			skipped--;
			return false;
		}
		if (entry.status !== 'skipped' && other > 0 && !isActiveRun(entry)) {
			other--;
			return false;
		}
		return true;
	});
	return kept;
}

export function patchRun(automation: IAutomation, runId: string, patch: Partial<IAutomationRun>): IAutomation {
	return { ...automation, runs: automation.runs.map(run => run.id === runId ? { ...run, ...patch } : run) };
}

/** Adds or updates one tool's status on a run (a later status of the same tool and detail wins). */
export function withRunTool(run: IAutomationRun, tool: IAutomationRunTool): IAutomationRun {
	const tools = (run.tools ?? []).filter(entry => !(entry.kind === tool.kind && entry.detail === tool.detail));
	return { ...run, tools: [...tools, tool].slice(-20) };
}

export interface IAutomationRunStats {
	readonly succeeded24h: number;
	readonly failed24h: number;
	readonly succeeded7d: number;
	readonly failed7d: number;
}

export function runStats(runs: readonly IAutomationRun[], now: number): IAutomationRunStats {
	let succeeded24h = 0, failed24h = 0, succeeded7d = 0, failed7d = 0;
	for (const run of runs) {
		const age = now - run.at;
		if (age > 7 * 86_400_000) {
			continue;
		}
		const ok = run.status === 'succeeded';
		const bad = run.status === 'failed' || run.status === 'cancelled';
		succeeded7d += ok ? 1 : 0;
		failed7d += bad ? 1 : 0;
		if (age <= 86_400_000) {
			succeeded24h += ok ? 1 : 0;
			failed24h += bad ? 1 : 0;
		}
	}
	return { succeeded24h, failed24h, succeeded7d, failed7d };
}

export function runDuration(run: IAutomationRun, now: number): number | undefined {
	if (run.status === 'skipped') {
		return undefined;
	}
	const start = run.startedAt ?? run.at;
	const end = run.finishedAt ?? (isActiveRun(run) ? now : undefined);
	return end !== undefined ? Math.max(0, end - start) : undefined;
}

/** "42s", "3m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

//#endregion

//#region Run filters

export type RunStatusBucket = 'running' | 'failed' | 'succeeded' | 'skipped';
export const RUN_STATUS_BUCKETS: readonly RunStatusBucket[] = ['running', 'failed', 'succeeded', 'skipped'];

export function runStatusBucket(status: AutomationRunStatus): RunStatusBucket {
	switch (status) {
		case 'queued':
		case 'running': return 'running';
		case 'failed':
		case 'cancelled': return 'failed';
		default: return status;
	}
}

export interface IAutomationRunFilter {
	readonly statuses: ReadonlySet<RunStatusBucket>;
	readonly triggers: ReadonlySet<AutomationTriggerGroup>;
	readonly tools: ReadonlyMap<AutomationRunToolKind, ReadonlySet<AutomationToolStatus>>;
	readonly text: string;
}

export const EMPTY_RUN_FILTER: IAutomationRunFilter = { statuses: new Set(), triggers: new Set(), tools: new Map(), text: '' };

/** The badge on the filter button: one per status, trigger and tool group in use. */
export function activeFilterCount(filter: IAutomationRunFilter): number {
	let count = filter.statuses.size ? 1 : 0;
	count += filter.triggers.size ? 1 : 0;
	for (const statuses of filter.tools.values()) {
		count += statuses.size ? 1 : 0;
	}
	return count;
}

export function filterRuns<T extends IAutomationRun>(runs: readonly T[], filter: IAutomationRunFilter, extraText?: (run: T) => string): T[] {
	const text = filter.text.trim().toLowerCase();
	const tools = [...filter.tools].filter(([, statuses]) => statuses.size);
	return runs.filter(run => {
		if (filter.statuses.size && !filter.statuses.has(runStatusBucket(run.status))) {
			return false;
		}
		if (filter.triggers.size && !filter.triggers.has(triggerGroupOf(run.provider))) {
			return false;
		}
		if (tools.length && !tools.every(([kind, statuses]) => (run.tools ?? []).some(tool => tool.kind === kind && statuses.has(tool.status)))) {
			return false;
		}
		if (text) {
			const haystack = [run.label, run.repository, run.error, run.note, run.status, run.event, extraText?.(run)].filter(Boolean).join(' ').toLowerCase();
			return haystack.includes(text);
		}
		return true;
	});
}

//#endregion

//#region Prompt

export interface IAutomationRunContext {
	readonly runId: string;
	readonly at: number;
	readonly triggerLabel: string;
	readonly manual?: boolean;
	readonly repository?: IAutomationRepository;
	/** MEMORIES.md as it is now, when the automation has the Memories tool. */
	readonly memory?: string;
	/** Event facts, one per line (see `summarizeAutomationEvent`). */
	readonly eventLines?: readonly string[];
	readonly eventProvider?: string;
	/** Raw payload excerpt for generic webhooks. */
	readonly payload?: string;
	/** The instructions with `{{payload.…}}` placeholders filled in. */
	readonly instructions?: string;
	/** Names of the MCP servers the automation lists. */
	readonly mcpServers?: readonly string[];
	/** Runtime actions the `automation` tool offers this run. */
	readonly actions: readonly string[];
}

/** MEMORIES.md content inlined into a run's prompt, so it needs no tool call to read it. */
export const MEMORY_IN_PROMPT = 6000;

/**
 * The text a run sends. Short framing, the facts of the event (not its payload), memory inline,
 * then the user's instructions: a GitHub-triggered run costs a few hundred tokens of context
 * instead of the 6-25k a raw payload would.
 */
export function automationRunPrompt(automation: Pick<IAutomation, 'name' | 'instructions'>, run: IAutomationRunContext): string {
	const lines = [
		`[Volt] Automation "${automation.name}" (run ${run.runId}, ${run.manual ? 'started by hand' : `trigger: ${run.triggerLabel}`}) at ${new Date(run.at).toISOString()}. Nobody is watching: do the task, then end with a short report of what you found and changed (with links).`,
	];
	if (run.repository) {
		lines.push(`Repository: ${run.repository.owner ? `${run.repository.owner}/` : ''}${run.repository.name}.`);
	}
	if (run.actions.length) {
		lines.push(`Tool \`automation\` actions for this run: ${run.actions.join(', ')}. Pass run_id "${run.runId}".`);
	}
	if (run.mcpServers?.length) {
		lines.push(`Use these MCP servers where they help: ${run.mcpServers.join(', ')}.`);
	}
	if (run.memory !== undefined) {
		const memory = run.memory.trim();
		const cut = memory.length > MEMORY_IN_PROMPT ? `${memory.slice(0, MEMORY_IN_PROMPT)}\n… (truncated; read it all with memory_read)` : memory;
		lines.push('', `<memories file="MEMORIES.md">\n${cut || '(empty: nothing recorded yet)'}\n</memories>`, 'Keep MEMORIES.md current with memory_write (whole file) or memory_append before you finish.');
	}
	if (run.eventLines?.length) {
		lines.push('', `<event source="${run.eventProvider ?? 'webhook'}">\n${run.eventLines.join('\n')}\n</event>`);
	}
	if (run.payload) {
		lines.push('', `<payload>\n${run.payload}\n</payload>`);
	}
	lines.push('', (run.instructions ?? automation.instructions).trim() || 'No instructions were written: say so and stop.');
	return lines.join('\n');
}

export function nameFromInstructions(text: string, max = 48): string {
	const line = text.trim().split('\n').map(entry => entry.trim()).find(Boolean) ?? '';
	const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '');
	return !plain ? 'Untitled' : plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

//#endregion

//#region Persistence

export interface IAutomationsFile {
	readonly version: number;
	readonly automations: readonly IAutomation[];
	/** Automation id → when it was deleted (see `AUTOMATION_TOMBSTONE_TTL_MS`). */
	readonly deleted?: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(raw: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === 'string' && value) {
			out[key] = value;
		}
	}
	return out;
}

export function parseSchedule(value: unknown): AutomationSchedule | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	switch (value.type) {
		case 'hourly': return typeof value.minute === 'number' && value.minute >= 0 && value.minute < 60 ? { type: 'hourly', minute: Math.floor(value.minute) } : undefined;
		case 'daily': return typeof value.time === 'string' && parseTimeOfDay(value.time) !== undefined ? { type: 'daily', time: formatTimeOfDay(parseTimeOfDay(value.time)!) } : undefined;
		case 'weekly': {
			const days = Array.isArray(value.weekdays) ? value.weekdays.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day < 7) : [];
			return typeof value.time === 'string' && parseTimeOfDay(value.time) !== undefined && days.length ? { type: 'weekly', weekdays: [...new Set(days)].sort((a, b) => a - b), time: formatTimeOfDay(parseTimeOfDay(value.time)!) } : undefined;
		}
		case 'cron': return typeof value.expr === 'string' && !parseCron(value.expr).error ? { type: 'cron', expr: value.expr.trim() } : undefined;
		case 'interval': return typeof value.everyMs === 'number' && value.everyMs > 0 ? { type: 'interval', everyMs: value.everyMs } : undefined;
		case 'once': return typeof value.at === 'number' && Number.isFinite(value.at) ? { type: 'once', at: Math.floor(value.at) } : undefined;
		// The old scheduled tasks' shape.
		case 'fixed_time': {
			const time = typeof value.timeOfDay === 'string' ? value.timeOfDay : '';
			const days = Array.isArray(value.weekdays) ? value.weekdays.filter((day): day is number => typeof day === 'number') : [];
			return parseTimeOfDay(time) === undefined ? undefined : days.length && days.length < 7 ? { type: 'weekly', weekdays: days, time } : { type: 'daily', time };
		}
	}
	return undefined;
}

export function parseTrigger(value: unknown): IAutomationTrigger | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !AUTOMATION_PROVIDERS.includes(value.provider as AutomationProvider) || typeof value.event !== 'string') {
		return undefined;
	}
	const provider = value.provider as AutomationProvider;
	const schedule = provider === 'schedule' ? parseSchedule(value.schedule) : undefined;
	const hook = provider !== 'schedule' ? parseWebhookTrigger(value.hook) : undefined;
	if ((provider === 'schedule' && !schedule) || (provider !== 'schedule' && !hook)) {
		return undefined;
	}
	return { id: value.id, provider, event: value.event, ...(schedule ? { schedule } : {}), ...(hook ? { hook } : {}), ...strings(value, ['option', 'timezone']) };
}

const TOOL_KINDS: readonly AutomationToolKind[] = ['memories', 'mcp', 'slack_send', 'slack_read', 'teams_send', 'teams_read'];

export function parseTool(value: unknown): IAutomationTool | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !TOOL_KINDS.includes(value.kind as AutomationToolKind)) {
		return undefined;
	}
	return { id: value.id, kind: value.kind as AutomationToolKind, ...strings(value, ['server', 'url', 'token', 'channel']) };
}

const RUN_STATUSES: readonly AutomationRunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'];
const RUN_TOOL_KINDS: readonly AutomationRunToolKind[] = [...AUTOMATION_RUN_TOOLS, 'memories'];

function parseRun(value: unknown): IAutomationRun | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.at !== 'number' || !RUN_STATUSES.includes(value.status as AutomationRunStatus)) {
		return undefined;
	}
	const provider = value.provider === 'manual' || AUTOMATION_PROVIDERS.includes(value.provider as AutomationProvider) ? value.provider as AutomationProvider | 'manual' : 'manual';
	const tools = Array.isArray(value.tools) ? value.tools.flatMap(tool => isRecord(tool) && RUN_TOOL_KINDS.includes(tool.kind as AutomationRunToolKind) && AUTOMATION_TOOL_STATUSES.includes(tool.status as AutomationToolStatus)
		? [{ kind: tool.kind as AutomationRunToolKind, status: tool.status as AutomationToolStatus, at: typeof tool.at === 'number' ? tool.at : value.at as number, ...strings(tool, ['detail']) }]
		: []) : undefined;
	return {
		id: value.id,
		at: value.at,
		status: value.status as AutomationRunStatus,
		provider,
		label: typeof value.label === 'string' ? value.label : 'Run',
		...strings(value, ['event', 'triggerId', 'threadId', 'turnId', 'repository', 'error', 'note', 'deliveryId']),
		...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
		...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
		...(tools?.length ? { tools } : {}),
		...(typeof value.slotAt === 'number' ? { slotAt: value.slotAt } : {}),
		...(typeof value.attempts === 'number' ? { attempts: value.attempts } : {}),
		...(value.limited === true ? { limited: true } : {}),
	};
}

export function parseRepository(value: unknown): IAutomationRepository | undefined {
	return isRecord(value) && typeof value.root === 'string' && typeof value.name === 'string'
		? { root: value.root, name: value.name, ...strings(value, ['owner']) }
		: undefined;
}

export function parseAutomation(value: unknown): IAutomation | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.createdAt !== 'number') {
		return undefined;
	}
	const list = <T>(raw: unknown, parse: (entry: unknown) => T | undefined): T[] => Array.isArray(raw) ? raw.map(parse).filter((entry): entry is T => !!entry) : [];
	const nextRuns: Record<string, number> = {};
	if (isRecord(value.nextRuns)) {
		for (const [key, at] of Object.entries(value.nextRuns)) {
			if (typeof at === 'number') {
				nextRuns[key] = at;
			}
		}
	}
	const runs = list(value.runs, parseRun);
	const relayUrls: Record<string, { url: string; relayId: string }> = {};
	if (isRecord(value.relayUrls)) {
		for (const [key, entry] of Object.entries(value.relayUrls)) {
			if (isRecord(entry) && typeof entry.url === 'string' && typeof entry.relayId === 'string') {
				relayUrls[key] = { url: entry.url, relayId: entry.relayId };
			}
		}
	}
	return {
		id: value.id,
		name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Untitled',
		instructions: typeof value.instructions === 'string' ? value.instructions : '',
		enabled: value.enabled === true,
		triggers: list(value.triggers, parseTrigger),
		repositories: list(value.repositories, parseRepository),
		tools: list(value.tools, parseTool),
		...strings(value, ['modelRef', 'mode', 'templateId', 'threadId', 'sourceThreadId', 'workflowId']),
		...(value.shared === true ? { shared: true } : {}),
		...(value.createdByAgent === true ? { createdByAgent: true } : {}),
		createdAt: value.createdAt,
		updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : value.createdAt,
		createdBy: typeof value.createdBy === 'string' && value.createdBy ? value.createdBy : 'You',
		nextRuns,
		...(Object.keys(relayUrls).length ? { relayUrls } : {}),
		runs,
		runCount: typeof value.runCount === 'number' ? value.runCount : runs.filter(run => run.status !== 'skipped').length,
	};
}

export function parseAutomationsFile(raw: unknown): IAutomation[] {
	const automations = isRecord(raw) && Array.isArray(raw.automations) ? raw.automations : [];
	return automations.map(parseAutomation).filter((automation): automation is IAutomation => !!automation);
}

/** The deleted-automation tombstones of a file, without the expired ones. */
export function parseDeletedAutomations(raw: unknown, now: number): Record<string, number> {
	const deleted = isRecord(raw) && isRecord(raw.deleted) ? raw.deleted : {};
	const out: Record<string, number> = {};
	for (const [id, at] of Object.entries(deleted)) {
		if (typeof at === 'number' && Number.isFinite(at) && now - at < AUTOMATION_TOMBSTONE_TTL_MS) {
			out[id] = at;
		}
	}
	return out;
}

export interface IAutomationsState {
	readonly automations: readonly IAutomation[];
	readonly deleted: Readonly<Record<string, number>>;
}

/**
 * Two Volt windows' views of the automations, made one. Every window keeps the whole list and
 * writes the whole file, so each write first merges with what is on disk instead of replacing it:
 * - an automation deleted in either (a tombstone newer than its last edit) stays deleted;
 * - one only one side has is kept (made in another window, or not written yet);
 * - for one both have, the newer edit's definition wins; runs are the union by id (a run that
 *   moved on, finished or started, wins over the same run still queued); each schedule's next
 *   run is the later one, so a slot one window used is used for both.
 * `local` wins ties. Pure; the result is in creation order.
 */
export function mergeAutomations(local: IAutomationsState, disk: IAutomationsState): IAutomationsState {
	const deleted: Record<string, number> = { ...disk.deleted };
	for (const [id, at] of Object.entries(local.deleted)) {
		deleted[id] = Math.max(at, deleted[id] ?? 0);
	}
	const alive = (automation: IAutomation) => deleted[automation.id] === undefined || deleted[automation.id] < automation.updatedAt;
	const onDisk = new Map(disk.automations.map(automation => [automation.id, automation]));
	const out: IAutomation[] = [];
	const seen = new Set<string>();
	for (const mine of local.automations) {
		seen.add(mine.id);
		const theirs = onDisk.get(mine.id);
		const merged = theirs ? mergeAutomation(mine, theirs) : mine;
		if (alive(merged)) {
			out.push(merged);
		}
	}
	for (const theirs of disk.automations) {
		if (!seen.has(theirs.id) && alive(theirs)) {
			out.push(theirs);
		}
	}
	// A tombstone is only needed while some window may still hold the automation.
	for (const automation of out) {
		delete deleted[automation.id];
	}
	// One order for every window (the order they were made in), so two windows never rewrite each other's file over order alone.
	out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { automations: out, deleted };
}

function mergeAutomation(mine: IAutomation, theirs: IAutomation): IAutomation {
	const base = theirs.updatedAt > mine.updatedAt ? theirs : mine;
	const runs = new Map<string, IAutomationRun>();
	for (const run of [...theirs.runs, ...mine.runs]) {
		const other = runs.get(run.id);
		runs.set(run.id, other ? newerRun(other, run) : run);
	}
	const nextRuns: Record<string, number> = {};
	for (const trigger of base.triggers) {
		const a = mine.nextRuns[trigger.id];
		const b = theirs.nextRuns[trigger.id];
		const next = a === undefined ? b : b === undefined ? a : Math.max(a, b);
		if (next !== undefined && base.nextRuns[trigger.id] !== undefined) {
			nextRuns[trigger.id] = next;
		}
	}
	return {
		...base,
		nextRuns,
		runs: capRuns([...runs.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
		runCount: Math.max(mine.runCount, theirs.runCount),
	};
}

/** Of two copies of one run, the one further along; `b` (local) on a tie. */
function newerRun(a: IAutomationRun, b: IAutomationRun): IAutomationRun {
	const rank = (run: IAutomationRun) => run.finishedAt !== undefined || !isActiveRun(run) ? 2 : run.status === 'running' ? 1 : 0;
	const diff = rank(a) - rank(b);
	if (diff !== 0) {
		return diff > 0 ? a : b;
	}
	return (a.finishedAt ?? a.startedAt ?? a.at) > (b.finishedAt ?? b.startedAt ?? b.at) ? a : b;
}

/** The orchestrator turn a run's turn became (`auto-r1~l1` continues `auto-r1` after a usage limit, `~s1` after it stopped, `~c1` its unfinished plan). */
export function isTurnOfRun(turnId: string | undefined, runTurnId: string | undefined): boolean {
	return !!turnId && !!runTurnId && (turnId === runTurnId || turnId.replace(/(?:~[cflmrs]\d+)+$/, '') === runTurnId);
}

/**
 * Scheduled tasks from before Automations (`voltSchedules/schedules.json`): each becomes an
 * automation with its schedule and webhook as triggers, its prompt as instructions, and runs kept.
 */
export function migrateScheduledTasks(raw: unknown, now: number): IAutomation[] {
	const tasks = isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
	const out: IAutomation[] = [];
	for (const task of tasks) {
		if (!isRecord(task) || typeof task.id !== 'string' || typeof task.prompt !== 'string') {
			continue;
		}
		const triggers: IAutomationTrigger[] = [];
		const schedule = parseSchedule(task.schedule);
		if (schedule && task.trigger !== 'webhook') {
			triggers.push({ id: `${task.id}-clock`, provider: 'schedule', event: schedule.type === 'weekly' ? 'weekly' : schedule.type === 'interval' ? 'hourly' : schedule.type, schedule });
		}
		const hook = parseWebhookTrigger(task.webhook);
		if (hook && (task.trigger === 'webhook' || task.trigger === 'both')) {
			triggers.push({ id: `${task.id}-hook`, provider: 'webhook', event: 'any', hook });
		}
		const target = isRecord(task.target) ? task.target : undefined;
		const repositories: IAutomationRepository[] = target?.kind === 'new' && typeof target.projectRoot === 'string'
			? [{ root: target.projectRoot, name: target.projectRoot.split('/').filter(Boolean).pop() ?? target.projectRoot }]
			: [];
		const runs: IAutomationRun[] = Array.isArray(task.runs) ? task.runs.flatMap((run, index) => {
			if (!isRecord(run) || typeof run.at !== 'number') {
				return [];
			}
			const status: AutomationRunStatus = run.status === 'failed' ? 'failed' : run.status === 'skipped' ? 'skipped' : 'succeeded';
			return [{
				id: `${task.id}-r${index}`, at: run.at, status, provider: run.manual === true ? 'manual' as const : run.webhook ? 'webhook' as const : 'schedule' as const,
				label: run.manual === true ? 'Run now' : schedule ? describeSchedule(schedule) : 'Webhook',
				...strings(run, ['threadId', 'error']),
			}];
		}) : [];
		const enabled = task.enabled !== false;
		const createdAt = typeof task.createdAt === 'number' ? task.createdAt : now;
		const automation: IAutomation = {
			id: `a-${task.id.replace(/^s-/, '')}`,
			name: typeof task.title === 'string' && task.title.trim() ? task.title : nameFromInstructions(task.prompt),
			instructions: task.prompt,
			enabled,
			triggers,
			repositories,
			tools: [{ id: `${task.id}-mem`, kind: 'memories' }],
			...strings(task, ['modelRef', 'mode', 'sourceThreadId']),
			...(target?.kind === 'thread' && typeof target.threadId === 'string' ? { threadId: target.threadId } : {}),
			...(task.createdBy === 'agent' ? { createdByAgent: true } : {}),
			createdAt,
			updatedAt: createdAt,
			createdBy: 'You',
			nextRuns: {},
			runs,
			runCount: runs.filter(run => run.status !== 'skipped').length,
		};
		out.push({ ...automation, nextRuns: planNextRuns(automation, now) });
	}
	return out;
}

//#endregion

//#region Service

export const IAutomationService = createDecorator<IAutomationService>('automationService');

export interface IAutomationCreateInput extends Partial<IAutomationDraft> {
	readonly createdByAgent?: boolean;
	readonly sourceThreadId?: string;
}

export interface IAutomationDeliveryInput {
	readonly deliveryId: string;
	readonly receivedAt: number;
	/** The rendered prompt pieces (instructions with placeholders filled, event facts, payload excerpt). */
	readonly instructions: string;
	readonly eventLines: readonly string[];
	readonly payload?: string;
	readonly label: string;
}

/** An automation run that executes the automation's workflow (`IAutomationDraft.workflowId`). */
export interface IAutomationWorkflowRequest {
	readonly automation: IAutomation;
	readonly run: IAutomationRun;
	/** The instructions with the event's placeholders filled in: the workflow's `task` input. */
	readonly task: string;
	readonly eventLines?: readonly string[];
	readonly payload?: string;
	readonly repository?: IAutomationRepository;
	/** The workflow run started, or its first agent step opened a chat. */
	onProgress(progress: { readonly workflowRunId?: string; readonly threadId?: string }): void;
}

export interface IAutomationWorkflowResult {
	readonly status: 'succeeded' | 'failed' | 'cancelled';
	readonly error?: string;
	/** The first agent step's chat, for Open chat. */
	readonly threadId?: string;
	readonly workflowRunId?: string;
}

export interface IAutomationWorkflowRun {
	readonly result: Promise<IAutomationWorkflowResult>;
	cancel(): void;
}

/** Runs workflows for automations; the workflows bridge registers it (the services do not depend on each other). */
export interface IAutomationWorkflowRunner {
	run(request: IAutomationWorkflowRequest): IAutomationWorkflowRun;
}

export interface IAutomationService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	list(): readonly IAutomation[];
	get(id: string): IAutomation | undefined;
	/** The account new automations are made by ("LeulAria"). */
	creator(): string;
	create(input: IAutomationCreateInput): Promise<IAutomation>;
	update(id: string, patch: Partial<IAutomationDraft>): Promise<IAutomation | undefined>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	duplicate(id: string): Promise<IAutomation | undefined>;
	delete(id: string): Promise<void>;
	/** Runs it now, off its triggers (schedules keep their next run). One run per repository. */
	runNow(id: string): Promise<readonly IAutomationRun[]>;
	/** A webhook delivery for one of its event triggers; the same delivery id never runs twice. */
	runFromDelivery(id: string, triggerId: string, input: IAutomationDeliveryInput): Promise<readonly IAutomationRun[]>;
	/** Records a delivery that did not start a run (filtered, a ping, the automation was off). */
	recordSkippedDelivery(id: string, triggerId: string, input: { readonly deliveryId: string; readonly receivedAt: number; readonly label: string; readonly note: string }): Promise<void>;
	/** Remembers the relay URL issued for a hook (the relay sync calls it). */
	setRelayUrl(id: string, hookId: string, url: string, relayId: string): Promise<void>;
	/** Stops the automation's active runs (or every automation's). Resolves with how many. */
	stopRuns(id?: string): Promise<number>;
	listMemoryFiles(id: string): Promise<readonly string[]>;
	readMemory(id: string, file?: string): Promise<string>;
	writeMemory(id: string, file: string, content: string): Promise<void>;
	deleteMemory(id: string, file: string): Promise<void>;
	/** Runs of automations with a `workflowId` go through `runner` (the latest one registered). */
	registerWorkflowRunner?(runner: IAutomationWorkflowRunner): { dispose(): void };
}

//#endregion
