/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { ContentBlock, StreamChunk } from './protocol.js';

/**
 * Translates a Volt provider stream into DeepSeek `StreamChunk`s.
 * Text and tool-argument deltas pass through immediately. `finish` is held so `usage` is emitted
 * first, and anything after `finish` other than usage is dropped.
 */
export async function* adaptModelStream(events: AsyncIterable<IVoltEvent>): AsyncGenerator<StreamChunk> {
	let next = 0;
	let text: { index: number; text: string } | undefined;
	let reasoning: { index: number; text: string } | undefined;
	const tools = new Map<string, { index: number; name: string; args: string }>();
	let usage: Extract<StreamChunk, { type: 'usage' }> | undefined;
	let finish: Extract<StreamChunk, { type: 'finish' }> | undefined;

	const endText = function* (): Generator<StreamChunk> {
		if (!text) {
			return;
		}
		const block: ContentBlock = { type: 'text', text: text.text };
		yield { type: 'block-end', index: text.index, block };
		text = undefined;
	};
	const endReasoning = function* (): Generator<StreamChunk> {
		if (!reasoning) {
			return;
		}
		const block: ContentBlock = { type: 'reasoning', text: reasoning.text };
		yield { type: 'block-end', index: reasoning.index, block };
		reasoning = undefined;
	};

	for await (const event of events) {
		if (event.type === 'finish') {
			finish = { type: 'finish', reason: event.reason === 'abort' ? 'aborted' : event.reason };
			continue;
		}
		if (finish && event.type !== 'usage') {
			continue;
		}
		if (event.type === 'usage') {
			usage = {
				type: 'usage',
				usage: {
					input: event.input,
					output: event.output,
					...(event.cache !== undefined ? { cache: event.cache } : {}),
				},
			};
			continue;
		}
		if (event.type === 'text.delta' && event.delta) {
			yield* endReasoning();
			if (!text) {
				text = { index: next++, text: '' };
				yield { type: 'block-start', index: text.index, blockType: 'text' };
			}
			text.text += event.delta;
			yield { type: 'text-delta', index: text.index, text: event.delta };
			continue;
		}
		if (event.type === 'reasoning.delta' && event.delta) {
			yield* endText();
			if (!reasoning) {
				reasoning = { index: next++, text: '' };
				yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' };
			}
			reasoning.text += event.delta;
			yield { type: 'reasoning-delta', index: reasoning.index, text: event.delta };
			continue;
		}
		if (event.type === 'tool.start') {
			yield* endText();
			yield* endReasoning();
			const index = next++;
			tools.set(event.callId, { index, name: event.name, args: event.input ?? '' });
			yield { type: 'block-start', index, blockType: 'tool-call' };
			yield { type: 'tool-call-delta', index, id: event.callId, name: event.name, argumentsDelta: event.input ?? '' };
			continue;
		}
		if (event.type === 'tool.input.delta') {
			const tool = tools.get(event.callId);
			if (!tool) {
				continue;
			}
			tool.args += event.delta;
			yield { type: 'tool-call-delta', index: tool.index, id: event.callId, argumentsDelta: event.delta };
		}
	}

	yield* endText();
	yield* endReasoning();
	for (const [id, tool] of tools) {
		yield { type: 'block-end', index: tool.index, block: { type: 'tool-call', id, name: tool.name, arguments: tool.args } };
	}
	if (usage) {
		yield usage;
	}
	yield finish ?? { type: 'finish', reason: tools.size ? 'tool_calls' : 'stop' };
}

export function assertUsageBeforeFinish(chunks: readonly StreamChunk[]): void {
	const finishAt = chunks.findIndex(chunk => chunk.type === 'finish');
	if (finishAt < 0) {
		throw new Error('stream is missing finish');
	}
	if (chunks.slice(finishAt + 1).length) {
		throw new Error('chunks followed finish');
	}
	const usageAt = chunks.findIndex(chunk => chunk.type === 'usage');
	if (usageAt >= 0 && usageAt > finishAt) {
		throw new Error('usage followed finish');
	}
}
