/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelAssistantPart, IModelMessage, IModelToolCall } from '../providers.js';
import { IToolSchema } from '../tools/tool.js';
import { INativeLoopMessage } from './nativeLoop.js';
import { IOpenAiReasoningReplay, IReasoningDetail } from './reasoningStream.js';

/**
 * One provider-neutral transcript, rendered for whichever model runs the next turn. Switching
 * models mid-conversation is safe because every provider-specific piece is decided here:
 *
 * - reasoning is replayed only to the provider and model that produced it;
 * - call ids are rewritten to what the target accepts, the same way on both sides of a pair;
 * - every tool call gets exactly one result, and orphaned results are dropped.
 */

const INTERRUPTED_RESULT = 'Tool call was interrupted before it returned a result.';

export function stringifyToolArgs(args: unknown): string {
	if (typeof args === 'string') {
		return args;
	}
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return '{}';
	}
}

export function parseToolArgs(raw: string | undefined): unknown {
	if (!raw) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		return { raw };
	}
}

export function nativeToModelMessages(messages: readonly INativeLoopMessage[]): IModelMessage[] {
	return repairToolPairs(messages.map(message => ({
		role: message.role,
		content: message.content,
		...(message.callId !== undefined ? { callId: message.callId } : {}),
		...(message.name !== undefined ? { name: message.name } : {}),
		...(message.toolCalls?.length ? {
			toolCalls: message.toolCalls.map(call => ({
				id: call.id,
				name: call.name,
				arguments: stringifyToolArgs(call.args),
			})),
		} : {}),
		...(message.parts?.length ? { parts: message.parts } : {}),
		...(message.isError ? { isError: true } : {}),
		...(message.images?.length ? { images: message.images } : {}),
	})));
}

/**
 * Every assistant tool call is answered by a tool message before the next user or assistant
 * turn, and no tool message answers a call that is not open. Cancellation, compaction, and a
 * model switch can each leave a transcript that breaks that rule; providers reject it.
 */
export function repairToolPairs(messages: readonly IModelMessage[]): IModelMessage[] {
	const out: IModelMessage[] = [];
	let open: IModelToolCall[] = [];
	const answered = new Set<string>();
	const closeOpen = () => {
		for (const call of open) {
			if (!answered.has(call.id)) {
				out.push({ role: 'tool', content: INTERRUPTED_RESULT, callId: call.id, name: call.name, isError: true });
			}
		}
		open = [];
		answered.clear();
	};
	for (const message of messages) {
		if (message.role === 'tool') {
			const call = open.find(candidate => candidate.id === message.callId);
			if (!call || answered.has(call.id)) {
				continue;
			}
			answered.add(call.id);
			out.push(message);
			continue;
		}
		closeOpen();
		out.push(message);
		if (message.role === 'assistant' && message.toolCalls?.length) {
			open = [...message.toolCalls];
		}
	}
	closeOpen();
	return out;
}

// --- call ids ------------------------------------------------------------------------------

export type CallIdStyle = 'anthropic' | 'openai';

/** Anthropic: `^[a-zA-Z0-9_-]{1,64}$`. OpenAI: at most 40 characters. Stable per input. */
export function sanitizeCallId(id: string, style: CallIdStyle): string {
	const max = style === 'anthropic' ? 64 : 40;
	let clean = style === 'anthropic' ? id.replace(/[^a-zA-Z0-9_-]/g, '_') : id;
	if (!clean) {
		clean = 'call';
	}
	if (clean.length <= max) {
		return clean;
	}
	const hash = shortHash(id);
	return `${clean.slice(0, max - hash.length - 1)}_${hash}`;
}

function shortHash(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

// --- OpenAI-compatible -----------------------------------------------------------------------

export interface IOpenAiMessageOptions {
	/** The model accepts image parts; tool images are sent as a follow-up user message. */
	readonly vision?: boolean;
	/**
	 * The provider and model this request goes to. Reasoning they produced is handed back on the
	 * assistant tool-call messages it preceded: DeepSeek and Kimi reject a thinking-mode tool call
	 * replayed without its `reasoning_content`, and OpenRouter keeps upstream reasoning alive
	 * through `reasoning_details`. Reasoning from any other model is left out.
	 */
	readonly reasoning?: { readonly provider: string; readonly model: string };
}

export function toOpenAiMessages(messages: readonly IModelMessage[], options: IOpenAiMessageOptions = {}): object[] {
	const out: object[] = [];
	const images: object[] = [];
	const flushImages = () => {
		if (images.length) {
			out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...images.splice(0)] });
		}
	};
	for (const message of messages) {
		if (message.role === 'tool') {
			out.push({
				role: 'tool',
				tool_call_id: sanitizeCallId(message.callId ?? '', 'openai'),
				content: message.content,
				...(message.name ? { name: message.name } : {}),
			});
			if (options.vision) {
				for (const image of message.images ?? []) {
					images.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
				}
			}
			continue;
		}
		flushImages();
		if (message.role === 'assistant' && message.toolCalls?.length) {
			out.push({
				role: 'assistant',
				content: message.content || null,
				...openAiReasoningReplay(message, options.reasoning),
				tool_calls: message.toolCalls.map(toOpenAiToolCall),
			});
			continue;
		}
		if (message.role === 'user' && options.vision && message.images?.length) {
			out.push({
				role: 'user',
				content: [
					{ type: 'text', text: message.content },
					...message.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
				],
			});
			continue;
		}
		out.push({ role: message.role, content: message.content });
	}
	flushImages();
	return out;
}

