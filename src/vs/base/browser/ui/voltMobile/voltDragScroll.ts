/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Rows that scroll sideways (filter chips, tab strips, pill bars) follow a finger or a mouse drag on
// a phone. A touch screen pans them natively unless something above cancels the touch (VS Code's
// Gesture does on its scrollable parts); a mouse never could, short of a trackpad. One listener on
// the workbench covers every such row: the row is found by its computed overflow when the drag
// starts, so no widget is changed to get it. A drag that moved the row swallows the click its
// release would send, and a quick flick carries on for a moment.

import { addDisposableListener, getWindow, isHTMLElement } from '../../dom.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';

/** Text, code, terminals and the workbench's own scrollbars keep their own dragging. */
const EXCLUDED = 'input, textarea, select, [contenteditable="true"], .monaco-editor, .xterm, .monaco-sash, .monaco-scrollable-element > .scrollbar, .volt-sheet-grabber, .volt-no-drag-scroll';

const SLOP = 8;
/** A release this fast (px/ms) carries on. */
const FLING_MIN = 0.3;
const FRICTION = 0.94;

interface IDrag {
	readonly pointerId: number;
	readonly row: HTMLElement;
	readonly x: number;
	readonly y: number;
	readonly start: number;
	active: boolean;
	lastX: number;
	lastTime: number;
	velocity: number;
}

export interface IVoltDragScrollOptions {
	/** Whether rows follow drags now (a phone-sized window). */
	readonly enabled: () => boolean;
}

export class VoltDragScroll extends Disposable {

	private drag: IDrag | undefined;
	private swallowClickUntil = 0;
	private fling: number | undefined;

	constructor(private readonly root: HTMLElement, private readonly options: IVoltDragScrollOptions) {
		super();
		const win = getWindow(root);
		this._register(addDisposableListener(root, 'pointerdown', (e: PointerEvent) => this.onDown(e), { capture: true, passive: true }));
		this._register(addDisposableListener(win, 'pointermove', (e: PointerEvent) => this.onMove(e), { capture: true }));
		this._register(addDisposableListener(win, 'pointerup', (e: PointerEvent) => this.onUp(e), { capture: true, passive: true }));
		// The browser took the touch over for its own panning: it scrolls the row itself.
		this._register(addDisposableListener(win, 'pointercancel', () => this.drag = undefined, { capture: true, passive: true }));
		this._register(addDisposableListener(root, 'click', (e: MouseEvent) => {
			if (Date.now() < this.swallowClickUntil) {
				this.swallowClickUntil = 0;
				e.preventDefault();
				e.stopPropagation();
			}
		}, true));
		this._register(toDisposable(() => this.stopFling()));
	}

	private onDown(e: PointerEvent): void {
		this.stopFling();
		this.drag = undefined;
		if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !this.options.enabled()) {
			return;
		}
		const row = e.target instanceof Element ? findHorizontalScroller(e.target, this.root) : undefined;
		if (row) {
			this.drag = { pointerId: e.pointerId, row, x: e.clientX, y: e.clientY, start: row.scrollLeft, active: false, lastX: e.clientX, lastTime: performance.now(), velocity: 0 };
		}
	}

	private onMove(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		const dx = e.clientX - drag.x;
		if (!drag.active) {
			const dy = e.clientY - drag.y;
			if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) {
				return;
			}
			// Mostly vertical: the page scrolls, not the row.
			if (Math.abs(dy) > Math.abs(dx)) {
				this.drag = undefined;
				return;
			}
			drag.active = true;
		}
		const now = performance.now();
		const dt = Math.max(1, now - drag.lastTime);
		drag.velocity = 0.7 * ((e.clientX - drag.lastX) / dt) + 0.3 * drag.velocity;
		drag.lastX = e.clientX;
		drag.lastTime = now;
		drag.row.scrollLeft = drag.start - dx;
		if (e.cancelable) {
			e.preventDefault();
		}
	}

	private onUp(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		this.drag = undefined;
		if (!drag.active) {
			return;
		}
		// The row moved: the release is not a tap on the chip under it.
		this.swallowClickUntil = Date.now() + 400;
		if (Math.abs(drag.velocity) > FLING_MIN) {
			this.startFling(drag.row, -drag.velocity * 16);
		}
	}

	private startFling(row: HTMLElement, velocity: number): void {
		const win = getWindow(row);
		const step = () => {
			velocity *= FRICTION;
			const before = row.scrollLeft;
			row.scrollLeft += velocity;
			if (Math.abs(velocity) < 0.5 || row.scrollLeft === before) {
				this.fling = undefined;
				return;
			}
			this.fling = win.requestAnimationFrame(step);
		};
		this.fling = win.requestAnimationFrame(step);
	}

	private stopFling(): void {
		if (this.fling !== undefined) {
			getWindow(this.root).cancelAnimationFrame(this.fling);
			this.fling = undefined;
		}
	}
}

/** The nearest element under `origin` that scrolls sideways and has more to show, or undefined. */
export function findHorizontalScroller(origin: Element, root: HTMLElement): HTMLElement | undefined {
	if (origin.closest(EXCLUDED)) {
		return undefined;
	}
	const win = getWindow(root);
	for (let el: Element | null = origin; el && el !== root; el = el.parentElement) {
		if (!isHTMLElement(el) || el.scrollWidth <= el.clientWidth + 1) {
			continue;
		}
		const overflow = win.getComputedStyle(el).overflowX;
		if (overflow === 'auto' || overflow === 'scroll') {
			return el;
		}
	}
	return undefined;
}
