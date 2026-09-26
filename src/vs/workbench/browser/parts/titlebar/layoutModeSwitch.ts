/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/layoutModeSwitch.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { AGENT_SIDE_PANEL_ID, resetAgentStatusbarShift } from './agentLayoutChrome.js';

const AGENT_LIST_WIDTH = 290;

export const TOGGLE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.toggleAgentIdeLayout';
export const SET_AGENT_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setAgentLayoutMode';
export const SET_IDE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setIdeLayoutMode';

const SIDEBAR_LOCATION_KEY = 'workbench.sideBar.location';
const STATUSBAR_VISIBLE_KEY = 'workbench.statusBar.visible';
const LAYOUT_MODE_STORAGE_KEY = 'volt.layoutMode';
export const AGENT_LEFT_SIDEBAR_HIDDEN_KEY = 'volt.agent.leftSidebar.hidden';

export type LayoutMode = 'agent' | 'ide';
export const LayoutModeContext = new RawContextKey<LayoutMode>('volt.layoutMode', 'ide');
export const AGENT_RIGHT_DOCK_COLLAPSED_KEY = 'volt.agent.rightDock.collapsed.v2';
export const AGENT_RIGHT_DOCK_COLLAPSED_WIDTH = 0;
/** Quick Open Actions no longer reserve a column; they sit in the chat scroller. */
export const AGENT_RIGHT_DOCK_EXPANDED_WIDTH = 0;

const onDidChangeLayoutModeEmitter = new Emitter<LayoutMode>();
export const onDidChangeLayoutMode = onDidChangeLayoutModeEmitter.event;

export function isAgentLeftSidebarHidden(storageService: IStorageService): boolean {
	return storageService.getBoolean(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, StorageScope.PROFILE, false);
}

export function storeAgentLeftSidebarHidden(storageService: IStorageService, hidden: boolean): void {
	storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, hidden, StorageScope.PROFILE, StorageTarget.USER);
}

export function readStoredLayoutMode(storageService: IStorageService, layoutService: IWorkbenchLayoutService): LayoutMode {
	const stored = storageService.get(LAYOUT_MODE_STORAGE_KEY, StorageScope.PROFILE, '');
	if (stored === 'agent' || stored === 'ide') {
		return stored;
	}
	return layoutService.getSideBarPosition() === Position.RIGHT ? 'agent' : 'ide';
}

export function isAgentRightDockCollapsed(storageService: IStorageService): boolean {
	return storageService.getBoolean(AGENT_RIGHT_DOCK_COLLAPSED_KEY, StorageScope.PROFILE, false);
}

const agentLayoutIcon = registerIcon('volt-layout-agent', Codicon.robot, localize('volt.layoutMode.agentIcon', 'Icon for Agent Mode.'));
const ideLayoutIcon = registerIcon('volt-layout-ide', Codicon.code, localize('volt.layoutMode.ideIcon', 'Icon for IDE Mode.'));

/** Agent mode parks the primary sidebar on the right so the Agents bar sits on the left. */
export function getLayoutMode(layoutService: IWorkbenchLayoutService): LayoutMode {
	return layoutService.getSideBarPosition() === Position.RIGHT ? 'agent' : 'ide';
}

/** Show the part that hosts the agent list. */
export function revealAgentSidePanel(layoutService: IWorkbenchLayoutService): void {
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
}

/** Unhide the agent list on the left and give it a real width. */
export async function openAgentSidebar(
	_configurationService: IConfigurationService,
	layoutService: IWorkbenchLayoutService,
	paneCompositeService: IPaneCompositePartService,
): Promise<void> {
	if (layoutService.isAuxiliaryBarMaximized()) {
		layoutService.setAuxiliaryBarMaximized(false);
	}
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	await paneCompositeService.openPaneComposite(AGENT_SIDE_PANEL_ID, ViewContainerLocation.AuxiliaryBar, true);
	const size = layoutService.getSize(Parts.AUXILIARYBAR_PART);
	if (size.width < 180) {
		layoutService.setSize(Parts.AUXILIARYBAR_PART, {
			width: AGENT_LIST_WIDTH,
			height: size.height,
		});
	}
	layoutService.layout();
}

