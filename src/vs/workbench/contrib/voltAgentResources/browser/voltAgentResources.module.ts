/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { AgentSidePanel } from '../../voltAgent/browser/chrome/agentSidePanel.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { AGENT_RESOURCES_SECTIONS, AgentResourcesSectionId } from '../../voltAgent/browser/resources/agentResourcesPage.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { AGENT_RESOURCES_EDITOR_ID, AGENT_RESOURCES_INPUT_ID, OPEN_AGENT_RESOURCES_COMMAND_ID } from '../common/voltAgentResources.js';
import { AgentResourcesEditor, AgentResourcesEditorInput, AgentResourcesEditorInputSerializer } from './agentResourcesEditor.js';

/**
 * The Agent Resources feature (the `volt.agent-resources` built-in extension): its page and the
 * commands that open it, loaded on first use and gone when the extension is disabled. The scan
 * service, the sections Customize embeds and the files sidebar's filter are core's.
 */
export const agentResourcesModule: IVoltFeatureModule = {
	activate(host: IVoltFeatureModuleHost): void {
		const subscriptions = host.subscriptions;

		subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(AgentResourcesEditor, AGENT_RESOURCES_EDITOR_ID, localize('agentResources.editorLabel', "Agent Resources")),
			[new SyncDescriptor(AgentResourcesEditorInput)]
		));
		host.registerEditorSerializer(AGENT_RESOURCES_INPUT_ID, new AgentResourcesEditorInputSerializer());

		subscriptions.add(registerAction2(class OpenAgentResourcesAction extends Action2 {
			constructor() {
				super({
					id: OPEN_AGENT_RESOURCES_COMMAND_ID,
					visibility: 'public',
					title: localize2('agentResources.open', "Open Agent Resources"),
					category: Categories.View,
					icon: Codicon.layers,
					f1: true,
				});
			}

			override async run(accessor: ServicesAccessor, section?: unknown, folder?: unknown): Promise<void> {
				const id = typeof section === 'string' && AGENT_RESOURCES_SECTIONS.some(candidate => candidate.id === section) ? section as AgentResourcesSectionId : undefined;
				const uri = URI.isUri(folder) ? folder : typeof folder === 'string' ? URI.parse(folder) : undefined;
				if (id || uri) {
					AgentResourcesEditor.request({ section: id, folder: uri });
				}
				const input = accessor.get(IInstantiationService).createInstance(AgentResourcesEditorInput);
				// In the agent window the page takes the main panel, like Customize.
				revealAgentSidePanel(accessor.get(IWorkbenchLayoutService));
				const view = await accessor.get(IViewsService).openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, false);
				if (view) {
					await view.openEditorPage(input);
					return;
				}
				await accessor.get(IEditorService).openEditor(input, { pinned: true });
			}
		}));

		// Shortcuts into each section, for the command palette.
		for (const section of AGENT_RESOURCES_SECTIONS) {
			if (section.id === 'overview') {
				continue;
			}
			subscriptions.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: agentResourcesSectionCommandId(section.id),
						visibility: 'public',
						title: agentResourcesSectionCommandTitle(section.label),
						f1: true,
					});
				}

				override async run(accessor: ServicesAccessor): Promise<void> {
					await accessor.get(ICommandService).executeCommand(OPEN_AGENT_RESOURCES_COMMAND_ID, section.id);
				}
			}));
		}
	},
};

function agentResourcesSectionCommandId(section: AgentResourcesSectionId): string {
	return `${OPEN_AGENT_RESOURCES_COMMAND_ID}.${section}`;
}

function agentResourcesSectionCommandTitle(label: string) {
	return { value: localize('agentResources.openSection', "Agent Resources: {0}", label), original: `Agent Resources: ${label}` };
}
