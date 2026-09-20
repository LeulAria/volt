/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { NativeFinishReason } from './nativeLoop.js';

interface IBufferedCall {
	id?: string;
	name?: string;
	args: string;
	started: boolean;
}

/**
 * Turns OpenAI-compatible `delta.tool_calls` + `finish_reason` into Volt tool events.
 * Arguments can arrive across many SSE chunks; the loop merges `tool.input.delta`.
 */
export class OpenAiToolAssembler {
	private readonly calls = new Map<number, IBufferedCall>();
	private finished: NativeFinishReason | undefined;

	apply(delta: {
		content?: string;
		reasoning_content?: string;
		tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
	} | undefined, finishReason?: string | null): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		if (!delta) {
			if (finishReason) {
				this.finished = mapFinish(finishReason);
			}
			return events;
		}
		for (const part of delta.tool_calls ?? []) {
			const index = part.index ?? 0;
			const call = this.calls.get(index) ?? { args: '', started: false };
			if (part.id) {
				call.id = part.id;
			}
			if (part.function?.name) {
				call.name = part.function.name;
			}
			if (part.function?.arguments) {
				call.args += part.function.arguments;
			}
			if (!call.started && call.id && call.name) {
				call.started = true;
				events.push({ type: 'tool.start', callId: call.id, name: call.name, input: call.args, kind: 'other' });
			} else if (call.started && part.function?.arguments) {
				events.push({ type: 'tool.input.delta', callId: call.id!, delta: part.function.arguments });
			}
			this.calls.set(index, call);
		}
		if (finishReason) {
			this.finished = mapFinish(finishReason);
		}
		return events;
	}

	finish(): { type: 'finish'; reason: NativeFinishReason } {
		if (this.finished) {
			return { type: 'finish', reason: this.finished };
		}
		return { type: 'finish', reason: this.calls.size ? 'tool_calls' : 'stop' };
	}
}

function mapFinish(reason: string): NativeFinishReason {
	switch (reason) {
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls';
		case 'length':
			return 'length';
		case 'content_filter':
			return 'error';
		default:
			return 'stop';
	}
}
