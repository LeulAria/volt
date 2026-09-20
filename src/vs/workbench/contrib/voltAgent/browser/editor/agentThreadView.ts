/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';

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

	constructor() {
		super();
		this.element = $('.volt-agent-thread');
		this.inner = $('.volt-agent-thread-inner');
		this.scroll = this._register(new DomScrollableElement(this.inner, {
			className: 'volt-agent-thread-scroll',
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			verticalScrollbarSize: 14,
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
		this._register(this.scroll.onScroll(() => this.syncStuckTurns()));
	}

	/** Pins fade edges and marks the sent card that is stuck at the top. */
	syncStuckTurns(): void {
		const viewport = this.scroll.getDomNode();
		if (!viewport.isConnected) {
			return;
		}
		const pos = this.scroll.getScrollPosition();
		const height = viewport.clientHeight;
		const scrollHeight = Math.max(height, this.inner.scrollHeight);
		const scrolled = pos.scrollTop > 1;
		const atEnd = pos.scrollTop + height >= scrollHeight - 2;
		this.element.classList.toggle('scrolled', scrolled);
		this.element.classList.toggle('at-end', atEnd);

		const viewportTop = this.inner.getBoundingClientRect().top;
		const targetWindow = getWindow(this.inner);
		for (const turn of this.inner.querySelectorAll<HTMLElement>('.volt-agent-turn.user')) {
			const exchange = turn.parentElement;
			if (!exchange) {
				turn.classList.remove('stuck');
				continue;
			}
			const rect = turn.getBoundingClientRect();
			const exchangeRect = exchange.getBoundingClientRect();
			// A sent card is pinned once sticky positioning has displaced it from
			// its natural spot (the top of its exchange, offset by its own margin)
			// and its exchange is still in view. Comparing against the natural
			// position keeps the very first card unpinned while at rest.
			const marginTop = parseFloat(targetWindow.getComputedStyle(turn).marginTop) || 0;
			const naturalTop = exchangeRect.top + marginTop;
			const stuck = rect.top > naturalTop + 0.5 && exchangeRect.bottom > viewportTop;
			turn.classList.toggle('stuck', stuck);
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
