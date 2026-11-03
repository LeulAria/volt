/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { parseRelayLink } from '../../../../../platform/voltRelay/common/relayLink.js';
import { IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { agentServerEnabled } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { AutomationHookSync } from './automationHookSync.js';

export { hookedTriggers, hookUrl } from './automationHookSync.js';

export const VOLT_RELAY_CONNECT_COMMAND_ID = 'voltRelay.connect';
export const VOLT_RELAY_DISCONNECT_COMMAND_ID = 'voltRelay.disconnect';

/**
 * Webhook triggers for this window's automations. When agents run in the agent server, the server
 * holds the relay and runs the deliveries itself (with no window open); this window does nothing.
 */
class AutomationHooksContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAutomationHooks';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (!agentServerEnabled(configurationService)) {
			this._register(instantiationService.createInstance(AutomationHookSync));
		}
	}
}

registerWorkbenchContribution2(AutomationHooksContribution.ID, AutomationHooksContribution, WorkbenchPhase.AfterRestored);

let pendingRelayConnect: Promise<IVoltRelayState | undefined> | undefined;

/** Asks for a link from `volt-relay pair` (or a URL and a code) and connects this Volt to it. */
export function connectVoltRelay(relay: IVoltRelayService, quickInput: IQuickInputService, notifications: INotificationService): Promise<IVoltRelayState | undefined> {
	// One prompt at a time: a second click on Connect while the link is being pasted joins the first.
	pendingRelayConnect ??= askAndConnect(relay, quickInput, notifications).finally(() => pendingRelayConnect = undefined);
	return pendingRelayConnect;
}

async function askAndConnect(relay: IVoltRelayService, quickInput: IQuickInputService, notifications: INotificationService): Promise<IVoltRelayState | undefined> {
	const link = await quickInput.input({
		prompt: localize('voltRelay.linkPrompt', "Paste the link from volt-relay pair"),
		placeHolder: 'https://relay.example.com/#pair=ABCD-EFGH',
		ignoreFocusLost: true,
		validateInput: async value => parseRelayLink(value) ? undefined : localize('voltRelay.badLink', "That is not a relay link."),
	});
	if (!link) {
		return undefined;
	}
	try {
		const state = await relay.connect(link);
		notifications.info(localize('voltRelay.connected', "Connected to {0}.", state.relayName ?? state.url ?? 'Volt Relay'));
		return state;
	} catch (err) {
		notifications.error(localize('voltRelay.connectFailed', "Could not connect to the relay: {0}", err instanceof Error ? err.message : String(err)));
		return undefined;
	}
}

registerAction2(class ConnectVoltRelayAction extends Action2 {
	constructor() {
		super({
			id: VOLT_RELAY_CONNECT_COMMAND_ID,
			title: localize2('voltRelay.connectCommand', "Connect to Volt Relay…"),
			category: localize2('voltAgent.category', "Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await connectVoltRelay(accessor.get(IVoltRelayService), accessor.get(IQuickInputService), accessor.get(INotificationService));
	}
});

registerAction2(class DisconnectVoltRelayAction extends Action2 {
	constructor() {
		super({
			id: VOLT_RELAY_DISCONNECT_COMMAND_ID,
			title: localize2('voltRelay.disconnectCommand', "Disconnect from Volt Relay"),
			category: localize2('voltAgent.category', "Agent"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltRelayService).disconnect();
	}
});
