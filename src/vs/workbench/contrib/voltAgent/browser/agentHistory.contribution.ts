/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { EditorExtensions, IEditorCommandsContext, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/agentHistory.js';
import { renderTranscriptMarkdown } from '../../../services/voltRuntime/common/agentHistoryLog.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import {
	AGENT_EDITOR_ID,
	AGENT_SIDE_PANEL_VIEW_ID,
	AgentEditorInput,
	EXPORT_AGENT_TRANSCRIPT_COMMAND_ID,
	OPEN_AGENT_COMMAND_ID,
	OPEN_AGENT_CUSTOMIZE_COMMAND_ID,
	NEW_AGENT_TAB_COMMAND_ID,
	OPEN_AGENT_HISTORY_COMMAND_ID,
	REPLACE_AGENT_COMMAND_ID,
	TOGGLE_AGENT_DRAWER_COMMAND_ID,
} from './agentEditorInput.js';
import { AGENT_CUSTOMIZE_EDITOR_ID, AgentCustomizeEditor, AgentCustomizeEditorInput, AgentCustomizeEditorInputSerializer } from './agentCustomizeEditor.js';
import { AgentSidePanel } from './agentSidePanel.js';
import { OPEN_BROWSER_COMMAND_ID } from './browserEditorInput.js';

const agentTitleActions = ContextKeyExpr.or(
	ActiveEditorContext.isEqualTo(AGENT_EDITOR_ID),
	ActiveEditorContext.isEqualTo(AGENT_CUSTOMIZE_EDITOR_ID),
);

async function showAgentSidePanel(accessor: ServicesAccessor, focus: boolean): Promise<AgentSidePanel | undefined> {
	accessor.get(IWorkbenchLayoutService).setPartHidden(false, Parts.AUXILIARYBAR_PART);
	return (await accessor.get(IViewsService).openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, focus)) ?? undefined;
}

function isEditorCommandsContext(value: unknown): value is IEditorCommandsContext {
	return !!value && typeof value === 'object' && typeof (value as IEditorCommandsContext).groupId === 'number';
}

/** The agent input the command was invoked for: the tab bar's group first, then the active editor. */
function resolveAgentInput(accessor: ServicesAccessor, context: unknown): AgentEditorInput | undefined {
	if (isEditorCommandsContext(context)) {
		const group = accessor.get(IEditorGroupsService).getGroup(context.groupId);
		const editor = context.editorIndex !== undefined ? group?.getEditorByIndex(context.editorIndex) : group?.activeEditor;
		if (editor instanceof AgentEditorInput) {
			return editor;
		}
	}
	const active = accessor.get(IEditorService).activeEditor;
	if (active instanceof AgentEditorInput) {
		return active;
	}
	const view = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
	const input = view?.getActiveAgentEditor()?.input;
	return input instanceof AgentEditorInput ? input : undefined;
}

//#region Tab bar: +, clock, drawer

registerAction2(class NewAgentTabAction extends Action2 {
	constructor() {
		super({
			id: NEW_AGENT_TAB_COMMAND_ID,
			title: localize2('voltAgent.newAgentTab', "New Agent"),
			icon: Codicon.plus,
			f1: false,
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: 10, when: agentTitleActions },
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const view = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
		const groupId = isEditorCommandsContext(context) ? context.groupId : undefined;
		if (view && groupId !== undefined && view.getGroup(groupId)) {
			await view.openNewAgent({ groupId });
			return;
		}
		await accessor.get(IEditorService).openEditor({ resource: AgentEditorInput.getNewEditorUri(), options: { pinned: true } });
	}
});

registerAction2(class ReplaceAgentAction extends Action2 {
	constructor() {
		super({
			id: REPLACE_AGENT_COMMAND_ID,
			title: localize2('voltAgent.replaceAgent', "Replace Agent"),
			category: Categories.View,
			f1: true,
		});
	}

	/** Swaps the agent in place instead of adding a tab (⌥-click on `+`). */
	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const view = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
		const groupId = isEditorCommandsContext(context) ? context.groupId : undefined;
		if (view && (groupId === undefined || view.getGroup(groupId))) {
			await view.replaceAgent(groupId);
			return;
		}
		const groups = accessor.get(IEditorGroupsService);
		const group = (groupId !== undefined ? groups.getGroup(groupId) : undefined) ?? groups.activeGroup;
		const previous = group.activeEditor;
		await group.openEditor(accessor.get(IInstantiationService).createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri()), { pinned: true });
		if (previous) {
			await group.closeEditor(previous);
		}
	}
});

