/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Usage-limit recovery. A turn the provider refused because the account ran out of usage is not a
 * failure the user has to babysit: the chat is parked with the reset time the provider named, the
 * sidebar shows it paused until then, and the orchestrator sends "continue where you left off" once
 * the limit resets. Unknown reset times are probed with a growing back-off; many chats waking at
 * the same reset go one after another, not in a burst.
 *
 * Modeled on T3 Code's UsageLimitRecoveryWorker (resume once per stop, never on a stale reset)
 * and Codex/Claude Code's own "resets 3:40 PM" wording. Everything here is pure: no clock reads
 * (callers pass `now`), so the decider and the tests agree.
 */

//#region Detection

/** A provider said the account is out of usage. `resetAt` is epoch ms when it named one. */
export interface ILimitSignal {
	readonly message: string;
	readonly resetAt?: number;
}

/**
 * Sentences providers stop a run with when the account is out of usage (Claude's synthetic
 * replies, Codex, Cursor, API 429 bodies, Gemini's RESOURCE_EXHAUSTED). Warnings ("You've used
 * 90% of your limit", "You're close to") and transient overload are not stops.
 */
const LIMIT_STOP = new RegExp([
	String.raw`\byou(?:'|\u2019)ve (?:hit|reached) your\b`,
	String.raw`\byou have (?:hit|reached) your\b`,
	String.raw`\b(?:usage|session|weekly|daily|monthly|spend|5-hour|five-hour|rate) limit (?:reached|exceeded|hit)\b`,
	String.raw`\b(?:hit|reached|exceeded) (?:the |your )?(?:usage|rate|session|spend|weekly) limit\b`,
	String.raw`\bout of (?:extra )?usage\b`,
	String.raw`\bout of usage credits\b`,
	String.raw`\bno available quota\b`,
	String.raw`\bquota (?:exceeded|exhausted)\b`,
	String.raw`\binsufficient_quota\b`,
	String.raw`\bresource_exhausted\b`,
	String.raw`\brate_limit_error\b`,
	String.raw`\btemporarily rate limited\b`,
	String.raw`\brate limit reached\b`,
	String.raw`\busage limit\b`,
].join('|'), 'i');

const LIMIT_WARNING = /^\s*(?:you(?:'|\u2019)ve used|you(?:'|\u2019)re close to|usage limit warning)\b/i;

/** Text that says the provider stopped the run because a usage or rate limit was reached. */
export function isLimitStopText(text: string | undefined): boolean {
	return !!text && !LIMIT_WARNING.test(text) && LIMIT_STOP.test(text);
}

/** A run's error message, when it is a usage-limit stop. */
export function limitFromError(message: string | undefined, now: number, timeZone?: string): ILimitSignal | undefined {
	if (!isLimitStopText(message)) {
		return undefined;
	}
	return withReset(clean(message!), parseLimitReset(message, now, timeZone));
}

/** A provider notice (`severity: error`), when it is a usage-limit stop. `resetAt` comes from structured rate-limit data. */
export function limitFromNotice(notice: { readonly severity: string; readonly title: string; readonly description?: string; readonly resetAt?: number }, now: number, timeZone?: string): ILimitSignal | undefined {
	const text = [notice.title, notice.description].filter(Boolean).join(' · ');
	if (notice.severity !== 'error' || !isLimitStopText(text)) {
		return undefined;
	}
	const resetAt = notice.resetAt !== undefined && notice.resetAt > now ? notice.resetAt : parseLimitReset(text, now, timeZone);
	return withReset(clean(text), resetAt);
}

/**
 * A reply that is nothing but the provider's limit sentence: Claude Code ends such a turn
 * normally with "You've hit your limit · resets 3pm" as the whole answer. Prose that discusses
 * limits is longer and does not start with the sentence.
 */
