/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { threadStatus } from '../../../../services/voltRuntime/common/orchestration/orchestratorViews.js';
import {
	estimateRunGroup,
	IAgentRunGroupService,
	IRunDiffTarget,
	IRunGroup,
	IRunGroupEstimate,
	IRunGroupModel,
	IRunGroupPrompt,
	IRunGroupRollup,
	IRunGroupStartRequest,
	IRunGroupView,
	IRunWinnerResult,
	runGroupRollup,
	RunFollowUpTarget,
	RunStatus,
	runStatus,
	RunWinnerAction,
} from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { readRunCostHistory } from './agentRunGroupWindowService.js';

const CREATE_PULL_REQUEST_COMMAND_ID = 'volt.pullRequest.create';
const COLLECTION = 'runGroups';

/**
 * The agent server's run groups, as a window on it sees them: the groups are the mirror of the
 * server's `runGroups` collection (shared with the browser and the phone), and starting, stopping
 * and picking a winner run there. Statuses come from this window's view of the orchestrator, the
 * same way the in-process service reads them, so the compare view and the sidebar agree with the
 * chats. The cost warning and the pull request form are this window's.
 */
export class RemoteAgentRunGroupService extends Disposable implements IAgentRunGroupService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;

	private sorted: readonly IRunGroup[] | undefined;
	private bySession: Map<string, string> | undefined;

	constructor(
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.whenReady = client.whenReady;
		this._register(client.onDidChangeCollection(e => {
			if (e.col !== COLLECTION) {
				return;
			}
			this.sorted = undefined;
			this.bySession = undefined;
			e.keys.forEach(key => this._onDidChange.fire(key));
		}));
		this._register(orchestrator.onDidChange(change => {
			const groups = new Set<string>();
			for (const threadId of change.threads) {
				const groupId = this.index().get(threadId);
				if (groupId) {
					groups.add(groupId);
				}
			}
			groups.forEach(groupId => this._onDidChange.fire(groupId));
		}));
	}

	private view(groupId: string): IRunGroupView | undefined {
		return this.client.mirror.get<IRunGroupView>(COLLECTION, groupId);
	}

	private index(): Map<string, string> {
		if (!this.bySession) {
			this.bySession = new Map();
			for (const group of this.list()) {
				for (const run of group.runs) {
					this.bySession.set(run.id, group.id);
				}
			}
		}
		return this.bySession;
	}

	//#region Read

	list(): readonly IRunGroup[] {
		this.sorted ??= this.client.mirror.values<IRunGroupView>(COLLECTION).filter(group => !!group?.id).sort((a, b) => b.createdAt - a.createdAt);
		return this.sorted;
	}

	get(groupId: string): IRunGroup | undefined {
		return this.view(groupId);
	}

	groupOf(sessionId: string): IRunGroup | undefined {
		const groupId = this.index().get(sessionId);
		return groupId ? this.view(groupId) : undefined;
	}

	runStatus(groupId: string, runId: string): RunStatus {
		const group = this.view(groupId);
		const run = group?.runs.find(candidate => candidate.id === runId);
		if (!group || !run) {
			return 'failed';
		}
		const state = this.orchestrator.getState();
		const thread = state.threads[runId];
		if (!thread) {
			return group.statuses?.[runId] ?? runStatus(run, undefined);
		}
		return runStatus(run, { status: threadStatus(state, runId), turns: thread.turns, ...(thread.last ? { lastOutcome: thread.last.outcome } : {}) });
	}

	rollup(groupId: string): IRunGroupRollup {
		const group = this.view(groupId);
		return runGroupRollup(group ? group.runs.filter(run => !run.discarded).map(run => this.runStatus(groupId, run.id)) : []);
	}

	//#endregion

	//#region Calls to the server

	async start(request: IRunGroupStartRequest): Promise<IRunGroup> {
		await this.whenReady;
		// The live display (image bytes) stays here: the server reads the frozen one's attachments.
		const { liveDisplay: _live, ...rest } = request;
		return this.client.call<IRunGroup>('runGroups.start', rest);
	}

	stop(groupId: string, runId?: string): Promise<void> {
		return this.client.call('runGroups.stop', groupId, runId);
	}

	retrySetup(groupId: string, runId: string): Promise<void> {
		return this.client.call('runGroups.retrySetup', groupId, runId);
	}

	followUp(groupId: string, target: string | 'all', prompt: IRunGroupPrompt): Promise<void> {
		return this.client.call('runGroups.followUp', groupId, target, prompt);
	}

	setFollowUpTarget(groupId: string, target: RunFollowUpTarget): void {
		this.client.send('runGroups.setFollowUpTarget', groupId, target);
	}

	refreshStats(groupId: string): Promise<void> {
		return this.client.call('runGroups.refreshStats', groupId);
	}

	async pickWinner(groupId: string, runId: string, action: RunWinnerAction, options: { readonly removeOthers: boolean }): Promise<IRunWinnerResult> {
		const result = await this.client.call<IRunWinnerResult>('runGroups.pickWinner', groupId, runId, action, options);
		if (result.ok && result.pullRequest) {
			// The server committed the winner's changes; the form is this window's.
			await this.commandService.executeCommand(CREATE_PULL_REQUEST_COMMAND_ID, result.pullRequest.runId);
		}
		return result;
	}

	removeWorktrees(groupId: string, runIds: readonly string[]): Promise<IRunWinnerResult> {
		return this.client.call('runGroups.removeWorktrees', groupId, runIds);
	}

	diffTarget(groupId: string, from: string | 'base', to: string): Promise<IRunDiffTarget> {
		return this.client.call('runGroups.diffTarget', groupId, from, to);
	}

	async estimate(models: readonly IRunGroupModel[]): Promise<IRunGroupEstimate> {
		return estimateRunGroup(models, await readRunCostHistory(this.instantiationService));
	}

	archive(groupId: string): Promise<void> {
		return this.client.call('runGroups.archive', groupId);
	}

	//#endregion
}
