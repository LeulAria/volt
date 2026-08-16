/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from './events.js';

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
	if (input === undefined && output === undefined && total === undefined && used === undefined && size === undefined) {
		return undefined;
	}
	const resolvedInput = input ?? 0;
	const resolvedOutput = output ?? (total !== undefined ? Math.max(0, total - resolvedInput) : 0);
	const cache = readTokenCount(usage.cachedReadTokens ?? usage.cached_read_tokens ?? usage.cache);
	return {
		type: 'usage',
		input: resolvedInput,
		output: resolvedOutput,
		...(used !== undefined ? { used } : {}),
		...(size !== undefined ? { size } : {}),
		...(cache !== undefined ? { cache } : {}),
	};
}

export function readTokenCount(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}
