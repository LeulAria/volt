/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Concurrency manager. Priority queue, cancellation, timeouts, and backpressure - the
 * knobs the execution router turns when more than one worker or tool batch is in flight.
 *
 * The queue is fair within a priority band (FIFO) and strict across bands. A cancelled
 * job never starts; a job that overruns its timeout is marked timed-out and the caller
 * decides whether to retry. Backpressure trips when the queue is full so a runaway
 * swarm cannot enqueue itself into memory exhaustion.
 */

export type JobPriority = 'high' | 'normal' | 'low';

export type JobStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'timeout';

export interface IJob<T> {
	readonly id: string;
	readonly priority: JobPriority;
	readonly timeoutMs: number;
	readonly run: (signal: { cancelled: boolean }) => Promise<T> | T;
}

export interface IJobResult<T> {
	readonly id: string;
	readonly status: JobStatus;
	readonly value?: T;
	readonly error?: string;
	readonly waitedMs: number;
	readonly ranMs: number;
}

export interface IConcurrencyOptions {
	readonly limit?: number;
	readonly maxQueue?: number;
	readonly defaultTimeoutMs?: number;
	readonly now?: () => number;
}

const PRIORITY_RANK: Readonly<Record<JobPriority, number>> = { high: 0, normal: 1, low: 2 };

interface IQueued<T> {
	readonly job: IJob<T>;
	readonly enqueuedAt: number;
	cancelled: boolean;
	readonly resolve: (result: IJobResult<T>) => void;
}

export class ConcurrencyManager {

	private readonly limit: number;
	private readonly maxQueue: number;
	private readonly defaultTimeoutMs: number;
	private readonly now: () => number;
	private readonly queue: IQueued<unknown>[] = [];
	private running = 0;
	private seq = 0;

	constructor(options: IConcurrencyOptions = {}) {
		this.limit = Math.max(1, options.limit ?? 4);
		this.maxQueue = Math.max(1, options.maxQueue ?? 32);
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
		this.now = options.now ?? Date.now;
	}

	get pending(): number {
		return this.queue.filter(item => !item.cancelled).length;
	}

	get inflight(): number {
		return this.running;
	}

	get backpressured(): boolean {
		return this.pending >= this.maxQueue;
	}

	enqueue<T>(job: Omit<IJob<T>, 'id'> & { id?: string }): { id: string; result: Promise<IJobResult<T>> } {
		if (this.backpressured) {
			throw new Error(`Concurrency backpressure: ${this.pending} jobs already queued.`);
		}
		const id = job.id ?? `j${++this.seq}`;
		const full: IJob<T> = {
			id,
			priority: job.priority,
			timeoutMs: job.timeoutMs || this.defaultTimeoutMs,
			run: job.run,
		};
		let resolve!: (result: IJobResult<T>) => void;
		const result = new Promise<IJobResult<T>>(r => { resolve = r; });
		this.queue.push({
			job: full as IJob<unknown>,
			enqueuedAt: this.now(),
			cancelled: false,
			resolve: resolve as (result: IJobResult<unknown>) => void,
		});
		this.queue.sort((a, b) => PRIORITY_RANK[a.job.priority] - PRIORITY_RANK[b.job.priority] || a.enqueuedAt - b.enqueuedAt);
		this.kick();
		return { id, result };
	}

	cancel(id: string): boolean {
		const entry = this.queue.find(item => item.job.id === id);
		if (!entry || entry.cancelled) {
			return false;
		}
		entry.cancelled = true;
		this.queue.splice(this.queue.indexOf(entry), 1);
		entry.resolve({ id, status: 'cancelled', waitedMs: this.now() - entry.enqueuedAt, ranMs: 0 });
		return true;
	}

	cancelAll(): void {
		for (const entry of this.queue.splice(0)) {
			entry.cancelled = true;
			entry.resolve({ id: entry.job.id, status: 'cancelled', waitedMs: this.now() - entry.enqueuedAt, ranMs: 0 });
		}
	}

	private kick(): void {
		while (this.running < this.limit) {
			const next = this.queue.find(item => !item.cancelled);
			if (!next) {
				return;
			}
			this.queue.splice(this.queue.indexOf(next), 1);
			this.running++;
			void this.run(next).finally(() => {
				this.running--;
				this.kick();
			});
		}
	}

	private async run(entry: IQueued<unknown>): Promise<void> {
		const started = this.now();
		const waitedMs = started - entry.enqueuedAt;
		const signal = { cancelled: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<'timeout'>(resolve => {
			timer = setTimeout(() => {
				signal.cancelled = true;
				resolve('timeout');
			}, entry.job.timeoutMs);
		});
		try {
			const raced = await Promise.race([
				Promise.resolve(entry.job.run(signal)).then(value => ({ kind: 'ok' as const, value })),
				timeout.then(kind => ({ kind })),
			]);
			const ranMs = this.now() - started;
			if (raced.kind === 'timeout') {
				entry.resolve({ id: entry.job.id, status: 'timeout', waitedMs, ranMs, error: `Timed out after ${entry.job.timeoutMs}ms.` });
				return;
			}
			entry.resolve({ id: entry.job.id, status: 'done', value: raced.value, waitedMs, ranMs });
		} catch (error) {
			entry.resolve({
				id: entry.job.id,
				status: 'done',
				error: error instanceof Error ? error.message : String(error),
				waitedMs,
				ranMs: this.now() - started,
			});
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}
}
