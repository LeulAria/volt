/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ICodeEditor, IOverlayWidget, isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IListService } from '../../../../../platform/list/browser/listService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { ActiveEditorContext, AuxiliaryBarVisibleContext, IsAuxiliaryWindowContext, ResourceContextKey } from '../../../../common/contextkeys.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { getMultiSelectedResources, IExplorerService } from '../../../files/browser/files.js';
import { ExplorerFolderContext } from '../../../files/common/files.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { AgentChangesEditor, AgentChangesEditorInput, AgentChangesEditorInputSerializer, AGENT_CHANGES_EDITOR_ID, OPEN_AGENT_CHANGES_COMMAND_ID, openAgentChanges } from '../review/agentChangesEditor.js';
import '../review/agentChangesActions.js';
import { AgentEditor } from './agentEditor.js';
import { AgentChangesMultiDiffSourceResolver, AgentSnapshotContentProvider, parseAgentChangesSourceUri } from '../review/agentSessionChangesService.js';
import { IMultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { normalizeBrowserUrl, VoltBrowserEditor } from '../preview/browserEditor.js';
import {
	BROWSER_EDITOR_ID,
	OPEN_BROWSER_COMMAND_ID,
	OpenBrowserIcon,
	VoltBrowserEditorInput,
	VoltBrowserEditorInputSerializer,
} from '../preview/browserEditorInput.js';
import { CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID } from '../../../../services/voltRuntime/common/hostTools.js';
import {
	AGENT_EDITOR_ID,
	AGENT_EDITOR_LINE_NUMBERS_SETTING,
	AGENT_FIND_COMMAND_ID,
	AGENT_FIND_HIDE_COMMAND_ID,
	AGENT_FIND_NEXT_COMMAND_ID,
	AGENT_FIND_PREVIOUS_COMMAND_ID,
	AGENT_FIND_TOGGLE_CASE_COMMAND_ID,
	AGENT_FIND_TOGGLE_REGEX_COMMAND_ID,
	AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID,
	AGENT_SIDE_PANEL_ID,
	AGENT_SIDE_PANEL_VIEW_ID,
	AGENT_SUBMIT_COMMAND_ID,
	AgentEditorInput,
	AgentEditorInputSerializer,
	NEW_AGENT_COMMAND_ID,
	OPEN_AGENT_SIDE_PANEL_COMMAND_ID,
	AgentSidePanelIcon,
} from './agentEditorInput.js';
import { CONTEXT_AGENT_FIND_INPUT_FOCUSED, CONTEXT_AGENT_FIND_WIDGET_VISIBLE, CONTEXT_IN_AGENT_INPUT } from './agentFindWidget.js';
import { AgentSidePanel } from '../chrome/agentSidePanel.js';
import {
	CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
	CONTEXT_INLINE_COMMENT_VISIBLE,
	INLINE_COMMENT_CLOSE_COMMAND_ID,
	INLINE_COMMENT_COMMAND_ID,
	INLINE_COMMENT_KEEP_COMMAND_ID,
	INLINE_COMMENT_UNDO_COMMAND_ID,
} from '../review/inlineCommentActions.js';
import { InlineCommentController } from '../review/inlineCommentController.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agent',
	title: localize('voltAgent.configTitle', "Agent Text Area"),
	type: 'object',
	properties: {
		[AGENT_EDITOR_LINE_NUMBERS_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltAgent.lineNumbers', "Show line numbers in the agent text area."),
		},
	},
});

const agentSidePanelContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_SIDE_PANEL_ID,
	title: localize2('voltAgent.sidePanel.title', "Agents"),
	icon: Codicon.robot,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_SIDE_PANEL_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_SIDE_PANEL_ID,
	hideIfEmpty: false,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AGENT_SIDE_PANEL_VIEW_ID,
	containerIcon: agentSidePanelContainer.icon,
	containerTitle: agentSidePanelContainer.title.value,
	singleViewPaneContainerTitle: agentSidePanelContainer.title.value,
	name: localize2('voltAgent.sidePanel.view', "Agents"),
	canToggleVisibility: false,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(AgentSidePanel),
}], agentSidePanelContainer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentEditor,
		AGENT_EDITOR_ID,
		localize('voltAgent.editorLabel', "New Agent")
	),
	[new SyncDescriptor(AgentEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AgentEditorInput.TypeID,
	AgentEditorInputSerializer
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentChangesEditor,
		AGENT_CHANGES_EDITOR_ID,
		localize('voltAgent.changesEditorLabel', "Agent Changes")
	),
	[new SyncDescriptor(AgentChangesEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AgentChangesEditorInput.TypeID,
	AgentChangesEditorInputSerializer
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		VoltBrowserEditor,
		BROWSER_EDITOR_ID,
		localize('voltBrowser.editorLabel', "Browser")
	),
	[new SyncDescriptor(VoltBrowserEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	VoltBrowserEditorInput.TypeID,
	VoltBrowserEditorInputSerializer
);

class AgentEditorResolverContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltAgentEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${Schemas.voltAgent}:**/**`,
			{
				id: AGENT_EDITOR_ID,
				label: localize('voltAgent.editorLabel', "New Agent"),
				priority: RegisteredEditorPriority.builtin
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === Schemas.voltAgent,
			},
			{
				createEditorInput: ({ resource, options }) => {
					return {
						editor: instantiationService.createInstance(AgentEditorInput, resource),
						options
					};
				}
			}
		));

		this._register(editorResolverService.registerEditor(
			`${Schemas.voltAgentChanges}:**/**`,
			{
				id: AGENT_CHANGES_EDITOR_ID,
				label: localize('voltAgent.changesEditorLabel', "Agent Changes"),
				priority: RegisteredEditorPriority.builtin
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === Schemas.voltAgentChanges,
			},
			{
				createEditorInput: ({ resource, options }) => {
					const parsed = parseAgentChangesSourceUri(resource);
					return {
						editor: instantiationService.createInstance(
							AgentChangesEditorInput,
							parsed?.sessionId ?? 'agent',
							parsed?.scope ?? 'uncommitted',
						),
						options
					};
				}
			}
		));

		this._register(editorResolverService.registerEditor(
			`${Schemas.voltBrowser}:**/**`,
			{
				id: BROWSER_EDITOR_ID,
				label: localize('voltBrowser.editorLabel', "Browser"),
				priority: RegisteredEditorPriority.builtin
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.scheme === Schemas.voltBrowser,
			},
			{
				createEditorInput: ({ resource, options }) => {
					return {
						editor: instantiationService.createInstance(VoltBrowserEditorInput, resource),
						options
					};
				}
			}
		));
	}
}

registerWorkbenchContribution2(AgentEditorResolverContribution.ID, AgentEditorResolverContribution, WorkbenchPhase.BlockStartup);

class AgentChangesResolverContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltAgentChangesResolver';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService multiDiffSourceResolverService: IMultiDiffSourceResolverService,
		@ITextModelService textModelService: ITextModelService,
	) {
		super();
		this._register(multiDiffSourceResolverService.registerResolver(instantiationService.createInstance(AgentChangesMultiDiffSourceResolver)));
		this._register(textModelService.registerTextModelContentProvider(
			Schemas.voltAgentSnapshot,
			instantiationService.createInstance(AgentSnapshotContentProvider),
		));
	}
}

registerWorkbenchContribution2(AgentChangesResolverContribution.ID, AgentChangesResolverContribution, WorkbenchPhase.BlockStartup);

registerAction2(class OpenAgentChangesAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_CHANGES_COMMAND_ID,
			title: localize2('voltAgent.openChanges', "Open Agent Changes"),
			category: Categories.View,
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		const id = typeof sessionId === 'string' && sessionId
			? sessionId
			: getActiveAgentEditor(accessor)?.sessionId;
		if (!id) {
			return;
		}
		await openAgentChanges(
			accessor.get(IInstantiationService),
			accessor.get(IEditorService),
			accessor.get(IEditorGroupsService),
			id,
		);
	}
});

class AgentSidePanelStartupContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltAgentSidePanelStartup';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IViewsService viewsService: IViewsService,
	) {
		super();
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		void viewsService.openView(AGENT_SIDE_PANEL_VIEW_ID, false);
	}
}

registerWorkbenchContribution2(AgentSidePanelStartupContribution.ID, AgentSidePanelStartupContribution, WorkbenchPhase.AfterRestored);

registerAction2(class NewAgentAction extends Action2 {
	constructor() {
		super({
			id: NEW_AGENT_COMMAND_ID,
			title: localize2('voltAgent.newAgent', "New Agent"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}

	override async run(accessor: ServicesAccessor, options?: { asTab?: boolean }): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		if (getLayoutMode(layoutService) === 'agent') {
			if (layoutService.isAuxiliaryBarMaximized()) {
				layoutService.setAuxiliaryBarMaximized(false);
			}
			const input = accessor.get(IInstantiationService).createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
			await accessor.get(IEditorService).openEditor(input, { pinned: true });
			return;
		}
		const viewsService = accessor.get(IViewsService);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		const view = await viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
		await view?.openNewAgent(options);
	}
});

registerAction2(class OpenBrowserAction extends Action2 {
	constructor() {
		super({
			id: OPEN_BROWSER_COMMAND_ID,
			title: localize2('voltAgent.openBrowser', "Open Browser"),
			category: Categories.View,
			f1: true,
			icon: OpenBrowserIcon,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
			menu: {
				id: MenuId.LayoutControlMenu,
				group: '0_new',
				order: 1,
				when: IsAuxiliaryWindowContext.negate(),
			},
		});
	}

	override async run(accessor: ServicesAccessor, url?: string, title?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const instantiationService = accessor.get(IInstantiationService);
		const resolved = typeof url === 'string' ? normalizeBrowserUrl(url) : '';
		let heading = title;
		if (resolved && !heading) {
			try {
				heading = new URL(resolved).hostname;
			} catch {
				heading = localize('voltBrowser.local', "Local");
			}
		}
		for (const group of editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.editors) {
				if (editor instanceof VoltBrowserEditorInput) {
					if (resolved) {
						editor.url = resolved;
						if (heading) {
							editor.setTitle(heading);
						}
					}
					await editorService.openEditor(editor, { pinned: true }, group);
					const pane = group.activeEditorPane;
					if (resolved && pane instanceof VoltBrowserEditor) {
						pane.openUrl(resolved);
					}
					return;
				}
			}
		}
		const input = instantiationService.createInstance(VoltBrowserEditorInput, VoltBrowserEditorInput.getNewEditorUri());
		if (resolved) {
			input.url = resolved;
			input.setTitle(heading || localize('voltBrowser.local', "Local"));
		}
		const target = pickPreviewGroup(editorGroupsService);
		await editorService.openEditor(input, { pinned: true }, target);
		closeEmptyEditorGroups(editorGroupsService);
	}
});

registerAction2(class CaptureBrowserSnapshotAction extends Action2 {
	constructor() {
		super({
			id: CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID,
			title: localize2('voltAgent.captureBrowserSnapshot', "Capture Browser Snapshot"),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<string | undefined> {
		const editorService = accessor.get(IEditorService);
		for (const pane of editorService.visibleEditorPanes) {
			if (pane instanceof VoltBrowserEditor) {
				return pane.captureSnapshot();
			}
		}
		return undefined;
	}
});

function pickPreviewGroup(editorGroupsService: IEditorGroupsService) {
	const groups = editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
	for (const group of groups) {
		if (group.editors.some(editor => editor instanceof VoltBrowserEditorInput)) {
			return group;
		}
	}
	const reuse = groups.find(group => group.count === 0 || group.editors.some(editor => !(editor instanceof AgentEditorInput)));
	if (reuse) {
		return reuse;
	}
	const active = editorGroupsService.activeGroup;
	if (groups.length <= 1) {
		return editorGroupsService.addGroup(active, GroupDirection.LEFT);
	}
	return groups.find(group => group !== active) ?? active;
}

function closeEmptyEditorGroups(editorGroupsService: IEditorGroupsService): void {
	const groups = editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
	if (groups.length <= 2) {
		return;
	}
	for (const group of groups) {
		if (group.count === 0) {
			editorGroupsService.removeGroup(group);
		}
	}
}

registerAction2(class MaximizeChatAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.maximizeChat',
			title: localize2('voltAgent.maximizeChat', "Maximize Chat"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyE,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const viewsService = accessor.get(IViewsService);
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await viewsService.openView(AGENT_SIDE_PANEL_VIEW_ID, true);
		layoutService.toggleMaximizedAuxiliaryBar();
	}
});

registerAction2(class AddRepositoryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.addRepository',
			title: localize2('voltAgent.addRepository', "Add Repository"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		try {
			await commandService.executeCommand('git.clone');
		} catch {
			await commandService.executeCommand('workbench.action.addRootFolder');
		}
	}
});

const ADD_SELECTION_TO_AGENT_COMMAND_ID = 'workbench.action.voltAgent.addSelectionToChat';

const hasEditorSelection = ContextKeyExpr.and(
	EditorContextKeys.hasNonEmptySelection,
	ActiveEditorContext.notEqualsTo(AGENT_EDITOR_ID),
	CONTEXT_IN_AGENT_INPUT.negate(),
);

async function addEditorSelectionToAgent(accessor: ServicesAccessor): Promise<boolean> {
	const editorService = accessor.get(IEditorService);
	const control = editorService.activeTextEditorControl;
	if (!isCodeEditor(control)) {
		return false;
	}
	const model = control.getModel();
	const selection = control.getSelection();
	if (!model || !selection || selection.isEmpty() || model.uri.scheme === Schemas.voltAgent || model.uri.scheme === 'volt-agent-input') {
		return false;
	}

	const layoutService = accessor.get(IWorkbenchLayoutService);
	const viewsService = accessor.get(IViewsService);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	const view = await viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
	if (!view) {
		return false;
	}
	if (!view.getActiveAgentEditor()) {
		await view.openNewAgent();
	}
	view.getActiveAgentEditor()?.addSelectionMention(model.uri, selection);
	return true;
}

registerAction2(class AddSelectionToAgentAction extends Action2 {
	constructor() {
		super({
			id: ADD_SELECTION_TO_AGENT_COMMAND_ID,
			title: localize2('voltAgent.addToChat', "Add to Chat"),
			category: Categories.View,
			f1: true,
			precondition: hasEditorSelection,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyL],
				weight: KeybindingWeight.WorkbenchContrib + 80,
				when: hasEditorSelection,
			},
			menu: [
				{
					id: MenuId.EditorContext,
					group: '1_chat',
					order: 1,
					when: hasEditorSelection,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await addEditorSelectionToAgent(accessor);
	}
});

registerAction2(class CommentSelectionAction extends Action2 {
	constructor() {
		super({
			id: INLINE_COMMENT_COMMAND_ID,
			title: localize2('voltAgent.comment', "Comment"),
			category: Categories.View,
			f1: true,
			precondition: hasEditorSelection,
			menu: [
				{
					id: MenuId.EditorContext,
					group: '1_chat',
					order: 2,
					when: hasEditorSelection,
				},
			],
		});
	}

	override run(accessor: ServicesAccessor): void {
		const control = accessor.get(IEditorService).activeTextEditorControl;
		if (isCodeEditor(control)) {
			InlineCommentController.get(control)?.open();
		}
	}
});

registerAction2(class CloseInlineCommentAction extends Action2 {
	constructor() {
		super({
			id: INLINE_COMMENT_CLOSE_COMMAND_ID,
			title: localize2('voltAgent.closeComment', "Close Inline Comment"),
			precondition: CONTEXT_INLINE_COMMENT_VISIBLE,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib + 10,
				when: CONTEXT_INLINE_COMMENT_VISIBLE,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const control = accessor.get(IEditorService).activeTextEditorControl;
		if (isCodeEditor(control)) {
			InlineCommentController.get(control)?.hide();
		}
	}
});

registerAction2(class KeepInlineCommentAction extends Action2 {
	constructor() {
		super({
			id: INLINE_COMMENT_KEEP_COMMAND_ID,
			title: localize2('voltAgent.keepCommentEdit', "Keep Inline Edit"),
			precondition: CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyY,
				weight: KeybindingWeight.WorkbenchContrib + 40,
				when: CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const control = accessor.get(IEditorService).activeTextEditorControl;
		if (isCodeEditor(control)) {
			InlineCommentController.get(control)?.keep();
		}
	}
});

registerAction2(class UndoInlineCommentAction extends Action2 {
	constructor() {
		super({
			id: INLINE_COMMENT_UNDO_COMMAND_ID,
			title: localize2('voltAgent.undoCommentEdit', "Undo Inline Edit"),
			precondition: CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				weight: KeybindingWeight.WorkbenchContrib + 40,
				when: CONTEXT_INLINE_COMMENT_HAS_PREVIEW,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const control = accessor.get(IEditorService).activeTextEditorControl;
		if (isCodeEditor(control)) {
			InlineCommentController.get(control)?.undo();
		}
	}
});

const ADD_FILE_TO_AGENT_COMMAND_ID = 'workbench.action.voltAgent.addFileToChat';
const ADD_FILE_TO_NEW_AGENT_COMMAND_ID = 'workbench.action.voltAgent.addFileToNewChat';

const attachableFileResource = ContextKeyExpr.and(
	ExplorerFolderContext.negate(),
	ContextKeyExpr.or(
		ResourceContextKey.Scheme.isEqualTo(Schemas.file),
		ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote),
		ResourceContextKey.Scheme.isEqualTo(Schemas.untitled)
	)
);

async function addResourcesToAgent(accessor: ServicesAccessor, resource: URI | undefined, newSession: boolean): Promise<void> {
	const resources = getMultiSelectedResources(
		resource,
		accessor.get(IListService),
		accessor.get(IEditorService),
		accessor.get(IEditorGroupsService),
		accessor.get(IExplorerService)
	).filter(candidate => candidate.scheme !== Schemas.voltAgent && candidate.scheme !== 'volt-agent-input');
	if (!resources.length) {
		return;
	}

	const layoutService = accessor.get(IWorkbenchLayoutService);
	const viewsService = accessor.get(IViewsService);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	const view = await viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
	if (!view) {
		return;
	}
	if (newSession || !view.getActiveAgentEditor()) {
		await view.openNewAgent();
	}
	await view.getActiveAgentEditor()?.addResourceMentions(resources);
}

registerAction2(class AddFileToAgentAction extends Action2 {
	constructor() {
		super({
			id: ADD_FILE_TO_AGENT_COMMAND_ID,
			title: localize2('voltAgent.addFileToChat', "Add File to Volt Chat"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
			menu: [
				{
					id: MenuId.ExplorerContext,
					group: '5_chat',
					order: 2,
					when: attachableFileResource,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		await addResourcesToAgent(accessor, resource, false);
	}
});

registerAction2(class AddFileToNewAgentAction extends Action2 {
	constructor() {
		super({
			id: ADD_FILE_TO_NEW_AGENT_COMMAND_ID,
			title: localize2('voltAgent.addFileToNewChat', "Add File to New Volt Chat"),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyN,
				weight: KeybindingWeight.WorkbenchContrib + 50,
			},
			menu: [
				{
					id: MenuId.ExplorerContext,
					group: '5_chat',
					order: 3,
					when: attachableFileResource,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		await addResourcesToAgent(accessor, resource, true);
	}
});

class AddSelectionToChatWidget extends Disposable implements IOverlayWidget {
	private readonly domNode: HTMLElement;

	constructor(
		private readonly editor: ICodeEditor,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.domNode = $('span.volt-agent-selection-actions');
		const add = append(this.domNode, $('span.volt-agent-selection-action'));
		add.setAttribute('role', 'button');
		append(add, $('span.volt-agent-selection-action-label')).textContent = localize('voltAgent.addToChat', "Add to Chat");
		const addKey = keybindingService.lookupKeybinding(ADD_SELECTION_TO_AGENT_COMMAND_ID);
		if (addKey) {
			append(add, $('span.volt-agent-selection-action-key')).textContent = addKey.getLabel() ?? '';
		}
		const comment = append(this.domNode, $('span.volt-agent-selection-action.volt-agent-comment'));
		comment.setAttribute('role', 'button');
		append(comment, $('span.volt-agent-selection-action-label')).textContent = localize('voltAgent.comment', "Comment");
		this._register(addDisposableListener(add, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			void commandService.executeCommand(ADD_SELECTION_TO_AGENT_COMMAND_ID);
		}));
		this._register(addDisposableListener(comment, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			void commandService.executeCommand(INLINE_COMMENT_COMMAND_ID);
		}));
		this.editor.addOverlayWidget(this);
		this._register(this.editor.onDidChangeCursorSelection(() => this.layout()));
		this._register(this.editor.onDidScrollChange(() => this.layout()));
		this._register(this.editor.onDidLayoutChange(() => this.layout()));
		this._register(this.editor.onDidChangeModel(() => this.layout()));
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set([CONTEXT_INLINE_COMMENT_VISIBLE.key]))) {
				this.layout();
			}
		}));
		this._register(toDisposable(() => this.editor.removeOverlayWidget(this)));
		this.layout();
	}

	getId(): string {
		return 'volt.agent.addToChatWidget';
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition() {
		return null;
	}

	private layout(): void {
		const model = this.editor.getModel();
		const selection = this.editor.getSelection();
		const editorDom = this.editor.getDomNode();
		if (!model || !selection || selection.isEmpty() || !editorDom || InlineCommentController.get(this.editor)?.isVisible) {
			this.domNode.style.visibility = 'hidden';
			return;
		}
		if (model.uri.scheme === Schemas.voltAgent || model.uri.scheme === 'volt-agent-input') {
			this.domNode.style.visibility = 'hidden';
			return;
		}
		let position = selection.getEndPosition();
		if (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber) {
			const lineNumber = selection.endLineNumber - 1;
			position = new Position(lineNumber, model.getLineMaxColumn(lineNumber));
		}
		const visible = this.editor.getScrolledVisiblePosition(position);
		if (!visible || visible.top + visible.height < 0 || visible.top > editorDom.clientHeight) {
			this.domNode.style.visibility = 'hidden';
			return;
		}
		this.domNode.style.visibility = 'visible';
		const top = visible.top + Math.max(0, (visible.height - this.domNode.offsetHeight) / 2);
		this.domNode.style.left = `${Math.round(visible.left + 8)}px`;
		this.domNode.style.top = `${Math.round(top)}px`;
	}
}

class AddSelectionToChatContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'volt.agent.addToChat';

	constructor(
		editor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(instantiationService.createInstance(AddSelectionToChatWidget, editor));
	}
}

registerEditorContribution(InlineCommentController.ID, InlineCommentController, EditorContributionInstantiation.AfterFirstRender);
registerEditorContribution(AddSelectionToChatContribution.ID, AddSelectionToChatContribution, EditorContributionInstantiation.AfterFirstRender);

registerAction2(class OpenAgentSidePanelAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_SIDE_PANEL_COMMAND_ID,
			title: localize2('voltAgent.openSidePanel', "Toggle Agents Side Bar"),
			category: Categories.View,
			f1: true,
			icon: AgentSidePanelIcon,
			toggled: {
				condition: AuxiliaryBarVisibleContext,
				title: localize('voltAgent.hideSidePanel', "Hide Agents Side Bar"),
				icon: AgentSidePanelIcon,
			},
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: KeybindingWeight.WorkbenchContrib + 70,
				when: hasEditorSelection.negate(),
			},
			menu: {
				id: MenuId.LayoutControlMenu,
				group: '2_pane_toggles',
				order: 2,
				when: ContextKeyExpr.and(
					IsAuxiliaryWindowContext.negate(),
					ContextKeyExpr.or(
						ContextKeyExpr.equals('config.workbench.layoutControl.type', 'toggles'),
						ContextKeyExpr.equals('config.workbench.layoutControl.type', 'both'),
					),
				),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const viewsService = accessor.get(IViewsService);
		const visible = layoutService.isVisible(Parts.AUXILIARYBAR_PART) && viewsService.isViewVisible(AGENT_SIDE_PANEL_VIEW_ID);
		if (visible) {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			return;
		}
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await viewsService.openView(AGENT_SIDE_PANEL_VIEW_ID, true);
	}
});

function getActiveAgentEditor(accessor: ServicesAccessor): AgentEditor | undefined {
	const editorService = accessor.get(IEditorService);
	if (editorService.activeEditorPane instanceof AgentEditor) {
		return editorService.activeEditorPane;
	}
	const groups = accessor.get(IEditorGroupsService);
	for (const group of groups.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
		if (group.activeEditorPane instanceof AgentEditor) {
			return group.activeEditorPane;
		}
	}
	const view = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID);
	return view?.getActiveAgentEditor();
}

const agentEditorFocused = ActiveEditorContext.isEqualTo(AGENT_EDITOR_ID);
const inAgentComposer = ContextKeyExpr.and(CONTEXT_IN_AGENT_INPUT, CONTEXT_AGENT_FIND_INPUT_FOCUSED.negate());

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_SUBMIT_COMMAND_ID,
			title: localize2('voltAgent.submit', "Send Agent Prompt"),
			precondition: CONTEXT_IN_AGENT_INPUT,
			keybinding: [
				{
					primary: KeyCode.Enter,
					weight: KeybindingWeight.EditorContrib + 100,
					when: inAgentComposer,
				},
				{
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					weight: KeybindingWeight.EditorContrib + 100,
					when: inAgentComposer,
				},
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		getActiveAgentEditor(accessor)?.submitComposer();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_COMMAND_ID,
			title: localize2('voltAgent.find', "Find in Agent"),
			precondition: agentEditorFocused,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: agentEditorFocused,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		getActiveAgentEditor(accessor)?.revealFind();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_HIDE_COMMAND_ID,
			title: localize2('voltAgent.hideFind', "Hide Find in Agent"),
			precondition: agentEditorFocused,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: ContextKeyExpr.and(agentEditorFocused, CONTEXT_AGENT_FIND_WIDGET_VISIBLE),
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		getActiveAgentEditor(accessor)?.hideFind();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_NEXT_COMMAND_ID,
			title: localize2('voltAgent.findNext', "Find Next in Agent"),
			precondition: agentEditorFocused,
			keybinding: [
				{
					primary: KeyCode.F3,
					mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyG, secondary: [KeyCode.F3] },
					weight: KeybindingWeight.WorkbenchContrib + 10,
					when: agentEditorFocused,
				},
				{
					primary: KeyCode.Enter,
					weight: KeybindingWeight.WorkbenchContrib + 10,
					when: CONTEXT_AGENT_FIND_INPUT_FOCUSED,
				},
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		getActiveAgentEditor(accessor)?.findNext();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_PREVIOUS_COMMAND_ID,
			title: localize2('voltAgent.findPrevious', "Find Previous in Agent"),
			precondition: agentEditorFocused,
			keybinding: [
				{
					primary: KeyMod.Shift | KeyCode.F3,
					mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG, secondary: [KeyMod.Shift | KeyCode.F3] },
					weight: KeybindingWeight.WorkbenchContrib + 10,
					when: agentEditorFocused,
				},
				{
					primary: KeyMod.Shift | KeyCode.Enter,
					weight: KeybindingWeight.WorkbenchContrib + 10,
					when: CONTEXT_AGENT_FIND_INPUT_FOCUSED,
				},
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		getActiveAgentEditor(accessor)?.findPrevious();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_TOGGLE_REGEX_COMMAND_ID,
			title: localize2('voltAgent.toggleFindRegex', "Toggle Find Regex in Agent"),
			precondition: agentEditorFocused,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.KeyR,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR },
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: CONTEXT_AGENT_FIND_WIDGET_VISIBLE,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const state = getActiveAgentEditor(accessor)?.findState;
		state?.change({ isRegex: !state.isRegex }, false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID,
			title: localize2('voltAgent.toggleFindWholeWord', "Toggle Find Whole Word in Agent"),
			precondition: agentEditorFocused,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.KeyW,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyW },
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: CONTEXT_AGENT_FIND_WIDGET_VISIBLE,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const state = getActiveAgentEditor(accessor)?.findState;
		state?.change({ wholeWord: !state.wholeWord }, false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_FIND_TOGGLE_CASE_COMMAND_ID,
			title: localize2('voltAgent.toggleFindCaseSensitive', "Toggle Find Case Sensitive in Agent"),
			precondition: agentEditorFocused,
			keybinding: {
				primary: KeyMod.Alt | KeyCode.KeyC,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC },
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: CONTEXT_AGENT_FIND_WIDGET_VISIBLE,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		const state = getActiveAgentEditor(accessor)?.findState;
		state?.change({ matchCase: !state.matchCase }, false);
	}
});

