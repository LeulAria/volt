/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { emptyOrchState, IAgentOrchestratorService, IOrchChange, IOrchPrompt, IOrchState, IOrchSubmitResult, IOrchTask, IOrchThread, IOrchTurnHost, OrchCommandBody, OrchDelivery, OrchEvent } from '../../voltRuntime/common/orchestration/orchestrator.js';
import { orchIsTurnCurrent, orchTaskForToolCall, orchTasksOf } from '../../voltRuntime/common/orchestration/orchestratorQueries.js';
import { IAgentServerClientService } from './agentServerClient.js';

/**
 * The agent server's orchestrator, as this window sees it: its state is the mirror of the
 * server's threads and tasks; commands, sends and cancels go to the server. Turns run there,
 * so this window is never the turn host.
 */
export class RemoteAgentOrchestratorService extends Disposable implements IAgentOrchestratorService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IOrchChange>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeTasks = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeTasks = this._onDidChangeTasks.event;

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

	notify(threadId: string, prompt: IOrchPrompt, turnId: string): Promise<IOrchSubmitResult> {
		return this.client.call('orchestrator.notify', threadId, prompt, turnId);
	}

	cancel(threadId: string, options?: { readonly cascade?: 'turn' | 'all' }): Promise<void> {
		return this.client.call('orchestrator.cancel', threadId, options);
	}

	setLimitRecovery(threadId: string, turnId: string, choice: { readonly autoResume?: boolean; readonly snooze?: boolean }): Promise<string | undefined> {
		return this.client.call('orchestrator.setLimitRecovery', threadId, turnId, choice);
	}

	async ensureThreadLoaded(threadId: string): Promise<void> {
		await this.whenReady;
		await this.client.call('orchestrator.ensureThreadLoaded', threadId);
	}

	setTurnHost(_host: IOrchTurnHost): IDisposable {
		return toDisposable(() => { });
	}
}
