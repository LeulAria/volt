/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeLoopMessage } from './nativeLoop.js';

/**
 * Tool-pair repair (Roo `validateAndFixToolResultIds`). Streaming, cancel, and
 * delegation can leave an assistant `toolCalls` without matching `tool` results,
 * or orphan results whose ids no longer match. Providers then reject the next
 * request. This is a lossless fix: missing results become an explicit interrupt
 * error; orphan results are remapped by order onto unmatched calls.
 */

export interface ITranscriptRepair {
	readonly messages: INativeLoopMessage[];
	readonly changed: boolean;
	readonly missing: number;
	readonly remapped: number;
}

export function repairTranscript(messages: readonly INativeLoopMessage[]): ITranscriptRepair {
	const next = messages.map(message => ({ ...message, toolCalls: message.toolCalls?.slice() }));
	let missing = 0;
	let remapped = 0;

	for (let i = 0; i < next.length; i++) {
		const assistant = next[i];
		const calls = assistant.role === 'assistant' ? assistant.toolCalls ?? [] : [];
		if (!calls.length) {
			continue;
		}
		const results: INativeLoopMessage[] = [];
		let j = i + 1;
		while (j < next.length && next[j].role === 'tool') {
			results.push(next[j]);
			j++;
		}

		const used = new Set<string>();
		const byId = new Map(results.filter(item => item.callId).map(item => [item.callId!, item]));
		const unmatched = results.filter(item => !item.callId || !calls.some(call => call.id === item.callId));

		const fixed: INativeLoopMessage[] = [];
		for (const call of calls) {
			const hit = byId.get(call.id);
			if (hit && !used.has(call.id)) {
				used.add(call.id);
				fixed.push({ ...hit, callId: call.id, name: hit.name ?? call.name });
				continue;
			}
			const orphan = unmatched.find(item => !used.has(item.callId ?? item.content));
			if (orphan) {
				used.add(orphan.callId ?? orphan.content);
				fixed.push({ ...orphan, callId: call.id, name: orphan.name ?? call.name });
				remapped++;
				continue;
			}
			fixed.push({
				role: 'tool',
				content: 'Tool call was interrupted before a result was recorded.',
				callId: call.id,
				name: call.name,
			});
			missing++;
		}

		if (fixed.length !== results.length || fixed.some((item, index) => item.callId !== results[index]?.callId)) {
			next.splice(i + 1, results.length, ...fixed);
		}
	}

	const changed = missing > 0 || remapped > 0;
	return { messages: next, changed, missing, remapped };
}

/**
 * Roo condense: after a summary replaces condensed turns, drop `tool` results whose
 * `tool_use` id is no longer in the remaining assistant messages. Providers reject
 * those orphans on the next call.
 */
export function stripOrphanToolResults(messages: readonly INativeLoopMessage[]): INativeLoopMessage[] {
	const callIds = new Set<string>();
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			callIds.add(call.id);
		}
	}
	return messages.filter(message => {
		if (message.role !== 'tool') {
			return true;
		}
		return !message.callId || callIds.has(message.callId);
	});
}
