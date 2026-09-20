/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSidePanel.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Orientation, Sash, SashState } from '../../../../../base/browser/ui/sash/sash.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier } from '../../../../browser/dnd.js';
import { IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { EditorsOrder, GroupModelChangeKind } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GettingStartedInput } from '../../../welcomeGettingStarted/browser/gettingStartedInput.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentCustomizeEditorInput } from '../customize/agentCustomizeEditor.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput, TOGGLE_AGENT_DRAWER_COMMAND_ID } from '../editor/agentEditorInput.js';
import { AgentHistoryDrawer } from '../history/agentHistoryDrawer.js';
import { AgentHomePane } from '../home/agentHomePane.js';
import { shouldShowAgentEditorTabs } from '../home/agentHomeModel.js';
import { setAgentTooltip } from './agentTooltip.js';
import { SidebarEditorPart } from '../editor/sidebarEditorPart.js';

const DRAWER_OPEN_KEY = 'volt.agent.drawer.open';
const DRAWER_WIDTH_KEY = 'volt.agent.drawer.width';
const DRAWER_MIN_WIDTH = 200;
const DRAWER_MAX_WIDTH = 280;

export class AgentSidePanel extends ViewPane {

	private bodyEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private hostEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private drawerActionsEl!: HTMLElement;
	private drawerViewEl!: HTMLButtonElement;
	private drawerCollapseEl!: HTMLButtonElement;
	private drawerToggleEl!: HTMLButtonElement;
	private drawer: AgentHistoryDrawer | undefined;
	private drawerOpen = false;
	private drawerWidth = DRAWER_MAX_WIDTH;
	private drawerSash: Sash | undefined;
	private editorPart: EditorPart | undefined;
	private home: AgentHomePane | undefined;
	private didSeedDefault = false;
	private collapsingGroups = false;
	private readonly groupListeners = this._register(new DisposableStore());
	private readonly partOptions = this._register(new MutableDisposable<IDisposable>());
	private readonly centerTabs = this._register(new MutableDisposable<IDisposable>());
	private readonly drawerDisposable = this._register(new MutableDisposable<AgentHistoryDrawer>());
	private readonly drawerViewListener = this._register(new MutableDisposable());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly workbenchLayoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		container.classList.add('volt-agent-side-panel');
		this.bodyEl = container;

		this.mainEl = append(container, $('.volt-agent-side-main'));
		this.home = this._register(this.instantiationService.createInstance(AgentHomePane, this.mainEl));
		this.hostEl = append(this.mainEl, $('.part.editor.volt-agent-side-host', { role: 'main' }));
		this.hostEl.style.position = 'relative';

		this.emptyEl = append(this.mainEl, $('.volt-agent-empty'));
		const action = append(this.emptyEl, $('button.volt-agent-empty-action')) as HTMLButtonElement;
		action.appendChild(renderIcon(Codicon.add));
		append(action, $('span')).textContent = localize('voltAgent.sidePanel.newAgent', "New Agent");

		this._register(addDisposableListener(action, 'click', () => void this.openNewAgent()));

