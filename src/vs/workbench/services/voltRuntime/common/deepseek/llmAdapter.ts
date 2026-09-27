/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { ContentBlock, StreamChunk, TokenUsage } from './protocol.js';

/**
 * Translates a Volt provider stream into DeepSeek `StreamChunk`s.
 *
 * - Text and tool-argument deltas pass through immediately.
 * - A block closes as soon as the provider says so (`text.end`, `reasoning.block`,
 *   `tool.input.end`), so a finished tool call can be dispatched while the model keeps writing.
 * - Usage is merged field by field: providers split input and output across events.
 * - `finish` is held so usage comes first, and anything after `finish` other than usage is dropped.
 * - Retries, refusals, and notices pass through as `event` chunks.
 */
export async function* adaptModelStream(events: AsyncIterable<IVoltEvent>): AsyncGenerator<StreamChunk> {
	let next = 0;
	let text: { index: number; text: string } | undefined;
	let reasoning: { index: number; text: string } | undefined;
	const tools = new Map<string, { index: number; name: string; args: string; ended: boolean }>();
	let usage: TokenUsage | undefined;
	let finish: Extract<StreamChunk, { type: 'finish' }> | undefined;

	const endText = function* (): Generator<StreamChunk> {
		if (!text) {
			return;
		}
		const block: ContentBlock = { type: 'text', text: text.text };
		yield { type: 'block-end', index: text.index, block };
		text = undefined;
	};
	const endReasoning = function* (replay?: { provider: string; model: string; text: string; opaque?: unknown }): Generator<StreamChunk> {
		if (!reasoning && !replay) {
			return;
		}
		const index = reasoning?.index ?? next++;
		const block: ContentBlock = replay
			? { type: 'reasoning', text: replay.text || reasoning?.text || '', provider: replay.provider, model: replay.model, ...(replay.opaque !== undefined ? { opaque: replay.opaque } : {}) }
			: { type: 'reasoning', text: reasoning!.text };
		if (!reasoning) {
			yield { type: 'block-start', index, blockType: 'reasoning' };
		}
		yield { type: 'block-end', index, block };
		reasoning = undefined;
	};
	const endTool = function* (callId: string): Generator<StreamChunk> {
		const tool = tools.get(callId);
		if (!tool || tool.ended) {
			return;
		}
		tool.ended = true;
		yield { type: 'block-end', index: tool.index, block: { type: 'tool-call', id: callId, name: tool.name, arguments: tool.args } };
	};

	for await (const event of events) {
		if (event.type === 'finish') {
			finish = { type: 'finish', reason: event.reason === 'abort' ? 'aborted' : event.reason };
			continue;
		}
		if (event.type === 'usage') {
			usage = mergeUsage(usage, event);
			continue;
		}
		if (finish) {
			continue;
		}
		switch (event.type) {
			case 'text.delta':
				if (!event.delta) {
					break;
				}
				yield* endReasoning();
				if (!text) {
					text = { index: next++, text: '' };
					yield { type: 'block-start', index: text.index, blockType: 'text' };
				}
				text.text += event.delta;
				yield { type: 'text-delta', index: text.index, text: event.delta };
				break;
			case 'text.end':
				yield* endText();
				break;
			case 'reasoning.delta':
				if (!event.delta) {
					break;
				}
				yield* endText();
				if (!reasoning) {
					reasoning = { index: next++, text: '' };
					yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' };
				}
				reasoning.text += event.delta;
				yield { type: 'reasoning-delta', index: reasoning.index, text: event.delta };
				break;
			case 'reasoning.block':
				yield* endText();
				yield* endReasoning({ provider: event.provider, model: event.model, text: event.text, opaque: event.opaque });
				break;
			case 'tool.start': {
				yield* endText();
				yield* endReasoning();
				const index = next++;
				tools.set(event.callId, { index, name: event.name, args: event.input ?? '', ended: false });
				yield { type: 'block-start', index, blockType: 'tool-call' };
				yield { type: 'tool-call-delta', index, id: event.callId, name: event.name, argumentsDelta: event.input ?? '' };
				break;
			}
			case 'tool.input.delta': {
				const tool = tools.get(event.callId);
				if (!tool || tool.ended) {
					break;
				}
				tool.args += event.delta;
				yield { type: 'tool-call-delta', index: tool.index, id: event.callId, argumentsDelta: event.delta };
				break;
			}
			case 'tool.input.end':
				yield* endTool(event.callId);
				break;
			case 'retry':
			case 'error':
			case 'notice':
				yield { type: 'event', event };
				break;
		}
	}

	yield* endText();
	yield* endReasoning();
	for (const id of tools.keys()) {
		yield* endTool(id);
	}
	if (usage) {
		yield { type: 'usage', usage };
	}
	yield finish ?? { type: 'finish', reason: tools.size ? 'tool_calls' : 'stop' };
}

/** Keeps the largest value seen per field; providers report cumulative counts. */
export function mergeUsage(current: TokenUsage | undefined, event: Extract<IVoltEvent, { type: 'usage' }>): TokenUsage {
	const pick = (value: number | undefined, previous: number | undefined) => value !== undefined && Number.isFinite(value)
		? Math.max(value, previous ?? 0)
		: previous;
	const input = pick(event.input, current?.input) ?? 0;
	const output = pick(event.output, current?.output) ?? 0;
	const cache = pick(event.cache, current?.cache);
	const cacheWrite = pick(event.cacheWrite, current?.cacheWrite);
	const used = pick(event.used, current?.used);
	return {
		input,
		output,
		...(cache !== undefined ? { cache } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
		...(used !== undefined ? { used } : {}),
	};
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
