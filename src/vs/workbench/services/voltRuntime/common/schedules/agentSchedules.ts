/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentScheduleTriggerKind, IAgentWebhookTrigger, parseWebhookTrigger } from './agentWebhooks.js';

/**
 * Scheduled agent tasks: a prompt Volt sends on a clock, either into one chat (a daily "check the
 * CI and fix what broke" in the chat that knows the project) or into a new chat each time. Runs
 * go through the orchestrator like a prompt the user sent, so a busy chat queues them.
 *
 * Modeled on T3 Code's scheduled tasks (interval or fixed wall-clock time on chosen weekdays, a
 * target thread or a new thread per run, missed fixed-time slots skipped, run now, pause).
 * Everything here is pure; the clock and the store live in the service.
 */

export const SCHEDULES_STATE_VERSION = 1;

/** Interval schedules run at most once a minute. */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;

/**
 * A fixed-time run Volt missed (it was closed) still runs when Volt comes back within this long;
 * later it is skipped and the next slot is scheduled, so a laptop opened at noon does not fire a
 * morning's worth of runs.
 */
export const SCHEDULE_MISSED_GRACE_MS = 10 * 60_000;

/** Runs remembered per task, newest last. */
export const SCHEDULE_RUNS_KEPT = 20;

export type AgentScheduleSpec =
	| { readonly type: 'interval'; readonly everyMs: number }
	/** `timeOfDay` is local 24-hour "HH:MM"; `weekdays` 0 (Sunday) to 6, absent for every day. */
	| { readonly type: 'fixed_time'; readonly timeOfDay: string; readonly weekdays?: readonly number[] };

/** Where a run goes: always the same chat, or a new chat in a project every time. */
export type AgentScheduleTarget =
	| { readonly kind: 'thread'; readonly threadId: string }
	| { readonly kind: 'new'; readonly projectRoot?: string };

export type AgentScheduleRunStatus = 'started' | 'queued' | 'failed' | 'skipped';

export interface IAgentScheduleRun {
	readonly at: number;
	readonly status: AgentScheduleRunStatus;
	readonly threadId?: string;
	readonly error?: string;
	/** Started by Run now rather than by the clock. */
	readonly manual?: boolean;
	/** Started by a webhook delivery. */
	readonly webhook?: { readonly deliveryId: string; readonly event?: string };
}

export interface IAgentSchedule {
	readonly id: string;
	readonly title: string;
	readonly prompt: string;
	readonly enabled: boolean;
	readonly schedule: AgentScheduleSpec;
	/** What starts runs: the clock, a webhook, or both. Absent: the clock. */
	readonly trigger?: AgentScheduleTriggerKind;
	readonly webhook?: IAgentWebhookTrigger;
	readonly target: AgentScheduleTarget;
	/** Catalog ref; absent: the chat's model (thread target) or the default model (new chats). */
	readonly modelRef?: string;
	/** Composer mode label ("Agent", "Plan", "Ask"). */
	readonly mode?: string;
	readonly createdAt: number;
	readonly createdBy: 'user' | 'agent';
	/** The chat the schedule was made from (by its agent or from its composer). */
	readonly sourceThreadId?: string;
	readonly nextRunAt?: number;
	readonly lastRunAt?: number;
	readonly runs: readonly IAgentScheduleRun[];
	readonly runCount: number;
}

//#region Schedule math

/** The clock runs this task (Schedule or Both). */
export function usesClock(task: Pick<IAgentSchedule, 'trigger'>): boolean {
	return task.trigger !== 'webhook';
}

/** A webhook starts runs of this task (Webhook or Both, with a hook set up). */
export function usesWebhook(task: Pick<IAgentSchedule, 'trigger' | 'webhook'>): boolean {
	return (task.trigger === 'webhook' || task.trigger === 'both') && !!task.webhook;
}

/** "09:30" → minutes after midnight, or undefined. */
export function parseTimeOfDay(value: string): number | undefined {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
	return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

export function formatTimeOfDay(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The first run strictly after `after`, in local time. Fixed times walk forward day by day (at
 * most a week) to the next allowed weekday; daylight saving changes are handled by `Date`.
 */
export function nextScheduleRun(spec: AgentScheduleSpec, after: number): number | undefined {
	if (spec.type === 'interval') {
		return spec.everyMs > 0 ? after + spec.everyMs : undefined;
	}
	const minutes = parseTimeOfDay(spec.timeOfDay);
	if (minutes === undefined) {
		return undefined;
	}
	const days = spec.weekdays?.length ? new Set(spec.weekdays) : undefined;
	const start = new Date(after);
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, Math.floor(minutes / 60), minutes % 60, 0, 0);
		if (candidate.getTime() > after && (!days || days.has(candidate.getDay()))) {
			return candidate.getTime();
		}
	}
	return undefined;
}

