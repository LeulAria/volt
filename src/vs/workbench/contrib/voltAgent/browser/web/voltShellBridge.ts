/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Volt phone app (apps/mobile) is a native shell around this page: a WKWebView or Android
// WebView that signs in to the agent server and loads `/code/`. Before the page loads it sets
// `window.__voltShell`; it sends messages by calling `window.__voltShellReceive(message)`, and the
// page answers through `window.ReactNativeWebView.postMessage`. Keep the names and shapes in step
// with apps/mobile/src/shell/bridge.ts.

import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';

export interface IVoltShellInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

/** What the shell sets before the page loads. */
export interface IVoltShellInfo {
	readonly version: number;
	readonly platform: 'ios' | 'android';
	readonly appVersion?: string;
	readonly insets?: IVoltShellInsets;
	readonly computer?: { readonly id?: string; readonly label?: string };
}

/** From the shell. */
export type VoltShellInbound =
	| { readonly type: 'insets'; readonly insets: IVoltShellInsets }
	| { readonly type: 'keyboard'; readonly visible: boolean; readonly height: number }
	| { readonly type: 'back' }
	| { readonly type: 'appState'; readonly active: boolean };

export type VoltShellHaptic = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

/** To the shell. */
export type VoltShellOutbound =
	| { readonly type: 'ready' }
	| { readonly type: 'theme'; readonly background: string; readonly dark: boolean }
	| { readonly type: 'haptic'; readonly style: VoltShellHaptic }
	| { readonly type: 'openExternal'; readonly url: string }
	| { readonly type: 'computers' }
	| { readonly type: 'back'; readonly handled: boolean }
	| { readonly type: 'signedOut' }
	/** The page's socket to the agent server: the shell looks for the computer's new address while it is reconnecting, and signs in again when it failed. */
	| { readonly type: 'connection'; readonly state: 'open' | 'reconnecting' | 'failed' };

interface IShellWindow {
	__voltShell?: IVoltShellInfo;
	__voltShellReceive?: (message: unknown) => void;
	ReactNativeWebView?: { postMessage(message: string): void };
}

const shellWindow = mainWindow as unknown as IShellWindow;

function readInfo(): IVoltShellInfo | undefined {
	const info = shellWindow.__voltShell;
	if (!info || typeof info !== 'object' || (info.platform !== 'ios' && info.platform !== 'android') || !shellWindow.ReactNativeWebView) {
		return undefined;
	}
	return info;
}

/** The phone app this page runs in, or undefined in a browser. */
export const voltShell: IVoltShellInfo | undefined = readInfo();

let insets: IVoltShellInsets | undefined = validInsets(voltShell?.insets);

/** The safe areas the shell measured natively (a WebView edge to edge may report no env() insets on Android). */
export function voltShellInsets(): IVoltShellInsets | undefined {
	return insets;
}

const onMessageEmitter = new Emitter<VoltShellInbound>();
/** Messages from the shell, already checked. */
export const onVoltShellMessage: Event<VoltShellInbound> = onMessageEmitter.event;

export function postToVoltShell(message: VoltShellOutbound): void {
	if (!voltShell) {
		return;
	}
	try {
		shellWindow.ReactNativeWebView?.postMessage(JSON.stringify(message));
	} catch {
		// The shell went away (the app is closing).
	}
}

function validInsets(value: unknown): IVoltShellInsets | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { top, right, bottom, left } = value as Record<string, unknown>;
	const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 400;
	return number(top) && number(right) && number(bottom) && number(left)
		? { top: top as number, right: right as number, bottom: bottom as number, left: left as number }
		: undefined;
}

function parse(message: unknown): VoltShellInbound | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}
	const value = message as Record<string, unknown>;
	switch (value.type) {
		case 'insets': {
			const next = validInsets(value.insets);
			return next ? { type: 'insets', insets: next } : undefined;
		}
		case 'keyboard':
			return typeof value.visible === 'boolean' && typeof value.height === 'number' && Number.isFinite(value.height)
				? { type: 'keyboard', visible: value.visible, height: Math.max(0, value.height) }
				: undefined;
		case 'back':
			return { type: 'back' };
		case 'appState':
			return typeof value.active === 'boolean' ? { type: 'appState', active: value.active } : undefined;
		default:
			return undefined;
	}
}

if (voltShell) {
	shellWindow.__voltShellReceive = (raw: unknown) => {
		const message = parse(typeof raw === 'string' ? safeJson(raw) : raw);
		if (!message) {
			return;
		}
		if (message.type === 'insets') {
			insets = message.insets;
		}
		onMessageEmitter.fire(message);
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
