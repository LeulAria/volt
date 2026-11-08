/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';

/** Presses here stay theirs: the text, buttons, fields, the model and Batch edits switches. */
const NOT_A_HANDLE = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="switch"], [role="option"], .monaco-editor';

/** How far the pointer goes before a press becomes a drag: a click (focus the text) stays a click. */
const DRAG_THRESHOLD = 3;

/**
 * Lets the user move a floating box (a comment or prompt box) by pressing on its blank parts and
 * dragging, like macOS's screenshot thumbnail. `onMove` gets the box's new left/top in its
 * containing block's px; the caller clamps it, keeps it and places the box. `canDrag` turns it off
 * (a comment folded into its pin).
 */
export function makeBoxDraggable(box: HTMLElement, onMove: (position: { left: number; top: number }) => void, canDrag: () => boolean = () => true): IDisposable {
	const store = new DisposableStore();
	let press: { pointerId: number; x: number; y: number; left: number; top: number; dragging: boolean } | undefined;
	const isHandle = (e: MouseEvent) => e.button === 0 && e.target instanceof Element && !e.target.closest(NOT_A_HANDLE) && canDrag();

	store.add(addDisposableListener(box, 'pointerdown', e => {
		if (!isHandle(e)) {
			return;
		}
		// No pointer capture yet: the press's mousedown must still reach the composer, which focuses its text.
		press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop, dragging: false };
	}));
	store.add(addDisposableListener(box, 'pointermove', e => {
		if (!press || e.pointerId !== press.pointerId) {
			return;
		}
		// Let go outside the box before it became a drag: the press is over.
		if (!(e.buttons & 1)) {
			press = undefined;
			return;
		}
		const dx = e.clientX - press.x;
		const dy = e.clientY - press.y;
		if (!press.dragging) {
			if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
				return;
			}
			press.dragging = true;
			box.classList.add('volt-box-dragging');
			try {
				box.setPointerCapture(e.pointerId);
			} catch {
				// Not an active pointer (a synthetic event): the drag works while the pointer stays over the box.
			}
		}
		e.preventDefault();
		onMove({ left: press.left + dx, top: press.top + dy });
	}));
	const end = (e: PointerEvent) => {
		if (!press || e.pointerId !== press.pointerId) {
			return;
		}
		press = undefined;
		box.classList.remove('volt-box-dragging');
		if (box.hasPointerCapture(e.pointerId)) {
			box.releasePointerCapture(e.pointerId);
		}
	};
	store.add(addDisposableListener(box, 'pointerup', end));
	store.add(addDisposableListener(box, 'pointercancel', end));
	store.add(addDisposableListener(box, 'lostpointercapture', end));
	return store;
}