export function limitFromReply(reply: string | undefined, now: number, timeZone?: string): ILimitSignal | undefined {
	const text = reply?.trim();
	if (!text || text.length > 400 || !/^(?:you(?:'|\u2019)ve (?:hit|reached) your|you(?:'|\u2019)re out of|your (?:org|seat|group|usage)\b|claude (?:ai )?usage limit reached|usage limit reached)/i.test(text)) {
		return undefined;
	}
	return withReset(clean(text), parseLimitReset(text, now, timeZone));
}

/** The latest signal wins its wording when longer; the reset is the later one either named. */
export function mergeLimitSignals(previous: ILimitSignal | undefined, next: ILimitSignal): ILimitSignal {
	if (!previous) {
		return next;
	}
	const message = next.message.length >= previous.message.length ? next.message : previous.message;
	const resetAt = previous.resetAt !== undefined && next.resetAt !== undefined ? Math.max(previous.resetAt, next.resetAt) : previous.resetAt ?? next.resetAt;
	return withReset(message, resetAt);
}

function withReset(message: string, resetAt: number | undefined): ILimitSignal {
	return resetAt !== undefined ? { message, resetAt } : { message };
}

function clean(text: string): string {
	// "Claude AI usage limit reached|1760000000": the epoch is for machines.
	return text.replace(/\|\d{9,13}\s*$/, '').replace(/^(?:error:\s*)+/i, '').trim().slice(0, 500);
}

//#endregion

//#region Reset time

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "usage limit reached|1760000000" (Claude's older form). */
const EPOCH_SUFFIX = /\|(\d{9,13})\s*$/;
/** "resets at 2026-10-08T15:40:00Z". */
const ISO_RESET = /\b(?:resets?|try again|retry|available)(?:\s+again)?\s+(?:at|on|after)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i;
/** "try again in 2h 30m", "in 4 days 3 hours 2 minutes", "retry in 23.5s", "reset after 1h2m3s". */
const RELATIVE_RESET = /\b(?:resets?|try again|retry|available again|wait)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i;
/** "resets 3pm", "resets 12:40am (Asia/Dubai)", "resets Oct 7, 3pm", "try again at 3:05 PM", "resets at 15:00". */
const CLOCK_RESET = /\b(?:resets?|try again|retry|available again)\s+(?:on\s+)?(?:(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>[ap]\.?m\.?)?(?:\s*\((?<zone>[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*|UTC|GMT)\))?/i;

/**
 * When the limit resets, read from the provider's sentence. A clock time without a date is the
 * next such time; a zone in parentheses is the provider's (Claude prints the user's own),
 * otherwise `timeZone`, otherwise this machine's. A time already past is no reset at all.
 */
export function parseLimitReset(text: string | undefined, now: number, timeZone?: string): number | undefined {
	if (!text) {
		return undefined;
	}
	const epoch = EPOCH_SUFFIX.exec(text);
	if (epoch) {
		const n = Number(epoch[1]);
		const at = n > 1e12 ? n : n * 1000;
		return at > now ? at : undefined;
	}
	const iso = ISO_RESET.exec(text);
	if (iso) {
		const at = Date.parse(iso[1]);
		return Number.isFinite(at) && at > now ? at : undefined;
	}
	const relative = RELATIVE_RESET.exec(text);
	if (relative) {
		const ms = parseDuration(relative[1]);
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
		h = h % 12 + (ampm[0].toLowerCase() === 'p' ? 12 : 0);
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
		return at > now ? at : undefined;
	}
	let at = zonedToEpoch(today.year, today.month, today.day, h, m, tz);
	// Already past today (a minute of slack for clock skew): it means tomorrow.
	if (at <= now - 60_000) {
		at = zonedToEpoch(today.year, today.month, today.day + 1, h, m, tz);
	}
	return at > now - 60_000 ? at : undefined;
}

/** Epoch seconds or milliseconds (rate-limit payloads), as epoch ms. */
export function epochMs(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : undefined;
}

function parseDuration(text: string): number {
	let ms = 0;
	for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/gi)) {
		const n = Number(match[1]);
		const unit = match[2].toLowerCase();
		ms += n * (unit.startsWith('d') ? 86_400_000 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000);
	}
	return Math.round(ms);
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
	const first = wall - offsetAt(wall);
	return wall - offsetAt(first);
}

//#endregion

//#region Scheduling

/** After the reset the provider's own clock may lag a little; resuming at the exact second hits the limit again. */
export const LIMIT_RESET_GRACE_MS = 20_000;
/** Chats that wake at the same reset go this far apart. */
export const LIMIT_STAGGER_MS = 15_000;
/** Probes for a limit with no reset time: one minute, then doubling-ish up to an hour. */
export const LIMIT_PROBE_BACKOFF_MS: readonly number[] = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000, 60 * 60_000];
/** Automatic resumes one stop gets before the chat waits for the user (about half a day of probing). */
export const LIMIT_MAX_PROBES = 16;

