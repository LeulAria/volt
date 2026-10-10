/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { AgentServerCapability } from '../../../platform/voltAgentServer/common/protocol.js';
import { IAgentServerClientInfo } from '../../../platform/voltAgentServer/common/protocolServer.js';

export const IAgentServerClients = createDecorator<IAgentServerClients>('agentServerClients');

/** The clients connected to the agent server, and the things only they can do. */
export interface IAgentServerClients {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	list(): IAgentServerClientInfo[];
	has(capability: AgentServerCapability): boolean;
	/** Calls the newest connected client that can; rejects when none is connected. */
	call<T>(capability: AgentServerCapability, method: string, ...params: unknown[]): Promise<T>;
}
