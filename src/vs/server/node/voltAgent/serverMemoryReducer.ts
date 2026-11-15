/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IVoltEventEnvelope } from '../../../workbench/services/voltRuntime/common/events.js';

/** The server is quiet this long after its last run ended (or after it started) before the heap is collected. */
export const IDLE_GC_DELAY_MS = 10_000;

/**
 * Gives the heap's garbage back once the server goes quiet. A Node process gets no idle-time GC, so the young
 * generation and the garbage a burst of turns leaves (streamed JSON, transcripts, tool results) stay committed:
 * 30 s after 15 seeded chats the server held 168 MB of heap for 83 MB of live objects, its footprint 30 MB above
 * rest, and one full collection gave all of it back (ADEMark A10, round 7). One collection 10 s after the last
 * run ends, and one after startup; nothing runs on a timer at rest. `gc` is the server's `--expose-gc` global;
 * without it this does nothing.
 */
export class ServerMemoryReducer extends Disposable {

	private readonly running = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		onDidEmit: Event<IVoltEventEnvelope>,
		private readonly gc: (() => unknown) | undefined = (globalThis as { gc?: () => unknown }).gc,
		private readonly delayMs = IDLE_GC_DELAY_MS,
	) {
		super();
		if (!this.gc) {
			return;
		}
		this._register(onDidEmit(({ event }) => {
			if (event.type === 'run.start') {
				this.running.add(event.runId);
				this.cancel();
			} else if (event.type === 'run.end') {
				this.running.delete(event.runId);
				if (!this.running.size) {
					this.schedule();
				}
			}
		}));
		this._register(toDisposable(() => this.cancel()));
		this.schedule();
	}

	private schedule(): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.running.size) {
				this.gc!();
			}
		}, this.delayMs);
	}

	private cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
