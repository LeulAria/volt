/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A bottom sheet: what a menu, a picker or a small dialog becomes on a phone. It rises from the
// bottom edge over a dimmed backdrop, sits above an on-screen keyboard and the home indicator,
// and stops at one of its detents (its content's height, half the screen, or nearly all of it).
// Drag its grabber, or its content once scrolled to the top, to move between detents; drag it
// down far or fast enough, tap the backdrop, press Escape or the system Back to dismiss it.

import './voltMobile.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../dom.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import { IVoltSurfaceEntry, openVoltSurface } from './voltSurfaces.js';
import { getVoltViewport } from './voltViewport.js';

/** `content` fits what the sheet holds; `medium` is half the screen; `large` leaves a strip of the page above it. */
export type VoltSheetDetent = 'content' | 'medium' | 'large';

export interface IVoltSheetOptions {
	/** Where the sheet mounts: inside the workbench, so the theme's variables reach it. */
	readonly container: HTMLElement;
	readonly ariaLabel: string;
	/** A title in the sheet's header, under the grabber. */
	readonly title?: string;
	/** Smallest first. Defaults to `['content']`. */
	readonly detents?: readonly VoltSheetDetent[];
	/** The detent the sheet opens at, an index into `detents`. Defaults to the first. */
	readonly initialDetent?: number;
	/** Backdrop taps, downward drags, Escape and Back close it. Defaults to true. */
	readonly dismissible?: boolean;
	readonly className?: string;
	/**
	 * Whether a downward drag starting on `target` moves the sheet rather than scrolling its content
	 * (content scrolled to its top). Natively scrolled content is checked without it; widgets that
	 * scroll themselves (VS Code lists) answer here.
	 */
	readonly canDragFrom?: (target: HTMLElement) => boolean;
	/** What takes focus when the sheet opens; the sheet itself otherwise (no keyboard pops up). */
	readonly initialFocus?: () => HTMLElement | undefined;
	/** Gives focus back to what had it before the sheet opened. Defaults to true. */
	readonly restoreFocus?: boolean;
}

/** The page shows above a large sheet, so it reads as a layer over it. */
const TOP_GAP = 12;
/** A medium sheet's share of the room. */
const MEDIUM_RATIO = 0.5;
/** Movement before a touch counts as a drag or a scroll. */
const DRAG_SLOP = 6;
/** A drag past the last detent moves this much per px of finger travel. */
const RUBBER_BAND = 0.18;
/** Px/ms: a flick this fast dismisses or changes detent whatever the distance. */
const FLICK_VELOCITY = 0.5;
/** How far ahead a release's speed carries it, in ms, when picking the detent it lands on. */
const MOMENTUM_MS = 160;
/** The longest a close waits for its transition before cleaning up. */
const CLOSE_TIMEOUT_MS = 420;

interface IDragState {
	readonly startY: number;
	readonly startX: number;
	readonly startHeight: number;
	readonly target: HTMLElement;
	readonly fromChrome: boolean;
	active: boolean;
	/** The detents' heights, measured once the drag starts. */
	heights: number[];
	lastY: number;
	lastTime: number;
	velocity: number;
	visual: number;
}

export class VoltSheet extends Disposable {

	readonly element: HTMLElement;
	readonly header: HTMLElement;
	readonly body: HTMLElement;

	private readonly layer: HTMLElement;
	private readonly backdrop: HTMLElement;
	private readonly grabber: HTMLElement;
	private readonly titleElement: HTMLElement;

	private readonly _onDidHide = this._register(new Emitter<void>());
	/** Fired once the sheet is gone (its close transition done). */
	readonly onDidHide: Event<void> = this._onDidHide.event;

	private readonly _onDidResize = this._register(new Emitter<number>());
	/** Fired with the body's new height when the sheet settles at a different size. */
	readonly onDidResize: Event<number> = this._onDidResize.event;

