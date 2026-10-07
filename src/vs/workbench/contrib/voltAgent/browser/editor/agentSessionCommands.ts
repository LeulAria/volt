/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { LayoutModeContext } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService, OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import type { AgentSidePanel } from '../chrome/agentSidePanel.js';
import { startAgentChat } from '../workspace/agentPanels.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { IAgentPaletteContext, registerAgentPaletteEntry, showAgentCommandPalette } from './agentCommandPalette.js';
import { AGENT_SIDE_PANEL_VIEW_ID, AgentEditorInput, NEW_AGENT_COMMAND_ID, OPEN_AGENT_HISTORY_COMMAND_ID } from './agentEditorInput.js';

export const NEW_AGENT_WITHOUT_PROJECT_COMMAND_ID = 'workbench.action.voltAgent.newChatWithoutProject';
export const RESTART_AGENT_SESSION_COMMAND_ID = 'workbench.action.voltAgent.restartAgentSession';
export const SHOW_AGENT_COMMANDS_COMMAND_ID = 'workbench.action.voltAgent.showAgentCommands';

const agentLayout = LayoutModeContext.isEqualTo('agent');
const category = localize2('voltAgent.category', "Volt Agent");

/** The chat a command acts on: the one on screen, else the side panel's. */
export function activeAgentSessionId(accessor: ServicesAccessor): string | undefined {
	const active = accessor.get(IEditorService).activeEditor;
	if (active instanceof AgentEditorInput) {
		return active.sessionId;
	}
	for (const group of accessor.get(IEditorGroupsService).mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
		if (group.activeEditor instanceof AgentEditorInput) {
			return group.activeEditor.sessionId;
		}
	}
	return accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID)?.getActiveAgentEditor()?.sessionId;
}

/** A chat with no project: its first send gives it a scratch folder of its own (see AgentScratchFolders). */
registerAction2(class NewAgentWithoutProjectAction extends Action2 {
	constructor() {
		super({
			id: NEW_AGENT_WITHOUT_PROJECT_COMMAND_ID,
			title: localize2('voltAgent.newChatWithoutProject', "New Chat Without Project"),
			category,
			f1: true,
			precondition: agentLayout,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN,
				weight: KeybindingWeight.WorkbenchContrib + 60,
				when: agentLayout,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		if (layoutService.isAuxiliaryBarMaximized()) {
			layoutService.setAuxiliaryBarMaximized(false);
		}
		await startAgentChat(
			accessor.get(IVoltSessionContextService),
			accessor.get(IAgentWorkspaceService),
			accessor.get(IAgentHistoryService),
			accessor.get(IEditorGroupsService),
			accessor.get(IInstantiationService),
			{ kind: 'none' },
		);
	}
});

/**
 * Stops the chat's agent so the next message starts a fresh one with the new skills, plugins and
 * MCP servers; the conversation carries over as a recap. A working agent is stopped first, if the
 * user agrees.
 */
registerAction2(class RestartAgentSessionAction extends Action2 {
	constructor() {
		super({
			id: RESTART_AGENT_SESSION_COMMAND_ID,
			title: localize2('voltAgent.restartAgentSession', "Restart Agent Session"),
			category,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
		const id = typeof sessionId === 'string' && sessionId ? sessionId : activeAgentSessionId(accessor);
		const notificationService = accessor.get(INotificationService);
		if (!id) {
			notificationService.info(localize('voltAgent.restart.noChat', "Open an agent chat to restart its session."));
			return;
		}
		const runtime = accessor.get(IAgentRuntimeService);
		const orchestrator = accessor.get(IAgentOrchestratorService);
		const dialogService = accessor.get(IDialogService);
		const running = !!orchestrator.getThread(id)?.active;
		if (running) {
			const { confirmed } = await dialogService.confirm({
				message: localize('voltAgent.restart.confirm', "Stop the agent and restart its session?"),
				detail: localize('voltAgent.restart.confirmDetail', "The agent is working. Restarting stops the current turn; the conversation stays."),
				primaryButton: localize({ key: 'voltAgent.restart.stopAndRestart', comment: ['&& denotes a mnemonic'] }, "&&Stop and Restart"),
			});
			if (!confirmed) {
				return;
			}
		}
		// The runtime marks the restart before it stops the turn, so a queued prompt that starts
		// next gets a fresh agent too; the orchestrator's own stop settles the turn and its subagents.
		const restarted = runtime.restartAgent(id, { cancel: running });
		if (running) {
			await orchestrator.cancel(id, { cascade: 'turn' });
		}
		if (await restarted) {
			notificationService.info(localize('voltAgent.restart.done', "Your next message starts a fresh agent session."));
		} else {
			notificationService.info(localize('voltAgent.restart.busy', "The agent started working; restart its session once it stops."));
		}
	}
});

/** The agent palette (Cmd+K in a chat): the chat commands, by name. */
registerAction2(class ShowAgentCommandsAction extends Action2 {
	constructor() {
		super({
			id: SHOW_AGENT_COMMANDS_COMMAND_ID,
			title: localize2('voltAgent.showAgentCommands', "Show Agent Commands"),
			category,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const given = context && typeof context === 'object' ? context as Partial<IAgentPaletteContext> : undefined;
		const sessionId = typeof given?.sessionId === 'string' ? given.sessionId : activeAgentSessionId(accessor);
		const running = typeof given?.running === 'boolean'
			? given.running
			: !!sessionId && !!accessor.get(IAgentOrchestratorService).getThread(sessionId)?.active;
		await showAgentCommandPalette(accessor, { sessionId, running });
	}
});

registerAgentPaletteEntry({
	id: 'newChat',
	label: localize('voltAgent.palette.newChat', "New Chat"),
	commandId: NEW_AGENT_COMMAND_ID,
	order: 10,
});
registerAgentPaletteEntry({
	id: 'newChatWithoutProject',
	label: localize('voltAgent.palette.newChatWithoutProject', "New Chat Without Project"),
	description: localize('voltAgent.palette.newChatWithoutProjectDetail', "Runs in a folder of its own"),
	commandId: NEW_AGENT_WITHOUT_PROJECT_COMMAND_ID,
	order: 20,
});
registerAgentPaletteEntry({
	id: 'restartAgentSession',
	label: localize('voltAgent.palette.restart', "Restart Agent Session"),
	description: localize('voltAgent.palette.restartDetail', "Pick up new skills, plugins and MCP servers"),
	commandId: RESTART_AGENT_SESSION_COMMAND_ID,
	args: context => [context.sessionId],
	enabled: context => !!context.sessionId,
	order: 30,
});
registerAgentPaletteEntry({
	id: 'searchChats',
	label: localize('voltAgent.palette.searchChats', "Search Chats"),
	commandId: OPEN_AGENT_HISTORY_COMMAND_ID,
	order: 60,
});
registerAgentPaletteEntry({
	id: 'quickOpen',
	label: localize('voltAgent.palette.quickOpen', "Go to File"),
	commandId: 'workbench.action.quickOpen',
	order: 70,
});
registerAgentPaletteEntry({
	id: 'openSettings',
	label: localize('voltAgent.palette.settings', "Open Settings"),
	commandId: OPEN_VOLT_SETTINGS_COMMAND_ID,
	order: 80,
});
