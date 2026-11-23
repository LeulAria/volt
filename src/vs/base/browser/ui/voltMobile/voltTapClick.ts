/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A finger's tap inside one of VS Code's gesture targets (a view container, a part's title, a list)
// never sends the native click: Gesture cancels the touch once it has dispatched its own Tap. VS
// Code's controls listen for that Tap; a plain button that only knows `click` (the Projects screen's
// shortcuts, a page's own buttons) did nothing under a finger. After a Tap nobody took, this sends
// the click the touch would have sent, to the control the finger was on.

import { getWindow, isHTMLElement } from '../../dom.js';
import { EventType as TouchEventType, GestureEvent } from '../../touch.js';
import { IDisposable, toDisposable } from '../../../common/lifecycle.js';

/** What a tap activates with a click. */
const CONTROL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], summary, label';
/** Where taps mean something else, or a VS Code widget that already answers the Tap itself. */
const OWN_TAPS = '.monaco-editor, .xterm, input, textarea, select, [contenteditable="true"], .monaco-button, .monaco-action-bar, .monaco-custom-toggle, .monaco-list-row';

interface IPendingTap {
	readonly event: GestureEvent;
	/** Each element the Tap was dispatched to (Gesture's targets that hold the finger's point). */
	readonly targets: EventTarget[];
}

export function installVoltTapClick(root: HTMLElement, enabled: () => boolean): IDisposable {
	const doc = root.ownerDocument;
	let pending: IPendingTap | undefined;

	const flush = (tap: IPendingTap) => {
		if (pending === tap) {
			pending = undefined;
		}
		const origin = tap.event.initialTarget;
		if (tap.event.defaultPrevented || !(origin instanceof Element) || !root.contains(origin)) {
			return;
		}
		const control = origin.closest(CONTROL);
		if (!isHTMLElement(control) || !root.contains(control) || control.closest(OWN_TAPS)) {
			return;
		}
		// The control (or something in it) is a gesture target of its own: it answered the Tap already.
		if (tap.targets.some(target => target instanceof Node && control.contains(target))) {
			return;
		}
		if ((control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true') {
			return;
		}
		const win = getWindow(control);
		const clientX = tap.event.pageX - win.scrollX;
		const clientY = tap.event.pageY - win.scrollY;
		origin.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: win, detail: 1, clientX, clientY, screenX: clientX, screenY: clientY }));
	};

	const onTap = (e: Event) => {
		if (!enabled()) {
			return;
		}
		const event = e as GestureEvent;
		if (!pending || pending.event !== event) {
			const tap: IPendingTap = { event, targets: [] };
			pending = tap;
			// Gesture dispatches one Tap to every target in turn, synchronously: decide once they all had it.
			getWindow(root).setTimeout(() => flush(tap), 0);
		}
		if (e.target) {
			pending.targets.push(e.target);
		}
	};

	// Gesture's events do not bubble; the capture phase still passes the document on the way to each target.
	doc.addEventListener(TouchEventType.Tap, onTap, true);
	return toDisposable(() => doc.removeEventListener(TouchEventType.Tap, onTap, true));
}