	private readonly detents: readonly VoltSheetDetent[];
	private detentIndex: number;
	/** The content detent's height only grows while open, so typing in a search does not make the sheet jump. */
	private contentHeight = 0;
	private height = 0;
	private entry: IVoltSurfaceEntry | undefined;
	private readonly openStore = this._register(new DisposableStore());
	private previousFocus: HTMLElement | undefined;
	private drag: IDragState | undefined;
	private state: 'new' | 'open' | 'closing' | 'closed' = 'new';

	constructor(private readonly options: IVoltSheetOptions) {
		super();
		this.detents = options.detents?.length ? options.detents : ['content'];
		this.detentIndex = Math.min(Math.max(0, options.initialDetent ?? 0), this.detents.length - 1);

		this.layer = $('.volt-sheet-layer');
		this.backdrop = append(this.layer, $('.volt-sheet-backdrop'));
		this.element = append(this.layer, $('.volt-sheet'));
		if (options.className) {
			this.element.classList.add(...options.className.split(' ').filter(Boolean));
		}
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-label', options.ariaLabel);
		this.element.tabIndex = -1;
		this.grabber = append(this.element, $('.volt-sheet-grabber'));
		this.grabber.setAttribute('aria-hidden', 'true');
		this.header = append(this.element, $('.volt-sheet-header'));
		this.titleElement = append(this.header, $('.volt-sheet-title'));
		this.setTitle(options.title);
		this.body = append(this.element, $('.volt-sheet-body'));
		this._register(toDisposable(() => this.layer.remove()));
	}

	get visible(): boolean {
		return this.state === 'open';
	}

	setTitle(title: string | undefined): void {
		this.titleElement.textContent = title ?? '';
		this.header.classList.toggle('empty', !title && !this.header.querySelector('.volt-sheet-header-action'));
	}

	show(): void {
		if (this.state !== 'new') {
			return;
		}
		this.state = 'open';
		const doc = this.options.container.ownerDocument;
		const active = doc.activeElement;
		this.previousFocus = isHTMLElement(active) ? active : undefined;
		this.options.container.appendChild(this.layer);
		const dismissible = this.options.dismissible !== false;
		this.entry = openVoltSurface({ dismiss: () => this.hide(), dismissible });
		this.layer.style.zIndex = String(this.entry.zIndex);
		this.layer.classList.toggle('reduced-motion', !!getVoltViewport()?.state.reducedMotion);

		this.installListeners();
		this.layout(false);
		// Start below the edge, then rise on the next frame so the transition runs.
		this.element.classList.add('entering');
		void this.element.offsetHeight;
		getWindow(this.layer).requestAnimationFrame(() => {
			this.element.classList.remove('entering');
			this.layer.classList.add('open');
		});
		const focus = this.options.initialFocus?.() ?? this.element;
		focus.focus({ preventScroll: true });
	}

