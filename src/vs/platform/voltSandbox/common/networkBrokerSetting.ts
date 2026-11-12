/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

/**
 * Which egress filter a sandboxed run's network `proxy` mode uses (spec M.3 C3 "Rollback"):
 * `broker` is the network broker (I.4, `node/networkBroker.ts`); `legacy` is the pre-broker proxy
 * (`node/sandboxProxy.ts`), kept for one release to roll back. Application scope: a workspace can't
 * pick the weaker one. Read at every launch, so a change applies to the next run.
 */
export type NetworkBrokerMode = 'broker' | 'legacy';

export const NETWORK_BROKER_SETTING = 'volt.sandbox.networkBroker';

export function readNetworkBrokerMode(value: unknown): NetworkBrokerMode {
	return value === 'legacy' ? 'legacy' : 'broker';
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.sandbox.networkBroker',
	title: localize('voltNetworkBroker.title', "Sandbox Network Broker"),
	type: 'object',
	properties: {
		[NETWORK_BROKER_SETTING]: {
			type: 'string',
			enum: ['broker', 'legacy'],
			enumDescriptions: [
				localize('voltNetworkBroker.broker', "Sandboxed chats reach the network through Volt's network broker: a route and token per run, the special-address table, live grants and budgets."),
				localize('voltNetworkBroker.legacy', "The earlier filtering proxy. For one release, to roll back."),
			],
			default: 'broker',
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltNetworkBroker.mode', "How a sandboxed chat with its network off reaches the hosts it is allowed. Applies to runs started after the change."),
		},
	},
});
