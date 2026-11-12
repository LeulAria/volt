/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { revealAgentSidePanel } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import type { AgentSidePanel } from '../../voltAgent/browser/chrome/agentSidePanel.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { closeModuleEditorsOnUnload, embedModuleEditor, IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { ISkillsEmbeddedPage, IVoltSkillsModule, OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID, SKILLS_EDITOR_ID, SKILLS_EDITOR_INPUT_TYPE_ID } from '../common/voltSkills.js';
import { AgentCustomizeEditor, AgentCustomizeEditorInput, AgentCustomizeEditorInputSerializer } from './agentCustomizeEditor.js';

function registerCommands(store: DisposableStore): void {
	store.add(registerAction2(class OpenAgentCustomizeAction extends Action2 {
		constructor() {
			super({
				id: OPEN_SKILLS_COMMAND_ID,
				visibility: 'public',
				title: localize2('voltAgent.customize', "Customize Agent"),
				category: Categories.View,
				icon: Codicon.extensions,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const instantiationService = accessor.get(IInstantiationService);
			const editorService = accessor.get(IEditorService);
			revealAgentSidePanel(accessor.get(IWorkbenchLayoutService));
			const view = await accessor.get(IViewsService).openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, false);
			if (view) {
				await view.openPage(SKILLS_EDITOR_INPUT_TYPE_ID, () => instantiationService.createInstance(AgentCustomizeEditorInput));
				return;
			}
			await editorService.openEditor(instantiationService.createInstance(AgentCustomizeEditorInput), { pinned: true });
		}
	}));

	store.add(registerAction2(class OpenAgentMarketplaceAction extends Action2 {
		constructor() {
			super({
				id: OPEN_SKILLS_MARKETPLACE_COMMAND_ID,
				visibility: 'public',
				title: localize2('voltAgent.marketplace', "Browse Skills and Plugins Marketplace"),
				category: Categories.View,
				icon: Codicon.extensions,
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			AgentCustomizeEditor.requestView('marketplace');
			await accessor.get(ICommandService).executeCommand(OPEN_SKILLS_COMMAND_ID);
		}
	}));
}

/**
 * The Skills & Plugins tab, as a module of the `volt.skills-and-plugins` built-in extension: its
 * commands and its editor (the tab, and the page Volt Settings hosts). Everything it registers goes
 * into `host.subscriptions`, so disabling the extension unloads it.
 */
class VoltSkillsModule implements IVoltFeatureModule, IVoltSkillsModule {

	private host: IVoltFeatureModuleHost | undefined;

	activate(host: IVoltFeatureModuleHost): void {
		this.host = host;
		registerCommands(host.subscriptions);
		host.subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(AgentCustomizeEditor, SKILLS_EDITOR_ID, localize('voltCustomize.editorLabel', "Customize")),
			[new SyncDescriptor(AgentCustomizeEditorInput)]
		));
		host.registerEditorSerializer(SKILLS_EDITOR_INPUT_TYPE_ID, new AgentCustomizeEditorInputSerializer());
		closeModuleEditorsOnUnload(host, [SKILLS_EDITOR_INPUT_TYPE_ID]);
		host.subscriptions.add(toDisposable(() => this.host = undefined));
	}

	createEmbeddedPage(parent: HTMLElement, group: IEditorGroup): ISkillsEmbeddedPage {
		const host = this.host;
		if (!host) {
			throw new Error('The Skills & Plugins module is not loaded.');
		}
		return embedModuleEditor(host, host.instantiationService.createInstance(AgentCustomizeEditor, group), new AgentCustomizeEditorInput(), parent);
	}
}

export const voltSkillsModule: IVoltFeatureModule & IVoltSkillsModule = new VoltSkillsModule();
