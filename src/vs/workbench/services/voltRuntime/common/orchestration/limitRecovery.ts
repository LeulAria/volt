/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isUsageLimitText } from '../acpNotices.js';
import type { IOrchLimitStop } from './orchestrator.js';

/**
 * Usage-limit recovery: a turn stopped because the provider's usage limit was reached. The chat
 * can resume itself when the limit resets ("Continue where you left off.") and can be snoozed
 * until then. Modeled on T3 Code's usage-limit recovery banner. Pure: the agent server's
 * orchestrator, the desktop, the web app and the mobile app all use it.
 */

/** What the chat is sent when its limit resets. */
export const LIMIT_RESUME_TEXT = 'Continue where you left off.';

/** The command and turn id of the resume for one limited turn, so it is sent once. */
export function limitResumeTurnId(threadId: string, turnId: string): string {
	return `limit-resume:${threadId}:${turnId}`;
}

/** A runtime notice or error that means the provider's usage limit stopped the run. */
export function isUsageLimitStop(event: { readonly type: string; readonly severity?: string; readonly title?: string; readonly description?: string; readonly message?: string }): boolean {
	if (event.type === 'error') {
		return isUsageLimitText(event.message);
	}
	// Warnings ("Usage limit warning", Cursor's plan wall that Volt retries on another model) do not stop the run.
	return event.type === 'notice' && event.severity === 'error' && isUsageLimitText(`${event.title ?? ''}\n${event.description ?? ''}`);
}

//#region Reset time

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "resets 12:40am (Asia/Dubai)", "resets Oct 7, 3pm", "resets at 15:00", "resets 3:20 AM". */
const CLOCK_RESET = /\bresets?\s+(?:on\s+)?(?:(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>[ap]\.?m\.?)?(?:\s*\((?<zone>[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*|UTC|GMT)\))?/i;
/** "try again in 2h 30m", "resets in 45 minutes", "in 5 hours". */
const RELATIVE_RESET = /\b(?:resets?|try again|retry|available again)\s+in\s+(?<amount>(?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*(?:and\s+|,\s*)?)+)/i;

/**
 * When a provider's usage limit resets, read from the sentence it showed. Times without a date
 * are the next such time; a time zone in parentheses is the provider's (Claude prints the user's
 * own), otherwise `timeZone`, otherwise this machine's.
 */
export function parseUsageLimitReset(text: string | undefined, now: number, timeZone?: string): number | undefined {
	if (!text) {
		return undefined;
	}
	const relative = RELATIVE_RESET.exec(text);
	if (relative?.groups) {
		const ms = parseDuration(relative.groups.amount);
		return ms > 0 ? now + ms : undefined;
	}
	const clock = CLOCK_RESET.exec(text);
	if (!clock?.groups) {
		return undefined;
	}
	const { month, day, hour, minute, ampm, zone } = clock.groups;
	let h = Number(hour);
	const m = minute ? Number(minute) : 0;
	// A bare number ("resets 5") is not a time; "resets 15:00" and "resets 5pm" are.
	if ((!minute && !ampm) || h > 23 || m > 59) {
		return undefined;
	}
	if (ampm) {
		if (h < 1 || h > 12) {
			return undefined;
		}
		const pm = ampm[0].toLowerCase() === 'p';
		h = h % 12 + (pm ? 12 : 0);
	}
	const tz = validTimeZone(zone) ?? validTimeZone(timeZone);
	const today = zonedParts(now, tz);
	if (month && day) {
		const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
		let at = zonedToEpoch(today.year, monthIndex, Number(day), h, m, tz);
		// "Jan 2" read on Dec 30 is next year's.
		if (at < now - 86_400_000) {
			at = zonedToEpoch(today.year + 1, monthIndex, Number(day), h, m, tz);
		}
		return at;
	}
	let at = zonedToEpoch(today.year, today.month, today.day, h, m, tz);
	// The time already passed today: it means tomorrow (a minute of slack for clock skew).
	if (at <= now - 60_000) {
		at = zonedToEpoch(today.year, today.month, today.day + 1, h, m, tz);
	}
	return at;
}

/** Epoch seconds or milliseconds, an ISO date, or nothing. */
export function readResetTime(value: unknown): number | undefined {
	if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	return n > 1e12 ? n : n * 1000;
}

function parseDuration(text: string): number {
	let ms = 0;
	for (const match of text.matchAll(/(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)/gi)) {
		const n = Number(match[1]);
		const unit = match[2][0].toLowerCase();
		ms += n * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000);
	}
	return ms;
}

function validTimeZone(zone: string | undefined): string | undefined {
	if (!zone) {
		return undefined;
	}
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return zone;
	} catch {
		return undefined;
	}
}

