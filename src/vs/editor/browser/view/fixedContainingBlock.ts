/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDomNodePagePosition } from '../../../base/browser/dom.js';

/**
 * Finds the box that the `top` and `left` of a `position: fixed` child of `parent` count from.
 *
 * That box is the viewport, unless an ancestor (a transform, a filter, `contain: paint`) has made
 * itself the containing block of fixed elements. Then `top` and `left` count from that ancestor's
 * corner, and what leaves its box is clipped. Widgets that work out viewport coordinates (the
 * suggest list, hovers, parameter hints) must subtract the corner and stay inside the box, or they
 * land away from the cursor, like the suggest list in the agent window's tools area, which is
 * `contain: paint`.
 */
export class FixedContainingBlock {

	private probe: HTMLElement | undefined;

	constructor(private readonly parent: HTMLElement) { }

	/**
	 * The box in viewport coordinates, or undefined when fixed elements are placed in the viewport as
	 * usual (or while the parent is not in a document, so nothing can be measured).
	 */
	measure(): IDomNodePagePosition | undefined {
		if (!this.parent.isConnected) {
			return undefined;
		}

		let probe = this.probe;
		if (!probe) {
			probe = this.probe = this.parent.ownerDocument.createElement('div');
			probe.setAttribute('aria-hidden', 'true');
			// Stretched over the containing block: its rectangle is that block's padding box.
			probe.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none;';
		}
		if (probe.parentElement !== this.parent) {
			this.parent.appendChild(probe);
		}

		const box = probe.getBoundingClientRect();
		const window = this.parent.ownerDocument.defaultView;
		if (!window || box.width <= 0 || box.height <= 0) {
			return undefined;
		}
		const isViewport = box.left === 0 && box.top === 0
			&& Math.abs(box.width - window.innerWidth) < 1 && Math.abs(box.height - window.innerHeight) < 1;
		return isViewport ? undefined : { left: box.left, top: box.top, width: box.width, height: box.height };
	}

	dispose(): void {
		this.probe?.remove();
		this.probe = undefined;
	}
}
