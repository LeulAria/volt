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

/** About how long the view takes to catch up with a reply that grew at the end. */
export const THREAD_FOLLOW_SMOOTH_MS = 120;

/**
 * One frame of following the end: a critically damped spring from `position` toward `target`, so
 * the view eases in and out of each streamed chunk and its speed carries over from one chunk to
 * the next (no jerk when a line lands mid-glide). `velocity` is in px/ms. It never passes the
 * target and never trails it by more than `maxLag` px; it lands exactly once it is within half a
 * pixel and nearly still.
 */
export function followScrollStep(position: number, target: number, velocity: number, elapsedMs: number, maxLag = Infinity, smoothMs = THREAD_FOLLOW_SMOOTH_MS): { position: number; velocity: number; done: boolean } {
	if (target - position > maxLag) {
		position = target - maxLag;
	}
	const dt = Math.min(64, Math.max(1, elapsedMs));
	const omega = 2 / smoothMs;
	const x = omega * dt;
	const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	const change = position - target;
	const temp = (velocity + omega * change) * dt;
	let nextVelocity = (velocity - omega * temp) * decay;
	let next = target + (change + temp) * decay;
	if ((target - position > 0) === (next > target)) {
		next = target;
		nextVelocity = 0;
	}
	if (Math.abs(target - next) <= 0.5 && Math.abs(nextVelocity) < 0.05) {
		return { position: target, velocity: 0, done: true };
	}
	return { position: next, velocity: nextVelocity, done: false };
}

/** Runs after the frame's redraw and scroll sync (-1000), before the sticky pass (-2000). */
const FOLLOW_PRIORITY = -1500;

/**
 * Keeps a thread pinned to its end while the reply streams, gliding there frame by frame instead
 * of snapping on each chunk. It is the only writer while it runs: it stops as soon as `follows`
 * says no (the reader scrolled up), when a glide takes over, or once it has landed.
 */
export class ThreadFollow {

	private frame: IDisposable | undefined;
	private velocity = 0;
	private last = 0;
	private writing = false;

	constructor(private readonly scroll: DomScrollableElement, private readonly element: HTMLElement, private readonly follows: () => boolean) { }

	/** True during the follow's own scroll write: its scroll event is not the reader moving. */
	get isWriting(): boolean {
		return this.writing;
	}

	/** Glides to the end over the next frames; with reduced motion it jumps there now. */
	follow(): void {
		if (this.frame) {
			return;
		}
		if (prefersReducedMotion(this.element)) {
			this.jumpToEnd();
			return;
		}
		this.last = 0;
		this.frame = scheduleAtNextAnimationFrame(getWindow(this.element), this.step, FOLLOW_PRIORITY);
	}

	jumpToEnd(): void {
		this.cancel();
		const dims = this.scroll.getScrollDimensions();
		this.write(Math.max(0, dims.scrollHeight - dims.height));
	}

	cancel(): void {
		this.frame?.dispose();
		this.frame = undefined;
		this.velocity = 0;
	}

	private readonly step = () => {
		this.frame = undefined;
		const now = getWindow(this.element).performance.now();
		const elapsed = this.last ? now - this.last : 16;
		this.last = now;
		if (!this.follows() || !this.element.isConnected || glides.get(this.scroll)?.running) {
			this.velocity = 0;
			return;
		}
		const dims = this.scroll.getScrollDimensions();
		const target = Math.max(0, dims.scrollHeight - dims.height);
		const next = followScrollStep(this.scroll.getScrollPosition().scrollTop, target, this.velocity, elapsed, Math.max(dims.height, 200));
		this.velocity = next.velocity;
		this.write(next.position);
		if (!next.done) {
			this.frame = scheduleAtNextAnimationFrame(getWindow(this.element), this.step, FOLLOW_PRIORITY);
		}
	};

	private write(scrollTop: number): void {
		this.writing = true;
		try {
			this.scroll.setScrollPosition({ scrollTop });
		} finally {
			this.writing = false;
		}
	}
}

/**
 * Whether an element from `target` up to (not including) `boundary` scrolls natively and can still
 * move the wheel's way: that element takes the wheel, not the thread.
 */
export function nativeScrollerTakesWheel(target: Element, boundary: Element, deltaX: number, deltaY: number): boolean {
	const view = getWindow(target);
	for (let el: Element | null = target; el && el !== boundary; el = el.parentElement) {
		if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) {
			continue;
		}
		const style = view.getComputedStyle(el);
		const y = /auto|scroll/.test(style.overflowY);
		const x = /auto|scroll/.test(style.overflowX);
		if ((y && deltaY < 0 && el.scrollTop > 0) || (y && deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1)
			|| (x && deltaX < 0 && el.scrollLeft > 0) || (x && deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) {
			return true;
		}
	}
	return false;
}