/** When a task created or re-enabled at `now` first runs. An interval waits one interval. */
export function firstScheduleRun(spec: AgentScheduleSpec, now: number): number | undefined {
	return nextScheduleRun(spec, now);
}

export type ScheduleDecision =
	/** Run it now; `nextRunAt` is the run after this one. */
	| { readonly kind: 'run'; readonly nextRunAt: number | undefined }
	/** Volt missed the slot by too much: record a skip and wait for the next one. */
	| { readonly kind: 'skip'; readonly nextRunAt: number | undefined }
	| { readonly kind: 'wait' };

/**
 * What to do with a task at `now`. A missed interval runs once and starts counting again from
 * now; a fixed time missed by more than the grace is skipped (T3 does the same).
 */
export function decideScheduleRun(task: Pick<IAgentSchedule, 'enabled' | 'schedule' | 'nextRunAt' | 'trigger'>, now: number): ScheduleDecision {
	if (!task.enabled || !usesClock(task) || task.nextRunAt === undefined || task.nextRunAt > now) {
		return { kind: 'wait' };
	}
	const late = now - task.nextRunAt;
	if (task.schedule.type === 'fixed_time' && late > SCHEDULE_MISSED_GRACE_MS) {
		return { kind: 'skip', nextRunAt: nextScheduleRun(task.schedule, now) };
	}
	return { kind: 'run', nextRunAt: nextScheduleRun(task.schedule, task.schedule.type === 'interval' ? now : Math.max(now, task.nextRunAt)) };
}

/** The soonest run among enabled tasks, for the service's timer. */
export function nextDueAt(tasks: readonly IAgentSchedule[]): number | undefined {
	let next: number | undefined;
	for (const task of tasks) {
		if (task.enabled && usesClock(task) && task.nextRunAt !== undefined && (next === undefined || task.nextRunAt < next)) {
			next = task.nextRunAt;
		}
	}
	return next;
}

export function recordScheduleRun(task: IAgentSchedule, run: IAgentScheduleRun, nextRunAt: number | undefined): IAgentSchedule {
	const { nextRunAt: _previous, ...rest } = task;
	return {
		...rest,
		runs: [...task.runs, run].slice(-SCHEDULE_RUNS_KEPT),
		lastRunAt: run.at,
		runCount: task.runCount + (run.status === 'skipped' ? 0 : 1),
		...(nextRunAt !== undefined ? { nextRunAt } : {}),
	};
}

//#endregion

//#region Input

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A schedule from loose input (an agent's tool call, a stored file): the structured object, or a
 * few words ("every 30 minutes", "daily at 09:00", "weekdays at 18:30"). Undefined + error text
 * when it cannot be read.
 */
export function parseScheduleSpec(value: unknown): { readonly spec?: AgentScheduleSpec; readonly error?: string } {
	if (typeof value === 'string') {
		return parseScheduleWords(value);
	}
	const raw = value as Record<string, unknown> | undefined;
	if (!raw || typeof raw !== 'object') {
		return { error: 'schedule must be an object: {"type":"interval","everyMs":3600000} or {"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}.' };
	}
	if (raw.type === 'interval') {
		const everyMs = typeof raw.everyMs === 'number' ? Math.round(raw.everyMs) : Number.NaN;
		if (!Number.isFinite(everyMs) || everyMs < MIN_SCHEDULE_INTERVAL_MS) {
			return { error: `everyMs must be at least ${MIN_SCHEDULE_INTERVAL_MS} (one minute).` };
		}
		return { spec: { type: 'interval', everyMs } };
	}
	if (raw.type === 'fixed_time') {
		const timeOfDay = typeof raw.timeOfDay === 'string' ? raw.timeOfDay.trim() : '';
		const minutes = parseTimeOfDay(timeOfDay);
		if (minutes === undefined) {
			return { error: 'timeOfDay must be local 24-hour HH:MM, such as 09:30.' };
		}
		const weekdays = Array.isArray(raw.weekdays) ? raw.weekdays : undefined;
		if (weekdays && weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)) {
			return { error: 'weekdays are numbers from 0 (Sunday) to 6 (Saturday).' };
		}
		const days = weekdays ? [...new Set(weekdays as number[])].sort((a, b) => a - b) : undefined;
		return { spec: { type: 'fixed_time', timeOfDay: formatTimeOfDay(minutes), ...(days?.length && days.length < 7 ? { weekdays: days } : {}) } };
	}
	return { error: 'schedule.type must be "interval" or "fixed_time".' };
}

