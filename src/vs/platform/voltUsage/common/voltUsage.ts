/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltUsageService = createDecorator<IVoltUsageService>('voltUsageService');
export const VOLT_USAGE_CHANNEL_NAME = 'voltUsage';
/** `{ "claude": [dirs], "codex": [dirs] }`: logins to read besides each agent's default. */
/** Lets other machines read this one's usage and copies the address to paste there (desktop only). */
export const VOLT_USAGE_SHARE_MACHINE_COMMAND_ID = 'workbench.action.voltAgent.usage.shareMachine';
export const VOLT_USAGE_ACCOUNT_DIRS_SETTING = 'volt.usage.accountDirectories';

/**
 * Agents whose usage Volt can read: local transcripts for Claude Code and Codex, the account API
 * for Cursor. OpenCode Go and Grok report subscription limits only.
 */
export type VoltUsageProvider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'grok';

export const VOLT_USAGE_PROVIDERS: readonly VoltUsageProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'grok'];

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
	/** Machines whose usage is included besides this one. */
	readonly machines?: readonly IVoltUsageMachineStatus[];
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

/** The subscription account a limit reading belongs to. */
export interface IVoltUsageAccount {
	/**
	 * Stable across machines (the provider's account id, or a hash of the login when the provider
	 * has none), so the same account read on two machines counts once.
	 */
	readonly id: string;
	/** Email or name, when the login says. */
	readonly label?: string;
}

export interface IVoltUsageLimitGroup {
	readonly provider: VoltUsageProvider;
	readonly account?: IVoltUsageAccount;
	/** Subscription name, e.g. "Max 5x" or "Plus". */
	readonly plan?: string;
	readonly windows: readonly IVoltUsageLimitWindow[];
	/** Free full resets the account can still redeem (Claude banked resets, Codex reset credits). */
	readonly resetCredits?: number;
	/** When the next reset credit to be spent expires, epoch ms. */
	readonly resetCreditsExpireAt?: number;
	/** Shown instead of the windows when they could not be read. */
	readonly error?: string;
	/** When the numbers were read; older than now when they came from a transcript. */
	readonly checkedAt: number;
	/** Names of the machines the account is signed in on. Absent: only this one. */
	readonly machines?: readonly string[];
}

/** What redeeming a reset credit did. */
export type VoltResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/** Another machine's Volt agent server whose usage is added to this one's. */
export interface IVoltUsageMachine {
	readonly id: string;
	readonly name: string;
	/** `http://host:port`, without the token. */
	readonly url: string;
}

export interface IVoltUsageMachineStatus extends IVoltUsageMachine {
	readonly state: 'ok' | 'offline' | 'unauthorized' | 'error';
	/** When the machine last answered, epoch ms. */
	readonly checkedAt?: number;
}

/** USD per million tokens. Cache rates default to the input rate. */
export interface IVoltUsageModelPrice {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/** One machine's own usage, as its agent server answers `GET /api/usage`. */
export interface IVoltUsageMachineReport {
	readonly machineName: string;
	/** Same for every Volt on one computer and user, so a computer added as its own machine is refused. */
	readonly machineId?: string;
	readonly usage: IVoltUsageSnapshot;
	readonly limits: readonly IVoltUsageLimitGroup[];
	/** The Cursor account its Cursor rows came from: account-wide, so counted once across machines. */
	readonly cursorAccount?: string;
}

export interface IVoltUsageService {
	readonly _serviceBrand: undefined;
	/** Usage history for the last {@link VOLT_USAGE_HISTORY_DAYS} days, other machines' included. Cached briefly unless `force`. */
	getUsage(force?: boolean): Promise<IVoltUsageSnapshot>;
	/** Live rate limits per account, pooled from this machine and the others. */
	getLimits(force?: boolean): Promise<readonly IVoltUsageLimitGroup[]>;
	/** Spends one of the account's reset credits, on whichever machine holds its login. */
	redeemResetCredit(provider: VoltUsageProvider, accountId: string): Promise<VoltResetCreditOutcome>;
	getMachines(): Promise<readonly IVoltUsageMachineStatus[]>;
	/** Adds a machine from the address its agent server shares (`http://host:port/#token=…`); checks it answers first. */
	addMachine(pairingUrl: string, name?: string): Promise<IVoltUsageMachineStatus>;
	removeMachine(id: string): Promise<void>;
	/** Prices the user set, by model id. They replace automatic pricing for that model. */
	getModelPrices(): Promise<Record<string, IVoltUsageModelPrice>>;
	/** Sets or (with `undefined`) clears a model's price. */
	setModelPrice(model: string, price: IVoltUsageModelPrice | undefined): Promise<void>;
}
