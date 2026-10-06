/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { LayoutModeContext } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { startAgentChat } from '../workspace/agentPanels.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

export const NEW_AGENT_WITHOUT_PROJECT_COMMAND_ID = 'workbench.action.voltAgent.newChatWithoutProject';

const agentLayout = LayoutModeContext.isEqualTo('agent');

/** A chat with no project: its first send gives it a scratch folder of its own (see AgentScratchFolders). */
registerAction2(class NewAgentWithoutProjectAction extends Action2 {
	constructor() {
		super({
			id: NEW_AGENT_WITHOUT_PROJECT_COMMAND_ID,
			title: localize2('voltAgent.newChatWithoutProject', "New Chat Without Project"),
			category: localize2('voltAgent.category', "Volt Agent"),
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
