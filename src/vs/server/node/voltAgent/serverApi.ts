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
import { AgentHistoryService } from '../../../workbench/services/voltRuntime/browser/history/agentHistoryService.js';
import { VoltSessionContextService } from '../../../workbench/services/voltRuntime/browser/sessionContextService.js';
import { AgentSessionStatus, IAgentHistoryService } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';
import { VOLT_MODES, VoltMode } from '../../../workbench/services/voltRuntime/common/modes.js';
import { IRemoteHostToolCall } from '../../../workbench/services/voltAgentServer/common/remoteVoltHostToolService.js';
import { IAgentOrchestratorService } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../workbench/services/voltRuntime/common/sessionContext.js';
import { ServerEditsJournal } from './serverEditsJournal.js';
import { ServerSessionHost } from './serverSessionHost.js';
import { ServerClientTools } from './serverClientTools.js';
import { IServerFileRoot, ServerFiles } from './serverFiles.js';
import { ServerComposer } from './serverComposer.js';
import { ServerGit } from './serverGit.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IVoltPullRequestService } from '../../../platform/voltPullRequests/common/voltPullRequests.js';
import { basename } from '../../../base/common/path.js';

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
] as const;

export type AgentServerCollection = typeof AGENT_SERVER_COLLECTIONS[number];

export function createCollections(publish: (delta: ICollectionDelta) => void): Map<AgentServerCollection, ReplicatedCollection> {
	return new Map(AGENT_SERVER_COLLECTIONS.map(name => [name, new ReplicatedCollection(name, publish)]));
}

/** Methods a client may call, per service. Everything else is refused. */
const RUNTIME_METHODS = [
	'send', 'steer', 'steerAsync', 'cancel', 'pause', 'resume', 'forkSession', 'redirect', 'applyHuman', 'seedSession', 'truncateSession',
	'restartAgent', 'relocate', 'compactionPlan', 'prewarmAgent', 'rememberWorktree', 'upsertProfile', 'deleteProfile', 'setModelEnabled',
	'setTaskModel', 'setModeProfile', 'refreshCatalog', 'detectAgents', 'refreshProviders', 'setProfileEnabled', 'setHealthCheckInterval',
	'setModelOptions', 'setAccessMode', 'setSandboxSettings', 'setDefaultSandboxSettings', 'respondToAccessRequest', 'respondToQuestions',
	'setProjectRules', 'revokeSavedApproval', 'listMcpServers', 'generateText', 'getRunMetrics', 'listReceipts', 'setActiveCatalogRef',
	'stopAgentBackgroundTask', 'warmPredictor',
] as const;
const ORCHESTRATOR_METHODS = ['submit', 'move', 'resumeLimit', 'configureLimit', 'notify', 'multitaskQueue', 'cancel', 'dispatch', 'ensureThreadLoaded'] as const;
const HISTORY_METHODS = [
	'search', 'rename', 'setAgentTitle', 'delete', 'setPinned', 'setArchived', 'setSettled', 'setAutoSettle', 'setSnoozed', 'restoreLifecycle',
	'setUnread', 'clearWoke', 'markAllRead', 'setAttention', 'pinSessionWorkspace', 'pinSessionParent', 'putAttachment', 'getAttachment',
	'attachmentResource', 'flushAll', 'readTranscript',
] as const;
const HANDLE_METHODS = ['load', 'loadDraft', 'saveDraft', 'setMeta', 'appendUser', 'appendAssistant', 'truncate', 'flush'] as const;
const PROJECT_METHODS = ['registerProject', 'registerScratchProject', 'unregisterProject', 'bindSession', 'rebindUnstartedSession'] as const;
const CHECKPOINT_METHODS = ['beginTurn', 'loadCheckpoints', 'previewRestore', 'restoreCheckpoint', 'redo', 'restoreFile', 'getChanges', 'deleteCheckpoints'] as const;

/**
 * The agent server's API: exposes the hosted services' methods and keeps the replicated
 * collections in step with their events.
 */
export class AgentServerApi extends Disposable {

