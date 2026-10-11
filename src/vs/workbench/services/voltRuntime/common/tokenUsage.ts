/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltBilledTokens, IVoltEvent } from './events.js';

export type IVoltUsageEvent = Extract<IVoltEvent, { type: 'usage' }>;

/**
 * Reads provider or ACP usage. Chat APIs send prompt/completion counts. ACP
 * `usage_update` sends session occupancy (`used`) and the live window (`size`).
 */
export function parseTokenUsage(raw: unknown): IVoltUsageEvent | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const usage = (o.usage && typeof o.usage === 'object' ? o.usage : o) as Record<string, unknown>;
	const input = readTokenCount(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens ?? usage.input);
	const output = readTokenCount(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens ?? usage.output);
	const total = readTokenCount(usage.totalTokens ?? usage.total_tokens);
	const used = readTokenCount(usage.used ?? o.used);
	const size = readTokenCount(usage.size ?? o.size);
	const costUsd = readCostUsd(o.cost ?? usage.cost);
	if (input === undefined && output === undefined && total === undefined && used === undefined && size === undefined && costUsd === undefined) {
		return undefined;
	}
	const resolvedInput = input ?? 0;
	const resolvedOutput = output ?? (total !== undefined ? Math.max(0, total - resolvedInput) : 0);
	const cache = readTokenCount(usage.cachedReadTokens ?? usage.cached_read_tokens ?? usage.cacheReadTokens ?? usage.cache);
	const cacheWrite = readTokenCount(usage.cachedWriteTokens ?? usage.cached_write_tokens ?? usage.cacheWriteTokens);
	const billed = readBilledTokens(o._meta);
	const own = resolvedInput + resolvedOutput + (cache ?? 0) + (cacheWrite ?? 0);
	return {
		type: 'usage',
		input: resolvedInput,
		output: resolvedOutput,
		...(used !== undefined ? { used } : {}),
		...(size !== undefined ? { size } : {}),
		...(cache !== undefined ? { cache } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(billed && billed.input + billed.output + billed.cacheRead + billed.cacheWrite > own ? { billed } : {}),
	};
}

/**
 * claude-agent-acp's prompt response: `usage` counts the main agent loop only, while
 * `_meta.quota.model_usage` rows (one per model) also count Task subagents, compaction and
 * internal calls. Their sum is what the turn was billed for.
 */
function readBilledTokens(meta: unknown): IVoltBilledTokens | undefined {
	const quota = meta && typeof meta === 'object' ? (meta as { quota?: unknown }).quota : undefined;
	const rows = quota && typeof quota === 'object' ? (quota as { model_usage?: unknown }).model_usage : undefined;
	if (!Array.isArray(rows) || !rows.length) {
		return undefined;
	}
	const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const row of rows) {
		const tally = row && typeof row === 'object' ? (row as { token_count?: unknown }).token_count : undefined;
		if (!tally || typeof tally !== 'object') {
			continue;
		}
		const t = tally as Record<string, unknown>;
		billed.input += readTokenCount(t.inputTokens) ?? 0;
		billed.output += readTokenCount(t.outputTokens) ?? 0;
		billed.cacheRead += readTokenCount(t.cachedInputTokens) ?? 0;
		billed.cacheWrite += readTokenCount(t.cachedWriteTokens) ?? 0;
	}
	return billed;
}

/** ACP's `cost: { amount, currency }`, in US dollars only. */
function readCostUsd(raw: unknown): number | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const cost = raw as { amount?: unknown; currency?: unknown };
	const currency = typeof cost.currency === 'string' ? cost.currency.toUpperCase() : 'USD';
	const amount = typeof cost.amount === 'number' ? cost.amount : typeof cost.amount === 'string' ? Number(cost.amount) : NaN;
	return currency === 'USD' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export function readTokenCount(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}