function parseScheduleWords(text: string): { readonly spec?: AgentScheduleSpec; readonly error?: string } {
	const value = text.trim().toLowerCase();
	const every = /^every\s+(\d+(?:\.\d+)?)?\s*(minute|min|hour|hr|day)s?$/.exec(value);
	if (every) {
		const amount = every[1] ? Number(every[1]) : 1;
		const unit = every[2].startsWith('min') ? 60_000 : every[2].startsWith('h') ? 3_600_000 : 86_400_000;
		return parseScheduleSpec({ type: 'interval', everyMs: amount * unit });
	}
	const at = /^(daily|every day|weekdays|weekends|(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[,\s]*(?:and\s+)?)+)\s+at\s+(\d{1,2}:\d{2})$/.exec(value);
	if (at) {
		const days = at[1];
		const weekdays = days === 'daily' || days === 'every day' ? undefined
			: days === 'weekdays' ? [1, 2, 3, 4, 5]
				: days === 'weekends' ? [0, 6]
					: (days.match(/(mon|tue|wed|thu|fri|sat|sun)/g) ?? []).map(day => WEEKDAY_NAMES.findIndex(name => name.startsWith(day)));
		return parseScheduleSpec({ type: 'fixed_time', timeOfDay: at[2], ...(weekdays ? { weekdays } : {}) });
	}
	return { error: `Could not read the schedule "${text}". Use {"type":"interval","everyMs":3600000} or {"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}, or words like "every 2 hours", "daily at 09:00", "weekdays at 18:30".` };
}

/** "Every 2 hours", "Every day at 09:00", "Weekdays at 18:30", "Mon, Wed at 08:15". */
export function describeSchedule(spec: AgentScheduleSpec): string {
	if (spec.type === 'interval') {
		const minutes = Math.round(spec.everyMs / 60_000);
		if (minutes % 1440 === 0) {
			const days = minutes / 1440;
			return days === 1 ? 'Every day' : `Every ${days} days`;
		}
		if (minutes % 60 === 0) {
			const hours = minutes / 60;
			return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
		}
		return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
	}
	const days = spec.weekdays;
	if (!days?.length || days.length === 7) {
		return `Every day at ${spec.timeOfDay}`;
	}
	const key = [...days].sort((a, b) => a - b).join(',');
	if (key === '1,2,3,4,5') {
		return `Weekdays at ${spec.timeOfDay}`;
	}
	if (key === '0,6') {
		return `Weekends at ${spec.timeOfDay}`;
	}
	const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	return `${[...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(day => short[day]).join(', ')} at ${spec.timeOfDay}`;
}

/** The prompt a run sends: the task's text, marked so the agent knows nobody typed it just now. */
export function scheduledRunPrompt(task: Pick<IAgentSchedule, 'title' | 'prompt' | 'schedule'>, at: number): string {
	return `[Volt] Scheduled task "${task.title}" (${describeSchedule(task.schedule).toLowerCase()}) ran at ${new Date(at).toISOString()}. The user set this up earlier and is not necessarily watching; do the task and finish with a short report.\n\n${task.prompt.trim()}`;
}

export function titleFromPrompt(prompt: string, max = 48): string {
	const line = prompt.trim().split('\n').map(text => text.trim()).find(Boolean) ?? 'Scheduled task';
	const plain = line.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '');
	return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

//#endregion

//#region Persistence

export interface IAgentSchedulesFile {
	readonly version: number;
	readonly tasks: readonly IAgentSchedule[];
}

export function parseSchedulesFile(raw: unknown): IAgentSchedule[] {
	const file = raw as Partial<IAgentSchedulesFile> | undefined;
	if (!file || !Array.isArray(file.tasks)) {
		return [];
	}
	return file.tasks.map(parseSchedule).filter((task): task is IAgentSchedule => !!task);
}

function parseSchedule(value: unknown): IAgentSchedule | undefined {
	const raw = value as Record<string, unknown> | undefined;
	if (!raw || typeof raw.id !== 'string' || typeof raw.prompt !== 'string' || typeof raw.createdAt !== 'number') {
		return undefined;
	}
	const spec = raw.schedule && typeof raw.schedule === 'object' && (raw.schedule as { type?: unknown }).type === 'interval'
		// Keep reading intervals stored under an older minimum, so they can still be edited or removed.
		? (typeof (raw.schedule as { everyMs?: unknown }).everyMs === 'number' && (raw.schedule as { everyMs: number }).everyMs > 0 ? { type: 'interval' as const, everyMs: (raw.schedule as { everyMs: number }).everyMs } : undefined)
		: parseScheduleSpec(raw.schedule).spec;
	const target = parseTarget(raw.target);
	if (!spec || !target) {
		return undefined;
	}
	const webhook = parseWebhookTrigger(raw.webhook);
	const trigger = (raw.trigger === 'webhook' || raw.trigger === 'both') && webhook ? raw.trigger : undefined;
	const runs = Array.isArray(raw.runs) ? raw.runs.map(parseRun).filter((run): run is IAgentScheduleRun => !!run).slice(-SCHEDULE_RUNS_KEPT) : [];
	return {
		id: raw.id,
		title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : titleFromPrompt(raw.prompt),
		prompt: raw.prompt,
		enabled: raw.enabled !== false,
		schedule: spec,
		...(trigger ? { trigger } : {}),
		...(webhook ? { webhook } : {}),
		target,
		...(typeof raw.modelRef === 'string' && raw.modelRef ? { modelRef: raw.modelRef } : {}),
		...(typeof raw.mode === 'string' && raw.mode ? { mode: raw.mode } : {}),
		createdAt: raw.createdAt,
		createdBy: raw.createdBy === 'agent' ? 'agent' : 'user',
		...(typeof raw.sourceThreadId === 'string' ? { sourceThreadId: raw.sourceThreadId } : {}),
		...(typeof raw.nextRunAt === 'number' ? { nextRunAt: raw.nextRunAt } : {}),
		...(typeof raw.lastRunAt === 'number' ? { lastRunAt: raw.lastRunAt } : {}),
		runs,
		runCount: typeof raw.runCount === 'number' ? raw.runCount : runs.filter(run => run.status !== 'skipped').length,
	};
}

