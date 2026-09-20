/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { booleanOption, IModelOptionDescriptor, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_SERVICE_TIER, reasoningOption, selectOption } from './modelOptions.js';

/**
 * CLI agents often under-report effort ladders and extra selects over ACP. These catalogs
 * overlay the missing traits onto models the agent actually advertised, using the same
 * per-family ladders Zeron reads from Claude Code / Codex. Nothing here invents a model row.
 */

export interface ICatalogOverlay {
	description?: string;
	contextWindow?: number;
	optionDescriptors: IModelOptionDescriptor[];
}

interface ICatalogEntry extends ICatalogOverlay {
	id: string;
	label: string;
}

const CLAUDE_CONTEXT = selectOption(MODEL_OPTION_CONTEXT, 'Context Window', [
	{ value: '200k', label: '200K', isDefault: true },
	{ value: '1m', label: '1M' },
]);

const CLAUDE_FAST = booleanOption(MODEL_OPTION_FAST, 'Fast Mode', false);
const CLAUDE_THINKING = booleanOption('thinking', 'Thinking', false);

const CLAUDE_FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'] as const;
const CLAUDE_XHIGH = ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'] as const;

const CLAUDE_CATALOG: ICatalogEntry[] = [
	entry('claude-fable-5-1', 'Fable 5.1', 'Most intelligent model for building agents', CLAUDE_FULL, [CLAUDE_CONTEXT], 200_000),
	entry('claude-fable-5', 'Fable 5', 'Previous generation Fable', CLAUDE_FULL, [CLAUDE_CONTEXT], 200_000),
	entry('claude-opus-5', 'Opus 5', 'Powerful model for complex work', CLAUDE_FULL, [CLAUDE_CONTEXT, CLAUDE_FAST], 200_000),
	entry('claude-opus-4-8', 'Opus 4.8', 'Previous generation Opus', CLAUDE_FULL, [CLAUDE_FAST]),
	entry('claude-opus-4-7', 'Opus 4.7', 'Older generation Opus', CLAUDE_XHIGH, [CLAUDE_FAST]),
	entry('claude-sonnet-5', 'Sonnet 5', 'Balanced speed and intelligence', CLAUDE_XHIGH, [CLAUDE_CONTEXT], 200_000),
	entry('claude-haiku-4-5', 'Haiku 4.5', 'Fastest model for everyday tasks', [], [CLAUDE_THINKING]),
];

const CODEX_TIER = selectOption(MODEL_OPTION_SERVICE_TIER, 'Service Tier', [
	{ value: 'default', label: 'Standard', isDefault: true },
	{ value: 'fast', label: 'Fast' },
]);

const CODEX_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const CODEX_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_XHIGH = ['low', 'medium', 'high', 'xhigh'] as const;

const CODEX_CATALOG: ICatalogEntry[] = [
	entry('gpt-6-astra', 'GPT-6-Astra', 'Our most capable model for complex, demanding work.', CODEX_ULTRA, [CODEX_TIER]),
	entry('gpt-5.6-sol', 'GPT-5.6-Sol', 'Frontier reasoning flagship', CODEX_ULTRA, [CODEX_TIER]),
	entry('gpt-5.6-terra', 'GPT-5.6-Terra', 'Deep multi-step agentic work', CODEX_ULTRA, [CODEX_TIER]),
	entry('gpt-5.6-luna', 'GPT-5.6-Luna', 'Fast frontier model', CODEX_MAX, [CODEX_TIER]),
	entry('gpt-daybreak-blue-latest', 'Daybreak Blue', 'Frontier model for defensive cybersecurity work', CODEX_ULTRA, []),
	entry('gpt-5.5', 'GPT-5.5', 'Previous generation flagship', CODEX_XHIGH, [CODEX_TIER]),
	entry('gpt-5.4', 'GPT-5.4', 'Reliable general coding', CODEX_XHIGH, [CODEX_TIER]),
	entry('gpt-5.4-mini', 'GPT-5.4-Mini', 'Small, fast and capable', CODEX_XHIGH, [CODEX_TIER]),
	entry('gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', 'Ultra-fast lightweight coding', CODEX_XHIGH, [CODEX_TIER]),
];

const OPENCODE_LADDER = ['low', 'medium', 'high'] as const;

const OPENCODE_CATALOG: ICatalogEntry[] = [
	entry('big-pickle', 'Big Pickle', 'OpenCode Zen\'s flagship coding model', [], []),
	entry('mimo-v2.5-free', 'MiMo V2.5 Free', 'Free tier on OpenCode Zen', [], []),
	entry('hy3-free', 'Hy3 Free', 'Free tier on OpenCode Zen', OPENCODE_LADDER, []),
];

