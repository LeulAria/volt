/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the screen is and what covers it: the form factor (phone, tablet, desktop), the safe areas
// (notch, home indicator, rounded corners), an on-screen keyboard, and the room the phone's bottom
// navigation takes. Off until the browser workbench installs it, so the desktop never sees it:
// `getVoltViewport()` is undefined there and every caller keeps its desktop behavior.

import { addDisposableListener, getActiveElement, isEditableElement } from '../../dom.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';

export const enum VoltFormFactor {
	Desktop = 'desktop',
	Tablet = 'tablet',
	Phone = 'phone',
}

export interface IVoltInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export interface IVoltViewportState {
	readonly formFactor: VoltFormFactor;
	/** No hover and a coarse pointer: a finger, not a mouse. */
	readonly touch: boolean;
	readonly landscape: boolean;
	/** The device's safe areas (env(safe-area-inset-*)); zero without `viewport-fit=cover`. */
	readonly safe: IVoltInsets;
	/** Px of the window an on-screen keyboard covers; 0 when it is closed or the page already shrank for it. */
	readonly keyboard: number;
	/** An on-screen keyboard is up (an editable element has focus and the viewport shrank for it). */
	readonly keyboardOpen: boolean;
	readonly reducedMotion: boolean;
	/** Px the bottom navigation takes, safe area included; 0 while it is hidden. */
	readonly bottomBar: number;
}

/** Narrower than this is a phone in portrait (and a narrow desktop window, which lays out the same). */
export const VOLT_PHONE_MAX_WIDTH = 600;
/** A touch screen shorter than this is a phone on its side. */
const PHONE_LANDSCAPE_MAX_HEIGHT = 500;
/** A touch screen narrower than this that is not a phone is a tablet. */
const TABLET_MAX_WIDTH = 1366;
/** The viewport shrinking by more than this while a field has focus is a keyboard, not a toolbar. */
const KEYBOARD_MIN_HEIGHT = 120;

const ZERO: IVoltInsets = { top: 0, right: 0, bottom: 0, left: 0 };

let current: VoltViewport | undefined;

/** The installed viewport, or undefined (the desktop, and the browser before the workbench starts). */
export function getVoltViewport(): VoltViewport | undefined {
	return current;
}

/** True on a phone-sized browser window: menus become sheets, large surfaces become pages. */
export function isVoltCompact(): boolean {
	return current?.state.formFactor === VoltFormFactor.Phone;
}

/** Room the workbench grid leaves at its edges: the safe areas, and the bottom navigation below it. */
export function getVoltLayoutInsets(): IVoltInsets {
	return current ? layoutInsets(current.state) : ZERO;
}

