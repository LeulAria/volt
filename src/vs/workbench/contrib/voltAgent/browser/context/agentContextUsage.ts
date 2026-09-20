/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../../../services/voltRuntime/common/capabilities.js';
import { IVoltHostToolInfo } from '../../../../services/voltRuntime/common/hostTools.js';
import { pickNumber } from '../../../../services/voltRuntime/common/models/modelMeta.js';
import { IModelOptionDescriptor, IVoltModelOptions, MODEL_OPTION_CONTEXT, optionValue } from '../../../../services/voltRuntime/common/models/modelOptions.js';
import { AgentCustomizationKind, IAgentCustomization } from '../customize/agentCustomize.js';
import { AgentSegment, blocksPlainText, collectBlocks } from '../blocks/agentBlocks.js';

/**
 * Context occupancy for the agent composer. Live `used`/`size` come from the
 * runtime (ACP `usage_update` or provider usage), matching t3code, OpenCode,
 * Roo, and pi: a new session stays at zero until the transcript or the
 * provider reports occupancy. Category slices are then allocated from that
 * occupancy plus local estimates for rules, skills, tools, and the draft.
 */

export type ContextCategoryId =
	| 'system'
	| 'tools'
	| 'rules'
	| 'skills'
	| 'mcp'
	| 'subagents'
	| 'summarized'
	| 'conversation'
	| 'reply'
	| 'draft'
	| 'unaccounted';

export interface IContextUsageCategory {
	readonly id: ContextCategoryId;
	readonly label: string;
	readonly tokens: number;
	readonly color: string;
	readonly detail?: string;
}

export interface IContextUsageModel {
	readonly ref: string;
	readonly name: string;
	readonly family: string;
	readonly provider?: string;
	readonly window: number;
	readonly active: boolean;
}

export interface IContextUsageProviderGroup {
	readonly family: string;
	readonly label: string;
	readonly models: readonly IContextUsageModelRow[];
}

export interface IContextUsageModelRow extends IContextUsageModel {
	readonly percent: number;
	readonly remaining: number;
	readonly fits: boolean;
}

export interface IContextOverhead {
	readonly system: number;
	readonly tools: number;
	readonly rules: number;
	readonly skills: number;
	readonly mcp: number;
	readonly subagents: number;
	readonly ruleCount: number;
	readonly skillCount: number;
	readonly mcpCount: number;
	readonly subagentCount: number;
}

export interface IContextUsageMessage {
	readonly kind: 'user' | 'agent';
	readonly text?: string;
	/** Expanded prompt the model received (mentions, attached files). */
	readonly agentText?: string;
	readonly title?: string;
	readonly steps?: readonly { label: string }[];
	readonly changes?: readonly string[];
	readonly activity?: { thinkingText?: string };
	readonly segments?: AgentSegment[];
	readonly tokensUsed?: number;
	readonly tokensWindow?: number;
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly tokensCache?: number;
}

export interface IContextUsageInput {
	readonly messages: readonly IContextUsageMessage[];
	readonly draft: string;
	readonly reportedUsed?: number;
	readonly reportedLimit?: number;
	readonly modelWindow: number;
	readonly modelName?: string;
	readonly nativeAgent?: boolean;
	readonly overhead?: IContextOverhead;
	readonly models: readonly IContextUsageModel[];
}

export interface IContextUsageSnapshot {
	readonly used: number;
	readonly limit: number;
	readonly remaining: number;
	readonly percent: number;
	readonly estimated: boolean;
	readonly input?: number;
	readonly output?: number;
	readonly cache?: number;
	readonly draft: number;
	readonly items: readonly IContextUsageCategory[];
	readonly models: readonly IContextUsageModelRow[];
	readonly modelName?: string;
	readonly compacted: boolean;
	readonly fitsOn: number;
}

export const CONTEXT_CATEGORY_COLORS: Record<ContextCategoryId, string> = {
	system: '#8b8b8b',
	tools: '#a78bfa',
	rules: '#f59e0b',
	skills: '#eab308',
	mcp: '#38bdf8',
	subagents: '#7dd3fc',
	summarized: '#f472b6',
	conversation: '#e11d48',
	reply: '#4ade80',
	draft: '#7dd3fc',
	unaccounted: '#818cf8',
};

