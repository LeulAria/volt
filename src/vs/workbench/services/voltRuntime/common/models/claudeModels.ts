/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a Claude model accepts, decided from its id and, when the Models API reported them, its
 * real limits. Request builders read this instead of matching `opus` / `sonnet` substrings:
 *
 * - `adaptive`: `thinking: {type: "adaptive"}` plus `output_config.effort` (4.6 and later).
 *   `budget_tokens` is rejected on these with a 400.
 * - `budget`: `thinking: {type: "enabled", budget_tokens}` (Haiku 4.5, 4.5 and older).
 * - `none`: no extended thinking.
 */

export type ClaudeThinkingStyle = 'adaptive' | 'budget' | 'none';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IClaudeModelMeta {
	readonly family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos' | 'unknown';
	/** Major.minor, e.g. 4.6 or 5. */
	readonly version: number;
	readonly thinking: ClaudeThinkingStyle;
	/** Thinking cannot be turned off; omit the parameter and lower the effort instead. */
	readonly thinkingAlwaysOn: boolean;
	/** Effort levels `output_config.effort` accepts. Empty when the model rejects the field. */
	readonly efforts: readonly ClaudeEffort[];
	readonly maxOutputTokens: number;
	readonly contextWindow: number;
}

export interface IListedClaudeLimits {
	readonly max_input_tokens?: number;
	readonly max_tokens?: number;
}

/** Default output ceiling for a streamed turn. Output is billed only for what is generated. */
export const CLAUDE_STREAM_OUTPUT_TOKENS = 64_000;

const FAMILY = /(opus|sonnet|haiku|fable|mythos)/;

export function claudeModelMeta(modelId: string, listed?: IListedClaudeLimits): IClaudeModelMeta {
	const id = normalizeClaudeId(modelId);
	const family = (FAMILY.exec(id)?.[1] ?? 'unknown') as IClaudeModelMeta['family'];
	const version = claudeVersion(id);
	const newest = family === 'fable' || family === 'mythos' || version >= 5;
	let thinking: ClaudeThinkingStyle;
	if (newest || (version >= 4.6 && family !== 'haiku')) {
		thinking = 'adaptive';
	} else if (version >= 3.7 || family === 'haiku' && version >= 4.5) {
		thinking = 'budget';
	} else {
		thinking = 'none';
	}
	const thinkingAlwaysOn = family === 'fable' || family === 'mythos' || /opus-5-5/.test(id);
	let efforts: ClaudeEffort[] = [];
	if (thinking === 'adaptive') {
		efforts = version >= 4.7 || newest ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'max'];
	} else if (family === 'opus' && version >= 4.5) {
		efforts = ['low', 'medium', 'high'];
	}
	let maxOutputTokens: number;
	if (thinking === 'adaptive') {
		maxOutputTokens = 128_000;
	} else if (family === 'opus' && version >= 4 && version < 4.5) {
		maxOutputTokens = 32_000;
	} else if (version >= 3.7) {
		maxOutputTokens = 64_000;
	} else {
		maxOutputTokens = 8_192;
	}
	let contextWindow = thinking === 'adaptive' && family !== 'haiku' ? 1_000_000 : 200_000;
	if (listed?.max_tokens && listed.max_tokens > 0) {
		maxOutputTokens = listed.max_tokens;
	}
	if (listed?.max_input_tokens && listed.max_input_tokens > 0) {
		contextWindow = listed.max_input_tokens;
	}
	return { family, version, thinking, thinkingAlwaysOn, efforts, maxOutputTokens, contextWindow };
}

/**
 * The thinking and effort fields for one request. `effort` is the level Volt chose (or the user
 * pinned); `undefined` or `off` turns thinking off where the model allows it.
 */
export function claudeThinkingParams(meta: IClaudeModelMeta, effort: string | undefined, maxTokens: number): Record<string, unknown> {
	const level = normalizeEffort(effort);
	if (meta.thinking === 'adaptive') {
		const out: Record<string, unknown> = {};
		if (level === 'off' && !meta.thinkingAlwaysOn) {
			out.thinking = { type: 'disabled' };
			return out;
		}
		out.thinking = { type: 'adaptive', display: 'summarized' };
		const chosen = level === 'off' ? 'low' : level;
		const supported = chosen ? closestEffort(chosen, meta.efforts) : undefined;
		if (supported) {
			out.output_config = { effort: supported };
		}
		return out;
	}
	if (meta.thinking === 'budget') {
		if (!level || level === 'off' || level === 'low') {
			return {};
		}
		const budget = level === 'medium' ? 4_096 : level === 'high' ? 12_000 : 24_000;
		const capped = Math.max(1_024, Math.min(budget, maxTokens - 2_048));
		const out: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: capped } };
		const supported = closestEffort(level, meta.efforts);
		if (supported) {
			out.output_config = { effort: supported };
		}
		return out;
	}
	return {};
}

function normalizeEffort(value: string | undefined): ClaudeEffort | 'off' | undefined {
	const key = value?.trim().toLowerCase().replace(/[\s_-]+/g, '');
	switch (key) {
		case undefined:
		case '':
		case 'auto':
			return undefined;
		case 'off':
		case 'none':
		case 'false':
			return 'off';
		case 'minimal':
		case 'min':
		case 'low':
			return 'low';
		case 'medium':
		case 'med':
			return 'medium';
		case 'high':
		case 'true':
			return 'high';
		case 'xhigh':
		case 'extrahigh':
			return 'xhigh';
		case 'max':
		case 'ultra':
		case 'ultrathink':
			return 'max';
		default:
			return undefined;
	}
}

const EFFORT_ORDER: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function closestEffort(wanted: ClaudeEffort, supported: readonly ClaudeEffort[]): ClaudeEffort | undefined {
	if (!supported.length) {
		return undefined;
	}
	if (supported.includes(wanted)) {
		return wanted;
	}
	const rank = EFFORT_ORDER.indexOf(wanted);
	const below = supported.filter(level => EFFORT_ORDER.indexOf(level) <= rank);
	return below.at(-1) ?? supported[0];
}

/** `anthropic.claude-opus-4-6-v1:0`, `claude-3-7-sonnet@20250219`, `anthropic/claude-sonnet-4` → comparable id. */
export function normalizeClaudeId(modelId: string): string {
	return modelId.toLowerCase()
		.replace(/^.*\//, '')
		.replace(/^(?:us\.|eu\.|apac\.|global\.)?anthropic\./, '')
		.replace(/@.*$/, '')
		.replace(/-v\d+(?::\d+)?$/, '')
		.replace(/-\d{8}$/, '');
}

/** `claude-opus-4-6` → 4.6, `claude-3-7-sonnet` → 3.7, `claude-sonnet-5` → 5. */
export function claudeVersion(normalizedId: string): number {
	const afterFamily = /(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(normalizedId);
	if (afterFamily) {
		return Number(afterFamily[1]) + (afterFamily[2] && afterFamily[2].length === 1 ? Number(afterFamily[2]) / 10 : 0);
	}
	const beforeFamily = /claude-(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku)/.exec(normalizedId);
	if (beforeFamily) {
		return Number(beforeFamily[1]) + (beforeFamily[2] && beforeFamily[2].length === 1 ? Number(beforeFamily[2]) / 10 : 0);
	}
	return 0;
}
