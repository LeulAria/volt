/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { NEW_AGENT_SCHEDULE_COMMAND_ID, OPEN_AGENT_SCHEDULES_COMMAND_ID } from '../schedules/agentScheduleCommands.js';
import { registerAgentPaletteEntry } from './agentCommandPalette.js';
import { activeAgentSessionId } from './agentSessionCommands.js';

/** `(sessionId?: string)`: compacts the chat's context as its next turn (the active chat by default). */
export const COMPACT_AGENT_CONTEXT_COMMAND_ID = 'workbench.action.voltAgent.compactContext';

registerAction2(class CompactAgentContextAction extends Action2 {
	constructor() {
		super({
			id: COMPACT_AGENT_CONTEXT_COMMAND_ID,
			title: localize2('voltAgent.compactContext', "Compact Context"),
			category: localize2('voltAgent.category', "Volt Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		const id = typeof sessionId === 'string' && sessionId ? sessionId : activeAgentSessionId(accessor);
		const notificationService = accessor.get(INotificationService);
		if (!id || !accessor.get(IAgentRuntimeService).supportsCommand(id, 'compact')) {
			notificationService.info(localize('voltAgent.compactNothing', "This chat has nothing to compact yet."));
			return;
		}
		// Like the Compact context chip: a /compact turn, queued behind whatever the chat is doing.
		await accessor.get(IAgentOrchestratorService).submit(id, { text: '/compact', mode: 'Agent' }, 'auto');
	}
});

registerAgentPaletteEntry({
	id: 'compactContext',
	label: localize('voltAgent.palette.compact', "Compact Context"),
	description: localize('voltAgent.palette.compactDetail', "Summarize the conversation so far to free up context"),
	commandId: COMPACT_AGENT_CONTEXT_COMMAND_ID,
	args: context => [context.sessionId],
	enabled: context => !!context.sessionId,
	order: 35,
});

registerAgentPaletteEntry({
	id: 'schedulePrompt',
	label: localize('voltAgent.palette.schedule', "Schedule a Prompt…"),
	description: localize('voltAgent.palette.scheduleDetail', "Run a prompt in this chat on a schedule"),
	commandId: NEW_AGENT_SCHEDULE_COMMAND_ID,
	args: context => [{ threadId: context.sessionId }],
	order: 60,
});

registerAgentPaletteEntry({
	id: 'scheduledTasks',
	label: localize('voltAgent.palette.schedules', "Scheduled Tasks"),
	commandId: OPEN_AGENT_SCHEDULES_COMMAND_ID,
	order: 61,
});
