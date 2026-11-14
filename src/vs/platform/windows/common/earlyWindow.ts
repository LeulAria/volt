/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Volt: the launch window.
 *
 * At a plain launch the main process opens the window the last session left (same options, same place) as soon as
 * Electron is ready, before the main bundle and its services load, and starts loading the workbench page in it. The
 * first code window then adopts that window and its page instead of creating them. These are the pure rules both
 * sides share (the main entry that opens it and the window code that adopts it run from different bundles); the
 * state between them lives on `globalThis[EARLY_WINDOW_KEY]`.
 */

/** File in the user data folder that describes the window to open at the next launch. */
export const EARLY_WINDOW_HINT_FILE = 'launchWindow.json';

export const EARLY_WINDOW_HINT_VERSION = 1;

/** Well-known global under which the main entry publishes the launch window for the window code to adopt. */
export const EARLY_WINDOW_KEY = '__voltEarlyWindow';

/** Well-known global that holds the IPC channels the launch window's page may call before their real handlers exist. */
export const EARLY_IPC_KEY = '__voltEarlyIpc';

export interface IEarlyWindowHint {
	readonly version: number;
	/** Product commit of the build that wrote it; a different build never uses it. */
	readonly commit: string | null;
	/** App root of the build that wrote it; the page URL and preload path are inside it. */
	readonly appRoot: string;
	/** The workbench page the window loaded. */
	readonly url: string;
	/** Browser window options, without `webPreferences` and position. */
	readonly options: Record<string, unknown>;
	/** Web preferences of the window's view, without `additionalArguments` (they carry a per-window channel). */
	readonly webPreferences: Record<string, unknown>;
	/**
	 * File name (in `VoltWindowSnapshots`) of the window's stored picture of its last screen, which the launch window's
	 * page paints before the window code is up. The page checks it against its configuration when that arrives.
	 */
	readonly snapshotFile?: string;
}

/**
 * Channel on which the launch window's page asks for the stored picture of its last screen, as soon as its startup
 * script runs. The call also tells the main entry that the page has its files, so it can load the main bundle.
 */
export const EARLY_SNAPSHOT_CHANNEL = 'vscode:voltLaunchSnapshot';

/** URL fragment the launch window's page is loaded with: only that page asks {@link EARLY_SNAPSHOT_CHANNEL}. */
export const EARLY_PAGE_FRAGMENT = 'volt-launch';

/**
 * How long the main entry waits at most for the launch window's page to have its files before it loads the main bundle
 * (loading it holds the main thread, and with it the page's file requests).
 */
export const EARLY_PAGE_WAIT_MS = 300;

/** A snapshot file name as the snapshot store names them (24 hex digits). */
export function isSnapshotFileName(name: unknown): name is string {
	return typeof name === 'string' && /^[0-9a-f]{24}\.json$/.test(name);
}

export interface IEarlyWindowBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Command line options a plain launch may carry. Anything else (a path to open, `--wait`, `--new-window`, a CLI command,
 * extension development, a profile) takes the normal path, because the window it opens may not be the last one.
 */
const PLAIN_LAUNCH_ARGS = new Set([
	'_', 'user-data-dir', 'extensions-dir', 'remote-debugging-port', 'log', 'use-mock-keychain', 'sandbox', 'no-sandbox',
	'disable-chromium-sandbox', 'disable-gpu', 'disable-gpu-sandbox', 'disable-renderer-backgrounding',
	'disable-backgrounding-occluded-windows', 'disable-lcd-text', 'force-color-profile', 'disable-features',
	'enable-features', 'js-flags', 'locale', 'crash-reporter-directory', 'crash-reporter-id', 'enable-proposed-api',
	'disable-extension', 'inspect', 'inspect-brk', 'inspect-extensions', 'inspect-brk-extensions', 'verbose',
]);

/**
 * Whether a launch with these parsed arguments is a plain one. `positional` are the positional arguments after the
 * executable (and after the app folder when Electron runs one from sources).
 */
export function isPlainLaunch(args: Record<string, unknown>, positional: readonly string[]): boolean {
	if (positional.some(arg => !arg.startsWith('-psn_'))) {
		return false; // something to open
	}
	return Object.keys(args).every(key => PLAIN_LAUNCH_ARGS.has(key) || key.startsWith('psn_'));
}

/** Reads a hint written by the same build (commit and app root), or undefined. */
export function parseEarlyWindowHint(raw: string, expected: { readonly commit: string | null; readonly appRoot: string }): IEarlyWindowHint | undefined {
	let hint: IEarlyWindowHint;
	try {
		hint = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!hint || typeof hint !== 'object' || hint.version !== EARLY_WINDOW_HINT_VERSION) {
		return undefined;
	}
	if ((hint.commit ?? null) !== expected.commit || hint.appRoot !== expected.appRoot) {
		return undefined;
	}
	if (typeof hint.url !== 'string' || !isObject(hint.options) || !isObject(hint.webPreferences)) {
		return undefined;
	}
	const preload = hint.webPreferences.preload;
	if (typeof preload !== 'string' || !isInside(preload, expected.appRoot) || !hint.url.startsWith('vscode-file://vscode-app/')) {
		return undefined;
	}
	if (hint.snapshotFile !== undefined && !isSnapshotFileName(hint.snapshotFile)) {
		return { ...hint, snapshotFile: undefined }; // the window still opens, without its picture
	}
	return hint;
}

