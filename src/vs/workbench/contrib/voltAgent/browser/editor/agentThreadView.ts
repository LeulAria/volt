/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement, runAtThisOrScheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';

/** Runs after the frame's redraw and scroll sync, so the sticky pass reads a settled layout once. */
const STUCK_SYNC_PRIORITY = -2000;
/**
 * The transcript's bottom fade (agentEditor.css): content within this many pixels of the viewport's
 * bottom edge is faded, so the mask only changes pixels while content reaches that band. 64px of fade
 * plus room for a last card's shadow.
 */
export const THREAD_BOTTOM_FADE_REACH = 64 + 16;
/**
 * After the frame's redraw and scroll sync (-1000), whose size read already laid the thread out, so
 * reading the native scroll position costs nothing; before the follow (-1500), so a native scroll
 * (find, a footnote) is adopted before the follow could write over it.
 */
const NATIVE_SCROLL_CHECK_PRIORITY = -1200;
/**
 * The scrollbar's slider is drawn last in the frame, after the sticky pass (-2000) has read its
 * rects. The scrollable used to draw it in the scroll event itself: every scroll sync and follow
 * step then left the slider's style dirty, and each later read in the frame (the native scroll
 * check, the sticky pass) and the follow's own scrollTop write flushed style and layout of the whole
 * thread again: three or four forced passes per streamed frame instead of one.
 */
const SCROLLBAR_RENDER_PRIORITY = -2500;
/** Drag-select autoscroll starts this far inside the top edge, and inside the bottom one, where the composer's chips and the fade cover the rows. */
const SELECT_SCROLL_EDGE_TOP = 24;
const SELECT_SCROLL_EDGE_BOTTOM = 56;
/** Px per frame at most. */
const SELECT_SCROLL_MAX_SPEED = 40;

/**
 * Shared agent transcript surface. The sidebar editor and the browser dock
 * mount this same instance so sent bubbles, thinking, tools, and approvals
 * stay on one renderer.
 */
export class AgentThreadView extends Disposable {

	readonly element: HTMLElement;
	readonly inner: HTMLElement;
	readonly scroll: DomScrollableElement;

	private homeParent: HTMLElement | undefined;
	private homeBefore: Node | null = null;
	private hosted = false;
	/** A sticky pass waiting for the next frame; scrolls and redraws in between share it. */
	private stuckFrame: IDisposable | undefined;
	/** The exchange whose sent card the last pass found pinned. */
	private stuckExchange: HTMLElement | undefined;
	private adoptingNative = false;

	constructor() {
		super();
		this.element = $('.volt-agent-thread');
		this.inner = $('.volt-agent-thread-inner');
		this.scroll = this._register(new DomScrollableElement(this.inner, {
			className: 'volt-agent-thread-scroll',
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			useShadows: false,
			handleMouseWheel: true,
			alwaysConsumeMouseWheel: false,
			// The slider is drawn once per frame, at the end (scheduleScrollbarRender), not in the scroll event.
			lazyRender: true,
		}));
		const node = this.scroll.getDomNode();
		node.style.width = '100%';
		node.style.height = '100%';
		this.element.appendChild(node);
		append(this.element, $('.volt-agent-thread-fade.top'));
		append(this.element, $('.volt-agent-thread-fade.bottom'));
		this._register(this.scroll.onScroll(() => {
			this.scheduleSyncStuckTurns();
			this.scheduleScrollbarRender();
		}));
		this._register(toDisposable(() => this.stuckFrame?.dispose()));
		this._register(toDisposable(() => this.scrollbarFrame?.dispose()));
		// A native scroll (scrollIntoView for a footnote or a cited quote, find, a drag-select past
		// the edge, scroll anchoring as an off-screen exchange is laid out) moves the element under
		// the scrollable; catch the scrollable up, or the next wheel turn would jump back. Its sizes
		// are read first: an anchoring scroll can land past the height the scrollable last knew.
		// Checked in the next frame's pass, not in the event: while a reply streams, nearly every scroll
		// is the follow's own write, and reading scrollTop in the event forced a style and layout pass
		// of the thread on every frame (5 % of a core with 5 chats streaming); after the frame's redraw
		// and scroll sync the layout is clean and the read is free.
		this._register(addDisposableListener(this.inner, 'scroll', () => this.scheduleNativeScrollCheck()));
		this._register(toDisposable(() => this.nativeScrollFrame?.dispose()));
		this._register(this.autoScrollSelection());
	}

	private nativeScrollFrame: IDisposable | undefined;
	private scrollbarFrame: IDisposable | undefined;

