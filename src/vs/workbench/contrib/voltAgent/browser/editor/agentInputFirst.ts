/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';

/** The frame-end callback runs after every other callback of the frame (higher priorities run first). */
const FRAME_END_PRIORITY = -100_000;

/**
 * Input first. A key typed into the composer is drawn at the next animation frame (the editor
 * schedules its render there). While a reply streams, that frame would also patch the reply, lay it
 * out and paint it, so the key's echo waited for the stream's work. The gate lets a stream paint
 * that falls in a key's frame move to the next frame, so the frame that shows the key carries the
 * composer's own work only. A paint moves at most once in a row: however fast the user types (key
 * repeat included), the reply still paints at least every other frame.
 */
export class InputFirstGate implements IDisposable {

	private keyFrame: IDisposable | undefined;
	private yielded = false;

	/** `schedule` runs a callback at the next animation frame with a priority (the DOM frame runner). */
	constructor(private readonly schedule: (callback: () => void, priority: number) => IDisposable) { }

	/** The composer took a key: its echo is drawn at the next frame. */
	noteKey(): void {
		this.keyFrame ??= this.schedule(() => this.keyFrame = undefined, FRAME_END_PRIORITY);
	}

	/** Called by a stream paint in its frame callback: true to move the paint to the next frame. */
	shouldYield(): boolean {
		if (this.keyFrame && !this.yielded) {
			this.yielded = true;
			return true;
		}
		this.yielded = false;
		return false;
	}

	dispose(): void {
		this.keyFrame?.dispose();
		this.keyFrame = undefined;
	}
}

/**
 * How much of a refresh interval a streaming chat keeps for its frame's work when it asks for the
 * frame late (dom's scheduleAtNextAnimationFrameLate). A key typed before the frame is asked for
 * gets its own frame at once and is on screen one refresh sooner than behind a frame asked for at
 * the refresh. A frame that only moves the follow glide is small and can be asked for later than
 * one that paints text: on a 120 Hz screen (8.3 ms) these leave the first 4 ms and 2.5 ms open.
 * Both still reach the screen with the refresh they always did (measured on a 120 Hz panel: a
 * main frame takes 1.7 ms at the median and 4.8 ms at the 99th percentile, and it is shown with
 * the same refresh as long as it is done 9.8 ms after the refresh began).
 */
export const STREAM_FRAME_RESERVE_MS = 1000 / 120 - 4;
export const STREAM_TEXT_FRAME_RESERVE_MS = 1000 / 120 - 2.5;

/** How long a measured frame interval is trusted (the window can move to a screen with another rate). */
const FRAME_INTERVAL_MAX_AGE_MS = 2000;

/**
 * Whether a frame at `timelineMs` is one in which streamed text is painted, on a screen that draws a
 * frame every `frameMs`: the first frame after each multiple of `stepMs`, which is the frame the
 * text's fade changes colour in (agentFreshText's step clock). A screen at or under the step rate,
 * or one not measured yet, paints text in every frame.
 */
export function isTextFrame(timelineMs: number, frameMs: number | undefined, stepMs: number): boolean {
	if (frameMs === undefined || frameMs > stepMs * 0.75) {
		return true;
	}
	return ((timelineMs % stepMs) + stepMs) % stepMs < frameMs;
}

/**
 * Keeps a streaming reply's paints in the frames its fade repaints text in anyway. On a 120 Hz
 * screen the fade changes colour in every other frame; a reply patched in a frame between two of
 * those made that frame paint text too, and with text painted in consecutive frames the
 * compositor holds each next frame back behind the one in flight (a typed key's frame included).
 * A paint that falls in a frame between waits for the next text frame: 8 ms at 120 Hz, never on a
 * 60 Hz screen.
 */
export class TextFrameClock implements IDisposable {

	private frameMs: number | undefined;
	private measuredAt = -Infinity;
	private probe: IDisposable | undefined;
	private waited = 0;

	/**
	 * `schedule` runs a callback at the next animation frame; `timelineNow` is the document
	 * timeline's time of the frame being drawn (undefined when the document has none).
	 */
	constructor(
		private readonly schedule: (callback: () => void) => IDisposable,
		private readonly timelineNow: () => number | undefined,
		private readonly stepMs: number,
	) { }

	/** Called by a stream paint in its frame callback: true to move the paint to the next frame. */
	shouldWait(): boolean {
		const now = this.timelineNow();
		if (now === undefined) {
			return false;
		}
		this.measure(now);
		// At most two frames in a row (a 180 Hz screen has two frames between text frames).
		if (this.waited < 2 && !isTextFrame(now, this.frameMs, this.stepMs)) {
			this.waited++;
			return true;
		}
		this.waited = 0;
		return false;
	}

	/**
	 * Called in a frame callback: how much of its interval the next frame needs
	 * ({@link STREAM_FRAME_RESERVE_MS} unless it is a frame text is painted in, or the screen is not
	 * measured yet).
	 */
	nextFrameReserveMs(): number {
		const now = this.timelineNow();
		if (now === undefined || this.frameMs === undefined) {
			return STREAM_TEXT_FRAME_RESERVE_MS;
		}
		return isTextFrame(now + this.frameMs, this.frameMs, this.stepMs) ? STREAM_TEXT_FRAME_RESERVE_MS : STREAM_FRAME_RESERVE_MS;
	}

	/** The screen's frame interval: the time between two frames in a row, taken again every 2 s of use. */
	private measure(now: number): void {
		if (this.probe || now - this.measuredAt < FRAME_INTERVAL_MAX_AGE_MS) {
			return;
		}
		this.probe = this.schedule(() => {
			const first = this.timelineNow();
			this.probe = this.schedule(() => {
				this.probe = undefined;
				const second = this.timelineNow();
				if (first === undefined || second === undefined) {
					return;
				}
				this.measuredAt = second;
				const interval = second - first;
				// A frame the window skipped (hidden, busy) is no measure of the screen.
				if (interval > 1 && interval < 50) {
					this.frameMs = interval;
				}
			});
		});
	}

	dispose(): void {
		this.probe?.dispose();
		this.probe = undefined;
	}
}