export class VoltViewport extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IVoltViewportState>());
	readonly onDidChange: Event<IVoltViewportState> = this._onDidChange.event;

	private _state: IVoltViewportState;
	get state(): IVoltViewportState { return this._state; }

	private readonly probe: HTMLElement;
	/** The tallest the window has been at each width: what it shrinks from when a keyboard opens (Android resizes the page). */
	private readonly tallest = new Map<number, number>();
	private bottomBar = 0;
	private frame: number | undefined;

	/**
	 * @param root the element that takes the classes and CSS variables (the workbench's main container,
	 * which also defines the theme's variables for everything mounted in it).
	 */
	static install(targetWindow: Window, root: HTMLElement): VoltViewport {
		current?.dispose();
		current = new VoltViewport(targetWindow, root);
		return current;
	}

	private constructor(private readonly targetWindow: Window, private readonly root: HTMLElement) {
		super();
		const doc = targetWindow.document;
		this.probe = doc.createElement('div');
		this.probe.className = 'volt-viewport-probe';
		this.probe.setAttribute('aria-hidden', 'true');
		this.probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
			+ 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
		doc.body.appendChild(this.probe);
		this._register(toDisposable(() => this.probe.remove()));

		this._state = this.measure();
		this.apply(undefined);

		const schedule = () => this.schedule();
		this._register(addDisposableListener(targetWindow, 'resize', schedule));
		this._register(addDisposableListener(targetWindow, 'orientationchange', schedule));
		const vv = targetWindow.visualViewport;
		if (vv) {
			this._register(addDisposableListener(vv, 'resize', schedule));
			this._register(addDisposableListener(vv, 'scroll', schedule));
		}
		// Focus moving into or out of a field opens or closes the keyboard before the resize lands.
		this._register(addDisposableListener(doc, 'focusin', schedule));
		this._register(addDisposableListener(doc, 'focusout', schedule));
		for (const query of ['(hover: none)', '(pointer: coarse)', '(prefers-reduced-motion: reduce)']) {
			const list = targetWindow.matchMedia(query);
			list.addEventListener('change', schedule);
			this._register(toDisposable(() => list.removeEventListener('change', schedule)));
		}
		this._register(toDisposable(() => {
			if (this.frame !== undefined) {
				targetWindow.cancelAnimationFrame(this.frame);
			}
			this.clear();
			if (current === this) {
				current = undefined;
			}
		}));
	}

	/** The bottom navigation reports its height (safe area included), or 0 when hidden. */
	setBottomBar(height: number): void {
		if (this.bottomBar !== height) {
			this.bottomBar = height;
			this.update();
		}
	}

	/** Measures again now (after a layout change that fires no resize). */
	update(): void {
		const previous = this._state;
		this._state = this.measure();
		if (!sameState(previous, this._state)) {
			this.apply(previous);
			this._onDidChange.fire(this._state);
		}
	}

	private schedule(): void {
		if (this.frame === undefined) {
			this.frame = this.targetWindow.requestAnimationFrame(() => {
				this.frame = undefined;
				this.update();
			});
		}
	}

	private measure(): IVoltViewportState {
		const win = this.targetWindow;
		const width = win.innerWidth;
		const height = win.innerHeight;
		const touch = win.matchMedia('(hover: none)').matches || win.matchMedia('(pointer: coarse)').matches;
		const landscape = width > height;
		let formFactor = VoltFormFactor.Desktop;
		if (width <= VOLT_PHONE_MAX_WIDTH || (touch && landscape && height <= PHONE_LANDSCAPE_MAX_HEIGHT)) {
			formFactor = VoltFormFactor.Phone;
		} else if (touch && width <= TABLET_MAX_WIDTH) {
			formFactor = VoltFormFactor.Tablet;
		}

		const style = win.getComputedStyle(this.probe);
		const safe: IVoltInsets = {
			top: parseFloat(style.paddingTop) || 0,
			right: parseFloat(style.paddingRight) || 0,
			bottom: parseFloat(style.paddingBottom) || 0,
			left: parseFloat(style.paddingLeft) || 0,
		};

		// iOS overlays the keyboard on the layout viewport; Android (interactive-widget=resizes-content)
		// shrinks the page instead, which shows as the window being shorter than it was at this width.
		const vv = win.visualViewport;
		const overlaid = vv ? Math.max(0, Math.round(height - vv.height - vv.offsetTop)) : 0;
		const tallest = Math.max(this.tallest.get(width) ?? 0, height);
		this.tallest.set(width, tallest);
		const active = getActiveElement();
		const editing = !!active && isEditableElement(active);
		const shrunk = tallest - height;
		const keyboardOpen = touch && editing && (overlaid > KEYBOARD_MIN_HEIGHT || shrunk > KEYBOARD_MIN_HEIGHT);
		return {
			formFactor,
			touch,
			landscape,
			safe,
			keyboard: keyboardOpen ? overlaid : 0,
			keyboardOpen,
			reducedMotion: win.matchMedia('(prefers-reduced-motion: reduce)').matches,
			bottomBar: this.bottomBar,
		};
	}

	private apply(previous: IVoltViewportState | undefined): void {
		const s = this._state;
		const root = this.root;
		root.classList.toggle('volt-mobile', s.formFactor !== VoltFormFactor.Desktop);
		root.classList.toggle('volt-mobile-phone', s.formFactor === VoltFormFactor.Phone);
		root.classList.toggle('volt-mobile-tablet', s.formFactor === VoltFormFactor.Tablet);
		root.classList.toggle('volt-mobile-touch', s.touch);
		root.classList.toggle('volt-mobile-landscape', s.landscape);
		root.classList.toggle('volt-mobile-keyboard', s.keyboardOpen);
		root.classList.toggle('volt-mobile-reduced-motion', s.reducedMotion);
		if (previous && sameInsets(previous.safe, s.safe) && previous.keyboard === s.keyboard && previous.bottomBar === s.bottomBar && previous.keyboardOpen === s.keyboardOpen) {
			return;
		}
		const insets = layoutInsets(s);
		const vars: [string, number][] = [
			['--volt-safe-top', s.safe.top],
			['--volt-safe-right', s.safe.right],
			['--volt-safe-bottom', s.keyboardOpen ? 0 : s.safe.bottom],
			['--volt-safe-left', s.safe.left],
			['--volt-keyboard', s.keyboard],
			['--volt-bottom-bar', s.keyboardOpen ? 0 : s.bottomBar],
			['--volt-inset-bottom', insets.bottom],
		];
		for (const [name, value] of vars) {
			root.style.setProperty(name, `${value}px`);
		}
	}

	private clear(): void {
		const root = this.root;
		root.classList.remove('volt-mobile', 'volt-mobile-phone', 'volt-mobile-tablet', 'volt-mobile-touch', 'volt-mobile-landscape', 'volt-mobile-keyboard', 'volt-mobile-reduced-motion');
		for (const name of ['--volt-safe-top', '--volt-safe-right', '--volt-safe-bottom', '--volt-safe-left', '--volt-keyboard', '--volt-bottom-bar', '--volt-inset-bottom']) {
			root.style.removeProperty(name);
		}
	}
}

function layoutInsets(s: IVoltViewportState): IVoltInsets {
	// The keyboard covers the home indicator and the navigation; the page already shrank for it.
	const bottom = s.keyboardOpen ? 0 : Math.max(s.safe.bottom, s.bottomBar);
	return { top: s.safe.top, right: s.safe.right, bottom, left: s.safe.left };
}

function sameInsets(a: IVoltInsets, b: IVoltInsets): boolean {
	return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

function sameState(a: IVoltViewportState, b: IVoltViewportState): boolean {
	return a.formFactor === b.formFactor && a.touch === b.touch && a.landscape === b.landscape && sameInsets(a.safe, b.safe)
		&& a.keyboard === b.keyboard && a.keyboardOpen === b.keyboardOpen && a.reducedMotion === b.reducedMotion && a.bottomBar === b.bottomBar;
}
