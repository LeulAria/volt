/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, runAtThisOrScheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';

/** Runs after the frame's redraw and scroll sync, so the sticky pass reads a settled layout once. */
const STUCK_SYNC_PRIORITY = -2000;

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
		}));
		const node = this.scroll.getDomNode();
		node.style.width = '100%';
		node.style.height = '100%';
		this.element.appendChild(node);
		append(this.element, $('.volt-agent-thread-fade.top'));
		append(this.element, $('.volt-agent-thread-fade.bottom'));
		this._register(this.scroll.onScroll(() => this.scheduleSyncStuckTurns()));
		this._register(toDisposable(() => this.stuckFrame?.dispose()));
		// A native scroll (scrollIntoView for a footnote or a cited quote, find, a drag-select past
		// the edge, scroll anchoring as an off-screen exchange is laid out) moves the element under
		// the scrollable; catch the scrollable up, or the next wheel turn would jump back. Its sizes
		// are read first: an anchoring scroll can land past the height the scrollable last knew.
		this._register(addDisposableListener(this.inner, 'scroll', () => {
			const scrollTop = this.inner.scrollTop;
			if (Math.abs(this.scroll.getScrollPosition().scrollTop - scrollTop) > 1) {
				this.scroll.scanDomNode();
				this.scroll.setScrollPosition({ scrollTop });
			}
		}));
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
		const turn = exchange?.querySelector<HTMLElement>(':scope > .volt-agent-turn.user:not(.notification):not(.compact-command)') ?? undefined;
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
				replies = Array.from(exchange.querySelectorAll<HTMLElement>(':scope > .volt-agent-turn:not(.user), :scope > .volt-agent-turn.notification'), reply => ({ reply, top: reply.getBoundingClientRect().top }));
			}
		}

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
			// Fade replies under the pinned card without painting a second window background.
			for (const { reply, top } of replies) {
				reply.style.setProperty('--volt-sticky-fade-end', `${bottom - top}px`);
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
