/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The contract between this shell and the Volt workbench it hosts. The workbench reads
 * `window.__voltShell` (injected before any of its scripts run), posts the messages below with
 * `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`, and receives the shell's through
 * `window.__voltShellReceive(msg)`. Names and shapes must match the workbench side.
 */

export const SHELL_PROTOCOL_VERSION = 1;

export interface IInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export interface IShellInfo {
	readonly version: typeof SHELL_PROTOCOL_VERSION;
	readonly platform: 'ios' | 'android';
	readonly appVersion: string;
	/** CSS px. */
	readonly insets: IInsets;
	readonly computer: { readonly id: string; readonly label: string };
}

export type HapticStyle = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

/**
 * The page's own link to its computer (the agent server socket); each state is posted once, when
 * it starts. `reconnecting`: down for a couple of seconds and retrying; the phone may have changed
 * networks, so until `open` the shell checks now and then whether the computer answers at another
 * of its addresses and signs in there. `open`: connected again. `failed`: the server refused the
 * page (its session ended); the shell signs in again.
 */
export type PageConnectionState = 'open' | 'reconnecting' | 'failed';

/** Web → native. */
export type WebMessage =
	/** The workbench is up: the splash goes, Live Activities start. */
	| { readonly type: 'ready' }
	| { readonly type: 'theme'; readonly background: string; readonly dark: boolean }
	| { readonly type: 'haptic'; readonly style: HapticStyle }
	/** http, https, mailto or tel only. */
	| { readonly type: 'openExternal'; readonly url: string }
	/** Show the saved computers. */
	| { readonly type: 'computers' }
	/** The answer to a native `back`. */
	| { readonly type: 'back'; readonly handled: boolean }
	/** The user signed out in the workbench. */
	| { readonly type: 'signedOut' }
	| { readonly type: 'connection'; readonly state: PageConnectionState };

/** Native → web. */
export type NativeMessage =
	| { readonly type: 'insets'; readonly insets: IInsets }
	| { readonly type: 'keyboard'; readonly visible: boolean; readonly height: number }
	| { readonly type: 'back' }
	| { readonly type: 'appState'; readonly active: boolean };

const HAPTIC_STYLES: ReadonlySet<string> = new Set<HapticStyle>(['selection', 'light', 'medium', 'success', 'warning', 'error']);
const CONNECTION_STATES: ReadonlySet<string> = new Set<PageConnectionState>(['open', 'reconnecting', 'failed']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const EXTERNAL_URL = /^(https?:\/\/[^\s]+|mailto:[^\s]*|tel:[^\s]*)$/i;
const MAX_MESSAGE_CHARS = 8_192;

/** `https://host:port` of a URL (lower case), or undefined for anything that isn't http(s). */
export function originOf(url: string): string | undefined {
	const match = /^(https?):\/\/([^/?#\s]+)/i.exec(url);
	if (!match) {
		return undefined;
	}
	const scheme = match[1].toLowerCase();
	let host = match[2].toLowerCase();
	// Userinfo never counts toward the origin; a default port is the same origin without it.
	host = host.slice(host.lastIndexOf('@') + 1);
	if ((scheme === 'http' && host.endsWith(':80')) || (scheme === 'https' && host.endsWith(':443'))) {
		host = host.slice(0, host.lastIndexOf(':'));
	}
	return `${scheme}://${host}`;
}

export function sameOrigin(a: string, b: string): boolean {
	const origin = originOf(a);
	return !!origin && origin === originOf(b);
}

export function isExternalUrl(url: unknown): url is string {
	return typeof url === 'string' && url.length <= 4_096 && EXTERNAL_URL.test(url);
}

/**
 * A message the page posted, or undefined for anything that isn't exactly one of
 * {@link WebMessage} from the active computer's origin (a frame of another site, a stale page,
 * a malformed payload).
 */
export function parseWebMessage(data: unknown, pageUrl: string, baseUrl: string | undefined): WebMessage | undefined {
	if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS || !baseUrl || !sameOrigin(pageUrl, baseUrl)) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const msg = value as Record<string, unknown>;
	switch (msg.type) {
		case 'ready':
		case 'computers':
		case 'signedOut':
			return { type: msg.type };
		case 'theme':
			return typeof msg.background === 'string' && HEX_COLOR.test(msg.background) && typeof msg.dark === 'boolean'
				? { type: 'theme', background: msg.background, dark: msg.dark }
				: undefined;
		case 'haptic':
			return typeof msg.style === 'string' && HAPTIC_STYLES.has(msg.style) ? { type: 'haptic', style: msg.style as HapticStyle } : undefined;
		case 'openExternal':
			return isExternalUrl(msg.url) ? { type: 'openExternal', url: msg.url } : undefined;
		case 'back':
			return typeof msg.handled === 'boolean' ? { type: 'back', handled: msg.handled } : undefined;
		case 'connection':
			return typeof msg.state === 'string' && CONNECTION_STATES.has(msg.state) ? { type: 'connection', state: msg.state as PageConnectionState } : undefined;
		default:
			return undefined;
	}
}

/** The script that delivers a message to the page (for `injectJavaScript`). */
export function deliverScript(msg: NativeMessage): string {
	return `window.__voltShellReceive && window.__voltShellReceive(${JSON.stringify(msg)});true;`;
}

/** The script injected before the page's own (`injectedJavaScriptBeforeContentLoaded`). */
export function infoScript(info: IShellInfo): string {
	return `window.__voltShell = ${JSON.stringify(info)};true;`;
}

/** Insets rounded to whole CSS px: sub-pixel churn while rotating is not a change. */
export function roundInsets(insets: IInsets): IInsets {
	return { top: Math.round(insets.top), right: Math.round(insets.right), bottom: Math.round(insets.bottom), left: Math.round(insets.left) };
}
