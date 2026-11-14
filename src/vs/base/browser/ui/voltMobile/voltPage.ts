/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A full-screen page: what a surface too big for a sheet becomes on a phone (the More page, a large
// picker, a settings list). It slides in from the trailing edge over everything, with a compact
// header (Back, a title, its own actions) under the safe area. Back, Escape, the system Back and a
// swipe from the leading edge close it.

import './voltMobile.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../dom.js';
import { renderIcon } from '../iconLabel/iconLabels.js';
import { Codicon } from '../../../common/codicons.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import { ThemeIcon } from '../../../common/themables.js';
import { IVoltSurfaceEntry, openVoltSurface } from './voltSurfaces.js';
import { getVoltViewport } from './voltViewport.js';

export interface IVoltPageAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly run: (anchor: HTMLElement) => void;
}

export interface IVoltPageOptions {
	/** Where the page mounts: inside the workbench, so the theme's variables reach it. */
	readonly container: HTMLElement;
	readonly title: string;
	/** The Back button's label (screen readers). */
	readonly backLabel: string;
	readonly className?: string;
	readonly actions?: readonly IVoltPageAction[];
	/** Stops above the bottom navigation, which stays in reach (a page that is itself a destination). */
	readonly aboveBottomBar?: boolean;
}

/** A swipe back starts this close to the leading edge. */
const EDGE_WIDTH = 24;
const DRAG_SLOP = 8;
const FLICK_VELOCITY = 0.5;
const CLOSE_TIMEOUT_MS = 420;

export class VoltPage extends Disposable {

	readonly element: HTMLElement;
	readonly header: HTMLElement;
	readonly body: HTMLElement;
	readonly actions: HTMLElement;

	private readonly layer: HTMLElement;
	private readonly titleElement: HTMLElement;

	private readonly _onDidHide = this._register(new Emitter<void>());
	readonly onDidHide: Event<void> = this._onDidHide.event;

	private readonly _onDidResize = this._register(new Emitter<{ readonly width: number; readonly height: number }>());
	/** The body's size, after the page opens and whenever the window or keyboard changes it. */
	readonly onDidResize: Event<{ readonly width: number; readonly height: number }> = this._onDidResize.event;

	private readonly openStore = this._register(new DisposableStore());
	private entry: IVoltSurfaceEntry | undefined;
	private previousFocus: HTMLElement | undefined;
	private state: 'new' | 'open' | 'closing' | 'closed' = 'new';

