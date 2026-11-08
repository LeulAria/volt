/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { AGENT_USAGE_EDITOR_ID, AGENT_USAGE_INPUT_ID, OPEN_AGENT_USAGE_COMMAND_ID, USAGE_DOCK_SECTION_ID, USAGE_SECTION_ID, USAGE_SLOT_ITEM_ID } from '../common/voltUsage.js';
import { AgentDockUsage } from './agentDockUsage.js';
import { AgentUsageEditor, AgentUsageEditorInput, AgentUsageEditorInputSerializer } from './agentUsageEditor.js';
import { AgentUsageHoverCard } from './agentUsageHoverCard.js';
import { AgentUsagePage } from './agentUsagePage.js';

/** Volt Settings, which hosts the Usage page (core's command, run by id). */
const OPEN_VOLT_SETTINGS_COMMAND_ID = 'workbench.action.openVoltSettings';

/**
 * The Usage feature (the `volt.usage` built-in extension): the Usage page of Volt Settings, the
 * limits card on the Usage buttons, the side toolbar's Usage section, the old Usage tab and the
 * command that opens the page. Loaded on first use; all of it goes when the extension is disabled.
 */
export const usageModule: IVoltFeatureModule = {
	activate(host: IVoltFeatureModuleHost): void {
		const subscriptions = host.subscriptions;

		host.registerPart('settingsPage', USAGE_SECTION_ID, {
			create: (instantiationService, container) => instantiationService.createInstance(AgentUsagePage, container),
		});
		host.registerPart('itemHover', USAGE_SLOT_ITEM_ID, {
			attach: (instantiationService, anchor, placement) => instantiationService.createInstance(AgentUsageHoverCard, anchor, placement),
		});
		host.registerPart('dockSection', USAGE_DOCK_SECTION_ID, {
			create: (instantiationService, parent) => instantiationService.createInstance(AgentDockUsage, parent),
		});

		// The old Usage tab: tabs restored from earlier sessions still open (the agent window drops them as pages).
		subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(AgentUsageEditor, AGENT_USAGE_EDITOR_ID, localize('voltUsage.editorLabel', "Usage")),
			[new SyncDescriptor(AgentUsageEditorInput)],
		));
		host.registerEditorSerializer(AGENT_USAGE_INPUT_ID, new AgentUsageEditorInputSerializer());

		subscriptions.add(registerAction2(class OpenAgentUsageAction extends Action2 {
			constructor() {
				super({
					id: OPEN_AGENT_USAGE_COMMAND_ID,
					visibility: 'public',
					title: localize2('voltAgent.usage', "Show Agent Usage and Limits"),
					category: Categories.View,
					icon: Codicon.graph,
					f1: true,
				});
			}

			override async run(accessor: ServicesAccessor): Promise<void> {
				// Usage is a page of Volt Settings; it opens on its last page, so jump to Usage.
				const editorService = accessor.get(IEditorService);
				await accessor.get(ICommandService).executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
				const pane = editorService.activeEditorPane as unknown as { showSection?: (id: string) => void } | undefined;
				pane?.showSection?.(USAGE_SECTION_ID);
			}
		}));
	},
};
