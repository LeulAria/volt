/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltAgentServerMainService = createDecorator<IVoltAgentServerMainService>('voltAgentServerMainService');
export const VOLT_AGENT_SERVER_CHANNEL_NAME = 'voltAgentServer';

/**
 * Windows run their agents in the agent server when this is on (the default). The main process
 * reads it too: the server then holds the relay connection instead of the main process.
 */
export const VOLT_AGENT_SERVER_ENABLED_SETTING = 'volt.agentServer.enabled';

/** Where a window finds this profile's agent server. */
export interface IVoltAgentServerEndpoint {
	/** `ws://127.0.0.1:<port>/ws` */
	readonly url: string;
	readonly token: string;
	readonly port: number;
	readonly pid: number;
	/** The web app, with the token in the hash. */
	readonly webUrl: string;
	/** Whether the server also listens on the local network (phones pair over it). */
	readonly network: boolean;
	/** The web app at this Mac's network address, with the token: what a phone pairs with. Set while `network` is on. */
	readonly pairingUrl?: string;
}

/**
 * The main process keeps the profile's agent server running (a launchd job on macOS, so it
 * outlives every window) and tells windows how to reach it.
 */
export interface IVoltAgentServerMainService {
	readonly _serviceBrand: undefined;
	/** Starts the server if it isn't running (or runs another build) and returns its endpoint. */
	ensureRunning(): Promise<IVoltAgentServerEndpoint>;
	/** Kills and restarts the server; runs pick up after it as they would after a crash. */
	restart(): Promise<IVoltAgentServerEndpoint>;
	/** Stops the server and removes its launchd job. */
	stop(): Promise<void>;
	/** Lets phones on the local network reach the server (the token is still required), or stops it; restarts the server. */
	setNetworkAccess(enabled: boolean): Promise<IVoltAgentServerEndpoint>;
}
