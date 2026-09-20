/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { NativeFinishReason } from './nativeLoop.js';

interface IBufferedCall {
	id: string;
	name: string;
	started: boolean;
}

/**
 * Anthropic Messages SSE: `content_block_start` (tool_use) + `input_json_delta` + `message_delta.stop_reason`.
 */
export class AnthropicToolAssembler {
	private readonly blocks = new Map<number, IBufferedCall>();
	private finished: NativeFinishReason | undefined;

	apply(event: {
		type?: string;
		index?: number;
		content_block?: { type?: string; id?: string; name?: string };
		delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
	}): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.id && event.content_block.name) {
			const index = event.index ?? 0;
			this.blocks.set(index, { id: event.content_block.id, name: event.content_block.name, started: true });
			events.push({ type: 'tool.start', callId: event.content_block.id, name: event.content_block.name, input: '', kind: 'other' });
		}
		if (event.type === 'content_block_delta' && event.delta?.partial_json) {
			const call = this.blocks.get(event.index ?? 0);
			if (call) {
				events.push({ type: 'tool.input.delta', callId: call.id, delta: event.delta.partial_json });
			}
		}
		const stop = event.delta?.stop_reason ?? (event.type === 'message_delta' ? event.delta?.stop_reason : undefined);
		if (stop) {
			this.finished = mapStop(stop);
		}
		return events;
	}

	finish(): { type: 'finish'; reason: NativeFinishReason } {
		if (this.finished) {
			return { type: 'finish', reason: this.finished };
		}
		return { type: 'finish', reason: this.blocks.size ? 'tool_calls' : 'stop' };
	}
}

function mapStop(reason: string): NativeFinishReason {
	switch (reason) {
		case 'tool_use':
			return 'tool_calls';
		case 'max_tokens':
			return 'length';
		default:
			return 'stop';
	}
}
