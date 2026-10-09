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

/** Runs a {@link DriftStallDetector} on a real timer. */
export class DriftStallMonitor implements IDisposable {

	private readonly handle: ReturnType<typeof setInterval>;

	constructor(thresholdMs: number, onStall: (stall: IDriftStall) => void, now: () => number = Date.now) {
		const interval = stallTickInterval(thresholdMs);
		const detector = new DriftStallDetector(thresholdMs, interval, now());
		this.handle = setInterval(() => {
			const stall = detector.tick(now());
			if (stall) {
				onStall(stall);
			}
		}, interval);
		(this.handle as { unref?: () => void }).unref?.();
	}

	dispose(): void {
		clearInterval(this.handle);
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
