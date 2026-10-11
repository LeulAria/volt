/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { emptyOrchState, IAgentOrchestratorService, IOrchChange, IOrchPrompt, IOrchState, IOrchSubmitResult, IOrchTask, IOrchThread, IOrchTurnHost, IOrchWorkspaceMover, OrchCommandBody, OrchDelivery, OrchEvent } from '../../voltRuntime/common/orchestration/orchestrator.js';
import { IWorkspaceMoveSpec } from '../../voltRuntime/common/git/workspaceMove.js';
import { orchIsTurnCurrent, orchTaskForToolCall, orchTasksOf } from '../../voltRuntime/common/orchestration/orchestratorQueries.js';
import { IAgentServerClientService } from './agentServerClient.js';

/**
 * The agent server's orchestrator, as this window sees it: its state is the mirror of the
 * server's threads and tasks; commands, sends, moves and cancels go to the server. Turns and
 * moves run there, so this window is never the turn host or the workspace mover.
 */
export class RemoteAgentOrchestratorService extends Disposable implements IAgentOrchestratorService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IOrchChange>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeTasks = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;
	private readonly _onDidStop = this._register(new Emitter<string>());
	readonly onDidStop = this._onDidStop.event;

	readonly whenReady: Promise<void>;
	private state: IOrchState | undefined;

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this.whenReady = client.whenReady;
		this._register(client.onDidChangeCollection(e => {
			if (e.col !== 'orch.threads' && e.col !== 'orch.tasks' && e.col !== 'orch.meta') {
				return;
			}
			this.state = undefined;
			if (e.col === 'orch.threads') {
				this._onDidChange.fire({ threads: e.keys, tasks: [] });
			} else if (e.col === 'orch.tasks') {
				this._onDidChange.fire({ threads: [], tasks: e.keys });
				this._onDidChangeTasks.fire(e.keys);
			}
		}));
		this._register(client.onServerEvent(event => {
			const stop = event as { kind?: string; threadId?: string };
			if (stop.kind === 'orch.stop' && typeof stop.threadId === 'string') {
				this._onDidStop.fire(stop.threadId);
			}
		}));
	}

	getState(): IOrchState {
		if (!this.state) {
			const mirror = this.client.mirror;
			const meta = mirror.get<{ seq: number; conflicts: IOrchState['conflicts'] }>('orch.meta', 'state');
			this.state = {
				...emptyOrchState(),
				seq: meta?.seq ?? 0,
				conflicts: meta?.conflicts ?? {},
				threads: Object.fromEntries(mirror.entries<IOrchThread>('orch.threads')),
				tasks: Object.fromEntries(mirror.entries<IOrchTask>('orch.tasks')),
			};
		}
		return this.state;
	}

	getThread(threadId: string): IOrchThread | undefined {
		return this.client.mirror.get<IOrchThread>('orch.threads', threadId);
	}

	getTask(taskId: string): IOrchTask | undefined {
		return this.client.mirror.get<IOrchTask>('orch.tasks', taskId);
	}

	tasksOf(threadId: string): readonly IOrchTask[] {
		return orchTasksOf(this.getState(), threadId);
	}

	taskForToolCall(threadId: string, toolCallId: string): IOrchTask | undefined {
		return orchTaskForToolCall(this.getState(), threadId, toolCallId);
	}

	isTurnCurrent(threadId: string, turnId: string): boolean {
		return orchIsTurnCurrent(this.getState(), threadId, turnId);
	}

	dispatch(command: OrchCommandBody & { readonly id?: string }): Promise<readonly OrchEvent[]> {
		return this.client.call('orchestrator.dispatch', command);
	}

	submit(threadId: string, prompt: IOrchPrompt, delivery: OrchDelivery, turnId?: string): Promise<IOrchSubmitResult> {
		return this.client.call('orchestrator.submit', threadId, prompt, delivery, turnId);
	}

	move(threadId: string, spec: IWorkspaceMoveSpec, options: { readonly by: 'user' | 'agent'; readonly stop?: boolean }): Promise<IOrchSubmitResult> {
		return this.client.call('orchestrator.move', threadId, spec, options);
	}

	resumeLimit(threadId: string): Promise<IOrchSubmitResult> {
		return this.client.call('orchestrator.resumeLimit', threadId);
	}

	configureLimit(threadId: string, auto: boolean | undefined): Promise<void> {
		return this.client.call('orchestrator.configureLimit', threadId, auto);
	}

	notify(threadId: string, prompt: IOrchPrompt, turnId: string, options?: { readonly interrupt?: boolean }): Promise<IOrchSubmitResult> {
		return this.client.call('orchestrator.notify', threadId, prompt, turnId, options);
	}

	multitaskQueue(threadId: string): Promise<number> {
		return this.client.call('orchestrator.multitaskQueue', threadId);
	}

	cancel(threadId: string, options?: { readonly cascade?: 'turn' | 'all' }): Promise<void> {
		return this.client.call('orchestrator.cancel', threadId, options);
	}

	async ensureThreadLoaded(threadId: string): Promise<void> {
		await this.whenReady;
		await this.client.call('orchestrator.ensureThreadLoaded', threadId);
	}

	/** Turns run in the server's own turn host. */
	setTurnHost(_host: IOrchTurnHost): IDisposable {
		return toDisposable(() => { });
	}

	/** Moves run in the server's own workspace mover (they also happen while no window is open). */
	setWorkspaceMover(_mover: IOrchWorkspaceMover): IDisposable {
		return toDisposable(() => { });
	}

	autoResumeDefault(): boolean {
		return this.client.mirror.get<boolean>('runtime', 'autoResumeDefault') ?? true;
	}
}
