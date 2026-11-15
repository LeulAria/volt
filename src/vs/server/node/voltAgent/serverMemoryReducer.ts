/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IVoltEventEnvelope } from '../../../workbench/services/voltRuntime/common/events.js';

/** The server is quiet this long after its last run ended (or after it started) before the heap is collected. */
export const IDLE_GC_DELAY_MS = 10_000;
/** After a collection the server looks once more this much later: work that is no run (a window loading its chats) leaves garbage too. */
export const IDLE_GC_RECHECK_MS = 60_000;
/** That second look collects only when the process grew by this much since the collection. */
export const IDLE_GC_REGROWTH_BYTES = 24 * 1024 * 1024;

/**
 * The server's `--expose-gc` global as a "give everything back" collection, or undefined without it. A plain
 * `gc()` marks and sweeps but keeps what V8 holds for reuse: the young generation at the size a burst grew it
 * to, and the pages it pooled. 30 s after 15 seeded chats (dev build, round 8) the server's footprint was 233 MB
 * with a 97 MB heap; a plain `gc()` left it at 232, a `last-resort` one took it to 161 (62 ms on the quiet server).
 */
export function memoryReducingGc(globals: { gc?: (options?: object) => unknown } = globalThis as { gc?: (options?: object) => unknown }): (() => unknown) | undefined {
	const gc = globals.gc;
	return gc ? () => gc({ type: 'major', execution: 'sync', flavor: 'last-resort' }) : undefined;
}

/**
 * Gives the heap's garbage back once the server goes quiet. A Node process gets no idle-time GC, so the young
 * generation and the garbage a burst of turns leaves (streamed JSON, transcripts, tool results) stay committed:
 * 30 s after 15 seeded chats the server held 168 MB of heap for 83 MB of live objects, its footprint 30 MB above
 * rest (ADEMark A10, round 7). One collection 10 s after the last run ends, and one after startup; then one look
 * a minute later, which collects again only if the process grew meanwhile (a window that loaded its chats after
 * the startup collection). Nothing runs on a timer at rest. Without `--expose-gc` this does nothing.
 */
export class ServerMemoryReducer extends Disposable {

	private readonly running = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private recheck: ReturnType<typeof setTimeout> | undefined;

	constructor(
		onDidEmit: Event<IVoltEventEnvelope>,
		private readonly gc: (() => unknown) | undefined = memoryReducingGc(),
		private readonly delayMs = IDLE_GC_DELAY_MS,
		private readonly recheckMs = IDLE_GC_RECHECK_MS,
		private readonly rss: () => number = () => process.memoryUsage.rss(),
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
				this.collect();
			}
		}, this.delayMs);
	}

	private collect(): void {
		this.gc!();
		const after = this.rss();
		clearTimeout(this.recheck);
		this.recheck = setTimeout(() => {
			this.recheck = undefined;
			// During a run nothing is collected: its end schedules the next collection.
			if (!this.running.size && !this.timer && this.rss() - after > IDLE_GC_REGROWTH_BYTES) {
				this.collect();
			}
		}, this.recheckMs);
	}

	private cancel(): void {
		clearTimeout(this.timer);
		clearTimeout(this.recheck);
		this.timer = undefined;
		this.recheck = undefined;
	}
}
