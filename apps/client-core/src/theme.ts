/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRenderTheme } from './client';
import type { ComposerMode } from './types';
import type { TokenKind } from './markdown/highlight';

/**
 * Volt's design tokens, taken from the desktop app's default themes (extensions/theme-cursor:
 * Volt Dark and Volt Light) and the agent window's CSS (agentMarkdown.css, agentEditor.css,
 * voltButton.css): the same canvas, text alphas, hairlines, mode colours and status colours, so
 * the web and mobile apps read as the same product.
 */
export interface IVoltPalette {
	readonly scheme: 'dark' | 'light';
	/** The chat canvas (the desktop's `--volt-agent-chat-bg`: the title bar's colour). */
	readonly canvas: string;
	/** Cards on the chat: edits, commands, diffs, code (`--volt-md-card-bg`: the editor background). */
	readonly card: string;
	/** Sidebars, headers, the home list. */
	readonly sidebar: string;
	/** Cards and rows on the canvas. */
	readonly surface: string;
	/** Menus, sheets, popovers. */
	readonly raised: string;
	/** The composer box. */
	readonly composer: string;
	/** A sent prompt (the composer's own fill). */
	readonly bubble: string;
	readonly bubbleBorder: string;
	readonly fg: string;
	readonly fgSecondary: string;
	readonly fgTertiary: string;
	readonly fgQuaternary: string;
	/** Icons beside tertiary text (agentMarkdown.css `--volt-md-icon-tertiary`, 52%). */
	readonly iconTertiary: string;
	readonly stroke: string;
	readonly strokeFaint: string;
	readonly fill: string;
	readonly fillFaint: string;
	readonly fillStrong: string;
	readonly accent: string;
	readonly link: string;
	readonly success: string;
	readonly danger: string;
	readonly warning: string;
	readonly info: string;
	readonly violet: string;
	/** Primary buttons: the near-white (light: near-black) fill of Volt's setup steps. */
	readonly primary: string;
	readonly onPrimary: string;
	/** An approval's Allow button (agentTranscript.css `.volt-approval-btn.primary`). */
	readonly approve: string;
	readonly onApprove: string;
	readonly codeBg: string;
	readonly diffAdded: string;
	readonly diffRemoved: string;
	readonly diffAddedFg: string;
	readonly diffRemovedFg: string;
	readonly overlay: string;
	readonly shadow: string;
	readonly syntax: Readonly<Record<TokenKind, string>>;
}

export const darkPalette: IVoltPalette = {
	scheme: 'dark',
	canvas: '#141414',
	card: '#181818',
	sidebar: '#101010',
	surface: '#1E1E1E',
	raised: '#232323',
	// The desktop's rgba(34,34,34,0.78) over the canvas: the composer and a sent prompt share it.
	composer: '#202020',
	bubble: '#202020',
	bubbleBorder: 'rgba(255,255,255,0.10)',
	fg: '#F0F0F0',
	fgSecondary: 'rgba(240,240,240,0.74)',
	fgTertiary: 'rgba(240,240,240,0.60)',
	fgQuaternary: 'rgba(240,240,240,0.36)',
	iconTertiary: 'rgba(240,240,240,0.52)',
	stroke: 'rgba(240,240,240,0.12)',
	strokeFaint: 'rgba(240,240,240,0.08)',
	fill: 'rgba(240,240,240,0.08)',
	fillFaint: 'rgba(240,240,240,0.04)',
	fillStrong: 'rgba(240,240,240,0.14)',
	accent: '#81A1C1',
	link: '#7BAFE9',
	success: '#70B489',
	danger: '#E34671',
	warning: '#D2943E',
	info: '#88C0D0',
	violet: '#AAA0FA',
	primary: '#F0F0F0',
	onPrimary: '#141414',
	approve: '#599CE7',
	onApprove: '#191C22',
	codeBg: '#181818',
	diffAdded: 'rgba(63,162,102,0.20)',
	diffRemoved: 'rgba(184,0,73,0.20)',
	diffAddedFg: '#70B489',
	diffRemovedFg: '#FC6B83',
	overlay: 'rgba(0,0,0,0.55)',
	shadow: 'rgba(0,0,0,0.45)',
	syntax: {
		plain: '#D6D6DD',
		comment: 'rgba(240,240,240,0.5)',
		string: '#E394DC',
		keyword: '#82D2CE',
		number: '#EBC88D',
		function: '#EFB080',
		type: '#EFB080',
		constant: '#82D2CE',
		operator: '#D6D6DD',
		punct: 'rgba(214,214,221,0.75)',
		tag: '#87C3FF',
		attr: '#AAA0FA',
		property: '#AAA0FA',
		variable: '#D6D6DD',
		inserted: '#70B489',
		deleted: '#FC6B83',
		meta: '#88C0D0',
		regex: '#E394DC',
	},
};

