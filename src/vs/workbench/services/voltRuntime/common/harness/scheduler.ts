/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkerLeaseManager } from './lease.js';
import { AgentRole, IOrchestration, IWorkerSpec } from './orchestrator.js';
import { IExecutionPlan, readySteps } from './plan.js';

/**
 * Task scheduler. DeepSeek's schedule package is a reminder clock; Volt's is
 * the fairness queue that turns an orchestration into leased work:
 *
 *   1. enqueue one job per worker
 *   2. priority within a band is FIFO
 *   3. a job only starts when its plan steps are ready and a lease is free
 *   4. the worker with the fewest completions is preferred (fairness)
 */

export type ScheduleStatus = 'queued' | 'leased' | 'done' | 'failed';

export type SchedulePriority = 'high' | 'normal' | 'low';

export interface IScheduledJob {
	readonly id: string;
	readonly workerId: string;
	readonly role: AgentRole;
	readonly stepIds: readonly string[];
	readonly priority: SchedulePriority;
	readonly status: ScheduleStatus;
	readonly completions: number;
}

export interface IScheduleSnapshot {
	readonly queued: number;
	readonly leased: number;
	readonly done: number;
	readonly jobs: readonly IScheduledJob[];
}

const PRIORITY_RANK: Readonly<Record<SchedulePriority, number>> = { high: 0, normal: 1, low: 2 };

const ROLE_PRIORITY: Readonly<Partial<Record<AgentRole, SchedulePriority>>> = {
	debug: 'high',
	research: 'high',
	explore: 'high',
	implement: 'normal',
	ui: 'normal',
	browser: 'normal',
	verify: 'low',
	review: 'low',
};

export class TaskScheduler {

	private readonly jobs: IScheduledJob[] = [];
	private readonly completions = new Map<string, number>();

	constructor(private readonly leases: WorkerLeaseManager) { }

	load(orchestration: IOrchestration, plan?: IExecutionPlan): IScheduleSnapshot {
		this.jobs.length = 0;
		for (const worker of orchestration.workers) {
			this.jobs.push(jobOf(worker, plan));
		}
		return this.snapshot();
	}

	dispatch(plan?: IExecutionPlan): IScheduledJob | undefined {
		const ready = new Set(plan ? readySteps(plan).map(step => step.id) : this.jobs.flatMap(job => job.stepIds));
		const candidates = this.jobs
			.filter(job => job.status === 'queued' && job.stepIds.some(id => ready.has(id) || !plan))
			.sort((a, b) =>
				PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
				(this.completions.get(a.workerId) ?? 0) - (this.completions.get(b.workerId) ?? 0));

		for (const job of candidates) {
			const lease = this.leases.acquire(job.workerId, job.id);
			if (!lease) {
				continue;
			}
			const next: IScheduledJob = { ...job, status: 'leased' };
			this.replace(job.id, next);
			return next;
		}
		return undefined;
	}

	complete(jobId: string, ok = true): IScheduledJob | undefined {
		const job = this.jobs.find(item => item.id === jobId);
		if (!job) {
			return undefined;
		}
		this.leases.release(job.workerId, job.id);
		const next: IScheduledJob = { ...job, status: ok ? 'done' : 'failed', completions: job.completions + 1 };
		this.replace(jobId, next);
		this.completions.set(job.workerId, (this.completions.get(job.workerId) ?? 0) + 1);
		return next;
	}

	heartbeat(jobId: string): boolean {
		const job = this.jobs.find(item => item.id === jobId && item.status === 'leased');
		return !!job && !!this.leases.heartbeat(job.workerId, job.id);
	}

	snapshot(): IScheduleSnapshot {
		return {
			queued: this.jobs.filter(job => job.status === 'queued').length,
			leased: this.jobs.filter(job => job.status === 'leased').length,
			done: this.jobs.filter(job => job.status === 'done').length,
			jobs: this.jobs.slice(),
		};
	}

	private replace(id: string, next: IScheduledJob): void {
		const index = this.jobs.findIndex(job => job.id === id);
		if (index >= 0) {
			this.jobs[index] = next;
		}
	}
}

function jobOf(worker: IWorkerSpec, _plan?: IExecutionPlan): IScheduledJob {
	return {
		id: `job:${worker.id}`,
		workerId: worker.id,
		role: worker.role,
		stepIds: worker.stepIds,
		priority: ROLE_PRIORITY[worker.role] ?? 'normal',
		status: 'queued',
		completions: 0,
	};
}

export type { IScheduledJob as IScheduledWork };
