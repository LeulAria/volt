/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Endpoint } from './inspect.js';

/**
 * Reads token usage, tool calls and (when logging is on) the answer text from a provider reply,
 * streamed (server-sent events) or whole, without changing a byte of what the client receives.
 * Usage is normalized: `input` excludes cached input, which is `cacheRead`.
 */
type Json = Record<string, any>;

const MAX_LOGGED_TEXT = 256 * 1024;

export class UsageMeter {
	input = 0;
	output = 0;
	cacheRead = 0;
	cacheWrite = 0;
	toolCalls = 0;
	text = '';
	private readonly seenCalls = new Set<string>();
	private onDone: (() => void) | undefined;

	constructor(private readonly endpoint: Endpoint, private readonly keepText: boolean) { }

	private addText(delta: unknown): void {
		if (this.keepText && typeof delta === 'string' && this.text.length < MAX_LOGGED_TEXT) {
			this.text += delta.slice(0, MAX_LOGGED_TEXT - this.text.length);
		}
	}

	private openAiUsage(usage: Json | undefined, promptKey: string, completionKey: string, detailsKey: string): void {
		if (!usage) {
			return;
		}
		const prompt = Number(usage[promptKey] ?? 0);
		const cached = Number(usage[detailsKey]?.cached_tokens ?? 0);
		this.input = Math.max(0, prompt - cached);
		this.cacheRead = cached;
		this.output = Number(usage[completionKey] ?? 0);
	}

	private anthropicUsage(usage: Json | undefined): void {
		if (!usage) {
			return;
		}
		if (usage.input_tokens !== undefined) {
			this.input = Number(usage.input_tokens);
		}
		if (usage.cache_read_input_tokens !== undefined) {
			this.cacheRead = Number(usage.cache_read_input_tokens);
		}
		if (usage.cache_creation_input_tokens !== undefined) {
			this.cacheWrite = Number(usage.cache_creation_input_tokens);
		}
		if (usage.output_tokens !== undefined) {
			this.output = Number(usage.output_tokens);
		}
	}

	/** One server-sent event's JSON payload. */
	event(data: Json): void {
		switch (this.endpoint) {
			case 'messages':
				switch (data.type) {
					case 'message_start': this.anthropicUsage(data.message?.usage); break;
					case 'message_delta': this.anthropicUsage(data.usage); break;
					case 'content_block_start':
						if (/tool_use$/.test(String(data.content_block?.type ?? ''))) {
							this.toolCalls++;
						}
						break;
					case 'content_block_delta':
						if (data.delta?.type === 'text_delta') {
							this.addText(data.delta.text);
						}
						break;
				}
				return;
			case 'chat':
				for (const choice of data.choices ?? []) {
					this.addText(choice.delta?.content);
					for (const call of choice.delta?.tool_calls ?? []) {
						if (call.id && !this.seenCalls.has(call.id)) {
							this.seenCalls.add(call.id);
							this.toolCalls++;
						}
					}
				}
				this.openAiUsage(data.usage, 'prompt_tokens', 'completion_tokens', 'prompt_tokens_details');
				return;
			case 'responses':
				if (data.type === 'response.output_text.delta') {
					this.addText(data.delta);
				} else if (data.type === 'response.output_item.added' && /call$/.test(String(data.item?.type ?? ''))) {
					this.toolCalls++;
				} else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
					this.openAiUsage(data.response?.usage, 'input_tokens', 'output_tokens', 'input_tokens_details');
				}
				return;
		}
	}

	/** A whole (non-streamed) JSON reply. */
	whole(body: Json): void {
		switch (this.endpoint) {
			case 'messages':
				this.anthropicUsage(body.usage);
				for (const block of body.content ?? []) {
					if (/tool_use$/.test(String(block.type ?? ''))) {
						this.toolCalls++;
					} else if (block.type === 'text') {
						this.addText(block.text);
					}
				}
				return;
			case 'chat':
				for (const choice of body.choices ?? []) {
					this.addText(choice.message?.content);
					this.toolCalls += (choice.message?.tool_calls ?? []).length;
				}
				this.openAiUsage(body.usage, 'prompt_tokens', 'completion_tokens', 'prompt_tokens_details');
				return;
			case 'responses':
				for (const item of body.output ?? []) {
					if (/call$/.test(String(item.type ?? ''))) {
						this.toolCalls++;
					}
					for (const part of item.content ?? []) {
						if (part.type === 'output_text') {
							this.addText(part.text);
						}
					}
				}
				this.openAiUsage(body.usage, 'input_tokens', 'output_tokens', 'input_tokens_details');
				return;
		}
	}

	/**
	 * A pass-through transform: bytes go to the client untouched; a side decoder splits them into
	 * SSE lines and feeds each `data:` JSON to the meter. `onDone` runs once, when the stream ends
	 * (or when {@link finish} is called because the client went away).
	 */
	tap(onDone: () => void): TransformStream<Uint8Array, Uint8Array> {
		const decoder = new TextDecoder();
		let buffer = '';
		this.onDone = onDone;
		const line = (raw: string) => {
			if (!raw.startsWith('data:')) {
				return;
			}
			const payload = raw.slice(5).trim();
			if (!payload || payload === '[DONE]') {
				return;
			}
			try {
				this.event(JSON.parse(payload) as Json);
			} catch {
				// A non-JSON data line (a comment, a heartbeat): nothing to meter.
			}
		};
		return new TransformStream<Uint8Array, Uint8Array>({
			transform: (chunk, controller) => {
				controller.enqueue(chunk);
				buffer += decoder.decode(chunk, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					line(buffer.slice(0, newline).replace(/\r$/, ''));
					buffer = buffer.slice(newline + 1);
				}
			},
			flush: () => {
				buffer += decoder.decode();
				if (buffer) {
					line(buffer.replace(/\r$/, ''));
				}
				this.finish();
			},
		});
	}

	/** Records once: at the end of the stream, or when the client goes away mid-stream. */
	finish(): void {
		const done = this.onDone;
		this.onDone = undefined;
		done?.();
	}
}
