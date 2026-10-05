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
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { AGENT_SIDE_PANEL_ID, stampLayoutModeChrome } from './agentLayoutChrome.js';
import { LAYOUT_MODE_CONTEXT_KEY } from './layoutKeybindingMode.js';
import { AGENT_LIST_WIDTH, AGENT_SIDEBAR_MIN_WIDTH, AGENT_LEFT_SIDEBAR_HIDDEN_KEY, LAYOUT_MODE_STORAGE_KEY, readStoredLayoutModeValue, SIDEBAR_LOCATION_KEY, type LayoutMode } from './layoutModeStartup.js';

export type { LayoutMode } from './layoutModeStartup.js';
export { AGENT_LEFT_SIDEBAR_HIDDEN_KEY } from './layoutModeStartup.js';

export const TOGGLE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.toggleAgentIdeLayout';
export const SET_AGENT_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setAgentLayoutMode';
export const SET_IDE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setIdeLayoutMode';

const STATUSBAR_VISIBLE_KEY = 'workbench.statusBar.visible';

export const LayoutModeContext = new RawContextKey<LayoutMode>(LAYOUT_MODE_CONTEXT_KEY, 'ide', localize('volt.layoutMode.context', "Whether the window is in Agent mode ('agent') or IDE mode ('ide')."));
export const AGENT_RIGHT_DOCK_COLLAPSED_KEY = 'volt.agent.rightDock.collapsed.v2';
export const AGENT_RIGHT_DOCK_COLLAPSED_WIDTH = 0;
/** Quick Open Actions no longer reserve a column; they sit in the chat scroller. */
export const AGENT_RIGHT_DOCK_EXPANDED_WIDTH = 0;

const onDidChangeLayoutModeEmitter = new Emitter<LayoutMode>();
export const onDidChangeLayoutMode = onDidChangeLayoutModeEmitter.event;
/** Fires before the parts move, so views can hold off resizing until the switch settles. */
const onWillChangeLayoutModeEmitter = new Emitter<LayoutMode>();
export const onWillChangeLayoutMode = onWillChangeLayoutModeEmitter.event;

export function isAgentLeftSidebarHidden(storageService: IStorageService): boolean {
	return storageService.getBoolean(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, StorageScope.PROFILE, false);
}

export function storeAgentLeftSidebarHidden(storageService: IStorageService, hidden: boolean): void {
	storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, hidden, StorageScope.PROFILE, StorageTarget.USER);
}

