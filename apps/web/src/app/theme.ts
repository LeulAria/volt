/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { darkPalette, FONT_MONO_STACK, FONT_UI_STACK, type IVoltPalette, lightPalette, MODE_COLORS } from '@volt/client-core';
import { useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'volt.web.theme';
const listeners = new Set<() => void>();

function read(): ThemePreference {
	try {
		const value = window.localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

export function setThemePreference(preference: ThemePreference): void {
	try {
		window.localStorage.setItem(KEY, preference);
	} catch {
		// private mode
	}
	listeners.forEach(listener => listener());
}

export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, read, read);
}

function systemScheme(): 'light' | 'dark' {
	return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Keeps `<html data-theme>` on the chosen scheme (following the system when asked). */
export function useAppliedTheme(): 'light' | 'dark' {
	const preference = useThemePreference();
	const system = useSyncExternalStore(listener => {
		const query = window.matchMedia('(prefers-color-scheme: light)');
		query.addEventListener('change', listener);
		return () => query.removeEventListener('change', listener);
	}, systemScheme, systemScheme);
	const scheme = preference === 'system' ? system : preference;
	useEffect(() => {
		document.documentElement.dataset.theme = scheme;
		document.querySelector('meta[name="theme-color"]:not([media])')?.remove();
		const meta = document.createElement('meta');
		meta.name = 'theme-color';
		meta.content = scheme === 'dark' ? darkPalette.sidebar : lightPalette.sidebar;
		document.head.appendChild(meta);
	}, [scheme]);
	return scheme;
}

function vars(p: IVoltPalette): string {
	const entries: [string, string][] = [
		['canvas', p.canvas], ['sidebar', p.sidebar], ['surface', p.surface], ['raised', p.raised], ['composer', p.composer],
		['bubble', p.bubble], ['bubble-border', p.bubbleBorder], ['fg', p.fg], ['fg2', p.fgSecondary], ['fg3', p.fgTertiary], ['fg4', p.fgQuaternary],
		['stroke', p.stroke], ['stroke-faint', p.strokeFaint], ['fill', p.fill], ['fill-faint', p.fillFaint], ['fill-strong', p.fillStrong],
		['accent', p.accent], ['link', p.link], ['success', p.success], ['danger', p.danger], ['warning', p.warning], ['info', p.info], ['violet', p.violet],
		['primary', p.primary], ['on-primary', p.onPrimary], ['code-bg', p.codeBg], ['card', p.card], ['icon3', p.iconTertiary], ['approve', p.approve], ['on-approve', p.onApprove], ['diff-add', p.diffAdded], ['diff-del', p.diffRemoved],
		['diff-add-fg', p.diffAddedFg], ['diff-del-fg', p.diffRemovedFg], ['overlay', p.overlay], ['shadow', p.shadow],
	];
	const syntax = Object.entries(p.syntax).map(([k, v]) => `--syn-${k}:${v};`).join('');
	const modes = Object.entries(MODE_COLORS).map(([mode, c]) => `--mode-${mode.toLowerCase()}-fg:${mode === 'Agent' ? p.fg : c.fg};--mode-${mode.toLowerCase()}-bg:${p.scheme === 'dark' ? c.bg : c.bgLight};--mode-${mode.toLowerCase()}-send:${mode === 'Agent' ? p.primary : c.send};--mode-${mode.toLowerCase()}-on-send:${mode === 'Agent' ? p.onPrimary : c.onSend};`).join('');
	return entries.map(([k, v]) => `--${k}:${v};`).join('') + syntax + modes;
}

/** The palette as CSS variables: one source of truth with the mobile app (client-core/theme.ts). */
export function installThemeVariables(): void {
	const style = document.createElement('style');
	style.id = 'volt-theme';
	style.textContent = `:root{--font-ui:${FONT_UI_STACK};--font-mono:${FONT_MONO_STACK};}`
		+ `:root,[data-theme="dark"]{color-scheme:dark;${vars(darkPalette)}}`
		+ `[data-theme="light"]{color-scheme:light;${vars(lightPalette)}}`;
	document.head.prepend(style);
}