	/** Draws the scrollbar's slider for this frame's scrolls, once, after every layout read of the frame. */
	private scheduleScrollbarRender(): void {
		if (this.scrollbarFrame) {
			return;
		}
		this.scrollbarFrame = runAtThisOrScheduleAtNextAnimationFrame(getWindow(this.inner), () => {
			this.scrollbarFrame = undefined;
			this.scroll.renderNow();
		}, SCROLLBAR_RENDER_PRIORITY);
	}

	private scheduleNativeScrollCheck(): void {
		if (this.nativeScrollFrame) {
			return;
		}
		this.nativeScrollFrame = runAtThisOrScheduleAtNextAnimationFrame(getWindow(this.inner), () => {
			this.nativeScrollFrame = undefined;
			this.adoptNativeScroll();
		}, NATIVE_SCROLL_CHECK_PRIORITY);
	}

	/** Catches the scrollable up with a scroll it did not make (see the constructor). */
	adoptNativeScroll(): void {
		const scrollTop = this.inner.scrollTop;
		if (Math.abs(this.scroll.getScrollPosition().scrollTop - scrollTop) > 1) {
			this.scroll.scanDomNode();
			this.adoptingNative = true;
			try {
				this.scroll.setScrollPosition({ scrollTop });
			} finally {
				this.adoptingNative = false;
			}
		}
	}

	/**
	 * Scrolls while a drag-select holds the pointer near an edge or past it. Chromium only
	 * autoscrolls a user-scrollable box, and the inner element is `overflow: hidden` under the
	 * custom scrollbar; the composer's chips and the bottom fade also cover the last rows, so the
	 * pointer reaches the composer before it ever leaves the transcript.
	 */
	private autoScrollSelection(): IDisposable {
		const targetWindow = getWindow(this.inner);
		const doc = this.inner.ownerDocument;
		let pointer: { x: number; y: number } | undefined;
		let frame: number | undefined;
		const stop = () => {
			pointer = undefined;
			if (frame !== undefined) {
				targetWindow.cancelAnimationFrame(frame);
				frame = undefined;
			}
		};
		const step = () => {
			frame = undefined;
			const selection = targetWindow.getSelection();
			if (!pointer || !selection || selection.isCollapsed || !selection.focusNode || !this.inner.contains(selection.focusNode)) {
				return;
			}
			const rect = this.element.getBoundingClientRect();
			const top = rect.top + SELECT_SCROLL_EDGE_TOP;
			const bottom = rect.bottom - SELECT_SCROLL_EDGE_BOTTOM;
			const depth = pointer.y < top ? pointer.y - top : pointer.y > bottom ? pointer.y - bottom : 0;
			if (depth === 0) {
				return;
			}
			const before = this.scroll.getScrollPosition().scrollTop;
			const speed = Math.sign(depth) * Math.min(SELECT_SCROLL_MAX_SPEED, 2 + Math.abs(depth) * 0.4);
			this.scroll.setScrollPosition({ scrollTop: before + speed });
			if (this.scroll.getScrollPosition().scrollTop === before) {
				return;
			}
			// The pointer is still, so the browser will not move the selection's end with the content.
			const x = Math.min(Math.max(pointer.x, rect.left + 1), rect.right - 1);
			const y = Math.min(Math.max(pointer.y, top), bottom);
			const caret = doc.caretRangeFromPoint(x, y);
			if (caret && this.inner.contains(caret.startContainer)) {
				selection.extend(caret.startContainer, caret.startOffset);
			}
			frame = targetWindow.requestAnimationFrame(step);
		};
		const listeners = [
			addDisposableListener(this.inner, 'pointerdown', (e: PointerEvent) => {
				stop();
				const target = e.target as Element | null;
				if (e.button === 0 && !target?.closest?.('.monaco-editor, textarea, input, [contenteditable="true"]')) {
					pointer = { x: e.clientX, y: e.clientY };
				}
			}),
			addDisposableListener(targetWindow, 'pointermove', (e: PointerEvent) => {
				if (!pointer) {
					return;
				}
				if (!(e.buttons & 1)) {
					stop();
					return;
				}
				pointer = { x: e.clientX, y: e.clientY };
				if (frame === undefined) {
					frame = targetWindow.requestAnimationFrame(step);
				}
			}, true),
			addDisposableListener(targetWindow, 'pointerup', stop, true),
			addDisposableListener(targetWindow, 'blur', stop),
		];
		return toDisposable(() => {
			stop();
			listeners.forEach(listener => listener.dispose());
		});
	}