		// Closed: overlay the hide/show control on the tab bar. Open: the same
		// row lives inside the drawer header with Search-tab view/collapse.
		this.drawerActionsEl = append(this.bodyEl, $('.volt-agent-drawer-actions'));
		this.drawerViewEl = append(this.drawerActionsEl, $('button.volt-agent-drawer-action.volt-agent-drawer-when-open')) as HTMLButtonElement;
		this._register(addDisposableListener(this.drawerViewEl, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.drawer) {
				return;
			}
			this.drawer.setTreeView(!this.drawer.treeView);
			this.updateDrawerActions();
			this.drawerViewEl.blur();
		}));
		this.drawerCollapseEl = append(this.drawerActionsEl, $('button.volt-agent-drawer-action.volt-agent-drawer-when-open')) as HTMLButtonElement;
		this._register(addDisposableListener(this.drawerCollapseEl, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (!this.drawer) {
				return;
			}
			if (this.drawer.canCollapse) {
				this.drawer.collapseAll();
			} else {
				this.drawer.expandAll();
			}
			this.updateDrawerActions();
			this.drawerCollapseEl.blur();
		}));
		this.drawerToggleEl = append(this.drawerActionsEl, $('button.volt-agent-drawer-toggle')) as HTMLButtonElement;
		this.drawerToggleEl.appendChild(renderIcon(Codicon.layoutSidebarRight));
		this.drawerToggleEl.setAttribute('aria-pressed', 'false');
		this.updateDrawerActions();
		this.updateToggleTooltip();
		this._register(addDisposableListener(this.drawerToggleEl, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleDrawer();
			this.drawerToggleEl.blur();
		}));

		this.applyDrawerWidth(this.storageService.getNumber(DRAWER_WIDTH_KEY, StorageScope.PROFILE, DRAWER_MAX_WIDTH));
		this.createDrawerSash();
		if (this.storageService.getBoolean(DRAWER_OPEN_KEY, StorageScope.PROFILE, false)) {
			this.setDrawerOpen(true, false);
		}

		const editorPartsView = this.editorGroupsService as unknown as IEditorPartsView;
		this.editorPart = this._register(this.instantiationService.createInstance(SidebarEditorPart, editorPartsView));
		this._register(editorPartsView.registerPart(this.editorPart));
		this.editorPart.create(this.hostEl, { restorePreviousState: true });
		this.applyPartOptions(false);

		this.bindAgentOnlyGroups();
		this.bindAgentOnlyDrop(container);
		this._register(this.editorPart.onDidAddGroup(() => {
			this.bindAgentOnlyGroups();
			this.syncAgentLayout();
		}));
		this._register(this.editorPart.onDidRemoveGroup(() => this.syncAgentLayout()));
		this._register(this.editorPart.onDidActivateGroup(() => this.syncActiveSession()));

		const observer = new ResizeObserver(() => this.layoutEditor());
		observer.observe(this.hostEl);
		this._register(toDisposable(() => observer.disconnect()));

		this._register(this.onDidChangeBodyVisibility(visible => {
			this.editorPart?.setVisible(visible && !this.isAgentLayout());
			this.updateAuxiliaryBarClass(visible);
			if (visible) {
				this.layoutEditor();
				void this.seedDefaultAgent();
			}
		}));
		this.editorPart.setVisible(this.isBodyVisible());
		this.updateAuxiliaryBarClass(this.isBodyVisible());
		queueMicrotask(() => this.updateAuxiliaryBarClass(this.isBodyVisible()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.sideBar.location')) {
				this.syncLayoutMode();
			}
		}));
		this._register(this.editorService.onDidEditorsChange(() => this.syncCenterTabs()));
		this.syncLayoutMode();

		void this.editorPart.whenRestored.then(() => {
			this.bindAgentOnlyGroups();
			void this.seedDefaultAgent();
			this.syncAgentLayout();
			this.layoutEditor();
		});
	}

	protected override layoutBody(_height: number, _width: number): void {
		this.home?.layout();
		this.layoutEditor();
	}

	override focus(): void {
		if (this.isAgentLayout()) {
			this.home?.focus();
			return;
		}
		if (this.isEmpty()) {
			(this.emptyEl.querySelector('button') as HTMLButtonElement | null)?.focus();
			return;
		}
		this.editorPart?.activeGroup.focus();
	}

	private isAgentLayout(): boolean {
		return getLayoutMode(this.workbenchLayoutService) === 'agent';
	}

	private syncLayoutMode(): void {
		const agent = this.isAgentLayout();
		this.element.ownerDocument.querySelector('.monaco-workbench')?.classList.toggle('volt-layout-agent', agent);
		this.bodyEl.classList.toggle('home-mode', agent);
		this.element.classList.toggle('home-mode', agent);
		this.hostEl.classList.toggle('hidden', agent);
		this.emptyEl.classList.toggle('hidden', agent);
		this.drawerActionsEl.classList.toggle('hidden', agent);
		this.editorPart?.setVisible(this.isBodyVisible() && !agent);
		if (agent && this.drawerOpen) {
			this.setDrawerOpen(false, false);
		}
		if (agent) {
			void this.seedCenterAgent();
		} else {
			void this.seedDefaultAgent();
		}
		this.updateAuxiliaryBarClass(this.isBodyVisible());
		this.syncCenterTabs();
		this.layoutEditor();
	}

	private syncCenterTabs(): void {
		const workbench = this.element.ownerDocument.querySelector('.monaco-workbench');
		if (!this.isAgentLayout()) {
			this.centerTabs.clear();
			workbench?.classList.remove('volt-single-agent');
			return;
		}
		let openEditors = 0;
		for (const group of this.editorGroupsService.mainPart.groups) {
			openEditors += group.count;
		}
		const showTabs = shouldShowAgentEditorTabs(openEditors);
		this.centerTabs.value = this.editorGroupsService.mainPart.enforcePartOptions({
			showTabs: showTabs ? 'multiple' : 'none',
		});
		workbench?.classList.toggle('volt-single-agent', !showTabs);
	}

	private layoutEditor(): void {
		this.home?.layout();
		this.drawer?.layout();
		this.drawerSash?.layout();
		if (!this.editorPart || !this.hostEl) {
			return;
		}
		const width = this.hostEl.clientWidth;
		const height = this.hostEl.clientHeight;
		if (width <= 0 || height <= 0) {
			return;
		}
		this.editorPart.layout(width, height, 0, 0);
	}

	//#region Drawer

	isDrawerOpen(): boolean {
		return this.drawerOpen;
	}

	toggleDrawer(): void {
		this.setDrawerOpen(!this.drawerOpen, true);
	}

	/**
	 * The drawer is built once and then shown or hidden, so a toggle can never
	 * stack a second copy beside the first one.
	 */
	setDrawerOpen(open: boolean, focus: boolean): void {
		if (this.isAgentLayout() && open) {
			return;
		}
		const wasOpen = this.drawerOpen;
		this.drawerOpen = open;
		if (open) {
			if (!this.drawer) {
				this.drawer = this.drawerDisposable.value = this.instantiationService.createInstance(AgentHistoryDrawer, this.bodyEl);
				this.drawerViewListener.value = this.drawer.onDidChangeView(() => this.updateDrawerActions());
			}
			this.drawer.setActiveSession(this.activeSessionId());
		}
		this.keepSingleDrawer();
		this.element.classList.toggle('drawer-open', open);
		this.bodyEl.classList.toggle('drawer-open', open);
		this.drawerToggleEl.setAttribute('aria-pressed', String(open));
		this.updateToggleTooltip();
		this.updateDrawerActions();
		if (this.drawerSash) {
			this.drawerSash.state = open ? SashState.Enabled : SashState.Disabled;
		}
		this.storageService.store(DRAWER_OPEN_KEY, open, StorageScope.PROFILE, StorageTarget.USER);
		this.layoutEditor();
		if (open) {
			getWindow(this.bodyEl).requestAnimationFrame(() => this.drawer?.layout());
		}
		if (!focus) {
			return;
		}
		if (open) {
			this.drawer?.focus();
		} else if (wasOpen) {
			this.editorPart?.activeGroup.focus();
		}
	}

	private updateDrawerActions(): void {
		// Same glyphs as the Search view title: current mode + the action name.
		const tree = this.drawer?.treeView !== false;
		this.drawerViewEl.replaceChildren(renderIcon(tree ? Codicon.listTree : Codicon.listFlat));
		const viewLabel = tree
			? localize('voltAgent.drawer.viewAsList', "View as List")
			: localize('voltAgent.drawer.viewAsTree', "View as Tree");
		this.drawerViewEl.setAttribute('aria-label', viewLabel);
		setAgentTooltip(this.drawerViewEl, viewLabel);

		const canCollapse = !!this.drawer?.canCollapse;
		this.drawerCollapseEl.replaceChildren(renderIcon(canCollapse ? Codicon.collapseAll : Codicon.expandAll));
		const collapseLabel = canCollapse
			? localize('voltAgent.drawer.collapseAll', "Collapse All")
			: localize('voltAgent.drawer.expandAll', "Expand All");
		this.drawerCollapseEl.setAttribute('aria-label', collapseLabel);
		setAgentTooltip(this.drawerCollapseEl, collapseLabel);
	}

	private updateToggleTooltip(): void {
		const label = this.drawerOpen
			? localize('voltAgent.drawer.hide', "Hide Agent Sidebar")
			: localize('voltAgent.drawer.show', "Show Agent Sidebar");
		this.drawerToggleEl.setAttribute('aria-label', label);
		setAgentTooltip(this.drawerToggleEl, label, this.keybindingService.lookupKeybinding(TOGGLE_AGENT_DRAWER_COMMAND_ID)?.getLabel() ?? undefined);
	}

	/** Drag the drawer's inner edge to resize it within its bounds. */
	private createDrawerSash(): void {
		const sash = this._register(new Sash(this.bodyEl, {
			getVerticalSashLeft: () => Math.max(0, this.bodyEl.clientWidth - this.currentDrawerWidth()),
		}, { orientation: Orientation.VERTICAL }));
		sash.state = SashState.Disabled;
		let startWidth = this.drawerWidth;
		this._register(sash.onDidStart(() => {
			startWidth = this.currentDrawerWidth();
		}));
		this._register(sash.onDidChange(e => this.applyDrawerWidth(startWidth - (e.currentX - e.startX))));
		this._register(sash.onDidReset(() => this.applyDrawerWidth(DRAWER_MAX_WIDTH)));
		this._register(sash.onDidEnd(() => this.storageService.store(DRAWER_WIDTH_KEY, this.drawerWidth, StorageScope.PROFILE, StorageTarget.USER)));
		this.drawerSash = sash;
	}

	private currentDrawerWidth(): number {
		return this.drawer?.element.offsetWidth || this.drawerWidth;
	}

	private applyDrawerWidth(width: number): void {
		const next = Math.round(Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, width)));
		this.drawerWidth = next;
		this.bodyEl.style.setProperty('--volt-agent-drawer-width', `${next}px`);
		this.drawerSash?.layout();
		this.layoutEditor();
	}

	/** Drops stray drawer nodes and parks the toolbar in the open drawer header. */
	private keepSingleDrawer(): void {
		for (const el of this.bodyEl.querySelectorAll('.volt-agent-drawer')) {
			if (el !== this.drawer?.element) {
				el.remove();
			}
		}
		this.placeDrawerActions();
	}

	/** Open: inside the drawer. Closed: overlay on the tab bar, no extra column. */
	private placeDrawerActions(): void {
		if (!this.drawerActionsEl) {
			return;
		}
		if (this.drawerOpen && this.drawer) {
			this.drawer.header.appendChild(this.drawerActionsEl);
		} else {
			this.bodyEl.appendChild(this.drawerActionsEl);
		}
	}

	private activeSessionId(): string | undefined {
		const editor = this.editorPart?.activeGroup.activeEditor;
		return editor instanceof AgentEditorInput ? editor.sessionId : undefined;
	}

	private syncActiveSession(): void {
		this.drawer?.setActiveSession(this.activeSessionId());
	}

	//#endregion

	/** Opens the Customize tab beside the agent sessions. */
	async openCustomize(): Promise<void> {
		if (this.isAgentLayout()) {
			const input = this.instantiationService.createInstance(AgentCustomizeEditorInput);
			await this.editorService.openEditor(input, { pinned: true });
			return;
		}
		if (!this.editorPart) {
			return;
		}
		await this.editorPart.whenRestored;
		const group = this.editorPart.activeGroup;
		const existing = group.editors.find(editor => editor instanceof AgentCustomizeEditorInput);
		const input = existing ?? this.instantiationService.createInstance(AgentCustomizeEditorInput);
		await group.openEditor(input, { pinned: true });
		this.syncAgentLayout();
		group.focus();
	}

	/** Shows a stored session, reusing its tab when it is already open. */
	async openSession(sessionId: string): Promise<void> {
		if (this.isAgentLayout()) {
			const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(sessionId));
			await this.editorService.openEditor(input, { pinned: true });
			return;
		}
		if (!this.editorPart) {
			return;
		}
		await this.editorPart.whenRestored;
		for (const group of this.editorPart.groups) {
			const existing = group.editors.find((editor): editor is AgentEditorInput => editor instanceof AgentEditorInput && editor.sessionId === sessionId);
			if (existing) {
				await group.openEditor(existing, { pinned: true });
				group.focus();
				return;
			}
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(sessionId));
		await this.editorPart.activeGroup.openEditor(input, { pinned: true });
		this.syncAgentLayout();
		this.editorPart.activeGroup.focus();
	}

	private updateAuxiliaryBarClass(visible: boolean): void {
		const bar = this.element.closest('.part.auxiliarybar');
		bar?.classList.toggle('volt-agent-editor-tabs', visible && !this.isAgentLayout());
		bar?.classList.toggle('volt-agent-home', this.isAgentLayout());
	}

	private isEmpty(): boolean {
		return (this.editorPart?.groups ?? []).every(group => group.count === 0);
	}

	private async seedDefaultAgent(): Promise<void> {
		if (this.isAgentLayout() || this.didSeedDefault || !this.editorPart) {
			return;
		}
		await this.editorPart.whenRestored;
		this.didSeedDefault = true;
		if (this.isEmpty()) {
			await this.openNewAgent();
		}
		this.syncAgentLayout();
	}

	async openNewAgent(options?: { asTab?: boolean; focus?: boolean; groupId?: number }): Promise<void> {
		if (this.isAgentLayout()) {
			const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
			await this.editorService.openEditor(input, { pinned: true, preserveFocus: options?.focus === false });
			return;
		}
		if (!this.editorPart) {
			return;
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		const preserveFocus = options?.focus === false;
		const group = (options?.groupId !== undefined ? this.getGroup(options.groupId) : undefined) ?? this.editorPart.activeGroup;
		await group.openEditor(input, { pinned: true, preserveFocus });
		this.syncAgentLayout();
		if (!preserveFocus) {
			group.focus();
		}
	}

	/** Opens a fresh agent in place of the one showing in the group. */
	async replaceAgent(groupId?: number): Promise<void> {
		if (!this.editorPart) {
			return;
		}
		await this.editorPart.whenRestored;
		const group = (groupId !== undefined ? this.getGroup(groupId) : undefined) ?? this.editorPart.activeGroup;
		const previous = group.activeEditor;
		await this.openNewAgent({ groupId: group.id });
		if (previous) {
			await group.closeEditor(previous);
		}
		this.syncAgentLayout();
	}

	getActiveAgentEditor(): AgentEditor | undefined {
		if (this.isAgentLayout()) {
			if (this.editorService.activeEditorPane instanceof AgentEditor) {
				return this.editorService.activeEditorPane;
			}
			for (const group of this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
				if (group.activeEditorPane instanceof AgentEditor) {
					return group.activeEditorPane;
				}
			}
			return undefined;
		}
		const pane = this.editorPart?.activeGroup.activeEditorPane;
		return pane instanceof AgentEditor ? pane : undefined;
	}

	private async seedCenterAgent(): Promise<void> {
		if (!this.isAgentLayout()) {
			return;
		}
		const welcome = this.editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.filter(identifier => identifier.editor instanceof GettingStartedInput);
		if (welcome.length) {
			await this.editorService.closeEditors(welcome);
		}
		if (this.editorService.editors.some(editor => editor instanceof AgentEditorInput)) {
			return;
		}
		await this.openNewAgent({ focus: false });
	}

	/** The group with this id when it lives inside this panel. */
	getGroup(groupId: number): IEditorGroup | undefined {
		return this.editorPart?.groups.find(group => group.id === groupId);
	}

	private uniqueAgentCount(): number {
		const ids = new Set<string>();
		for (const group of this.editorPart?.groups ?? []) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput) {
					ids.add(editor.resource.toString());
				}
			}
		}
		return ids.size;
	}

	private applyPartOptions(canSplit: boolean): void {
		if (!this.editorPart) {
			return;
		}
		this.partOptions.value = this.editorPart.enforcePartOptions({
			closeEmptyGroups: true,
			showTabs: 'multiple',
			splitOnDragAndDrop: canSplit,
		});
	}

	private syncEmptyState(): void {
		const empty = this.isEmpty();
		this.emptyEl.classList.toggle('hidden', !empty);
		this.element.classList.toggle('is-empty', empty);
	}

	private syncAgentLayout(): void {
		if (!this.editorPart || this.collapsingGroups) {
			return;
		}
		const canSplit = this.uniqueAgentCount() >= 2;
		this.hostEl.classList.toggle('single-agent', !canSplit);
		this.element.classList.toggle('single-agent', !canSplit);
		this.applyPartOptions(canSplit);
		if (!canSplit && this.occupiedGroups().length > 1) {
			this.collapseToSingleGroup();
		}
		this.syncEmptyState();
		this.layoutEditor();
	}

	private occupiedGroups(): IEditorGroup[] {
		return (this.editorPart?.groups ?? []).filter(group => group.count > 0);
	}

	private collapseToSingleGroup(): void {
		if (!this.editorPart) {
			return;
		}
		const occupied = this.occupiedGroups();
		if (occupied.length < 2) {
			return;
		}
		this.collapsingGroups = true;
		try {
			const active = this.editorPart.activeGroup;
			const target = occupied.includes(active) ? active : occupied[0];
			for (const group of occupied) {
				if (group.id !== target.id) {
					this.editorPart.mergeGroup(group.id, target.id);
				}
			}
		} finally {
			this.collapsingGroups = false;
		}
	}

	private bindAgentOnlyGroups(): void {
		this.groupListeners.clear();
		for (const group of this.editorPart?.groups ?? []) {
			for (const editor of [...group.editors]) {
				if (!isSidebarEditor(editor)) {
					this.bounceNonAgent(group, editor);
				}
			}
			this.groupListeners.add(group.onDidModelChange(e => {
				if (e.kind === GroupModelChangeKind.EDITOR_OPEN && e.editor && !isSidebarEditor(e.editor)) {
					this.bounceNonAgent(group, e.editor);
				}
				this.syncAgentLayout();
				if (e.kind === GroupModelChangeKind.EDITOR_ACTIVE || e.kind === GroupModelChangeKind.EDITOR_CLOSE) {
					this.syncActiveSession();
				}
			}));
			this.groupListeners.add(group.onDidCloseEditor(() => this.syncAgentLayout()));
		}
	}

	private bounceNonAgent(group: IEditorGroup, editor: EditorInput): void {
		const target = this.editorGroupsService.mainPart.activeGroup;
		if (target && target !== group) {
			group.moveEditor(editor, target);
		} else {
			void group.closeEditor(editor);
		}
	}

	private bindAgentOnlyDrop(container: HTMLElement): void {
		const onDrag = (e: DragEvent, accept: boolean) => {
			if (!this.isDraggedAgent()) {
				if (e.dataTransfer && this.isDraggedEditor()) {
					e.dataTransfer.dropEffect = 'none';
				}
				container.classList.remove('drop-target');
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			container.classList.toggle('drop-target', accept);
		};
		this._register(addDisposableListener(container, 'dragenter', e => onDrag(e, true)));
		this._register(addDisposableListener(container, 'dragover', e => onDrag(e, true)));
		this._register(addDisposableListener(container, 'dragleave', e => {
			if (!container.contains(e.relatedTarget as Node)) {
				container.classList.remove('drop-target');
			}
		}));
		this._register(addDisposableListener(container, 'drop', e => {
			container.classList.remove('drop-target');
			if (!this.isDraggedAgent()) {
				e.preventDefault();
				e.stopPropagation();
			}
		}));
	}

	private isDraggedEditor(): boolean {
		return LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().hasData(DraggedEditorIdentifier.prototype)
			|| LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().hasData(DraggedEditorGroupIdentifier.prototype);
	}

	private isDraggedAgent(): boolean {
		const editors = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().getData(DraggedEditorIdentifier.prototype) ?? [];
		if (editors.length) {
			return editors.every(item => isSidebarEditor(item.identifier.editor));
		}
		const groups = LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().getData(DraggedEditorGroupIdentifier.prototype) ?? [];
		if (!groups.length) {
			return false;
		}
		return groups.every(item => {
			const group = this.editorGroupsService.getGroup(item.identifier);
			return !!group && group.editors.every(editor => isSidebarEditor(editor));
		});
	}
}

function isSidebarEditor(editor: EditorInput): boolean {
	return editor instanceof AgentEditorInput || editor instanceof AgentCustomizeEditorInput;
}
