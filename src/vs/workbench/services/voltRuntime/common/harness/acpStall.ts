/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ACP prompt-stall watchdog (Zeron). Some CLIs never resolve `session/prompt`
 * and never emit an update. A silent Working state is worse than a visible
 * error: the UI spins forever. This timer fires only if nothing arrived.
 */

export const ACP_PROMPT_STALL_MS = 90_000;

export interface IPromptStall {
	/** Call on any wire activity so the timer is cancelled. */
	readonly ping: () => void;
	readonly dispose: () => void;
	readonly fired: () => boolean;
}

export function startPromptStall(ms: number, onStall: () => void, schedule: (fn: () => void, delay: number) => { dispose: () => void } = defaultSchedule): IPromptStall {
	let fired = false;
	let alive = true;
	const timer = schedule(() => {
		if (!alive || fired) {
			return;
		}
		fired = true;
		onStall();
	}, Math.max(1, ms));
	return {
		ping: () => {
			alive = false;
			timer.dispose();
		},
		dispose: () => {
			alive = false;
			timer.dispose();
		},
		fired: () => fired,
	};
}

function defaultSchedule(fn: () => void, delay: number): { dispose: () => void } {
	const handle = setTimeout(fn, delay);
	return { dispose: () => clearTimeout(handle) };
}
