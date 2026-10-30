/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { COMPACT_CHIP_THRESHOLD_SETTING, COMPACT_OLD_THREADS_SETTING } from '../../../services/voltRuntime/common/compaction.js';
import { HANDOFF_BUDGET_PERCENT_SETTING, HANDOFF_DEFAULT_MAX_TOKENS, HANDOFF_DEFAULT_PERCENT, HANDOFF_MAX_TOKENS_SETTING, HANDOFF_MIN_TOKENS } from '../../../services/voltRuntime/common/contextHandoff.js';
import { DEFAULT_ORCH_LIMITS, ORCH_BUDGET_TOKENS_SETTING, ORCH_BUDGET_USD_SETTING, ORCH_DEFAULT_BUDGET_USD, ORCH_KEEP_WORKING_SETTING, ORCH_LIMIT_MAX, ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_PER_CALL_SETTING, ORCH_RESUME_AFTER_RESTART_SETTING, ORCH_ROLE_MODELS_SETTING } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { LIMIT_AUTO_RESUME_SETTING, LIMIT_STOP_CLAUDE_SETTING } from '../../../services/voltRuntime/common/orchestration/limitRecovery.js';
import { LEARN_FROM_RUNS_SETTING } from '../../../services/voltRuntime/common/harness/experience.js';
import { EVIDENCE_GATE_SETTING, PROOF_REVIEW_SETTING } from '../../../services/voltRuntime/common/harness/evidenceObserver.js';
import { PROMPT_CACHE_KEEPALIVE_SETTING } from '../../../services/voltRuntime/common/deepseek/loop.js';

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
		[PROMPT_CACHE_KEEPALIVE_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.promptCacheKeepAlive', "Keep Claude's prompt cache warm while a run waits. Claude keeps a chat's prompt cached for five minutes; when a long command, a delegated task or your approval holds the run longer, Volt reads the prompt again shortly before it expires (at most six times per wait), so the next step costs a tenth of the input price instead of a full rewrite of the cache."),
		},
		[EVIDENCE_GATE_SETTING]: {
			type: 'string',
			enum: ['substantial', 'always', 'off'],
			enumDescriptions: [
				localize('voltAgent.evidenceGate.substantial', "Substantial runs (a large request, one that names a check, or one that has changed several files) can only finish once their checks pass after the last edit. Quick edits finish at once."),
				localize('voltAgent.evidenceGate.always', "Every run that changes files is held to its receipt."),
				localize('voltAgent.evidenceGate.off', "Nothing is held back. Runs still get a receipt of what was checked."),
			],
			default: 'substantial',
			markdownDescription: localize('voltAgent.evidenceGate', "Proof of done. Volt turns each request into a short list of what \"done\" means (your own criteria, the project's own check, the change itself), and when an agent says it has finished, checks each item against what actually ran after its last edit. A check that failed, went stale or never ran sends the agent back with the exact gap and the command that closes it, a few times at most. Each run that checked something ends with a receipt showing each item and its proof."),
		},
		[PROOF_REVIEW_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.proofReview', "Get a second opinion before a substantial run finishes. Once its checks pass, one small request to the chat's model reads the request and the diff with a clean context (none of the agent's own reasoning) and says whether every requested change is really made. A miss sends the agent back once. It is shown on the run's receipt."),
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
		[ORCH_BUDGET_USD_SETTING]: {
			type: 'number',
			default: ORCH_DEFAULT_BUDGET_USD,
			minimum: 0,
			description: localize('voltAgent.multitaskBudgetUsd', "What the subagents of one request may spend together, in US dollars (the agent's reported cost, else list price). Past it, Volt stops the subagents still working, tells the chat why, and starts no more until your next message. 0 turns the limit off."),
		},
		[ORCH_BUDGET_TOKENS_SETTING]: {
			type: 'number',
			default: 0,
			minimum: 0,
			description: localize('voltAgent.multitaskBudgetTokens', "The same limit in tokens (input, output and cache writes; cache reads are not counted), for models Volt has no price for. 0 turns it off."),
		},
		[ORCH_ROLE_MODELS_SETTING]: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'string' },
			properties: {
				default: { type: 'string', description: localize('voltAgent.roleModels.default', "Model for roles not listed here.") },
				research: { type: 'string', description: localize('voltAgent.roleModels.research', "Model for research tasks (read-only).") },
				review: { type: 'string', description: localize('voltAgent.roleModels.review', "Model for reviews (read-only). A model from another vendor than the one that wrote the code gives a real second opinion.") },
				implementation: { type: 'string', description: localize('voltAgent.roleModels.implementation', "Model for implementation tasks.") },
				test: { type: 'string', description: localize('voltAgent.roleModels.test', "Model for test tasks.") },
				design: { type: 'string', description: localize('voltAgent.roleModels.design', "Model for UI and design tasks.") },
				general: { type: 'string', description: localize('voltAgent.roleModels.general', "Model for general tasks.") },
			},
			markdownDescription: localize('voltAgent.multitaskRoleModels', "The model a subagent runs on when its agent asks for `model: \"auto\"`, by task role. Values are models as the model picker names them (`claude-code:claude-haiku-5-5`, `codex:gpt-6-sol`, or a label such as `Sonnet 5.5`). A role without an entry uses `default`, else the chat's model."),
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
