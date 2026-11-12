/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IVoltExtensionHostTicket } from './protocol.js';

export const IVoltAgentServerMainService = createDecorator<IVoltAgentServerMainService>('voltAgentServerMainService');
export const VOLT_AGENT_SERVER_CHANNEL_NAME = 'voltAgentServer';

/**
 * Windows run their agents in the agent server when this is on (the default). The main process
 * reads it too: the server then holds the relay connection instead of the main process.
 */
export const VOLT_AGENT_SERVER_ENABLED_SETTING = 'volt.agentServer.enabled';

/** Desktop only: lets the agent server listen on the network (it restarts). Add Device runs it. */
export const VOLT_ALLOW_NETWORK_COMMAND_ID = 'volt.agentServer.allowNetwork';

/** Where a window finds this profile's agent server. */
export interface IVoltAgentServerEndpoint {
	/** `ws://127.0.0.1:<port>/ws` */
	readonly url: string;
	readonly token: string;
	readonly port: number;
	readonly pid: number;
	/** Volt in the browser (the sign-in page, then the workbench). Carries no token: see `createLocalWebLink`. */
	readonly webUrl: string;
	/** Whether the server also listens on the local network (phones pair over it, with TLS). */
	readonly network: boolean;
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
	/**
	 * Volt in this computer's browser at `path` (default `/`), signed in once: the URL's fragment
	 * holds a single-use nonce valid for a minute. Starts the server if needed.
	 */
	createLocalWebLink(path?: string): Promise<string>;
	/**
	 * P6: a single-use ticket (a minute) for one connection of a sandboxed extension host to the
	 * server's workbench, with its port and connection token. Starts the server if needed.
	 */
	createExtensionHostTicket(): Promise<IVoltExtensionHostTicket & { readonly port: number }>;
}
