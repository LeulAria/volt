/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** The main process channel the Volt Client's in-app OAuth 2.0 sign-in window is opened through. */
export const VOLT_HTTP_OAUTH_CHANNEL_NAME = 'voltHttpOAuth';

export const IVoltHttpOAuth = createDecorator<IVoltHttpOAuth>('voltHttpOAuth');

/**
 * How an in-app sign-in ended:
 * - `url`: the address the provider sent the window to under the callback, with its `code`,
 *   `state` or `error` (never loaded).
 * - `cancelled`: the user closed the window, or the sign-in ran out of time.
 * - `unsupported`: no window can be opened here (the web workbench): sign in in the browser.
 */
export type VoltOAuthSignInResult =
	| { readonly url: string }
	| { readonly cancelled: true }
	| { readonly unsupported: true }
	| { readonly error: string };

export interface IVoltHttpOAuth {
	readonly _serviceBrand: undefined;
	/**
	 * Opens `authorizeUrl` in a window of its own (a private session: the user signs in to the
	 * provider there) and waits for the provider to send it to `callbackUrl`. Only http(s)
	 * sign-in pages open; the callback may be any address registered with the app.
	 */
	signIn(authorizeUrl: string, callbackUrl: string): Promise<VoltOAuthSignInResult>;
}

/** The address without its query and fragment, and without a trailing slash on the path. */
function voltOAuthBase(url: string): string {
	return url.split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether the window's next address is the callback: the same scheme, host, port and path as the
 * callback URL (its own query, if any, is not compared), whatever the provider added after it.
 */
export function isVoltOAuthCallback(url: string, callbackUrl: string): boolean {
	const callback = voltOAuthBase(callbackUrl.trim());
	return !!callback && voltOAuthBase(url) === callback;
}
