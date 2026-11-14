/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';

/** After every other callback of the frame (VS Code's runner calls higher priorities first). */
const FRAME_END_PRIORITY = -100_000;

interface IWindowState {
	/** The next frame draws a keystroke: transcript work waits a frame. */
	pending: boolean;
	/** This frame yields to a keystroke (set while its callbacks run). */
	yielding: boolean;
	/** The last frame yielded: this one does not, so a held key never starves the transcript. */
	cooling: boolean;
}

const states = new WeakMap<Window, IWindowState>();

/**
 * Keystroke-first frames. While replies stream, every frame patches the live reply, glides the
 * thread after it and syncs its scroll state: 10-20 ms of main-thread work with five chats
 * streaming, and a key typed into the composer was drawn in that same frame, after all of it
 * (ADEMark A8, round 5). A keystroke now marks the next frame as its own: transcript work that
 * asks {@link yieldsToInput} runs one frame later, so the frame that draws the character carries
 * the composer alone. Never two frames in a row: a key held down or typed every frame still lets
 * the transcript draw every other frame.
 */
export function noteComposerInput(win: Window): void {
	let state = states.get(win);
	if (!state) {
		state = { pending: false, yielding: false, cooling: false };
		states.set(win, state);
	}
	if (state.pending) {
		// The next frame already draws a keystroke.
		return;
	}
	state.pending = true;
	const s = state;
	// At the start of the frame that draws the key, before the transcript's callbacks (priority 0
	// and below): it yields, unless the frame before it did.
	scheduleAtNextAnimationFrame(win, () => s.yielding = !s.cooling, Number.MAX_SAFE_INTEGER);
	// At its end: a frame that yielded makes the next one cool down (its own end clears that).
	scheduleAtNextAnimationFrame(win, () => {
		s.pending = false;
		if (s.yielding) {
			s.yielding = false;
			s.cooling = true;
			scheduleAtNextAnimationFrame(win, () => s.cooling = false, FRAME_END_PRIORITY);
		}
	}, FRAME_END_PRIORITY);
}

/**
 * Whether work in this animation frame should wait for the next one, because the frame draws a
 * keystroke. Call from an animation frame callback; reschedule the work when it says true.
 */
export function yieldsToInput(win: Window): boolean {
	return states.get(win)?.yielding ?? false;
}
