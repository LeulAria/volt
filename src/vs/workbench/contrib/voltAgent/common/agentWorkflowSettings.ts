/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { COMPACT_OLD_THREADS_SETTING } from '../../../services/voltRuntime/common/compaction.js';
import { ORCH_RESUME_AFTER_RESTART_SETTING } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { LIMIT_AUTO_RESUME_SETTING } from '../../../services/voltRuntime/common/orchestration/limitRecovery.js';

export { ORCH_RESUME_AFTER_RESTART_SETTING as AGENT_RESUME_AFTER_RESTART_SETTING, COMPACT_OLD_THREADS_SETTING as AGENT_COMPACT_OLD_THREADS_SETTING, LIMIT_AUTO_RESUME_SETTING as AGENT_AUTO_RESUME_AFTER_LIMIT_SETTING };

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
		[LIMIT_AUTO_RESUME_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.autoResumeAfterLimit', "When a provider's usage limit stops a chat, continue it on its own once the limit resets (\"Continue where you left off\"). Without a reset time, Volt checks again with a growing delay. Each chat's banner can cancel or ask for it."),
		},
		[COMPACT_OLD_THREADS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.compactOldThreads', "Compact a large chat (100K tokens or more) before sending into it after it sat idle for over an hour. The provider's prompt cache has expired by then, so resending the whole history costs the most."),
		},
	},
});
