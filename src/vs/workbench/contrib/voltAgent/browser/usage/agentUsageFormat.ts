/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeIntl } from '../../../../../base/common/date.js';
import { language } from '../../../../../base/common/platform.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const usd = safeIntl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = safeIntl.NumberFormat(language, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** `$1,189.37`; a non-zero amount under a cent reads `<$0.01` rather than `$0.00`. */
export function formatCost(value: number): string {
	if (value > 0 && value < 0.005) {
		return `<${usd.value.format(0.01)}`;
	}
	return usd.value.format(value);
}

/** Axis labels: `$400`, or cents when the whole scale is under a dollar. */
export function formatCostTick(value: number, step: number): string {
	return step >= 1 ? usdWhole.value.format(value) : usd.value.format(value);
}

/** Three significant digits with a unit: 980, 208K, 28.5M, 3.58B. */
export function formatTokens(value: number): string {
	const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
	for (const [size, unit] of units) {
		if (Math.abs(value) >= size) {
			const scaled = value / size;
			const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
			return `${Number(scaled.toFixed(digits))}${unit}`;
		}
	}
	return String(Math.round(value));
}

export function formatShare(part: number, whole: number): string {
	if (whole <= 0 || part <= 0) {
		return '—';
	}
	const share = (part / whole) * 100;
	if (share < 0.1) {
		return '<0.1%';
	}
	return `${share >= 99.95 ? 100 : Number(share.toFixed(1))}%`;
}

/** Whole percent, `<1%` for a sliver, so 0.4% left never rounds to an alarming 0%. */
export function formatPercent(value: number): string {
	if (value > 0 && value < 1) {
		return '<1%';
	}
	if (value < 100 && value > 99) {
		return '99%';
	}
	return `${Math.round(value)}%`;
}

/** Countdown as the limits page shows it: `7m`, `2h 5m`, `3d 17h`. */
export function formatDuration(ms: number): string {
	if (ms < MINUTE_MS) {
		return '<1m';
	}
	if (ms < HOUR_MS) {
		return `${Math.round(ms / MINUTE_MS)}m`;
	}
	if (ms < DAY_MS) {
		const hours = Math.floor(ms / HOUR_MS);
		const minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
		return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY_MS);
	const hours = Math.round((ms - days * DAY_MS) / HOUR_MS);
	return hours ? `${days}d ${hours}h` : `${days}d`;
}

const dayFormat = safeIntl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric' });
const axisDayFormat = safeIntl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
const hourFormat = safeIntl.DateTimeFormat(language, { hour: 'numeric' });
const hourRangeFormat = safeIntl.DateTimeFormat(language, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const weekdayFormat = safeIntl.DateTimeFormat(language, { weekday: 'short' });
const timeFormat = safeIntl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' });
const resetFormat = safeIntl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** `Fri, Oct 3`. */
export function formatDay(ms: number): string {
	return dayFormat.value.format(ms);
}

/** `Sep 4` for daily axes, `10 AM` for hourly ones. */
export function formatAxis(ms: number, hourly: boolean): string {
	return hourly ? hourFormat.value.format(ms) : axisDayFormat.value.format(ms);
}

/** Tooltip heading for one slot: `Fri, Oct 3`, or `Fri 10:00 AM – 11:00 AM`. */
export function formatSlot(ms: number, hourly: boolean): string {
	if (!hourly) {
		return formatDay(ms);
	}
	return `${hourRangeFormat.value.format(ms)} – ${hourFormat.value.format(ms + HOUR_MS)}`;
}

/** `Tue, Oct 7, 5:00 PM`. */
export function formatResetTime(ms: number): string {
	return resetFormat.value.format(ms);
}

/** `Mon`. */
export function formatWeekday(ms: number): string {
	return weekdayFormat.value.format(ms);
}

/** `11:00 AM`. */
export function formatTime(ms: number): string {
	return timeFormat.value.format(ms);
}