	constructor(private readonly options: IVoltPageOptions) {
		super();
		this.layer = $('.volt-page-layer');
		this.layer.classList.toggle('above-bottom-bar', !!options.aboveBottomBar);
		this.element = append(this.layer, $('.volt-page'));
		if (options.className) {
			this.element.classList.add(...options.className.split(' ').filter(Boolean));
		}
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-label', options.title);
		this.element.tabIndex = -1;

		this.header = append(this.element, $('.volt-page-header'));
		const back = append(this.header, $('button.volt-page-back.volt-touch-icon')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.chevronLeft));
		back.setAttribute('aria-label', options.backLabel);
		back.title = options.backLabel;
		this._register(addDisposableListener(back, 'click', () => this.hide()));
		this.titleElement = append(this.header, $('h2.volt-page-title'));
		this.titleElement.textContent = options.title;
		this.actions = append(this.header, $('.volt-page-actions'));
		for (const action of options.actions ?? []) {
			const button = append(this.actions, $('button.volt-page-action.volt-touch-icon')) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(renderIcon(action.icon));
			button.setAttribute('aria-label', action.label);
			button.title = action.label;
			this._register(addDisposableListener(button, 'click', () => action.run(button)));
		}
		this.body = append(this.element, $('.volt-page-body'));
		this._register(toDisposable(() => this.layer.remove()));
	}

	get visible(): boolean {
		return this.state === 'open';
	}

	setTitle(title: string): void {
		this.titleElement.textContent = title;
		this.element.setAttribute('aria-label', title);
	}

	show(): void {
		if (this.state !== 'new') {
			return;
		}
		this.state = 'open';
		const active = this.options.container.ownerDocument.activeElement;
		this.previousFocus = isHTMLElement(active) ? active : undefined;
		this.options.container.appendChild(this.layer);
		this.entry = openVoltSurface({ dismiss: () => this.hide(), dismissible: true });
		this.layer.style.zIndex = String(this.entry.zIndex);
		this.layer.classList.toggle('reduced-motion', !!getVoltViewport()?.state.reducedMotion);
		this.installListeners();
		this.element.classList.add('entering');
		void this.element.offsetHeight;
		getWindow(this.layer).requestAnimationFrame(() => {
			this.element.classList.remove('entering');
			this.layer.classList.add('open');
			this.fireResize();
		});
		this.element.focus({ preventScroll: true });
	}

	hide(): void {
		if (this.state !== 'open') {
			return;
		}
		this.state = 'closing';
		this.openStore.clear();
		this.entry?.dispose();
		this.entry = undefined;
		this.layer.classList.remove('open');
		this.layer.classList.add('closing');
		this.element.style.transform = '';
		let done = false;
		const finish = () => {
			if (done) {
				return;
			}
			done = true;
			this.state = 'closed';
			this.layer.remove();
			if (this.previousFocus?.isConnected) {
				this.previousFocus.focus({ preventScroll: true });
			}
			this._onDidHide.fire();
		};
		const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
		this.element.addEventListener('transitionend', e => {
			if (e.target === this.element && e.propertyName === 'transform') {
				clearTimeout(timer);
				finish();
			}
		});
	}

	private fireResize(): void {
		if (this.state === 'open') {
			this._onDidResize.fire({ width: this.body.clientWidth, height: this.body.clientHeight });
		}
	}

	private installListeners(): void {
		const store = this.openStore;
		const viewport = getVoltViewport();
		if (viewport) {
			store.add(viewport.onDidChange(() => this.fireResize()));
		}
		store.add(addDisposableListener(getWindow(this.layer), 'resize', () => this.fireResize()));

		// A swipe from the leading edge drags the page away, as on iOS.
		let swipe: { startX: number; startY: number; lastX: number; lastTime: number; velocity: number; active: boolean } | undefined;
		store.add(addDisposableListener(this.element, 'touchstart', (e: TouchEvent) => {
			const touch = e.touches[0];
			swipe = e.touches.length === 1 && touch.clientX <= EDGE_WIDTH
				? { startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastTime: performance.now(), velocity: 0, active: false }
				: undefined;
		}, { passive: true }));
		store.add(addDisposableListener(this.element, 'touchmove', (e: TouchEvent) => {
			const touch = e.touches[0];
			if (!swipe || !touch) {
				return;
			}
			const dx = touch.clientX - swipe.startX;
			if (!swipe.active) {
				if (Math.abs(dx) < DRAG_SLOP) {
					return;
				}
				if (dx < 0 || Math.abs(touch.clientY - swipe.startY) > Math.abs(dx)) {
					swipe = undefined;
					return;
				}
				swipe.active = true;
				this.element.classList.add('dragging');
			}
			if (e.cancelable) {
				e.preventDefault();
			}
			const now = performance.now();
			swipe.velocity = 0.8 * ((touch.clientX - swipe.lastX) / Math.max(1, now - swipe.lastTime)) + 0.2 * swipe.velocity;
			swipe.lastX = touch.clientX;
			swipe.lastTime = now;
			this.element.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
		}, { passive: false }));
		const end = () => {
			const s = swipe;
			swipe = undefined;
			if (!s?.active) {
				return;
			}
			this.element.classList.remove('dragging');
			const dx = s.lastX - s.startX;
			if (dx > this.element.offsetWidth / 3 || s.velocity > FLICK_VELOCITY) {
				this.hide();
			} else {
				this.element.style.transform = '';
			}
		};
		store.add(addDisposableListener(this.element, 'touchend', end));
		store.add(addDisposableListener(this.element, 'touchcancel', end));
	}
}
