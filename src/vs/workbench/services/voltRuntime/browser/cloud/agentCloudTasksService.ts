/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltRelayEvent, IVoltRelayService } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IAgentWorktreeService } from '../../common/git/agentWorktree.js';
import { CloudAgent, ICloudTask, ownCloudTasks, sortCloudTasks, upsertCloudTask } from '../../common/cloud/cloudTasks.js';
import { IRelayMachine } from '../../common/relay/relayMachines.js';

export const IAgentCloudTasksService = createDecorator<IAgentCloudTasksService>('agentCloudTasksService');

export interface ICloudSendInput {
	readonly repoRoot: string;
	readonly prompt: string;
	readonly title?: string;
	readonly agent: CloudAgent;
	readonly model?: string;
	/** A runner's machine id; absent (Auto): the relay picks the least loaded one. */
	readonly machineId?: string;
	readonly chatId?: string;
}

/**
 * Cloud tasks this Volt sent, kept in step with the relay: the relay holds them, so the list is
 * read back at start and then follows its task events. Applying a result fetches its bundle into
 * a new worktree; the diff is the patch the runner made.
 */
export interface IAgentCloudTasksService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** This Volt's tasks, newest first. Empty while the relay is not connected. */
	readonly tasks: readonly ICloudTask[];
	/** The relay's runners (Volt's own device is not one), with their load from heartbeats. */
	runners(): Promise<IRelayMachine[]>;
	send(input: ICloudSendInput): Promise<ICloudTask>;
	cancel(id: string): Promise<void>;
	/** Removes a finished task from the list (the relay keeps the record). */
	remove(id: string): Promise<void>;
	/** The result's patch text, cut at 2 MB. */
	readPatch(task: ICloudTask): Promise<string>;
	/** Fetches the result into `repoRoot` and checks it out in a new worktree. */
	applyLocally(task: ICloudTask, repoRoot: string): Promise<{ readonly path: string; readonly branch: string }>;
}

const PATCH_LIMIT = 2 * 1024 * 1024;

export class AgentCloudTasksService extends Disposable implements IAgentCloudTasksService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _tasks: ICloudTask[] = [];
	get tasks(): readonly ICloudTask[] { return this._tasks; }

	private deviceId: string | undefined;
	private loading: Promise<void> | undefined;

	constructor(
		@IVoltRelayService private readonly relay: IVoltRelayService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.relay.onDidChangeState(() => void this.reload()));
		this._register(this.relay.onDidEvent(event => this.onEvent(event)));
		void this.reload();
	}

	async runners(): Promise<IRelayMachine[]> {
		const reply = await this.relay.request<{ machines: IRelayMachine[] }>('GET', '/machines');
		return reply.machines.filter(machine => machine.kind === 'runner');
	}

	async send(input: ICloudSendInput): Promise<ICloudTask> {
		const { task } = await this.relay.createCloudTask({
			repoRoot: input.repoRoot,
			prompt: input.prompt,
			...(input.title ? { title: input.title } : {}),
			agent: input.agent,
			...(input.model ? { model: input.model } : {}),
			...(input.machineId ? { machineId: input.machineId } : { autoPicked: true }),
			...(input.chatId ? { chatId: input.chatId } : {}),
		}) as { task: ICloudTask };
		this.store(task);
		return task;
	}

	async cancel(id: string): Promise<void> {
		this.store(await this.relay.request<ICloudTask>('POST', `/tasks/${encodeURIComponent(id)}/cancel`));
	}

	async remove(id: string): Promise<void> {
		await this.relay.request('DELETE', `/tasks/${encodeURIComponent(id)}`);
		this._tasks = this._tasks.filter(task => task.id !== id);
		this._onDidChange.fire();
	}

	async readPatch(task: ICloudTask): Promise<string> {
		if (!task.result?.patchBlob) {
			throw new Error('The task has no patch.');
		}
		return this.relay.readBlobText(task.result.patchBlob, PATCH_LIMIT);
	}

	async applyLocally(task: ICloudTask, repoRoot: string): Promise<{ readonly path: string; readonly branch: string }> {
		const applied = await this.relay.fetchCloudResult(task.id, repoRoot);
		const created = await this.worktrees.create(repoRoot, { kind: 'new', name: applied.branch, from: applied.ref });
		return { path: created.path, branch: created.branch };
	}

	private async reload(): Promise<void> {
		if (this.loading) {
			return this.loading;
		}
		this.loading = (async () => {
			try {
				const state = await this.relay.getState();
				this.deviceId = state.deviceId;
				if (state.status !== 'online') {
					this._tasks = [];
					return;
				}
				const reply = await this.relay.request<{ tasks: ICloudTask[] }>('GET', '/tasks?limit=200');
				this._tasks = sortCloudTasks(ownCloudTasks(reply.tasks, this.deviceId));
			} catch (err) {
				this.logService.warn('[volt cloud] could not read cloud tasks', err);
			} finally {
				this.loading = undefined;
				this._onDidChange.fire();
			}
		})();
		return this.loading;
	}

	private onEvent(event: IVoltRelayEvent): void {
		if (event.type === 'resync') {
			void this.reload();
		} else if (event.type === 'task' && event.data) {
			this.store(event.data as ICloudTask);
		} else if (event.type === 'task.removed' && event.id) {
			this._tasks = this._tasks.filter(task => task.id !== event.id);
			this._onDidChange.fire();
		}
	}

	private store(task: ICloudTask): void {
		if (!this.deviceId || task.origin.deviceId !== this.deviceId || task.archived) {
			return;
		}
		this._tasks = sortCloudTasks(upsertCloudTask(this._tasks, task));
		this._onDidChange.fire();
	}
}

registerSingleton(IAgentCloudTasksService, AgentCloudTasksService, InstantiationType.Delayed);
