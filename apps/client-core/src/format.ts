/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IUriLike } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** "now", "4m", "3h", "Yesterday", "Tue", "Sep 3" (list rows). */
export function relativeTime(at: number | undefined, now = Date.now()): string {
	if (!at) {
		return '';
	}
	const diff = now - at;
	if (diff < 45_000) {
		return 'now';
	}
	if (diff < HOUR) {
		return `${Math.max(1, Math.round(diff / MINUTE))}m`;
	}
	const today = startOfDay(now);
	if (at >= today) {
		return `${Math.round(diff / HOUR)}h`;
	}
	if (at >= today - DAY) {
		return 'Yesterday';
	}
	if (at >= today - 6 * DAY) {
		return WEEKDAYS[new Date(at).getDay()];
	}
	const d = new Date(at);
	return new Date(now).getFullYear() === d.getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "2:41 PM" */
export function clockTime(at: number | undefined): string {
	if (!at) {
		return '';
	}
	const d = new Date(at);
	const h = d.getHours();
	const m = d.getMinutes();
	return `${h % 12 || 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "8s", "2m 14s", "1h 3m" */
export function duration(ms: number | undefined): string {
	if (ms === undefined || ms < 0 || !Number.isFinite(ms)) {
		return '';
	}
	const s = Math.round(ms / 1000);
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	if (m < 60) {
		const rest = s % 60;
		return rest ? `${m}m ${rest}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** "0:42", "12:05" (a live working timer). */
export function timer(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = h ? String(m).padStart(2, '0') : String(m);
	return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** "980", "12.4k", "1.2M" */
export function compactNumber(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) {
		return '';
	}
	if (n < 1000) {
		return String(Math.round(n));
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function money(usd: number | undefined): string {
	if (usd === undefined || !Number.isFinite(usd)) {
		return '';
	}
	return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(usd < 1 ? 2 : 2)}`;
}

export function basename(path: string | undefined): string {
	if (!path) {
		return '';
	}
	const clean = path.replace(/[\\/]+$/, '');
	const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
	return i >= 0 ? clean.slice(i + 1) : clean;
}

export function dirname(path: string | undefined): string {
	if (!path) {
		return '';
	}
	const clean = path.replace(/[\\/]+$/, '');
	const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
	return i > 0 ? clean.slice(0, i) : '';
}

/** `~/code/volt/src/app.ts` with the home folder folded and the middle cut when long. */
export function shortPath(path: string | undefined, max = 48): string {
	if (!path) {
		return '';
	}
	let p = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
	if (p.length <= max) {
		return p;
	}
	const parts = p.split('/');
	const tail = parts.slice(-2).join('/');
	p = `${parts[0] || ''}/…/${tail}`;
	return p.length <= max ? p : `…${p.slice(-max + 1)}`;
}

export function uriPath(uri: IUriLike | string | undefined): string | undefined {
	if (!uri) {
		return undefined;
	}
	if (typeof uri === 'string') {
		if (uri.startsWith('file://')) {
			try {
				return decodeURIComponent(new URL(uri).pathname);
			} catch {
				return uri;
			}
		}
		return uri;
	}
	return uri.fsPath ?? uri.path;
}

/** A `file` URI as the server revives it (`$mid` 1 is VS Code's marshalled URI). */
export function fileUri(path: string): IUriLike {
	return { $mid: 1, scheme: 'file', authority: '', path: path.startsWith('/') ? path : `/${path}` };
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** First line of a text, trimmed to `max` characters. */
export function firstLine(text: string | undefined, max = 140): string {
	if (!text) {
		return '';
	}
	const line = text.trim().split('\n').find(l => l.trim()) ?? '';
	const clean = line.replace(/^[#>*\-\s]+/, '').replace(/[`*_~]/g, '').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
