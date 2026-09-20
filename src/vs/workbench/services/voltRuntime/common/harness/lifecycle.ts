/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Task lifecycle. A run is a state machine, not a boolean. The UI, the event store, and the
 * resume path all need to know *which* kind of not-running a run is: waiting for the user is
 * not the same as paused, and verifying is not the same as still planning.
 *
 * Illegal transitions throw in tests and are no-ops in production (`tryTransition`) so a
 * buggy caller cannot take a completed run back to planning.
 */

export type TaskPhase =
	| 'created'
	| 'planning'
	| 'running'
	| 'waiting'
	| 'paused'
	| 'verifying'
	| 'completed'
	| 'failed'
	| 'cancelled';

export const TASK_PHASES: readonly TaskPhase[] = [
	'created', 'planning', 'running', 'waiting', 'paused', 'verifying', 'completed', 'failed', 'cancelled',
];

const TERMINAL: ReadonlySet<TaskPhase> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Legal edges. `resume` is not a phase - it is the transition `waiting|paused → running`
 * (or `planning` if nothing has started yet).
 */
const EDGES: Readonly<Record<TaskPhase, readonly TaskPhase[]>> = {
	created: ['planning', 'running', 'cancelled'],
	planning: ['running', 'waiting', 'cancelled', 'failed'],
	running: ['waiting', 'paused', 'verifying', 'completed', 'failed', 'cancelled'],
	waiting: ['running', 'planning', 'cancelled', 'failed'],
	paused: ['running', 'cancelled'],
	verifying: ['running', 'completed', 'failed', 'cancelled'],
	completed: [],
	failed: ['planning', 'running'],
	cancelled: [],
};

export interface ILifecycleSnapshot {
	readonly phase: TaskPhase;
	readonly enteredAt: number;
	readonly history: readonly { readonly phase: TaskPhase; readonly at: number }[];
}

export class TaskLifecycle {

	private phase: TaskPhase = 'created';
	private enteredAt: number;
	private readonly log: { phase: TaskPhase; at: number }[] = [];

	constructor(now = Date.now()) {
		this.enteredAt = now;
		this.log.push({ phase: 'created', at: now });
	}

	get current(): TaskPhase {
		return this.phase;
	}

	get snapshot(): ILifecycleSnapshot {
		return { phase: this.phase, enteredAt: this.enteredAt, history: this.log.slice() };
	}

	can(next: TaskPhase): boolean {
		return EDGES[this.phase].includes(next);
	}

	isTerminal(): boolean {
		return TERMINAL.has(this.phase);
	}

	transition(next: TaskPhase, now = Date.now()): ILifecycleSnapshot {
		if (next === this.phase) {
			return this.snapshot;
		}
		if (!this.can(next)) {
			throw new Error(`Illegal lifecycle transition: ${this.phase} → ${next}.`);
		}
		this.phase = next;
		this.enteredAt = now;
		this.log.push({ phase: next, at: now });
		return this.snapshot;
	}

	/** Same as `transition` but returns `undefined` instead of throwing. Used on the hot path. */
	tryTransition(next: TaskPhase, now = Date.now()): ILifecycleSnapshot | undefined {
		if (next === this.phase) {
			return this.snapshot;
		}
		if (!this.can(next)) {
			return undefined;
		}
		return this.transition(next, now);
	}

	/** Waiting or paused work comes back as running; a failed run may be retried. */
	resume(now = Date.now()): ILifecycleSnapshot {
		if (this.phase === 'waiting' || this.phase === 'paused') {
			return this.transition('running', now);
		}
		if (this.phase === 'failed') {
			return this.transition('running', now);
		}
		if (this.phase === 'created') {
			return this.transition('planning', now);
		}
		throw new Error(`Cannot resume from ${this.phase}.`);
	}
}

export function isTerminalPhase(phase: TaskPhase): boolean {
	return TERMINAL.has(phase);
}

export function toRunStatus(phase: TaskPhase): 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' {
	switch (phase) {
		case 'created':
		case 'planning':
			return 'queued';
		case 'waiting':
		case 'paused':
			return 'waiting';
		case 'completed':
			return 'completed';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		case 'running':
		case 'verifying':
		default:
			return 'running';
	}
}
