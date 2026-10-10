/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWatchdogClock } from '../../../common/harness/acpStall.js';

/** A manual clock: timers fire only when the test advances time. */
export class FakeWatchdogClock implements IWatchdogClock {
	private time = 0;
	private timers: { at: number; fn: () => void; live: boolean }[] = [];

	now(): number {
		return this.time;
	}

	setTimeout(fn: () => void, delayMs: number): { dispose(): void } {
		const timer = { at: this.time + delayMs, fn, live: true };
		this.timers.push(timer);
		return { dispose: () => { timer.live = false; } };
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (; ;) {
			const due = this.timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) {
				break;
			}
			due.live = false;
			this.time = due.at;
			due.fn();
		}
		this.time = end;
		this.timers = this.timers.filter(timer => timer.live);
	}

	/**
	 * The computer sleeps for `ms`: the wall clock jumps, timers do not run and stay due the same
	 * time after waking (monotonic timer clocks stop during sleep).
	 */
	sleep(ms: number): void {
		this.time += ms;
		for (const timer of this.timers) {
			timer.at += ms;
		}
	}

	get pending(): number {
		return this.timers.filter(timer => timer.live).length;
	}
}