registerAction2(class ShowAgentHistoryAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_HISTORY_COMMAND_ID,
			title: localize2('voltAgent.showHistory', "Show Agent History"),
			icon: Codicon.history,
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: 20, when: agentTitleActions },
		});
	}

	/** The tab-bar icon opens a dropdown (see AgentEditor.getActionViewItem); everywhere else opens the drawer. */
	override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await showAgentSidePanel(accessor, false);
		view?.setDrawerOpen(true, true);
	}
});

registerAction2(class ToggleAgentDrawerAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_AGENT_DRAWER_COMMAND_ID,
			title: localize2('voltAgent.toggleDrawer', "Toggle Agents Side Bar"),
			icon: Codicon.layoutSidebarRight,
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyU,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const viewsService = accessor.get(IViewsService);
		const existing = viewsService.getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
		const showing = layoutService.isVisible(Parts.AUXILIARYBAR_PART) && viewsService.isViewVisible(AGENT_SIDE_PANEL_VIEW_ID);
		if (existing && showing) {
			existing.toggleDrawer();
			return;
		}
		const view = await showAgentSidePanel(accessor, false);
		view?.setDrawerOpen(true, true);
	}
});

registerAction2(class OpenAgentSessionAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_COMMAND_ID,
			title: localize2('voltAgent.openSession', "Open Agent Session"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		if (typeof sessionId !== 'string' || !sessionId) {
			return;
		}
		const view = await showAgentSidePanel(accessor, false);
		await view?.openSession(sessionId);
	}
});

//#endregion

//#region Customize tab

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentCustomizeEditor, AGENT_CUSTOMIZE_EDITOR_ID, localize('voltCustomize.editorLabel', "Customize")),
	[new SyncDescriptor(AgentCustomizeEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AgentCustomizeEditorInput.TypeID,
	AgentCustomizeEditorInputSerializer
);

registerAction2(class OpenAgentCustomizeAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_CUSTOMIZE_COMMAND_ID,
			title: localize2('voltAgent.customize', "Customize Agent"),
			category: Categories.View,
			icon: Codicon.extensions,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await showAgentSidePanel(accessor, false);
		if (view) {
			await view.openCustomize();
			return;
		}
		const input = accessor.get(IInstantiationService).createInstance(AgentCustomizeEditorInput);
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
	}
});

//#endregion

//#region More actions (...)

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: OPEN_BROWSER_COMMAND_ID, title: localize('voltAgent.menu.openBrowser', "Open Browser") },
	group: '1_volt_browser',
	order: 10,
	when: agentTitleActions,
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: OPEN_VOLT_SETTINGS_COMMAND_ID, title: localize('voltAgent.menu.agentSettings', "Agent Settings") },
	group: '2z_volt_settings',
	order: 10,
	when: agentTitleActions,
});

registerAction2(class ExportAgentTranscriptAction extends Action2 {
	constructor() {
		super({
			id: EXPORT_AGENT_TRANSCRIPT_COMMAND_ID,
			title: localize2('voltAgent.exportTranscript', "Export Transcript"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.EditorTitle, group: '2_volt_transcript', order: 10, when: agentTitleActions },
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const history = accessor.get(IAgentHistoryService);
		const notifications = accessor.get(INotificationService);
		const input = resolveAgentInput(accessor, context);
		if (!input || !history.has(input.sessionId)) {
			notifications.info(localize('voltAgent.exportEmpty', "This agent has no messages to export yet."));
			return;
		}
		const handle = history.open(input.sessionId);
		await handle.flush();
		const transcript = await handle.load();
		if (!transcript.turns.length) {
			notifications.info(localize('voltAgent.exportEmpty', "This agent has no messages to export yet."));
			return;
		}
		const meta = history.get(input.sessionId);
		const title = meta?.title || transcript.title || localize('voltAgent.exportUntitled', "Agent transcript");

		const dialogs = accessor.get(IFileDialogService);
		const target = await dialogs.showSaveDialog({
			title: localize('voltAgent.exportTitle', "Export Agent Transcript"),
			defaultUri: joinPath(await dialogs.defaultFilePath(), `${fileSafe(title)}.md`),
			filters: [{ name: localize('voltAgent.exportMarkdown', "Markdown"), extensions: ['md'] }],
		});
		if (!target) {
			return;
		}
		const markdown = renderTranscriptMarkdown(title, transcript, at => new Date(at).toLocaleString());
		await accessor.get(IFileService).writeFile(target, VSBuffer.fromString(markdown));
	}
});

function fileSafe(name: string): string {
	return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'agent-transcript';
}

//#endregion
