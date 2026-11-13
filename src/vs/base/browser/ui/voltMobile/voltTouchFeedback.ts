/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a finger feels on a phone: every button, row and card answers a touch at once with a pressed
// state and a ripple from where it was touched (round and centered on icon buttons), and a long
// press opens the element's context menu where the browser does not (iOS Safari never fires
// `contextmenu`). One listener on the workbench covers every control, existing ones included: no
// widget is changed to get it. The ripple is drawn in a layer over the control, so the control's
// own layout, overflow and positioning are never touched.

import './voltMobile.css';
import { $, addDisposableListener, getWindow, isHTMLElement } from '../../dom.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { isIOS } from '../../../common/platform.js';

/** What answers a touch: buttons, menu items, list rows, tabs, toggles, and cards marked for it. */
export const VOLT_TOUCH_INTERACTIVE = [
	'button', 'a[href]', '[role="button"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
	'[role="option"]', '[role="tab"]', '[role="treeitem"]', '[role="checkbox"]', '[role="switch"]', '[role="link"]',
	'.monaco-button', '.action-label', '.monaco-list-row', '.monaco-custom-toggle', '.volt-touch-card', '.volt-touch-icon',
].join(', ');

/** Never: text, code and terminals keep the platform's own touch behavior. */
export const VOLT_TOUCH_EXCLUDED = [
	'input', 'textarea', 'select', '[contenteditable="true"]', '.monaco-editor .view-lines', '.monaco-editor .inputarea',
	'.xterm-screen', '.monaco-sash', '.volt-no-ripple',
].join(', ');

/** Areas whose widgets already turn a long press into a context menu (VS Code's Gesture: lists, tabs, view headers). */
const GESTURE_CONTEXT_MENU_AREAS = '.monaco-list, .tabs-container, .composite-bar, .part.statusbar, .monaco-pane-view, .monaco-editor';

const PRESS_DELAY_MS = 50;
const LONG_PRESS_MS = 480;
const MOVE_SLOP = 10;
/** A press shows at least this long, so a quick tap still reads. */
const MIN_PRESS_MS = 140;
/** Icon buttons at most this big get a round ripple from their center. */
const ICON_MAX_SIZE = 48;

interface IPress {
	readonly pointerId: number;
	readonly target: HTMLElement;
	readonly origin: Element;
	readonly x: number;
	readonly y: number;
	readonly start: number;
	shown: boolean;
	ripple: HTMLElement | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	longPress: ReturnType<typeof setTimeout> | undefined;
}

export interface IVoltTouchFeedbackOptions {
	/** Opens context menus on a long press where the browser does not. Defaults to iOS only. */
	readonly longPressContextMenu?: boolean;
	/** Reduced motion: a flat tint instead of a spreading ripple, and no scaling. */
	readonly reducedMotion?: () => boolean;
}

/** A short tick where the platform has one (Android); nothing elsewhere. */
export function voltHaptic(kind: 'tick' | 'press' = 'tick'): void {
	try {
		(navigator as Navigator & { vibrate?: (pattern: number) => boolean }).vibrate?.(kind === 'press' ? 12 : 6);
	} catch {
		// Not allowed before a user gesture; feedback is optional.
	}
}

export class VoltTouchFeedback extends Disposable {

	private press: IPress | undefined;
	private readonly layer: HTMLElement;
	/** The click a long press would still send to the element: swallowed, the menu already opened. */
	private swallowClickUntil = 0;

	constructor(private readonly root: HTMLElement, private readonly options: IVoltTouchFeedbackOptions = {}) {
		super();
		this.layer = $('.volt-ripple-layer');
		this.layer.setAttribute('aria-hidden', 'true');
		root.appendChild(this.layer);
		this._register(toDisposable(() => this.layer.remove()));

		const win = getWindow(root);
		this._register(addDisposableListener(root, 'pointerdown', (e: PointerEvent) => this.onDown(e), { capture: true, passive: true }));
		this._register(addDisposableListener(win, 'pointermove', (e: PointerEvent) => this.onMove(e), { capture: true, passive: true }));
		this._register(addDisposableListener(win, 'pointerup', (e: PointerEvent) => this.onUp(e), { capture: true, passive: true }));
		this._register(addDisposableListener(win, 'pointercancel', (e: PointerEvent) => this.onCancel(e), { capture: true, passive: true }));
		// Scrolling the content under the finger cancels the press.
		this._register(addDisposableListener(root, 'scroll', () => this.cancel(), { capture: true, passive: true }));
		this._register(addDisposableListener(root, 'click', (e: MouseEvent) => {
			if (Date.now() < this.swallowClickUntil) {
				this.swallowClickUntil = 0;
				e.preventDefault();
				e.stopPropagation();
			}
		}, true));
		this._register(toDisposable(() => this.cancel()));
	}

	private onDown(e: PointerEvent): void {
		if (e.pointerType === 'mouse' || !e.isPrimary) {
			return;
		}
		this.cancel();
		const origin = e.target instanceof Element ? e.target : undefined;
		const target = origin ? findTouchTarget(origin, this.root) : undefined;
		if (!origin || !target) {
			return;
		}
		const press: IPress = {
			pointerId: e.pointerId, target, origin, x: e.clientX, y: e.clientY, start: Date.now(),
			shown: false, ripple: undefined, timer: undefined, longPress: undefined,
		};
		this.press = press;
		// A beat before showing, so a finger that starts a scroll does not light up what it passed over.
		press.timer = setTimeout(() => this.show(press), PRESS_DELAY_MS);
		const longPress = this.options.longPressContextMenu ?? isIOS;
		if (longPress && !origin.closest(GESTURE_CONTEXT_MENU_AREAS)) {
			press.longPress = setTimeout(() => this.onLongPress(press), LONG_PRESS_MS);
		}
	}