export function toOpenAiTools(tools: readonly IToolSchema[]): object[] {
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

/** The reasoning fields an assistant message gets back, joined across its reasoning blocks. */
function openAiReasoningReplay(message: IModelMessage, target: IOpenAiMessageOptions['reasoning']): IOpenAiReasoningReplay {
	if (!target) {
		return {};
	}
	let content: string | undefined;
	let text: string | undefined;
	const details: IReasoningDetail[] = [];
	for (const part of message.parts ?? []) {
		if (part.type !== 'reasoning' || part.block.provider !== target.provider || part.block.model !== target.model) {
			continue;
		}
		const opaque = part.block.opaque as IOpenAiReasoningReplay | undefined;
		if (typeof opaque?.reasoning_content === 'string') {
			content = (content ?? '') + opaque.reasoning_content;
		}
		if (typeof opaque?.reasoning === 'string') {
			text = (text ?? '') + opaque.reasoning;
		}
		if (Array.isArray(opaque?.reasoning_details)) {
			details.push(...opaque.reasoning_details as readonly IReasoningDetail[]);
		}
	}
	return {
		...(content !== undefined ? { reasoning_content: content } : {}),
		...(text !== undefined ? { reasoning: text } : {}),
		...(details.length ? { reasoning_details: details } : {}),
	};
}

function toOpenAiToolCall(call: IModelToolCall): object {
	return {
		id: sanitizeCallId(call.id, 'openai'),
		type: 'function',
		function: { name: call.name, arguments: call.arguments },
	};
}

// --- Anthropic -------------------------------------------------------------------------------

export function toAnthropicTools(tools: readonly IToolSchema[], options: { readonly eagerInputStreaming?: boolean } = {}): object[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
		...(options.eagerInputStreaming ? { eager_input_streaming: true } : {}),
	}));
}

export interface IAnthropicMessage {
	role: 'user' | 'assistant';
	content: string | object[];
}

export interface IAnthropicMessageOptions {
	/** The model this request goes to. Thinking blocks from any other model are left out. */
	readonly model?: string;
}

export function toAnthropicMessages(messages: readonly IModelMessage[], options: IAnthropicMessageOptions = {}): IAnthropicMessage[] {
	const out: IAnthropicMessage[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.role === 'tool') {
			const part = anthropicToolResult(message);
			const last = out.at(-1);
			if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(block => (block as { type?: string }).type === 'tool_result')) {
				last.content.push(part);
			} else {
				out.push({ role: 'user', content: [part] });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const blocks = anthropicAssistantBlocks(message, options.model);
			if (blocks.length) {
				out.push({ role: 'assistant', content: blocks });
			}
			continue;
		}
		if (message.images?.length) {
			out.push({
				role: 'user',
				content: [
					...(message.content.trim() ? [{ type: 'text', text: message.content }] : []),
					...message.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
				],
			});
		} else if (message.content.trim()) {
			out.push({ role: 'user', content: message.content });
		}
	}
	return out;
}

function anthropicToolResult(message: IModelMessage): object {
	const images = message.images ?? [];
	const content: object[] | string = images.length
		? [
			...(message.content ? [{ type: 'text', text: message.content }] : []),
			...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
		]
		: message.content || '(no output)';
	return {
		type: 'tool_result',
		tool_use_id: sanitizeCallId(message.callId ?? '', 'anthropic'),
		content,
		...(message.isError ? { is_error: true } : {}),
	};
}