	/**
	 * Drag to scroll with momentum, for touch screens (Volt's workbench in a phone or tablet
	 * browser). The scroller is not native, so touches move it here; listeners stay passive so
	 * taps still click.
	 */
	enableTouchScrolling(): IDisposable {
		const node = this.scroll.getDomNode();
		const targetWindow = getWindow(node);
		node.classList.add('touch-scrolling');
		let lastY = 0;
		let samples: { y: number; t: number }[] = [];
		let frame: number | undefined;
		const stopMomentum = () => {
			if (frame !== undefined) {
				targetWindow.cancelAnimationFrame(frame);
				frame = undefined;
			}
		};
		const scrollBy = (dy: number) => this.scroll.setScrollPosition({ scrollTop: this.scroll.getScrollPosition().scrollTop + dy });
		const listeners = [
			addDisposableListener(node, 'touchstart', (e: TouchEvent) => {
				stopMomentum();
				lastY = e.touches[0].clientY;
				samples = [{ y: lastY, t: e.timeStamp }];
			}, { passive: true }),
			addDisposableListener(node, 'touchmove', (e: TouchEvent) => {
				const y = e.touches[0].clientY;
				scrollBy(lastY - y);
				lastY = y;
				samples.push({ y, t: e.timeStamp });
				samples = samples.filter(sample => e.timeStamp - sample.t < 100);
			}, { passive: true }),
			addDisposableListener(node, 'touchend', (e: TouchEvent) => {
				const first = samples[0];
				const last = samples.at(-1);
				if (!first || !last || last.t - first.t <= 0 || e.timeStamp - last.t > 60) {
					return;
				}
				// px per ms, decaying like UIScrollView's normal deceleration rate.
				let velocity = (first.y - last.y) / (last.t - first.t);
				let previous = targetWindow.performance.now();
				const step = (now: number) => {
					const dt = now - previous;
					previous = now;
					velocity *= Math.pow(0.998, dt);
					const before = this.scroll.getScrollPosition().scrollTop;
					scrollBy(velocity * dt);
					frame = Math.abs(velocity) > 0.02 && this.scroll.getScrollPosition().scrollTop !== before ? targetWindow.requestAnimationFrame(step) : undefined;
				};
				frame = targetWindow.requestAnimationFrame(step);
			}, { passive: true }),
		];
		return toDisposable(() => {
			stopMomentum();
			node.classList.remove('touch-scrolling');
			listeners.forEach(listener => listener.dispose());
		});
	}

	/** True during the scroll event of a native scroll being adopted (see the constructor), which may not be the reader's. */
	get isAdoptingNativeScroll(): boolean {
		return this.adoptingNative;
	}

	/** {@link syncStuckTurns} once, at the end of this frame (or the next one): scrolls and redraws share it. */
	scheduleSyncStuckTurns(): void {
		if (this.stuckFrame) {
			return;
		}
		this.stuckFrame = runAtThisOrScheduleAtNextAnimationFrame(getWindow(this.inner), () => {
			this.stuckFrame = undefined;
			this.syncStuckTurns();
		}, STUCK_SYNC_PRIORITY);
	}

	/**
	 * Pins fade edges and marks the sent card that is stuck at the top. Only the exchange under the
	 * top edge can hold a pinned card (a card sticks inside its own exchange), so that is the only one
	 * measured: the pass costs the same in a long chat as in a short one.
	 */
	syncStuckTurns(): void {
		this.stuckFrame?.dispose();
		this.stuckFrame = undefined;
		const viewport = this.scroll.getDomNode();
		if (!viewport.isConnected) {
			return;
		}
		// Read everything first, then write: a class or style written between reads would make each
		// following read lay the thread out again.
		const pos = this.scroll.getScrollPosition();
		const dims = this.scroll.getScrollDimensions();
		const viewportTop = this.inner.getBoundingClientRect().top;
		const exchange = this.exchangeAt(viewportTop);
		// Only prompts the user sent pin; a subagent report scrolls with the replies under them.
		// The exchange's own children are walked, not queried: a `:scope >` query with `:not()`
		// walked the whole reply's subtree on every scrolled frame (over 1 s in 67 s of streaming).
		let turn: HTMLElement | undefined;
		const turns: HTMLElement[] = [];
		if (exchange) {
			for (const child of exchange.children) {
				if (!isHTMLElement(child) || !child.classList.contains('volt-agent-turn')) {
					continue;
				}
				const user = child.classList.contains('user');
				if (user && !turn && !child.classList.contains('notification') && !child.classList.contains('compact-command')) {
					turn = child;
				}
				if (!user || child.classList.contains('notification')) {
					turns.push(child);
				}
			}
		}
		// The space under the last exchange (`.volt-agent-thread-inner::after`) is empty: while that is all the
		// bottom fade covers, the fade changes no pixel and its mask only costs the GPU a surface of its own.
		const last = this.inner.lastElementChild;
		const bottomClear = isBottomFadeClear(last ? last.getBoundingClientRect().bottom : viewportTop, viewportTop + dims.height);
		let stuck = false;
		let bottom = 0;
		let replies: { reply: HTMLElement; top: number }[] = [];
		if (exchange && turn) {
			const rect = turn.getBoundingClientRect();
			const exchangeRect = exchange.getBoundingClientRect();
			// A sent card is pinned once sticky positioning has displaced it from
			// its natural spot (the top of its exchange, offset by its own margin)
			// and its exchange is still in view. Comparing against the natural
			// position keeps the very first card unpinned while at rest.
			const marginTop = parseFloat(getWindow(this.inner).getComputedStyle(turn).marginTop) || 0;
			const naturalTop = exchangeRect.top + marginTop;
			stuck = rect.top > naturalTop + 0.5 && exchangeRect.bottom > viewportTop;
			bottom = rect.bottom;
			if (stuck) {
				replies = turns.map(reply => ({ reply, top: reply.getBoundingClientRect().top }));
			}
		}

		// On the scroller itself (monaco never rewrites its classes here): only that element restyles.
		viewport.classList.toggle('bottom-clear', bottomClear);
		this.element.classList.toggle('scrolled', pos.scrollTop > 1);
		this.element.classList.toggle('at-end', pos.scrollTop + dims.height >= Math.max(dims.height, dims.scrollHeight) - 2);
		const previous = this.stuckExchange;
		if (previous && (previous !== exchange || !stuck)) {
			this.unpin(previous);
		}
		if (exchange && turn && stuck) {
			turn.classList.add('stuck');
			// Stands in for `:has(> .volt-agent-turn.user.stuck)` on the exchange (see agentEditor.css).
			exchange.classList.add('has-stuck-turn');
			// Fade replies under the pinned card without painting a second window background. Written
			// only when the value moved: the write restyles and repaints the reply (its mask).
			for (const { reply, top } of replies) {
				const end = `${Math.round(bottom - top)}px`;
				if (reply.style.getPropertyValue('--volt-sticky-fade-end') !== end) {
					reply.style.setProperty('--volt-sticky-fade-end', end);
				}
			}
			this.stuckExchange = exchange;
		} else {
			this.stuckExchange = undefined;
		}
		// Stands in for `.volt-agent-thread:has(.volt-agent-turn.user.stuck)`.
		this.element.classList.toggle('has-stuck-turn', !!this.stuckExchange);
	}

