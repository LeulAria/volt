/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { COMPACT_CHIP_THRESHOLD_SETTING, COMPACT_OLD_THREADS_SETTING } from '../../../services/voltRuntime/common/compaction.js';
import { HANDOFF_BUDGET_PERCENT_SETTING, HANDOFF_DEFAULT_MAX_TOKENS, HANDOFF_DEFAULT_PERCENT, HANDOFF_MAX_TOKENS_SETTING, HANDOFF_MIN_TOKENS } from '../../../services/voltRuntime/common/contextHandoff.js';
import { ORCH_RESUME_AFTER_RESTART_SETTING } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';

export { ORCH_RESUME_AFTER_RESTART_SETTING as AGENT_RESUME_AFTER_RESTART_SETTING, COMPACT_OLD_THREADS_SETTING as AGENT_COMPACT_OLD_THREADS_SETTING };

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.workflow',
	title: localize('voltAgent.workflowConfigTitle', "Agent Workflow"),
	type: 'object',
	properties: {
		[ORCH_RESUME_AFTER_RESTART_SETTING]: {
			type: 'string',
			enum: ['off', 'subagents', 'all'],
			enumDescriptions: [
				localize('voltAgent.resumeAfterRestart.off', "Nothing continues by itself. Interrupted chats and delegated tasks show Resume."),
				localize('voltAgent.resumeAfterRestart.subagents', "Delegated tasks that were running continue, so the chat waiting for their reports gets them. Your own chats show Resume."),
				localize('voltAgent.resumeAfterRestart.all', "Every chat and delegated task that was running continues."),
			],
			default: 'subagents',
			description: localize('voltAgent.resumeAfterRestart', "What continues on its own when Volt restarts while agents are working. A turn continues through at most two restarts in a row."),
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
