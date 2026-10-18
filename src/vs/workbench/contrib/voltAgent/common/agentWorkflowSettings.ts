/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { COMPACT_CHIP_THRESHOLD_SETTING, COMPACT_OLD_THREADS_SETTING } from '../../../services/voltRuntime/common/compaction.js';
import { HANDOFF_BUDGET_PERCENT_SETTING, HANDOFF_DEFAULT_MAX_TOKENS, HANDOFF_DEFAULT_PERCENT, HANDOFF_MAX_TOKENS_SETTING, HANDOFF_MIN_TOKENS } from '../../../services/voltRuntime/common/contextHandoff.js';
import { DEFAULT_ORCH_LIMITS, ORCH_KEEP_WORKING_SETTING, ORCH_LIMIT_MAX, ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_PER_CALL_SETTING, ORCH_RESUME_AFTER_RESTART_SETTING } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { LIMIT_AUTO_RESUME_SETTING, LIMIT_STOP_CLAUDE_SETTING } from '../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import { LEARN_FROM_RUNS_SETTING } from '../../../services/voltRuntime/common/harness/experience.js';

export { ORCH_MAX_PARALLEL_SETTING as AGENT_MULTITASK_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING as AGENT_MULTITASK_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_PER_CALL_SETTING as AGENT_MULTITASK_MAX_PER_CALL_SETTING, ORCH_RESUME_AFTER_RESTART_SETTING as AGENT_RESUME_AFTER_RESTART_SETTING, ORCH_KEEP_WORKING_SETTING as AGENT_KEEP_WORKING_SETTING, COMPACT_OLD_THREADS_SETTING as AGENT_COMPACT_OLD_THREADS_SETTING, LIMIT_AUTO_RESUME_SETTING as AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING };

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.workflow',
	title: localize('voltAgent.workflowConfigTitle', "Agent Workflow"),
	type: 'object',
	properties: {
		[ORCH_KEEP_WORKING_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.keepWorking', "Keep agents working until the task is done. When a chat's work stops part way (an error past the quick retries, an agent that crashed or stopped responding, Volt restarting or crashing, many automatic wake-ups in a row), Volt restarts it on its own: after 15 seconds, then waiting longer each time, at most 30 minutes apart, for as long as it takes. A turn that ends with its plan unfinished continues while it makes progress. Stopping a chat, or sending it something else, ends this. Usage limits are handled by their own settings."),
		},
		[LEARN_FROM_RUNS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.learnFromRuns', "Learn from finished work. After a long run, or one that got past errors, Volt reads what it did and keeps at most one lesson backed by what happened (a command this project really needs, the fix for an error that came back) as a project memory, so later chats do not pay to discover it again. Usually nothing is kept. Each reflection is one small request to the chat's model."),
		},
		[ORCH_RESUME_AFTER_RESTART_SETTING]: {
			type: 'string',
			enum: ['off', 'subagents', 'all'],
			enumDescriptions: [
				localize('voltAgent.resumeAfterRestart.off', "Nothing continues by itself. Interrupted chats and delegated tasks show Resume."),
				localize('voltAgent.resumeAfterRestart.subagents', "Delegated tasks that were running continue, so the chat waiting for their reports gets them. Your own chats show Resume."),
				localize('voltAgent.resumeAfterRestart.all', "Every chat and delegated task that was running continues at once, from its last finished step."),
			],
			default: 'all',
			description: localize('voltAgent.resumeAfterRestart', "What continues on its own when Volt restarts while agents are working. A turn continues through at most two restarts in a row."),
		},
		[ORCH_MAX_PARALLEL_SETTING]: {
			type: 'number',
			default: DEFAULT_ORCH_LIMITS.runningPerParent,
			minimum: 1,
			maximum: ORCH_LIMIT_MAX.runningPerParent,
			description: localize('voltAgent.multitaskMaxParallel', "How many multitask agents and subagents one chat runs at once. More wait their turn and start as others finish. Each one is its own agent session, so more at once costs more memory and usage."),
		},
		[ORCH_MAX_PARALLEL_TOTAL_SETTING]: {
			type: 'number',
			default: DEFAULT_ORCH_LIMITS.runningTotal,
			minimum: 1,
			maximum: ORCH_LIMIT_MAX.runningTotal,
			description: localize('voltAgent.multitaskMaxParallelTotal', "How many multitask agents and subagents run at once across all chats in this window. Never fewer than one chat's limit."),
		},
		[ORCH_MAX_PER_CALL_SETTING]: {
			type: 'number',
			default: DEFAULT_ORCH_LIMITS.spawnsPerCall,
			minimum: 1,
			maximum: ORCH_LIMIT_MAX.spawnsPerCall,
			description: localize('voltAgent.multitaskMaxPerCall', "How many multitask agents or subagents an agent can start in one go (one delegate_task call). It starts the rest once those report. Those over the running limits wait their turn."),
		},
		[LIMIT_AUTO_RESUME_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.autoResumeAfterLimit', "When a provider's usage limit stops a chat, continue it on its own once the limit resets (\"Continue where you left off\"). Without a reset time, Volt checks again with a growing delay. Each chat's banner can cancel or ask for it."),
		},
		[LIMIT_STOP_CLAUDE_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.stopAtClaudeLimit', "When Claude's usage limit stops a chat, stop there: the chat does not continue on its own or check again, and the Claude subagents still working in it are stopped, so Volt sends nothing more on the account. Resume from the chat's banner. Volt cannot turn off extra usage on your Claude account; with it on, Claude keeps going on credit without reporting a limit."),
		},
		[COMPACT_OLD_THREADS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.compactOldThreads', "Compact a large chat (100K tokens or more) before sending into it after it sat idle for over an hour. The provider's prompt cache has expired by then, so resending the whole history costs the most."),
		},
		[COMPACT_CHIP_THRESHOLD_SETTING]: {
			type: 'number',
			default: 80,
			minimum: 1,
			maximum: 100,
			description: localize('voltAgent.compactChipThreshold', "How full the context window must be (percent) before the composer offers \"Compact first\". A click arms it: your next message compacts the conversation first (the agent's own /compact when it has one, else Volt's handoff summary in a fresh session)."),
		},
		[HANDOFF_BUDGET_PERCENT_SETTING]: {
			type: 'number',
			default: HANDOFF_DEFAULT_PERCENT,
			minimum: 1,
			maximum: 50,
			description: localize('voltAgent.handoffBudgetPercent', "When a chat moves to another model or provider (or a fork starts), the share of the new model's context window the conversation handoff may take. Recent turns go verbatim, older ones condensed; never more than a third of the window."),
		},
		[HANDOFF_MAX_TOKENS_SETTING]: {
			type: 'number',
			default: HANDOFF_DEFAULT_MAX_TOKENS,
			minimum: HANDOFF_MIN_TOKENS,
			description: localize('voltAgent.handoffMaxTokens', "The most tokens a conversation handoff to another model may take, whatever its context window."),
		},
	},
});
