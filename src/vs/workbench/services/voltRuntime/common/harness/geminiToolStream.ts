/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { stringifyToolArgs } from './providerMessages.js';
import { NativeFinishReason } from './nativeLoop.js';

/**
 * Gemini `streamGenerateContent` parts: text, thought, functionCall. Finish is often `STOP`
 * even when the model called a function, so presence of functionCall wins.
 */
export class GeminiToolAssembler {
	private readonly calls = new Map<string, true>();
	private finished: NativeFinishReason | undefined;
	private seq = 0;

	apply(parts: { text?: string; thought?: boolean | string; functionCall?: { name?: string; args?: unknown } }[] | undefined, finishReason?: string): IVoltEvent[] {
		const events: IVoltEvent[] = [];
		for (const part of parts ?? []) {
			if (part.functionCall?.name) {
				this.seq++;
				const id = `gemini-${this.seq}-${part.functionCall.name}`;
				this.calls.set(id, true);
				events.push({
					type: 'tool.start',
					callId: id,
					name: part.functionCall.name,
					input: stringifyToolArgs(part.functionCall.args),
					kind: 'other',
				});
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