	/** The exchange under the viewport's top edge (the first whose bottom is below it), by binary search. */
	private exchangeAt(viewportTop: number): HTMLElement | undefined {
		const children = this.inner.children;
		let low = 0;
		let high = children.length - 1;
		let found: HTMLElement | undefined;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const child = children[mid] as HTMLElement;
			if (child.getBoundingClientRect().bottom > viewportTop) {
				found = child;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}
		return found?.classList.contains('volt-agent-exchange') ? found : undefined;
	}

	private unpin(exchange: HTMLElement): void {
		exchange.classList.remove('has-stuck-turn');
		for (const turn of exchange.querySelectorAll<HTMLElement>(':scope > .volt-agent-turn.user.stuck')) {
			turn.classList.remove('stuck');
		}
		for (const reply of exchange.querySelectorAll<HTMLElement>(':scope > .volt-agent-turn')) {
			reply.style.removeProperty('--volt-sticky-fade-end');
		}
	}

	rememberHome(): void {
		this.homeParent = this.element.parentElement ?? undefined;
		this.homeBefore = this.element.nextSibling;
	}

	mount(host: HTMLElement): void {
		if (!this.homeParent) {
			this.rememberHome();
		}
		if (this.element.parentElement !== host) {
			host.appendChild(this.element);
		}
		this.hosted = true;
		this.layout();
	}

	restore(): void {
		if (!this.hosted || !this.homeParent) {
			return;
		}
		const composer = this.homeParent.querySelector('.volt-agent-composer');
		if (composer) {
			this.homeParent.insertBefore(this.element, composer);
		} else if (this.homeBefore && this.homeBefore.parentNode === this.homeParent) {
			this.homeParent.insertBefore(this.element, this.homeBefore);
		} else if (this.homeParent.isConnected) {
			this.homeParent.insertBefore(this.element, this.homeParent.firstChild);
		}
		this.hosted = false;
		this.layout();
	}

	get isHosted(): boolean {
		return this.hosted;
	}

	layout(): void {
		if (!this.element.isConnected) {
			return;
		}
		void getWindow(this.element).requestAnimationFrame(() => {
			this.scroll.scanDomNode();
			this.syncStuckTurns();
		});
	}
}

/**
 * Whether the transcript's bottom fade covers only the empty space under the last exchange: the last
 * content ends at least {@link THREAD_BOTTOM_FADE_REACH} above the viewport's bottom edge (both in
 * client pixels). Then the fade's mask can come off with no visible change.
 */
export function isBottomFadeClear(contentBottom: number, viewportBottom: number): boolean {
	return contentBottom <= viewportBottom - THREAD_BOTTOM_FADE_REACH;
}
