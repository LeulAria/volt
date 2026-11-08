/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorPane } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IVoltAgentWindowService, IVoltChatPane, IVoltToolsPanel } from '../../../../services/voltPlugins/browser/voltAgentWindow.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentSurfaceHost, openInAgentTools, openSideChatBeside, openSideChatOnScreen, revealAgentToolEditor } from './agentSurfaceHost.js';
import { hasSavedAgentTools } from './agentToolsEditorPart.js';
import { visibleChatSession } from './agentVisibleChat.js';

/** A chat pane, or undefined when what opened isn't one. */
function chatPane(pane: IEditorPane | undefined): IVoltChatPane | undefined {
	if (!(pane instanceof AgentEditor)) {
		return undefined;
	}
	return {
		showTranscript: () => pane.showTranscriptInTools(),
		submitPrompt: (prompt, display) => pane.submitPrompt(prompt, display ? { text: display.text } : undefined),
	};
}

function chatPaneOf(opened: Promise<IEditorPane | undefined> | undefined): Promise<IVoltChatPane | undefined> | undefined {
	return opened?.then(chatPane);
}

/** The agent window for feature modules (`IVoltAgentWindowService`), over the right panel's own helpers. */
export class VoltAgentWindowService implements IVoltAgentWindowService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) { }

	isAgentLayout(): boolean {
		return getLayoutMode(this.layoutService) === 'agent';
	}

	visibleChat(): string | undefined {
		return this.instantiationService.invokeFunction(visibleChatSession);
	}

	openInTools(input: EditorInput, sessionId?: string, options?: IEditorOptions): Promise<IEditorPane | undefined> | undefined {
		return openInAgentTools(input, sessionId, options);
	}

	revealInTools(input: EditorInput): boolean {
		return revealAgentToolEditor(input);
	}

	hasSavedTools(id: string): boolean {
		return hasSavedAgentTools(this.storageService, id);
	}

	createToolsPanel(frame: HTMLElement, content: HTMLElement): IVoltToolsPanel {
		const host = this.instantiationService.createInstance(AgentSurfaceHost, frame, content);
		return {
			present: id => host.present(id),
			canOpen: () => host.canOpenTools(),
			layout: dimension => host.layout(dimension),
			openNewChat: () => host.openEditorInTools(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri())).then(chatPane),
			dispose: () => host.dispose(),
		};
	}

	openSideChatBeside(element: HTMLElement): Promise<IVoltChatPane | undefined> | undefined {
		return chatPaneOf(openSideChatBeside(element));
	}

	openSideChatOnScreen(sessionId?: string): Promise<IVoltChatPane | undefined> | undefined {
		return chatPaneOf(openSideChatOnScreen(sessionId));
	}

	async openNewChat(): Promise<IVoltChatPane | undefined> {
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		return chatPane(await this.editorService.openEditor(input, { pinned: true }));
	}
}

registerSingleton(IVoltAgentWindowService, VoltAgentWindowService, InstantiationType.Delayed);
