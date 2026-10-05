/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltUsageService = createDecorator<IVoltUsageService>('voltUsageService');
export const VOLT_USAGE_CHANNEL_NAME = 'voltUsage';

/** Agents whose usage Volt can read: local transcripts for Claude Code and Codex, the account API for Cursor. */
export type VoltUsageProvider = 'claude' | 'codex' | 'cursor';

export const VOLT_USAGE_PROVIDERS: readonly VoltUsageProvider[] = ['claude', 'codex', 'cursor'];

/** How fast a request was served; faster speeds bill at a premium. */
export type VoltUsageSpeed = 'standard' | 'fast' | 'ultrafast';

/** Usage history reaches back this far. The view's longest range is 90 days. */
export const VOLT_USAGE_HISTORY_DAYS = 90;

/** Tokens and cost for one model in one provider during one clock hour. */
export interface IVoltUsageBucket {
	readonly provider: VoltUsageProvider;
	readonly model: string;
	/** Start of the hour, epoch ms. */
	readonly hour: number;
	/** Input billed at the full rate. */
	readonly uncached: number;
	/** Input read from the prompt cache. */
	readonly cached: number;
	/** Input written to the prompt cache. */
	readonly cacheWrite: number;
	/** Output, reasoning included. */
	readonly output: number;
	/** What these tokens cost at public API prices, or what the provider reported. */
	readonly costUsd: number;
	/** What the cached input would have cost at the full input rate, minus what it cost. */
	readonly savingsUsd: number;
	/** No price was known for this model, so `costUsd` is 0. */
	readonly unpriced: boolean;
	/**
	 * `costUsd` by token category. A provider-reported cost is split in proportion to the model's
	 * list rates; cost with no known rates stays out, so these can sum to less than `costUsd`.
	 */
	readonly inputCostUsd: number;
	readonly cacheReadCostUsd: number;
	readonly cacheWriteCostUsd: number;
	readonly outputCostUsd: number;
	/** Cost of fast and ultrafast requests; the rest is standard. */
	readonly fastCostUsd: number;
	readonly ultrafastCostUsd: number;
	/** What fast and ultrafast requests cost above the standard rate. */
	readonly speedPremiumUsd: number;
}

/**
 * Sessions active in one provider during one clock hour, whether or not a model answered.
 * Counted like Claude Code's own `/stats`: every session with a message in the window.
 */
export interface IVoltUsageActivity {
	readonly provider: VoltUsageProvider;
	/** Start of the hour, epoch ms. */
	readonly hour: number;
	/** Session indexes, unique across the snapshot. */
	readonly sessions: readonly number[];
}

export interface IVoltUsageNote {
	readonly provider: VoltUsageProvider;
	readonly message: string;
}

export interface IVoltUsageSnapshot {
	readonly generatedAt: number;
	/** Oldest instant covered. */
	readonly sinceMs: number;
	readonly buckets: readonly IVoltUsageBucket[];
	readonly activity: readonly IVoltUsageActivity[];
	/** Distinct sessions across all activity. */
	readonly sessionCount: number;
	/** Providers whose history could not be read, and why. */
	readonly notes: readonly IVoltUsageNote[];
	/** Where model prices came from, e.g. "LiteLLM, updated 2h ago". */
	readonly pricingSource: string;
}

export interface IVoltUsageLimitWindow {
	readonly id: string;
	/** The provider's own name for the window, e.g. "Current session". */
	readonly label: string;
	/** Shown after the label, e.g. "Includes Cursor Grok and Composer". */
	readonly scope?: string;
	/** What happens past the limit, in the provider's words. */
	readonly note?: string;
	/** 0-100. */
	readonly usedPercent: number;
	/** Epoch ms; absent when the window has not started. */
	readonly resetsAt?: number;
	/** Window length, for the pace estimate. */
	readonly windowMs?: number;
}

export interface IVoltUsageLimitGroup {
	readonly provider: VoltUsageProvider;
	/** Subscription name, e.g. "Max 5x" or "Plus". */
	readonly plan?: string;
	readonly windows: readonly IVoltUsageLimitWindow[];
	/** Free full resets the account can still redeem (Codex). */
	readonly resetCredits?: number;
	/** Shown instead of the windows when they could not be read. */
	readonly error?: string;
	/** When the numbers were read; older than now when they came from a transcript. */
	readonly checkedAt: number;
}

export interface IVoltUsageService {
	readonly _serviceBrand: undefined;
	/** Usage history for the last {@link VOLT_USAGE_HISTORY_DAYS} days. Cached briefly unless `force`. */
	getUsage(force?: boolean): Promise<IVoltUsageSnapshot>;
	/** Live rate limits per provider the user is signed in to. */
	getLimits(force?: boolean): Promise<readonly IVoltUsageLimitGroup[]>;
}
