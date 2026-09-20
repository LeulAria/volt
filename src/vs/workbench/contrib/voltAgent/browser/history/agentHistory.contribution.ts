/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAncestorOfActiveElement } from '../../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { renderTranscriptMarkdown } from '../../../../services/voltRuntime/common/history/agentHistoryLog.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import {
	AGENT_EDITOR_ID,
	AGENT_SIDE_PANEL_VIEW_ID,
	AgentEditorInput,
	EXPORT_AGENT_TRANSCRIPT_COMMAND_ID,
	OPEN_AGENT_COMMAND_ID,
	OPEN_AGENT_CUSTOMIZE_COMMAND_ID,
	NEW_AGENT_TAB_COMMAND_ID,
	OPEN_AGENT_HISTORY_COMMAND_ID,
	OPEN_AGENT_SEARCH_COMMAND_ID,
	REPLACE_AGENT_COMMAND_ID,
	TOGGLE_AGENT_DRAWER_COMMAND_ID,
} from '../editor/agentEditorInput.js';
import { AGENT_CUSTOMIZE_EDITOR_ID, AgentCustomizeEditor, AgentCustomizeEditorInput, AgentCustomizeEditorInputSerializer } from '../customize/agentCustomizeEditor.js';
import { findEditorCommandsContext } from '../editor/agentEditorCommandsContext.js';
import { toggleAgentSearchPalette } from '../search/agentSearchPalette.js';
import { AgentSidePanel } from '../chrome/agentSidePanel.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';

const agentTitleActions = ContextKeyExpr.or(
	ActiveEditorContext.isEqualTo(AGENT_EDITOR_ID),
	ActiveEditorContext.isEqualTo(AGENT_CUSTOMIZE_EDITOR_ID),
);

async function showAgentSidePanel(accessor: ServicesAccessor, focus: boolean): Promise<AgentSidePanel | undefined> {
	accessor.get(IWorkbenchLayoutService).setPartHidden(false, Parts.AUXILIARYBAR_PART);
	return (await accessor.get(IViewsService).openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, focus)) ?? undefined;
}

async function searchAgentSessions(accessor: ServicesAccessor): Promise<void> {
	const history = accessor.get(IAgentHistoryService);
	await history.whenReady;
	const items = history.list({ limit: 80 }).map(session => ({
		label: session.title || session.preview || session.id,
		description: session.workspaceLabel,
		detail: session.summary || (session.title ? session.preview : undefined),
		sessionId: session.id,
	} satisfies IQuickPickItem & { sessionId: string }));
	const picked = await accessor.get(IQuickInputService).pick(items, {
		placeHolder: localize('voltAgent.home.searchSessions', "Search chats"),
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (picked) {
		const view = await showAgentSidePanel(accessor, false);
		await view?.openSession(picked.sessionId);
	}
}

/** Open (or replace) a new agent in the group that owns the `+`, not the other pane. */
async function openNewAgentInFocusedGroup(accessor: ServicesAccessor, replace: boolean, ...args: unknown[]): Promise<void> {
	const groups = accessor.get(IEditorGroupsService);
	const view = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
	const groupId = findEditorCommandsContext(args)?.groupId;
	const inSidePanel = !!view && (
		(groupId !== undefined && !!view.getGroup(groupId))
		|| isAncestorOfActiveElement(view.element)
	);
	if (view && inSidePanel) {
		if (replace) {
			await view.replaceAgent(groupId);
		} else {
			await view.openNewAgent(groupId !== undefined ? { groupId } : undefined);
		}
		return;
	}
	const layoutService = accessor.get(IWorkbenchLayoutService);
	if (getLayoutMode(layoutService) === 'agent' && layoutService.isAuxiliaryBarMaximized()) {
		layoutService.setAuxiliaryBarMaximized(false);
	}
	const group = (groupId !== undefined ? groups.getGroup(groupId) : undefined) ?? groups.activeGroup;
	const input = accessor.get(IInstantiationService).createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
	const previous = replace ? group.activeEditor : undefined;
	await group.openEditor(input, { pinned: true });
	if (previous) {
		await group.closeEditor(previous);
	}
}

/** The agent input the command was invoked for: the tab bar's group first, then the active editor. */
function resolveAgentInput(accessor: ServicesAccessor, ...args: unknown[]): AgentEditorInput | undefined {
	const context = findEditorCommandsContext(args);
	if (context) {
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

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await openNewAgentInFocusedGroup(accessor, false, ...args);
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
	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await openNewAgentInFocusedGroup(accessor, true, ...args);
	}
});

registerAction2(class OpenAgentSearchAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_SEARCH_COMMAND_ID,
			title: localize2('voltAgent.search', "Search"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		toggleAgentSearchPalette(accessor.get(IInstantiationService));
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
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 20,
				when: ContextKeyExpr.and(
					agentTitleActions,
					ContextKeyExpr.equals('config.workbench.sideBar.location', 'left'),
				),
			},
		});
	}

	/** The tab-bar icon opens a dropdown (see AgentEditor.getActionViewItem); everywhere else opens the drawer. */
	override async run(accessor: ServicesAccessor): Promise<void> {
		if (getLayoutMode(accessor.get(IWorkbenchLayoutService)) === 'agent') {
			await searchAgentSessions(accessor);
			return;
		}
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

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const history = accessor.get(IAgentHistoryService);
		const notifications = accessor.get(INotificationService);
		const input = resolveAgentInput(accessor, ...args);
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
