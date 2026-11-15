/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';
import { IVoltStallReport } from './voltDiagnostics.js';

/** How often the drift timer ticks for a threshold: a third of it, between 20 and 100 ms. */
export function stallTickInterval(thresholdMs: number): number {
	return Math.min(100, Math.max(20, Math.round(thresholdMs / 3)));
}

export interface IDriftStall {
	/** Epoch milliseconds when the loop stopped answering, as far as the timer can tell. */
	readonly startTime: number;
	/** How late the tick came. The loop was blocked at least this long. */
	readonly durationMs: number;
}

/**
 * IPC calls that only re-send state a window already reported (heartbeats), and bring no work of their own. At rest
 * they were the only calls into main, and each woke the stall monitor's timer for 10 s at 10 ticks a second.
 */
const HEARTBEAT_CALLS: ReadonlySet<string> = new Set([
	'voltCodeIndex.reportWorkspaceActivity', // every window, every 2 minutes (the language-server budget)
	'voltAwake.setLease', // a window with agents at work, every minute
]);

/** Whether an IPC call into main should wake the stall monitor (see {@link DriftStallMonitor.poke}). */
export function ipcCallWakesStallMonitor(channelName: string, command: string): boolean {
	return !HEARTBEAT_CALLS.has(`${channelName}.${command}`);
}

/**
 * Detects event-loop stalls from a repeating timer: a tick that arrives `threshold` ms or more
 * late means the loop was blocked that long. Pure, so the decision is testable; `tick(now)` is
 * called by the timer with the current time.
 */
export class DriftStallDetector {

	private expected: number;

	constructor(
		readonly thresholdMs: number,
		readonly intervalMs: number,
		start: number,
	) {
		this.expected = start + intervalMs;
	}

	tick(now: number): IDriftStall | undefined {
		const lag = now - this.expected;
		this.expected = now + this.intervalMs;
		if (this.thresholdMs <= 0 || lag < this.thresholdMs) {
			return undefined;
		}
		return { startTime: now - lag, durationMs: lag };
	}
}

/**
 * Runs a {@link DriftStallDetector} on a real timer. The lag is measured on `monotonic`:
 * `performance.now()` stops while the machine sleeps (macOS, Linux), so a closed lid is not a
 * stall the way it is on `Date.now()`. `wall` dates the stall for the log and spans.
 */
export class DriftStallMonitor implements IDisposable {

	private handle: ReturnType<typeof setInterval> | undefined;
	private armedUntil = Number.POSITIVE_INFINITY;
	private readonly interval: number;

	/**
	 * `armMs`: the timer runs only for that long after each {@link poke} (work arriving: an IPC call),
	 * and stops at rest, where a tick every `threshold / 3` ms was the process's most frequent wakeup
	 * (main: 10 a second). Without it the timer always runs.
	 */
	constructor(
		private readonly thresholdMs: number,
		private readonly onStall: (stall: IDriftStall) => void,
		private readonly monotonic: () => number = () => performance.now(),
		private readonly wall: () => number = Date.now,
		private readonly armMs?: number,
	) {
		this.interval = stallTickInterval(thresholdMs);
		if (armMs === undefined) {
			this.start();
		} else {
			this.poke();
		}
	}

	/** Whether the timer is ticking now. */
	get armed(): boolean {
		return this.handle !== undefined;
	}

	/** Work arrived: watch the loop for the next `armMs`. */
	poke(): void {
		if (this.armMs === undefined) {
			return;
		}
		this.armedUntil = this.monotonic() + this.armMs;
		if (!this.handle) {
			this.start();
		}
	}

	private start(): void {
		const detector = new DriftStallDetector(this.thresholdMs, this.interval, this.monotonic());
		this.handle = setInterval(() => {
			const now = this.monotonic();
			const stall = detector.tick(now);
			if (stall) {
				this.onStall({ startTime: this.wall() - stall.durationMs, durationMs: stall.durationMs });
			} else if (now > this.armedUntil) {
				this.stop();
			}
		}, this.interval);
		(this.handle as { unref?: () => void }).unref?.();
	}

	private stop(): void {
		clearInterval(this.handle);
		this.handle = undefined;
	}

	dispose(): void {
		this.stop();
	}
}

/**
 * At most `burst` reports per `windowMs`; the rest are counted, and the next report that gets
 * through says how many were held back.
 */
export class StallRateLimiter {

	private windowStart = Number.NEGATIVE_INFINITY;
	private inWindow = 0;
	private suppressed = 0;

	constructor(
		private readonly burst = 5,
		private readonly windowMs = 60_000,
	) { }

	/** Undefined when the report must be dropped; otherwise how many were dropped before it. */
	take(now: number): number | undefined {
		if (now - this.windowStart >= this.windowMs) {
			this.windowStart = now;
			this.inWindow = 0;
		}
		if (this.inWindow >= this.burst) {
			this.suppressed++;
			return undefined;
		}
		this.inWindow++;
		const suppressed = this.suppressed;
		this.suppressed = 0;
		return suppressed;
	}
}

/** One line for the Volt Diagnostics log. */
export function formatStall(report: IVoltStallReport): string {
	const where = report.process === 'main' ? 'Main process' : `Window ${report.windowId ?? '?'}`;
	const blocking = report.blockingMs !== undefined ? ` (${Math.round(report.blockingMs)} ms blocking input)` : '';
	const what = report.attribution.length
		? ` while running ${report.attribution.map(item => item.durationMs !== undefined ? `${item.detail} [${item.kind}, ${Math.round(item.durationMs)} ms]` : `${item.detail} [${item.kind}]`).join('; ')}`
		: '';
	const held = report.suppressed ? ` (${report.suppressed} earlier stalls not logged)` : '';
	return `${where} event loop stalled for ${Math.round(report.durationMs)} ms${blocking}${what}${held}`;
}