	private onMove(e: PointerEvent): void {
		const press = this.press;
		if (press && e.pointerId === press.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP) {
			this.cancel();
		}
	}

	private onUp(e: PointerEvent): void {
		const press = this.press;
		if (!press || e.pointerId !== press.pointerId) {
			return;
		}
		this.press = undefined;
		clearTimeout(press.longPress);
		clearTimeout(press.timer);
		// A quick tap released before the press showed still gets its ripple.
		this.show(press);
		const remaining = Math.max(0, MIN_PRESS_MS - (Date.now() - press.start));
		setTimeout(() => this.release(press, false), remaining);
	}

	private onCancel(e: PointerEvent): void {
		if (this.press && e.pointerId === this.press.pointerId) {
			this.cancel();
		}
	}

	private cancel(): void {
		const press = this.press;
		if (!press) {
			return;
		}
		this.press = undefined;
		clearTimeout(press.timer);
		clearTimeout(press.longPress);
		this.release(press, true);
	}

	private show(press: IPress): void {
		if (press.shown || !press.target.isConnected) {
			return;
		}
		press.shown = true;
		const target = press.target;
		// A control can confine its ripple to a part of itself (the navigation bar's pill).
		const host = target.querySelector<HTMLElement>('.volt-ripple-host') ?? target;
		const rect = host.getBoundingClientRect();
		const icon = host === target && isIconButton(target, rect);
		target.classList.add('volt-pressed');
		target.classList.toggle('volt-pressed-icon', icon);
		if (rect.width <= 0 || rect.height <= 0) {
			return;
		}
		press.ripple = this.drawRipple(host, rect, icon, press.x, press.y);
	}

	private release(press: IPress, cancelled: boolean): void {
		press.target.classList.remove('volt-pressed', 'volt-pressed-icon');
		const ripple = press.ripple;
		press.ripple = undefined;
		if (!ripple) {
			return;
		}
		ripple.classList.add(cancelled ? 'cancelled' : 'fading');
		setTimeout(() => ripple.remove(), cancelled ? 120 : 320);
	}

	private drawRipple(target: HTMLElement, rect: DOMRect, icon: boolean, x: number, y: number): HTMLElement {
		const win = getWindow(target);
		const style = win.getComputedStyle(target);
		const host = $('.volt-ripple');
		host.style.color = style.color;
		const reduced = this.options.reducedMotion?.() ?? false;
		host.classList.toggle('reduced', reduced);
		let left = rect.left;
		let top = rect.top;
		let width = rect.width;
		let height = rect.height;
		if (icon) {
			// Round, a little larger than the glyph, centered on it.
			const size = Math.max(36, Math.max(rect.width, rect.height) + 8);
			left = rect.left + rect.width / 2 - size / 2;
			top = rect.top + rect.height / 2 - size / 2;
			width = height = size;
			host.style.borderRadius = '50%';
		} else {
			host.style.borderRadius = style.borderRadius;
		}
		host.style.left = `${left}px`;
		host.style.top = `${top}px`;
		host.style.width = `${width}px`;
		host.style.height = `${height}px`;
		const wave = host.appendChild($('.volt-ripple-wave'));
		const cx = icon ? width / 2 : Math.min(Math.max(x - left, 0), width);
		const cy = icon ? height / 2 : Math.min(Math.max(y - top, 0), height);
		// Big enough to reach the farthest corner from where it starts.
		const radius = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
		wave.style.left = `${cx - radius}px`;
		wave.style.top = `${cy - radius}px`;
		wave.style.width = wave.style.height = `${radius * 2}px`;
		this.layer.appendChild(host);
		void wave.offsetWidth;
		host.classList.add('spreading');
		return host;
	}

	private onLongPress(press: IPress): void {
		if (this.press !== press || !press.origin.isConnected) {
			return;
		}
		const event = new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: press.x,
			clientY: press.y,
			view: getWindow(press.origin),
			button: 2,
			buttons: 0,
		});
		press.origin.dispatchEvent(event);
		if (event.defaultPrevented) {
			// Something opened a menu: let go of the press, and drop the click the lift would send.
			voltHaptic('press');
			this.swallowClickUntil = Date.now() + 800;
			this.cancel();
		}
	}
}

/** The control a touch on `origin` lands on, or undefined (text, code, disabled controls, nothing). */
export function findTouchTarget(origin: Element, root: HTMLElement): HTMLElement | undefined {
	if (origin.closest(VOLT_TOUCH_EXCLUDED)) {
		return undefined;
	}
	const target = origin.closest(VOLT_TOUCH_INTERACTIVE);
	if (!isHTMLElement(target) || !root.contains(target) || isDisabled(target)) {
		return undefined;
	}
	return target;
}

function isDisabled(el: HTMLElement): boolean {
	return el.matches(':disabled, [aria-disabled="true"], .disabled, .is-disabled');
}

/** Small and square-ish with no text of its own: an icon button. */
export function isIconButton(el: HTMLElement, rect: { readonly width: number; readonly height: number }): boolean {
	if (el.classList.contains('volt-touch-icon')) {
		return true;
	}
	if (el.classList.contains('volt-touch-card') || el.classList.contains('monaco-list-row')) {
		return false;
	}
	return rect.width <= ICON_MAX_SIZE && rect.height <= ICON_MAX_SIZE && Math.abs(rect.width - rect.height) <= 14 && !el.textContent?.trim();
}
