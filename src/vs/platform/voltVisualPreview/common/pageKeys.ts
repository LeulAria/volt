/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh } from '../../../base/common/platform.js';

/** A key as the DevTools protocol dispatches it. */
export interface IPageKey {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	/** What typing it inserts, for printable keys and Enter. */
	readonly text?: string;
}

const NAMED_KEYS: Readonly<Record<string, IPageKey>> = {
	enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
	return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
	tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
	escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
	esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
	backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
	delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
	del: { key: 'Delete', code: 'Delete', keyCode: 46 },
	space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
	spacebar: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
	arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
	up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
	arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
	down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
	arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
	left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
	arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
	right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
	home: { key: 'Home', code: 'Home', keyCode: 36 },
	end: { key: 'End', code: 'End', keyCode: 35 },
	pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
	pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
	insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};

/** DevTools modifier bits. */
const MODIFIERS: Readonly<Record<string, number>> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
export const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;

/** On a Mac, editing shortcuts are the window's commands, not the page's: name them so they run. */
export const MAC_COMMANDS: Readonly<Record<string, string>> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

function keyOf(name: string): IPageKey | undefined {
	const named = NAMED_KEYS[name.toLowerCase()];
	if (named) {
		return named;
	}
	const fn = /^f([1-9]|1[0-2])$/i.exec(name);
	if (fn) {
		return { key: name.toUpperCase(), code: name.toUpperCase(), keyCode: 111 + Number(fn[1]) };
	}
	if (name.length === 1) {
		const upper = name.toUpperCase();
		const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : '';
		return { key: name, code, keyCode: /[a-z\d]/i.test(name) ? upper.charCodeAt(0) : 0, text: name };
	}
	return undefined;
}

/** "Meta+a", "Shift+Tab", "Enter" as DevTools modifier bits and a key; undefined for an unknown key. */
export function parseKeyCombo(combo: string): { readonly modifiers: number; readonly key: IPageKey } | undefined {
	const parts = combo.split('+').map(part => part.trim());
	// "Meta++" ends in the plus key itself.
	const name = parts.length > 1 && parts[parts.length - 1] === '' ? '+' : parts.pop() ?? '';
	let modifiers = 0;
	for (const part of parts.filter(Boolean)) {
		const lower = part.toLowerCase();
		modifiers |= lower === 'controlormeta' || lower === 'cmdorctrl' ? (isMacintosh ? META : CTRL) : MODIFIERS[lower] ?? 0;
	}
	const key = keyOf(name);
	return key ? { modifiers, key } : undefined;
}