const ANTIGRAVITY_FLASH = ['low', 'medium', 'high'] as const;
const ANTIGRAVITY_PRO = ['low', 'high'] as const;
const ANTIGRAVITY_THINKING = ['thinking'] as const;

const ANTIGRAVITY_CATALOG: ICatalogEntry[] = [
	entry('gemini-3.6-flash', 'Gemini 3.6 Flash', 'Google\'s fast Antigravity model', ANTIGRAVITY_FLASH, []),
	entry('gemini-3.5-flash', 'Gemini 3.5 Flash', 'Previous generation Antigravity flash', ANTIGRAVITY_FLASH, []),
	entry('gemini-3.1-pro', 'Gemini 3.1 Pro', 'Antigravity reasoning model', ANTIGRAVITY_PRO, []),
	entry('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Claude on Antigravity', ANTIGRAVITY_THINKING, []),
	entry('claude-opus-4-6', 'Claude Opus 4.6', 'Claude Opus on Antigravity', ANTIGRAVITY_THINKING, []),
	entry('claude-3.7-sonnet', 'Claude 3.7 Sonnet', 'Claude 3.7 on Antigravity', ANTIGRAVITY_THINKING, []),
	entry('deepseek-v4-flash-max', 'DeepSeek V4 Flash Max', 'DeepSeek on Antigravity', ['high'], []),
	entry('gpt-oss-120b', 'GPT-OSS 120B', 'Open-weight model on Antigravity', ['medium'], []),
];

function entry(id: string, label: string, description: string, ladder: readonly string[], options: IModelOptionDescriptor[], contextWindow?: number): ICatalogEntry {
	return {
		id,
		label,
		description,
		...(contextWindow ? { contextWindow } : {}),
		optionDescriptors: [
			...(ladder.length ? [reasoningOption(ladder, ladder.includes('high') ? 'high' : ladder[0])] : []),
			...options,
		],
	};
}

const CATALOGS: Record<string, ICatalogEntry[]> = {
	'claude-code': CLAUDE_CATALOG,
	claude: CLAUDE_CATALOG,
	anthropic: CLAUDE_CATALOG,
	codex: CODEX_CATALOG,
	openai: CODEX_CATALOG,
	opencode: OPENCODE_CATALOG,
	antigravity: ANTIGRAVITY_CATALOG,
	agy: ANTIGRAVITY_CATALOG,
	'gemini-cli': ANTIGRAVITY_CATALOG,
	'gemini-acp': ANTIGRAVITY_CATALOG,
};

/** `anthropic/claude-opus-4-7-20260101[1m]` → `opus-4-7`. */
export function canonicalModelKey(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/\[.*\]$/, '')
		.replace(/^[^/\s]+\/+/, '')
		.replace(/^claude-/, '')
		.replace(/-20\d{6}$/, '')
		.replace(/\./g, '-')
		.replace(/_/g, '-');
}

function overlayScore(key: string, labelKey: string, item: ICatalogEntry): number {
	const itemKey = canonicalModelKey(item.id);
	const itemLabel = canonicalModelKey(item.label);
	if (key === itemKey || (labelKey && labelKey === itemLabel)) {
		return 100;
	}
	if (key === itemLabel || (labelKey && labelKey === itemKey)) {
		return 90;
	}
	if (itemKey.length >= 6 && (key === itemKey || key.endsWith(`-${itemKey}`))) {
		return 70;
	}
	if (key.length >= 6 && itemKey.endsWith(`-${key}`)) {
		return 60;
	}
	return 0;
}

export function catalogOverlay(providerId: string, modelId: string, label?: string): ICatalogOverlay | undefined {
	const catalog = CATALOGS[providerId];
	if (!catalog?.length) {
		return undefined;
	}
	const key = canonicalModelKey(modelId);
	const labelKey = label ? canonicalModelKey(label) : '';
	let best: ICatalogEntry | undefined;
	let bestScore = 0;
	for (const item of catalog) {
		const score = overlayScore(key, labelKey, item);
		if (score > bestScore) {
			best = item;
			bestScore = score;
		}
	}
	if (!best) {
		return undefined;
	}
	return {
		...(best.description ? { description: best.description } : {}),
		...(best.contextWindow ? { contextWindow: best.contextWindow } : {}),
		optionDescriptors: best.optionDescriptors.map(descriptor => ({
			...descriptor,
			...(descriptor.options ? { options: descriptor.options.map(choice => ({ ...choice })) } : {}),
		})),
	};
}
