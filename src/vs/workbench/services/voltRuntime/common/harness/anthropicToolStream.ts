/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { ProviderError } from '../providerError.js';
import { NativeFinishReason } from './nativeLoop.js';

/**
 * Anthropic Messages SSE → Volt events, one content block at a time:
 *
 * - text blocks open and close with the block, so replay keeps the model's block boundaries;
 * - thinking blocks keep their signature and come out as `reasoning.block` for verbatim replay;
 * - a tool call's arguments end at its `content_block_stop`, so read-only calls can start early;
 * - usage is merged across `message_start` (input and cache) and `message_delta` (output);
 * - an `error` event throws, and a `refusal` stop is surfaced instead of ending as a normal answer.
 */

export interface IAnthropicStreamJson {
	type?: string;
	index?: number;
	message?: { usage?: IAnthropicUsage; model?: string };
	content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; data?: string };
	delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
	usage?: IAnthropicUsage;
	error?: { type?: string; message?: string };
	stop_details?: { category?: string | null; explanation?: string | null } | null;
}

interface IAnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

type OpenBlock =
	| { kind: 'text'; id: string }
	| { kind: 'thinking'; id: string; text: string; signature: string }
	| { kind: 'redacted'; data: string }
	| { kind: 'tool'; callId: string }
	| { kind: 'other' };

export class AnthropicStreamParser {

	private readonly blocks = new Map<number, OpenBlock>();
	private readonly usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	private sawUsage = false;
	private stop: string | undefined;
	private refusal: string | undefined;
	private toolCalls = 0;

	constructor(private readonly model: string, private readonly idPrefix = `a${Date.now().toString(36)}`) { }

	apply(json: IAnthropicStreamJson): IVoltEvent[] {
		switch (json.type) {
			case 'message_start':
				this.mergeUsage(json.message?.usage);
				return this.sawUsage ? [this.usageEvent()] : [];
			case 'content_block_start':
				return this.start(json.index ?? 0, json.content_block);
			case 'content_block_delta':
				return this.delta(json.index ?? 0, json.delta);
			case 'content_block_stop':
				return this.end(json.index ?? 0);
			case 'message_delta':
				this.mergeUsage(json.usage);
				if (json.delta?.stop_reason) {
					this.stop = json.delta.stop_reason;
				}
				if (json.delta?.stop_reason === 'refusal') {
					const category = json.stop_details?.category;
					this.refusal = json.stop_details?.explanation || (category ? `The model declined this request (${category}).` : 'The model declined this request.');
				}
				return [];
			case 'error': {
				const type = json.error?.type;
				throw new ProviderError(`${type ?? 'error'}: ${json.error?.message ?? 'stream failed'}`, undefined, type);
			}
			default:
				return [];
		}
	}

	/** Usage, any refusal notice, and the finish reason. Call once after the stream ends. */
	finish(): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		for (const index of [...this.blocks.keys()]) {
			events.push(...this.end(index));
		}
		if (this.sawUsage) {
			events.push(this.usageEvent());
		}
		if (this.refusal) {
			events.push({ type: 'error', message: this.refusal, retryable: false });
		}
		events.push({ type: 'finish', reason: this.finishReason() });
		return events;
	}

	private finishReason(): NativeFinishReason {
		switch (this.stop) {
			case 'tool_use':
				return 'tool_calls';
			case 'max_tokens':
			case 'model_context_window_exceeded':
				return 'length';
			case 'refusal':
				return 'error';
			case undefined:
				return this.toolCalls ? 'tool_calls' : 'stop';
			default:
				return 'stop';
		}
	}

	private start(index: number, block: IAnthropicStreamJson['content_block']): IVoltEvent[] {
		switch (block?.type) {
			case 'text': {
				const id = `${this.idPrefix}-${index}`;
				this.blocks.set(index, { kind: 'text', id });
				const events: IVoltEvent[] = [{ type: 'text.start', id }];
				if (block.text) {
					events.push({ type: 'text.delta', id, delta: block.text });
				}
				return events;
			}
			case 'thinking': {
				const id = `${this.idPrefix}-${index}`;
				this.blocks.set(index, { kind: 'thinking', id, text: block.thinking ?? '', signature: block.signature ?? '' });
				return [{ type: 'reasoning.start', id }];
			}
			case 'redacted_thinking':
				this.blocks.set(index, { kind: 'redacted', data: block.data ?? '' });
				return [];
			case 'tool_use':
				if (!block.id || !block.name) {
					this.blocks.set(index, { kind: 'other' });
					return [];
				}
				this.toolCalls++;
				this.blocks.set(index, { kind: 'tool', callId: block.id });
				return [{ type: 'tool.start', callId: block.id, name: block.name, input: '', kind: 'other' }];
			default:
				this.blocks.set(index, { kind: 'other' });
				return [];
		}
	}

	private delta(index: number, delta: IAnthropicStreamJson['delta']): IVoltEvent[] {
		const block = this.blocks.get(index);
		if (!block || !delta) {
			return [];
		}
		if (block.kind === 'text' && delta.text) {
			return [{ type: 'text.delta', id: block.id, delta: delta.text }];
		}
		if (block.kind === 'thinking') {
			if (delta.thinking) {
				block.text += delta.thinking;
				return [{ type: 'reasoning.delta', id: block.id, delta: delta.thinking }];
			}
			if (delta.signature) {
				block.signature += delta.signature;
			}
			return [];
		}
		if (block.kind === 'tool' && delta.partial_json) {
			return [{ type: 'tool.input.delta', callId: block.callId, delta: delta.partial_json }];
		}
		return [];
	}

	private end(index: number): IVoltEvent[] {
		const block = this.blocks.get(index);
		this.blocks.delete(index);
		switch (block?.kind) {
			case 'text':
				return [{ type: 'text.end', id: block.id }];
			case 'thinking':
				return [
					{ type: 'reasoning.end', id: block.id },
					{ type: 'reasoning.block', provider: 'anthropic', model: this.model, text: block.text, opaque: { type: 'thinking', thinking: block.text, signature: block.signature } },
				];
			case 'redacted':
				return [{ type: 'reasoning.block', provider: 'anthropic', model: this.model, text: '', opaque: { type: 'redacted_thinking', data: block.data } }];
			case 'tool':
				return [{ type: 'tool.input.end', callId: block.callId }];
			default:
				return [];
		}
	}

	private mergeUsage(usage: IAnthropicUsage | undefined): void {
		if (!usage) {
			return;
		}
		const take = (value: number | undefined, current: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(current, value) : current;
		this.usage.input = take(usage.input_tokens, this.usage.input);
		this.usage.output = take(usage.output_tokens, this.usage.output);
		this.usage.cacheRead = take(usage.cache_read_input_tokens, this.usage.cacheRead);
		this.usage.cacheWrite = take(usage.cache_creation_input_tokens, this.usage.cacheWrite);
		this.sawUsage = true;
	}

	private usageEvent(): IVoltEvent {
		const { input, output, cacheRead, cacheWrite } = this.usage;
		return { type: 'usage', input, output, cache: cacheRead, cacheWrite, used: input + cacheRead + cacheWrite };
	}
}