function parseTarget(value: unknown): AgentScheduleTarget | undefined {
	const raw = value as Record<string, unknown> | undefined;
	if (raw?.kind === 'thread' && typeof raw.threadId === 'string' && raw.threadId) {
		return { kind: 'thread', threadId: raw.threadId };
	}
	if (raw?.kind === 'new') {
		return { kind: 'new', ...(typeof raw.projectRoot === 'string' && raw.projectRoot ? { projectRoot: raw.projectRoot } : {}) };
	}
	return undefined;
}

function parseRun(value: unknown): IAgentScheduleRun | undefined {
	const raw = value as Record<string, unknown> | undefined;
	if (!raw || typeof raw.at !== 'number' || (raw.status !== 'started' && raw.status !== 'queued' && raw.status !== 'failed' && raw.status !== 'skipped')) {
		return undefined;
	}
	return {
		at: raw.at,
		status: raw.status,
		...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
		...(typeof raw.error === 'string' ? { error: raw.error } : {}),
		...(raw.manual === true ? { manual: true } : {}),
		...(raw.webhook && typeof (raw.webhook as { deliveryId?: unknown }).deliveryId === 'string' ? { webhook: { deliveryId: (raw.webhook as { deliveryId: string }).deliveryId, ...(typeof (raw.webhook as { event?: unknown }).event === 'string' ? { event: (raw.webhook as { event: string }).event } : {}) } } : {}),
	};
}

//#endregion

//#region Service

export const IAgentScheduleService = createDecorator<IAgentScheduleService>('agentScheduleService');

export interface IAgentScheduleInput {
	readonly title?: string;
	readonly prompt: string;
	readonly schedule: AgentScheduleSpec;
	readonly trigger?: AgentScheduleTriggerKind;
	readonly webhook?: IAgentWebhookTrigger;
	readonly target: AgentScheduleTarget;
	readonly modelRef?: string;
	readonly mode?: string;
	readonly enabled?: boolean;
	readonly createdBy?: 'user' | 'agent';
	readonly sourceThreadId?: string;
}

export interface IAgentScheduleService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	list(): readonly IAgentSchedule[];
	get(id: string): IAgentSchedule | undefined;
	/** Schedules whose runs go into this chat. */
	forThread(threadId: string): readonly IAgentSchedule[];
	create(input: IAgentScheduleInput): Promise<IAgentSchedule>;
	update(id: string, patch: Partial<IAgentScheduleInput>): Promise<IAgentSchedule | undefined>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	delete(id: string): Promise<void>;
	/** Runs it now, off the clock; the next scheduled run stays where it was. */
	runNow(id: string): Promise<IAgentScheduleRun | undefined>;
	/**
	 * A run started by a webhook delivery: `text` is the rendered prompt the agent reads, `display`
	 * what the transcript shows. `key` names the turn, so a delivery handled twice runs once.
	 */
	runFromWebhook(id: string, run: { readonly text: string; readonly display: string; readonly key: string; readonly deliveryId: string; readonly event?: string; readonly at: number }): Promise<IAgentScheduleRun>;
}

//#endregion

/** The models a scheduled run can use, from the catalog. */
export function scheduleModelChoices(catalog: readonly { readonly ref: string; readonly label: string; readonly enabled: boolean; readonly kind: string }[]): { readonly ref: string; readonly label: string }[] {
	// Agent-provider models (Cursor's Grok 4.7) are kind 'agent'; local ones are 'model'. Both can run a task.
	return catalog.filter(item => item.enabled && (item.kind === 'model' || item.kind === 'agent')).map(item => ({ ref: item.ref, label: item.label }));
}
