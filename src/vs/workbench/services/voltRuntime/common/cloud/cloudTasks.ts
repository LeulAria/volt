/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cloud tasks as the relay keeps them: a prompt and a git source, run headlessly by a runner.
 * The relay holds the state, so these rows survive a Volt restart. Pure rules for the sidebar
 * rows, the status line and the new chat's Cloud location live here.
 */

export type CloudTaskStatus = 'queued' | 'claimed' | 'preparing' | 'running' | 'finishing' | 'succeeded' | 'failed' | 'cancelled';

export type CloudAgent = 'claude' | 'codex';

export interface ICloudTaskFile {
	readonly path: string;
	readonly insertions: number;
	readonly deletions: number;
}

export interface ICloudTask {
	readonly id: string;
	readonly title: string;
	readonly prompt: string;
	readonly agent: CloudAgent;
	readonly model?: string;
	readonly status: CloudTaskStatus;
	readonly progress?: string;
	readonly lastMessage?: string;
	readonly error?: string;
	readonly createdAt: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly assignedTo?: string;
	readonly assignedName?: string;
	readonly target: { readonly machineId?: string; readonly autoPicked?: boolean };
	readonly origin: { readonly deviceId: string; readonly deviceName?: string; readonly repoRoot?: string; readonly chatId?: string };
	readonly source: { readonly projectName?: string; readonly baseCommit?: string; readonly baseBranch?: string; readonly repoUrl?: string };
	readonly result?: {
		readonly branch?: string;
		readonly baseCommit?: string;
		readonly headCommit?: string;
		readonly bundleBlob?: string;
		readonly patchBlob?: string;
		readonly summary?: string;
		readonly files?: readonly ICloudTaskFile[];
		readonly stats?: { readonly files: number; readonly insertions: number; readonly deletions: number };
		readonly noChanges?: boolean;
	};
	readonly usage?: { readonly costUsd?: number; readonly inputTokens?: number; readonly outputTokens?: number };
	readonly cancelRequested?: boolean;
	readonly archived?: boolean;
}

const ACTIVE: ReadonlySet<string> = new Set<CloudTaskStatus>(['queued', 'claimed', 'preparing', 'running', 'finishing']);

export function isCloudTaskActive(task: Pick<ICloudTask, 'status'>): boolean {
	return ACTIVE.has(task.status);
}

/** Green, red, muted for the row's status dot; `active` spins. */
export function cloudTaskTone(task: Pick<ICloudTask, 'status'>): 'active' | 'succeeded' | 'failed' | 'muted' {
	if (isCloudTaskActive(task)) {
		return 'active';
	}
	return task.status === 'succeeded' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'muted';
}

/** The task's line in the sidebar and the status bar: where it is, in a few words. */
export function cloudTaskStatusText(task: ICloudTask): string {
	switch (task.status) {
		case 'queued':
			if (task.target.autoPicked) {
				return 'Waiting for the least loaded runner';
			}
			return task.target.machineId ? 'Waiting for its runner' : 'Waiting for a runner';
		case 'claimed':
		case 'preparing':
			return task.assignedName ? `Preparing on ${task.assignedName}` : 'Preparing';
		case 'running':
			return [task.progress || 'Running', task.assignedName ? `on ${task.assignedName}` : undefined].filter(Boolean).join(' ');
		case 'finishing':
			return 'Collecting changes';
		case 'succeeded': {
			if (task.result?.noChanges) {
				return 'Finished with no changes';
			}
			const files = task.result?.stats?.files ?? task.result?.files?.length ?? 0;
			return files ? `${files} ${files === 1 ? 'file' : 'files'} changed` : 'Finished';
		}
		case 'failed':
			return task.error ? `Failed: ${task.error}` : 'Failed';
		case 'cancelled':
			return 'Cancelled';
	}
}

/** The task has code to apply: a branch and a bundle the runner made. */
export function cloudTaskHasResult(task: ICloudTask): boolean {
	return task.status === 'succeeded' && !!task.result?.bundleBlob && !!task.result.branch && !task.result.noChanges;
}

/** Newest first, as the sidebar lists them. */
export function sortCloudTasks(tasks: readonly ICloudTask[]): ICloudTask[] {
	return [...tasks].filter(task => !task.archived).sort((a, b) => b.createdAt - a.createdAt);
}

/** Tasks this Volt sent (the relay lists every device's tasks to an admin). */
export function ownCloudTasks(tasks: readonly ICloudTask[], deviceId: string | undefined): ICloudTask[] {
	return deviceId ? tasks.filter(task => task.origin.deviceId === deviceId) : [];
}

/** Replaces a task by id, or adds it; a removed task is dropped by the caller. */
export function upsertCloudTask(tasks: readonly ICloudTask[], task: ICloudTask): ICloudTask[] {
	return tasks.some(candidate => candidate.id === task.id)
		? tasks.map(candidate => candidate.id === task.id ? task : candidate)
		: [...tasks, task];
}

/** The Run on location's machine choice is remembered per project, like the location itself. */
export const CLOUD_AUTO = 'auto';

export function cloudMachineStorageKey(projectId: string | undefined): string {
	return `volt.agent.cloudMachine.${projectId || 'default'}`;
}

/** `auto`, or a runner's machine id. Anything else is Auto. */
export function normalizeCloudMachine(value: string | undefined): string {
	return value && /^[\w.-]{4,80}$/.test(value) ? value : CLOUD_AUTO;
}

/**
 * The runner's agent for a catalog model's provider family: Claude Code or Codex. Other providers
 * have no headless runner, so they cannot run in the cloud.
 */
export function cloudAgentForFamily(family: string | undefined): CloudAgent | undefined {
	return family === 'claude' ? 'claude' : family === 'codex' ? 'codex' : undefined;
}

export function cloudAgentLabel(agent: CloudAgent): string {
	return agent === 'codex' ? 'Codex' : 'Claude Code';
}
