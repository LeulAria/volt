/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension } from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IAgentHistoryService } from '../../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../../services/voltRuntime/common/sessionContext.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { AgentEditor } from '../../editor/agentEditor.js';
import { AgentEditorInput } from '../../editor/agentEditorInput.js';
import { attachSessionToProject } from '../../workspace/agentShell.js';
import { IAgentWorkspaceService } from '../../workspace/agentWorkspace.js';
import { ICanvasAgentChat } from './canvasAgent.js';

/**
 * The canvas's agent as a real chat (the one the browser dock runs hidden): its composer with the
 * model picker, its transcript streaming, in the compact chrome side chats use. It is a side chat of
 * the chat that made the canvas, in that chat's project.
 */
export async function createCanvasAgentChat(instantiationService: IInstantiationService, sessionId: string, parentChat: string | undefined): Promise<ICanvasAgentChat> {
	const [groups, history, workspace, sessionContext] = instantiationService.invokeFunction(accessor => [
		accessor.get(IEditorGroupsService),
		accessor.get(IAgentHistoryService),
		accessor.get(IAgentWorkspaceService),
		accessor.get(IVoltSessionContextService),
	] as const);
	if (parentChat) {
		history.pinSessionParent(sessionId, parentChat);
		const parent = workspace.get(parentChat);
		const project = (parent?.projectId ? sessionContext.getProject(parent.projectId) : undefined) ?? sessionContext.activeProject;
		if (project && !workspace.get(sessionId)?.projectId) {
			attachSessionToProject(sessionContext, workspace, history, sessionId, project);
		}
	}
	const element = $('.volt-canvas-agent-chat');
	const input = instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(sessionId));
	const editor = instantiationService.createInstance(AgentEditor, groups.activeGroup);
	editor.create(element);
	editor.layout(new Dimension(340, 480));
	await editor.setInput(input, { preserveFocus: true }, {}, CancellationToken.None);
	editor.setBrowserHosted(true);
	return {
		element,
		onDidSend: editor.onDidComposerSend,
		layout: (width, height) => {
			if (width > 0 && height > 0) {
				editor.layout(new Dimension(width, height));
				editor.setBrowserHosted(true);
			}
		},
		submit: text => editor.submitPrompt(text),
		draft: text => editor.prefillDraft(text),
		dispose: () => {
			editor.dispose();
			input.dispose();
			element.remove();
		},
	};
}
