/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
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
import { OPEN_PULL_REQUESTS_PAGE_COMMAND_ID } from '../pullRequests/agentPullRequestCommands.js';
import { createHomeAutomationsIcon, createHomeCustomizeIcon, createHomePullRequestsIcon, createHomeSettingsIcon } from './agentHomeIcons.js';

export type AgentFooterAction = 'settings' | 'usage' | 'pullRequests' | 'automations' | 'customize';

export interface IAgentFooterActionSpec {
	readonly label: string;
	readonly icon: () => Element;
	readonly command: string;
	/** Extra class in the footer (Usage keeps its own). */
	readonly className?: string;
}

export const AGENT_FOOTER_ACTIONS: Readonly<Record<AgentFooterAction, IAgentFooterActionSpec>> = {
	settings: { label: localize('voltAgent.home.settings', "Settings"), icon: () => createHomeSettingsIcon(), command: OPEN_VOLT_SETTINGS_COMMAND_ID },
	usage: { label: localize('voltAgent.home.usage', "Usage"), icon: () => createUsageIcon(14), command: OPEN_AGENT_USAGE_COMMAND_ID, className: 'volt-agent-home-usage' },
	pullRequests: { label: localize('voltAgent.home.pullRequests', "Pull Requests"), icon: () => createHomePullRequestsIcon(), command: OPEN_PULL_REQUESTS_PAGE_COMMAND_ID },
	automations: { label: localize('voltAgent.home.automations', "Automations"), icon: () => createHomeAutomationsIcon(), command: OPEN_AUTOMATIONS_COMMAND_ID },
	customize: { label: localize('voltAgent.home.customize', "Customize"), icon: () => createHomeCustomizeIcon(), command: OPEN_AGENT_CUSTOMIZE_COMMAND_ID },
};

/** Runs the action's command on click; Usage shows every account's limits on hover instead of a tooltip. */
export function wireAgentFooterAction(button: HTMLButtonElement, id: AgentFooterAction, commandService: ICommandService, store: DisposableStore, instantiationService?: IInstantiationService): void {
	const spec = AGENT_FOOTER_ACTIONS[id];
	button.setAttribute('aria-label', spec.label);
	if (id === 'usage' && instantiationService) {
		store.add(instantiationService.createInstance(AgentUsageHoverCard, button, 'above'));
	} else {
		setAgentTooltip(button, spec.label);
	}
	store.add(addDisposableListener(button, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		void commandService.executeCommand(spec.command);
		button.blur();
	}));
}

/**
 * Settings, Usage, Pull Requests, Automations and Customize: the icon row at the foot of the Settings
 * nav and the Pull Requests page (the agent list's own footer places them by slot, agentHomePane.ts).
 * The buttons come back by id.
 */
export function appendAgentFooterActions(footer: HTMLElement, commandService: ICommandService, store: DisposableStore, instantiationService?: IInstantiationService): Record<AgentFooterAction, HTMLButtonElement> {
	const action = (id: AgentFooterAction) => {
		const spec = AGENT_FOOTER_ACTIONS[id];
		const button = append(footer, $(`button.volt-agent-home-settings${spec.className ? `.${spec.className}` : ''}`)) as HTMLButtonElement;
		button.type = 'button';
		button.dataset.action = id;
		button.appendChild(spec.icon());
		wireAgentFooterAction(button, id, commandService, store, instantiationService);
		return button;
	};
	return { settings: action('settings'), usage: action('usage'), pullRequests: action('pullRequests'), automations: action('automations'), customize: action('customize') };
}
