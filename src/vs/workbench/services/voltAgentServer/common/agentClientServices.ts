/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentServerClientKind, AgentServerTopic } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IWebSocketLike } from '../../../../platform/voltAgentServer/common/connection.js';
import { IAgentSessionMeta } from '../../voltRuntime/common/history/agentHistory.js';
import { IOrchPrompt } from '../../voltRuntime/common/orchestration/orchestrator.js';
import { IVoltProjectRecord, workspaceForProject } from '../../voltRuntime/common/sessionContext.js';
import { AgentServerClient } from './agentServerClient.js';
import { RemoteAgentHistoryService } from './remoteAgentHistoryService.js';
import { RemoteAgentOrchestratorService } from './remoteAgentOrchestratorService.js';
import { RemoteAgentRuntimeService } from './remoteAgentRuntimeService.js';
import { RemoteVoltSessionContextService } from './remoteVoltSessionContextService.js';

/** Synchronous key/value storage for a client's own choices (selected project, model); per device. */
export interface IAgentClientStorage {
	get(key: string, scope?: unknown, fallback?: string): string | undefined;
	store(key: string, value: string, ...rest: unknown[]): void;
	remove(key: string, ...rest: unknown[]): void;
}

export interface IAgentClientServicesOptions {
	readonly kind: AgentServerClientKind;
	/** Where the server is and the token it accepts; asked again before every reconnect. */
	readonly endpoint: () => Promise<{ readonly url: string; readonly token: string }>;
	readonly createSocket: (url: string) => IWebSocketLike;
	readonly storage: IAgentClientStorage;
	readonly topics?: readonly AgentServerTopic[];
	readonly onError?: (method: string, err: unknown) => void;
}

/**
 * The agent server as a client without a workbench sees it (the web app and the mobile app): the
 * connection and the same remote services the desktop window runs on. No DOM.
 */
export class AgentClientServices extends Disposable {

	readonly client: AgentServerClient;
	readonly runtime: RemoteAgentRuntimeService;
	readonly orchestrator: RemoteAgentOrchestratorService;
	readonly history: RemoteAgentHistoryService;
	readonly projects: RemoteVoltSessionContextService;

	constructor(options: IAgentClientServicesOptions) {
		super();
		this.client = this._register(new AgentServerClient({
			endpoint: options.endpoint,
			createSocket: options.createSocket,
			client: { kind: options.kind, id: generateUuid(), topics: options.topics ?? ['col', 'session', 'hostTools', 'server'] },
			onError: options.onError,
		}));
		this.runtime = this._register(new RemoteAgentRuntimeService(this.client));
		this.orchestrator = this._register(new RemoteAgentOrchestratorService(this.client));
		const workspace = { getWorkspace: () => ({ id: `volt-${options.kind}`, folders: [] }) };
		const environment = { userRoamingDataHome: URI.file('/') };
		this.history = this._register(new RemoteAgentHistoryService(this.client, workspace as never, environment as never));
		this.projects = this._register(new RemoteVoltSessionContextService(this.client, options.storage as never));
	}

	connect(): void {
		this.client.connect();
	}
}

/** The chats a client lists at home: top-level chats, not subagents or delegated tasks. */
export function homeSessions(services: AgentClientServices, options?: { readonly includeArchived?: boolean }): IAgentSessionMeta[] {
	return services.history.list({ includeArchived: options?.includeArchived ?? false })
		.filter(session => !session.subagent && !services.orchestrator.getThread(session.id)?.taskId);
}

/** The model a send uses: the one picked in this composer, else the chat's, else the active one. */
export function currentModelRef(services: AgentClientServices, sessionId: string | undefined, picked: string | undefined): string | undefined {
	const thread = sessionId ? services.orchestrator.getThread(sessionId) : undefined;
	return picked ?? thread?.modelRef ?? services.runtime.getActiveCatalogRef();
}

/** A new chat runs in its project: the workspace is pinned and the chat bound, as the window does. */
export function bindChatToProject(services: AgentClientServices, sessionId: string, project: IVoltProjectRecord): void {
	services.history.pinSessionWorkspace(sessionId, workspaceForProject(project));
	services.projects.bindSession(sessionId, project.id);
}

export interface IAgentClientSend {
	readonly text: string;
	/** Absent or without messages yet: a new chat, which needs a project. */
	readonly sessionId?: string;
	readonly isNewChat: boolean;
	readonly project?: IVoltProjectRecord;
	readonly modelRef?: string;
	readonly mode?: string;
}

/**
 * Sends a prompt the way every client does: a new chat is bound to its project first, then the
 * prompt goes to the orchestrator (which queues or steers when the chat is busy).
 * Returns the chat id, or undefined when a new chat has no project.
 */
export function sendAgentPrompt(services: AgentClientServices, send: IAgentClientSend): { readonly sessionId: string; readonly done: Promise<unknown> } | undefined {
	const text = send.text.trim();
	if (!text) {
		return undefined;
	}
	const sessionId = send.sessionId ?? `agent-${generateUuid()}`;
	if (send.isNewChat) {
		if (!send.project) {
			return undefined;
		}
		bindChatToProject(services, sessionId, send.project);
	}
	const ref = send.modelRef;
	const prompt: IOrchPrompt = {
		text,
		mode: send.mode ?? 'Agent',
		...(ref ? { modelRef: ref, options: services.runtime.getModelOptions(ref) } : {}),
	};
	return { sessionId, done: services.orchestrator.submit(sessionId, prompt, 'auto', generateUuid()) };
}

/** Stops a chat's running turn (and the subagents it started for that turn). */
export function stopAgentTurn(services: AgentClientServices, sessionId: string): Promise<unknown> {
	return services.orchestrator.cancel(sessionId, { cascade: 'turn' });
}

export { agentTurnStatus, formatWorkedDuration, type IAgentTurnStatusSource } from '../../voltRuntime/common/agentTurnStatus.js';
