/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A project's icon in the agent sidebar and its rail:
 * - `monogram`: one or two letters on a colored tile; both are derived from the name unless set.
 * - `codicon`: a product icon, optionally tinted.
 * - `image`: a picture the user picked, kept as a small data URL.
 */
export type VoltProjectIcon =
	| { readonly kind: 'monogram'; readonly letters?: string; readonly color?: string }
	| { readonly kind: 'codicon'; readonly id: string; readonly color?: string }
	| { readonly kind: 'image'; readonly dataUrl: string };

/** Tile colors for monograms: muted enough for the translucent sidebar, distinct from each other. */
export const PROJECT_MONOGRAM_COLORS: readonly string[] = [
	'#5b8def', // blue
	'#8b6cf0', // violet
	'#c062c9', // magenta
	'#e0607e', // rose
	'#e57a45', // orange
	'#d4a52c', // amber
	'#5aa864', // green
	'#2fa59a', // teal
	'#3c9fcf', // sky
	'#7c8796', // slate
];

/** Largest image kept for a project icon, in pixels per side. */
export const PROJECT_ICON_IMAGE_SIZE = 64;

/**
 * One or two letters from a project name: the first letters of its first two words ("beta-site"
 * → "BS", "myProject" → "MP"), or the first letter of a single word ("volt" → "V").
 */
export function deriveProjectMonogram(name: string): string {
	const words = projectNameWords(name);
	if (!words.length) {
		return '?';
	}
	const first = firstGrapheme(words[0]);
	const second = words.length > 1 ? firstGrapheme(words[1]) : '';
	return (first + second).toLocaleUpperCase();
}

/** Words of a name split at separators, case changes ("myProject") and letter/digit edges are kept. */
export function projectNameWords(name: string): string[] {
	const base = name.trim().replace(/\.(git|code-workspace)$/i, '');
	return base
		.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
		.split(/[^\p{L}\p{N}]+/u)
		.filter(word => word.length > 0);
}

function firstGrapheme(word: string): string {
	return Array.from(word)[0] ?? '';
}

/** A stable color for a name (FNV-1a over its lowercased text). */
export function deriveProjectColor(name: string): string {
	let hash = 0x811c9dc5;
	for (const char of name.trim().toLowerCase()) {
		hash ^= char.codePointAt(0)!;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return PROJECT_MONOGRAM_COLORS[hash % PROJECT_MONOGRAM_COLORS.length];
}

/** Letters the user typed: at most two characters, trimmed; empty means derive them. */
export function normalizeMonogramLetters(value: string | undefined): string | undefined {
	const letters = Array.from((value ?? '').replace(/\s+/g, '')).slice(0, 2).join('');
	return letters ? letters.toLocaleUpperCase() : undefined;
}

/** `#rgb` or `#rrggbb`, lowercased; anything else is dropped. */
export function normalizeProjectColor(value: string | undefined): string | undefined {
	const color = value?.trim().toLowerCase();
	if (!color || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(color)) {
		return undefined;
	}
	return color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color;
}

/** Text color that reads on a tile of this color: white unless the tile is light. */
export function monogramTextColor(background: string): string {
	const hex = normalizeProjectColor(background);
	if (!hex) {
		return '#ffffff';
	}
	const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.5 ? '#1f2328' : '#ffffff';
}

/** What a monogram tile shows: the stored letters and color, or the ones derived from the name. */
export function resolveMonogram(name: string, icon: VoltProjectIcon | undefined): { readonly letters: string; readonly color: string } {
	const stored = icon?.kind === 'monogram' ? icon : undefined;
	return {
		letters: normalizeMonogramLetters(stored?.letters) ?? deriveProjectMonogram(name),
		color: normalizeProjectColor(stored?.color) ?? deriveProjectColor(name),
	};
}

/** Checks a stored value; anything malformed is dropped rather than drawn. */
export function reviveProjectIcon(value: unknown): VoltProjectIcon | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as { kind?: unknown; letters?: unknown; color?: unknown; id?: unknown; dataUrl?: unknown };
	const color = typeof raw.color === 'string' ? normalizeProjectColor(raw.color) : undefined;
	switch (raw.kind) {
		case 'monogram': {
			const letters = typeof raw.letters === 'string' ? normalizeMonogramLetters(raw.letters) : undefined;
			return { kind: 'monogram', ...(letters ? { letters } : {}), ...(color ? { color } : {}) };
		}
		case 'codicon':
			return typeof raw.id === 'string' && /^[a-z0-9-]+$/.test(raw.id) ? { kind: 'codicon', id: raw.id, ...(color ? { color } : {}) } : undefined;
		case 'image':
			return typeof raw.dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(raw.dataUrl) && raw.dataUrl.length < 200_000
				? { kind: 'image', dataUrl: raw.dataUrl }
				: undefined;
		default:
			return undefined;
	}
}

/** The key a project is stored under: its folder URI without a trailing slash. */
export function projectIconKey(root: string): string {
	return root.replace(/\/+$/, '');
}