const NATIVE_SYSTEM_TOKENS = 1_700;
const CHAT_SYSTEM_TOKENS = 400;
const NATIVE_TOOL_TOKENS = 14_000;
const CHAT_TOOL_TOKENS = 800;
const DEFAULT_RULE_TOKENS = 400;
const DEFAULT_SKILL_TOKENS = 800;
const DEFAULT_MCP_TOKENS = 1_200;
const DEFAULT_SUBAGENT_TOKENS = 600;

export function estimateTokensFromText(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) {
		return 0;
	}
	return Math.max(1, Math.round(trimmed.length / 4));
}

export function estimateMessageTokens(message: IContextUsageMessage): number {
	return estimateTokensFromText(messageOccupancyText(message));
}

export function agentMessagePlainText(message: IContextUsageMessage): string {
	const parts: string[] = [];
	if (message.segments || message.text) {
		const fromBlocks = blocksPlainText(collectBlocks(message.segments ?? [], message.text));
		if (fromBlocks) {
			parts.push(fromBlocks);
		}
	}
	if (message.title) {
		parts.push(message.title);
	}
	for (const step of message.steps ?? []) {
		parts.push(step.label);
	}
	if (message.changes?.length) {
		parts.push(message.changes.join('\n'));
	}
	return parts.join('\n');
}

