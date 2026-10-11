/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkPalette, type IVoltPalette, lightPalette, MODE_COLORS, type ComposerMode } from '@volt/client-core';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'volt.theme';

export const FONT = {
	mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const;

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
			if (value === 'light' || value === 'dark') {
				setPref(value);
			}
		});
	}, []);
	const setPreference = useCallback((next: ThemePreference) => {
		setPref(next);
		void AsyncStorage.setItem(KEY, next);
	}, []);
	const dark = preference === 'system' ? system !== 'light' : preference === 'dark';
	const value = useMemo<ITheme>(() => {
		const p = dark ? darkPalette : lightPalette;
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
	}, [dark, preference, setPreference]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ITheme {
	const theme = useContext(ThemeContext);
	if (!theme) {
		throw new Error('useTheme outside ThemeProvider');
	}
	return theme;
}
