/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { isLiveTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { shouldAutoSettleIdle } from '../../common/agentAutoSettle.js';
import { AGENT_HOME_AUTO_SETTLE_DAYS_SETTING } from '../../common/agentHomeSettings.js';

/** How often idle chats are looked at again; the rule counts days, so an hour is plenty. */
const AUTO_SETTLE_INTERVAL_MS = 60 * 60_000;

/**
 * Moves chats idle for `volt.agent.home.autoSettleDays` to Settled, on startup and every hour.
 * Pull request endings settle chats on their own in the pull request service.
 */
class AgentAutoSettleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentAutoSettle';

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => this.run(), AUTO_SETTLE_INTERVAL_MS);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING)) {
				this.run();
			}
		}));
		// Orchestration recovery tells which chats still run work; settle nothing before it.
		void Promise.all([this.history.whenReady, this.orchestrator.whenReady]).then(() => this.run(), err => this.logService.warn('[volt] auto-settle could not start', err));
	}

	private run(): void {
		const days = this.configurationService.getValue<number>(AGENT_HOME_AUTO_SETTLE_DAYS_SETTING);
		if (typeof days !== 'number' || !(days > 0)) {
			return;
		}
		const state = this.orchestrator.getState();
		const delegating = new Set(Object.values(state.tasks).filter(task => isLiveTaskState(task.state)).map(task => task.parentId));
		const now = Date.now();
		for (const meta of this.history.list()) {
			const thread = this.orchestrator.getThread(meta.id);
			const busy = !!thread?.active || !!thread?.queue.length || !!thread?.inputs.length;
			if (shouldAutoSettleIdle(meta, { busy, liveSubagents: delegating.has(meta.id) }, now, days)) {
				void this.history.setSettled(meta.id, true);
			}
		}
	}
}

registerWorkbenchContribution2(AgentAutoSettleContribution.ID, AgentAutoSettleContribution, WorkbenchPhase.Eventually);