export const lightPalette: IVoltPalette = {
	scheme: 'light',
	canvas: '#F3F3F3',
	card: '#FCFCFC',
	sidebar: '#E7E7E7',
	surface: '#FFFFFF',
	raised: '#FFFFFF',
	// Volt Light's composer is white (rgba(255,255,255,0.94)); a sent prompt is rgba(236,236,236,0.82) over the chat.
	composer: '#FFFFFF',
	bubble: '#EDEDED',
	bubbleBorder: 'rgba(0,0,0,0.12)',
	fg: '#141414',
	fgSecondary: 'rgba(20,20,20,0.74)',
	fgTertiary: 'rgba(20,20,20,0.60)',
	fgQuaternary: 'rgba(20,20,20,0.36)',
	iconTertiary: 'rgba(20,20,20,0.52)',
	stroke: 'rgba(20,20,20,0.12)',
	strokeFaint: 'rgba(20,20,20,0.08)',
	fill: 'rgba(20,20,20,0.08)',
	fillFaint: 'rgba(20,20,20,0.04)',
	fillStrong: 'rgba(20,20,20,0.10)',
	accent: '#2778C1',
	link: '#0064B0',
	success: '#007041',
	danger: '#BE1744',
	warning: '#8B5700',
	info: '#176C74',
	violet: '#654DC0',
	primary: '#141414',
	onPrimary: '#FCFCFC',
	approve: '#2778C1',
	onApprove: '#FFFFFF',
	codeBg: '#FCFCFC',
	diffAdded: 'rgba(0,175,102,0.14)',
	diffRemoved: 'rgba(255,97,123,0.22)',
	diffAddedFg: '#007041',
	diffRemovedFg: '#BE1744',
	overlay: 'rgba(0,0,0,0.30)',
	shadow: 'rgba(0,0,0,0.14)',
	syntax: {
		plain: '#141414',
		comment: 'rgba(20,20,20,0.55)',
		string: '#7565CC',
		keyword: '#A30034',
		number: '#92156A',
		function: '#CD4500',
		type: '#005293',
		constant: '#005293',
		operator: '#141414',
		punct: 'rgba(20,20,20,0.7)',
		tag: '#007041',
		attr: '#654DC0',
		property: '#005293',
		variable: '#005293',
		inserted: '#007041',
		deleted: '#BE1744',
		meta: '#176C74',
		regex: '#0064B0',
	},
};

/** Volt Dark Midnight: the Nord-blue dark theme (cursor-dark-midnight-color-theme.json). */
export const midnightPalette: IVoltPalette = {
	...darkPalette,
	canvas: '#191C22',
	card: '#1E2127',
	sidebar: '#14161B',
	surface: '#232730',
	raised: '#272C36',
	composer: '#23262C',
	bubble: '#23262C',
	bubbleBorder: 'rgba(201,209,222,0.10)',
	fg: '#C9D1DE',
	fgSecondary: 'rgba(201,209,222,0.74)',
	fgTertiary: 'rgba(201,209,222,0.60)',
	fgQuaternary: 'rgba(201,209,222,0.36)',
	iconTertiary: 'rgba(201,209,222,0.52)',
	stroke: 'rgba(255,255,255,0.09)',
	strokeFaint: 'rgba(255,255,255,0.05)',
	fill: 'rgba(216,222,233,0.07)',
	fillFaint: 'rgba(216,222,233,0.035)',
	fillStrong: 'rgba(216,222,233,0.13)',
	accent: '#88C0D0',
	link: '#8FBCBB',
	success: '#A3BE8C',
	danger: '#BF616A',
	warning: '#EBCB8B',
	info: '#88C0D0',
	violet: '#B48EAD',
	primary: '#88C0D0',
	onPrimary: '#191C22',
	codeBg: '#1E2127',
	diffAddedFg: '#A3BE8C',
	diffRemovedFg: '#BF616A',
	diffAdded: 'rgba(163,190,140,0.16)',
	diffRemoved: 'rgba(191,97,106,0.16)',
};

/** Volt Dark High Contrast: near-black surfaces, stronger lines (cursor-dark-hc-color-theme.json). */
export const contrastPalette: IVoltPalette = {
	...darkPalette,
	canvas: '#0A0A0A',
	card: '#0A0A0A',
	sidebar: '#000000',
	surface: '#141414',
	raised: '#1A1A1A',
	composer: '#171717',
	bubble: '#171717',
	bubbleBorder: 'rgba(240,240,240,0.22)',
	fgSecondary: 'rgba(240,240,240,0.86)',
	fgTertiary: 'rgba(240,240,240,0.70)',
	fgQuaternary: 'rgba(240,240,240,0.50)',
	iconTertiary: 'rgba(240,240,240,0.66)',
	stroke: 'rgba(240,240,240,0.24)',
	strokeFaint: 'rgba(240,240,240,0.14)',
	fill: 'rgba(240,240,240,0.10)',
	fillFaint: 'rgba(240,240,240,0.05)',
	fillStrong: 'rgba(240,240,240,0.18)',
	success: '#A3BE8C',
	danger: '#E06C75',
	warning: '#EBCB8B',
	codeBg: '#000000',
};

