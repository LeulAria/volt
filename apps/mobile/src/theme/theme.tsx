/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Font from 'expo-font';
import { darkPalette, type IVoltPalette, lightPalette, MODE_COLORS, type ComposerMode, voltTheme, type VoltThemeId } from '@volt/client-core';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';

/** `system` follows the phone (Volt Dark / Volt Light); otherwise one of the desktop's Volt themes. */
export type ThemePreference = 'system' | VoltThemeId;

const KEY = 'volt.theme';

const SYSTEM_MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Code is set in Geist Mono, the desktop's monospace font, once {@link loadFonts} has it. */
export const FONT: { mono: string } = { mono: SYSTEM_MONO };

/** Loads the bundled fonts; the system's monospace stays if they don't load. Call before the first screen draws. */
export async function loadFonts(): Promise<void> {
	try {
		await Font.loadAsync({ GeistMono: require('../../assets/fonts/GeistMono-Variable.ttf') as number });
		FONT.mono = 'GeistMono';
	} catch {
		FONT.mono = SYSTEM_MONO;
	}
}

export interface ITheme {
	readonly p: IVoltPalette;
	readonly dark: boolean;
	readonly preference: ThemePreference;
	readonly setPreference: (preference: ThemePreference) => void;
	readonly mode: (mode: ComposerMode) => { readonly fg: string; readonly bg: string; readonly send: string; readonly onSend: string };
}

const ThemeContext = createContext<ITheme | undefined>(undefined);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
	const system = useColorScheme();
	const [preference, setPref] = useState<ThemePreference>('system');
	useEffect(() => {
		void AsyncStorage.getItem(KEY).then(value => {
			if (voltTheme(value)) {
				setPref(value as VoltThemeId);
			}
		});
	}, []);
	const setPreference = useCallback((next: ThemePreference) => {
		setPref(next);
		void AsyncStorage.setItem(KEY, next);
	}, []);
	const p = preference === 'system' ? (system === 'light' ? lightPalette : darkPalette) : voltTheme(preference)?.palette ?? darkPalette;
	const dark = p.scheme === 'dark';
	const value = useMemo<ITheme>(() => {
		return {
			p,
			dark,
			preference,
			setPreference,
			mode: mode => {
				const c = MODE_COLORS[mode];
				return mode === 'Agent'
					? { fg: p.fg, bg: p.fill, send: p.primary, onSend: p.onPrimary }
					: { fg: c.fg, bg: dark ? c.bg : c.bgLight, send: c.send, onSend: c.onSend };
			},
		};
	}, [p, dark, preference, setPreference]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ITheme {
	const theme = useContext(ThemeContext);
	if (!theme) {
		throw new Error('useTheme outside ThemeProvider');
	}
	return theme;
}
