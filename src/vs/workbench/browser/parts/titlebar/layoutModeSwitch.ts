/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/layoutModeSwitch.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { resetAgentStatusbarShift } from './agentLayoutChrome.js';
import { AuxiliaryBarPart } from '../auxiliarybar/auxiliaryBarPart.js';

export const TOGGLE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.toggleAgentIdeLayout';
export const SET_AGENT_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setAgentLayoutMode';
export const SET_IDE_LAYOUT_MODE_COMMAND_ID = 'workbench.action.setIdeLayoutMode';

const SIDEBAR_LOCATION_KEY = 'workbench.sideBar.location';

export const AGENT_CHROME_HEIGHT = 28;

const agentLayoutIcon = registerIcon('volt-layout-agent', Codicon.robot, localize('volt.layoutMode.agentIcon', 'Icon for Agent Mode.'));
const ideLayoutIcon = registerIcon('volt-layout-ide', Codicon.code, localize('volt.layoutMode.ideIcon', 'Icon for IDE Mode.'));

export function getLayoutMode(layoutService: IWorkbenchLayoutService): LayoutMode {
	return layoutService.getSideBarPosition() === Position.RIGHT ? 'agent' : 'ide';
}

export async function setLayoutMode(
	configurationService: IConfigurationService,
	layoutService: IWorkbenchLayoutService,
	mode: LayoutMode,
): Promise<void> {
	const location = mode === 'agent' ? 'right' : 'left';
	if (configurationService.getValue<string>(SIDEBAR_LOCATION_KEY) !== location) {
		await configurationService.updateValue(SIDEBAR_LOCATION_KEY, location);
	}

	applyLayoutModeChrome(layoutService);
}

export function applyLayoutModeChrome(layoutService: IWorkbenchLayoutService): void {
	const agent = getLayoutMode(layoutService) === 'agent';
	layoutService.mainContainer.classList.toggle('volt-layout-agent', agent);
	if (!agent) {
		resetAgentStatusbarShift(layoutService.mainContainer);
	}
	layoutService.setPartHidden(agent, Parts.ACTIVITYBAR_PART);
	layoutService.setPartHidden(agent, Parts.SIDEBAR_PART);
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	layoutService.updateCustomTitleBarVisibility();
	layoutService.layout();
	if (agent) {
		const size = layoutService.getSize(Parts.AUXILIARYBAR_PART);
		if (size.width !== AuxiliaryBarPart.AGENT_DEFAULT_WIDTH) {
			layoutService.setSize(Parts.AUXILIARYBAR_PART, {
				width: AuxiliaryBarPart.AGENT_DEFAULT_WIDTH,
				height: size.height,
			});
		}
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
		return setLayoutMode(accessor.get(IConfigurationService), layoutService, next);
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
			toggled: ContextKeyExpr.equals(`config.${SIDEBAR_LOCATION_KEY}`, 'right'),
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: -1,
					when: ContextKeyExpr.and(
						titleBarWhen,
						ContextKeyExpr.equals(`config.${SIDEBAR_LOCATION_KEY}`, 'left'),
					),
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
		return setLayoutMode(accessor.get(IConfigurationService), accessor.get(IWorkbenchLayoutService), 'agent');
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
			toggled: ContextKeyExpr.equals(`config.${SIDEBAR_LOCATION_KEY}`, 'left'),
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: -1,
					when: ContextKeyExpr.and(
						titleBarWhen,
						ContextKeyExpr.equals(`config.${SIDEBAR_LOCATION_KEY}`, 'right'),
					),
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
		return setLayoutMode(accessor.get(IConfigurationService), accessor.get(IWorkbenchLayoutService), 'ide');
	}
});

class LayoutModeChromeContribution extends Disposable {
	static readonly ID = 'workbench.contrib.voltLayoutModeChrome';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this.createAgentChrome(commandService);
		applyLayoutModeChrome(layoutService);
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SIDEBAR_LOCATION_KEY)) {
				applyLayoutModeChrome(layoutService);
			}
		}));
	}

	private createAgentChrome(commandService: ICommandService): void {
		const chrome = append(this.layoutService.mainContainer, $('.volt-agent-chrome'));
		append(chrome, $('.volt-agent-chrome-drag'));
		const controls = append(chrome, $('.volt-agent-chrome-controls'));
		const ide = append(controls, $('button.volt-agent-ide-switch')) as HTMLButtonElement;
		ide.appendChild(renderIcon(ideLayoutIcon));
		ide.setAttribute('aria-label', localize('volt.layoutMode.setIde', "IDE Mode"));
		ide.title = localize('volt.layoutMode.setIde', "IDE Mode");
		this._register(addDisposableListener(ide, 'click', () => {
			void commandService.executeCommand(SET_IDE_LAYOUT_MODE_COMMAND_ID);
		}));
	}
}

registerWorkbenchContribution2(LayoutModeChromeContribution.ID, LayoutModeChromeContribution, WorkbenchPhase.AfterRestored);