	private readonly sessionRefresh = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly runtimeRefresh: RunOnceScheduler;
	private readonly historyRefresh: RunOnceScheduler;
	private readonly clientTools: ServerClientTools;

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
		@IVoltPullRequestService pullRequests: IVoltPullRequestService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.runtimeRefresh = this._register(new RunOnceScheduler(() => this.publishRuntime(), 20));
		this.historyRefresh = this._register(new RunOnceScheduler(() => this.publishHistory(), 50));
		this.clientTools = this._register(new ServerClientTools(protocol, hostTools, sessionId => sessions.holders(sessionId)));
		const files = this._register(new ServerFiles(protocol, () => this.fileRoots(), logService));
		const allowed = (path: string) => files.allowed(path);
		this._register(new ServerGit(protocol, allowed, pullRequests, logService));
		this._register(new ServerComposer(protocol, allowed, instantiationService));
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
			// setAccessMode(mode, sessionId?) names its chat second; warmPredictor(ref) names none.
			const sessionArg = method === 'setAccessMode' ? params[1] : params[0];
			const sessionId = typeof sessionArg === 'string' ? sessionArg : undefined;
			if (method === 'setDefaultSandboxSettings' || (method === 'setAccessMode' && !sessionId)) {
				// Chats that never chose their own sandbox or access mode follow the default.
				for (const key of this.col('sessions').keys()) {
					this.scheduleSession(key);
				}
			} else if (sessionId && method !== 'generateText' && method !== 'warmPredictor') {
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
		this._register(this.protocol.registerMethods('hostTools', {
			invokeTool: (_ctx, name, args, call) => {
				const remote = call && typeof call === 'object' ? fromWire<IRemoteHostToolCall>(call) : undefined;
				return this.hostTools.invokeTool(String(name), fromWire(args), remote ? { ...remote, mode: remote.mode as VoltMode | undefined } : undefined).then(toWire);
			},
			listTools: () => toWire(this.hostTools.listTools()),
			setClientTools: (ctx, tools) => this.clientTools.set(ctx.client.connectionId, Array.isArray(tools) ? fromWire(tools) : []),
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
			skipCurrentRun: (_ctx, id) => this.sessions.skipCurrentRun(String(id)),
			truncate: (_ctx, id, messageId) => this.sessions.truncate(String(id), String(messageId)),
			recordAssistant: (_ctx, id, message, final, status) => this.sessions.recordAssistant(String(id), fromWire(message), !!final, String(status) as AgentSessionStatus),
		}));
		this._register(this.protocol.registerMethods('edits', {
			ack: (_ctx, ids) => this.edits.ack(Array.isArray(ids) ? ids.map(String) : []),
			setPending: (_ctx, files) => this.edits.setPending(Array.isArray(files) ? files : []),
			resolved: (_ctx, resolution) => this.edits.resolved(resolution as Parameters<ServerEditsJournal['resolved']>[0]),
		}));
		this._register(this.protocol.registerMethods('secrets', {
			importMissing: (ctx, secrets) => {
				// Only a Volt window hands over provider keys; a paired phone never writes secrets.
				if (ctx.client.role !== 'owner') {
					throw Object.assign(new Error('Only Volt on this computer can import provider keys.'), { code: 'Forbidden' });
				}
				return this.importSecrets(secrets && typeof secrets === 'object' ? secrets as Record<string, string> : {});
			},
		}));
		this._register(this.protocol.onDidChangeClients(() => {
			// Chats held by connections that went away are no longer held, and their tools are gone.
			const live = new Set(this.protocol.listClients().map(client => client.connectionId));
			this.sessions.releaseExcept(live);
			this.clientTools.retain(live);
		}));
	}

	/** The folders paired clients may browse and edit: every local project and every chat's worktree. */
	private fileRoots(): IServerFileRoot[] {
		const roots: IServerFileRoot[] = [];
		const seen = new Set<string>();
		for (const project of (this.sessionContext as VoltSessionContextService).exportState().projects) {
			if (project.root.scheme === 'file' && !seen.has(project.root.fsPath)) {
				seen.add(project.root.fsPath);
				roots.push({ id: project.id, name: project.displayName, path: project.root.fsPath, kind: 'project', ...(project.scratch ? { scratch: true } : {}) });
			}
		}
		const sessions = this.col('sessions');
		for (const sessionId of sessions.keys()) {
			const session = sessions.get(sessionId) as { worktreePath?: unknown; workingFolder?: unknown } | undefined;
			for (const folder of [session?.worktreePath, session?.workingFolder]) {
				if (typeof folder === 'string' && folder && !seen.has(folder)) {
					seen.add(folder);
					roots.push({ id: `worktree:${sessionId}`, name: basename(folder), path: folder, kind: 'worktree', sessionId });
				}
			}
		}
		return roots;
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
		this._register(this.orchestrator.onDidStop(threadId => this.protocol.publish('server', { kind: 'orch.stop', threadId })));
		this._register(this.runtime.onDidChangeAgentBackgroundTask(task => this.protocol.publish('server', toWire({ kind: 'runtime.backgroundTask', task }))));
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
			defaultSandbox: runtime.getDefaultSandboxSettings(),
			autoResumeDefault: this.orchestrator.autoResumeDefault(),
			keepsWorking: this.orchestrator.keepsWorking(),
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
		const compaction = this.runtime.compactionPlan(sessionId, undefined);
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
				...(this.runtime.workingFolder(sessionId) ? { workingFolder: this.runtime.workingFolder(sessionId) } : {}),
				sandbox: this.runtime.getSandboxSettings(sessionId),
				accessMode: this.runtime.getAccessMode(sessionId),
				...(compaction ? { compaction } : {}),
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
		const state = (this.sessionContext as VoltSessionContextService).exportState();
		this.col('projects').replace({
			...Object.fromEntries(state.projects.map(project => [`project:${project.id}`, toWire(project)])),
			bindings: state.bindings,
		});
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
