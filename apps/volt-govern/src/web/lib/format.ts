/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export { formatUsd } from '../../shared/pricing';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');

export function formatCount(n: number | null | undefined): string {
	if (n === null || n === undefined) {
		return '—';
	}
	return Math.abs(n) >= 10_000 ? compact.format(n) : whole.format(n);
}

export function formatMs(ms: number): string {
	return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string | null | undefined): string {
	if (!iso) {
		return 'never';
	}
	const diff = (Date.parse(iso) - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) {
		return 'just now';
	}
	if (abs < 3600) {
		return rtf.format(Math.round(diff / 60), 'minute');
	}
	if (abs < 86_400) {
		return rtf.format(Math.round(diff / 3600), 'hour');
	}
	if (abs < 30 * 86_400) {
		return rtf.format(Math.round(diff / 86_400), 'day');
	}
	return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) {
		return '—';
	}
	return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function isMac(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function keys(mac: string): string {
	return isMac() ? mac : mac.replace('⌃', 'Ctrl+').replace('⇧', 'Shift+').replace('⌥', 'Alt+').replace('⌘', 'Ctrl+');
}

/** A device platform as people say it: darwin → macOS, win32 → Windows. */
export function platformName(platform: string): string {
	return ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[platform] ?? platform;
}
