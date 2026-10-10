/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeThinkingParams, IClaudeModelMeta } from '../models/claudeModels.js';
import { IModelMessage } from '../providers.js';
import { IToolSchema } from '../tools/tool.js';
import { IAnthropicMessage, toAnthropicMessages, toAnthropicTools } from './providerMessages.js';

/**
 * The Messages API body for one turn. The prefix is laid out for the prompt cache:
 *
 *   tools (fixed order) → system (breakpoint) → messages (append-only; breakpoints on the last
 *   block and on the turn before it, so a request that appends many blocks still finds the
 *   previous entry inside the 20-block lookback).
 *
 * Nothing volatile lives in the prefix; per-turn notes arrive as new messages at the tail.
 */

export interface IAnthropicRequestInput {
	readonly modelId: string;
	readonly meta: IClaudeModelMeta;
	readonly messages: readonly IModelMessage[];
	readonly tools?: readonly IToolSchema[];
	readonly maxTokens: number;
	/** Effort Volt chose or the user pinned; `auto` has already been resolved by the caller. */
	readonly effort?: string;
	/** api.anthropic.com. Proxies and gateways may reject newer fields, so those stay off elsewhere. */
	readonly firstParty: boolean;
	/** Sampling pins from Settings. Sent only while extended thinking is off (the API fixes them then). */
	readonly temperature?: number;
	readonly topP?: number;
}

export interface IAnthropicRequest {
	readonly body: Record<string, unknown>;
	readonly betas: readonly string[];
}

const EPHEMERAL = { type: 'ephemeral' } as const;

export function buildAnthropicRequest(input: IAnthropicRequestInput): IAnthropicRequest {
	const systemText = input.messages.filter(message => message.role === 'system').map(message => message.content).filter(Boolean);
	const system = systemText.map((text, index) => ({
		type: 'text',
		text,
		...(index === systemText.length - 1 ? { cache_control: EPHEMERAL } : {}),
	}));
	const messages = markCacheBreakpoints(toAnthropicMessages(input.messages, { model: input.modelId }));
	const betas: string[] = [];
	const thinking = claudeThinkingParams(input.meta, input.effort, input.maxTokens);
	const body: Record<string, unknown> = {
		model: input.modelId,
		max_tokens: input.maxTokens,
		stream: true,
		...(system.length ? { system } : {}),
		messages,
		...(input.tools?.length ? { tools: toAnthropicTools(input.tools, { eagerInputStreaming: input.firstParty }) } : {}),
		...thinking,
		...samplingParams(input, thinking),
	};
	if (input.firstParty && input.tools?.length) {
		// Old tool results are cleared server-side once the prompt grows. That is not a history
		// edit, so cached prefixes and replayed thinking stay valid.
		body.context_management = { edits: [{ type: 'clear_tool_uses_20250919' }] };
		betas.push('context-management-2025-06-27');
	}
	return { body, betas };
}

/**
 * Temperature or top_p, never both: newer Claude models reject the pair. Claude takes a temperature
 * up to 1. With thinking on the API allows neither to move, so the pins wait until it is off.
 */
function samplingParams(input: IAnthropicRequestInput, thinking: Record<string, unknown>): Record<string, unknown> {
	const mode = (thinking.thinking as { type?: string } | undefined)?.type;
	if (mode && mode !== 'disabled') {
		return {};
	}
	if (input.temperature !== undefined) {
		return { temperature: Math.min(1, input.temperature) };
	}
	return input.topP !== undefined ? { top_p: input.topP } : {};
}

/** Breakpoints on the last block of the last message and of the message two turns back. */
export function markCacheBreakpoints(messages: IAnthropicMessage[]): IAnthropicMessage[] {
	const targets = new Set<number>();
	if (messages.length) {
		targets.add(messages.length - 1);
	}
	if (messages.length > 2) {
		targets.add(messages.length - 3);
	}
	return messages.map((message, index) => targets.has(index) ? withBreakpoint(message) : message);
}

function withBreakpoint(message: IAnthropicMessage): IAnthropicMessage {
	const content = typeof message.content === 'string'
		? [{ type: 'text', text: message.content }]
		: [...message.content];
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i] as { type?: string; text?: string };
		// Thinking blocks cannot carry a marker, and empty text is rejected outright.
		if (block.type === 'thinking' || block.type === 'redacted_thinking' || (block.type === 'text' && !block.text)) {
			continue;
		}
		content[i] = { ...block, cache_control: EPHEMERAL };
		return { role: message.role, content };
	}
	return message;
}
