/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Event as ElectronEvent } from 'electron';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltHttpOAuth, VoltOAuthSignInResult, isVoltOAuthCallback } from '../common/voltHttpOAuth.js';

/** The sign-in window's session: kept, so a provider remembers the user like Postman's in-app sign-in does. */
const VOLT_HTTP_OAUTH_PARTITION = 'persist:volt-http-oauth';
/** A sign-in nobody finishes ends on its own. */
const VOLT_HTTP_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The web contents of sign-in windows (and the popups they open). The app's security guard
 * (`web-contents-created` in app.ts) blocks every navigation outside a `<webview>`; these are the
 * one other place a page may navigate: a provider's sign-in moves through several pages.
 */
const signInContents = new Set<number>();

/** Whether `webContentsId` belongs to an OAuth sign-in window, whose pages may navigate. */
export function isVoltHttpOAuthContents(webContentsId: number): boolean {
	return signInContents.has(webContentsId);
}

function isWebAddress(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * Postman's "Get New Access Token" without "Authorize using browser": the provider's sign-in page in
 * a window of Volt's own (sandboxed, no Node, a session of its own), watched until the provider sends
 * it to the callback URL. That address is caught before it loads, so nothing has to listen on it,
 * and the window closes. One sign-in at a time: a new one ends the one before.
 */
export class VoltHttpOAuthMainService extends Disposable implements IVoltHttpOAuth {
	declare readonly _serviceBrand: undefined;

	private current: { readonly window: BrowserWindow; readonly finish: (result: VoltOAuthSignInResult) => void } | undefined;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => this.current?.finish({ cancelled: true })));
	}

	async signIn(authorizeUrl: string, callbackUrl: string): Promise<VoltOAuthSignInResult> {
		if (!isWebAddress(authorizeUrl)) {
			return { error: 'The Auth URL must be an http or https address.' };
		}
		if (!callbackUrl.trim()) {
			return { error: 'A Callback URL is needed to know when the sign-in is done.' };
		}
		this.current?.finish({ cancelled: true });

		const parent = BrowserWindow.getFocusedWindow() ?? undefined;
		const window = new BrowserWindow({
			width: 520,
			height: 720,
			title: 'Sign In',
			parent,
			show: false,
			autoHideMenuBar: true,
			webPreferences: {
				partition: VOLT_HTTP_OAUTH_PARTITION,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webviewTag: false,
				spellcheck: false,
			},
		});
		return new Promise<VoltOAuthSignInResult>(resolve => {
			let done = false;
			const timer = setTimeout(() => finish({ cancelled: true }), VOLT_HTTP_OAUTH_TIMEOUT_MS);
			const finish = (result: VoltOAuthSignInResult) => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				if (this.current?.window === window) {
					this.current = undefined;
				}
				if (!window.isDestroyed()) {
					window.destroy();
				}
				resolve(result);
			};
			this.current = { window, finish };

			const contents = window.webContents;
			const contentsId = contents.id;
			signInContents.add(contentsId);
			contents.once('destroyed', () => signInContents.delete(contentsId));
			contents.on('did-create-window', child => {
				const childId = child.webContents.id;
				signInContents.add(childId);
				child.webContents.once('destroyed', () => signInContents.delete(childId));
			});
			// Caught before it loads: the callback need not exist, and its code never reaches a page.
			const catchCallback = (event: ElectronEvent, url: string) => {
				if (isVoltOAuthCallback(url, callbackUrl)) {
					event.preventDefault();
					finish({ url });
				}
			};
			contents.on('will-redirect', (event, url) => catchCallback(event, url));
			contents.on('will-navigate', (event, url) => catchCallback(event, url));
			// Navigations neither event sees (a custom scheme the provider sends the window to).
			contents.on('did-start-navigation', details => {
				if (details.isMainFrame && isVoltOAuthCallback(details.url, callbackUrl)) {
					finish({ url: details.url });
				}
			});
			// Providers that sign in through a popup (a "Continue with …" button) keep it in this session.
			contents.setWindowOpenHandler(({ url }) => isWebAddress(url) ? { action: 'allow' } : { action: 'deny' });
			contents.on('page-title-updated', (_event, title) => window.setTitle(title ? `Sign In: ${title}` : 'Sign In'));
			window.once('ready-to-show', () => window.show());
			window.on('closed', () => finish({ cancelled: true }));
			contents.loadURL(authorizeUrl).catch(err => {
				// A redirect to the callback aborts the load (ERR_ABORTED) after the sign-in has finished.
				if (!done) {
					this.logService.warn('[volt http] OAuth sign-in page failed to load', err);
					window.show();
				}
			});
		});
	}
}
