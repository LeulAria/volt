/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { INativeLoopMessage } from './nativeLoop.js';
import { IRunProjection, IStoredEnvelope, reduceRun } from './eventStore.js';

/**
 * Deterministic replay. Given the same durable log, every subscriber reconstructs the same
 * projection *and* the same model-visible transcript. Live deltas are not in the log, so
 * replay never flickers: it is the ended text, the tool calls, and the file changes.
 */

export interface IReplayResult {
	readonly projection: IRunProjection;
	readonly messages: readonly INativeLoopMessage[];
}

export function replay(log: readonly IStoredEnvelope[]): IReplayResult | undefined {
	if (!log.length) {
		return undefined;
	}
	return {
		projection: reduceRun(log),
		messages: deriveMessages(log),
	};
}

/**
 * Rebuild what the model saw. System/user text comes from the first user-facing events;
 * assistant text comes from `text.end`; tool calls and results pair by `callId`.
 */
export function deriveMessages(log: readonly IStoredEnvelope[]): INativeLoopMessage[] {
	const messages: INativeLoopMessage[] = [];
	let assistant = '';
	const pending = new Map<string, { name: string; input: string }>();

	const flushAssistant = () => {
		if (assistant.trim()) {
			messages.push({ role: 'assistant', content: assistant });
			assistant = '';
		}
	};

	for (const item of log) {
		applyEvent(item.event, messages, pending, text => { assistant += text; }, flushAssistant);
	}
	flushAssistant();
	return messages;
}

function applyEvent(
	event: IVoltEvent,
	messages: INativeLoopMessage[],
	pending: Map<string, { name: string; input: string }>,
	appendAssistant: (text: string) => void,
	flushAssistant: () => void,
): void {
	switch (event.type) {
		case 'text.end':
			if (event.delta) {
				appendAssistant(event.delta);
			}
			break;
		case 'text.delta':
			if (event.delta) {
				appendAssistant(event.delta);
			}
			break;
		case 'tool.start':
			pending.set(event.callId, { name: event.name, input: event.input ?? '' });
			break;
		case 'tool.end': {
			const start = pending.get(event.callId);
			flushAssistant();
			if (start) {
				messages.push({
					role: 'assistant',
					content: '',
					toolCalls: [{ id: event.callId, name: start.name, args: parseArgs(start.input) }],
				});
			}
			messages.push({
				role: 'tool',
				content: typeof event.result === 'string' ? event.result : event.error ?? '',
				callId: event.callId,
				name: start?.name ?? event.callId,
			});
			pending.delete(event.callId);
			break;
		}
		case 'clarify':
			messages.push({ role: 'assistant', content: event.question });
			break;
		default:
			break;
	}
}

function parseArgs(input: string): unknown {
	if (!input) {
		return {};
	}
	try {
		return JSON.parse(input);
	} catch {
		return { raw: input };
	}
}
