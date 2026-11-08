/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isPreviewPartition } from './browserCookies.js';

/**
 * What the in-app browser's pages (`<webview>` guests) may do outside their page, decided in the
 * main process (B-37, spec I.9, WEB-1..3). Pure, so the decisions are tested without Electron.
 */

/**
 * Permissions a page in the in-app browser gets: writing the clipboard, fullscreen, pointer and
 * keyboard lock, and protected media playback. Everything else is refused, notably camera and
 * microphone (they would use Volt's own macOS grants), notifications shown as Volt, geolocation,
 * devices, screen capture and `openExternal` (an in-page navigation to a custom scheme).
 */
const ALLOWED_GUEST_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'mediaKeySystem']);

export function isGuestPermissionAllowed(permission: string): boolean {
	return ALLOWED_GUEST_PERMISSIONS.has(permission);
}

/** Only the in-app browser's own partitions may host a `<webview>` (the shared one and per-chat ones). */
export function isBrowserGuestPartition(partition: string | undefined): boolean {
	return !!partition && isPreviewPartition(partition);
}

/**
 * A page's `window.open` / `target=_blank`: http(s) opens in the user's browser; any other scheme
 * (`mailto:`, `zoommtg:`, `vscode:`, `file:`, `about:blank`, ...) is refused, so a page cannot start
 * an OS protocol handler or a Volt window. The user can still copy the link (B-AP-6).
 */
export function guestPopupAction(url: string): 'openExternal' | 'deny' {
	try {
		const protocol = new URL(url).protocol;
		return protocol === 'http:' || protocol === 'https:' ? 'openExternal' : 'deny';
	} catch {
		return 'deny';
	}
}

/** `webPreferences` keys that would give a guest page Node, a preload script or Volt's privileges. */
const UNSAFE_GUEST_PREFERENCES = ['preload', 'preloadURL', 'nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'contextIsolation', 'webSecurity', 'sandbox', 'experimentalFeatures', 'enableBlinkFeatures', 'additionalArguments', 'webviewTag'] as const;

/**
 * Strips preload scripts and Node options from a `<webview>` about to attach, whatever its
 * attributes said, and pins the safe values: no Node, isolated context, web security on, no
 * nested `<webview>`s. Changes `webPreferences` in place, as `will-attach-webview` requires.
 */
export function sanitizeGuestWebPreferences(webPreferences: Record<string, unknown>): void {
	for (const key of UNSAFE_GUEST_PREFERENCES) {
		delete webPreferences[key];
	}
	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInWorker = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.contextIsolation = true;
	webPreferences.webSecurity = true;
	webPreferences.webviewTag = false;
}
