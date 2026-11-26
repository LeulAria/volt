/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/** Volt's look for the few native screens (system font, the desktop's dark and light canvases). */
export interface IPalette {
	readonly dark: boolean;
	readonly canvas: string;
	readonly raised: string;
	readonly fg: string;
	readonly fgSecondary: string;
	readonly fgTertiary: string;
	readonly stroke: string;
	readonly fill: string;
	readonly accent: string;
	readonly onAccent: string;
	readonly danger: string;
}

const DARK: IPalette = {
	dark: true,
	canvas: '#141414',
	raised: '#1C1C1C',
	fg: '#E6E6E6',
	fgSecondary: '#8B8B8B',
	fgTertiary: '#5E5E5E',
	stroke: 'rgba(255,255,255,0.08)',
	fill: 'rgba(255,255,255,0.06)',
	accent: '#81A1C1',
	onAccent: '#0F1419',
	danger: '#FC6B83',
};

const LIGHT: IPalette = {
	dark: false,
	canvas: '#FCFCFC',
	raised: '#FFFFFF',
	fg: '#1F1F1F',
	fgSecondary: '#6B6B6B',
	fgTertiary: '#9A9A9A',
	stroke: 'rgba(0,0,0,0.08)',
	fill: 'rgba(0,0,0,0.04)',
	accent: '#4C6A8C',
	onAccent: '#FFFFFF',
	danger: '#D1344F',
};

export function palette(dark: boolean): IPalette {
	return dark ? DARK : LIGHT;
}

/** The workbench's last colours: painted behind the page so a launch never flashes white. */
export interface IShellTheme {
	readonly background: string;
	readonly dark: boolean;
}

const THEME_KEY = 'volt.shell.theme';
const HEX = /^#[0-9a-f]{6}$/i;

function systemTheme(): IShellTheme {
	const dark = Appearance.getColorScheme() !== 'light';
	return { background: palette(dark).canvas, dark };
}

let theme: IShellTheme = systemTheme();
let stored = false;
const listeners = new Set<() => void>();

/** Started at launch, before the first render. */
export const themeLoaded: Promise<void> = AsyncStorage.getItem(THEME_KEY).then(json => {
	if (!json || stored) {
		return;
	}
	const value = JSON.parse(json) as Partial<IShellTheme>;
	if (typeof value.background === 'string' && HEX.test(value.background) && typeof value.dark === 'boolean') {
		theme = { background: value.background, dark: value.dark };
		listeners.forEach(listener => listener());
	}
}).catch(() => undefined);

export function setShellTheme(next: IShellTheme): void {
	stored = true;
	if (next.background.toLowerCase() === theme.background.toLowerCase() && next.dark === theme.dark) {
		return;
	}
	theme = next;
	listeners.forEach(listener => listener());
	void AsyncStorage.setItem(THEME_KEY, JSON.stringify(next)).catch(() => undefined);
}

export function useShellTheme(): IShellTheme {
	return useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => theme, () => theme);
}

export function isHexColor(value: unknown): value is string {
	return typeof value === 'string' && HEX.test(value);
}
