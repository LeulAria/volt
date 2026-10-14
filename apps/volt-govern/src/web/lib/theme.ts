/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { darkPalette, FONT_MONO_STACK, FONT_UI_STACK, type IVoltPalette, lightPalette } from '@volt/client-core';
import { useEffect, useSyncExternalStore } from 'react';

/** Volt Dark / Volt Light, the same tokens as the desktop and the web IDE (client-core/theme.ts). */
export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'volt.govern.theme';
const listeners = new Set<() => void>();

function read(): ThemePreference {
	try {
		const value = localStorage.getItem(KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

export function setThemePreference(preference: ThemePreference): void {
	try {
		localStorage.setItem(KEY, preference);
	} catch {
		// Private mode: the choice lasts for this page.
	}
	listeners.forEach(l => l());
}

export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(l => (listeners.add(l), () => listeners.delete(l)), read, read);
}

const systemScheme = () => matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

export function useAppliedTheme(): 'light' | 'dark' {
	const preference = useThemePreference();
	const system = useSyncExternalStore(l => {
		const q = matchMedia('(prefers-color-scheme: light)');
		q.addEventListener('change', l);
		return () => q.removeEventListener('change', l);
	}, systemScheme, systemScheme);
	const scheme = preference === 'system' ? system : preference;
	useEffect(() => {
		document.documentElement.dataset.theme = scheme;
	}, [scheme]);
	return scheme;
}

function vars(p: IVoltPalette): string {
	const entries: [string, string][] = [
		['canvas', p.canvas], ['sidebar', p.sidebar], ['surface', p.surface], ['raised', p.raised],
		['fg', p.fg], ['fg2', p.fgSecondary], ['fg3', p.fgTertiary], ['fg4', p.fgQuaternary],
		['stroke', p.stroke], ['stroke-faint', p.strokeFaint], ['fill', p.fill], ['fill-faint', p.fillFaint], ['fill-strong', p.fillStrong],
		['accent', p.accent], ['link', p.link], ['success', p.success], ['danger', p.danger], ['warning', p.warning], ['info', p.info], ['violet', p.violet],
		['primary', p.primary], ['on-primary', p.onPrimary], ['code-bg', p.codeBg], ['overlay', p.overlay], ['shadow', p.shadow],
	];
	return entries.map(([k, v]) => `--${k}:${v};`).join('');
}

export function installThemeVariables(): void {
	const style = document.createElement('style');
	style.id = 'volt-theme';
	style.textContent = `:root{--font-ui:${FONT_UI_STACK};--font-mono:${FONT_MONO_STACK};}`
		+ `:root,[data-theme="dark"]{color-scheme:dark;${vars(darkPalette)}}`
		+ `[data-theme="light"]{color-scheme:light;${vars(lightPalette)}}`;
	document.head.prepend(style);
}
