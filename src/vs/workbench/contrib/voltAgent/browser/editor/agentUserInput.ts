/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether the user has pressed a key or a pointer in a window since it opened. Until then the chat on
 * screen was only restored with the window, nobody picked it: Volt starts no agent process for it
 * (an idle Claude Code agent is a few hundred MB). The first key, click or tap counts, so opening,
 * focusing or typing in a chat warms its agent as before.
 */
const acted = new WeakSet<object>();
const watched = new WeakSet<object>();

const INPUT_EVENTS = ['keydown', 'pointerdown'] as const;

/** Watches `target` (a window) for the first key or pointer press; once per window. */
export function watchForUserInput(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): void {
	if (watched.has(target)) {
		return;
	}
	watched.add(target);
	const mark = () => {
		acted.add(target);
		for (const type of INPUT_EVENTS) {
			target.removeEventListener(type, mark, true);
		}
	};
	for (const type of INPUT_EVENTS) {
		target.addEventListener(type, mark, true);
	}
}

/** True once the user pressed a key or a pointer in `target` (see {@link watchForUserInput}). */
export function hasUserInput(target: object): boolean {
	return acted.has(target);
}
