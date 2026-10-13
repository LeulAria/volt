/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	/** The chat canvas (editor background). */
	readonly canvas: string;
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
	canvas: '#181818',
	sidebar: '#141414',
	surface: '#1E1E1E',
	raised: '#232323',
	// The desktop's rgba(34,34,34,0.78) over the canvas: the composer and a sent prompt share it.
	composer: '#202020',
	bubble: '#202020',
	bubbleBorder: 'rgba(255,255,255,0.10)',
	fg: '#F0F0F0',
	fgSecondary: 'rgba(240,240,240,0.74)',
	fgTertiary: 'rgba(240,240,240,0.56)',
	fgQuaternary: 'rgba(240,240,240,0.36)',
	stroke: 'rgba(240,240,240,0.12)',
	strokeFaint: 'rgba(240,240,240,0.075)',
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
	codeBg: '#141414',
	diffAdded: 'rgba(63,162,102,0.18)',
	diffRemoved: 'rgba(227,70,113,0.18)',
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
	canvas: '#FCFCFC',
	sidebar: '#F3F3F3',
	surface: '#FFFFFF',
	raised: '#FFFFFF',
	// The desktop's rgba(236,236,236,0.82) over the canvas.
	composer: '#EFEFEF',
	bubble: '#EFEFEF',
	bubbleBorder: 'rgba(0,0,0,0.12)',
	fg: '#141414',
	fgSecondary: 'rgba(20,20,20,0.74)',
	fgTertiary: 'rgba(20,20,20,0.56)',
	fgQuaternary: 'rgba(20,20,20,0.36)',
	stroke: 'rgba(20,20,20,0.12)',
	strokeFaint: 'rgba(20,20,20,0.07)',
	fill: 'rgba(20,20,20,0.06)',
	fillFaint: 'rgba(20,20,20,0.03)',
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
	codeBg: '#F5F5F5',
	diffAdded: 'rgba(0,112,65,0.12)',
	diffRemoved: 'rgba(190,23,68,0.10)',
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

/** Type scale (size / line height), one step larger on phones than the desktop's 14/22 body. */
export const TYPE = {
	caption: { size: 11, line: 14 },
	footnote: { size: 12, line: 16 },
	small: { size: 13, line: 18 },
	body: { size: 14, line: 22 },
	reading: { size: 15, line: 23 },
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