export async function setLayoutMode(
	configurationService: IConfigurationService,
	layoutService: IWorkbenchLayoutService,
	mode: LayoutMode,
	storageService: IStorageService,
): Promise<void> {
	storageService.store(LAYOUT_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
	const location = mode === 'agent' ? 'right' : 'left';
	if (configurationService.getValue<string>(SIDEBAR_LOCATION_KEY) !== location) {
		await configurationService.updateValue(SIDEBAR_LOCATION_KEY, location);
	}
	if (mode === 'agent') {
		storeAgentLeftSidebarHidden(storageService, false);
	}

	applyLayoutModeChrome(layoutService, configurationService, storageService);
	onDidChangeLayoutModeEmitter.fire(mode);
}

export function applyLayoutModeChrome(
	layoutService: IWorkbenchLayoutService,
	configurationService: IConfigurationService,
	storageService?: IStorageService,
): void {
	const agent = getLayoutMode(layoutService) === 'agent';
	const root = layoutService.mainContainer;
	root.dataset.voltLayoutMode = agent ? 'agent' : 'ide';
	root.classList.toggle('volt-layout-agent', agent);
	if (!agent) {
		resetAgentStatusbarShift(root);
	}
	layoutService.setPartHidden(agent, Parts.ACTIVITYBAR_PART);
	layoutService.setPartHidden(agent, Parts.SIDEBAR_PART);
	const hideLeftSidebar = agent && !!storageService && isAgentLeftSidebarHidden(storageService);
	layoutService.setPartHidden(hideLeftSidebar, Parts.AUXILIARYBAR_PART);
	if (agent) {
		root.style.setProperty('--volt-agent-right-dock-width', '0px');
		root.classList.remove('volt-agent-right-collapsed');
	}
	const statusBarHiddenByUser = configurationService.getValue<boolean>(STATUSBAR_VISIBLE_KEY) === false;
	layoutService.setPartHidden(agent || statusBarHiddenByUser, Parts.STATUSBAR_PART);
	layoutService.updateCustomTitleBarVisibility();
	layoutService.layout();
	if (agent && !hideLeftSidebar) {
		const size = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (size.width !== AGENT_LIST_WIDTH) {
			layoutService.setSize(Parts.AUXILIARYBAR_PART, {
				width: AGENT_LIST_WIDTH,
				height: size.height,
			});
		}
	}
	if (agent) {
		const titlebarHeight = layoutService.getSize(Parts.TITLEBAR_PART).height;
		if (titlebarHeight > 0) {
			root.style.setProperty('--volt-agent-titlebar-height', `${Math.round(titlebarHeight)}px`);
		}
	}
	if (hideLeftSidebar) {
		root.style.setProperty('--volt-agent-sidebar-width', '0px');
		root.classList.add('volt-agent-left-collapsed');
	}
}

const titleBarWhen = IsAuxiliaryWindowContext.negate();

registerAction2(class ToggleLayoutModeAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_LAYOUT_MODE_COMMAND_ID,
			title: localize2('volt.layoutMode.toggle', "Toggle Agent / IDE Layout"),
			category: Categories.View,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const next: LayoutMode = getLayoutMode(layoutService) === 'agent' ? 'ide' : 'agent';
		return setLayoutMode(accessor.get(IConfigurationService), layoutService, next, accessor.get(IStorageService));
	}
});

registerAction2(class SetAgentLayoutModeAction extends Action2 {
	constructor() {
		super({
			id: SET_AGENT_LAYOUT_MODE_COMMAND_ID,
			title: localize2('volt.layoutMode.setAgent', "Agent Mode"),
			category: Categories.View,
			f1: true,
			icon: agentLayoutIcon,
			toggled: LayoutModeContext.isEqualTo('agent'),
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: -1,
					when: ContextKeyExpr.and(titleBarWhen, LayoutModeContext.isEqualTo('ide')),
				},
				{
					id: MenuId.MenubarAppearanceMenu,
					group: '3_workbench_layout_move',
					order: 1,
				},
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return setLayoutMode(accessor.get(IConfigurationService), accessor.get(IWorkbenchLayoutService), 'agent', accessor.get(IStorageService));
	}
});

registerAction2(class SetIdeLayoutModeAction extends Action2 {
	constructor() {
		super({
			id: SET_IDE_LAYOUT_MODE_COMMAND_ID,
			title: localize2('volt.layoutMode.setIde', "IDE Mode"),
			category: Categories.View,
			f1: true,
			icon: ideLayoutIcon,
			toggled: LayoutModeContext.isEqualTo('ide'),
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: -1,
					when: ContextKeyExpr.and(titleBarWhen, LayoutModeContext.isEqualTo('agent')),
				},
				{
					id: MenuId.MenubarAppearanceMenu,
					group: '3_workbench_layout_move',
					order: 2,
				},
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return setLayoutMode(accessor.get(IConfigurationService), accessor.get(IWorkbenchLayoutService), 'ide', accessor.get(IStorageService));
	}
});

class LayoutModeChromeContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltLayoutModeChrome';

	private readonly layoutModeKey: IContextKey<LayoutMode>;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
	) {
		super();
		this.layoutModeKey = LayoutModeContext.bindTo(contextKeyService);
		this.layoutModeKey.set(getLayoutMode(layoutService));
		this._register(onDidChangeLayoutMode(next => this.layoutModeKey.set(next)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SIDEBAR_LOCATION_KEY)) {
				applyLayoutModeChrome(this.layoutService, this.configurationService, this.storageService);
				this.layoutModeKey.set(getLayoutMode(this.layoutService));
				this.keepAgentsOnAuxiliaryBar();
			}
		}));
		void this.finish();
	}

	private async finish(): Promise<void> {
		const mode = readStoredLayoutMode(this.storageService, this.layoutService);
		if (this.storageService.get(LAYOUT_MODE_STORAGE_KEY, StorageScope.PROFILE, '') !== mode) {
			this.storageService.store(LAYOUT_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
		}
		const location = mode === 'agent' ? 'right' : 'left';
		if (this.configurationService.getValue<string>(SIDEBAR_LOCATION_KEY) !== location) {
			await this.configurationService.updateValue(SIDEBAR_LOCATION_KEY, location);
		}
		if (mode === 'agent') {
			storeAgentLeftSidebarHidden(this.storageService, false);
		}
		applyLayoutModeChrome(this.layoutService, this.configurationService, this.storageService);
		this.layoutModeKey.set(getLayoutMode(this.layoutService));
		this.keepAgentsOnAuxiliaryBar();
		if (mode === 'agent') {
			await openAgentSidebar(this.configurationService, this.layoutService, this.paneCompositeService);
		}
	}

	private keepAgentsOnAuxiliaryBar(): void {
		const container = this.viewDescriptorService.getViewContainerById(AGENT_SIDE_PANEL_ID);
		if (!container) {
			return;
		}
		if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'voltAgentLayout');
		}
	}
}

registerWorkbenchContribution2(LayoutModeChromeContribution.ID, LayoutModeChromeContribution, WorkbenchPhase.AfterRestored);
