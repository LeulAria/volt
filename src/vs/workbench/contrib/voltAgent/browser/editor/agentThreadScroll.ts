/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';

/** How long a glide to a message or a page takes; reduced motion jumps instead. */
export const THREAD_GLIDE_MS = 220;

/**
 * Where Page Up / Page Down lands: one view height, less a strip of overlap so the line read
 * last stays on screen (as browsers page), kept inside the thread.
 */
export function pageScrollTarget(scrollTop: number, viewportHeight: number, scrollHeight: number, direction: -1 | 1): number {
	const overlap = Math.min(64, Math.round(viewportHeight * 0.12));
	const page = Math.max(24, viewportHeight - overlap);
	const max = Math.max(0, scrollHeight - viewportHeight);
	return Math.max(0, Math.min(max, scrollTop + direction * page));
}

/**
 * The message to step to from the one at the landing line: the last one starting above it
 * (previous) or the first one starting below it (next); -1 when there is none. `tops` are the
 * messages' top edges in order, in the same coordinates as `landing`.
 */
export function stepTurnIndex(tops: readonly number[], landing: number, direction: -1 | 1, slack = 2): number {
	return direction < 0
		? tops.findLastIndex(top => top < landing - slack)
		: tops.findIndex(top => top > landing + slack);
}

/** The OS asks for less motion, or Volt's `workbench.reduceMotion` is on. */
export function prefersReducedMotion(element: HTMLElement): boolean {
	return !!element.closest('.monaco-workbench.reduce-motion') || getWindow(element).matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Eased scrolling for a chat thread, shared by the message rail and the paging keys so one
 * cancels the other. A new glide starts from where the running one was headed, so repeated
 * Page Down presses add up instead of stalling.
 */
export class ThreadGlide {

	private frame: IDisposable | undefined;
	private to: number | undefined;

	constructor(private readonly scroll: DomScrollableElement, private readonly element: HTMLElement) { }

	/** The scroll top the thread is headed to: the running glide's end, else where it is now. */
	get target(): number {
		return this.to ?? this.scroll.getScrollPosition().scrollTop;
	}

	get running(): boolean {
		return this.frame !== undefined;
	}

	glideTo(scrollTop: number): void {
		this.cancel();
		const dims = this.scroll.getScrollDimensions();
		const to = Math.max(0, Math.min(Math.max(0, dims.scrollHeight - dims.height), scrollTop));
		const from = this.scroll.getScrollPosition().scrollTop;
		if (Math.abs(to - from) < 1) {
			return;
		}
		if (prefersReducedMotion(this.element)) {
			this.scroll.setScrollPosition({ scrollTop: to });
			return;
		}
		this.to = to;
		const targetWindow = getWindow(this.element);
		const start = Date.now();
		const step = () => {
			const t = Math.min(1, (Date.now() - start) / THREAD_GLIDE_MS);
			const eased = 1 - Math.pow(1 - t, 3);
			this.scroll.setScrollPosition({ scrollTop: from + (to - from) * eased });
			if (t < 1) {
				this.frame = scheduleAtNextAnimationFrame(targetWindow, step);
			} else {
				this.frame = undefined;
				this.to = undefined;
			}
		};
		this.frame = scheduleAtNextAnimationFrame(targetWindow, step);
	}

	cancel(): void {
		this.frame?.dispose();
		this.frame = undefined;
		this.to = undefined;
	}
}

const glides = new WeakMap<DomScrollableElement, ThreadGlide>();

/** The thread's one glide, made on first use. */
export function threadGlide(scroll: DomScrollableElement, element: HTMLElement): ThreadGlide {
	let glide = glides.get(scroll);
	if (!glide) {
		glide = new ThreadGlide(scroll, element);
		glides.set(scroll, glide);
	}
	return glide;
}
