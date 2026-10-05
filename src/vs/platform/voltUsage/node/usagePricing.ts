/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname } from '../../../base/common/path.js';
import { IUsageRecord } from './usageTranscripts.js';

/** LiteLLM's public price list, the same source ccusage and T3 Code use. */
export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Refetch the list once a day; new models show up there within days of launch. */
const PRICES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** USD per token for one billing speed. */
export interface ITokenRates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * Standard rates, plus the rates of each faster speed the model publishes. A request at a speed
 * with no published rates bills at the standard rates.
 */
export interface IModelRate extends ITokenRates {
	/** LiteLLM's `provider_specific_entry.fast` multiple (Claude fast mode), else its `*_priority` rates (Codex `priority`). */
	readonly fast?: ITokenRates;
	/** LiteLLM's `*_ultrafast` rates (Codex `ultrafast`). */
	readonly ultrafast?: ITokenRates;
}

/** A cost split by the kind of token it paid for. */
export interface ICategoryCost {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

function scaleRates(rates: ITokenRates, multiple: number): ITokenRates {
	return { input: rates.input * multiple, output: rates.output * multiple, cacheRead: rates.cacheRead * multiple, cacheWrite: rates.cacheWrite * multiple };
}

/**
 * Per-token USD rates from LiteLLM (October 2026), used only when the list cannot be
 * downloaded and no copy is cached yet. Keeps the common models priced offline.
 */
const OPUS_5: ITokenRates = { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6 };
const FALLBACK_RATES: Record<string, IModelRate> = {
	'claude-opus-5-5': { ...OPUS_5, fast: scaleRates(OPUS_5, 2) },
	'claude-opus-5': { ...OPUS_5, fast: scaleRates(OPUS_5, 2) },
	'claude-fable-5-1': { input: 1e-5, output: 5e-5, cacheRead: 2.5e-7, cacheWrite: 1.25e-5 },
	'claude-sonnet-5-5': { input: 2e-6, output: 1e-5, cacheRead: 2e-7, cacheWrite: 2.5e-6 },
	'claude-haiku-4-5': { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
	'claude-haiku-4-5-20251001': { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
	'gpt-6-astra': { input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheWrite: 1.25e-5 },
	'gpt-6-sol': { input: 2e-6, output: 1e-5, cacheRead: 2e-7, cacheWrite: 2.5e-6 },
};

/** Bare family names are ambiguous across generations, so they stay unpriced rather than guessed. */
const UNPRICEABLE = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable', 'default', 'auto']);

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bareName(key: string): string {
	const slash = key.lastIndexOf('/');
	return slash === -1 ? key : key.slice(slash + 1);
}

function sameTokenRates(a: ITokenRates | undefined, b: ITokenRates | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

function sameRate(a: IModelRate, b: IModelRate): boolean {
	return sameTokenRates(a, b) && sameTokenRates(a.fast, b.fast) && sameTokenRates(a.ultrafast, b.ultrafast);
}

/**
 * One rate set from a LiteLLM entry; `suffix` picks a tier such as `_priority`. Needs both an
 * input and an output rate. Cache rates the entry leaves out are priced as plain input for the
 * standard tier, and keep the standard tier's cache-to-input ratio for a faster one.
 */
function readTokenRates(entry: Record<string, unknown>, suffix: string, standard?: ITokenRates): ITokenRates | undefined {
	const input = finite(entry[`input_cost_per_token${suffix}`]);
	const output = finite(entry[`output_cost_per_token${suffix}`]);
	if (input === undefined || output === undefined) {
		return undefined;
	}
	const cache = (field: string, ratio: 'cacheRead' | 'cacheWrite') => finite(entry[`${field}${suffix}`])
		?? (standard && standard.input > 0 ? (standard[ratio] / standard.input) * input : input);
	return { input, output, cacheRead: cache('cache_read_input_token_cost', 'cacheRead'), cacheWrite: cache('cache_creation_input_token_cost', 'cacheWrite') };
}

/**
 * Turns the LiteLLM document into a rate table. Entries missing an input or output rate are
 * dropped: half a price under-reports cost, which is worse than showing "Unpriced". A bare
 * name (`gpt-6-sol` for `azure/gpt-6-sol`) is added only when every qualified entry agrees.
 */
export function parseRateTable(document: unknown): Map<string, IModelRate> {
	const table = new Map<string, IModelRate>();
	if (!document || typeof document !== 'object') {
		return table;
	}
	for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const standard = readTokenRates(entry, '');
		const key = name.trim().toLowerCase();
		if (!standard || !key) {
			continue;
		}
		const specific = entry.provider_specific_entry && typeof entry.provider_specific_entry === 'object' ? entry.provider_specific_entry as Record<string, unknown> : undefined;
		const multiple = finite(specific?.fast);
		const fast = multiple && multiple > 0 ? scaleRates(standard, multiple) : readTokenRates(entry, '_priority', standard);
		const ultrafast = readTokenRates(entry, '_ultrafast', standard);
		table.set(key, { ...standard, ...(fast ? { fast } : {}), ...(ultrafast ? { ultrafast } : {}) });
	}
	const aliases = new Map<string, IModelRate | null>();
	for (const [key, rate] of table) {
		const alias = bareName(key);
		if (!alias || alias === key || table.has(alias)) {
			continue;
		}
		const held = aliases.get(alias);
		if (held === undefined) {
			aliases.set(alias, rate);
		} else if (held && !sameRate(held, rate)) {
			aliases.set(alias, null);
		}
	}
	for (const [alias, rate] of aliases) {
		if (rate) {
			table.set(alias, rate);
		}
	}
	return table;
}

/** Drops `[1m]` and similar variant suffixes; the table only knows base names. */
export function rateKey(model: string): string {
	const key = model.trim().toLowerCase();
	const bracket = key.indexOf('[');
	return bracket === -1 ? key : key.slice(0, bracket);
}

export class UsagePricing {

	private table: Map<string, IModelRate> = new Map(Object.entries(FALLBACK_RATES));
	private loadedAt = 0;
	private source = 'built-in prices';
	private loading: Promise<void> | undefined;

	constructor(private readonly cachePath: string) { }

	get description(): string {
		return this.source;
	}

	/** Loads the cached list, then refreshes it from LiteLLM when it is older than a day. */
	ensureLoaded(): Promise<void> {
		if (this.loadedAt && Date.now() - this.loadedAt < PRICES_MAX_AGE_MS) {
			return Promise.resolve();
		}
		this.loading ??= this.load().finally(() => this.loading = undefined);
		return this.loading;
	}

	private async load(): Promise<void> {
		let cachedAt = 0;
		try {
			const [text, stat] = await Promise.all([fs.readFile(this.cachePath, 'utf8'), fs.stat(this.cachePath)]);
			this.apply(parseRateTable(JSON.parse(text)), stat.mtimeMs);
			cachedAt = stat.mtimeMs;
		} catch {
			// No cached copy yet.
		}
		if (cachedAt && Date.now() - cachedAt < PRICES_MAX_AGE_MS) {
			return;
		}
		try {
			const response = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(15_000) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const text = await response.text();
			const table = parseRateTable(JSON.parse(text));
			if (table.size < 100) {
				throw new Error('price list looks truncated');
			}
			this.apply(table, Date.now());
			await fs.mkdir(dirname(this.cachePath), { recursive: true });
			await fs.writeFile(this.cachePath, text);
		} catch {
			// Offline: keep the cached or built-in table, and try again on the next refresh.
			this.loadedAt = 0;
			if (!cachedAt) {
				this.source = 'built-in prices';
			}
		}
	}

	private apply(table: Map<string, IModelRate>, at: number): void {
		for (const [key, rate] of Object.entries(FALLBACK_RATES)) {
			if (!table.has(key)) {
				table.set(key, rate);
			}
		}
		this.table = table;
		this.loadedAt = at;
		this.source = 'LiteLLM public API prices';
	}

	rate(model: string): IModelRate | undefined {
		const key = rateKey(model);
		if (!key || UNPRICEABLE.has(bareName(key))) {
			return undefined;
		}
		return this.table.get(key) ?? this.table.get(bareName(key)) ?? this.table.get(key.replace(/-\d{8}$/, ''));
	}

	/**
	 * Prices one record. Reasoning tokens are already inside `output`. A provider-reported cost
	 * (Cursor) is kept as is and split by category and speed in proportion to the model's list
	 * rates; with no known rates it stays unsplit. The premium is what a faster speed cost above
	 * the same tokens at standard rates.
	 */
	price(record: IUsageRecord, rateModel = record.model): IPricedUsage {
		const rate = this.rate(rateModel);
		const reported = record.reportedCostUsd;
		if (!rate) {
			return reported !== undefined
				? { cost: reported, savings: 0, unpriced: false, premium: 0 }
				: { cost: 0, savings: 0, unpriced: true, premium: 0 };
		}
		const rates = (record.speed === 'standard' ? undefined : rate[record.speed]) ?? rate;
		const list = costByCategory(record, rates);
		const listCost = list.input + list.cacheRead + list.cacheWrite + list.output;
		const savings = record.cached * (rates.input - rates.cacheRead);
		if (reported !== undefined && listCost <= 0) {
			return { cost: reported, savings, unpriced: false, premium: 0 };
		}
		const standard = costByCategory(record, rate);
		const premium = record.speed === 'standard' ? 0 : listCost - (standard.input + standard.cacheRead + standard.cacheWrite + standard.output);
		const scale = reported === undefined ? 1 : reported / listCost;
		return {
			cost: reported ?? listCost,
			savings,
			unpriced: false,
			categories: { input: list.input * scale, cacheRead: list.cacheRead * scale, cacheWrite: list.cacheWrite * scale, output: list.output * scale },
			premium: premium * scale,
		};
	}
}

export interface IPricedUsage {
	readonly cost: number;
	readonly savings: number;
	readonly unpriced: boolean;
	/** `cost` by token category; absent when no rates are known to split it. */
	readonly categories?: ICategoryCost;
	/** What a faster speed cost above standard rates. */
	readonly premium: number;
}

function costByCategory(record: IUsageRecord, rates: ITokenRates): ICategoryCost {
	return {
		input: record.uncached * rates.input,
		cacheRead: record.cached * rates.cacheRead,
		cacheWrite: record.cacheWrite * rates.cacheWrite,
		output: record.output * rates.output,
	};
}
