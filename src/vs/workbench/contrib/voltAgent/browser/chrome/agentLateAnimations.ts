/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, isHTMLElement, scheduleAtNextAnimationFrameLate } from '../../../../../base/browser/dom.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { STREAM_FRAME_RESERVE_MS } from '../editor/agentInputFirst.js';

/**
 * The CSS animations stepped from late frames: the shimmer of a live status line, of the to-do
 * being worked on and of a watched task. They animate a custom property, so they run on the main
 * thread, and the browser begins a main frame at every screen refresh for a running main-thread
 * animation. With a frame begun at every refresh a key typed in the composer always waits for the
 * next one (see dom's scheduleAtNextAnimationFrameLate).
 */
export const LATE_STEPPED_ANIMATIONS: ReadonlySet<string> = new Set(['volt-agent-shimmer']);

/** What the driver needs of a Web Animation. */
export interface ILateSteppedAnimation {
	readonly playState: string;
	currentTime: unknown;
	pause(): void;
	play(): void;
	readonly effect: { readonly target?: { readonly isConnected: boolean } | null } | null;
}

/**
 * Holds the animations it is given paused and moves each one, in every frame it is stepped in, to
 * the time it would have reached running: the same picture in the same frames, without the
 * browser asking for those frames itself.
 */
export class LateAnimationDriver implements IDisposable {

	/** Each held animation with the timeline time at which its own time was zero. */
	private readonly held = new Map<ILateSteppedAnimation, number>();
	private frame: IDisposable | undefined;
	private disposed = false;

	/** `schedule` runs a callback in the next frame; `timelineNow` is the document timeline's time. */
	constructor(
		private readonly schedule: (callback: () => void) => IDisposable,
		private readonly timelineNow: () => number | undefined,
	) { }

	get size(): number {
		return this.held.size;
	}

	/** Takes a running animation over. Without a timeline it is left to run on its own. */
	adopt(animation: ILateSteppedAnimation): void {
		const now = this.timelineNow();
		const at = animation.currentTime;
		if (this.disposed || now === undefined || typeof at !== 'number' || animation.playState !== 'running' || this.held.has(animation)) {
			return;
		}
		animation.pause();
		this.held.set(animation, now - at);
		this.scheduleStep();
	}

	/** One frame: every held animation shows the frame's time; ended or removed ones are let go. */
	step(): void {
		const now = this.timelineNow();
		for (const [animation, origin] of this.held) {
			if (animation.playState !== 'paused' || !animation.effect?.target?.isConnected) {
				this.held.delete(animation);
			} else if (now !== undefined) {
				animation.currentTime = now - origin;
			}
		}
		if (this.held.size) {
			this.scheduleStep();
		}
	}

	private scheduleStep(): void {
		this.frame ??= this.schedule(() => {
			this.frame = undefined;
			this.step();
		});
	}

	/** The held animations run on their own again. */
	dispose(): void {
		this.disposed = true;
		this.frame?.dispose();
		this.frame = undefined;
		for (const animation of this.held.keys()) {
			if (animation.playState === 'paused') {
				animation.play();
			}
		}
		this.held.clear();
	}
}

const drivers = new WeakMap<Document, { readonly dispose: () => void; uses: number }>();

/**
 * Steps the {@link LATE_STEPPED_ANIMATIONS} of `targetWindow`'s document from late frames for as
 * long as the returned handle (of any caller for that document) is held.
 */
export function stepAnimationsLate(targetWindow: Window): IDisposable {
	const doc = targetWindow.document;
	let entry = drivers.get(doc);
	if (!entry) {
		const driver = new LateAnimationDriver(
			callback => scheduleAtNextAnimationFrameLate(targetWindow, callback, 0, STREAM_FRAME_RESERVE_MS),
			() => {
				const time = doc.timeline?.currentTime;
				return typeof time === 'number' ? time : undefined;
			},
		);
		const listener = addDisposableListener(doc, 'animationstart', (e: AnimationEvent) => {
			if (!LATE_STEPPED_ANIMATIONS.has(e.animationName) || !isHTMLElement(e.target)) {
				return;
			}
			for (const animation of e.target.getAnimations()) {
				if ((animation as CSSAnimation).animationName === e.animationName) {
					driver.adopt(animation as ILateSteppedAnimation);
				}
			}
		});
		entry = {
			uses: 0,
			dispose: () => {
				listener.dispose();
				driver.dispose();
			},
		};
		drivers.set(doc, entry);
	}
	entry.uses++;
	const used = entry;
	return toDisposable(() => {
		if (--used.uses === 0) {
			drivers.delete(doc);
			used.dispose();
		}
	});
}
