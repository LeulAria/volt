/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { OPEN_AUTOMATIONS_COMMAND_ID } from '../automations/automationCommands.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { OPEN_AGENT_CUSTOMIZE_COMMAND_ID } from '../editor/agentEditorInput.js';
import { OPEN_AGENT_USAGE_COMMAND_ID } from '../usage/agentUsageEditor.js';
import { createUsageIcon } from '../usage/agentUsageIcons.js';
import { AgentUsageHoverCard } from '../usage/agentUsageHoverCard.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { createHomeAutomationsIcon, createHomeSettingsIcon } from './agentHomeIcons.js';

export type AgentFooterAction = 'settings' | 'usage' | 'automations' | 'customize';

/**
 * Settings, Usage, Automations and Customize: the icon row at the foot of the agent list, also
 * at the foot of the Settings nav. Each runs its command; the buttons come back by id.
 */
export function appendAgentFooterActions(footer: HTMLElement, commandService: ICommandService, store: DisposableStore, instantiationService?: IInstantiationService): Record<AgentFooterAction, HTMLButtonElement> {
	const action = (id: AgentFooterAction, label: string, icon: () => Element, command: string, className = '') => {
		const button = append(footer, $(`button.volt-agent-home-settings${className}`)) as HTMLButtonElement;
		button.type = 'button';
		button.dataset.action = id;
		button.appendChild(icon());
		button.setAttribute('aria-label', label);
		if (id === 'usage' && instantiationService) {
			// Every account's limits on hover, instead of a plain "Usage" tooltip.
			store.add(instantiationService.createInstance(AgentUsageHoverCard, button));
		} else {
			setAgentTooltip(button, label);
		}
		store.add(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void commandService.executeCommand(command);
			button.blur();
		}));
		return button;
	};
	return {
		settings: action('settings', localize('voltAgent.home.settings', "Settings"), () => createHomeSettingsIcon(), OPEN_VOLT_SETTINGS_COMMAND_ID),
		usage: action('usage', localize('voltAgent.home.usage', "Usage"), () => createUsageIcon(14), OPEN_AGENT_USAGE_COMMAND_ID, '.volt-agent-home-usage'),
		automations: action('automations', localize('voltAgent.home.automations', "Automations"), () => createHomeAutomationsIcon(), OPEN_AUTOMATIONS_COMMAND_ID),
		customize: action('customize', localize('voltAgent.home.customize', "Customize"), () => renderIcon(Codicon.extensions), OPEN_AGENT_CUSTOMIZE_COMMAND_ID),
	};
}