	hide(): void {
		if (this.state !== 'open') {
			return;
		}
		this.state = 'closing';
		this.drag = undefined;
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
			if (this.options.restoreFocus !== false && this.previousFocus?.isConnected) {
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

	/** Hides the sheet without closing it, while something it opened (a file picker) is up. */
	setAside(aside: boolean): void {
		this.layer.classList.toggle('set-aside', aside);
	}

	/** The tallest the body can be at the largest detent. */
	maxBodyHeight(): number {
		return Math.max(0, this.maxHeight() - this.chromeHeight());
	}

	/** The body's height now. */
	bodyHeight(): number {
		return Math.max(0, this.height - this.chromeHeight());
	}

	/** Measures the content again (it changed) and settles at the current detent. */
	layout(animate = true): void {
		if (this.state !== 'open') {
			return;
		}
		const heights = this.detentHeights();
		this.setHeight(heights[this.detentIndex], animate);
	}

	// ---- Sizes ---------------------------------------------------------------------------

	private room(): number {
		const win = getWindow(this.layer);
		return win.visualViewport?.height ?? win.innerHeight;
	}

	private maxHeight(): number {
		const safeTop = getVoltViewport()?.state.safe.top ?? 0;
		return Math.max(120, Math.round(this.room() - safeTop - TOP_GAP));
	}

	private chromeHeight(): number {
		return this.grabber.offsetHeight + this.header.offsetHeight + this.bodyPadding();
	}

	private bodyPadding(): number {
		const style = getWindow(this.element).getComputedStyle(this.element);
		return (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.paddingTop) || 0);
	}

	private naturalHeight(): number {
		const style = this.element.style;
		const height = style.height;
		style.height = 'auto';
		const natural = this.element.offsetHeight;
		style.height = height;
		return natural;
	}

	private detentHeights(): number[] {
		const max = this.maxHeight();
		return this.detents.map(detent => {
			switch (detent) {
				case 'large': return max;
				case 'medium': return Math.min(max, Math.round(this.room() * MEDIUM_RATIO));
				default:
					this.contentHeight = Math.min(max, Math.max(this.contentHeight, this.naturalHeight()));
					return this.contentHeight;
			}
		});
	}

	private setHeight(height: number, animate: boolean): void {
		this.element.classList.toggle('no-transition', !animate);
		const changed = height !== this.height;
		this.height = height;
		this.element.style.height = `${height}px`;
		this.element.style.transform = '';
		if (!animate) {
			void this.element.offsetHeight;
			this.element.classList.remove('no-transition');
		}
		if (changed) {
			this._onDidResize.fire(this.bodyHeight());
		}
	}

	// ---- Input ---------------------------------------------------------------------------

	private installListeners(): void {
		const store = this.openStore;
		store.add(addDisposableListener(this.backdrop, 'click', () => {
			if (this.options.dismissible !== false) {
				this.hide();
			}
		}));
		// Tab stays inside the sheet.
		store.add(addDisposableListener(this.element, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Tab') {
				this.trapFocus(e);
			}
		}));
		store.add(addDisposableListener(this.element, 'touchstart', (e: TouchEvent) => this.onTouchStart(e), { passive: true }));
		store.add(addDisposableListener(this.element, 'touchmove', (e: TouchEvent) => this.onTouchMove(e), { passive: false }));
		store.add(addDisposableListener(this.element, 'touchend', () => this.onTouchEnd()));
		store.add(addDisposableListener(this.element, 'touchcancel', () => this.onTouchEnd()));
		// A mouse drags by the grabber and the header (a desktop browser at phone width).
		const onMouseDown = (e: PointerEvent) => {
			if (e.pointerType !== 'mouse' || e.button !== 0) {
				return;
			}
			const target = e.target as HTMLElement;
			this.beginDrag(e.clientX, e.clientY, target, true);
			const win = getWindow(this.element);
			const move = addDisposableListener(win, 'pointermove', (m: PointerEvent) => this.moveDrag(m.clientX, m.clientY) && m.preventDefault());
			const up = addDisposableListener(win, 'pointerup', () => {
				move.dispose();
				up.dispose();
				this.onTouchEnd();
			});
			store.add(move);
			store.add(up);
		};
		store.add(addDisposableListener(this.grabber, 'pointerdown', onMouseDown));
		store.add(addDisposableListener(this.header, 'pointerdown', onMouseDown));
		// The keyboard and the window resize the room; a detent's height follows.
		const viewport = getVoltViewport();
		if (viewport) {
			store.add(viewport.onDidChange(() => this.layout(true)));
		} else {
			store.add(addDisposableListener(getWindow(this.layer), 'resize', () => this.layout(true)));
		}
	}

	private onTouchStart(e: TouchEvent): void {
		if (e.touches.length !== 1) {
			this.drag = undefined;
			return;
		}
		const touch = e.touches[0];
		const target = e.target as HTMLElement;
		this.beginDrag(touch.clientX, touch.clientY, target, this.grabber.contains(target) || this.header.contains(target));
	}

	private beginDrag(x: number, y: number, target: HTMLElement, fromChrome: boolean): void {
		this.drag = {
			startX: x, startY: y, startHeight: this.height, target, fromChrome,
			active: false, heights: [], lastY: y, lastTime: performance.now(), velocity: 0, visual: this.height,
		};
	}

	private onTouchMove(e: TouchEvent): void {
		const touch = e.touches[0];
		if (touch && this.moveDrag(touch.clientX, touch.clientY) && e.cancelable) {
			e.preventDefault();
		}
	}

	/** True while the move drives the sheet (the caller then stops the page from scrolling). */
	private moveDrag(x: number, y: number): boolean {
		const drag = this.drag;
		if (!drag || this.state !== 'open') {
			return false;
		}
		const dy = y - drag.startY;
		if (!drag.active) {
			if (Math.abs(dy) < DRAG_SLOP && Math.abs(x - drag.startX) < DRAG_SLOP) {
				return false;
			}
			if (Math.abs(x - drag.startX) > Math.abs(dy) || !this.canDrag(drag, dy)) {
				this.drag = undefined;
				return false;
			}
			drag.active = true;
			this.element.classList.add('dragging');
		}
		const now = performance.now();
		const dt = Math.max(1, now - drag.lastTime);
		drag.velocity = 0.8 * ((y - drag.lastY) / dt) + 0.2 * drag.velocity;
		drag.lastY = y;
		drag.lastTime = now;
		drag.visual = drag.startHeight - dy;
		this.paintDrag(drag.heights, drag.visual);
		return true;
	}

	private canDrag(drag: IDragState, dy: number): boolean {
		const heights = drag.heights = this.detentHeights();
		if (dy < 0) {
			// Up grows the sheet to a larger detent; content that scrolls keeps the gesture for itself.
			return this.detentIndex < heights.length - 1 && (drag.fromChrome || !this.scrollsAt(drag.target));
		}
		return drag.fromChrome || this.atTop(drag.target);
	}

	/** The content under the finger is scrolled to its top, so a pull down moves the sheet. */
	private atTop(target: HTMLElement): boolean {
		for (let el: HTMLElement | null = target; el && el !== this.element; el = el.parentElement) {
			if (el.scrollTop > 0) {
				return false;
			}
		}
		return this.options.canDragFrom?.(target) ?? true;
	}

	private scrollsAt(target: HTMLElement): boolean {
		for (let el: HTMLElement | null = target; el && el !== this.element; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight + 1) {
				return true;
			}
		}
		return this.options.canDragFrom !== undefined;
	}

	private paintDrag(heights: readonly number[], visual: number): void {
		const min = heights[0];
		const max = heights[heights.length - 1];
		let height: number;
		let translate: number;
		if (visual > max) {
			height = max;
			translate = -(visual - max) * RUBBER_BAND;
		} else if (visual >= min) {
			height = visual;
			translate = 0;
		} else {
			height = min;
			translate = min - visual;
		}
		this.element.style.height = `${height}px`;
		this.element.style.transform = `translate3d(0, ${translate}px, 0)`;
		// The backdrop fades as the sheet leaves.
		this.backdrop.style.opacity = visual < min ? String(Math.max(0, visual / min)) : '';
	}

	private onTouchEnd(): void {
		const drag = this.drag;
		this.drag = undefined;
		if (!drag?.active || this.state !== 'open') {
			return;
		}
		this.element.classList.remove('dragging');
		this.backdrop.style.opacity = '';
		const heights = drag.heights;
		const min = heights[0];
		const visual = drag.visual;
		const velocity = drag.velocity; // px/ms, positive downward
		const projected = visual - velocity * MOMENTUM_MS;
		const dismissible = this.options.dismissible !== false;
		if (dismissible && (visual < min - Math.min(120, min * 0.3) || (velocity > FLICK_VELOCITY && projected < min))) {
			this.hide();
			return;
		}
		let best = 0;
		for (let i = 1; i < heights.length; i++) {
			if (Math.abs(heights[i] - projected) < Math.abs(heights[best] - projected)) {
				best = i;
			}
		}
		this.detentIndex = best;
		this.setHeight(heights[best], true);
	}

	private trapFocus(e: KeyboardEvent): void {
		const focusable = Array.from(this.element.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
			.filter(el => el.offsetParent !== null);
		if (!focusable.length) {
			e.preventDefault();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = this.element.ownerDocument.activeElement;
		if (e.shiftKey && (active === first || active === this.element)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}
}
