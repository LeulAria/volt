/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IVoltDevServer, IVoltEmulation, IVoltLocalServer, IVoltMockHit, IVoltMockRoute, IVoltPlayground, IVoltPlaygroundRequest, IVoltPlaygroundUpdate } from './browserAgent.js';
import { IVoltCookieImportRequest, IVoltCookieImportResult, IVoltCookieSource } from './browserCookies.js';

export const IVoltBrowserService = createDecorator<IVoltBrowserService>('voltBrowserService');
export const VOLT_BROWSER_CHANNEL_NAME = 'voltBrowser';

/** The in-app browser's own session. Its cookies and cache stay apart from the workbench. */
export const VOLT_BROWSER_PARTITION = 'persist:volt-browser';

export type VoltBrowserColorScheme = 'system' | 'light' | 'dark';

export type VoltBrowserDataKind = 'cookies' | 'cache' | 'siteData';

/** What one site keeps in the browser, cleared per origin (the HTTP cache is per profile). */
export type VoltSiteDataKind = 'cookies' | 'storage' | 'indexeddb' | 'cache_storage' | 'service_workers' | 'http_cache';

export const VOLT_SITE_DATA_KINDS: readonly VoltSiteDataKind[] = ['cookies', 'storage', 'indexeddb', 'cache_storage', 'service_workers', 'http_cache'];

/** A cookie as DevTools' Application panel lists it. */
export interface IVoltSiteCookie {
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path?: string;
	readonly httpOnly: boolean;
	readonly secure: boolean;
	readonly sameSite?: string;
	readonly session: boolean;
	/** Seconds since the epoch. */
	readonly expires?: number;
}

/** What the main process sees of a page's site that the page's own script cannot (HttpOnly cookies). */
export interface IVoltSiteData {
	readonly url: string;
	readonly origin: string;
	readonly cookies: readonly IVoltSiteCookie[];
}

/**
 * The parts of the in-app browser that need the main process: the session (cookies, cache) and
 * the DevTools protocol (color scheme emulation). The window is sandboxed and reaches neither.
 */
export interface IVoltBrowserService {
	readonly _serviceBrand: undefined;

	/** Clears one kind of data from the in-app browser's session, for every site. */
	clearData(kind: VoltBrowserDataKind): Promise<void>;

	/** A browser page's site data the page cannot read itself: every cookie for its URL, HttpOnly ones too. */
	siteData(webContentsId: number): Promise<IVoltSiteData | undefined>;

	/** Clears these kinds of data of a browser page's origin only; other sites keep theirs. False when the page is gone. */
	clearSiteData(webContentsId: number, kinds: readonly VoltSiteDataKind[]): Promise<boolean>;

	/** Emulates `prefers-color-scheme` for one browser page; `system` follows the OS again. */
	setColorScheme(webContentsId: number, scheme: VoltBrowserColorScheme): Promise<boolean>;

	/** Cookie stores of the browsers installed here (Chrome, Safari, Arc, Firefox, Edge, Brave, …), one per profile. */
	listCookieSources(): Promise<IVoltCookieSource[]>;

	/** Copies one profile's cookies into a preview browser profile. Decrypting Chromium cookies may make the OS ask the user once. */
	importCookies(request: IVoltCookieImportRequest): Promise<IVoltCookieImportResult>;

	/**
	 * Lets a browser page act focused (focus events, `:focus`, `document.hasFocus()`) while the
	 * window's focus stays elsewhere, e.g. in the chat composer while an agent types into the page.
	 */
	setFocusEmulation(webContentsId: number, enabled: boolean): Promise<boolean>;

	/**
	 * Answers the page's matching requests with fake responses (DevTools `Fetch` interception), so
	 * an agent can test loading, error and empty states without a backend. An empty list stops it.
	 */
	setNetworkMocks(webContentsId: number, routes: readonly IVoltMockRoute[]): Promise<boolean>;

	/** Requests the mocks saw since they were set (most recent last, at most 200). */
	getMockHits(webContentsId: number): Promise<IVoltMockHit[]>;

	/** Emulates conditions on one page; fields left out keep their current value. `reset` clears all. */
	emulate(webContentsId: number, emulation: IVoltEmulation, reset?: boolean): Promise<IVoltEmulation | undefined>;

	/** A PNG of the whole page, beyond the viewport (data URL), or undefined. */
	captureFullPage(webContentsId: number, maxHeight?: number): Promise<{ dataUrl: string; width: number; height: number; clipped: boolean } | undefined>;

	/** Processes listening on TCP ports here (dev servers), without Volt's own. */
	listLocalServers(): Promise<IVoltLocalServer[]>;

	/** A throwaway site served on its own loopback origin from a folder outside every workspace. */
	createPlayground(request: IVoltPlaygroundRequest): Promise<IVoltPlayground>;
	updatePlayground(update: IVoltPlaygroundUpdate): Promise<IVoltPlayground>;
	listPlaygrounds(sessionId?: string): Promise<IVoltPlayground[]>;
	/** Stops the servers and deletes the folders: one id, or every playground of a chat. */
	deletePlaygrounds(selector: { readonly id?: string; readonly sessionId?: string }): Promise<IVoltPlayground[]>;

	/**
	 * Starts a project's dev server (its own command, in its folder, with the user's shell
	 * environment) unless Volt already runs that command there, and waits up to `waitMs` for it to
	 * listen. Volt stops it when it quits.
	 */
	startDevServer(cwd: string, command: string, waitMs: number): Promise<IVoltDevServer>;
	/** Dev servers Volt started: running ones and ones that ended, with their recent output. */
	listDevServers(): Promise<IVoltDevServer[]>;
	stopDevServer(pid: number): Promise<boolean>;
}
