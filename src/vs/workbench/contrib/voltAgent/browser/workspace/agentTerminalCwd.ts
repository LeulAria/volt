/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';

/**
 * In agent layout a new terminal (panel or editor) starts where the open chat works:
 * its worktree, else its project, else the active project. The window itself often has
 * no folder open, so without this the shell lands in the home folder.
 */
class AgentTerminalCwdContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentTerminalCwd';

	constructor(
		@ITerminalService terminalService: ITerminalService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
	) {
		super();
		terminalService.setDefaultCwdProvider(() => this.chatFolder());
		this._register({ dispose: () => terminalService.setDefaultCwdProvider(undefined) });
	}

	private chatFolder(): URI | undefined {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return undefined;
		}
		const editor = this.editorGroupsService.mainPart.activeGroup?.activeEditor;
		let folder: URI | undefined;
		if (editor instanceof AgentEditorInput) {
			const worktree = this.runtime.getOrCreateSession(editor.sessionId).worktreePath;
			folder = worktree ? URI.file(worktree) : this.sessionContext.rootFor(editor.sessionId);
		}
		folder ??= this.sessionContext.activeProject?.root;
		return folder?.scheme === Schemas.file ? folder : undefined;
	}
}

registerWorkbenchContribution2(AgentTerminalCwdContribution.ID, AgentTerminalCwdContribution, WorkbenchPhase.BlockRestore);
