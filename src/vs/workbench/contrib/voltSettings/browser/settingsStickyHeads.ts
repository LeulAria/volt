/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

const BLOCK = 'volt-settings-block';
const HEAD = 'volt-settings-sticky-head';
const BODY = 'volt-settings-block-body';
const BACKDROP = 'volt-settings-head-backdrop';
const MIRROR = 'volt-settings-head-mirror';
/** The band under a stuck title where the blur gives way to the real rows; the same length in voltSettings.css. */
const ROWS_FADE_PX = 20;

/** One titled run of the settings page: its title sticks while the rest of the block scrolls under it. */
export function appendSettingsBlock(page: HTMLElement, headClass: string): { readonly head: HTMLElement; readonly body: HTMLElement } {
	const block = append(page, $(`.${BLOCK}`));
	const head = append(block, $(`.${HEAD}.${headClass}`));
	append(head, $(`.${BACKDROP}`)).setAttribute('aria-hidden', 'true');
	const body = append(block, $(`.${BODY}`));
	return { head, body };
}

/**
 * Settings titles stick to the top of the page over a blurred copy of what scrolls under them,
 * like macOS System Settings. No backdrop-filter: in the see-through agent window it stops
 * Chromium from clearing old pixels (black sidebar, scroll trails). The page is cloned into the
 * stuck title's backdrop instead, where a plain `filter: blur()` softens it, and the real rows
 * fade out as they pass under the title. The same trick as the agent list's sticky headers.
 */
export class SettingsStickyHeads extends Disposable {

	/** A copy of the page for the backdrop; dropped whenever the page changes. */
	private mirror: HTMLElement | undefined;
	private stuck: { readonly head: HTMLElement; readonly body: HTMLElement; readonly backdrop: HTMLElement } | undefined;
	private readonly pending = this._register(new MutableDisposable());

	constructor(
		/** The element that scrolls (its `scrollTop` moves the page). */
		private readonly viewport: HTMLElement,
		/** The page whose children are {@link appendSettingsBlock} blocks. */
		private readonly page: HTMLElement,
	) {
		super();
		const observer = new MutationObserver(records => {
			if (records.some(record => !isOwnMutation(record))) {
				this.mirror = undefined;
				this.schedule();
			}
		});
		observer.observe(page, { childList: true, subtree: true, characterData: true });
		this._register(toDisposable(() => observer.disconnect()));
		this._register(toDisposable(() => this.release()));
	}

	schedule(): void {
		if (!this.page.isConnected) {
			return;
		}
		this.pending.value = scheduleAtNextAnimationFrame(getWindow(this.page), () => this.sync());
	}

	/** Call after each scroll, in the same frame, so the copy never lags the page. */
	sync(): void {
		this.pending.clear();
		if (!this.page.isConnected) {
			return;
		}
		const view = this.viewport.getBoundingClientRect();
		let head: HTMLElement | undefined;
		let body: HTMLElement | undefined;
		for (const block of this.page.children) {
			if (!block.classList.contains(BLOCK)) {
				continue;
			}
			const rect = block.getBoundingClientRect();
			if (rect.top < view.top && rect.bottom > view.top) {
				head = block.querySelector<HTMLElement>(`:scope > .${HEAD}`) ?? undefined;
				body = block.querySelector<HTMLElement>(`:scope > .${BODY}`) ?? undefined;
				break;
			}
		}
		const backdrop = head?.querySelector<HTMLElement>(`:scope > .${BACKDROP}`) ?? undefined;
		if (!head || !body || !backdrop) {
			this.release();
			return;
		}
		if (this.stuck?.head !== head) {
			this.release();
			this.stuck = { head, body, backdrop };
			head.classList.add('stuck');
		}

		const mirror = this.mirror ??= this.copyPage();
		if (mirror.parentElement !== backdrop) {
			backdrop.replaceChildren(mirror);
		}
		const headRect = head.getBoundingClientRect();
		const pageRect = this.page.getBoundingClientRect();
		// The backdrop spans the whole pane, the copy lines up with the page under it.
		backdrop.style.left = `${view.left - headRect.left}px`;
		backdrop.style.width = `${view.width}px`;
		mirror.style.width = `${pageRect.width}px`;
		mirror.style.left = `${pageRect.left - view.left}px`;
		mirror.style.top = `${pageRect.top - headRect.top}px`;

		// No line under the title: behind it the rows are only the blurred copy, then they fade back
		// in over a short band below it, where the copy (extended by CSS) fades out.
		const bottom = headRect.bottom - body.getBoundingClientRect().top;
		body.style.maskImage = bottom + ROWS_FADE_PX > 0 ? `linear-gradient(to bottom, transparent ${bottom}px, #000 ${bottom + ROWS_FADE_PX}px)` : '';
	}

	private copyPage(): HTMLElement {
		const copy = this.page.cloneNode(true) as HTMLElement;
		copy.classList.add(MIRROR);
		copy.removeAttribute('id');
		copy.setAttribute('aria-hidden', 'true');
		copy.inert = true;
		for (const el of copy.querySelectorAll(`.${BACKDROP}`)) {
			el.remove();
		}
		for (const el of copy.querySelectorAll<HTMLElement>(`.${BODY}`)) {
			el.style.maskImage = '';
		}
		for (const el of copy.querySelectorAll(`.${HEAD}.stuck`)) {
			el.classList.remove('stuck');
		}
		for (const el of copy.querySelectorAll('[id]')) {
			el.removeAttribute('id');
		}
		return copy;
	}

	private release(): void {
		const stuck = this.stuck;
		if (!stuck) {
			return;
		}
		this.stuck = undefined;
		stuck.head.classList.remove('stuck');
		stuck.body.style.maskImage = '';
		stuck.backdrop.replaceChildren();
	}
}

/** Moving the copy between backdrops is this class's own doing, not a page change. */
function isOwnMutation(record: MutationRecord): boolean {
	const target = isHTMLElement(record.target) ? record.target : record.target.parentElement;
	if (target?.closest(`.${BACKDROP}`)) {
		return true;
	}
	const nodes = [...record.addedNodes, ...record.removedNodes];
	return nodes.length > 0 && nodes.every(node => isHTMLElement(node) && (node.classList.contains(BACKDROP) || node.classList.contains(MIRROR)));
}
