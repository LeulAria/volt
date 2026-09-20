/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worker lease manager. A swarm worker that dies mid-edit without releasing its path claim
 * would lock that file forever; a lease that expires without a heartbeat is how the
 * orchestrator notices and reassigns the work.
 *
 * Heartbeats are the only liveness signal. A worker that is busy for longer than the TTL
 * without beating is treated as dead even if its process is still around - that is the
 * point: a wedged worker is worse than a missing one.
 */

export interface IWorkerLease {
	readonly workerId: string;
	readonly taskId: string;
	readonly acquiredAt: number;
	readonly expiresAt: number;
	readonly heartbeats: number;
}

export interface ILeaseOptions {
	readonly ttlMs?: number;
	readonly now?: () => number;
}

const DEFAULT_TTL = 30_000;

export class WorkerLeaseManager {

	private readonly leases = new Map<string, IWorkerLease>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: ILeaseOptions = {}) {
		this.ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL);
		this.now = options.now ?? Date.now;
	}

	acquire(workerId: string, taskId: string): IWorkerLease | undefined {
		this.reap();
		if (this.heldBy(taskId) && this.heldBy(taskId) !== workerId) {
			return undefined;
		}
		const at = this.now();
		const lease: IWorkerLease = {
			workerId,
			taskId,
			acquiredAt: at,
			expiresAt: at + this.ttlMs,
			heartbeats: 0,
		};
		this.leases.set(keyOf(workerId, taskId), lease);
		return lease;
	}

	heartbeat(workerId: string, taskId: string): IWorkerLease | undefined {
		const lease = this.leases.get(keyOf(workerId, taskId));
		if (!lease) {
			return undefined;
		}
		const at = this.now();
		if (lease.expiresAt <= at) {
			this.leases.delete(keyOf(workerId, taskId));
			return undefined;
		}
		const next: IWorkerLease = { ...lease, expiresAt: at + this.ttlMs, heartbeats: lease.heartbeats + 1 };
		this.leases.set(keyOf(workerId, taskId), next);
		return next;
	}

	release(workerId: string, taskId?: string): boolean {
		if (taskId) {
			return this.leases.delete(keyOf(workerId, taskId));
		}
		let released = false;
		for (const [key, lease] of this.leases) {
			if (lease.workerId === workerId) {
				this.leases.delete(key);
				released = true;
			}
		}
		return released;
	}

	heldBy(taskId: string): string | undefined {
		this.reap();
		for (const lease of this.leases.values()) {
			if (lease.taskId === taskId) {
				return lease.workerId;
			}
		}
		return undefined;
	}

	expired(): readonly IWorkerLease[] {
		const at = this.now();
		return [...this.leases.values()].filter(lease => lease.expiresAt <= at);
	}

	reap(): readonly IWorkerLease[] {
		const dead = this.expired();
		for (const lease of dead) {
			this.leases.delete(keyOf(lease.workerId, lease.taskId));
		}
		return dead;
	}

	all(): readonly IWorkerLease[] {
		this.reap();
		return [...this.leases.values()];
	}
}

function keyOf(workerId: string, taskId: string): string {
	return `${workerId}\0${taskId}`;
}