interface IZonedParts { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number }

function zonedParts(epoch: number, timeZone: string | undefined): IZonedParts {
	const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(epoch));
	const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value ?? 0);
	return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** The instant a wall-clock time happens in a time zone (DST-correct to the minute). */
function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string | undefined): number {
	const wall = Date.UTC(year, month, day, hour, minute);
	const offsetAt = (epoch: number) => {
		const p = zonedParts(epoch, timeZone);
		return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000;
	};
	let at = wall - offsetAt(wall);
	at = wall - offsetAt(at);
	return at;
}

//#endregion

//#region Banner

export interface ILimitRecoveryView {
	readonly title: string;
	/** "Resets today at 4:10 AM · in 2h 10m", or why it cannot be scheduled. */
	readonly description: string;
	/** Resume and snooze are offered (the reset time is known). */
	readonly canSchedule: boolean;
	readonly autoResume: boolean;
	readonly snoozed: boolean;
	/** The reset passed: snoozing makes no sense, resuming happens right away. */
	readonly resetPassed: boolean;
	readonly resumeLabel: string;
	readonly snoozeLabel: string;
}

export interface ILimitRecoverySessionMeta {
	readonly snoozed?: boolean;
	readonly snoozedUntil?: number;
}

/**
 * The banner above the composer for a limited chat. `session` is the chat's history entry: a
 * snooze the user ended from the sidebar no longer shows as snoozed here.
 */
export function limitRecoveryView(limit: IOrchLimitStop, now: number, session?: ILimitRecoverySessionMeta, locale?: string): ILimitRecoveryView {
	const resetAt = limit.resetAt;
	const canSchedule = resetAt !== undefined;
	const resetPassed = resetAt !== undefined && resetAt <= now;
	const snoozed = !!limit.snooze && !resetPassed && (!session || (!!session.snoozed && session.snoozedUntil === resetAt));
	const autoResume = !!limit.autoResume;
	let description: string;
	if (resetAt === undefined) {
		description = 'Reset time unavailable; retry manually';
	} else if (resetPassed) {
		description = autoResume ? 'Limit reset; resuming…' : 'Limit reset; you can continue';
	} else {
		description = `Resets ${formatResetTime(resetAt, now, locale)} · in ${formatCountdown(resetAt - now)}`;
	}
	return {
		title: 'Usage limit reached',
		description,
		canSchedule,
		autoResume,
		snoozed,
		resetPassed,
		resumeLabel: autoResume ? 'Cancel auto-resume' : resetPassed ? 'Resume now' : 'Resume at reset',
		snoozeLabel: snoozed ? 'Unsnooze' : 'Snooze until reset',
	};
}

/** "4:10 AM", "tomorrow at 4:10 AM", "Oct 7 at 4:10 AM". */
export function formatResetTime(resetAt: number, now: number, locale?: string): string {
	const date = new Date(resetAt);
	const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
	const dayIndex = (epoch: number) => {
		const d = new Date(epoch);
		return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
	};
	const days = dayIndex(resetAt) - dayIndex(now);
	if (days === 0) {
		return `today at ${time}`;
	}
	if (days === 1) {
		return `tomorrow at ${time}`;
	}
	const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
	return `${day} at ${time}`;
}

/** "2h 10m", "45m", "under a minute". */
export function formatCountdown(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);
	if (minutes <= 1) {
		return ms < 60_000 ? 'under a minute' : '1m';
	}
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days) {
		return hours ? `${days}d ${hours}h` : `${days}d`;
	}
	return hours ? (mins ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
}

/** When the banner's text next changes (the countdown's next minute, or the reset itself). */
export function nextLimitViewChange(limit: IOrchLimitStop, now: number): number | undefined {
	if (limit.resetAt === undefined || limit.resetAt <= now) {
		return undefined;
	}
	const toReset = limit.resetAt - now;
	const toMinute = toReset % 60_000 || 60_000;
	return now + Math.min(toReset, toMinute) + 5;
}

//#endregion
