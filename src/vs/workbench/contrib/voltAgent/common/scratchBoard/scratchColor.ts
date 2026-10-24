/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Board colours are stored as they look on a light board. A dark board shows each one through
 * the same transform Excalidraw's dark mode applies with CSS (`invert(93%) hue-rotate(180deg)`),
 * computed here per colour so images and the UI around the board are left alone.
 */

interface IRgba {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

const NAMED: Readonly<Record<string, string>> = {
	black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
	orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
};

export function parseColor(input: string): IRgba | undefined {
	const value = (NAMED[input.trim().toLowerCase()] ?? input).trim();
	let m = /^#([0-9a-f]{3,8})$/i.exec(value);
	if (m) {
		const hex = m[1];
		if (hex.length === 3 || hex.length === 4) {
			const r = parseInt(hex[0] + hex[0], 16), g = parseInt(hex[1] + hex[1], 16), b = parseInt(hex[2] + hex[2], 16);
			const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
			return { r, g, b, a };
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
			const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
			return { r, g, b, a };
		}
		return undefined;
	}
	m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value);
	if (m) {
		const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		return { r: clampByte(+m[1]), g: clampByte(+m[2]), b: clampByte(+m[3]), a: Math.max(0, Math.min(1, alpha)) };
	}
	return undefined;
}

function clampByte(v: number): number {
	return Math.max(0, Math.min(255, Math.round(v)));
}

function hex2(v: number): string {
	return clampByte(v).toString(16).padStart(2, '0');
}

export function formatColor(c: IRgba): string {
	const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
	return c.a >= 1 ? base : `${base}${hex2(c.a * 255)}`;
}

/** `#rrggbb` (or `#rrggbbaa`), lower case; unknown input passes through unchanged. */
export function normalizeColor(input: string): string {
	if (input === 'transparent') {
		return input;
	}
	const c = parseColor(input);
	return c ? formatColor(c) : input;
}

export function isValidColor(input: string): boolean {
	return input === 'transparent' || parseColor(input) !== undefined;
}

const darkCache = new Map<string, string>();

/** The colour as a dark board shows it. */
export function darkModeColor(input: string): string {
	if (input === 'transparent' || input === 'none') {
		return input;
	}
	const cached = darkCache.get(input);
	if (cached) {
		return cached;
	}
	const c = parseColor(input);
	if (!c) {
		return input;
	}
	// invert(93%): v' = a + v(1 - 2a), clamped.
	const amount = 0.93;
	const inv = (v: number) => Math.max(0, Math.min(1, amount + (v / 255) * (1 - 2 * amount)));
	const r = inv(c.r), g = inv(c.g), b = inv(c.b);
	// hue-rotate(180deg) colour matrix (cos = -1, sin = 0), clamped.
	const r2 = Math.max(0, Math.min(1, -0.574 * r + 1.43 * g + 0.144 * b));
	const g2 = Math.max(0, Math.min(1, 0.426 * r + 0.43 * g + 0.144 * b));
	const b2 = Math.max(0, Math.min(1, 0.426 * r + 1.43 * g - 0.856 * b));
	const out = formatColor({ r: r2 * 255, g: g2 * 255, b: b2 * 255, a: c.a });
	if (darkCache.size > 2000) {
		darkCache.clear();
	}
	darkCache.set(input, out);
	return out;
}

/** Relative luminance 0..1, for picking readable text on a colour. */
export function luminance(input: string): number {
	const c = parseColor(input);
	if (!c) {
		return 1;
	}
	const ch = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function withAlpha(input: string, alpha: number): string {
	const c = parseColor(input);
	return c ? formatColor({ ...c, a: Math.max(0, Math.min(1, alpha)) }) : input;
}
