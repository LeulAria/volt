/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { stringifyToolArgs } from './providerMessages.js';
import { NativeFinishReason } from './nativeLoop.js';

let streamSeq = 0;

export interface IGeminiPart {
	text?: string;
	thought?: boolean | string;
	thoughtSignature?: string;
	functionCall?: { name?: string; args?: unknown };
}

/**
 * Gemini `streamGenerateContent` parts: text, thought, functionCall. Finish is often `STOP`
 * even when the model called a function, so presence of functionCall wins.
 *
 * A function call arrives whole, so its input ends at once. Call ids are unique across turns
 * (Gemini has none of its own), and a part's `thoughtSignature` is kept as a reasoning block so
 * the next request can hand it back to the same model.
 */
export class GeminiToolAssembler {
	private readonly calls = new Map<string, true>();
	private finished: NativeFinishReason | undefined;
	private seq = 0;
	private readonly prefix = `gemini_${(++streamSeq).toString(36)}${Date.now().toString(36)}`;

	constructor(private readonly model = '') { }

	apply(parts: IGeminiPart[] | undefined, finishReason?: string): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		for (const part of parts ?? []) {
			if (part.functionCall?.name) {
				this.seq++;
				const id = `${this.prefix}_${this.seq}`;
				this.calls.set(id, true);
				events.push({
					type: 'tool.start',
					callId: id,
					name: part.functionCall.name,
					input: stringifyToolArgs(part.functionCall.args),
					kind: 'other',
				});
				if (part.thoughtSignature) {
					events.push({ type: 'reasoning.block', provider: 'gemini', model: this.model, text: '', opaque: { callId: id, thoughtSignature: part.thoughtSignature } });
				}
				events.push({ type: 'tool.input.end', callId: id });
			}
		}
		if (finishReason) {
			this.finished = mapFinish(finishReason, this.calls.size > 0);
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

function mapFinish(reason: string, hasTools: boolean): NativeFinishReason {
	switch (reason) {
		case 'MAX_TOKENS':
			return 'length';
		case 'SAFETY':
		case 'RECITATION':
		case 'BLOCKLIST':
		case 'PROHIBITED_CONTENT':
			return 'error';
		default:
			return hasTools ? 'tool_calls' : 'stop';
	}
}
