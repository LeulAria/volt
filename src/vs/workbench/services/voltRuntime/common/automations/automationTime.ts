/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wall-clock time in IANA zones, with Intl only (no time zone database of our own). A schedule's
 * times are read in its trigger's zone; the calendar draws in local time. Local time uses Date's
 * own getters, so a trigger without a zone behaves exactly as before zones existed.
 */

export interface IWallTime {
	readonly year: number;
	/** 1-12. */
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	/** 0 (Sunday) to 6. */
	readonly weekday: number;
}

export interface IWallClock {
	/** The IANA id, or undefined for local time. */
	readonly zone: string | undefined;
	parts(at: number): IWallTime;
	/**
	 * The moment the clock reads this. Values out of range carry over (hour 24 is the next day). A
	 * time skipped by daylight saving moves forward past the gap; a repeated one is its first pass.
	 */
	epoch(year: number, month: number, day: number, hour: number, minute: number): number;
	/** Minutes ahead of UTC at `at`. */
	offset(at: number): number;
}

const DAY_MS = 86_400_000;

const LOCAL_CLOCK: IWallClock = {
	zone: undefined,
	parts: at => {
		const date = new Date(at);
		return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), weekday: date.getDay() };
	},
	// Date does what IWallClock.epoch promises: a skipped time takes the offset before the gap (so it lands after it), a repeated one the earlier instant.
	epoch: (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime(),
	offset: at => -new Date(at).getTimezoneOffset(),
};

class ZonedClock implements IWallClock {

	private readonly format: Intl.DateTimeFormat;

	constructor(readonly zone: string) {
		this.format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
	}

	parts(at: number): IWallTime {
		let year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0;
		for (const part of this.format.formatToParts(at)) {
			switch (part.type) {
				case 'year': year = Number(part.value); break;
				case 'month': month = Number(part.value); break;
				case 'day': day = Number(part.value); break;
				// Older engines print midnight as 24 even with h23.
				case 'hour': hour = Number(part.value) % 24; break;
				case 'minute': minute = Number(part.value); break;
				case 'second': second = Number(part.value); break;
			}
		}
		return { year, month, day, hour, minute, second, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
	}

	offset(at: number): number {
		const p = this.parts(at);
		const whole = at - (((at % 1000) + 1000) % 1000);
		return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / 60_000);
	}

	epoch(year: number, month: number, day: number, hour: number, minute: number): number {
		const wall = Date.UTC(year, month - 1, day, hour, minute);
		// The offsets a day either side: they differ only when a change is near.
		const before = this.offset(wall - DAY_MS);
		const after = this.offset(wall + DAY_MS);
		if (before === after) {
			return wall - before * 60_000;
		}
		let first: number | undefined;
		for (const offset of [before, after]) {
			const candidate = wall - offset * 60_000;
			if (this.offset(candidate) === offset && (first === undefined || candidate < first)) {
				first = candidate;
			}
		}
		// No instant reads this (the clock jumped over it): the offset before the jump lands just past the gap.
		return first ?? wall - before * 60_000;
	}
}

const clocks = new Map<string, IWallClock>();
const validity = new Map<string, boolean>();
let localZoneCache: { readonly zone: string; readonly at: number } | undefined;

/** The machine's zone ("Europe/Berlin"); re-read at most once a minute, in case the machine travels. */
export function localTimeZone(): string {
	const now = Date.now();
	if (!localZoneCache || now - localZoneCache.at > 60_000) {
		let zone = 'UTC';
		try {
			zone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		} catch {
			// Keep UTC.
		}
		localZoneCache = { zone, at: now };
	}
	return localZoneCache.zone;
}

export function isValidTimeZone(zone: string): boolean {
	let valid = validity.get(zone);
	if (valid === undefined) {
		try {
			valid = !!zone.trim() && !!new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
		} catch {
			valid = false;
		}
		validity.set(zone, valid);
	}
	return valid;
}

