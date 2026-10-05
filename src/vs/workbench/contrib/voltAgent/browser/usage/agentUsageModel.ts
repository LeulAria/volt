/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltUsageActivity, IVoltUsageBucket, IVoltUsageLimitGroup, IVoltUsageLimitWindow, IVoltUsageSnapshot, VOLT_USAGE_HISTORY_DAYS, VOLT_USAGE_PROVIDERS, VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';

export type UsageView = 'cost' | 'tokens' | 'limits';
export type UsageRange = '24h' | '7d' | '30d' | '90d';
export type UsageMetric = 'cost' | 'tokens';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const USAGE_RANGE_DAYS: Record<Exclude<UsageRange, '24h'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export interface IUsageTotals {
	cost: number;
	tokens: number;
	uncached: number;
	cached: number;
	cacheWrite: number;
	output: number;
	savings: number;
	/** `cost` by token category; what no rates could split is `cost` minus these. */
	inputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	outputCost: number;
	/** `cost` of fast and ultrafast requests, and what they cost above standard rates. */
	fastCost: number;
	ultrafastCost: number;
	speedPremium: number;
	/** Tokens with no price known, counted in `tokens` but not in `cost`. */
	unpricedTokens: number;
}

export interface IUsageProviderSummary extends IUsageTotals {
	readonly provider: VoltUsageProvider;
	readonly sessions: number;
}

export interface IUsageModelRow extends IUsageTotals {
	readonly provider: VoltUsageProvider;
	readonly model: string;
	readonly unpriced: boolean;
}

export interface IUsageDayRow extends IUsageTotals {
	/** Local midnight (or hour start, for the 24h range). */
	readonly start: number;
}

export interface IUsageSlot {
	readonly start: number;
	readonly byProvider: ReadonlyMap<VoltUsageProvider, IUsageTotals>;
}

export interface IUsageSummary {
	readonly range: UsageRange;
	/** Hourly for the 24h range, daily otherwise. */
	readonly hourly: boolean;
	readonly total: IUsageTotals;
	readonly sessions: number;
	/** Every provider with usage, largest first by the active metric. */
	readonly providers: readonly IUsageProviderSummary[];
	readonly models: readonly IUsageModelRow[];
	/** Days (or hours) with usage, newest first. */
	readonly days: readonly IUsageDayRow[];
	/** One per day (or hour) in the range, oldest first, empty ones included. */
	readonly slots: readonly IUsageSlot[];
}

export function emptyTotals(): IUsageTotals {
	return {
		cost: 0, tokens: 0, uncached: 0, cached: 0, cacheWrite: 0, output: 0, savings: 0,
		inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0,
		fastCost: 0, ultrafastCost: 0, speedPremium: 0, unpricedTokens: 0,
	};
}

function addBucket(into: IUsageTotals, bucket: IVoltUsageBucket): void {
	const tokens = bucket.uncached + bucket.cached + bucket.cacheWrite + bucket.output;
	into.cost += bucket.costUsd;
	into.uncached += bucket.uncached;
	into.cached += bucket.cached;
	into.cacheWrite += bucket.cacheWrite;
	into.output += bucket.output;
	into.savings += bucket.savingsUsd;
	into.tokens += tokens;
	into.inputCost += bucket.inputCostUsd ?? 0;
	into.cacheReadCost += bucket.cacheReadCostUsd ?? 0;
	into.cacheWriteCost += bucket.cacheWriteCostUsd ?? 0;
	into.outputCost += bucket.outputCostUsd ?? 0;
	into.fastCost += bucket.fastCostUsd ?? 0;
	into.ultrafastCost += bucket.ultrafastCostUsd ?? 0;
	into.speedPremium += bucket.speedPremiumUsd ?? 0;
	if (bucket.unpriced && bucket.costUsd === 0) {
		into.unpricedTokens += tokens;
	}
}

function addTotals(into: IUsageTotals, from: IUsageTotals): void {
	for (const key of Object.keys(from) as (keyof IUsageTotals)[]) {
		into[key] += from[key];
	}
}

/** Share of input read from cache, or undefined without input. Cache writes count as misses. */
export function cacheHitRate(totals: IUsageTotals): number | undefined {
	const input = totals.uncached + totals.cached + totals.cacheWrite;
	return input > 0 ? totals.cached / input : undefined;
}

/** Effective USD per million priced tokens, or undefined when nothing was priced. */
export function costPerMillionTokens(totals: IUsageTotals): number | undefined {
	const priced = totals.tokens - totals.unpricedTokens;
	return priced > 0 && totals.cost > 0 ? (totals.cost / priced) * 1_000_000 : undefined;
}

