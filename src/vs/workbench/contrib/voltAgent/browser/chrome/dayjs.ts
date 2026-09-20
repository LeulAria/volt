/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export interface IDayjs {
	valueOf(): number;
	fromNow(): string;
}

/**
 * Compact dayjs-style relative time: "3m ago", "2d ago", "2h ago".
 */
export function dayjs(input?: number | Date): IDayjs {
	const value = toMs(input);
	return {
		valueOf: () => value,
		fromNow: () => fromNow(value),
	};
}

function toMs(input?: number | Date): number {
	if (input instanceof Date) {
		return input.getTime();
	}
	if (typeof input === 'number' && Number.isFinite(input)) {
		return input;
	}
	return Date.now();
}

function fromNow(value: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
	if (seconds < 10) {
		return 'just now';
	}
	if (seconds < MINUTE) {
		return `${seconds}s ago`;
	}
	if (seconds < HOUR) {
		return `${Math.floor(seconds / MINUTE)}m ago`;
	}
	if (seconds < DAY) {
		return `${Math.floor(seconds / HOUR)}h ago`;
	}
	if (seconds < WEEK) {
		const days = Math.floor(seconds / DAY);
		return days === 1 ? '1 day ago' : `${days}d ago`;
	}
	if (seconds < MONTH) {
		const weeks = Math.floor(seconds / WEEK);
		return weeks === 1 ? '1w ago' : `${weeks}w ago`;
	}
	if (seconds < YEAR) {
		const months = Math.floor(seconds / MONTH);
		return months === 1 ? '1mo ago' : `${months}mo ago`;
	}
	const years = Math.floor(seconds / YEAR);
	return years === 1 ? '1y ago' : `${years}y ago`;
}
