/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltVisualPreviewService, VOLT_VISUAL_PREVIEW_CHANNEL_NAME } from '../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { AgentGalleryToolProvider } from '../browser/visuals/agentGalleryTools.js';
import { disposeLiveVisuals } from '../browser/visuals/agentVisuals.js';
import { AgentVisualToolProvider } from '../browser/visuals/agentVisualTools.js';
import { setCanvasAgentChatFactory } from '../browser/visuals/canvas/canvasAgent.js';
import { createCanvasAgentChat } from '../browser/visuals/canvas/canvasAgentChat.js';
import { OPEN_CANVAS_COMMAND_ID } from '../browser/visuals/canvas/canvasCard.js';
import { CANVAS_EDITOR_ID, CanvasEditor, CanvasEditorInput, CanvasEditorInputSerializer } from '../browser/visuals/canvas/canvasEditor.js';
import { IVoltCanvasService, VoltCanvasService } from '../browser/visuals/canvas/canvasService.js';
import { AgentCanvasToolProvider } from '../browser/visuals/canvas/canvasTools.js';
import { agentToolsSessionOnScreen, openInAgentTools } from '../browser/workspace/agentSurfaceHost.js';

// Pages are measured and screenshotted offscreen in the main process.
registerMainProcessRemoteService(IVoltVisualPreviewService, VOLT_VISUAL_PREVIEW_CHANNEL_NAME);

/**
 * Puts render_chart, html_render and html_preview, the galleries (mockups_render,
 * screens_capture) and the design canvas (canvas_render, canvas_update, canvas_read) on Volt's
 * MCP server before any agent connects.
 */
class AgentVisualsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentVisuals';

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IInstantiationService instantiationService: IInstantiationService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
	) {
		super();
		const provider = this._register(instantiationService.createInstance(AgentVisualToolProvider));
		this._register(hostTools.registerToolProvider(provider));
		const galleries = this._register(instantiationService.createInstance(AgentGalleryToolProvider, joinPath(environmentService.tmpDir, 'volt-screens')));
		this._register(hostTools.registerToolProvider(galleries));
		const canvases = this._register(instantiationService.createInstance(AgentCanvasToolProvider));
		this._register(hostTools.registerToolProvider(canvases));
		this._register(disposeLiveVisuals());
	}
}

registerWorkbenchContribution2(AgentVisualsContribution.ID, AgentVisualsContribution, WorkbenchPhase.BlockRestore);

// The design canvas: one store per window, a tab beside the chat, and the command that opens it.
registerSingleton(IVoltCanvasService, VoltCanvasService, InstantiationType.Delayed);
// Each canvas's own agent, in its sidebar, is a real chat.
setCanvasAgentChatFactory(createCanvasAgentChat);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(CanvasEditor, CANVAS_EDITOR_ID, localize('voltCanvas.editorLabel', "Design Canvas")),
	[new SyncDescriptor(CanvasEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(CanvasEditorInput.TypeID, CanvasEditorInputSerializer);

CommandsRegistry.registerCommand(OPEN_CANVAS_COMMAND_ID, async (accessor, canvasId: unknown, frame?: unknown) => {
	if (typeof canvasId !== 'string' || !canvasId) {
		return;
	}
	const editorService = accessor.get(IEditorService);
	const canvases = accessor.get(IVoltCanvasService);
	const focus = typeof frame === 'string' && frame ? frame : undefined;
	const existing = editorService.editors.find((editor): editor is CanvasEditorInput => editor instanceof CanvasEditorInput && editor.canvasId === canvasId);
	const doc = await canvases.get(canvasId);
	const input = existing ?? new CanvasEditorInput(canvasId, doc?.title, focus);
	if (existing && focus) {
		existing.requestFocus(focus);
	}
	// Beside the chat in the agent layout; a normal editor tab in the IDE layout.
	const opened = openInAgentTools(input, agentToolsSessionOnScreen());
	if (opened) {
		await opened;
	} else {
		await editorService.openEditor(input, { pinned: true });
	}
});