function localMidnight(ms: number): number {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Slot starts for the range ending at `now`: 24 hours, or N local days ending today. */
export function rangeSlots(range: UsageRange, now: number): number[] {
	if (range === '24h') {
		const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
		return Array.from({ length: 24 }, (_, index) => currentHour - (23 - index) * HOUR_MS);
	}
	const days = USAGE_RANGE_DAYS[range];
	const starts: number[] = [];
	const cursor = new Date(localMidnight(now));
	cursor.setDate(cursor.getDate() - (days - 1));
	for (let index = 0; index < days; index++) {
		starts.push(cursor.getTime());
		// setDate keeps local midnight across DST changes, unlike adding 24h.
		cursor.setDate(cursor.getDate() + 1);
	}
	return starts;
}

function slotIndex(starts: readonly number[], ms: number): number {
	let low = 0;
	let high = starts.length - 1;
	if (ms < starts[0]) {
		return -1;
	}
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= ms) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return low;
}

export function metricValue(totals: IUsageTotals, metric: UsageMetric): number {
	return metric === 'cost' ? totals.cost : totals.tokens;
}

export function summarizeUsage(snapshot: IVoltUsageSnapshot, range: UsageRange, metric: UsageMetric, now = Date.now()): IUsageSummary {
	const starts = rangeSlots(range, now);
	const hourly = range === '24h';
	const slots = starts.map(start => ({ start, byProvider: new Map<VoltUsageProvider, IUsageTotals>() }));
	const total = emptyTotals();
	const providers = new Map<VoltUsageProvider, { totals: IUsageTotals; sessions: Set<number> }>();
	const models = new Map<string, IUsageModelRow & IUsageTotals>();
	const allSessions = new Set<number>();
	const end = hourly ? starts[starts.length - 1] + HOUR_MS : starts[starts.length - 1] + 2 * DAY_MS;

	for (const bucket of snapshot.buckets) {
		if (bucket.hour + HOUR_MS <= starts[0] || bucket.hour >= end) {
			continue;
		}
		// Hour buckets start on the hour; a local day can start on the half hour (UTC+5:30), so
		// the bucket goes to the slot its midpoint falls in.
		const index = slotIndex(starts, bucket.hour + HOUR_MS / 2);
		if (index < 0) {
			continue;
		}
		const slot = slots[index].byProvider;
		let slotTotals = slot.get(bucket.provider);
		if (!slotTotals) {
			slotTotals = emptyTotals();
			slot.set(bucket.provider, slotTotals);
		}
		addBucket(slotTotals, bucket);
		addBucket(total, bucket);

		let provider = providers.get(bucket.provider);
		if (!provider) {
			provider = { totals: emptyTotals(), sessions: new Set() };
			providers.set(bucket.provider, provider);
		}
		addBucket(provider.totals, bucket);

		const modelKey = `${bucket.provider}\u0000${bucket.model}`;
		let model = models.get(modelKey);
		if (!model) {
			model = { provider: bucket.provider, model: bucket.model, unpriced: false, ...emptyTotals() };
			models.set(modelKey, model);
		}
		addBucket(model, bucket);
		if (bucket.unpriced) {
			(model as { unpriced: boolean }).unpriced = true;
		}
	}

	// Sessions count every session with a message in the range, billed or not, as Claude Code does.
	for (const entry of snapshot.activity) {
		if (entry.hour + HOUR_MS <= starts[0] || entry.hour >= end) {
			continue;
		}
		const provider = providers.get(entry.provider);
		for (const session of entry.sessions) {
			provider?.sessions.add(session);
			allSessions.add(session);
		}
	}

	const byMetric = (a: IUsageTotals, b: IUsageTotals) => metricValue(b, metric) - metricValue(a, metric) || metricValue(b, metric === 'cost' ? 'tokens' : 'cost') - metricValue(a, metric === 'cost' ? 'tokens' : 'cost');
	const providerRows: IUsageProviderSummary[] = [...providers.entries()]
		.map(([provider, value]) => ({ provider, sessions: value.sessions.size, ...value.totals }))
		.sort((a, b) => byMetric(a, b) || VOLT_USAGE_PROVIDERS.indexOf(a.provider) - VOLT_USAGE_PROVIDERS.indexOf(b.provider));
	const modelRows = [...models.values()].sort(byMetric);
	const days: IUsageDayRow[] = [];
	for (let index = slots.length - 1; index >= 0; index--) {
		const totals = emptyTotals();
		for (const value of slots[index].byProvider.values()) {
			addTotals(totals, value);
		}
		if (totals.tokens > 0) {
			days.push({ start: slots[index].start, ...totals });
		}
	}
	return { range, hourly, total, sessions: allSessions.size, providers: providerRows, models: modelRows, days, slots };
}

//#region Placeholder

const PLACEHOLDER_MODELS: Record<VoltUsageProvider, { model: string; scale: number; phase: number; tokensPerUsd: number }> = {
	claude: { model: 'claude-opus', scale: 9, phase: 0, tokensPerUsd: 3_000_000 },
	cursor: { model: 'composer', scale: 6, phase: 2.1, tokensPerUsd: 1_000_000 },
	codex: { model: 'gpt-codex', scale: 1.2, phase: 4.4, tokensPerUsd: 500_000 },
};

