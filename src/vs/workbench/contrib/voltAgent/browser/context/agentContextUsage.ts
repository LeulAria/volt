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
	readonly activity?: { thinkingText?: string; streaming?: boolean };
	readonly segments?: AgentSegment[];
	readonly tokensUsed?: number;
	readonly tokensWindow?: number;
	/** `tokensUsed` is the kept summary alone (Claude, right after compacting); the system prompt and tools come on top. */
	readonly usageExcludesPrompt?: boolean;
	/** The chat's first prompt-side occupancy (system prompt, tools, first message), on its first reply. */
	readonly tokensBase?: number;
	/** Tool output the transcript does not keep (file reads): the model read it, so it sits in the context. */
	readonly toolOutputChars?: number;
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

/** Swatch colors from the context popover, in display order. */
export const CONTEXT_CATEGORY_COLORS: Record<ContextCategoryId, string> = {
	system: '#9a9a9a',
	tools: '#9388f1',
	rules: '#3fa365',
	skills: '#f0b567',
	mcp: '#b58ead',
	subagents: '#7baeed',
	summarized: '#fb6b84',
	conversation: '#e07d77',
	reply: '#4ade80',
	draft: '#7dd3fc',
	unaccounted: '#818cf8',
};

/** Category order in the popover. Later rows (reply, draft, unaccounted) follow when present. */
export const CONTEXT_POPOVER_CATEGORY_ORDER: readonly ContextCategoryId[] = [
	'system',
	'tools',
	'rules',
	'skills',
	'mcp',
	'subagents',
	'summarized',
	'conversation',
];

const NATIVE_SYSTEM_TOKENS = 1_700;
const CHAT_SYSTEM_TOKENS = 400;
const NATIVE_TOOL_TOKENS = 14_000;
const CHAT_TOOL_TOKENS = 800;
const DEFAULT_RULE_TOKENS = 400;
const DEFAULT_MCP_TOKENS = 1_200;
/** Path and markup around one skill or subagent entry in the catalog the model sees. */
const CATALOG_ENTRY_CHARS = 80;

export function estimateTokensFromText(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) {
		return 0;
	}
	return Math.max(1, Math.round(trimmed.length / 4));
}

export function estimateMessageTokens(message: IContextUsageMessage): number {
	return estimateTokensFromText(messageOccupancyText(message)) + toolOutputTokens(message.toolOutputChars);
}

/** Tool output is counted at the same four characters per token as the rest of the transcript. */
export function toolOutputTokens(chars: number | undefined): number {
	return chars && chars > 0 ? Math.ceil(chars / 4) : 0;
}

export function agentMessagePlainText(message: IContextUsageMessage): string {
	const parts: string[] = [];
	if (message.segments || message.text) {
		const fromBlocks = blocksPlainText(collectBlocks(message.segments ?? [], message.text));
		if (fromBlocks) {
			parts.push(fromBlocks);
		}
	}
	for (const segment of message.segments ?? []) {
		if (segment.kind === 'notice') {
			parts.push(segment.description ? `${segment.title}\n${segment.description}` : segment.title);
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

/** "28% Full", the muted line under the popover title. */
export function formatContextFullLabel(percent: number): string {
	return `${formatContextPercent(percent)} Full`;
}

/** "~71.6K / 256K Tokens", the right side of that same line. */
export function formatContextWindowLabel(used: number, limit: number): string {
	return `~${formatContextTokens(used)} / ${formatContextTokens(limit)} Tokens`;
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
	// Skills and subagents load on demand: only their name, description and path sit in context.
	const catalogFor = (kind: AgentCustomizationKind) => byKind(kind)
		.reduce((sum, item) => sum + Math.round((item.name.length + item.description.length + CATALOG_ENTRY_CHARS) / 4), 0);
	return {
		system: base.system,
		tools: base.tools + hostToolTokens,
		rules: tokensFor('rule', DEFAULT_RULE_TOKENS),
		skills: catalogFor('skill'),
		mcp: tokensFor('mcp', DEFAULT_MCP_TOKENS),
		subagents: catalogFor('subagent'),
		ruleCount: byKind('rule').length,
		skillCount: byKind('skill').length,
		mcpCount: byKind('mcp').length,
		subagentCount: byKind('subagent').length,
	};
}

export function lastUsageMessage(messages: readonly IContextUsageMessage[]): IContextUsageMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.kind === 'agent' && (message.tokensUsed || message.tokensWindow || message.tokensIn || message.tokensOut || message.tokensCache)) {
			return message;
		}
	}
	return undefined;
}