export const LIMIT_AUTO_RESUME_SETTING = 'volt.agent.autoResumeAfterLimit';

/** What the decider knows about a parked chat (see `IOrchLimitPark`). */
export interface ILimitPark {
	readonly at: number;
	readonly resetAt?: number;
	/** Automatic resumes already sent for this stop. */
	readonly probes: number;
	/** The user's choice for this chat: false cancelled the resume, true asked for it with the setting off. */
	readonly auto?: boolean;
	/** A stagger slot: not before this. */
	readonly notBefore?: number;
}

/** The chat resumes on its own: its own choice, else the setting. */
export function limitAutoResumes(limit: ILimitPark, autoDefault: boolean): boolean {
	return (limit.auto ?? autoDefault) && limit.probes < LIMIT_MAX_PROBES;
}

/** The probe delay after `probes` failed probes. */
export function limitBackoff(probes: number): number {
	return LIMIT_PROBE_BACKOFF_MS[Math.min(Math.max(0, probes), LIMIT_PROBE_BACKOFF_MS.length - 1)];
}

/**
 * When the chat may resume: the reset plus grace, or (no reset known) the stop plus the back-off,
 * never before its stagger slot. A reset that passed long ago still counts: resume now.
 */
export function limitDueAt(limit: ILimitPark): number {
	const base = limit.resetAt !== undefined ? limit.resetAt + LIMIT_RESET_GRACE_MS : limit.at + limitBackoff(limit.probes);
	return Math.max(base, limit.notBefore ?? 0);
}

/** The model-facing text of the turn that continues a chat after its limit reset. */
export const LIMIT_RESUME_TEXT = '[Volt] Your usage limit has reset, so the request above was not finished. Continue where you left off: check what is already done (files, git status, command output) before redoing anything, then finish the work.';

/** The transcript row of that turn. */
export function limitResumeDisplay(manual: boolean): { readonly text: string; readonly notification: true } {
	return { text: manual ? 'Continued after the usage limit' : 'Continued after the usage limit reset', notification: true };
}

/** One resume per stop and probe, so a retried tick never sends it twice. */
export function limitResumeTurnId(turnId: string, probe: number): string {
	return `${turnId.replace(/~l\d+$/, '')}~l${probe}`;
}

//#endregion

//#region Banner

export interface ILimitBannerView {
	readonly title: string;
	/** "resumes at 3:40 PM (in 1h 12m)", "checking again at 3:12 PM (in 4m)", "auto-resume is off". */
	readonly detail: string;
	/** The chat resumes on its own. */
	readonly auto: boolean;
	/** The reset passed and the resume is about to go (or waits for its stagger slot). */
	readonly due: boolean;
	/** Text of the toggle: "Cancel" while auto, "Resume at reset" otherwise. */
	readonly toggleLabel: string;
	readonly resetKnown: boolean;
}

/**
 * The banner above the composer of a parked chat, and the sidebar's shorter label. `auto` is the
 * effective choice (`limitAutoResumes`).
 */
