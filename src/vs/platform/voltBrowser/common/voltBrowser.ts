/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltBrowserService = createDecorator<IVoltBrowserService>('voltBrowserService');
export const VOLT_BROWSER_CHANNEL_NAME = 'voltBrowser';

/** The in-app browser's own session. Its cookies and cache stay apart from the workbench. */
export const VOLT_BROWSER_PARTITION = 'persist:volt-browser';

export type VoltBrowserColorScheme = 'system' | 'light' | 'dark';

export type VoltBrowserDataKind = 'cookies' | 'cache' | 'siteData';

/**
 * The parts of the in-app browser that need the main process: the session (cookies, cache) and
 * the DevTools protocol (color scheme emulation). The window is sandboxed and reaches neither.
 */
export interface IVoltBrowserService {
	readonly _serviceBrand: undefined;

	/** Clears one kind of data from the in-app browser's session, for every site. */
	clearData(kind: VoltBrowserDataKind): Promise<void>;

	/** Emulates `prefers-color-scheme` for one browser page; `system` follows the OS again. */
	setColorScheme(webContentsId: number, scheme: VoltBrowserColorScheme): Promise<boolean>;
}
