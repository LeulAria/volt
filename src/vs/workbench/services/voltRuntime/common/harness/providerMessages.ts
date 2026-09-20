/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelMessage, IModelToolCall } from '../providers.js';
import { IToolSchema } from '../tools/tool.js';
import { INativeLoopMessage } from './nativeLoop.js';

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
	return messages.map(message => ({
		role: message.role,
		content: message.content,
		callId: message.callId,
		name: message.name,
		toolCalls: message.toolCalls?.map(call => ({
			id: call.id,
			name: call.name,
			arguments: stringifyToolArgs(call.args),
		})),
	}));
}

export function toOpenAiMessages(messages: readonly IModelMessage[]): object[] {
	return messages.map(message => {
		if (message.role === 'tool') {
			return {
				role: 'tool',
				tool_call_id: message.callId ?? '',
				content: message.content,
				...(message.name ? { name: message.name } : {}),
			};
		}
		if (message.role === 'assistant' && message.toolCalls?.length) {
			return {
				role: 'assistant',
				content: message.content || null,
				tool_calls: message.toolCalls.map(toOpenAiToolCall),
			};
		}
		return { role: message.role, content: message.content };
	});
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

export function toAnthropicTools(tools: readonly IToolSchema[]): object[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

export interface IAnthropicMessage {
	role: 'user' | 'assistant';
	content: string | object[];
}

export function toAnthropicMessages(messages: readonly IModelMessage[]): IAnthropicMessage[] {
	const out: IAnthropicMessage[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.role === 'tool') {
			const part = { type: 'tool_result', tool_use_id: message.callId ?? '', content: message.content };
			const last = out.at(-1);
			if (last?.role === 'user' && Array.isArray(last.content)) {
				last.content.push(part);
			} else {
				out.push({ role: 'user', content: [part] });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const parts: object[] = [];
			if (message.content) {
				parts.push({ type: 'text', text: message.content });
			}
			for (const call of message.toolCalls ?? []) {
				parts.push({
					type: 'tool_use',
					id: call.id,
					name: call.name,
					input: parseToolArgs(call.arguments),
				});
			}
			out.push({ role: 'assistant', content: parts.length ? parts : message.content });
			continue;
		}
		out.push({ role: 'user', content: message.content });
	}
	return out;
}

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

export function toGeminiContents(messages: readonly IModelMessage[]): IGeminiContent[] {
	const out: IGeminiContent[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			continue;
		}
		if (message.role === 'tool') {
			const part = {
				functionResponse: {
					name: message.name ?? 'tool',
					response: { result: message.content },
				},
			};
			const last = out.at(-1);
			if (last?.role === 'user') {
				last.parts.push(part);
			} else {
				out.push({ role: 'user', parts: [part] });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const parts: object[] = [];
			if (message.content) {
				parts.push({ text: message.content });
			}
			for (const call of message.toolCalls ?? []) {
				parts.push({ functionCall: { name: call.name, args: parseToolArgs(call.arguments) } });
			}
			out.push({ role: 'model', parts: parts.length ? parts : [{ text: message.content }] });
			continue;
		}
		out.push({ role: 'user', parts: [{ text: message.content }] });
	}
	return out;
}

function toOpenAiToolCall(call: IModelToolCall): object {
	return {
		id: call.id,
		type: 'function',
		function: { name: call.name, arguments: call.arguments },
	};
}

function stripAdditionalProperties(schema: object): object {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return schema;
	}
	const record = schema as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === 'additionalProperties') {
			continue;
		}
		next[key] = value && typeof value === 'object' && !Array.isArray(value) ? stripAdditionalProperties(value) : value;
	}
	return next;
}
