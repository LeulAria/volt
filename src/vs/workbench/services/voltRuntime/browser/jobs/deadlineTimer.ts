/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';

/** The longest the timer sleeps before it reads the wall clock again. */
const HEARTBEAT_MS = 30_000;

/**
 * Fires at a wall-clock instant, also across sleep. A plain `setTimeout` counts monotonic time,
 * which stops while a Mac sleeps: a three-hour wait armed before a five-hour sleep fires three
 * hours after the lid opens. This timer never waits longer than a heartbeat before it reads
 * `Date.now()` again, and reads it at once when the machine comes back (the network returns, the
 * window is shown or focused). Late is fine; it never fires early, and it fires once per `schedule`.
 */
export class DeadlineTimer extends Disposable {

	private at: number | undefined;
	private handle: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly onDue: () => void,
		private readonly now: () => number = Date.now,
		private readonly heartbeatMs = HEARTBEAT_MS,
	) {
		super();
		// The agent server runs this too, where there is no window: the heartbeat alone wakes it.
		const win = (globalThis as { window?: Window }).window;
		if (win) {
			const wake = () => this.check();
			win.addEventListener('online', wake);
			win.addEventListener('focus', wake);
			win.document.addEventListener('visibilitychange', wake);
			this._register(toDisposable(() => {
				win.removeEventListener('online', wake);
				win.removeEventListener('focus', wake);
				win.document.removeEventListener('visibilitychange', wake);
			}));
		}
		this._register({ dispose: () => this.clear() });
	}

	/** The instant it fires, or undefined while nothing is scheduled. */
	get deadline(): number | undefined {
		return this.at;
	}

	/** Fires at `at` (now, when it has passed); undefined cancels. */
	schedule(at: number | undefined): void {
		if (at === this.at && (at === undefined || this.handle !== undefined)) {
			return;
		}
		this.at = at;
		this.arm();
	}

	/** Reads the clock now: fires when the deadline has passed. */
	check(): void {
		if (this.at === undefined) {
			return;
		}
		if (this.now() >= this.at) {
			this.clear();
			this.at = undefined;
			this.onDue();
			return;
		}
		this.arm();
	}

	private arm(): void {
		this.clear();
		if (this.at === undefined) {
			return;
		}
		const wait = Math.min(Math.max(this.at - this.now(), 0), this.heartbeatMs);
		this.handle = setTimeout(() => {
			this.handle = undefined;
			this.check();
		}, wait);
	}

	private clear(): void {
		if (this.handle !== undefined) {
			clearTimeout(this.handle);
			this.handle = undefined;
		}
	}
}
