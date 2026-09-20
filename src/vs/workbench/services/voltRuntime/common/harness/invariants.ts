/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStoredEnvelope } from './eventStore.js';
import { INativeLoopMessage } from './nativeLoop.js';

/**
 * Runtime invariants. DeepSeek's law - "model-visible means logged" - is the
 * one that keeps resume, replay, and eval honest. If a tool result reached the
 * model and is missing from the durable log, the next turn is reconstructing
 * a conversation that never happened.
 */

export interface IInvariantFailure {
	readonly rule: 'model-visible-logged' | 'tool-call-paired' | 'surface-reconstructed';
	readonly detail: string;
}

export interface IInvariantReport {
	readonly ok: boolean;
	readonly failures: readonly IInvariantFailure[];
}

export function checkInvariants(messages: readonly INativeLoopMessage[], log: readonly IStoredEnvelope[]): IInvariantReport {
	const failures: IInvariantFailure[] = [];
	const loggedTools = new Set<string>();
	for (const item of log) {
		if (item.event.type === 'tool.end') {
			loggedTools.add(item.event.callId);
		}
	}

	for (const message of messages) {
		if (message.role !== 'tool') {
			continue;
		}
		const id = message.callId;
		if (!id) {
			failures.push({ rule: 'tool-call-paired', detail: `A tool message for ${message.name ?? 'unknown'} has no call id.` });
			continue;
		}
		if (!loggedTools.has(id)) {
			failures.push({ rule: 'model-visible-logged', detail: `Tool result ${id} reached the model but is missing from the durable log.` });
		}
	}

	failures.push(...checkTranscriptPairs(messages).failures);

	return { ok: failures.length === 0, failures };
}

/** Pairing only - safe to run on every step. Log membership is a separate, stricter check. */
export function checkTranscriptPairs(messages: readonly INativeLoopMessage[]): IInvariantReport {
	const failures: IInvariantFailure[] = [];
	const open = new Set<string>();
	for (const message of messages) {
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				open.add(call.id);
			}
		}
		if (message.role === 'tool' && message.callId) {
			open.delete(message.callId);
		}
	}
	for (const id of open) {
		failures.push({ rule: 'tool-call-paired', detail: `Assistant tool call ${id} has no following result.` });
	}
	return { ok: failures.length === 0, failures };
}
