/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sliding idle watchdog for an ACP prompt turn. Every piece of agent activity (a `session/update`,
 * an agent -> Volt request) restarts the quiet clock. When the clock runs long it escalates in
 * three stages: `notice` (tell the user), `recover` (cancel the prompt and ask the agent to carry
 * on), `fail` (end the turn with a retryable error).
 *
 * What counts as "too quiet" depends on who owes the next event:
 * - the model (nothing running): it should stream text, reasoning or a tool call;
 * - a tool (a call started and has not finished): a build or test can legitimately print nothing
 *   for minutes, so the budget is the tool's own ceiling, or longer when the call declared one;
 * - the user (an approval or question is open): the clock is paused.
 *
 * Defaults come from captures of Cursor's CLI (`Cursor SS/v3/loop-extremes`, `protocol-tools`):
 * - A 400,000-char prompt was silent for 300 s before its first token and then succeeded, and
 *   cursor-agent's own stall/reconnect loop runs for up to ~260 s before it reports "Connection
 *   stalled repeatedly". A quiet model is therefore only interrupted after 6 minutes, well past both.
 * - A 10-minute script ran as one silent tool call for 596 s; Claude's Bash tool caps at 10 min;
 *   cursor-agent MCP calls time out at 60 s. A running tool gets 10 / 20 / 25 minutes, extended
 *   by the call's own `timeout` / `block_until_ms` (AwaitShell allows up to 119 min).
 */

export type IdleStage = 'notice' | 'recover' | 'fail';

/** Title of the `notice` event for the first stage; the UI can key its "slow" state on it. */
export const ACP_STALL_NOTICE_TITLE = 'Taking longer than expected';

/** Who owes the next event while the turn is quiet. */
export type IdleOwner = 'model' | 'tool';

export interface IIdleThresholds {
	readonly noticeMs: number;
	readonly recoverMs: number;
	readonly failMs: number;
}

export interface IIdleWatchdogTimings {
	readonly model: IIdleThresholds;
	readonly tool: IIdleThresholds;
	/**
	 * How far past a running call's declared timeout each stage waits. Cursor reports a timed-out
	 * shell by backgrounding it, so the result should land within moments of the declared time.
	 */
	readonly declaredGraceMs: IIdleThresholds;
	/** Soft recoveries allowed per turn; past this a stall goes straight to `fail`. */
	readonly maxRecoveries: number;
}

export const ACP_IDLE_TIMINGS: IIdleWatchdogTimings = {
	model: { noticeMs: 2 * 60_000, recoverMs: 6 * 60_000, failMs: 9 * 60_000 },
	tool: { noticeMs: 10 * 60_000, recoverMs: 20 * 60_000, failMs: 25 * 60_000 },
	declaredGraceMs: { noticeMs: 60_000, recoverMs: 5 * 60_000, failMs: 10 * 60_000 },
	// Cursor stops resuming after 2 attempts that make no progress ("Agent stopped retrying").
	maxRecoveries: 2,
};

export interface IIdleStageInfo {
	readonly stage: IdleStage;
	readonly owner: IdleOwner;
	/** Time since the last agent activity (pauses excluded). */
	readonly quietMs: number;
	/** Nothing at all has arrived since the turn started. */
	readonly neverActive: boolean;
	/** Soft recoveries already attempted in this turn, before this stage. */
	readonly recoveries: number;
}

export interface IWatchdogClock {
	now(): number;
	setTimeout(fn: () => void, delayMs: number): { dispose(): void };
}

export const realWatchdogClock: IWatchdogClock = {
	now: () => Date.now(),
	setTimeout: (fn, delayMs) => {
		const handle = setTimeout(fn, delayMs);
		return { dispose: () => clearTimeout(handle) };
	},
};

const MAX_TIMER_MS = 2 ** 31 - 1;

export class IdleWatchdog {

	private lastActivity: number;
	private readonly running = new Map<string, number | undefined>();
	private pauses = 0;
	private recoveries = 0;
	private fired = new Set<IdleStage>();
	private everActive = false;
	private timer: { dispose(): void } | undefined;
	private disposed = false;

	constructor(
		private readonly onStage: (info: IIdleStageInfo) => void,
		private readonly timings: IIdleWatchdogTimings = ACP_IDLE_TIMINGS,
		private readonly clock: IWatchdogClock = realWatchdogClock,
	) {
		this.lastActivity = clock.now();
		this.arm();
	}

	/** Any agent activity. Restarts the quiet clock and re-arms every stage. */
	activity(): void {
		if (this.disposed) {
			return;
		}
		this.everActive = true;
		this.lastActivity = this.clock.now();
		this.fired = new Set();
		this.arm();
	}

	/** A tool call started; `declaredMs` is the wait the call asked for, when it named one. */
	toolStarted(callId: string, declaredMs?: number): void {
		this.running.set(callId, declaredMs);
		this.activity();
	}

