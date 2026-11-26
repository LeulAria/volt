/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Android's navigation bar over the page. The app runs edge to edge, so the bar is see-through
 * and the page paints behind it; React Native sets its buttons from the system's light or dark
 * mode once, with a scrim of that mode behind three-button navigation. A dark page on a phone in
 * light mode then gets a white band with dark buttons at the bottom. This drops the scrim and sets
 * the buttons from what is actually behind them. (iOS's home indicator adapts by itself.)
 */
interface IVoltSystemBarsModule {
	setNavigationBarStyle(dark: boolean): Promise<void>;
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<IVoltSystemBarsModule>('VoltSystemBars') : null;

/** Light buttons over a dark background, or dark ones over a light background. */
export function setNavigationBarStyle(dark: boolean): void {
	void native?.setNavigationBarStyle(dark).catch(() => undefined);
}
