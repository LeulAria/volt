/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILaneBudget } from './lanes.js';

/**
 * Resource governor. Lane budgets are the *declared* ceiling; this is the *spent* counter.
 * The loop consults it before every model turn and every tool batch so a run that is about
 * to overflow tokens or wall-clock stops cleanly instead of dying inside a provider call.
 *
 * Six meters, because they fail independently: a cheap model can still blow the step budget,
 * and a reasoning model can stay under the step budget while emptying the token one.
 */

export type BudgetMeter = 'tokens' | 'time' | 'cost' | 'steps' | 'tools' | 'parallel';

export interface IResourceBudget {
	readonly tokens: number;
	readonly timeMs: number;
	readonly cost: number;
	readonly steps: number;
	readonly tools: number;
	readonly parallel: number;
}

export interface IResourceSpend {
	readonly tokens?: number;
	readonly timeMs?: number;
	readonly cost?: number;
	readonly steps?: number;
	readonly tools?: number;
}

export interface IGovernorSnapshot {
	readonly cap: IResourceBudget;
	readonly spent: IResourceBudget;
	readonly remaining: IResourceBudget;
	readonly exceeded: readonly BudgetMeter[];
	/** 0..1 - the worst meter. Recovery uses this as `budgetUsed`. */
	readonly used: number;
}

const UNLIMITED = Number.MAX_SAFE_INTEGER;

export function budgetFromLane(lane: ILaneBudget, extras: Partial<IResourceBudget> = {}): IResourceBudget {
	return {
		tokens: extras.tokens ?? UNLIMITED,
		timeMs: extras.timeMs ?? UNLIMITED,
		cost: extras.cost ?? UNLIMITED,
		steps: extras.steps ?? lane.maxModelCalls,
		tools: extras.tools ?? lane.maxToolCalls,
		parallel: extras.parallel ?? 4,
	};
}

export function tightenBudget(left: IResourceBudget, right: Partial<IResourceBudget>): IResourceBudget {
	return {
		tokens: Math.min(left.tokens, right.tokens ?? left.tokens),
		timeMs: Math.min(left.timeMs, right.timeMs ?? left.timeMs),
		cost: Math.min(left.cost, right.cost ?? left.cost),
		steps: Math.min(left.steps, right.steps ?? left.steps),
		tools: Math.min(left.tools, right.tools ?? left.tools),
		parallel: Math.min(left.parallel, right.parallel ?? left.parallel),
	};
}

export class ResourceGovernor {

	private spent: IResourceBudget = { tokens: 0, timeMs: 0, cost: 0, steps: 0, tools: 0, parallel: 0 };

	constructor(private readonly cap: IResourceBudget, private readonly startedAt = Date.now()) { }

	consume(spend: IResourceSpend, now = Date.now()): IGovernorSnapshot {
		this.spent = {
			tokens: this.spent.tokens + Math.max(0, spend.tokens ?? 0),
			timeMs: Math.max(this.spent.timeMs, now - this.startedAt) + Math.max(0, spend.timeMs ?? 0),
			cost: round4(this.spent.cost + Math.max(0, spend.cost ?? 0)),
			steps: this.spent.steps + Math.max(0, spend.steps ?? 0),
			tools: this.spent.tools + Math.max(0, spend.tools ?? 0),
			parallel: this.spent.parallel,
		};
		return this.snapshot(now);
	}

	setParallel(count: number): void {
		this.spent = { ...this.spent, parallel: Math.max(0, count) };
	}

	canAfford(meter: BudgetMeter, amount = 1): boolean {
		const remaining = this.snapshot().remaining;
		return remaining[meter === 'time' ? 'timeMs' : meter] >= amount;
	}

	snapshot(now = Date.now()): IGovernorSnapshot {
		const wall = Math.max(this.spent.timeMs, now - this.startedAt);
		const spent: IResourceBudget = { ...this.spent, timeMs: wall };
		const remaining: IResourceBudget = {
			tokens: Math.max(0, this.cap.tokens - spent.tokens),
			timeMs: Math.max(0, this.cap.timeMs - spent.timeMs),
			cost: Math.max(0, round4(this.cap.cost - spent.cost)),
			steps: Math.max(0, this.cap.steps - spent.steps),
			tools: Math.max(0, this.cap.tools - spent.tools),
			parallel: Math.max(0, this.cap.parallel - spent.parallel),
		};
		const exceeded = (Object.keys(this.cap) as BudgetMeter[]).filter(meter => remaining[meter === 'time' ? 'timeMs' : meter] <= 0 && this.cap[meter === 'time' ? 'timeMs' : meter] !== UNLIMITED);
		const ratios = [
			ratio(spent.tokens, this.cap.tokens),
			ratio(spent.timeMs, this.cap.timeMs),
			ratio(spent.cost, this.cap.cost),
			ratio(spent.steps, this.cap.steps),
			ratio(spent.tools, this.cap.tools),
		];
		return {
			cap: this.cap,
			spent,
			remaining,
			exceeded,
			used: Math.min(1, Math.max(0, ...ratios)),
		};
	}
}

function ratio(spent: number, cap: number): number {
	if (cap <= 0 || cap === UNLIMITED) {
		return 0;
	}
	return spent / cap;
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}
