/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentServerTopic, IAgentServerEvent } from './protocol.js';

export interface IEventLogLimits {
	/** Events kept for replay. */
	readonly maxEvents: number;
	/** Serialized bytes kept for replay (approximate: UTF-16 length of the JSON). */
	readonly maxBytes: number;
}

export const DEFAULT_EVENT_LOG_LIMITS: IEventLogLimits = { maxEvents: 20_000, maxBytes: 64 * 1024 * 1024 };

interface IStoredEvent {
	readonly event: IAgentServerEvent;
	/** The frame as sent, so a replay doesn't serialize twice. */
	readonly text: string;
}

/** Whether a reconnecting client can catch up by replay, and from where. */
export type ResumeDecision =
	| { readonly kind: 'replay'; readonly events: readonly IStoredEvent[] }
	| { readonly kind: 'snapshot'; readonly reason: 'epoch' | 'ahead' | 'evicted' | 'none' };

/**
 * The server's ordered event stream for one boot (epoch). Every published event gets the next `seq`
 * (contiguous, starting at 1) and stays in a ring buffer bounded by count and size so a client that
 * dropped can replay what it missed. Durable state is not here: past the buffer, clients reload
 * snapshots.
 */
export class AgentServerEventLog {

	private readonly buffer: IStoredEvent[] = [];
	/** Index of the oldest live entry in `buffer` (entries before it are evicted and waiting for compaction). */
	private head = 0;
	private bytes = 0;
	private _seq = 0;

	constructor(
		readonly epoch: string,
		private readonly limits: IEventLogLimits = DEFAULT_EVENT_LOG_LIMITS,
	) { }

	/** The newest `seq` (0 before the first event). */
	get seq(): number {
		return this._seq;
	}

	/** The oldest `seq` still replayable, or `seq + 1` when the buffer is empty. */
	get oldestSeq(): number {
		return this.head < this.buffer.length ? this.buffer[this.head].event.seq : this._seq + 1;
	}

	get size(): number {
		return this.buffer.length - this.head;
	}

	append(topic: AgentServerTopic, data: unknown): IStoredEvent {
		const event: IAgentServerEvent = { t: 'evt', seq: ++this._seq, topic, data };
		const stored: IStoredEvent = { event, text: JSON.stringify(event) };
		this.buffer.push(stored);
		this.bytes += stored.text.length;
		this.evict();
		return stored;
	}

	/**
	 * Decides how a client that last applied `resume` catches up. Replays only when every event after
	 * its cursor is still buffered and the cursor belongs to this epoch.
	 */
	resume(resume: { readonly epoch: string; readonly seq: number } | undefined): ResumeDecision {
		if (!resume) {
			return { kind: 'snapshot', reason: 'none' };
		}
		if (resume.epoch !== this.epoch) {
			return { kind: 'snapshot', reason: 'epoch' };
		}
		if (resume.seq > this._seq || resume.seq < 0) {
			return { kind: 'snapshot', reason: 'ahead' };
		}
		if (resume.seq === this._seq) {
			return { kind: 'replay', events: [] };
		}
		if (resume.seq + 1 < this.oldestSeq) {
			return { kind: 'snapshot', reason: 'evicted' };
		}
		// Contiguous seqs: the event after the cursor sits at a fixed offset from the oldest.
		const start = this.head + (resume.seq + 1 - this.oldestSeq);
		return { kind: 'replay', events: this.buffer.slice(start) };
	}

	private evict(): void {
		while (this.size > 1 && (this.size > this.limits.maxEvents || this.bytes > this.limits.maxBytes)) {
			this.bytes -= this.buffer[this.head].text.length;
			this.head++;
		}
		// Compact once the dead prefix is large, so eviction stays O(1) amortized.
		if (this.head > 1024 && this.head * 2 > this.buffer.length) {
			this.buffer.splice(0, this.head);
			this.head = 0;
		}
	}
}
