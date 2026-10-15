/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer, RunOnceScheduler } from '../../../../../base/common/async.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { isLiveTaskState } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { IAgentOrchestratorService, IOrchThread, isOrchHold, orchHoldReason } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { shouldAutoSettleIdle } from '../../common/agentAutoSettle.js';
import { AGENT_HOME_AUTO_SETTLE_DAYS_SETTING } from '../../common/agentHomeSettings.js';
import { AGENT_LIFECYCLE_UNDO_COMMAND_ID, AgentLifecycleUndoContext, IAgentThreadLifecycleService, liftAgentHold } from './agentThreadLifecycle.js';

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

/**
 * Settled and archived chats do not run. Moving a chat there stops its turn and every subagent under
 * it, ends Volt's restarts and usage-limit resumes, and holds the chat (`blocked`): queued prompts,
 * subagent reports, pull request news and messages from other chats wait instead of starting it.
 * Moving it back lifts the hold without starting anything; sending or resuming does that.
 */
class AgentSettledRunGuardContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentSettledRunGuard';

	/** Chats to look at again; read after the change that named them is fully applied. */
	private readonly pending = new Set<string>();
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.flush(), 0));
	private ready = false;

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.history.onDidChange(() => this.check(Object.keys(this.orchestrator.getState().threads))));
		this._register(this.orchestrator.onDidChange(change => this.check(change.threads)));
		void Promise.all([this.history.whenReady, this.orchestrator.whenReady]).then(() => {
			this.ready = true;
			this.check(Object.keys(this.orchestrator.getState().threads));
		}, err => this.logService.warn('[volt] the settled-chat guard could not start', err));
	}

	private check(ids: Iterable<string>): void {
		for (const id of ids) {
			this.pending.add(id);
		}
		if (this.ready && this.pending.size && !this.scheduler.isScheduled()) {
			this.scheduler.schedule();
		}
	}

	private flush(): void {
		const ids = [...this.pending];
		this.pending.clear();
		for (const id of ids) {
			const thread = this.orchestrator.getThread(id);
			// A subagent's chat follows its task, which stops with the chat that started it.
			if (!thread || thread.taskId) {
				continue;
			}
			const hold = orchHoldReason(this.history.get(id));
			if (!hold) {
				if (isOrchHold(thread.blocked)) {
					void liftAgentHold(this.orchestrator, id);
				}
				continue;
			}
			if (this.runs(thread)) {
				this.logService.info(`[volt] ${id} is ${hold}: stopping its work`);
				void this.orchestrator.dispatch({ type: 'turn.cancel', threadId: id, cascade: 'all' });
			}
			// Another reason (a worktree or clone in the making) holds it already; it is looked at again when that ends.
			if (!thread.blocked || (isOrchHold(thread.blocked) && thread.blocked !== hold)) {
				void this.orchestrator.dispatch({ type: 'thread.block', threadId: id, reason: hold });
			}
		}
	}

	/** Work that runs, or would start on its own: what a stop with `cascade: 'all'` ends. */
	private runs(thread: IOrchThread): boolean {
		if ((thread.active && thread.active.phase !== 'cancelling') || thread.rescue || (thread.limit && !thread.active && thread.limit.auto !== false)) {
			return true;
		}
		if (thread.queue.length && !thread.pause) {
			return true;
		}
		return this.orchestrator.tasksOf(thread.id).some(task => task.source === 'volt' && isLiveTaskState(task.state));
	}
}

registerWorkbenchContribution2(AgentSettledRunGuardContribution.ID, AgentSettledRunGuardContribution, WorkbenchPhase.AfterRestored);

/**
 * Cmd+Z while the sidebar shows an Undo notice puts the chats back. Text fields and terminals keep
 * their own undo; the notice's 5 seconds keep the shortcut from taking over anywhere else.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_LIFECYCLE_UNDO_COMMAND_ID,
			title: localize2('voltAgent.undoLifecycle', "Undo Last Chat Settle, Snooze, Archive or Pin"),
			precondition: AgentLifecycleUndoContext,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyZ,
				// Above the editor's undo, which has no when clause of its own.
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: ContextKeyExpr.and(AgentLifecycleUndoContext, InputFocusedContext.negate(), ContextKeyExpr.not('terminalFocus')),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAgentThreadLifecycleService).undo();
	}
});