/** Busy stretches and quiet ones, smooth enough to read as a real chart behind the loading page. */
function placeholderWave(days: number, phase: number): number {
	const swell = Math.max(0, Math.sin(days * 0.45 + phase)) ** 3;
	const burst = Math.max(0, Math.sin(days * 1.3 + phase * 1.7)) ** 6;
	return 0.15 + swell + 0.8 * burst;
}

/** Made-up usage the page renders, faded, while the real snapshot loads. Only its shape matters. */
export function placeholderUsage(now = Date.now()): IVoltUsageSnapshot {
	const buckets: IVoltUsageBucket[] = [];
	const activity: IVoltUsageActivity[] = [];
	const step = 3 * HOUR_MS;
	const first = Math.floor((now - VOLT_USAGE_HISTORY_DAYS * DAY_MS) / step) * step;
	let session = 0;
	for (let hour = first; hour <= now; hour += step) {
		const days = (hour - first) / DAY_MS;
		for (const provider of VOLT_USAGE_PROVIDERS) {
			const { model, scale, phase, tokensPerUsd } = PLACEHOLDER_MODELS[provider];
			const cost = scale * placeholderWave(days, phase);
			const tokens = cost * tokensPerUsd;
			buckets.push({
				provider, model, hour,
				uncached: tokens * 0.04, cached: tokens * 0.85, cacheWrite: tokens * 0.1, output: tokens * 0.01,
				costUsd: cost, savingsUsd: cost * 2, unpriced: false,
				inputCostUsd: cost * 0.15, cacheReadCostUsd: cost * 0.3, cacheWriteCostUsd: cost * 0.25, outputCostUsd: cost * 0.3,
				fastCostUsd: 0, ultrafastCostUsd: 0, speedPremiumUsd: 0,
			});
			activity.push({ provider, hour, sessions: [session++] });
		}
	}
	return { generatedAt: now, sinceMs: first, buckets, activity, sessionCount: session, notes: [], pricingSource: '' };
}

/** Made-up limits for the Limits page while the real ones load. */
export function placeholderLimits(now = Date.now()): IVoltUsageLimitGroup[] {
	const window = (id: string, label: string, usedPercent: number, resetsInMs: number, windowMs: number): IVoltUsageLimitWindow =>
		({ id, label, usedPercent, resetsAt: now + resetsInMs, windowMs });
	return [
		{ provider: 'claude', plan: 'Max', checkedAt: now, windows: [window('session', 'Current session', 42, 3 * HOUR_MS, 5 * HOUR_MS), window('week', 'Weekly', 63, 3 * DAY_MS, 7 * DAY_MS)] },
		{ provider: 'codex', plan: 'Plus', checkedAt: now, windows: [window('session', 'Current session', 18, 4 * HOUR_MS, 5 * HOUR_MS), window('week', 'Weekly', 35, 5 * DAY_MS, 7 * DAY_MS)] },
		{ provider: 'cursor', plan: 'Pro', checkedAt: now, windows: [window('month', 'Included usage', 54, 12 * DAY_MS, 30 * DAY_MS)] },
	];
}

//#endregion

//#region Limits

export interface ILimitPace {
	/** Using the window faster than it refills. */
	readonly ahead: boolean;
	/** At the current rate the limit runs out this long from now, before it resets. */
	readonly runsOutInMs?: number;
	/** Percent expected to be left at reset if the rate holds. */
	readonly leftAtReset: number;
}

/**
 * Compares the share of the window used with the share of time gone. Undefined until enough
 * of the window has passed for the rate to mean something.
 */
export function limitPace(window: IVoltUsageLimitWindow, now = Date.now()): ILimitPace | undefined {
	if (!window.resetsAt || !window.windowMs || window.resetsAt <= now) {
		return undefined;
	}
	const elapsedMs = window.windowMs - (window.resetsAt - now);
	const elapsed = elapsedMs / window.windowMs;
	if (elapsed < 0.03 || elapsed > 1) {
		return undefined;
	}
	const used = window.usedPercent / 100;
	const projected = used / elapsed;
	// Early in a window one busy hour looks like a sprint, so small leads are not called out.
	const ahead = used > elapsed + 0.05;
	const leftAtReset = Math.max(0, Math.min(100, Math.round((1 - projected) * 100)));
	if (projected > 1 && used < 1 && used > 0 && elapsed >= 0.15) {
		const ratePerMs = used / elapsedMs;
		const runsOutInMs = (1 - used) / ratePerMs;
		if (runsOutInMs < window.resetsAt - now) {
			return { ahead, runsOutInMs, leftAtReset: 0 };
		}
	}
	return { ahead, leftAtReset };
}

//#endregion
