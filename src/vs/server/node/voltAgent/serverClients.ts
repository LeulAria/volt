/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { AgentServerCapability } from '../../../platform/voltAgentServer/common/protocol.js';
import { IAgentServerClientInfo, IClientCallOptions } from '../../../platform/voltAgentServer/common/protocolServer.js';

export const IAgentServerClients = createDecorator<IAgentServerClients>('agentServerClients');

/** The clients connected to the agent server, and the things only they can do. */
export interface IAgentServerClients {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	list(): IAgentServerClientInfo[];
	has(capability: AgentServerCapability): boolean;
	/** Calls the newest connected client that can; rejects when none is connected. */
	call<T>(capability: AgentServerCapability, method: string, ...params: unknown[]): Promise<T>;
	/** {@link call} with a preferred client and a time limit. */
	callWith<T>(capability: AgentServerCapability, options: IClientCallOptions, method: string, ...params: unknown[]): Promise<T>;
	/** {@link call}, preferring a client that has the chat open (its browser tab, its window). */
	callForChat<T>(capability: AgentServerCapability, sessionId: string | undefined, method: string, ...params: unknown[]): Promise<T>;
	/** The connections that have the chat open. */
	holders(sessionId: string): ReadonlySet<number>;
}
