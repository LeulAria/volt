/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltHostMcpService = createDecorator<IVoltHostMcpService>('voltHostMcpService');
export const VOLT_HOST_MCP_CHANNEL_NAME = 'voltHostMcp';

export interface IVoltHostMcpToolInfo {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: object;
	/** Lets a URL ask for a subset: `/mcp/<sessionId>?groups=core,image`. */
	readonly group?: string;
}

/** Where agents reach a window's server, and the bearer token every request must carry. */
export interface IVoltHostMcpEndpoint {
	/** `http://127.0.0.1:<port>/mcp` */
	readonly url: string;
	/** Send as `Authorization: Bearer <token>`. Random per server; never logged. */
	readonly token: string;
}

/** An agent called a tool on the server a window registered. The window answers with `respond`. */
export interface IVoltHostMcpCall {
	readonly id: string;
	readonly serverId: string;
	/** From the URL path `/mcp/<sessionId>`: the Volt chat the agent serves. */
	readonly sessionId?: string;
	readonly name: string;
	readonly args: unknown;
}

export interface IVoltHostMcpResult {
	readonly content: readonly unknown[];
	readonly isError?: boolean;
}

/**
 * Volt's own MCP server (questions, the in-app browser) for agents it launches. It runs in the
 * main process because the workbench renderer is sandboxed; each window registers a server and
 * answers the tool calls that come in on it.
 */
export interface IVoltHostMcpService {
	readonly _serviceBrand: undefined;
	readonly onDidCall: Event<IVoltHostMcpCall>;
	/** The agent dropped the HTTP request (timeout, cancelled turn) before an answer came. */
	readonly onDidCancel: Event<{ readonly id: string; readonly serverId: string }>;
	/**
	 * Starts (or updates the tools of) the server `serverId`. It listens on loopback only and answers
	 * only requests with its bearer token, a loopback Host and no browser Origin.
	 */
	start(serverId: string, tools: readonly IVoltHostMcpToolInfo[]): Promise<IVoltHostMcpEndpoint>;
	respond(id: string, result: IVoltHostMcpResult): Promise<void>;
	stop(serverId: string): Promise<void>;
}
