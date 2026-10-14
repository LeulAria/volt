/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * USD per million tokens. The defaults are list prices for well-known models at the time of
 * writing and are a starting point only: an organization's own price table (Settings → Prices)
 * wins, and a model with no matching price has no cost (null, never zero).
 */
export interface IPrice {
	/** `provider/model` glob. */
	readonly match: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

export const DEFAULT_PRICES: readonly IPrice[] = [
	// First match wins: a newer model's row before the older family glob it would also match.
	{ match: 'anthropic/claude-fable-5-1*', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	{ match: 'anthropic/claude-fable-5*', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	{ match: 'anthropic/claude-opus-5-5*', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	{ match: 'anthropic/claude-opus-5*', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	{ match: 'anthropic/claude-opus-4-8*', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	{ match: 'anthropic/claude-opus-4-7*', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	{ match: 'anthropic/claude-opus-4-6*', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	{ match: 'anthropic/claude-opus-4*', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	{ match: 'anthropic/claude-sonnet-5*', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	{ match: 'anthropic/claude-sonnet-4*', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	{ match: 'anthropic/claude-haiku-4-5*', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	{ match: 'openai/gpt-5', input: 1.25, output: 10, cacheRead: 0.125 },
	{ match: 'openai/gpt-5-mini', input: 0.25, output: 2, cacheRead: 0.025 },
	{ match: 'openai/gpt-4.1', input: 2, output: 8, cacheRead: 0.5 },
	{ match: 'openai/gpt-4.1-mini', input: 0.4, output: 1.6, cacheRead: 0.1 },
	{ match: 'openai/gpt-4o', input: 2.5, output: 10, cacheRead: 1.25 },
];

export interface ITokenUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/** Cost in micro-USD (integer), or null when no price applies. */
export function costMicros(qualifiedModel: string, usage: ITokenUsage, prices: readonly IPrice[], matches: (value: string, glob: string) => boolean): number | null {
	const price = prices.find(p => matches(qualifiedModel, p.match));
	if (!price) {
		return null;
	}
	const usd = (usage.input * price.input
		+ usage.output * price.output
		+ (usage.cacheRead ?? 0) * (price.cacheRead ?? price.input)
		+ (usage.cacheWrite ?? 0) * (price.cacheWrite ?? price.input)) / 1_000_000;
	return Math.round(usd * 1_000_000);
}

export function formatUsd(micros: number | null | undefined): string {
	if (micros === null || micros === undefined) {
		return '—';
	}
	const usd = micros / 1_000_000;
	return usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd >= 0.01 ? 3 : 4)}`;
}
