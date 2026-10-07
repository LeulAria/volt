/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';

/**
 * Provider reasoning ("thinking") outside Anthropic's own block format. Servers put it in
 * different fields of the same stream shape:
 *
 * - DeepSeek, Kimi, vLLM, LM Studio: `delta.reasoning_content`;
 * - OpenRouter: `delta.reasoning`, plus structured `delta.reasoning_details` that must be
 *   handed back verbatim for some upstream models to keep reasoning across tool calls;
 * - Ollama: `message.thinking`.
 *
 * Every one becomes `reasoning.start` / `reasoning.delta` / `reasoning.end` for the transcript's
 * Thought row, and a closing `reasoning.block` the loop stores and replays to the same model.
 */

/** One OpenRouter `reasoning_details` entry. Text arrives across chunks keyed by `index`. */
export interface IReasoningDetail {
	readonly type?: string;
	readonly index?: number;
	readonly text?: string;
	readonly summary?: string;
	readonly data?: string;
	readonly signature?: string;
	readonly [key: string]: unknown;
}

export interface IOpenAiReasoningFields {
	readonly reasoning_content?: unknown;
	readonly reasoning?: unknown;
	readonly reasoning_details?: unknown;
}

/**
 * What a stored reasoning block carries for replay over an OpenAI-shaped API: the assistant
 * message fields to send back, exactly as the server named them.
 */
export interface IOpenAiReasoningReplay {
	readonly reasoning_content?: string;
	readonly reasoning?: string;
	readonly reasoning_details?: readonly IReasoningDetail[];
}

/** The reasoning text in one OpenAI-shaped delta, from whichever field the server used. */
export function openAiReasoningText(delta: IOpenAiReasoningFields | undefined): string {
	if (!delta) {
		return '';
	}
	if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
		return delta.reasoning_content;
	}
	// OpenRouter repeats `reasoning` inside `reasoning_details`; the plain field wins.
	if (typeof delta.reasoning === 'string' && delta.reasoning) {
		return delta.reasoning;
	}
	let text = '';
	for (const detail of reasoningDetails(delta)) {
		if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
			text += detail.text;
		} else if (detail.type === 'reasoning.summary' && typeof detail.summary === 'string') {
			text += detail.summary;
		}
	}
	return text;
}

export function reasoningDetails(delta: IOpenAiReasoningFields | undefined): IReasoningDetail[] {
	const details = delta?.reasoning_details;
	return Array.isArray(details) ? details.filter((detail): detail is IReasoningDetail => !!detail && typeof detail === 'object') : [];
}

/**
 * Folds streamed detail fragments into whole entries: fragments with the same `index` (or, when
 * the server sends none, the same type in a row) concatenate their text and keep the last
 * signature or encrypted payload.
 */
export function mergeReasoningDetails(into: IReasoningDetail[], fragments: readonly IReasoningDetail[]): void {
	for (const fragment of fragments) {
		const at = typeof fragment.index === 'number'
			? into.findIndex(entry => entry.index === fragment.index)
			: (into.length && into[into.length - 1].type === fragment.type && fragment.type !== 'reasoning.encrypted' ? into.length - 1 : -1);
		if (at < 0) {
			into.push({ ...fragment });
			continue;
		}
		const entry = into[at];
		into[at] = {
			...entry,
			...fragment,
			...(typeof entry.text === 'string' || typeof fragment.text === 'string' ? { text: `${entry.text ?? ''}${fragment.text ?? ''}` } : {}),
			...(typeof entry.summary === 'string' || typeof fragment.summary === 'string' ? { summary: `${entry.summary ?? ''}${fragment.summary ?? ''}` } : {}),
		};
	}
}

/**
 * One stream's reasoning. Feed it deltas; close it before the reply text or a tool call starts
 * (the loop seals a reasoning block at the first non-reasoning event) and at the end.
 */
export class ProviderReasoning {

	private text = '';
	private readonly details: IReasoningDetail[] = [];
	private open = false;

	/**
	 * @param replay how the block is handed back: `reasoning_content` for servers that read that
	 * field, `details` for OpenRouter, or `none` when the provider never takes reasoning back.
	 */
	constructor(
		private readonly id: string,
		private readonly provider: string,
		private readonly model: string,
		private readonly replay: 'reasoning_content' | 'details' | 'none',
	) { }

	get isOpen(): boolean {
		return this.open;
	}

	delta(text: string, details: readonly IReasoningDetail[] = []): IVoltEvent[] {
		if (!text && !details.length) {
			return [];
		}
		const events: IVoltEvent[] = [];
		if (!this.open) {
			this.open = true;
			this.text = '';
			this.details.length = 0;
			events.push({ type: 'reasoning.start', id: this.id });
		}
		mergeReasoningDetails(this.details, details);
		if (text) {
			this.text += text;
			events.push({ type: 'reasoning.delta', id: this.id, delta: text });
		}
		return events;
	}

	close(): IVoltEvent[] {
		if (!this.open) {
			return [];
		}
		this.open = false;
		const events: IVoltEvent[] = [{ type: 'reasoning.end', id: this.id }];
		const opaque = this.opaque();
		if (opaque) {
			events.push({ type: 'reasoning.block', provider: this.provider, model: this.model, text: this.text, opaque });
		}
		return events;
	}

	private opaque(): IOpenAiReasoningReplay | undefined {
		switch (this.replay) {
			case 'reasoning_content':
				return this.text ? { reasoning_content: this.text } : undefined;
			case 'details':
				return this.details.length ? { reasoning_details: this.details.map(detail => ({ ...detail })) } : this.text ? { reasoning: this.text } : undefined;
			default:
				return undefined;
		}
	}
}
