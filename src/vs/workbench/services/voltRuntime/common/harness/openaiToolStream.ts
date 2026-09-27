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
	ended: boolean;
}

let streamSeq = 0;

/**
 * Turns OpenAI-compatible `delta.tool_calls` + `finish_reason` into Volt tool events.
 * Arguments can arrive across many SSE chunks; the loop merges `tool.input.delta`.
 *
 * A call's arguments are complete when the next call index starts or the stream finishes, and
 * `tool.input.end` says so, which lets read-only calls start before the stream is over. Servers
 * that omit call ids get stable synthesized ones instead of silently losing the call.
 */
export class OpenAiToolAssembler {
	private readonly calls = new Map<number, IBufferedCall>();
	private finished: NativeFinishReason | undefined;
	private readonly prefix = `call_v${(++streamSeq).toString(36)}${Date.now().toString(36)}`;

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
			for (const [other, open] of this.calls) {
				if (other < index && open.started && !open.ended) {
					open.ended = true;
					events.push({ type: 'tool.input.end', callId: open.id! });
				}
			}
			const call = this.calls.get(index) ?? { args: '', started: false, ended: false };
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

	/** Starts id-less calls under a synthesized id and closes every open call. Call before `finish`. */
	drain(): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		for (const [index, call] of this.calls) {
			if (!call.started && call.name) {
				call.id = call.id ?? `${this.prefix}_${index}`;
				call.started = true;
				events.push({ type: 'tool.start', callId: call.id, name: call.name, input: call.args, kind: 'other' });
			}
			if (call.started && !call.ended) {
				call.ended = true;
				events.push({ type: 'tool.input.end', callId: call.id! });
			}
		}
		return events;
	}

	finish(): { type: 'finish'; reason: NativeFinishReason } {
		if (this.finished && !(this.finished === 'stop' && this.hasCalls())) {
			return { type: 'finish', reason: this.finished };
		}
		return { type: 'finish', reason: this.hasCalls() ? 'tool_calls' : 'stop' };
	}

	private hasCalls(): boolean {
		return [...this.calls.values()].some(call => call.started);
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
