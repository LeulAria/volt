/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AGENT_CHAT_MAX_WIDTH, AGENT_CHAT_MIN_WIDTH, AGENT_CHAT_WIDTH_SETTING } from '../../common/agentChatWidth.js';
import {
	AGENT_BADGE_SETTING,
	AGENT_NOTIFY_INPUT_SETTING,
	AGENT_NOTIFY_SOUND_SETTING,
	AGENT_NOTIFY_THREAD_SETTING,
} from '../../common/agentThreadAttention.js';
import { AgentThreadAttentionService, IAgentThreadAttentionService } from '../attention/agentThreadAttention.js';
import { AgentChatWidthContribution } from '../chat/agentChatWidth.js';
import { AGENT_COMPACT_LIST_SETTING } from '../home/agentHomeDensity.js';
import { showProjectIconPicker } from './agentProjectIconPicker.js';
import { AgentSidebarDecorationsContribution } from './agentSidebarDecorations.js';
import { AgentSidebarRailContribution, TOGGLE_AGENT_SIDEBAR_RAIL_COMMAND_ID, toggleAgentSidebarRail } from './agentSidebarRail.js';
import './agentProjectIconService.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.notifications',
	title: localize('voltNotifications.configTitle', "Notifications"),
	type: 'object',
	properties: {
		[AGENT_NOTIFY_THREAD_SETTING]: {
			type: 'string',
			enum: ['off', 'whenUnfocused', 'always'],
			enumDescriptions: [
				localize('voltNotifications.thread.off', "Never show a notification."),
				localize('voltNotifications.thread.whenUnfocused', "Only while Volt is not the focused app."),
				localize('voltNotifications.thread.always', "Also while Volt is focused, unless the chat is on screen."),
			],
			default: 'off',
			description: localize('voltNotifications.thread', "Show a system notification when an agent chat finishes or fails. Clicking it brings Volt forward and opens the chat."),
		},
		[AGENT_NOTIFY_INPUT_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltNotifications.input', "Also notify when a chat waits for your approval or an answer. Follows the setting above."),
		},
		[AGENT_NOTIFY_SOUND_SETTING]: {
			type: 'string',
			enum: ['none', 'system', 'chime', 'ping', 'bell'],
			enumItemLabels: [
				localize('voltNotifications.sound.none', "None"),
				localize('voltNotifications.sound.system', "System"),
				localize('voltNotifications.sound.chime', "Chime"),
				localize('voltNotifications.sound.ping', "Ping"),
				localize('voltNotifications.sound.bell', "Bell"),
			],
			enumDescriptions: [
				localize('voltNotifications.sound.noneDesc', "Silent."),
				localize('voltNotifications.sound.systemDesc', "The system's notification sound."),
				localize('voltNotifications.sound.chimeDesc', "A short rising chime."),
				localize('voltNotifications.sound.pingDesc', "A soft ping."),
				localize('voltNotifications.sound.bellDesc', "A bell."),
			],
			default: 'chime',
			description: localize('voltNotifications.sound', "The sound played with a chat notification. A chat that needs your input plays the action-required sound unless this is None. Volume follows Accessibility Signal Options."),
		},
		[AGENT_BADGE_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltNotifications.badge', "Count chats that finished while you were not looking at them on the app icon (the Dock on macOS, the taskbar on Windows, the launcher on Linux)."),
		},
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.agentLayout',
	title: localize('voltAgentLayout.configTitle', "Agent Layout"),
	type: 'object',
	properties: {
		[AGENT_COMPACT_LIST_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltAgentLayout.compactList', "Show the agent sidebar's chats as a denser list: smaller rows without the age and other secondary details."),
		},
		[AGENT_CHAT_WIDTH_SETTING]: {
			anyOf: [
				{ type: 'string', enum: ['narrow', 'default', 'wide', 'full'] },
				{ type: 'number', minimum: AGENT_CHAT_MIN_WIDTH, maximum: AGENT_CHAT_MAX_WIDTH },
			],
			default: 'default',
			markdownDescription: localize('voltAgentLayout.chatWidth', "How wide the chat transcript and composer may grow: `narrow` (600px), `default` (728px), `wide` (960px), `full` (the whole column), or a width in pixels from {0} to {1}.", AGENT_CHAT_MIN_WIDTH, AGENT_CHAT_MAX_WIDTH),
		},
	},
});

registerSingleton(IAgentThreadAttentionService, AgentThreadAttentionService, InstantiationType.Delayed);

/** Starts the attention service with the window, so it sees every chat end. */
class AgentThreadAttentionStarter implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentThreadAttention';
	constructor(@IAgentThreadAttentionService _attention: IAgentThreadAttentionService) { }
}

registerWorkbenchContribution2(AgentThreadAttentionStarter.ID, AgentThreadAttentionStarter, WorkbenchPhase.AfterRestored);
// The rail and the list's width must be known before the list is first drawn.
registerWorkbenchContribution2(AgentSidebarRailContribution.ID, AgentSidebarRailContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AgentSidebarDecorationsContribution.ID, AgentSidebarDecorationsContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AgentChatWidthContribution.ID, AgentChatWidthContribution, WorkbenchPhase.BlockRestore);

registerAction2(class ToggleAgentSidebarRailAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_AGENT_SIDEBAR_RAIL_COMMAND_ID,
			title: localize2('voltAgent.toggleSidebarRail', "Toggle Agent Sidebar Icon Rail"),
			category: Categories.View,
			f1: true,
		});
	}
	run(): void {
		toggleAgentSidebarRail();
	}
});

registerAction2(class ToggleAgentCompactListAction extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.toggleCompactList',
			title: localize2('voltAgent.toggleCompactList', "Toggle Compact Agent List"),
			category: Categories.View,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue(AGENT_COMPACT_LIST_SETTING, configuration.getValue<boolean>(AGENT_COMPACT_LIST_SETTING) !== true);
	}
});

registerAction2(class ChangeProjectIconAction extends Action2 {
	constructor() {
		super({
			id: 'volt.agent.changeProjectIcon',
			title: localize2('voltAgent.changeProjectIcon', "Change Project Icon…"),
			category: Categories.View,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const sessionContext = accessor.get(IVoltSessionContextService);
		const quickInput = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);
		const active = sessionContext.activeProject?.root.toString();
		type Item = IQuickPickItem & { readonly project: typeof sessionContext.projects[number] };
		const items: Item[] = sessionContext.projects.map(project => ({
			label: project.displayName,
			description: project.root.scheme === 'file' ? project.root.fsPath : project.root.toString(),
			project,
		}));
		// The open project first.
		items.sort((a, b) => Number(b.project.root.toString() === active) - Number(a.project.root.toString() === active));
		const picked = await quickInput.pick(items, { placeHolder: localize('voltAgent.changeProjectIcon.pick', "Choose a project") });
		if (picked) {
			showProjectIconPicker(instantiationService, picked.project.root, picked.project.displayName);
		}
	}
});
