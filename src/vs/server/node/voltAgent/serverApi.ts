/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentRepoResolver } from '../../../workbench/contrib/voltAgent/browser/home/agentRepoInfo.js';
import { ReplicatedCollection } from '../../../platform/voltAgentServer/common/collections.js';
import { ICollectionDelta } from '../../../platform/voltAgentServer/common/protocol.js';
import { AgentServerProtocol, IAgentServerCallContext } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IAgentCheckpointService } from '../../../workbench/contrib/voltAgent/browser/review/agentCheckpointService.js';
import { AgentPullRequestService, IAgentPullRequestService } from '../../../workbench/contrib/voltAgent/browser/pullRequests/agentPullRequestService.js';
import { AgentHistoryService } from '../../../workbench/services/voltRuntime/browser/history/agentHistoryService.js';
import { VoltSessionContextService } from '../../../workbench/services/voltRuntime/browser/sessionContextService.js';
import { IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { VOLT_MODES } from '../../../workbench/services/voltRuntime/common/modes.js';
import { IAgentOrchestratorService } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../workbench/services/voltRuntime/common/sessionContext.js';
import { ServerEditsJournal } from './serverEditsJournal.js';
import { ServerSessionHost } from './serverSessionHost.js';

/** Replicated collections the server publishes. Clients' mirrors answer synchronous getters from them. */
export const AGENT_SERVER_COLLECTIONS = [
	/** Runtime-wide settings and status: catalog, profiles, access mode, model options. */
	'runtime',
	/** Per chat: the runtime session summary (model, active run, worktree, steering). */
	'sessions',
	/** Per chat: pending questions. */
	'questions',
	/** `pending`: approvals waiting on the user. */
	'access',
	'orch.threads',
	'orch.tasks',
	/** `state`: the orchestrator's seq and conflicts. */
	'orch.meta',
	/** Per chat: its history index entry. */
	'history',
	/** `state`: which chats are on disk, and the pins. */
	'history.meta',
	/** Per project id: the project record; plus `bindings`. */
	'projects',
	/** Per chat: checkpoints and whether a restore can be redone. */
	'checkpoints',
	/** The edits journal (see ServerEditsJournal). */
	'edits',
	/** `chat:<id>`: a chat's linked pull requests; `known`: last reads; `hosts`: host problems. */
	'prs',
] as const;

export type AgentServerCollection = typeof AGENT_SERVER_COLLECTIONS[number];

export function createCollections(publish: (delta: ICollectionDelta) => void): Map<AgentServerCollection, ReplicatedCollection> {
	return new Map(AGENT_SERVER_COLLECTIONS.map(name => [name, new ReplicatedCollection(name, publish)]));
}

/** Methods a client may call, per service. Everything else is refused. */
const RUNTIME_METHODS = [
	'send', 'steer', 'steerAsync', 'cancel', 'pause', 'resume', 'forkSession', 'redirect', 'applyHuman', 'seedSession', 'truncateSession',
	'prewarmAgent', 'rememberWorktree', 'upsertProfile', 'deleteProfile', 'setModelEnabled', 'setTaskModel', 'setModeProfile', 'refreshCatalog',
	'detectAgents', 'refreshProviders', 'setProfileEnabled', 'setHealthCheckInterval', 'setModelOptions', 'setAccessMode', 'respondToAccessRequest',
	'respondToQuestions', 'setProjectRules', 'revokeSavedApproval', 'listMcpServers', 'generateText', 'getRunMetrics', 'listReceipts',
	'setActiveCatalogRef',
] as const;
const ORCHESTRATOR_METHODS = ['submit', 'notify', 'cancel', 'dispatch', 'ensureThreadLoaded', 'setLimitRecovery'] as const;
const HISTORY_METHODS = [
	'search', 'rename', 'setAgentTitle', 'delete', 'setPinned', 'setArchived', 'setSettled', 'setSnoozed', 'setUnread', 'clearWoke', 'markAllRead',
	'setAttention', 'pinSessionWorkspace', 'pinSessionParent', 'putAttachment', 'getAttachment', 'attachmentResource', 'flushAll',
] as const;
const HANDLE_METHODS = ['load', 'loadDraft', 'saveDraft', 'setMeta', 'appendUser', 'appendAssistant', 'truncate', 'flush'] as const;
const PROJECT_METHODS = ['registerProject', 'unregisterProject', 'bindSession', 'rebindUnstartedSession'] as const;
const PULL_REQUEST_METHODS = ['link', 'unlink', 'watch', 'unwatch', 'refresh', 'repoFor', 'repoForFolder', 'detail', 'create', 'generatePullRequestText', 'generateCommitMessage'] as const;
const CHECKPOINT_METHODS = ['beginTurn', 'loadCheckpoints', 'previewRestore', 'restoreCheckpoint', 'redo', 'restoreFile', 'getChanges', 'deleteCheckpoints', 'whenIdle'] as const;

/**
 * The agent server's API: exposes the hosted services' methods and keeps the replicated
 * collections in step with their events.
 */
export class AgentServerApi extends Disposable {

	private readonly sessionRefresh = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly runtimeRefresh: RunOnceScheduler;
	private readonly historyRefresh: RunOnceScheduler;

	constructor(
		private readonly protocol: AgentServerProtocol,
		private readonly cols: Map<AgentServerCollection, ReplicatedCollection>,
		private readonly sessions: ServerSessionHost,
		private readonly edits: ServerEditsJournal,
		private readonly importSecrets: (secrets: Record<string, string>) => Promise<string[]>,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IAgentCheckpointService private readonly checkpoints: IAgentCheckpointService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
	) {
		super();
		this.runtimeRefresh = this._register(new RunOnceScheduler(() => this.publishRuntime(), 20));
		this.historyRefresh = this._register(new RunOnceScheduler(() => this.publishHistory(), 50));
		this.registerMethods();
		this.observe();
		this.publishRuntime();
		this.publishHistory();
		this.publishProjects();
		this.publishOrchestrator(undefined);
		this._register(toDisposable(() => {
			for (const timer of this.sessionRefresh.values()) {
				clearTimeout(timer);
			}
		}));
	}

	private col(name: AgentServerCollection): ReplicatedCollection {
		return this.cols.get(name)!;
	}

	//#region Methods

	private registerMethods(): void {
		this._register(this.expose('runtime', this.runtime, RUNTIME_METHODS, (method, params) => {
			const sessionId = typeof params[0] === 'string' ? params[0] : undefined;
			if (sessionId && method !== 'generateText') {
				this.scheduleSession(sessionId);
			}
			this.runtimeRefresh.schedule();
		}));
		this._register(this.protocol.registerMethod('runtime.getOrCreateSession', (_ctx, sessionId) => {
			this.publishSession(String(sessionId));
			return this.col('sessions').get(String(sessionId));
		}));
		// One completion (Tab predictions in a window): collected here, replayed by the window.
		this._register(this.protocol.registerMethod('runtime.streamModel', async (_ctx, ref, messages, options) => {
			const events: unknown[] = [];
			for await (const event of this.runtime.streamModel(String(ref), fromWire(messages), fromWire(options), CancellationToken.None)) {
				events.push(event);
			}
			return toWire(events);
		}));
		this._register(this.protocol.registerMethod('runtime.getPendingQuestions', (_ctx, sessionId) => toWire(this.runtime.getPendingQuestions(String(sessionId)))));
		this._register(this.expose('orchestrator', this.orchestrator, ORCHESTRATOR_METHODS));
		this._register(this.expose('history', this.history, HISTORY_METHODS, () => this.historyRefresh.schedule()));
		this._register(this.protocol.registerMethods('history.handle', Object.fromEntries(HANDLE_METHODS.map(method => [method, async (_ctx: IAgentServerCallContext, id: unknown, ...args: unknown[]) => {
			const handle = this.history.open(String(id)) as unknown as Record<string, (...a: unknown[]) => unknown>;
			const result = await handle[method](...args.map(arg => fromWire(arg)));
			this.historyRefresh.schedule();
			return toWire(result);
		}]))));
		this._register(this.expose('projects', this.sessionContext, PROJECT_METHODS, () => this.publishProjects()));
		this._register(this.expose('checkpoints', this.checkpoints, CHECKPOINT_METHODS));
		this._register(this.expose('prs', this.pullRequests, PULL_REQUEST_METHODS));
		this._register(this.protocol.registerMethods('hostTools', {
			invokeTool: (_ctx, name, args, sessionId) => this.hostTools.invokeTool(String(name), fromWire(args), typeof sessionId === 'string' ? { sessionId, source: 'native' } : undefined).then(toWire),
			listTools: () => toWire(this.hostTools.listTools()),
		}));
		// Repository facts for sidebar rows (initials, branch), read the way a window reads them.
		const repos = new AgentRepoResolver(this.fileService);
		this._register(this.protocol.registerMethod('repos.resolve', async (_ctx, path) => {
			try {
				return toWire(await repos.resolve(uriFromStoredRoot(String(path))));
			} catch {
				return undefined;
			}
		}));
		this._register(this.protocol.registerMethods('session', {
			open: (ctx, id) => this.sessions.open(String(id), ctx.client.connectionId),
			close: (ctx, id) => this.sessions.close(String(id), ctx.client.connectionId),
			stop: (_ctx, id) => this.sessions.stop(String(id)),
			skipCurrentRun: (_ctx, id) => this.sessions.skipCurrentRun(String(id)),
			truncate: (_ctx, id, messageId, userTurns) => this.sessions.truncate(String(id), typeof messageId === 'string' ? messageId : undefined, Number(userTurns)),
			recordMode: (_ctx, id, mode) => this.sessions.recordMode(String(id), String(mode)),
		}));
		this._register(this.protocol.registerMethods('edits', {
			ack: (_ctx, ids) => this.edits.ack(Array.isArray(ids) ? ids.map(String) : []),
			setPending: (_ctx, files) => this.edits.setPending(Array.isArray(files) ? files : []),
			resolved: (_ctx, resolution) => this.edits.resolved(resolution as Parameters<ServerEditsJournal['resolved']>[0]),
		}));
		this._register(this.protocol.registerMethods('secrets', {
			importMissing: (_ctx, secrets) => this.importSecrets(secrets && typeof secrets === 'object' ? secrets as Record<string, string> : {}),
		}));
		this._register(this.protocol.onDidChangeClients(() => {
			// Chats held by connections that went away are no longer held.
			this.sessions.releaseExcept(new Set(this.protocol.listClients().map(client => client.connectionId)));
		}));
	}

	/**
	 * Exposes `methods` of `target` as `<name>.<method>`. Arguments arrive JSON (URIs and bytes
	 * revived), results leave JSON. `after` runs once the call returned.
	 */
	private expose(name: string, target: object, methods: readonly string[], after?: (method: string, params: unknown[]) => void): IDisposable {
		const service = target as Record<string, (...args: unknown[]) => unknown>;
		return this.protocol.registerMethods(name, Object.fromEntries(methods.map(method => [method, async (_ctx: IAgentServerCallContext, ...params: unknown[]) => {
			const args = params.map(param => fromWire(param));
			try {
				return toWire(await service[method](...args));
			} finally {
				after?.(method, args);
			}
		}])));
	}

	//#endregion

	//#region Collections

	private observe(): void {
		this._register(this.runtime.onDidChangeCatalog(() => this.runtimeRefresh.schedule()));
		this._register(this.runtime.onDidChangeProfiles(() => this.runtimeRefresh.schedule()));
		this._register(this.runtime.onDidChangeProviderStatus(() => this.runtimeRefresh.schedule()));
		this._register(this.runtime.onDidChangeActiveCatalog(() => this.runtimeRefresh.schedule()));
		this._register(this.runtime.onDidChangeAccess(() => {
			this.runtimeRefresh.schedule();
			this.publishAccess();
		}));
		this._register(this.runtime.onDidChangeQuestions(sessionId => {
			const pending = this.runtime.getPendingQuestions(sessionId);
			this.col('questions').update({ [sessionId]: pending.length ? toWire(pending) : undefined });
		}));
		this._register(this.runtime.onDidEmit(envelope => {
			this.scheduleSession(envelope.sessionId);
			const type = envelope.event.type;
			if (type === 'access.ask' || type === 'access.resolved' || type === 'access.blocked') {
				this.publishAccess();
				this.runtimeRefresh.schedule();
			} else if (type === 'run.end') {
				// Receipts and run metrics.
				this.runtimeRefresh.schedule();
			}
			this.protocol.publish('runtime.event', toWire(envelope));
		}));
		this._register(this.orchestrator.onDidChange(change => this.publishOrchestrator(change)));
		this._register(this.history.onDidChange(() => this.historyRefresh.schedule()));
		this._register(this.sessionContext.onDidChangeProjects(() => this.publishProjects()));
		this._register(this.checkpoints.onDidChange(sessionId => this.publishCheckpoints(sessionId)));
		this._register(this.pullRequests.onDidChange(() => this.publishPullRequests()));
		this._register(this.pullRequests.onDidChangePullRequest(key => {
			this.publishPullRequests();
			this.protocol.publish('server', { kind: 'pr.changed', key });
		}));
		this._register(this.pullRequests.onDidReadDetail(detail => this.protocol.publish('server', toWire({ kind: 'pr.detail', detail }))));
		void this.pullRequests.whenReady.then(() => this.publishPullRequests());
		this._register(this.hostTools.onDidInvokeTool(e => this.protocol.publish('hostTools', toWire({ kind: 'invoked', ...e }))));
		this._register(this.hostTools.onDidChangeMcp(() => this.protocol.publish('hostTools', { kind: 'mcp' })));
		this._register(this.hostTools.onDidChangeTools(() => this.runtimeRefresh.schedule()));
	}

	private publishRuntime(): void {
		const runtime = this.runtime;
		const catalog = runtime.listCatalog();
		const lastCheck = runtime.getLastProviderCheck();
		this.col('runtime').replace(toWire({
			catalog,
			catalogLoading: runtime.isCatalogLoading(),
			profiles: runtime.listProfiles(),
			providerStatuses: runtime.listProviderStatuses(),
			...(lastCheck !== undefined ? { lastProviderCheck: lastCheck } : {}),
			healthInterval: runtime.getHealthCheckInterval(),
			taskModels: runtime.getTaskModels(),
			modeProfiles: Object.fromEntries(VOLT_MODES.map(mode => [mode, runtime.getModeProfile(mode) ?? null])),
			modelOptions: Object.fromEntries(catalog.map(item => [item.ref, runtime.getModelOptions(item.ref)])),
			enabledModels: Object.fromEntries(catalog.map(item => [item.ref, runtime.isModelEnabled(item.ref)])),
			accessMode: runtime.getAccessMode(),
			projectRules: runtime.listProjectRules(),
			savedApprovals: runtime.listSavedApprovals(),
			receipts: runtime.listReceipts().slice(-500),
			runMetrics: runtime.getRunMetrics().slice(-200),
			...(runtime.getActiveCatalogRef() ? { activeCatalogRef: runtime.getActiveCatalogRef() } : {}),
			...(runtime.resolveTabModelRef() ? { tabModelRef: runtime.resolveTabModelRef() } : {}),
			hostTools: this.hostTools.listTools(),
		}) as Record<string, unknown>);
	}

	private publishAccess(): void {
		this.col('access').replace({ pending: toWire(this.runtime.listPendingAccessRequests()) });
	}

	private scheduleSession(sessionId: string): void {
		if (this.sessionRefresh.has(sessionId)) {
			return;
		}
		this.sessionRefresh.set(sessionId, setTimeout(() => {
			this.sessionRefresh.delete(sessionId);
			this.publishSession(sessionId);
		}, 30));
	}

	/** What the UI reads synchronously about a chat's runtime session. */
	private publishSession(sessionId: string): void {
		const session = this.runtime.getOrCreateSession(sessionId);
		const chat = this.runtime.chatFor(sessionId);
		this.col('sessions').update({
			[sessionId]: toWire({
				sessionId: session.sessionId,
				conversationId: session.conversationId,
				mode: session.mode,
				...(session.providerRef ? { providerRef: session.providerRef } : {}),
				...(session.profileId ? { profileId: session.profileId } : {}),
				...(session.activeRun ? { activeRun: session.activeRun } : {}),
				...(session.lastLane ? { lastLane: session.lastLane } : {}),
				...(session.paused ? { paused: true } : {}),
				...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
				...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
				userTurns: session.messages.filter(message => message.role === 'user' && !(message as { steer?: boolean }).steer).length,
				canSteer: this.runtime.canSteer(sessionId),
				commands: ['compact'].filter(name => this.runtime.supportsCommand(sessionId, name)),
				...(chat !== sessionId ? { chat } : {}),
			}),
		});
	}

	private publishOrchestrator(change: { readonly threads: readonly string[]; readonly tasks: readonly string[] } | undefined): void {
		const state = this.orchestrator.getState();
		if (!change) {
			this.col('orch.threads').replace(toWire(state.threads) as Record<string, unknown>);
			this.col('orch.tasks').replace(toWire(state.tasks) as Record<string, unknown>);
		} else {
			this.col('orch.threads').update(Object.fromEntries(change.threads.map(id => [id, toWire(state.threads[id])])));
			this.col('orch.tasks').update(Object.fromEntries(change.tasks.map(id => [id, toWire(state.tasks[id])])));
		}
		this.col('orch.meta').update({ state: { seq: state.seq, conflicts: state.conflicts } });
		// Turns start and settle here, and child chats get their parents and projects.
		this.historyRefresh.schedule();
		this.publishProjects();
	}

	private publishHistory(): void {
		const exported = (this.history as AgentHistoryService).exportState();
		this.col('history').replace(Object.fromEntries(exported.sessions.map(meta => [meta.id, toWire(meta)])));
		this.col('history.meta').update({
			state: toWire({
				onDisk: exported.onDisk,
				pinnedWorkspaces: exported.pinnedWorkspaces,
				pinnedParents: exported.pinnedParents,
				pinnedSubagents: exported.pinnedSubagents,
			}),
		});
	}

	private publishProjects(): void {
		const projects = this.sessionContext.projects;
		this.col('projects').replace({
			...Object.fromEntries(projects.map(project => [`project:${project.id}`, toWire(project)])),
			bindings: (this.sessionContext as VoltSessionContextService).exportBindings(),
		});
	}

	private publishPullRequests(): void {
		const state = (this.pullRequests as AgentPullRequestService).exportState();
		this.col('prs').replace(toWire({
			...Object.fromEntries(Object.entries(state.chats).map(([sessionId, links]) => [`chat:${sessionId}`, links])),
			known: state.known,
			hosts: state.hosts,
		}) as Record<string, unknown>);
	}

	private publishCheckpoints(sessionId: string): void {
		this.col('checkpoints').update({
			[sessionId]: toWire({ checkpoints: this.checkpoints.getCheckpoints(sessionId), canRedo: this.checkpoints.canRedo(sessionId) }),
		});
	}

	//#endregion

	override dispose(): void {
		this.logService.trace('[volt agent server] api disposed');
		super.dispose();
	}
}