/** No zone, or the machine's own: Date's getters read it. */
export function isLocalTimeZone(zone: string | undefined): boolean {
	return !zone || zone === localTimeZone();
}

/** The clock of a zone; local time when the zone is absent, the machine's own, or unknown. */
export function wallClock(zone?: string): IWallClock {
	if (isLocalTimeZone(zone) || !isValidTimeZone(zone!)) {
		return LOCAL_CLOCK;
	}
	let clock = clocks.get(zone!);
	if (!clock) {
		clock = new ZonedClock(zone!);
		clocks.set(zone!, clock);
	}
	return clock;
}

/** A calendar day with overflow carried (day 32 is the next month's first), by date arithmetic alone: no zone, no daylight saving. */
export function civilDay(year: number, month: number, day: number): { readonly year: number; readonly month: number; readonly day: number; readonly weekday: number } {
	const date = new Date(Date.UTC(year, month - 1, day));
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

/** "GMT+4", "GMT-5:30", "GMT" for an offset in minutes. */
export function formatGmtOffset(offset: number): string {
	if (offset === 0) {
		return 'GMT';
	}
	const sign = offset > 0 ? '+' : '-';
	const hours = Math.floor(Math.abs(offset) / 60);
	const minutes = Math.abs(offset) % 60;
	return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** "Berlin", "New York", "Buenos Aires", "UTC". */
export function timeZoneCity(zone: string): string {
	const last = zone.split('/').pop() ?? zone;
	return last.replace(/_/g, ' ');
}

/** "GMT+1 · Berlin": the zone's offset at `at` and its city. */
export function timeZoneLabel(zone: string, at: number): string {
	const offset = formatGmtOffset(wallClock(zone).offset(at));
	const city = timeZoneCity(zone);
	return city === 'UTC' || city === offset ? offset : `${offset} · ${city}`;
}

/** Zones most teams schedule in, west to east; listed before the full list. */
export const COMMON_TIME_ZONES: readonly string[] = [
	'UTC',
	'Pacific/Honolulu',
	'America/Anchorage',
	'America/Los_Angeles',
	'America/Denver',
	'America/Chicago',
	'America/New_York',
	'America/Sao_Paulo',
	'Europe/London',
	'Europe/Lisbon',
	'Europe/Berlin',
	'Europe/Paris',
	'Africa/Lagos',
	'Africa/Cairo',
	'Africa/Johannesburg',
	'Europe/Istanbul',
	'Africa/Nairobi',
	'Europe/Moscow',
	'Asia/Dubai',
	'Asia/Karachi',
	'Asia/Kolkata',
	'Asia/Bangkok',
	'Asia/Singapore',
	'Asia/Shanghai',
	'Asia/Tokyo',
	'Australia/Sydney',
	'Pacific/Auckland',
];

const FALLBACK_TIME_ZONES: readonly string[] = [
	...COMMON_TIME_ZONES,
	'America/Phoenix', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Halifax',
	'Atlantic/Reykjavik', 'Europe/Dublin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo',
	'Europe/Copenhagen', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv', 'Asia/Jerusalem', 'Asia/Riyadh', 'Africa/Addis_Ababa', 'Asia/Tehran',
	'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Manila', 'Asia/Seoul', 'Australia/Perth', 'Australia/Adelaide',
	'Australia/Brisbane', 'Australia/Melbourne',
];

let zoneList: readonly string[] | undefined;

/** Every zone this engine knows (Intl.supportedValuesOf), else a list of the usual ones. Sorted, UTC first. */
export function timeZoneList(): readonly string[] {
	if (!zoneList) {
		let zones: string[] = [];
		try {
			zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
		} catch {
			zones = [];
		}
		const all = new Set(zones.length ? zones : FALLBACK_TIME_ZONES);
		all.delete('UTC');
		zoneList = ['UTC', ...[...all].sort()];
	}
	return zoneList;
}
