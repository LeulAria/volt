/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltDesktopService = createDecorator<IVoltDesktopService>('voltDesktopService');
export const VOLT_DESKTOP_CHANNEL_NAME = 'voltDesktop';

export interface IVoltDesktopStatus {
	/** Desktop control works on this OS (macOS for now). */
	readonly supported: boolean;
	/** Volt has the Accessibility permission (needed to read and drive other apps). */
	readonly trusted: boolean;
	/** Volt has the Screen Recording permission (only screenshots of other apps need it). */
	readonly screen: boolean;
	/** Why it cannot run, e.g. the Swift compiler is missing. */
	readonly error?: string;
}

export interface IVoltDesktopApp {
	readonly name: string;
	readonly bundle: string;
	readonly pid: number;
	readonly active: boolean;
	readonly hidden: boolean;
}

/** One accessibility element as the helper reads it; frames are in screen points (top-left origin). */
export interface IVoltDesktopNode {
	/** Handle for acting on it; valid until the next tree read. */
	readonly h: string;
	readonly role: string;
	readonly sub?: string;
	readonly title?: string;
	readonly desc?: string;
	readonly value?: string;
	readonly help?: string;
	/** Placeholder text. */
	readonly ph?: string;
	/** AXIdentifier. */
	readonly id?: string;
	readonly disabled?: boolean;
	readonly focused?: boolean;
	readonly selected?: boolean;
	readonly expanded?: boolean;
	readonly f?: readonly [number, number, number, number];
	readonly c?: readonly IVoltDesktopNode[];
}

export interface IVoltDesktopTree {
	readonly app: string;
	readonly bundle: string;
	readonly pid: number;
	/** The window read (the focused one, unless a window title was asked for). */
	readonly window?: string;
	readonly windows: readonly string[];
	readonly root?: IVoltDesktopNode;
	readonly truncated?: boolean;
}

export type VoltDesktopAction =
	/** An accessibility action on an element: AXPress (default), AXIncrement, AXShowMenu, AXConfirm, … */
	| { readonly kind: 'press'; readonly h: string; readonly action?: string }
	/** Sets a text field's value directly (and focuses it). */
	| { readonly kind: 'setValue'; readonly h: string; readonly value: string }
	| { readonly kind: 'focus'; readonly h: string }
	| { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button?: 'left' | 'right'; readonly count?: number }
	| { readonly kind: 'type'; readonly text: string }
	/** A key chord, e.g. "cmd+s", "enter", "shift+tab". */
	| { readonly kind: 'key'; readonly combo: string }
	| { readonly kind: 'scroll'; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
	/** Brings an app to the front, opening it if needed (name or bundle id), or opens a URL. */
	| { readonly kind: 'activate'; readonly app: string }
	/** Picks a menu bar item by its path, e.g. ["File", "Export", "PDF…"]. */
	| { readonly kind: 'menu'; readonly app?: string; readonly path: readonly string[] };

/**
 * Reads and drives other apps on the user's desktop through the OS accessibility APIs (macOS),
 * for the agent's desktop_* tools. Lives in the main process: the workbench is sandboxed.
 */
export interface IVoltDesktopService {
	readonly _serviceBrand: undefined;
	/** `prompt` asks macOS to show its Accessibility permission prompt for Volt. */
	status(prompt?: boolean): Promise<IVoltDesktopStatus>;
	apps(): Promise<IVoltDesktopApp[]>;
	/** The accessibility tree of an app's focused window (or the frontmost app's). */
	tree(target: { readonly app?: string; readonly pid?: number; readonly window?: string; readonly max?: number }): Promise<IVoltDesktopTree>;
	act(action: VoltDesktopAction): Promise<void>;
}