/**
 * The bounds the last active window was left with, from the global `storage.json`, when it was left in the normal mode
 * (a maximized or full screen window is shown only after its state is applied, so it takes the normal path).
 */
export function lastWindowBounds(storageJson: string): IEarlyWindowBounds | undefined {
	let state: { windowsState?: { lastActiveWindow?: { uiState?: { mode?: number; x?: unknown; y?: unknown; width?: unknown; height?: unknown } } } };
	try {
		state = JSON.parse(storageJson);
	} catch {
		return undefined;
	}
	const ui = state?.windowsState?.lastActiveWindow?.uiState;
	if (!ui || ui.mode !== 1 /* WindowMode.Normal */) {
		return undefined;
	}
	const { x, y, width, height } = ui;
	if (![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value)) || (width as number) <= 0 || (height as number) <= 0) {
		return undefined;
	}
	return { x: x as number, y: y as number, width: width as number, height: height as number };
}

const GEOMETRY_KEYS = new Set(['x', 'y', 'width', 'height']);

/** Options a created window can still take (key → how), so a launch window that differs only in these is adopted. */
export const SETTABLE_WINDOW_OPTIONS = new Set(['backgroundColor', 'title', 'minWidth', 'minHeight', 'fullscreenable']);

/** Options that never decide what the window is (`show` follows the mode; preferences belong to the view). */
const IGNORED_WINDOW_OPTIONS = new Set(['show', 'webPreferences']);

export interface IEarlyWindowMatch {
	/** The launch window can be adopted. */
	readonly compatible: boolean;
	/** Settable options whose value differs (to apply after adoption), geometry included. */
	readonly changed: readonly string[];
	/** Options that differ and cannot be changed on a created window. */
	readonly conflicts: readonly string[];
}

/** Compares the launch window's options with the options the window code would create its window with. */
export function matchEarlyWindowOptions(early: Record<string, unknown>, actual: Record<string, unknown>): IEarlyWindowMatch {
	const changed: string[] = [];
	const conflicts: string[] = [];
	for (const key of new Set([...Object.keys(early), ...Object.keys(actual)])) {
		if (IGNORED_WINDOW_OPTIONS.has(key) || sameValue(early[key], actual[key])) {
			continue;
		}
		if (GEOMETRY_KEYS.has(key) || SETTABLE_WINDOW_OPTIONS.has(key)) {
			changed.push(key);
		} else {
			conflicts.push(key);
		}
	}
	return { compatible: conflicts.length === 0, changed, conflicts };
}

/**
 * Web preferences that never decide what the page is: the per-window channel, and `show`, which Electron writes into
 * the preferences object a `WebContentsView` is created with (so a hint written from that object has it, and the
 * options of the next window do not).
 */
const IGNORED_WEB_PREFERENCES = new Set(['additionalArguments', 'show']);

/** Compares the view's web preferences (the per-window channel and the zoom, which can be set later, aside). */
export function matchEarlyWebPreferences(early: Record<string, unknown>, actual: Record<string, unknown>): boolean {
	for (const key of new Set([...Object.keys(early), ...Object.keys(actual)])) {
		if (IGNORED_WEB_PREFERENCES.has(key) || key === 'zoomFactor') {
			continue;
		}
		if (!sameValue(early[key], actual[key])) {
			return false;
		}
	}
	return true;
}

/** The hint to store for a window created with these options. */
export function toEarlyWindowHint(input: { commit: string | null; appRoot: string; url: string; options: Record<string, unknown>; webPreferences: Record<string, unknown>; snapshotFile?: string }): IEarlyWindowHint {
	const options: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input.options)) {
		if (!GEOMETRY_KEYS.has(key) && !IGNORED_WINDOW_OPTIONS.has(key) && isPlainValue(value)) {
			options[key] = value;
		}
	}
	const webPreferences: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input.webPreferences)) {
		if (!IGNORED_WEB_PREFERENCES.has(key) && isPlainValue(value)) {
			webPreferences[key] = value;
		}
	}
	const snapshotFile = isSnapshotFileName(input.snapshotFile) ? input.snapshotFile : undefined;
	return { version: EARLY_WINDOW_HINT_VERSION, commit: input.commit, appRoot: input.appRoot, url: input.url, options, webPreferences, ...(snapshotFile ? { snapshotFile } : {}) };
}

function sameValue(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function isPlainValue(value: unknown): boolean {
	if (value === undefined || typeof value === 'function') {
		return false;
	}
	try {
		JSON.stringify(value);
		return true;
	} catch {
		return false;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInside(path: string, root: string): boolean {
	if (!root || !path.startsWith(root) || path.split(/[\\/]/).includes('..')) {
		return false;
	}
	const separator = /[\\/]$/.test(root) ? root.charAt(root.length - 1) : path.charAt(root.length);
	return separator === '/' || separator === '\\';
}