export function limitBannerView(limit: ILimitPark, now: number, auto: boolean, locale?: string): ILimitBannerView {
	const due = limitDueAt(limit);
	const resetKnown = limit.resetAt !== undefined;
	const gaveUp = limit.probes >= LIMIT_MAX_PROBES;
	let detail: string;
	if (auto && due <= now) {
		detail = 'resuming now…';
	} else if (auto) {
		detail = resetKnown
			? `resumes at ${formatClock(due, now, locale)} (in ${formatCountdown(due - now)})`
			: `checking again at ${formatClock(due, now, locale)} (in ${formatCountdown(due - now)})`;
	} else if (resetKnown && limit.resetAt! > now) {
		detail = `resets at ${formatClock(limit.resetAt!, now, locale)} (in ${formatCountdown(limit.resetAt! - now)}) · auto-resume off`;
	} else if (resetKnown) {
		detail = 'the limit has reset';
	} else {
		detail = gaveUp ? 'still limited after several checks · resume when you are ready' : 'reset time unknown · auto-resume off';
	}
	return {
		title: 'Usage limit reached',
		detail,
		auto,
		due: due <= now,
		toggleLabel: auto ? 'Cancel' : resetKnown ? 'Resume at reset' : 'Keep checking',
		resetKnown,
	};
}

/**
 * The parked-until time and the countdown for one parked chat, computed once from one clock reading.
 * The banner and the sidebar badge both take their numbers from here, so they cannot disagree.
 */
export interface ILimitParkedClock {
	/** The chat resumes on its own (`limitAutoResumes`). */
	readonly auto: boolean;
	/** When the chat resumes: the reset plus grace and stagger, or the next probe (`limitDueAt`). */
	readonly dueAt: number;
	/** Milliseconds until `dueAt`, 0 once it has passed. */
	readonly remainingMs: number;
}

export function limitParkedClock(limit: ILimitPark, autoDefault: boolean, now: number): ILimitParkedClock {
	const dueAt = limitDueAt(limit);
	return { auto: limitAutoResumes(limit, autoDefault), dueAt, remainingMs: Math.max(0, dueAt - now) };
}

/** The sidebar badge: "Resumes 3:40 PM", "Limit · 4m". */
export function limitBadgeLabel(limit: ILimitPark, now: number, auto: boolean, locale?: string): string {
	if (!auto) {
		return 'Limit reached';
	}
	const due = limitDueAt(limit);
	if (due <= now) {
		return 'Resuming';
	}
	return due - now < 3_600_000 ? `Resumes in ${formatCountdown(due - now)}` : `Resumes ${formatClock(due, now, locale)}`;
}

/** "3:40 PM", "tomorrow 3:40 PM", "Oct 9, 3:40 PM". */
export function formatClock(at: number, now: number, locale?: string): string {
	const date = new Date(at);
	const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
	const dayIndex = (epoch: number) => {
		const d = new Date(epoch);
		return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
	};
	const days = dayIndex(at) - dayIndex(now);
	if (days === 0) {
		return time;
	}
	if (days === 1) {
		return `tomorrow ${time}`;
	}
	return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)}, ${time}`;
}

/** "1h 12m", "45m", "2d 3h", "under a minute". */
export function formatCountdown(ms: number): string {
	if (ms < 60_000) {
		return 'under a minute';
	}
	const minutes = Math.ceil(ms / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days) {
		return hours ? `${days}d ${hours}h` : `${days}d`;
	}
	return hours ? (mins ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;
}

/** When a countdown's text next changes: the next whole minute before the due time, or the due time. */
export function nextBannerTick(dueAt: number, now: number): number | undefined {
	if (dueAt <= now) {
		return undefined;
	}
	const left = dueAt - now;
	const toMinute = left % 60_000 || 60_000;
	return now + Math.min(left, toMinute) + 50;
}

//#endregion