export function formatContextTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) {
		return '0';
	}
	if (n < 1_000) {
		return String(Math.round(n));
	}
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${trimDecimal(m)}M`;
	}
	return `${trimDecimal(n / 1_000)}K`;
}

export function formatContextPercent(percent: number): string {
	if (!Number.isFinite(percent) || percent <= 0) {
		return '0%';
	}
	if (percent < 10) {
		return `${trimDecimal(percent)}%`;
	}
	return `${Math.round(percent)}%`;
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, '');
}

export function resolveModelContextWindow(
	model: { contextWindow?: number; contextLabel?: string; optionDescriptors?: readonly IModelOptionDescriptor[] } | undefined,
	options?: IVoltModelOptions,
	fallback = DEFAULT_MODEL_CAPABILITIES.contextWindow,
): number {
	if (!model) {
		return fallback;
	}
	const context = model.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT);
	const option = context && options ? optionValue(context, options) : undefined;
	return pickNumber(typeof option === 'string' ? option : undefined, model.contextLabel, model.contextWindow) ?? fallback;
}

export function defaultOverhead(nativeAgent = false): IContextOverhead {
	return {
		system: nativeAgent ? NATIVE_SYSTEM_TOKENS : CHAT_SYSTEM_TOKENS,
		tools: nativeAgent ? NATIVE_TOOL_TOKENS : CHAT_TOOL_TOKENS,
		rules: 0,
		skills: 0,
		mcp: 0,
		subagents: 0,
		ruleCount: 0,
		skillCount: 0,
		mcpCount: 0,
		subagentCount: 0,
	};
}

export function overheadFromCustomizations(
	items: readonly IAgentCustomization[],
	hostTools: readonly IVoltHostToolInfo[] = [],
	nativeAgent = false,
): IContextOverhead {
	const base = defaultOverhead(nativeAgent);
	const hostToolTokens = hostTools.reduce((sum, tool) => sum + estimateTokensFromText(JSON.stringify(tool)), 0);
	const byKind = (kind: AgentCustomizationKind) => items.filter(item => item.kind === kind);
	const tokensFor = (kind: AgentCustomizationKind, fallback: number) => {
		const matched = byKind(kind);
		return matched.reduce((sum, item) => {
			const bytes = item.bytes;
			return sum + (bytes && bytes > 0 ? Math.max(1, Math.round(bytes / 4)) : fallback);
		}, 0);
	};
	return {
		system: base.system,
		tools: base.tools + hostToolTokens,
		rules: tokensFor('rule', DEFAULT_RULE_TOKENS),
		skills: tokensFor('skill', DEFAULT_SKILL_TOKENS),
		mcp: tokensFor('mcp', DEFAULT_MCP_TOKENS),
		subagents: tokensFor('subagent', DEFAULT_SUBAGENT_TOKENS),
		ruleCount: byKind('rule').length,
		skillCount: byKind('skill').length,
		mcpCount: byKind('mcp').length,
		subagentCount: byKind('subagent').length,
	};
}

export function lastUsageMessage(messages: readonly IContextUsageMessage[]): IContextUsageMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.kind === 'agent' && (message.tokensUsed || message.tokensWindow || message.tokensIn || message.tokensOut)) {
			return message;
		}
	}
	return undefined;
}

/** Last-request prompt+completion is session occupancy when ACP `used` is missing. */
export function occupancyFromUsage(message: Pick<IContextUsageMessage, 'tokensUsed' | 'tokensIn' | 'tokensOut'> | undefined, reportedUsed?: number): number | undefined {
	if (message?.tokensUsed && message.tokensUsed > 0) {
		return message.tokensUsed;
	}
	if (reportedUsed && reportedUsed > 0) {
		return reportedUsed;
	}
	const turn = (message?.tokensIn ?? 0) + (message?.tokensOut ?? 0);
	return turn > 0 ? turn : undefined;
}

export function buildContextUsageSnapshot(input: IContextUsageInput): IContextUsageSnapshot {
	const last = lastUsageMessage(input.messages);
	const reportedUsed = occupancyFromUsage(last, input.reportedUsed);
	const reportedLimit = last?.tokensWindow ?? input.reportedLimit;
	const limit = reportedLimit && reportedLimit > 0 ? reportedLimit : Math.max(1, input.modelWindow);
	const draft = estimateTokensFromText(input.draft);
	const hasLiveUsage = !!(reportedUsed && reportedUsed > 0);
	const hasTranscript = input.messages.length > 0;
	const overhead = hasLiveUsage || hasTranscript
		? scaleOverhead(input.overhead ?? defaultOverhead(input.nativeAgent), reportedUsed)
		: zeroOverhead();
	const overheadTotal = overheadSum(overhead);
	const conversation = conversationTokens(input.messages);
	const inputTokens = last?.tokensIn;
	const outputTokens = last?.tokensOut;
	const cacheTokens = last?.tokensCache;

	const items: IContextUsageCategory[] = [];
	const push = (id: ContextCategoryId, label: string, tokens: number, detail?: string) => {
		if (tokens > 0) {
			items.push({ id, label, tokens, color: CONTEXT_CATEGORY_COLORS[id], detail });
		}
	};

	if (hasLiveUsage || hasTranscript) {
		push('system', localize('voltAgent.contextSystem', "System prompt"), overhead.system);
		push('tools', localize('voltAgent.contextTools', "Tool definitions"), overhead.tools);
		push('rules', localize('voltAgent.contextRules', "Rules"), overhead.rules, countDetail(overhead.ruleCount, localize('voltAgent.contextRuleOne', "rule"), localize('voltAgent.contextRuleMany', "rules")));
		push('skills', localize('voltAgent.contextSkills', "Skills"), overhead.skills, countDetail(overhead.skillCount, localize('voltAgent.contextSkillOne', "skill"), localize('voltAgent.contextSkillMany', "skills")));
		push('mcp', localize('voltAgent.contextMcp', "MCP & dynamic tools"), overhead.mcp, countDetail(overhead.mcpCount, localize('voltAgent.contextMcpOne', "server"), localize('voltAgent.contextMcpMany', "servers")));
		push('subagents', localize('voltAgent.contextSubagents', "Subagent definitions"), overhead.subagents, countDetail(overhead.subagentCount, localize('voltAgent.contextSubagentOne', "subagent"), localize('voltAgent.contextSubagentMany', "subagents")));
	}

	let used: number;
	let estimated = true;
	let compacted = false;

	if (hasLiveUsage && reportedUsed) {
		used = reportedUsed + draft;
		estimated = false;
		const remaining = Math.max(0, reportedUsed - overheadTotal);
		if (conversation > remaining) {
			const visible = remaining;
			const summarized = conversation - remaining;
			compacted = summarized > 0;
			push('summarized', localize('voltAgent.contextSummarized', "Summarized conversation"), summarized);
			push('conversation', localize('voltAgent.contextConversation', "Conversation"), visible);
		} else {
			push('conversation', localize('voltAgent.contextConversation', "Conversation"), conversation);
			const leftover = remaining - conversation;
			push('unaccounted', localize('voltAgent.contextOverhead', "Prompt & tools"), leftover);
		}
	} else if (last?.tokensIn) {
		const prompt = last.tokensIn;
		const output = last.tokensOut ?? 0;
		used = prompt + output + draft;
		estimated = false;
		const visible = Math.min(conversation, Math.max(0, prompt - overheadTotal));
		push('conversation', localize('voltAgent.contextConversation', "Conversation"), visible);
		push('unaccounted', localize('voltAgent.contextOverhead', "Prompt & tools"), Math.max(0, prompt - overheadTotal - visible));
		push('reply', localize('voltAgent.contextReply', "Last reply"), output);
	} else if (hasTranscript) {
		used = overheadTotal + conversation + draft;
		push('conversation', localize('voltAgent.contextConversation', "Conversation"), conversation);
	} else {
		used = draft;
	}

	push('draft', localize('voltAgent.contextDraft', "Current prompt"), draft);

	const percent = Math.min(100, (used / limit) * 100);
	const models = input.models.map(model => {
		const modelPercent = model.window > 0 ? Math.min(999, (used / model.window) * 100) : 0;
		return {
			...model,
			percent: modelPercent,
			remaining: Math.max(0, model.window - used),
			fits: used <= model.window,
		};
	}).sort((a, b) => {
		if (a.active !== b.active) {
			return a.active ? -1 : 1;
		}
		return a.window - b.window;
	});

	return {
		used,
		limit,
		remaining: Math.max(0, limit - used),
		percent,
		estimated,
		input: inputTokens,
		output: outputTokens,
		cache: cacheTokens,
		draft,
		items,
		models,
		modelName: input.modelName,
		compacted,
		fitsOn: models.filter(model => model.fits).length,
	};
}

export function filterContextModels(models: readonly IContextUsageModelRow[], query: string): IContextUsageModelRow[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [...models];
	}
	return models.filter(model => [model.name, model.family, model.provider ?? ''].some(value => value.toLowerCase().includes(needle)));
}

export function groupContextModels(models: readonly IContextUsageModelRow[]): IContextUsageProviderGroup[] {
	const groups = new Map<string, IContextUsageModelRow[]>();
	const labels = new Map<string, string>();
	for (const model of models) {
		const family = model.family || 'generic';
		const list = groups.get(family) ?? [];
		list.push(model);
		groups.set(family, list);
		if (!labels.has(family) && model.provider) {
			labels.set(family, model.provider);
		}
	}
	return [...groups.entries()]
		.map(([family, items]) => ({
			family,
			label: labels.get(family) ?? family,
			models: items.slice().sort((a, b) => {
				if (a.active !== b.active) {
					return a.active ? -1 : 1;
				}
				return a.window - b.window;
			}),
		}))
		.sort((a, b) => {
			const aActive = a.models.some(model => model.active);
			const bActive = b.models.some(model => model.active);
			if (aActive !== bActive) {
				return aActive ? -1 : 1;
			}
			return a.label.localeCompare(b.label);
		});
}

function conversationTokens(messages: readonly IContextUsageMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function messageOccupancyText(message: IContextUsageMessage): string {
	if (message.kind === 'user') {
		return message.agentText || message.text || '';
	}
	const parts: string[] = [agentMessagePlainText(message), message.activity?.thinkingText ?? ''];
	for (const segment of message.segments ?? []) {
		if (segment.kind === 'thought') {
			parts.push(segment.text);
		} else if (segment.kind === 'activity') {
			parts.push(segment.item.label, segment.item.detail ?? '', segment.item.text ?? '', segment.item.input ?? '');
		}
	}
	return parts.filter(Boolean).join('\n');
}

function overheadSum(overhead: IContextOverhead): number {
	return overhead.system + overhead.tools + overhead.rules + overhead.skills + overhead.mcp + overhead.subagents;
}

function zeroOverhead(): IContextOverhead {
	return {
		system: 0,
		tools: 0,
		rules: 0,
		skills: 0,
		mcp: 0,
		subagents: 0,
		ruleCount: 0,
		skillCount: 0,
		mcpCount: 0,
		subagentCount: 0,
	};
}

function scaleOverhead(overhead: IContextOverhead, reportedUsed?: number): IContextOverhead {
	const total = overheadSum(overhead);
	if (!reportedUsed || reportedUsed <= 0 || total <= 0 || total <= reportedUsed) {
		return overhead;
	}
	const scale = reportedUsed / total;
	const scaled = (value: number) => Math.round(value * scale);
	return {
		system: scaled(overhead.system),
		tools: scaled(overhead.tools),
		rules: scaled(overhead.rules),
		skills: scaled(overhead.skills),
		mcp: scaled(overhead.mcp),
		subagents: scaled(overhead.subagents),
		ruleCount: overhead.ruleCount,
		skillCount: overhead.skillCount,
		mcpCount: overhead.mcpCount,
		subagentCount: overhead.subagentCount,
	};
}

function countDetail(count: number, one: string, many: string): string | undefined {
	if (count <= 0) {
		return undefined;
	}
	return `${count} ${count === 1 ? one : many}`;
}