/**
 * Session occupancy from the latest usage event. Prefer ACP/`used`. When that is
 * missing, prompt + completion + cache is one coherent turn total so the header
 * and Input/Output/Cached chips describe the same snapshot.
 */
export function occupancyFromUsage(message: Pick<IContextUsageMessage, 'tokensUsed' | 'tokensIn' | 'tokensOut' | 'tokensCache'> | undefined, reportedUsed?: number): number | undefined {
	const input = message?.tokensIn ?? 0;
	const output = message?.tokensOut ?? 0;
	const cache = message?.tokensCache ?? 0;
	const turn = input + output + cache;
	const preferred = (message?.tokensUsed && message.tokensUsed > 0)
		? message.tokensUsed
		: (reportedUsed && reportedUsed > 0 ? reportedUsed : undefined);
	if (preferred !== undefined) {
		// `used` sometimes drops cache (input+output only) or drops the completion
		// (Anthropic reports used as input + cache). The turn total is the occupancy then.
		// Only when `used` matches one of those sums: Claude's end-of-turn totals add up the
		// cache reads of every model call in the turn (117K read for a 27K context), which
		// would fill the meter with tokens that were never in the window at once.
		const dropsCache = cache > 0 && nearlyEqual(preferred, input + output);
		const dropsOutput = output > 0 && nearlyEqual(preferred, input + cache);
		if (turn > preferred && (dropsCache || dropsOutput)) {
			return turn;
		}
		return preferred;
	}
	return turn > 0 ? turn : undefined;
}

/** Within a rounding difference: providers count the same prompt a few tokens apart. */
function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= Math.max(64, b * 0.01);
}

/**
 * What sits in front of the conversation (system prompt, tool definitions): the chat's first
 * prompt-side figure less its first message, else the local estimate from rules, skills and tools.
 */
export function promptBaseTokens(messages: readonly IContextUsageMessage[], estimate: number): number {
	const index = messages.findIndex(message => message.kind === 'agent');
	const base = index >= 0 ? messages[index].tokensBase : undefined;
	if (!base) {
		return estimate;
	}
	const prompt = messages.slice(0, index).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	return Math.max(0, base - prompt);
}

export function buildContextUsageSnapshot(input: IContextUsageInput): IContextUsageSnapshot {
	const last = lastUsageMessage(input.messages);
	const measured = occupancyFromUsage(last, input.reportedUsed);
	// Right after compacting Claude counts only the kept summary; the system prompt and tools still come first.
	const promptBase = last?.usageExcludesPrompt && measured !== undefined
		? promptBaseTokens(input.messages, overheadSum(input.overhead ?? defaultOverhead(input.nativeAgent)))
		: 0;
	const reportedUsed = measured !== undefined ? measured + promptBase : undefined;
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
		// Usage events often land at the start or end of a turn. Text that arrived
		// after that snapshot still has to move the meter while the reply streams.
		const tail = unreportedTailTokens(input.messages);
		const settledConversation = Math.max(0, conversation - Math.min(tail, conversation));
		used = reportedUsed + draft + tail;
		estimated = tail > 0 || promptBase > 0;
		const remaining = Math.max(0, reportedUsed - overheadTotal);
		const conversationLabel = localize('voltAgent.contextConversation', "Conversation");
		if (settledConversation > remaining) {
			// Compacted: allocate only what still sits in the live occupancy.
			// Do not paint overflow estimates into the bar. Those tokens are gone.
			compacted = true;
			allocateCompactedConversation(push, remaining, settledConversation);
			addCategoryTokens(items, 'conversation', conversationLabel, tail);
		} else {
			push('conversation', conversationLabel, settledConversation + tail);
			const leftover = remaining - settledConversation;
			push('unaccounted', localize('voltAgent.contextOverhead', "Prompt & tools"), leftover);
		}
	} else if (last && ((last.tokensIn ?? 0) > 0 || (last.tokensCache ?? 0) > 0)) {
		const prompt = (last.tokensIn ?? 0) + (last.tokensCache ?? 0);
		const output = last.tokensOut ?? 0;
		used = prompt + output + draft;
		estimated = false;
		const budget = Math.max(0, prompt - overheadTotal);
		const visible = Math.min(conversation, budget);
		push('conversation', localize('voltAgent.contextConversation', "Conversation"), visible);
		push('unaccounted', localize('voltAgent.contextOverhead', "Prompt & tools"), Math.max(0, budget - visible));
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

function messageHasUsage(message: IContextUsageMessage): boolean {
	return message.kind === 'agent' && !!(message.tokensUsed || message.tokensWindow || message.tokensIn || message.tokensOut || message.tokensCache);
}

/**
 * Tokens written after the latest usage snapshot. A streaming reply whose
 * provider occupancy is prompt-only (input + cache, no output yet) counts too.
 * An ACP `used` value with no input/output split already includes generated text.
 */
function unreportedTailTokens(messages: readonly IContextUsageMessage[]): number {
	let lastUsage = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messageHasUsage(messages[i])) {
			lastUsage = i;
			break;
		}
	}
	let extra = 0;
	for (let i = lastUsage + 1; i < messages.length; i++) {
		extra += estimateMessageTokens(messages[i]);
	}
	if (lastUsage >= 0 && messages[lastUsage].activity?.streaming) {
		extra += uncountedStreamingOutput(messages[lastUsage]);
	}
	return extra;
}

