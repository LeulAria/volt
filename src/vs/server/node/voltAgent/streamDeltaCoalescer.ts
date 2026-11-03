/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import type { IVoltEvent, IVoltEventEnvelope } from '../../../workbench/services/voltRuntime/common/events.js';

/** How long a chat's streamed deltas gather before they go out as one event. */
export const STREAM_DELTA_COALESCE_MS = 100;

/**
 * Joins a chat's back-to-back streaming deltas into one event before they go to clients. An agent
 * streams tens of small deltas a second; with a hundred chats at work that is thousands of events
 * a second for every window, each parsed and handed to every listener, while the transcript itself
 * comes in session patches. Joined deltas mean the same: text and reasoning append, appended tool
 * input appends, and a tool's live status keeps its latest line. Anything else for the chat sends
 * what it gathered first, so each chat's events keep their order.
 */
export class StreamDeltaCoalescer extends Disposable {

	/** One gathered delta per chat, in the order they started. */
	private readonly pending = new Map<string, IVoltEventEnvelope>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly emit: (envelope: IVoltEventEnvelope) => void,
		private readonly delayMs = STREAM_DELTA_COALESCE_MS,
	) {
		super();
		this._register({ dispose: () => this.flush() });
	}

	push(envelope: IVoltEventEnvelope): void {
		const sessionId = envelope.sessionId;
		const held = this.pending.get(sessionId);
		if (held) {
			const joined = joinDeltas(held, envelope);
			if (joined) {
				this.pending.set(sessionId, joined);
				return;
			}
			this.pending.delete(sessionId);
			this.emit(held);
		}
		if (joinable(envelope.event)) {
			this.pending.set(sessionId, envelope);
			this.timer ??= setTimeout(() => {
				this.timer = undefined;
				this.flush();
			}, this.delayMs);
			return;
		}
		this.emit(envelope);
	}

	/** Sends everything gathered now. */
	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const held = [...this.pending.values()];
		this.pending.clear();
		for (const envelope of held) {
			this.emit(envelope);
		}
	}
}

function joinable(event: IVoltEvent): boolean {
	return event.type === 'text.delta' || event.type === 'reasoning.delta' || event.type === 'tool.progress'
		|| (event.type === 'tool.input.delta' && event.append === true);
}

/** `next` folded into `held`, or undefined when they cannot be one event. */
export function joinDeltas(held: IVoltEventEnvelope, next: IVoltEventEnvelope): IVoltEventEnvelope | undefined {
	if (held.runId !== next.runId || held.provider || next.provider) {
		return undefined;
	}
	const a = held.event;
	const b = next.event;
	let event: IVoltEvent | undefined;
	if ((a.type === 'text.delta' && b.type === 'text.delta') || (a.type === 'reasoning.delta' && b.type === 'reasoning.delta')) {
		event = a.id === b.id ? { ...a, delta: (a.delta ?? '') + (b.delta ?? '') } : undefined;
	} else if (a.type === 'tool.input.delta' && b.type === 'tool.input.delta') {
		event = a.callId === b.callId && a.append === true && b.append === true ? { ...a, delta: a.delta + b.delta } : undefined;
	} else if (a.type === 'tool.progress' && b.type === 'tool.progress') {
		event = a.callId === b.callId ? b : undefined;
	}
	return event ? { ...next, event } : undefined;
}
