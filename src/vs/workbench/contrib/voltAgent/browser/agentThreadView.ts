/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, getWindow } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';

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
		void getWindow(this.element).requestAnimationFrame(() => this.scroll.scanDomNode());
	}
}