function uncountedStreamingOutput(message: IContextUsageMessage): number {
	const estimated = estimateMessageTokens(message);
	const reportedOut = message.tokensOut ?? 0;
	const inputSide = (message.tokensIn ?? 0) + (message.tokensCache ?? 0);
	const used = message.tokensUsed ?? 0;
	// Completion already sits inside `used` (or will be added by occupancyFromUsage
	// once tokensOut is set). Only the estimate past that completion is new.
	if (reportedOut > 0) {
		return Math.max(0, estimated - reportedOut);
	}
	if (used > inputSide) {
		return 0;
	}
	return estimated;
}

function addCategoryTokens(items: IContextUsageCategory[], id: ContextCategoryId, label: string, tokens: number): void {
	if (tokens <= 0) {
		return;
	}
	const existing = items.find(item => item.id === id);
	if (existing) {
		(existing as { tokens: number }).tokens += tokens;
		return;
	}
	items.push({ id, label, tokens, color: CONTEXT_CATEGORY_COLORS[id] });
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
	const keys = ['system', 'tools', 'rules', 'skills', 'mcp', 'subagents'] as const;
	const scaledValues = keys.map(key => Math.round(overhead[key] * scale));
	let allocated = scaledValues.reduce((sum, value) => sum + value, 0);
	// Rounding can overshoot the live occupancy; shave from the largest buckets.
	while (allocated > reportedUsed) {
		let largest = 0;
		for (let i = 1; i < scaledValues.length; i++) {
			if (scaledValues[i] > scaledValues[largest]) {
				largest = i;
			}
		}
		if (scaledValues[largest] <= 0) {
			break;
		}
		scaledValues[largest] -= 1;
		allocated -= 1;
	}
	return {
		system: scaledValues[0],
		tools: scaledValues[1],
		rules: scaledValues[2],
		skills: scaledValues[3],
		mcp: scaledValues[4],
		subagents: scaledValues[5],
		ruleCount: overhead.ruleCount,
		skillCount: overhead.skillCount,
		mcpCount: overhead.mcpCount,
		subagentCount: overhead.subagentCount,
	};
}

/**
 * Split the remaining live occupancy between summarized + recent conversation
 * so both rows are shares of the same header total (never overflow estimates).
 */
function allocateCompactedConversation(
	push: (id: ContextCategoryId, label: string, tokens: number, detail?: string) => void,
	remaining: number,
	conversationEstimate: number,
): void {
	if (remaining <= 0) {
		return;
	}
	const overflow = Math.max(0, conversationEstimate - remaining);
	const rawTotal = overflow + remaining;
	const summarized = rawTotal > 0 ? Math.round(remaining * (overflow / rawTotal)) : 0;
	const visible = remaining - summarized;
	push('summarized', localize('voltAgent.contextSummarized', "Summarized conversation"), summarized);
	push('conversation', localize('voltAgent.contextConversation', "Conversation"), visible);
}

function countDetail(count: number, one: string, many: string): string | undefined {
	if (count <= 0) {
		return undefined;
	}
	return `${count} ${count === 1 ? one : many}`;
}
