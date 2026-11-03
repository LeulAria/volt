/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltEvent } from '../events.js';
import type { IOrchTaskUsage } from './orchestrator.js';

/**
 * What a delegated task spent, folded from its chat's `usage` events: the counts the subagent
 * budget is checked against. Reports follow the Session Usage panel's rules: one with `used`
 * covers a single model call (Volt's own loop), so those add up; one without it is the agent's
 * total for the turn (ACP's prompt response) and replaces the run's sum; `billed` (the agent's
 * own subagents included) wins over the main loop's counts. Claude's cost is cumulative per
 * session: a run adds its growth, or all of it when it shrank (a new session).
 */

type UsageEvent = Extract<IVoltEvent, { type: 'usage' }>;

interface ITokenCounts {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface ITaskSpendTracker {
	/** Runs that ended. */
	readonly banked: ITokenCounts;
	readonly runId?: string;
	readonly run: ITokenCounts;
	/** The agent's reported cost, summed over its sessions. */
	readonly costUsd?: number;
	/** The agent's last cumulative session cost. */
	readonly sessionCost?: number;
}

/** USD per token. */
export interface ITaskTokenRates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

const ZERO: ITokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A tracker for a task that already spent `usage` (it continues after a restart). */
export function seedSpendTracker(usage: IOrchTaskUsage | undefined): ITaskSpendTracker {
	if (!usage) {
		return { banked: ZERO, run: ZERO };
	}
	return {
		banked: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		run: ZERO,
		...(usage.priced === 'reported' && usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
	};
}

export function foldSpend(tracker: ITaskSpendTracker, runId: string, event: UsageEvent): ITaskSpendTracker {
	let next = tracker;
	if (next.runId !== runId) {
		next = { ...next, banked: add(next.banked, next.run), runId, run: ZERO };
	}
	const count = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
	const billed = event.billed;
	const spent: ITokenCounts = billed
		? { input: count(billed.input), output: count(billed.output), cacheRead: count(billed.cacheRead), cacheWrite: count(billed.cacheWrite) }
		: { input: count(event.input), output: count(event.output), cacheRead: count(event.cache), cacheWrite: count(event.cacheWrite) };
	if (spent.input + spent.output + spent.cacheRead + spent.cacheWrite > 0) {
		next = { ...next, run: event.used === undefined ? spent : add(next.run, spent) };
	}
	if (event.costUsd !== undefined && Number.isFinite(event.costUsd) && event.costUsd >= 0) {
		const before = next.sessionCost ?? 0;
		const grew = event.costUsd >= before ? event.costUsd - before : event.costUsd;
		next = { ...next, costUsd: round6((next.costUsd ?? 0) + grew), sessionCost: event.costUsd };
	}
	return next;
}

/** The task's spend: the agent's own cost when it reports one, else its tokens at list price, else tokens only. */
export function spendUsage(tracker: ITaskSpendTracker, rates: ITaskTokenRates | undefined): IOrchTaskUsage {
	const total = add(tracker.banked, tracker.run);
	const tokens = total.input + total.output + total.cacheWrite;
	const base = { tokens, ...total };
	if (tracker.costUsd !== undefined) {
		return { ...base, costUsd: tracker.costUsd, priced: 'reported' };
	}
	if (rates) {
		const cost = total.input * rates.input + total.output * rates.output + total.cacheRead * rates.cacheRead + total.cacheWrite * rates.cacheWrite;
		return { ...base, costUsd: round6(cost), priced: 'list' };
	}
	return base;
}

function add(a: ITokenCounts, b: ITokenCounts): ITokenCounts {
	return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}
