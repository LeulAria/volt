/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IUserGestureToken } from '../../../../platform/voltSandbox/common/principals.js';
import { GestureTokenRegistry } from '../../../../platform/voltSandbox/common/trust.js';

/** G.12: a permission button does nothing for this long after it appears. */
export const PERMISSION_BUTTON_INERT_MS = 500;

/** Why a click on a permission button was not taken as the user's answer. */
export type GestureRefusal = 'untrusted' | 'inert' | 'no-pointer-movement';

export interface IGestureButtonOptions {
	/** The element pointer movement must happen over (the card or dialog). Default: the button. */
	readonly area?: HTMLElement;
	readonly inertMs?: number;
	/** The click did not count. */
	readonly onRefused?: (why: GestureRefusal) => void;
}

/**
 * Arms one of Volt's own permission buttons (spec G.7, G.12): it stays disabled for 500 ms after it
 * appears, a pointer click counts only after the pointer moved over the card, and only a real
 * input event (`isTrusted`: the browser's own, never `element.click()` or a dispatched event)
 * mints a gesture token for `principal`. Keyboard activation needs no pointer movement. A webview
 * or an extension can't reach this handler (their "clicks" are messages), so they can't produce a
 * token; the grant path refuses anything without one (`IVoltTrustService.grant`).
 */
export function bindGestureButton(button: Button, registry: GestureTokenRegistry, principal: string, onGesture: (token: IUserGestureToken) => void, options: IGestureButtonOptions = {}): IDisposable {
	const store = new DisposableStore();
	const area = options.area ?? button.element;
	const inertMs = options.inertMs ?? PERMISSION_BUTTON_INERT_MS;
	const shownAt = Date.now();
	let moved = false;
	button.enabled = false;
	button.element.classList.add('volt-gesture-inert');
	const window = getWindow(button.element);
	const timer = window.setTimeout(() => {
		button.enabled = true;
		button.element.classList.remove('volt-gesture-inert');
	}, inertMs);
	store.add(toDisposable(() => window.clearTimeout(timer)));
	store.add(addDisposableListener(area, 'pointermove', (e: PointerEvent) => {
		if (e.isTrusted) {
			moved = true;
		}
	}));
	store.add(button.onDidClick(e => {
		if (!e?.isTrusted) {
			options.onRefused?.('untrusted');
			return;
		}
		if (Date.now() - shownAt < inertMs) {
			options.onRefused?.('inert');
			return;
		}
		const keyboard = isKeyboardActivation(e);
		if (!keyboard && !moved) {
			options.onRefused?.('no-pointer-movement');
			return;
		}
		onGesture(registry.mint(principal));
	}));
	return store;
}

/** Enter or Space on the focused button (a keyboard event, or the click a key press makes, whose `detail` is 0). */
function isKeyboardActivation(e: Event): boolean {
	return e.type === 'keydown' || e.type === 'keyup' || e.type === 'keypress' || (e.type === 'click' && (e as MouseEvent).detail === 0);
}