	/** The call's input arrived later (ACP sends it in an update) and declared a wait. */
	toolDeclared(callId: string, declaredMs: number): void {
		if (this.running.has(callId)) {
			this.running.set(callId, declaredMs);
			this.arm();
		}
	}

	toolEnded(callId: string): void {
		this.running.delete(callId);
		this.activity();
	}

	/**
	 * The model is streaming again, so whatever it started earlier no longer blocks it. Agents that
	 * never report a call's end (or report it inside the first `tool_call`) would otherwise keep the
	 * lenient tool budget for the rest of the turn.
	 */
	modelOutput(): void {
		this.running.clear();
		this.activity();
	}

	/** Waiting on the user (approval, question). Nested pauses stack; the last release restarts the clock. */
	pause(): { dispose(): void } {
		this.pauses++;
		this.timer?.dispose();
		this.timer = undefined;
		let released = false;
		return {
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				this.pauses = Math.max(0, this.pauses - 1);
				if (!this.pauses && !this.disposed) {
					this.lastActivity = this.clock.now();
					this.fired = new Set();
					this.arm();
				}
			},
		};
	}

	/**
	 * The owner applied a soft recovery. The quiet clock is *not* restarted: the prompt it sent is
	 * Volt's own doing, so if the agent stays silent the `fail` stage still lands on schedule.
	 */
	recovered(): void {
		this.recoveries++;
	}

	get owner(): IdleOwner {
		return this.running.size ? 'tool' : 'model';
	}

	get isPaused(): boolean {
		return this.pauses > 0;
	}

	/** The thresholds that apply right now. */
	thresholds(): IIdleThresholds {
		const base = this.running.size ? this.timings.tool : this.timings.model;
		let declared = 0;
		for (const ms of this.running.values()) {
			declared = Math.max(declared, ms ?? 0);
		}
		if (!declared) {
			return base;
		}
		const grace = this.timings.declaredGraceMs;
		return {
			noticeMs: Math.max(base.noticeMs, declared + grace.noticeMs),
			recoverMs: Math.max(base.recoverMs, declared + grace.recoverMs),
			failMs: Math.max(base.failMs, declared + grace.failMs),
		};
	}

	dispose(): void {
		this.disposed = true;
		this.timer?.dispose();
		this.timer = undefined;
	}

	private canRecover(): boolean {
		return this.recoveries < this.timings.maxRecoveries;
	}

	private nextStage(): { stage: IdleStage; atMs: number } | undefined {
		const limits = this.thresholds();
		const stages: [IdleStage, number][] = [['notice', limits.noticeMs], ['recover', limits.recoverMs], ['fail', limits.failMs]];
		for (const [stage, ms] of stages) {
			if (this.fired.has(stage) || (stage === 'recover' && !this.canRecover())) {
				continue;
			}
			return { stage, atMs: ms };
		}
		return undefined;
	}

	private arm(): void {
		this.timer?.dispose();
		this.timer = undefined;
		if (this.disposed || this.pauses) {
			return;
		}
		const next = this.nextStage();
		if (!next) {
			return;
		}
		const delay = Math.min(MAX_TIMER_MS, Math.max(1, this.lastActivity + next.atMs - this.clock.now()));
		this.timer = this.clock.setTimeout(() => this.check(), delay);
	}

	private check(): void {
		this.timer = undefined;
		if (this.disposed || this.pauses) {
			return;
		}
		const quietMs = this.clock.now() - this.lastActivity;
		const limits = this.thresholds();
		// Fire the furthest stage that is due; earlier ones it skipped are implied.
		let stage: IdleStage | undefined;
		if (quietMs >= limits.failMs && !this.fired.has('fail')) {
			stage = 'fail';
		} else if (quietMs >= limits.recoverMs && !this.fired.has('recover') && this.canRecover()) {
			stage = 'recover';
		} else if (quietMs >= limits.noticeMs && !this.fired.has('notice')) {
			stage = 'notice';
		}
		if (stage) {
			this.fired.add(stage);
			if (stage !== 'notice') {
				this.fired.add('notice');
			}
			const info: IIdleStageInfo = { stage, owner: this.owner, quietMs, neverActive: !this.everActive, recoveries: this.recoveries };
			this.onStage(info);
		}
		if (!this.disposed && !this.fired.has('fail')) {
			this.arm();
		}
	}
}

/** Reads the wait a tool call declared in its input (`timeout`, `block_until_ms`, ...), in ms. */
export function declaredToolWaitMs(input: string | undefined): number | undefined {
	if (!input) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	let best = 0;
	for (const key of ['timeout', 'timeout_ms', 'timeoutMs', 'block_until_ms', 'blockUntilMs']) {
		const value = record[key];
		const ms = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
		if (Number.isFinite(ms) && ms > best) {
			best = ms;
		}
	}
	return best > 0 ? best : undefined;
}
