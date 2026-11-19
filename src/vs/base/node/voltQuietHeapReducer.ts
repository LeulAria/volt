/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as v8 from 'v8';
import * as vm from 'vm';

/** The first look, after the process started its work: startup's garbage is all there by then. */
export const QUIET_HEAP_FIRST_LOOK_MS = 20_000;
/** The look after a collection, and the shortest wait between looks. */
export const QUIET_HEAP_LOOK_MS = 60_000;
/** Looks that found nothing to do come this far apart at most (each doubles the wait). */
export const QUIET_HEAP_MAX_LOOK_MS = 10 * 60_000;
/** A busy process is looked at again this much later. */
export const QUIET_HEAP_BUSY_RETRY_MS = 30_000;
/** How long the processor time of the process is watched to call it quiet. */
export const QUIET_HEAP_PROBE_MS = 2_000;
/** Quiet = less than this share of one core over the probe. */
export const QUIET_HEAP_MAX_CPU = 0.05;
/** After the first collection, the heap must have grown this much since the last one to be collected again. */
export const QUIET_HEAP_REGROWTH_BYTES = 16 * 1024 * 1024;

type Gc = (options?: object) => unknown;

/**
 * A "give everything back" collection for this process, or undefined when V8's `gc` cannot be reached. A process
 * started with `--expose-gc` has it as a global; any other gets it from a fresh context while the flag is on for
 * that one statement, so nothing else in the process (an extension, a `vm` context made later) ever sees `gc`.
 *
 * `last-resort` is what makes V8 hand memory back: a plain collection sweeps but keeps the young generation at the
 * size a burst grew it to (three 16 MB semi-spaces in Electron 37) and the pages it pooled.
 */
export function memoryReducingGc(globals: { gc?: Gc } = globalThis as { gc?: Gc }): (() => void) | undefined {
	let gc = globals.gc;
	if (typeof gc !== 'function') {
		try {
			v8.setFlagsFromString('--expose-gc');
			gc = vm.runInNewContext('gc') as Gc;
		} catch {
			gc = undefined;
		} finally {
			try {
				v8.setFlagsFromString('--no-expose-gc');
			} catch {
				// the flag stays as it was
			}
		}
	}
	if (typeof gc !== 'function') {
		return undefined;
	}
	const collect = gc;
	return () => { collect({ type: 'major', execution: 'sync', flavor: 'last-resort' }); };
}

export interface IQuietHeapHost {
	/** Collects the heap and hands its memory back, or undefined when that is not possible here. */
	readonly gc: (() => void) | undefined;
	/** Bytes V8 has committed for the heap. */
	heapTotal(): number;
	/** Processor time this process has used so far, in microseconds. */
	cpuMicros(): number;
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

function nodeHost(): IQuietHeapHost {
	return {
		gc: memoryReducingGc(),
		heapTotal: () => process.memoryUsage().heapTotal,
		cpuMicros: () => { const usage = process.cpuUsage(); return usage.user + usage.system; },
		now: () => Date.now(),
		setTimeout: (callback, ms) => {
			const handle = setTimeout(callback, ms);
			// Never the reason a process stays alive.
			(handle as { unref?(): void }).unref?.();
			return handle;
		},
		clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

/**
 * Gives a Node-side process's heap garbage back once the process is quiet: Volt's main process, the extension
 * host and the shared process. Such a process gets no idle-time collection (Chromium gives one to renderers
 * only), so what startup allocated stays committed for as long as the process then does little: the young
 * generation at its full size and the pages V8 pooled. A dev build one minute after launch (round 10): main 186 MB
 * with a 102 MB heap of which 61 MB live, extension host 118 MB (71 / 56), shared process 119 MB; after one
 * collection each 150, 90 and 98 MB, and they stayed there. The collection took 13 to 23 ms.
 *
 * One look {@link QUIET_HEAP_FIRST_LOOK_MS} after start, then a minute after every collection, then at doubling
 * intervals up to ten minutes while there is nothing to do. A look collects only when the process used under
 * {@link QUIET_HEAP_MAX_CPU} of a core for {@link QUIET_HEAP_PROBE_MS} (never in the middle of work) and, after the
 * first time, only when the heap grew by {@link QUIET_HEAP_REGROWTH_BYTES} since the last collection.
 */
export class QuietHeapReducer {

	private timer: unknown;
	private disposed = false;
	/** The heap's size right after the last collection; undefined before the first. */
	private floor: number | undefined;
	private wait = QUIET_HEAP_LOOK_MS;
	private _collections = 0;

	constructor(private readonly host: IQuietHeapHost = nodeHost(), firstLookMs = QUIET_HEAP_FIRST_LOOK_MS) {
		if (host.gc) {
			this.schedule(firstLookMs);
		}
	}

	get collections(): number {
		return this._collections;
	}

	private schedule(ms: number): void {
		if (this.disposed) {
			return;
		}
		this.timer = this.host.setTimeout(() => this.look(), ms);
	}

	private look(): void {
		// Nothing to give back: no need to watch the processor for it.
		if (this.floor !== undefined && this.host.heapTotal() - this.floor < QUIET_HEAP_REGROWTH_BYTES) {
			this.wait = Math.min(this.wait * 2, QUIET_HEAP_MAX_LOOK_MS);
			this.schedule(this.wait);
			return;
		}
		const cpu = this.host.cpuMicros();
		const at = this.host.now();
		this.timer = this.host.setTimeout(() => {
			if (this.disposed) {
				return;
			}
			const elapsedMicros = Math.max(1, (this.host.now() - at) * 1000);
			if ((this.host.cpuMicros() - cpu) / elapsedMicros >= QUIET_HEAP_MAX_CPU) {
				this.schedule(QUIET_HEAP_BUSY_RETRY_MS);
				return;
			}
			this.host.gc!();
			this._collections++;
			this.floor = this.host.heapTotal();
			this.wait = QUIET_HEAP_LOOK_MS;
			this.schedule(this.wait);
		}, QUIET_HEAP_PROBE_MS);
	}

	dispose(): void {
		this.disposed = true;
		this.host.clearTimeout(this.timer);
	}
}

let started: QuietHeapReducer | undefined;

/** Starts this process's {@link QuietHeapReducer}, once. */
export function startQuietHeapReducer(): QuietHeapReducer {
	started ??= new QuietHeapReducer();
	return started;
}