export function readStoredLayoutMode(storageService: IStorageService, layoutService: IWorkbenchLayoutService): LayoutMode {
	const stored = storageService.get(LAYOUT_MODE_STORAGE_KEY, StorageScope.PROFILE, '');
	return readStoredLayoutModeValue(stored, layoutService.getSideBarPosition() === Position.RIGHT);
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

/** The list floats over the chat (a narrow window) instead of taking a column. */
export function isAgentDrawerMode(layoutService: IWorkbenchLayoutService): boolean {
	return layoutService.mainContainer.classList.contains('volt-agent-drawer-mode');
}

/** Whether the agent list is on screen, as a column or as the open drawer. */
export function isAgentSidebarShowing(layoutService: IWorkbenchLayoutService): boolean {
	if (isAgentDrawerMode(layoutService)) {
		return layoutService.mainContainer.classList.contains('volt-agent-drawer-open');
	}
	const visible = layoutService.isVisible(Parts.AUXILIARYBAR_PART);
	return visible && layoutService.getSize(Parts.AUXILIARYBAR_PART).width >= AGENT_SIDEBAR_MIN_WIDTH;
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
	if (!layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
		layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	}
	await paneCompositeService.openPaneComposite(AGENT_SIDE_PANEL_ID, ViewContainerLocation.AuxiliaryBar, true);
	const size = layoutService.getSize(Parts.AUXILIARYBAR_PART);
	if (size.width < AGENT_SIDEBAR_MIN_WIDTH && !isAgentDrawerMode(layoutService)) {
		layoutService.setSize(Parts.AUXILIARYBAR_PART, {
			width: AGENT_LIST_WIDTH,
			height: size.height,
		});
	}
}

export async function setLayoutMode(
	configurationService: IConfigurationService,
	layoutService: IWorkbenchLayoutService,
	mode: LayoutMode,
	storageService: IStorageService,
): Promise<void> {
	onWillChangeLayoutModeEmitter.fire(mode);
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

function hidePartIfNeeded(layoutService: IWorkbenchLayoutService, part: Parts, hidden: boolean): boolean {
	if (layoutService.isVisible(part) === !hidden) {
		return false;
	}
	layoutService.setPartHidden(hidden, part);
	return true;
}

export function applyLayoutModeChrome(
	layoutService: IWorkbenchLayoutService,
	configurationService: IConfigurationService,
	storageService?: IStorageService,
): void {
	const agent = getLayoutMode(layoutService) === 'agent';
	const root = layoutService.mainContainer;
	// A drawer is closed unless it is showing now; the saved choice is for the column.
	const hideLeftSidebar = agent && (isAgentDrawerMode(layoutService)
		? !root.classList.contains('volt-agent-drawer-open')
		: !!storageService && isAgentLeftSidebarHidden(storageService));
	let changed = false;
	if (hidePartIfNeeded(layoutService, Parts.ACTIVITYBAR_PART, agent)) {
		changed = true;
	}
	if (hidePartIfNeeded(layoutService, Parts.SIDEBAR_PART, agent)) {
		changed = true;
	}
	if (hidePartIfNeeded(layoutService, Parts.AUXILIARYBAR_PART, hideLeftSidebar)) {
		changed = true;
	}
	const statusBarHiddenByUser = configurationService.getValue<boolean>(STATUSBAR_VISIBLE_KEY) === false;
	if (hidePartIfNeeded(layoutService, Parts.STATUSBAR_PART, agent || statusBarHiddenByUser)) {
		changed = true;
	}
	if (agent && !hideLeftSidebar && !isAgentDrawerMode(layoutService) && layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
		const size = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (size.width < AGENT_SIDEBAR_MIN_WIDTH) {
			layoutService.setSize(Parts.AUXILIARYBAR_PART, {
				width: AGENT_LIST_WIDTH,
				height: size.height,
			});
			changed = true;
		}
	}
	const sidebarWidth = agent && !hideLeftSidebar && layoutService.isVisible(Parts.AUXILIARYBAR_PART)
		? isAgentDrawerMode(layoutService) ? AGENT_LIST_WIDTH : layoutService.getSize(Parts.AUXILIARYBAR_PART).width
		: 0;
	const titlebarHeight = layoutService.getSize(Parts.TITLEBAR_PART).height;
	stampLayoutModeChrome(root, agent, sidebarWidth, titlebarHeight > 0 ? titlebarHeight : undefined);
	layoutService.updateCustomTitleBarVisibility();
	if (changed) {
		layoutService.layout();
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
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.layoutModeKey = LayoutModeContext.bindTo(contextKeyService);
		const mode = readStoredLayoutMode(this.storageService, this.layoutService);
		this.layoutModeKey.set(mode);
		this._register(onDidChangeLayoutMode(next => this.layoutModeKey.set(next)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SIDEBAR_LOCATION_KEY)) {
				applyLayoutModeChrome(this.layoutService, this.configurationService, this.storageService);
				this.layoutModeKey.set(getLayoutMode(this.layoutService));
				this.keepAgentsOnAuxiliaryBar();
			}
		}));
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (!this.disposed) {
				this.finish();
			}
		});
	}

	private disposed = false;

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private finish(): void {
		const mode = readStoredLayoutMode(this.storageService, this.layoutService);
		if (this.storageService.get(LAYOUT_MODE_STORAGE_KEY, StorageScope.PROFILE, '') !== mode) {
			this.storageService.store(LAYOUT_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
		}
		applyLayoutModeChrome(this.layoutService, this.configurationService, this.storageService);
		this.layoutModeKey.set(getLayoutMode(this.layoutService));
		this.keepAgentsOnAuxiliaryBar();
		const location = mode === 'agent' ? 'right' : 'left';
		if (this.configurationService.getValue<string>(SIDEBAR_LOCATION_KEY) !== location) {
			void this.configurationService.updateValue(SIDEBAR_LOCATION_KEY, location);
		}
		if (mode === 'agent' && !isAgentLeftSidebarHidden(this.storageService)) {
			void openAgentSidebar(this.configurationService, this.layoutService, this.paneCompositeService);
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

registerWorkbenchContribution2(LayoutModeChromeContribution.ID, LayoutModeChromeContribution, WorkbenchPhase.BlockStartup);
