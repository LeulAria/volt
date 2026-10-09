/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltExternalMcpService = createDecorator<IVoltExternalMcpService>('voltExternalMcpService');
export const VOLT_EXTERNAL_MCP_CHANNEL_NAME = 'voltExternalMcp';

/** Settings (the window pushes them to the main process with `configure`). */
export const EXTERNAL_MCP_ENABLED_SETTING = 'volt.externalMcp.enabled';
export const EXTERNAL_MCP_PORT_SETTING = 'volt.externalMcp.port';
export const EXTERNAL_MCP_PUBLIC_URL_SETTING = 'volt.externalMcp.publicUrl';

/** Stable, so `claude mcp add … http://127.0.0.1:47651/mcp` keeps working across restarts. */
export const DEFAULT_EXTERNAL_MCP_PORT = 47651;

/**
 * What an outside agent may do, chosen on the consent screen:
 * - `read`: list, search and read chats, their queues and checkouts; wait on them.
 * - `send`: message chats, interrupt them, edit their queues.
 * - `launch`: start new chats and fork existing ones (they run on the user's models and spend).
 * - `admin`: rename, archive and pin chats, move them to another model.
 */
export type ExternalMcpScope = 'read' | 'send' | 'launch' | 'admin';
export const EXTERNAL_MCP_SCOPES: readonly ExternalMcpScope[] = ['read', 'send', 'launch', 'admin'];
/** Asked for when a client names no scope: everything but admin. */
export const DEFAULT_EXTERNAL_MCP_SCOPES: readonly ExternalMcpScope[] = ['read', 'send', 'launch'];

/** A tool the window serves to outside agents, with the scope that unlocks it. */
export interface IExternalMcpToolInfo {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: object;
	readonly scope: ExternalMcpScope;
}

export interface IExternalMcpConfig {
	readonly enabled: boolean;
	readonly port: number;
	/** An https origin (a tunnel) that also reaches this server; '' when none. */
	readonly publicUrl: string;
}

export interface IExternalMcpStatus {
	readonly enabled: boolean;
	readonly listening: boolean;
	readonly port: number;
	/** `http://127.0.0.1:<port>/mcp` */
	readonly url: string;
	/** `<publicUrl>/mcp` when a tunnel is set. */
	readonly publicMcpUrl?: string;
	/** Why it is not listening (port taken, …). */
	readonly error?: string;
}

/** An outside agent the user allowed, as the Connected agents page lists it. */
export interface IExternalMcpGrantView {
	readonly id: string;
	readonly clientId: string;
	/** The name the agent registered with. Volt cannot verify it. */
	readonly clientName: string;
	readonly redirectUri: string;
	readonly scopes: readonly ExternalMcpScope[];
	readonly createdAt: number;
	readonly lastUsedAt?: number;
	readonly lastTool?: string;
	readonly calls: number;
	/** The URL the agent connected through (loopback or the tunnel). */
	readonly resource: string;
}

/** An agent asked to connect; the window shows the consent screen. */
export interface IExternalMcpConsentRequest {
	readonly id: string;
	/** The window that should ask (the one the user used last). */
	readonly windowId: string;
	readonly clientId: string;
	readonly clientName: string;
	readonly clientUri?: string;
	readonly redirectUri: string;
	readonly scopes: readonly ExternalMcpScope[];
	/** The client registered in this request's minute: a new app, not one seen before. */
	readonly newClient: boolean;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface IExternalMcpConsentDecision {
	readonly approve: boolean;
	/** Narrower than requested when the user unticked some. */
	readonly scopes?: readonly ExternalMcpScope[];
}

/** An outside agent called a tool; the window in `windowId` answers with `respond`. */
export interface IExternalMcpCall {
	readonly id: string;
	readonly windowId: string;
	readonly grantId: string;
	readonly clientId: string;
	readonly clientName: string;
	readonly scopes: readonly ExternalMcpScope[];
	readonly name: string;
	readonly args: unknown;
}

export interface IExternalMcpResult {
	readonly content: readonly unknown[];
	readonly isError?: boolean;
}

/**
 * Volt's orchestrator as an MCP server for agents Volt did not launch (Claude Code, Codex,
 * Cursor, connectors through a tunnel). Streamable HTTP on a stable loopback port, behind OAuth
 * 2.1 (RFC 9728 resource metadata, RFC 8414 server metadata, RFC 7591 registration, PKCE S256,
 * short access tokens and rotating refresh tokens stored as hashes). The user approves each agent
 * in a Volt window and can revoke it on Settings > Connected agents.
 */
export interface IVoltExternalMcpService {
	readonly _serviceBrand: undefined;
	readonly onDidCall: Event<IExternalMcpCall>;
	readonly onDidCancel: Event<{ readonly id: string; readonly windowId: string }>;
	readonly onDidRequestConsent: Event<IExternalMcpConsentRequest>;
	/** A consent request was answered, expired or replaced: windows close its screen. */
	readonly onDidEndConsent: Event<{ readonly id: string }>;
	readonly onDidChangeGrants: Event<void>;
	readonly onDidChangeStatus: Event<IExternalMcpStatus>;
	/** Starts, moves or stops the server. Every window sends the same settings; it is idempotent. */
	configure(config: IExternalMcpConfig): Promise<IExternalMcpStatus>;
	getStatus(): Promise<IExternalMcpStatus>;
	/**
	 * The window offers to answer tool calls and consent requests with these tools. The window the
	 * user focused last answers (`focus`).
	 */
	attach(windowId: string, tools: readonly IExternalMcpToolInfo[]): Promise<void>;
	detach(windowId: string): Promise<void>;
	focus(windowId: string): Promise<void>;
	respond(id: string, result: IExternalMcpResult): Promise<void>;
	pendingConsents(): Promise<readonly IExternalMcpConsentRequest[]>;
	answerConsent(id: string, decision: IExternalMcpConsentDecision): Promise<void>;
	listGrants(): Promise<readonly IExternalMcpGrantView[]>;
	/** The agent's tokens stop working at once; its next call gets 401. */
	revoke(grantId: string): Promise<void>;
}
