/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, clipboard, dialog, Event as ElectronEvent, session, Session, WebContents, WebPreferences } from 'electron';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { guestPopupAction, isBrowserGuestPartition, isGuestPermissionAllowed, sanitizeGuestWebPreferences } from '../common/browserGuestPolicy.js';

/** How long a page that asked to open a non-web link waits before it may show the copy-link dialog again. */
const COPY_LINK_COOLDOWN_MS = 30_000;

const guardedSessions = new WeakSet<Session>();
const lastCopyLinkOffer = new WeakMap<WebContents, number>();

/**
 * Permission handlers on an in-app browser partition: without them Electron grants every request,
 * camera and microphone included (B-37). Idempotent.
 */
export function guardBrowserPartition(partition: string): void {
	const target = session.fromPartition(partition);
	if (guardedSessions.has(target)) {
		return;
	}
	guardedSessions.add(target);
	target.setPermissionRequestHandler((_contents, permission, callback) => callback(isGuestPermissionAllowed(permission)));
	target.setPermissionCheckHandler((_contents, permission) => isGuestPermissionAllowed(permission));
	target.setDevicePermissionHandler(() => false);
}

/**
 * `will-attach-webview` on Volt's windows: only the in-app browser's partitions may host a
 * `<webview>`, and its preferences lose any preload script or Node option before it attaches.
 */
export function onWillAttachWebview(event: ElectronEvent, webPreferences: WebPreferences, params: Record<string, string>, logService: ILogService): void {
	if (!isBrowserGuestPartition(params.partition)) {
		logService.warn(`[volt-browser] refused a <webview> in partition ${params.partition || '(none)'}`);
		event.preventDefault();
		return;
	}
	sanitizeGuestWebPreferences(webPreferences as Record<string, unknown>);
	guardBrowserPartition(params.partition);
}

/**
 * `window.open` and `target=_blank` from an in-app browser page: web links open in the user's
 * browser; anything else is refused, with a dialog that offers to copy the link (B-AP-6), at most
 * once per page every {@link COPY_LINK_COOLDOWN_MS}.
 */
export function onGuestWindowOpen(contents: WebContents, url: string, openExternal: (url: string) => void, logService: ILogService): { action: 'deny' } {
	if (guestPopupAction(url) === 'openExternal') {
		openExternal(url);
		return { action: 'deny' };
	}
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? 'unknown';
	logService.info(`[volt-browser] refused a popup to a ${scheme}: link`);
	const now = Date.now();
	if (now - (lastCopyLinkOffer.get(contents) ?? 0) >= COPY_LINK_COOLDOWN_MS) {
		lastCopyLinkOffer.set(contents, now);
		const owner = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
		const options = {
			type: 'info' as const,
			message: localize('voltBrowser.popupRefused', "The page tried to open a {0}: link", scheme),
			detail: localize('voltBrowser.popupRefusedDetail', "The in-app browser opens only web links outside Volt. You can copy this link and open it yourself:\n\n{0}", url.length > 500 ? `${url.slice(0, 500)}...` : url),
			buttons: [localize('voltBrowser.copyLink', "Copy Link"), localize('voltBrowser.close', "Close")],
			defaultId: 1,
			cancelId: 1,
		};
		void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)).then(result => {
			if (result.response === 0) {
				clipboard.writeText(url);
			}
		});
	}
	return { action: 'deny' };
}