function anthropicAssistantBlocks(message: IModelMessage, model: string | undefined): object[] {
	const calls = new Map((message.toolCalls ?? []).map(call => [call.id, call]));
	const toolUse = (call: IModelToolCall) => ({
		type: 'tool_use',
		id: sanitizeCallId(call.id, 'anthropic'),
		name: call.name,
		input: objectArgs(parseToolArgs(call.arguments)),
	});
	if (!message.parts?.length) {
		const blocks: object[] = [];
		if (message.content) {
			blocks.push({ type: 'text', text: message.content });
		}
		for (const call of calls.values()) {
			blocks.push(toolUse(call));
		}
		return blocks;
	}
	const blocks: object[] = [];
	const used = new Set<string>();
	for (const part of message.parts) {
		const block = anthropicPart(part, calls, model, toolUse);
		if (block) {
			blocks.push(block);
		}
		if (part.type === 'tool_call') {
			used.add(part.callId);
		}
	}
	for (const [id, call] of calls) {
		if (!used.has(id)) {
			blocks.push(toolUse(call));
		}
	}
	return blocks;
}

function anthropicPart(part: IModelAssistantPart, calls: ReadonlyMap<string, IModelToolCall>, model: string | undefined, toolUse: (call: IModelToolCall) => object): object | undefined {
	switch (part.type) {
		case 'text':
			return part.text ? { type: 'text', text: part.text } : undefined;
		case 'reasoning':
			return part.block.provider === 'anthropic' && part.block.model === model && part.block.opaque && typeof part.block.opaque === 'object'
				? part.block.opaque
				: undefined;
		case 'tool_call': {
			const call = calls.get(part.callId);
			return call ? toolUse(call) : undefined;
		}
	}
}

/** Anthropic `tool_use.input` must be an object. A parse failure is replayed as `{ raw }`. */
function objectArgs(value: unknown): object {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
}

// --- Gemini ----------------------------------------------------------------------------------

export function toGeminiTools(tools: readonly IToolSchema[]): object[] {
	return [{
		functionDeclarations: tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: stripAdditionalProperties(tool.parameters),
		})),
	}];
}

export interface IGeminiContent {
	role: 'user' | 'model';
	parts: object[];
}

export interface IGeminiMessageOptions {
	/** Thought signatures are replayed only to the model that produced them. */
	readonly model?: string;
}

export function toGeminiContents(messages: readonly IModelMessage[], options: IGeminiMessageOptions = {}): IGeminiContent[] {
	const out: IGeminiContent[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.role === 'tool') {
			const part = {
				functionResponse: {
					name: message.name ?? 'tool',
					response: message.isError ? { error: message.content } : { result: message.content },
				},
			};
			const last = out.at(-1);
			if (last?.role === 'user') {
				last.parts.push(part);
			} else {
				out.push({ role: 'user', parts: [part] });
			}
			for (const image of message.images ?? []) {
				out.at(-1)!.parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const parts: object[] = [];
			if (message.content) {
				parts.push({ text: message.content });
			}
			const signatures = geminiSignatures(message, options.model);
			for (const call of message.toolCalls ?? []) {
				const signature = signatures.get(call.id);
				parts.push({ functionCall: { name: call.name, args: parseToolArgs(call.arguments) }, ...(signature ? { thoughtSignature: signature } : {}) });
			}
			if (parts.length) {
				out.push({ role: 'model', parts });
			}
			continue;
		}
		const imageParts = (message.images ?? []).map(image => ({ inlineData: { mimeType: image.mediaType, data: image.data } }));
		if (message.content.trim() || imageParts.length) {
			out.push({ role: 'user', parts: [...(message.content.trim() ? [{ text: message.content }] : []), ...imageParts] });
		}
	}
	return out;
}

/** Gemini carries thought signatures on function-call parts; they arrive as reasoning blocks keyed by call id. */
function geminiSignatures(message: IModelMessage, model: string | undefined): Map<string, string> {
	const signatures = new Map<string, string>();
	for (const part of message.parts ?? []) {
		if (part.type !== 'reasoning' || part.block.provider !== 'gemini' || part.block.model !== model) {
			continue;
		}
		const opaque = part.block.opaque as { callId?: unknown; thoughtSignature?: unknown } | undefined;
		if (typeof opaque?.callId === 'string' && typeof opaque.thoughtSignature === 'string') {
			signatures.set(opaque.callId, opaque.thoughtSignature);
		}
	}
	return signatures;
}

function stripAdditionalProperties(schema: object): object {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return schema as object;
	}
	const record = schema as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === 'additionalProperties') {
			continue;
		}
		if (Array.isArray(value)) {
			next[key] = (value as unknown[]).map(item => item && typeof item === 'object' ? stripAdditionalProperties(item) : item);
			continue;
		}
		next[key] = value && typeof value === 'object' ? stripAdditionalProperties(value) : value;
	}
	return next;
}