/** Volt Light Colorblind: blue/orange instead of green/red for status and diffs. */
export const colorblindPalette: IVoltPalette = {
	...lightPalette,
	accent: '#1F79C0',
	link: '#0066AB',
	success: '#0066AB',
	danger: '#B35900',
	warning: '#795F00',
	diffAdded: 'rgba(0,102,171,0.12)',
	diffRemoved: 'rgba(179,89,0,0.12)',
	diffAddedFg: '#0066AB',
	diffRemovedFg: '#B35900',
	syntax: { ...lightPalette.syntax, inserted: '#0066AB', deleted: '#B35900', tag: '#006E4E' },
};

export type VoltThemeId = 'dark' | 'midnight' | 'contrast' | 'light' | 'colorblind';

export interface IVoltTheme {
	readonly id: VoltThemeId;
	/** The desktop theme's name (Settings > Appearance). */
	readonly label: string;
	readonly palette: IVoltPalette;
}

/** The desktop's built-in Volt themes, in its theme gallery's order. */
export const VOLT_THEMES: readonly IVoltTheme[] = [
	{ id: 'dark', label: 'Volt Dark', palette: darkPalette },
	{ id: 'midnight', label: 'Volt Dark Midnight', palette: midnightPalette },
	{ id: 'contrast', label: 'Volt Dark High Contrast', palette: contrastPalette },
	{ id: 'light', label: 'Volt Light', palette: lightPalette },
	{ id: 'colorblind', label: 'Volt Light Colorblind', palette: colorblindPalette },
];

export function voltTheme(id: string | null | undefined): IVoltTheme | undefined {
	return VOLT_THEMES.find(theme => theme.id === id);
}

export function paletteFor(scheme: 'dark' | 'light'): IVoltPalette {
	return scheme === 'dark' ? darkPalette : lightPalette;
}

/** The composer modes' colours (agentEditor.css `[data-mode]`); Agent uses the primary fill. */
export const MODE_COLORS: Readonly<Record<ComposerMode, { readonly fg: string; readonly bg: string; readonly bgLight: string; readonly send: string; readonly onSend: string }>> = {
	Agent: { fg: '#F0F0F0', bg: 'rgba(240,240,240,0.08)', bgLight: 'rgba(20,20,20,0.06)', send: '#F0F0F0', onSend: '#141414' },
	Plan: { fg: '#C9924A', bg: '#3D2E24', bgLight: '#F6EADB', send: '#C9924A', onSend: '#111111' },
	Ask: { fg: '#2F8B57', bg: '#1A2B20', bgLight: '#E0F1E7', send: '#2F8B57', onSend: '#111111' },
	Debug: { fg: '#C44B68', bg: '#3D1F26', bgLight: '#F7E1E6', send: '#C44B68', onSend: '#FFFFFF' },
	Multitask: { fg: '#8E68D6', bg: '#2D2438', bgLight: '#ECE5F8', send: '#8E68D6', onSend: '#FFFFFF' },
};

export type StatusTone = 'approval' | 'question' | 'working' | 'queued' | 'limit' | 'failed' | 'unread' | 'stopped' | 'idle' | 'done';

/** Status colours shared by list rows, chips and the working pill (T3's palette in Volt's hues). */
export function statusColor(tone: StatusTone, palette: IVoltPalette): string {
	switch (tone) {
		case 'approval': return palette.warning;
		case 'question': return palette.violet;
		case 'working': return palette.info;
		case 'queued': return palette.accent;
		case 'limit': return palette.warning;
		case 'failed': return palette.danger;
		case 'unread': return palette.success;
		case 'done': return palette.success;
		case 'stopped': return palette.fgTertiary;
		case 'idle': return palette.fgQuaternary;
	}
}

/**
 * Type scale (size / line height). The transcript uses the desktop's own: replies and prompts at
 * 14/22 (agentMarkdown.css `.volt-agent-reply`), work log rows at 13/22 (agentTranscript.css).
 */
export const TYPE = {
	caption: { size: 11, line: 14 },
	footnote: { size: 12, line: 16 },
	small: { size: 13, line: 18 },
	/** A work log row: "Explored 3 files". */
	step: { size: 13, line: 22 },
	body: { size: 14, line: 22 },
	reading: { size: 14, line: 22 },
	callout: { size: 16, line: 22 },
	title3: { size: 17, line: 22 },
	title2: { size: 20, line: 25 },
	title1: { size: 26, line: 32 },
	display: { size: 32, line: 38 },
} as const;

export const RADIUS = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20, pill: 999 } as const;

export const SPACE = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const MOTION = { fast: 120, base: 180, entrance: 220, pane: 260 } as const;

export const FONT_MONO_STACK = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
export const FONT_UI_STACK = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, Roboto, sans-serif';

/** The colors a page drawn on the server (a diagram, a formula, an agent's page) takes to match the app. */
export function renderThemeFor(p: IVoltPalette): IRenderTheme {
	return { kind: p.scheme, background: p.canvas, foreground: p.fg, muted: p.fgSecondary, border: p.stroke, accent: p.link, surface: p.surface, code: p.codeBg };
}
