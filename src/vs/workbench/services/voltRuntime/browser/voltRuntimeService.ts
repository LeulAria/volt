/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAgentWorktreeService } from '../common/git/agentWorktree.js';
import { IAgentHistoryService } from '../common/history/agentHistory.js';
import { IVoltSessionContextService } from '../common/sessionContext.js';
import './sessionContextService.js';
import { ISearchService } from '../../search/common/search.js';
import { evaluateAccess, memoKey } from '../common/access/accessBroker.js';
import { DEFAULT_ACCESS_MODE, normalizeVoltAccessMode, VOLT_ACCESS_MODE_STORAGE_KEY, VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, VoltAccessMode } from '../common/access/accessModes.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../common/access/accessPresets.js';
import { AccessDecisionScope, IAccessDecision, IAccessGate, IAccessRequest, ICompiledPolicy, IExecutionReceipt, IPermissionRule, PermissionEffect } from '../common/access/accessTypes.js';
import { compilePolicy } from '../common/access/policyCompiler.js';
import { accessBridgeFor } from './agents/bridges/accessBridges.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../common/capabilities.js';
import { IVoltEvent, IVoltEventEnvelope } from '../common/events.js';
import { IVoltModelOptions, MODEL_OPTION_REASONING, resolveModelOptions, VOLT_MODEL_OPTIONS_STORAGE_KEY } from '../common/models/modelOptions.js';
import { modePolicy, VoltMode } from '../common/modes.js';
import { displayProviderLabel, IProviderProfile, IProviderProfileDraft, secretKeyForProfile, VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, VOLT_CATALOG_REVISION, VOLT_CATALOG_REVISION_STORAGE_KEY, VOLT_CATALOG_STORAGE_KEY, VOLT_DEFAULT_HEALTH_INTERVAL, VOLT_ENABLED_MODELS_STORAGE_KEY, VOLT_HEALTH_INTERVAL_STORAGE_KEY, VOLT_MODE_PROFILES_STORAGE_KEY, VOLT_PROFILES_STORAGE_KEY, VOLT_SEED_VERSION_STORAGE_KEY, VOLT_TASK_MODELS_STORAGE_KEY } from '../common/profiles.js';
import { IAgentDetectResult, IAgentProvider, IAgentSessionHandle, IDetectResult, IModelInfo, IModelMessage, IModelProvider, IVoltCatalogItem, IVoltProviderStatus, VoltProviderState } from '../common/providers.js';
import { resolveTabModel } from '../common/models/modelAccess.js';
import { IAgentRuntimeService, IVoltTaskModels } from '../common/runtime.js';
import { IVoltRunSnapshot, IVoltSendRequest, IVoltSession } from '../common/session.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolService } from '../common/hostTools.js';
import { AcpAgentProvider, IAcpFileWrite } from './agents/acpProvider.js';
import { EditBaselineTracker } from './editBaselines.js';
import './host/hostToolService.js';
import { clearClaudeModelCache } from './agents/claudeCatalog.js';
import { CLI_AGENT_DEFINITIONS, cliAgentDefinition, detectCliAgent } from './agents/cliAgents.js';
import { NullVoltStdioService } from './host/nullStdioService.js';
import { loadWorkspaceRunPlan } from './host/workspaceRunPlan.js';
import { IIntent, mergeGrantedGroups } from '../common/harness/intent.js';
import { buildAcpLead, IContextPackInput, IEnvironmentFacts } from '../common/harness/contextPack.js';
import { INativeLoopMessage } from '../common/harness/nativeLoop.js';
import { nativeToModelMessages } from '../common/harness/providerMessages.js';
import { runToolBatch } from '../common/harness/toolRuntime.js';
import { estimateTokens, totalTokens } from '../common/harness/contextEngine.js';
import { FileLedger } from '../common/harness/fileLedger.js';
import { alwaysRules, findInstruction, instructionsIndex, rulesForPath } from '../common/harness/instructions.js';
import { applyCompaction, COMPACTION_SYSTEM, compactionBoundary, compactionRequest, DEFAULT_COMPACTION, effectiveWindow, mechanicalSummary, serializeForSummary, shouldCompact } from '../common/harness/nativeCompaction.js';
import { chooseEffort, EffortLevel } from '../common/deepseek/effort.js';
import { IToolDocuments } from './tools/fileTools.js';
import { ISubagentRequest } from './tools/metaTools.js';
import { CodeIntelHost } from './host/codeIntelHost.js';
import { McpHost } from './host/mcpHost.js';
import { NativeJournal } from './history/nativeJournal.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IInstructionsSnapshot, loadInstructions } from './prompt/instructionsLoader.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { posix } from '../../../../base/common/path.js';
import { isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';
import { IPathService } from '../../path/common/pathService.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { stringifyUnknown } from '../common/harness/toolResult.js';
import { actionForGroup, resourceForCall } from '../common/harness/toolAccess.js';
import { classifyRisk } from '../common/access/riskClassifier.js';
import { CapabilityGroup } from '../common/harness/lanes.js';
import { IRoutableModel } from '../common/harness/modelRouter.js';
import { workerFraming } from '../common/harness/orchestrator.js';
import { planEntries } from '../common/harness/plan.js';
import { applyHumanAction, IHumanAction } from '../common/harness/humanLoop.js';
import { IPreparedRun, prepareRun } from '../common/harness/pipeline.js';
import { IRunHarness } from '../common/harness/runHarness.js';
import { EvalLedger } from '../common/harness/eval.js';
import { isAcpTurnRestartable } from '../common/harness/sessionRetry.js';
import { TaskLifecycle } from '../common/harness/lifecycle.js';
import { formatTaskBrief } from '../common/harness/taskIntel.js';
import { IToolCall, IToolContext, IVoltTool, toolSchemas, toolSnippets } from '../common/tools/tool.js';
import { deepseekKnobs, resolveApproval } from '../common/deepseek/approval.js';
import { runDeepseekLoop } from '../common/deepseek/loop.js';
import { VoltLlmAdapter } from './deepseek/voltLlmAdapter.js';
import { buildSubagentPrompt, nativeModelTurn } from '../common/deepseek/prompt.js';
import { ApprovalOutcome } from '../common/deepseek/protocol.js';
import { createBuiltinTools } from './tools/registry.js';
import { loadProjectInstructions } from './prompt/projectInstructions.js';
import { IRunPlan } from '../common/runPlan.js';
import { isWindows, isMacintosh } from '../../../../base/common/platform.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import { createCompatProvider, createLMStudioProvider, createOpenAIProvider, createOpenRouterProvider } from './providers/openaiCompat.js';

const RECEIPT_LIMIT = 500;
/** Access-broker session id for Tab completions that ride an ACP agent. */
const TAB_PREDICTION_SESSION_ID = 'volt-tab-prediction';

/** Bumped whenever the built-in profile list changes so existing installs pick it up. */
const CLI_SEED_VERSION = 3;

interface ISessionState extends IVoltSession {
	seq: number;
	agentHandle?: IAgentSessionHandle;
	agentProviderId?: string;
	cancel?: CancellationTokenSource;
	/** Extra capability groups granted mid-session by `request_capabilities`. */
	extraGroups?: CapabilityGroup[];
	/** The pre-loop pipeline result for the active run. ACP only. */
	prepared?: IPreparedRun;
	harness?: IRunHarness;
	/** In-process DeepSeek loop for native models. The open workspace folder is the cwd. */
	deepseek?: INativeState;
	/** How many of `messages` the current ACP agent session has seen. */
	agentSynced?: number;
	/** Catalog ref the live agent session was started for. */
	agentRef?: string;
	/** A prewarm in flight; a send waits for it instead of starting a second process. */
	agentStarting?: Promise<void>;
	/** One notice after a checkout is created or restored. */
	announceWorktree?: boolean;
}

/** Native-model conversation state that outlives a single run. */
interface INativeState {
	messages: INativeLoopMessage[];
	inbox: string[];
	running: boolean;
	cwd?: string;
	/** How many of the session's `messages` this transcript already contains. */
	synced: number;
	ledger: FileLedger;
	/** Folders holding spilled command logs, readable by read_file. */
	logRoots: URI[];
	/** Files changed in the current run, with their error markers from before the first change. */
	changed: ResourceMap<Map<string, number>>;
	/** Prompt size the provider last reported. */
	promptTokens: number;
	effort?: EffortLevel;
	todo?: string;
	instructions?: IInstructionsSnapshot;
}

/** Languages whose editor services report diagnostics worth waiting for. */
const DIAGNOSED_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|c|cc|cpp|h|hpp|php|rb|swift|dart|vue|svelte|css|scss|less|json)$/i;
const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'grep', 'glob', 'diagnostics', 'code_nav', 'git_status', 'git_diff', 'git_log', 'git_show', 'skill'];
const INSTRUCTIONS_TTL_MS = 5_000;
const RECAP_CHARS = 24_000;

export class AgentRuntimeService extends Disposable implements IAgentRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, ISessionState>();
	private readonly listeners = new Map<string, Set<(e: IVoltEventEnvelope) => void>>();
	private readonly modelProviders = new Map<string, IModelProvider>();
	private readonly agentProviders = new Map<string, IAgentProvider>();
	private profiles: IProviderProfile[] = [];
	private enabled = new Set<string>();
	private taskModels: IVoltTaskModels = {};
	private activeCatalogRef: string | undefined;
	private modeProfiles: Partial<Record<VoltMode, string>> = {};
	private catalog: IVoltCatalogItem[] = [];
	private catalogLoading = false;
	private catalogRefresh: Promise<void> | undefined;
	private modelOptions: Record<string, IVoltModelOptions> = {};
	private detections = new Map<string, IDetectResult>();
	private readonly agentModels = new Map<string, IModelInfo[]>();
	private lastProviderCheck: number | undefined;
	private readonly healthTimer = this._register(new IntervalTimer());
	private providerRefresh: Promise<void> | undefined;
	private providerRefreshAgain = false;
	private accessMode: VoltAccessMode = DEFAULT_ACCESS_MODE;
	private projectRules: IPermissionRule[] = [];
	private savedRules: IPermissionRule[] = [];
	private compiledPolicy: ICompiledPolicy = compilePolicy({});
	private tabAgent: { ref: string; handle: IAgentSessionHandle; provider: IAgentProvider } | undefined;
	private readonly policyMemo = new Map<string, IAccessDecision>();
	private readonly pendingApprovals = new Map<string, { resolve: (decision: IAccessDecision) => void; request: IAccessRequest }>();
	private receipts: IExecutionReceipt[] = [];
	private saveAccessHandle: ReturnType<typeof setTimeout> | undefined;
	private readonly runPlans = new Map<string, Promise<IRunPlan>>();
	private readonly projectInstructionsByRoot = new Map<string, Promise<string | undefined>>();
	private readonly instructionsByRoot = new Map<string, { readonly at: number; readonly value: Promise<IInstructionsSnapshot> }>();
	private readonly codeIntel: CodeIntelHost;
	private readonly mcpHost: McpHost;
	private readonly journal: NativeJournal;
	private readonly nativeRestores = new Map<string, Promise<void>>();
	private readonly evalLedger = new EvalLedger();

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog: Event<void> = this._onDidChangeCatalog.event;
	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles: Event<void> = this._onDidChangeProfiles.event;
	private readonly _onDidChangeProviderStatus = this._register(new Emitter<void>());
	readonly onDidChangeProviderStatus: Event<void> = this._onDidChangeProviderStatus.event;
	private readonly _onDidChangeAccess = this._register(new Emitter<void>());
	readonly onDidChangeAccess: Event<void> = this._onDidChangeAccess.event;
	private readonly _onDidEmit = this._register(new Emitter<IVoltEventEnvelope>());
	readonly onDidEmit: Event<IVoltEventEnvelope> = this._onDidEmit.event;
	private readonly editBaselines: EditBaselineTracker;
	private readonly _onDidChangeActiveCatalog = this._register(new Emitter<void>());
	readonly onDidChangeActiveCatalog: Event<void> = this._onDidChangeActiveCatalog.event;

	private readonly accessGate: IAccessGate = {
		evaluate: request => this.evaluateAccessRequest(request),
	};

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ISearchService private readonly searchService: ISearchService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IPathService private readonly pathService: IPathService,
		@IMarkerService markerService: IMarkerService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		this.codeIntel = this._register(new CodeIntelHost(markerService, textModelService, languageFeaturesService, fileService));
		this.mcpHost = this._register(new McpHost(fileService, stdio, requestService, logService));
		this.journal = this._register(new NativeJournal(joinPath(environmentService.userRoamingDataHome, 'voltNative'), fileService, logService));
		this.editBaselines = new EditBaselineTracker(fileService, (sessionId, path) => this.editableUri(sessionId, path));
		this.registerProviders();
		this.loadState();
		void this.refreshCatalog();
		void this.refreshProviders();
		this.scheduleHealthChecks();
		this._register(toDisposable(() => void this.disposeTabAgent()));
	}

	getOrCreateSession(key: string): IVoltSession {
		let session = this.sessions.get(key);
		if (!session) {
			session = {
				sessionId: key,
				conversationId: generateUuid(),
				mode: 'agent',
				messages: [],
				seq: 0,
			};
			this.sessions.set(key, session);
		}
		return session;
	}

	seedSession(key: string, messages: readonly { role: 'user' | 'assistant'; content: string }[]): void {
		const session = this.getOrCreateSession(key) as ISessionState;
		if (session.messages.length || session.activeRun) {
			return;
		}
		session.messages = messages.filter(message => message.content.trim()).map(message => ({ role: message.role, content: message.content }));
		// The saved native transcript carries tool calls and results the text history does not.
		const seeded = session.messages.length;
		this.nativeRestores.set(key, this.journal.load(key).then(entry => {
			if (!entry || session.deepseek) {
				return;
			}
			const state = this.nativeState(session);
			state.messages.push(...entry.messages);
			state.synced = Math.min(entry.synced, seeded);
			state.effort = entry.effort as EffortLevel | undefined;
			state.todo = entry.todo;
		}, () => undefined));
	}

	rememberWorktree(sessionId: string, path: string | undefined, branch: string | undefined): void {
		if (!path || !branch) {
			return;
		}
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.worktreePath = path;
		session.worktreeBranch = branch;
	}

	async send(sessionId: string, request: IVoltSendRequest): Promise<string> {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.mode = request.mode;
		session.providerRef = request.providerRef ?? session.providerRef ?? this.defaultRef(request.mode);
		const runLive = session.activeRun && (session.activeRun.status === 'running' || session.activeRun.status === 'waiting');
		if (runLive && session.activeRun && session.deepseek?.running) {
			this.denyPending(sessionId, 'follow-up');
			session.messages.push({ role: 'user', content: request.text });
			session.deepseek.inbox.push(request.text);
			this.emit(session, session.activeRun.runId, { type: 'human', action: 'redirect', detail: request.text });
			this.emit(session, session.activeRun.runId, { type: 'inbox', claimed: 0 });
			return session.activeRun.runId;
		}
		const live = runLive && session.harness;
		if (live && session.activeRun && session.harness) {
			this.denyPending(sessionId, 'follow-up');
			session.messages.push({ role: 'user', content: request.text });
			session.harness.inbox.inject(request.text, { wake: true, target: 'turn' });
			this.emit(session, session.activeRun.runId, { type: 'human', action: 'redirect', detail: request.text });
			this.emit(session, session.activeRun.runId, { type: 'inbox', claimed: 0 });
			return session.activeRun.runId;
		}
		session.messages.push({ role: 'user', content: request.text });
		try {
			await this.prepareWorktree(session, request);
		} catch (err) {
			const runId = this.beginRun(session, request);
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, 'fail');
			return runId;
		}

		const catalogItem = this.catalog.find(item => item.ref === session.providerRef && item.enabled) ?? this.catalog.find(item => item.enabled);
		if (!catalogItem || catalogItem.kind !== 'agent') {
			const runId = this.beginRun(session, request);
			this.emit(session, runId, { type: 'lifecycle', phase: 'running' });
			void this.execute(session, runId, request).catch(err => {
				this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
				this.finish(session, runId, 'fail');
			});
			return runId;
		}
		const root = this.executionRoot(session);
		const hasWorkspace = !!root;
		const hasGit = root ? await this.fileService.exists(URI.joinPath(root, '.git')) : false;
		const prepared = prepareRun({
			text: request.text,
			mode: request.mode,
			intentContext: {
				hasWorkspace,
				priorLane: session.lastLane,
			},
			intelContext: {
				hasPriorTurns: session.messages.length > 1,
				attachments: request.mentions,
			},
			attachments: request.mentions,
			provider: catalogItem ? { kind: catalogItem.kind, providerId: catalogItem.providerId } : undefined,
			catalog: this.routableCatalog(),
			explicitRef: session.providerRef,
			sessionId,
			conversationId: session.conversationId,
			workspaceId: root?.toString(),
			accessMode: this.accessMode,
			environment: {
				hasWorkspace,
				hasGit,
				hasBrowserHost: true,
				hasNetwork: true,
				...(root ? { cwd: root.fsPath } : {}),
				platform: isMacintosh ? 'darwin' : isWindows ? 'win32' : 'linux',
			},
			evalHints: this.evalLedger.hints(),
		});
		session.lastLane = prepared.intent.lane;
		session.prepared = prepared;

		const runId = generateUuid();
		const run: IVoltRunSnapshot = {
			runId,
			sessionId,
			status: 'running',
			startedAt: Date.now(),
			providerRef: session.providerRef,
			lane: prepared.intent.lane,
		};
		session.activeRun = run;
		session.cancel?.dispose(true);
		session.cancel = new CancellationTokenSource();

		this.emit(session, runId, { type: 'run.start', runId, mode: request.mode });
		this.noteWorktree(session, runId);
		this.emit(session, runId, { type: 'envelope', id: prepared.envelope.id, mode: request.mode, permissions: prepared.envelope.permissions });
		this.emit(session, runId, { type: 'lifecycle', phase: 'planning' });
		this.emit(session, runId, { type: 'lane', lane: prepared.intent.lane, signals: prepared.intent.signals, wantsPreview: prepared.intent.wantsPreview, wantsWeb: prepared.intent.wantsWeb });
		if (prepared.mission) {
			this.emit(session, runId, { type: 'mission', phase: prepared.mission.phase, detail: prepared.mission.goal });
		}
		// The agent plans, and asks when something is unclear, with its own tools once it has
		// looked at the code. A plan or question drafted from the prompt text alone would only
		// restate the request, so neither is shown or allowed to stop the run.
		this.emit(session, runId, { type: 'lifecycle', phase: 'running' });
		void this.execute(session, runId, request, prepared.intent).catch(err => {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, 'fail');
		});
		return runId;
	}

	/**
	 * Starts the selected ACP agent before the first message (spawn, initialize, session/new),
	 * so the user's first send does not pay the cold start. Native models need no warm-up.
	 */
	prewarmAgent(sessionId: string, providerRef: string | undefined, mode: VoltMode): void {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		if (session.activeRun?.status === 'running' || session.agentStarting) {
			return;
		}
		const ref = providerRef ?? session.providerRef ?? this.defaultRef(mode);
		const item = this.catalog.find(candidate => candidate.ref === ref && candidate.enabled);
		const profile = item ? this.profiles.find(candidate => candidate.id === item.profileId) : undefined;
		const provider = profile ? this.agentProviders.get(profile.providerId) : undefined;
		if (!item || item.kind !== 'agent' || !profile || !provider) {
			return;
		}
		if (session.agentHandle && session.agentRef === item.ref && (provider.isLive?.(session.agentHandle) ?? true)) {
			return;
		}
		const starting: Promise<void> = this.startAgentSession(session, provider, profile, item, mode, undefined)
			.catch(err => this.logService.trace('[volt] agent prewarm failed', err))
			.finally(() => {
				if (session.agentStarting === starting) {
					session.agentStarting = undefined;
				}
			});
		session.agentStarting = starting;
	}

	private async startAgentSession(session: ISessionState, provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, mode: VoltMode, options: IVoltModelOptions | undefined): Promise<void> {
		if (session.agentHandle && session.agentProviderId) {
			await this.agentProviders.get(session.agentProviderId)?.dispose(session.agentHandle).catch(() => undefined);
		}
		session.agentHandle = undefined;
		const handle = await provider.start({
			mode,
			profile,
			cwd: this.executionRoot(session)?.fsPath,
			modelId: item.id === profile.providerId ? undefined : item.id,
			options: this.resolvedOptions(item, options),
		});
		session.agentHandle = handle;
		session.agentProviderId = provider.id;
		session.agentRef = item.ref;
		// A fresh agent process has seen nothing of this conversation yet.
		session.agentSynced = 0;
		await provider.applyAccessPolicy?.(handle, this.compiledPolicy);
	}

	truncateSession(sessionId: string, userTurns: number): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.activeRun?.status === 'running') {
			return;
		}
		let seen = 0;
		const cut = session.messages.findIndex(message => message.role === 'user' && seen++ === userTurns);
		if (cut < 0) {
			return;
		}
		session.messages = session.messages.slice(0, cut);
		const state = session.deepseek;
		if (state) {
			let turns = 0;
			const nativeCut = state.messages.findIndex(message => message.role === 'user' && message.turn && turns++ === userTurns);
			if (nativeCut >= 0) {
				state.messages.splice(nativeCut);
				state.synced = session.messages.length;
			} else {
				// Compaction merged the turns; start the model transcript over from the text history.
				state.messages.splice(0);
				state.synced = 0;
			}
			state.inbox.splice(0);
			state.ledger.invalidateReferences();
			void this.journal.schedule(sessionId, () => ({ version: 1, messages: state.messages, synced: state.synced, effort: state.effort, todo: state.todo, savedAt: Date.now() }), true);
		}
		// An ACP agent cannot forget turns; the next message starts a fresh agent with a recap.
		if (session.agentHandle && (session.agentSynced ?? 0) > session.messages.length) {
			const provider = session.agentProviderId ? this.agentProviders.get(session.agentProviderId) : undefined;
			void provider?.dispose(session.agentHandle).catch(() => undefined);
			session.agentHandle = undefined;
			session.agentProviderId = undefined;
			session.agentSynced = 0;
		}
	}

	async cancel(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.denyPending(sessionId);
		session.cancel?.cancel();
		const runId = session.activeRun?.runId;
		if (runId) {
			this.finish(session, runId, 'abort');
		}
		if (session.agentHandle && session.agentProviderId) {
			void this.agentProviders.get(session.agentProviderId)?.interrupt(session.agentHandle);
		}
	}

	async pause(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.paused = true;
		if (session.harness) {
			session.harness.paused = true;
			session.harness.lifecycle.tryTransition('paused');
		}
		const runId = session.activeRun?.runId;
		if (runId) {
			session.activeRun = { ...session.activeRun!, status: 'waiting' };
			this.emit(session, runId, { type: 'lifecycle', phase: 'paused' });
			this.emit(session, runId, { type: 'human', action: 'pause', detail: 'Paused.' });
		}
	}

	async resume(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.paused = false;
		if (session.harness) {
			session.harness.paused = false;
			session.harness.lifecycle.resume();
		}
		const runId = session.activeRun?.runId;
		if (runId) {
			session.activeRun = { ...session.activeRun!, status: 'running' };
			this.emit(session, runId, { type: 'lifecycle', phase: 'running' });
			this.emit(session, runId, { type: 'human', action: 'resume', detail: 'Resumed.' });
		}
	}

	async forkSession(sessionId: string): Promise<string> {
		const source = this.getOrCreateSession(sessionId) as ISessionState;
		const nextId = generateUuid();
		const child = this.getOrCreateSession(nextId) as ISessionState;
		child.conversationId = source.conversationId;
		child.mode = source.mode;
		child.providerRef = source.providerRef;
		child.messages = source.messages.map(message => ({ ...message }));
		child.lastLane = source.lastLane;
		const runId = source.activeRun?.runId ?? generateUuid();
		this.emit(child, runId, { type: 'human', action: 'fork', detail: `Forked from ${sessionId}.` });
		return nextId;
	}

	async redirect(sessionId: string, text: string): Promise<string> {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		const runId = session.activeRun?.runId;
		const running = session.activeRun && (session.activeRun.status === 'running' || session.activeRun.status === 'waiting');
		if (running && session.deepseek?.running && runId) {
			session.deepseek.inbox.push(text);
			session.messages.push({ role: 'user', content: text });
			this.emit(session, runId, { type: 'human', action: 'redirect', detail: text });
			this.emit(session, runId, { type: 'inbox', claimed: 0 });
			return runId;
		}
		if (running && session.harness && runId) {
			session.harness.inbox.inject(text, true);
			session.messages.push({ role: 'user', content: text });
			this.emit(session, runId, { type: 'human', action: 'redirect', detail: text });
			this.emit(session, runId, { type: 'inbox', claimed: 0 });
			return runId;
		}
		if (runId) {
			this.emit(session, runId, { type: 'human', action: 'redirect', detail: text });
		}
		return this.send(sessionId, { text, mode: session.mode, providerRef: session.providerRef });
	}

	async applyHuman(sessionId: string, action: IHumanAction): Promise<void> {
		const session = this.sessions.get(sessionId) as ISessionState | undefined;
		if (!session) {
			return;
		}
		const life = session.harness?.lifecycle ?? new TaskLifecycle();
		const effect = applyHumanAction(action, life, session.harness?.controller.plan);
		const runId = session.activeRun?.runId ?? generateUuid();
		if (effect.phase === 'paused' || action.kind === 'pause' || action.kind === 'takeover') {
			session.paused = true;
			if (session.harness) {
				session.harness.paused = true;
			}
		}
		if (effect.phase === 'running' && action.kind === 'resume') {
			session.paused = false;
			if (session.harness) {
				session.harness.paused = false;
			}
		}
		if (effect.stop || action.kind === 'stop' || action.kind === 'takeover') {
			session.cancel?.cancel();
		}
		if (effect.plan && session.harness) {
			session.harness.controller.replacePlan(effect.plan);
			this.emit(session, runId, { type: 'plan', entries: planEntries(effect.plan) });
		}
		if (effect.inject) {
			if (session.deepseek?.running) {
				session.deepseek.inbox.push(effect.inject);
			} else {
				session.harness?.inbox.inject(effect.inject, true);
			}
		}
		if (effect.approval) {
			this.respondToAccessRequest(effect.approval.requestId, effect.approval.effect, 'once');
		}
		this.emit(session, runId, { type: 'human', action: action.kind, detail: effect.reason });
	}

	onEvent(sessionId: string, listener: (e: IVoltEventEnvelope) => void): IDisposable {
		let set = this.listeners.get(sessionId);
		if (!set) {
			set = new Set();
			this.listeners.set(sessionId, set);
		}
		set.add(listener);
		return toDisposable(() => set.delete(listener));
	}

	isCatalogLoading(): boolean {
		return this.catalogLoading;
	}

	listCatalog(): IVoltCatalogItem[] {
		return this.catalog;
	}

	listProfiles(): IProviderProfile[] {
		return this.profiles;
	}

	async upsertProfile(draft: IProviderProfileDraft, secret?: string): Promise<IProviderProfile> {
		const id = draft.id ?? generateUuid();
		const existing = this.profiles.find(p => p.id === id);
		const profile: IProviderProfile = {
			id,
			label: draft.kind === 'agent' ? displayProviderLabel(draft.label, draft.providerId) : draft.label,
			kind: draft.kind,
			providerId: draft.providerId,
			modelId: draft.modelId,
			enabled: draft.enabled ?? existing?.enabled ?? true,
			transport: draft.transport,
			apiStyle: draft.apiStyle,
			endpoint: draft.endpoint,
			command: draft.command,
			args: draft.args,
			cwd: draft.cwd,
			authKind: draft.authKind,
			hasSecret: !!(secret || existing?.hasSecret),
		};
		this.profiles = [...this.profiles.filter(p => p.id !== id), profile];
		if (secret) {
			await this.secretStorage.set(secretKeyForProfile(id), secret);
			profile.hasSecret = true;
		}
		this.saveProfiles();
		this._onDidChangeProfiles.fire();
		await this.refreshCatalog();
		return profile;
	}

	async deleteProfile(id: string): Promise<void> {
		this.profiles = this.profiles.filter(p => p.id !== id);
		await this.secretStorage.delete(secretKeyForProfile(id));
		this.saveProfiles();
		this._onDidChangeProfiles.fire();
		await this.refreshCatalog();
	}

	async setModelEnabled(ref: string, enabled: boolean): Promise<void> {
		if (enabled) {
			this.enabled.add(ref);
		} else {
			this.enabled.delete(ref);
		}
		this.storageService.store(VOLT_ENABLED_MODELS_STORAGE_KEY, JSON.stringify([...this.enabled]), StorageScope.APPLICATION, StorageTarget.USER);
		this.catalog = this.catalog.map(item => item.ref === ref ? { ...item, enabled } : item);
		this._onDidChangeCatalog.fire();
	}

	isModelEnabled(ref: string): boolean {
		return this.enabled.has(ref);
	}

	getTaskModels(): IVoltTaskModels {
		return { ...this.taskModels };
	}

	// --- IVoltModelAccess (shared with the Prediction Runtime, D22) ---------------------------

	resolveCatalogItem(ref: string): IVoltCatalogItem | undefined {
		return this.catalog.find(item => item.ref === ref);
	}

	getActiveCatalogRef(): string | undefined {
		return this.activeCatalogRef;
	}

	async setActiveCatalogRef(ref: string | undefined): Promise<void> {
		if (this.activeCatalogRef === ref) {
			return;
		}
		this.activeCatalogRef = ref;
		if (ref) {
			this.storageService.store(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, ref, StorageScope.APPLICATION, StorageTarget.USER);
		} else {
			this.storageService.remove(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, StorageScope.APPLICATION);
		}
		this._onDidChangeActiveCatalog.fire();
	}

	resolveTabModelRef(): string | undefined {
		return resolveTabModel(this.activeCatalogRef, this.taskModels, this.catalog, item => this.profileCanServeTab(item.profileId));
	}

	/** OpenAI-style profiles with no stored key can never produce ghost text. */
	private profileCanServeTab(profileId: string): boolean {
		const profile = this.profiles.find(p => p.id === profileId);
		if (!profile) {
			return false;
		}
		return profile.authKind !== 'apikey' || profile.hasSecret;
	}

	/**
	 * One stateless completion. Chat models go through HTTP. Agent refs reuse a dedicated
	 * ask-mode ACP session so the composer selection can power Tab.
	 */
	async *streamModel(ref: string, messages: IModelMessage[], options: IVoltModelOptions | undefined, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const item = this.catalog.find(c => c.ref === ref);
		if (!item) {
			throw new Error(`Unknown catalog ref ${ref}`);
		}
		const profile = this.profiles.find(p => p.id === item.profileId);
		if (!profile) {
			throw new Error(`Missing profile for catalog ref ${ref}`);
		}
		if (item.kind === 'agent') {
			yield* this.streamTabAgent(item, profile, messages, options, token);
			return;
		}
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			throw new Error(`Unknown model provider ${profile.providerId}`);
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const resolved = this.resolvedOptions(item, options);
		if (resolved[MODEL_OPTION_REASONING] === 'auto') {
			// One-shot completions (Tab, titles) want the first token now, not deep thought.
			resolved[MODEL_OPTION_REASONING] = closestLevel('low', (item.optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING)?.options ?? []).map(option => option.value).filter(value => value !== 'auto' && value !== 'off')) ?? 'low';
		}
		yield* provider.stream({
			modelId: item.id,
			messages,
			profile,
			apiKey,
			options: resolved,
		}, token);
	}

	private async *streamTabAgent(
		item: IVoltCatalogItem,
		profile: IProviderProfile,
		messages: IModelMessage[],
		options: IVoltModelOptions | undefined,
		token: CancellationToken,
	): AsyncIterable<IVoltEvent> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			throw new Error(`Unknown agent provider ${profile.providerId}`);
		}
		if (!this.tabAgent || this.tabAgent.ref !== item.ref) {
			await this.disposeTabAgent();
			const handle = await provider.start({
				mode: 'ask',
				profile,
				cwd: this.workspace.getWorkspace().folders[0]?.uri.fsPath,
				modelId: item.id === profile.providerId ? undefined : item.id,
				options: this.resolvedOptions(item, options),
			});
			provider.setRunContext?.(handle, { sessionId: TAB_PREDICTION_SESSION_ID, runId: 'tab', mode: 'ask' });
			await provider.applyAccessPolicy?.(handle, compilePolicy({ overlay: modeOverlay('ask') }));
			this.tabAgent = { ref: item.ref, handle, provider };
		}
		const text = [
			'Fill-in-the-middle. Reply with SOURCE CODE only - the exact characters to insert at the cursor.',
			'No English. No markdown. No explanation. Empty reply if you cannot complete.',
			...messages.map(message => message.content).filter(Boolean),
		].join('\n\n');
		yield* provider.send(this.tabAgent.handle, { text, mode: 'ask' }, profile, token);
	}

	private async disposeTabAgent(): Promise<void> {
		const live = this.tabAgent;
		this.tabAgent = undefined;
		if (live) {
			await live.provider.dispose(live.handle).catch(() => undefined);
		}
	}

	async setTaskModel(slot: keyof IVoltTaskModels, ref: string | undefined): Promise<void> {
		this.taskModels = { ...this.taskModels, [slot]: ref };
		this.storageService.store(VOLT_TASK_MODELS_STORAGE_KEY, JSON.stringify(this.taskModels), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeCatalog.fire();
	}

	getModeProfile(mode: VoltMode): string | undefined {
		return this.modeProfiles[mode];
	}

	async setModeProfile(mode: VoltMode, profileId: string | undefined): Promise<void> {
		this.modeProfiles = { ...this.modeProfiles, [mode]: profileId };
		this.storageService.store(VOLT_MODE_PROFILES_STORAGE_KEY, JSON.stringify(this.modeProfiles), StorageScope.APPLICATION, StorageTarget.USER);
	}

	async refreshCatalog(): Promise<void> {
		if (this.catalogRefresh) {
			return this.catalogRefresh;
		}
		this.catalogRefresh = this.doRefreshCatalog().finally(() => {
			this.catalogRefresh = undefined;
		});
		return this.catalogRefresh;
	}

	/**
	 * Providers are queried in parallel and the picker is updated as each one answers, so the
	 * first CLI to respond is visible immediately instead of waiting on the slowest probe.
	 */
	private async doRefreshCatalog(): Promise<void> {
		this.catalogLoading = true;
		if (!this.catalog.length) {
			this._onDidChangeCatalog.fire();
		}
		const byProfile = new Map<string, IVoltCatalogItem[]>();
		for (const item of this.catalog) {
			const existing = byProfile.get(item.profileId) ?? [];
			existing.push(item);
			byProfile.set(item.profileId, existing);
		}
		const publish = () => {
			this.catalog = [...byProfile.values()].flat();
			this._onDidChangeCatalog.fire();
		};
		await Promise.all(this.profiles.filter(profile => profile.enabled).map(async profile => {
			byProfile.set(profile.id, await this.catalogForProfile(profile));
			publish();
		}));
		this.persistCatalog();
		this.catalogLoading = false;
		this._onDidChangeCatalog.fire();
	}

	private async catalogForProfile(profile: IProviderProfile): Promise<IVoltCatalogItem[]> {
		if (profile.kind === 'model') {
			const provider = this.modelProviders.get(profile.providerId);
			if (!provider) {
				return [];
			}
			const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
			let models = await provider.listModels(profile, apiKey).catch(() => []);
			if (profile.modelId && !models.some(m => m.id === profile.modelId)) {
				models = [{ id: profile.modelId, label: profile.modelId, capabilities: DEFAULT_MODEL_CAPABILITIES }, ...models];
			}
			return models.map(model => {
				const ref = `model:${profile.id}:${model.id}`;
				return {
					ref,
					kind: 'model' as const,
					providerId: profile.providerId,
					profileId: profile.id,
					id: model.id,
					label: model.label,
					qualifier: profile.label,
					enabled: this.enabled.size ? this.enabled.has(ref) : true,
					capabilities: model.capabilities,
					...(model.optionDescriptors ? { optionDescriptors: model.optionDescriptors } : {}),
					...(model.description ? { description: model.description } : {}),
					...(model.contextLabel ? { contextLabel: model.contextLabel } : {}),
				};
			});
		}

		const definition = cliAgentDefinition(profile.providerId);
		let detect = this.detections.get(profile.id);
		if (!detect) {
			detect = await this.detectProfile(profile).catch(() => ({ available: false, detail: 'Health check failed.' }) satisfies IDetectResult);
			this.detections.set(profile.id, detect);
		}
		if (!detect.available || (definition?.probeAuth && !detect.authenticated)) {
			return [];
		}
		const label = displayProviderLabel(profile.label, profile.providerId);
		const models = await this.discoverAgentModels(profile);
		if (models.length) {
			return models.map(model => {
				const ref = `agent:${profile.id}:${model.id}`;
				return {
					ref,
					kind: 'agent' as const,
					providerId: profile.providerId,
					profileId: profile.id,
					id: model.id,
					label: model.label,
					qualifier: model.label.toLowerCase().includes(label.toLowerCase()) ? undefined : label,
					enabled: this.enabled.size ? this.enabled.has(ref) : true,
					capabilities: model.capabilities,
					...(model.optionDescriptors ? { optionDescriptors: model.optionDescriptors } : {}),
					...(model.detail ? { detail: model.detail } : {}),
					...(model.description ? { description: model.description } : {}),
					...(model.contextLabel ? { contextLabel: model.contextLabel } : {}),
				};
			});
		}
		return [];
	}

	async detectAgents(): Promise<IAgentDetectResult[]> {
		const results: IAgentDetectResult[] = [];
		for (const profile of this.profiles.filter(p => p.kind === 'agent')) {
			const provider = this.agentProviders.get(profile.providerId);
			if (!provider) {
				continue;
			}
			const detect = await this.detectProfile(profile);
			results.push({ ...detect, providerId: profile.providerId, profileId: profile.id, label: profile.label });
		}
		return results;
	}

	listProviderStatuses(): IVoltProviderStatus[] {
		return this.profiles.map(profile => {
			const detect = this.detections.get(profile.id);
			const models = this.catalog.filter(item => item.profileId === profile.id);
			return {
				profileId: profile.id,
				providerId: profile.providerId,
				kind: profile.kind,
				label: displayProviderLabel(profile.label, profile.providerId),
				state: this.providerState(profile, detect),
				enabled: profile.enabled,
				version: detect?.version,
				account: detect?.account,
				plan: detect?.plan,
				detail: detect?.detail,
				earlyAccess: cliAgentDefinition(profile.providerId)?.earlyAccess,
				checkedAt: this.lastProviderCheck,
				models,
			} satisfies IVoltProviderStatus;
		});
	}

	async refreshProviders(): Promise<void> {
		if (this.providerRefresh) {
			this.providerRefreshAgain = true;
			return this.providerRefresh;
		}
		this.providerRefresh = this.executeProviderRefresh().finally(() => {
			this.providerRefresh = undefined;
		});
		return this.providerRefresh;
	}

	private async executeProviderRefresh(): Promise<void> {
		clearClaudeModelCache();
		this.agentModels.clear();
		const results = await Promise.all(this.profiles.map(async profile => {
			const detect = profile.enabled
				? await this.detectProfile(profile).catch(() => ({ available: false, detail: 'Health check failed.' }) satisfies IDetectResult)
				: undefined;
			return [profile.id, detect] as const;
		}));
		this.detections = new Map(results.filter((entry): entry is readonly [string, IDetectResult] => !!entry[1]));
		this.lastProviderCheck = Date.now();
		await this.refreshCatalog();
		this._onDidChangeProviderStatus.fire();
		if (this.providerRefreshAgain) {
			this.providerRefreshAgain = false;
			await this.executeProviderRefresh();
		}
	}

	async setProfileEnabled(profileId: string, enabled: boolean): Promise<void> {
		const profile = this.profiles.find(p => p.id === profileId);
		if (!profile || profile.enabled === enabled) {
			return;
		}
		this.profiles = this.profiles.map(p => p.id === profileId ? { ...p, enabled } : p);
		this.saveProfiles();
		this._onDidChangeProfiles.fire();
		await this.refreshCatalog();
		this._onDidChangeProviderStatus.fire();
	}

	getLastProviderCheck(): number | undefined {
		return this.lastProviderCheck;
	}

	getHealthCheckInterval(): number {
		const raw = this.storageService.getNumber(VOLT_HEALTH_INTERVAL_STORAGE_KEY, StorageScope.APPLICATION);
		return raw === undefined || raw < 0 ? VOLT_DEFAULT_HEALTH_INTERVAL : raw;
	}

	async setHealthCheckInterval(seconds: number): Promise<void> {
		this.storageService.store(VOLT_HEALTH_INTERVAL_STORAGE_KEY, Math.max(0, Math.round(seconds)), StorageScope.APPLICATION, StorageTarget.USER);
		this.scheduleHealthChecks();
		this._onDidChangeProviderStatus.fire();
	}

	getModelOptions(ref: string): IVoltModelOptions {
		return this.modelOptions[ref] ?? {};
	}

	async setModelOptions(ref: string, options: IVoltModelOptions): Promise<void> {
		this.modelOptions = { ...this.modelOptions, [ref]: options };
		this.storageService.store(VOLT_MODEL_OPTIONS_STORAGE_KEY, JSON.stringify(this.modelOptions), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeCatalog.fire();
	}

	getAccessMode(): VoltAccessMode {
		return this.accessMode;
	}

	async setAccessMode(mode: VoltAccessMode): Promise<void> {
		this.accessMode = normalizeVoltAccessMode(mode);
		this.storageService.store(VOLT_ACCESS_MODE_STORAGE_KEY, this.accessMode, StorageScope.APPLICATION, StorageTarget.USER);
		this.recompilePolicy();
		this._onDidChangeAccess.fire();
		await this.pushPolicyToAgents();
	}

	respondToAccessRequest(requestId: string, effect: Extract<PermissionEffect, 'allow' | 'deny'>, scope: AccessDecisionScope = 'once', pattern?: string): void {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) {
			return;
		}
		this.pendingApprovals.delete(requestId);
		const decision: IAccessDecision = {
			requestId,
			effect,
			scope,
			pattern: pattern ?? pending.request.resource.value,
			policySource: scope === 'always' ? 'session' : 'user',
			risk: pending.request.risk,
		};
		if (effect === 'allow' && scope === 'always') {
			this.savedRules = [...this.savedRules, {
				action: pending.request.action,
				resource: decision.pattern ?? pending.request.resource.value,
				effect: 'allow',
				source: 'session',
			}];
			this.recompilePolicy();
			this.scheduleSaveAccess();
		}
		this.recordReceipt(pending.request, decision, effect === 'allow' ? 'approved' : 'denied');
		const session = this.sessions.get(pending.request.sessionId);
		if (session && effect === 'allow' && pending.request.action === 'question' && (session.mode === 'plan' || session.mode === 'ask')) {
			// Approving the plan is the Build step: the rest of this run implements it.
			session.mode = 'agent';
		}
		if (session?.activeRun) {
			session.activeRun = { ...session.activeRun, status: 'running' };
			this.emit(session, pending.request.runId, { type: 'access.resolved', requestId, effect, scope });
		}
		pending.resolve(decision);
	}

	listPendingAccessRequests(sessionId?: string): IAccessRequest[] {
		const requests = [...this.pendingApprovals.values()].map(item => item.request);
		return sessionId ? requests.filter(request => request.sessionId === sessionId) : requests;
	}

	listReceipts(sessionId?: string): IExecutionReceipt[] {
		return sessionId ? this.receipts.filter(item => item.sessionId === sessionId) : this.receipts.slice();
	}

	listProjectRules(): IPermissionRule[] {
		return this.projectRules.slice();
	}

	async setProjectRules(rules: IPermissionRule[]): Promise<void> {
		this.projectRules = rules.map(rule => ({ ...rule, source: 'project' as const }));
		this.recompilePolicy();
		this.scheduleSaveAccess();
		this._onDidChangeAccess.fire();
		await this.pushPolicyToAgents();
	}

	listSavedApprovals(): IPermissionRule[] {
		return this.savedRules.slice();
	}

	async revokeSavedApproval(index: number): Promise<void> {
		this.savedRules = this.savedRules.filter((_, i) => i !== index);
		this.recompilePolicy();
		this.scheduleSaveAccess();
		this._onDidChangeAccess.fire();
	}

	/**
	 * Asks a CLI agent for its models. Discovery spawns the agent, so results are cached until the
	 * next health check and skipped entirely for agents we know are not installed.
	 */
	private async discoverAgentModels(profile: IProviderProfile): Promise<IModelInfo[]> {
		const cached = this.agentModels.get(profile.id);
		if (cached) {
			return cached;
		}
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider?.listModels || this.detections.get(profile.id)?.available === false) {
			return [];
		}
		const models = await provider.listModels(profile).catch(() => undefined);
		if (!models) {
			return this.agentModels.get(profile.id) ?? [];
		}
		this.agentModels.set(profile.id, models);
		return models;
	}

	/** Merges the caller's selections over the stored ones and fills in provider defaults. */
	private resolvedOptions(item: IVoltCatalogItem, requested: IVoltModelOptions | undefined): IVoltModelOptions {
		return resolveModelOptions(item.optionDescriptors, { ...this.getModelOptions(item.ref), ...requested });
	}

	private providerState(profile: IProviderProfile, detect: IDetectResult | undefined): VoltProviderState {
		if (!profile.enabled) {
			return 'disabled';
		}
		if (!detect) {
			return 'checking';
		}
		if (!detect.available) {
			return 'missing';
		}
		return detect.authenticated ? 'authenticated' : 'available';
	}

	private async detectProfile(profile: IProviderProfile): Promise<IDetectResult> {
		if (profile.kind === 'agent') {
			const definition = cliAgentDefinition(profile.providerId);
			if (definition) {
				return detectCliAgent(this.stdio, definition, profile.command);
			}
			const provider = this.agentProviders.get(profile.providerId);
			return provider ? provider.detect(profile) : { available: false, detail: 'Unknown agent provider.' };
		}
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			return { available: false, detail: 'Unknown model provider.' };
		}
		const detect = await provider.detect(profile);
		if (!detect.available) {
			return detect;
		}
		const needsKey = profile.authKind === 'apikey';
		const authenticated = detect.authenticated ?? (!needsKey || profile.hasSecret);
		return {
			...detect,
			authenticated,
			detail: detect.detail ?? (authenticated
				? `Connected - ${profile.endpoint?.baseURL ?? profile.providerId}`
				: 'Available - add an API key to start using this provider.'),
		};
	}

	private scheduleHealthChecks(): void {
		this.healthTimer.cancel();
		const seconds = this.getHealthCheckInterval();
		if (seconds <= 0) {
			return;
		}
		this.healthTimer.cancelAndSet(() => void this.refreshProviders(), seconds * 1000);
	}

	private beginRun(session: ISessionState, request: IVoltSendRequest): string {
		const runId = generateUuid();
		session.activeRun = {
			runId,
			sessionId: session.sessionId,
			status: 'running',
			startedAt: Date.now(),
			providerRef: session.providerRef,
		};
		session.cancel?.dispose(true);
		session.cancel = new CancellationTokenSource();
		this.emit(session, runId, { type: 'run.start', runId, mode: request.mode });
		this.noteWorktree(session, runId);
		return runId;
	}

	/** The open project, never the managed checkout. */
	private projectRoot(session: ISessionState): URI | undefined {
		return this.sessionContext.rootFor(session.sessionId) ?? this.workspace.getWorkspace().folders[0]?.uri;
	}

	/** The session's project root, or its worktree once one exists. A visible chat must not retarget a run that already has a binding. */
	private executionRoot(session: ISessionState): URI | undefined {
		if (session.worktreePath) {
			return URI.file(session.worktreePath);
		}
		return this.projectRoot(session);
	}

	/** First send in New Worktree mode creates the checkout. Later sends stay there, recreating it if archive pruned the files. */
	private async prepareWorktree(session: ISessionState, request: IVoltSendRequest): Promise<void> {
		const project = this.projectRoot(session);
		if (session.worktreePath && session.worktreeBranch) {
			if (!project) {
				throw new Error('Open a folder before using a worktree.');
			}
			const recreated = await this.worktrees.ensure(project.fsPath, session.worktreePath, session.worktreeBranch);
			if (recreated) {
				session.announceWorktree = true;
			}
			return;
		}
		const userTurns = session.messages.filter(message => message.role === 'user').length;
		if (request.runOn !== 'worktree' || userTurns > 1) {
			return;
		}
		if (!project) {
			throw new Error('Open a folder before using a worktree.');
		}
		const created = await this.worktrees.create(project.fsPath);
		session.worktreePath = created.path;
		session.worktreeBranch = created.branch;
		session.announceWorktree = true;
		this.history.open(session.sessionId).setMeta({ worktreePath: created.path, worktreeBranch: created.branch });
	}

	private noteWorktree(session: ISessionState, runId: string): void {
		if (!session.announceWorktree || !session.worktreeBranch || !session.worktreePath) {
			return;
		}
		session.announceWorktree = false;
		this.emit(session, runId, { type: 'notice', severity: 'info', title: `Running in ${session.worktreeBranch}`, description: session.worktreePath });
	}

	private workspaceTools(session: ISessionState, state?: INativeState): IVoltTool[] {
		return createBuiltinTools({
			fileService: this.fileService,
			searchService: this.searchService,
			requestService: this.requestService,
			stdio: this.stdio,
			hostTools: this.hostTools,
			root: () => this.executionRoot(session),
			meta: {
				grantGroups: () => session.extraGroups ?? [],
				...(state ? {
					loadSkill: name => this.loadSkill(session, name),
					runSubagent: (request, ctx) => this.runSubagent(session, state, request, ctx),
				} : {}),
			},
			...(state ? {
				ledger: () => state.ledger,
				documents: this.toolDocuments,
				readRoots: () => [...(state.instructions?.readRoots ?? []), ...state.logRoots],
				rulesFor: uri => {
					const rules = state.instructions?.rules;
					const root = this.executionRoot(session);
					return rules?.length && root ? rulesForPath(rules, relativeToRoot(root, uri)) : undefined;
				},
				codeIntel: this.codeIntel,
				onLog: path => {
					const dir = URI.file(path).with({ path: posix.dirname(URI.file(path).path) });
					if (!state.logRoots.some(root => root.toString() === dir.toString())) {
						state.logRoots.push(dir);
					}
				},
			} : {}),
		});
	}

	/** Open editors: agent edits go into the buffer the user sees when it has unsaved changes. */
	private readonly toolDocuments: IToolDocuments = {
		dirtyText: uri => {
			const model = this.textFileService.files.get(uri);
			return model?.isDirty() ? model.textEditorModel?.getValue() : undefined;
		},
		writeOpen: async (uri, text) => {
			const model = this.textFileService.files.get(uri);
			const editor = model?.textEditorModel;
			if (!model || !editor) {
				return false;
			}
			editor.pushEditOperations([], [{ range: editor.getFullModelRange(), text }], () => null);
			await model.save();
			return true;
		},
	};

	/**
	 * Native model path. DeepSeek owns the turn, the tool pipeline, and approval.
	 * Volt streams the selected provider, paints `IVoltEvent`s, and owns what the loop cannot:
	 * the cache-stable prompt, effort, compaction, sub-agents, and the completion review.
	 */
	private async executeDeepseek(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem): Promise<void> {
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown model provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const root = this.executionRoot(session);
		const cwd = root?.fsPath;
		await this.nativeRestores.get(session.sessionId);
		this.nativeRestores.delete(session.sessionId);
		const state = this.nativeState(session);
		state.cwd = cwd;
		state.running = true;
		const journal = () => ({ version: 1 as const, messages: state.messages, synced: state.synced, effort: state.effort, todo: state.todo, savedAt: Date.now() });
		state.changed.clear();
		state.ledger.resumeReferences();
		this.syncNativeTranscript(session, state, request.text);

		const [projectInstructions, instructions, mcpTools] = await Promise.all([
			this.workspaceProjectInstructions(root),
			this.workspaceInstructions(root),
			// MCP servers get a short, bounded wait: a slow server joins the next run instead of stalling this one.
			modePolicy(request.mode).allowMcp
				? this.pathService.userHome().catch(() => undefined).then(home => this.mcpHost.tools(root, home, state.messages.length > 1 ? 1_500 : 4_000)).catch(() => [])
				: Promise.resolve([]),
		]);
		state.instructions = instructions;
		const facts = this.environmentFacts(root);
		const tools = [...this.workspaceTools(session, state), ...mcpTools];
		const turn = nativeModelTurn({
			text: request.text,
			mode: request.mode,
			cwd,
			platform: facts.platform,
			shell: facts.shell,
			date: facts.date,
			projectInstructions,
			rules: alwaysRules(instructions.rules),
			skills: instructionsIndex(instructions.skills, instructions.rules),
			tools,
		});
		const selected = tools.filter(tool => turn.toolNames.includes(tool.name));
		const registry = new Map(selected.map(tool => [tool.name, tool]));
		const cancel = session.cancel?.token ?? CancellationToken.None;
		const options = this.runOptions(item, request, state);
		const schemas = toolSchemas(selected);
		const contextWindow = item.capabilities.contextWindow || DEFAULT_MODEL_CAPABILITIES.contextWindow;
		const system: INativeLoopMessage = { role: 'system', content: turn.prompt };
		const emit = (event: IVoltEvent) => {
			if (event.type === 'usage') {
				state.promptTokens = event.used ?? event.input + (event.cache ?? 0) + (event.cacheWrite ?? 0);
			}
			this.emit(session, runId, event);
		};
		const compact = (messages: INativeLoopMessage[], aggressive: boolean) => this.compactNative(session, runId, state, messages, {
			provider, profile, apiKey, item, system: turn.prompt, contextWindow, aggressive, token: cancel,
		});
		try {
			const result = await runDeepseekLoop({
				stream: (messages, _token, streamOptions) => new VoltLlmAdapter(provider).stream({
					modelId: item.id,
					messages: nativeToModelMessages([system, ...messages]),
					profile,
					apiKey,
					options,
					tools: schemas,
					...(streamOptions?.maxOutputTokens ? { maxOutputTokens: streamOptions.maxOutputTokens } : {}),
				}, cancel),
				execute: (calls, onResult) => runToolBatch(registry, calls, {
					cwd,
					signal: abortSignalFrom(cancel),
					emit: event => this.onToolEvent(session, runId, state, event),
				}, { authorize: async () => ({ allow: true }), onResult }),
				authorize: call => this.authorizeDeepseek(session, runId, profile, call, registry.get(call.name)),
				preauthorize: call => this.preauthorizeDeepseek(session, runId, profile, call, registry.get(call.name)),
				emit,
				tool: name => registry.get(name),
				cwd,
				contextWindow,
				maxOutputTokens: 128_000,
				prepareTurn: async (messages, step) => {
					state.ledger.nextStep();
					this.journal.schedule(session.sessionId, journal);
					if (step > 1 || messages.length > 2) {
						const estimate = Math.max(state.promptTokens, estimateTokens(turn.prompt) + totalTokens(messages));
						if (shouldCompact(estimate, { window: contextWindow, ...DEFAULT_COMPACTION })) {
							await compact(messages, false);
						}
					}
				},
				recoverOverflow: messages => compact(messages, true),
				reviewCompletion: modePolicy(request.mode).allowWrites ? input => this.reviewCompletion(state, input.attempt) : undefined,
			}, {
				messages: state.messages,
				token: cancel,
				isPaused: () => !!session.paused,
				claimInbox: () => state.inbox.splice(0, state.inbox.length),
			});
			if (result.assistant) {
				session.messages.push({ role: 'assistant', content: result.assistant });
			}
			state.synced = session.messages.length;
			if (result.outcome === 'budget') {
				this.emit(session, runId, { type: 'notice', severity: 'warning', title: 'Paused at the step limit for one run.', description: 'Send "continue" to keep going from here.' });
			}
			const aborted = result.outcome === 'abort' || cancel.isCancellationRequested;
			this.finish(session, runId, aborted ? 'abort' : result.outcome === 'fail' ? 'fail' : 'done');
		} catch (err) {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, cancel.isCancellationRequested ? 'abort' : 'fail');
		} finally {
			state.running = false;
			state.synced = Math.max(state.synced, session.messages.length);
			void this.journal.schedule(session.sessionId, journal, true);
		}
	}

	private nativeState(session: ISessionState): INativeState {
		session.deepseek ??= {
			messages: [],
			inbox: [],
			running: false,
			synced: 0,
			ledger: new FileLedger(),
			logRoots: [],
			changed: new ResourceMap(),
			promptTokens: 0,
		};
		return session.deepseek;
	}

	/**
	 * The native transcript and `session.messages` can drift apart when the user switches between
	 * a native model and an ACP agent. Turns the native transcript has not seen are mirrored in as
	 * plain text before the new message, so a model switch never loses the conversation.
	 */
	private syncNativeTranscript(session: ISessionState, state: INativeState, text: string): void {
		const unseen = session.messages.slice(state.synced, -1);
		for (const message of unseen) {
			if (!message.content.trim() || message.role === 'system') {
				continue;
			}
			state.messages.push(message.role === 'assistant' ? { role: 'assistant', content: message.content } : { role: 'user', content: message.content, turn: true });
		}
		const tail = state.messages.at(-1);
		if (!(tail?.role === 'user' && tail.content === text)) {
			state.messages.push({ role: 'user', content: text, turn: true });
		}
		state.synced = session.messages.length;
	}

	/** Model options for this run, with reasoning `auto` resolved to a concrete level. */
	private runOptions(item: IVoltCatalogItem, request: IVoltSendRequest, state: INativeState): IVoltModelOptions {
		const options = { ...this.resolvedOptions(item, request.options) };
		const descriptor = item.optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING);
		if (!descriptor || options[MODEL_OPTION_REASONING] !== 'auto') {
			return options;
		}
		const level = chooseEffort(request.text, { mode: request.mode, previous: state.effort, attachments: request.mentions?.length });
		state.effort = level;
		const values = (descriptor.options ?? []).map(option => option.value).filter(value => value !== 'auto' && value !== 'off');
		options[MODEL_OPTION_REASONING] = closestLevel(level, values) ?? level;
		return options;
	}

	private onToolEvent(session: ISessionState, runId: string, state: INativeState, event: { type: string;[key: string]: unknown }): void {
		if (event.type === 'file.change' && URI.isUri(event.uri)) {
			if (!state.changed.has(event.uri)) {
				state.changed.set(event.uri, this.codeIntel.errorCounts(event.uri));
			}
			this.codeIntel.noteWrite(event.uri);
		}
		if (event.type === 'plan' && Array.isArray(event.entries)) {
			state.todo = (event.entries as { content: string; status: string }[]).map(entry => `- [${entry.status}] ${entry.content}`).join('\n');
		}
		const forwarded = asToolEvent(event);
		if (forwarded) {
			this.emit(session, runId, forwarded);
		}
	}

	/**
	 * Before the model is allowed to stop: did its edits introduce compiler or linter errors in the
	 * files it changed? Language services already know, so this costs a second, not a build.
	 */
	private async reviewCompletion(state: INativeState, attempt: number): Promise<string | undefined> {
		const files = [...state.changed.entries()].filter(([uri]) => DIAGNOSED_EXTENSIONS.test(uri.path));
		if (!files.length) {
			return undefined;
		}
		const found = await Promise.all(files.map(async ([uri, baseline]) => ({ uri, added: await this.codeIntel.newErrors(uri, baseline).catch(() => []) })));
		const root = state.cwd ? URI.file(state.cwd) : undefined;
		const lines = found.flatMap(({ uri, added }) => added.slice(0, 10).map(item => `${root ? relativeToRoot(root, uri) : uri.fsPath}:${item.line}:${item.column} ${item.message.split('\n')[0]}${item.source ? ` (${item.source})` : ''}`));
		if (!lines.length) {
			return undefined;
		}
		return [
			`Before you finish: the editor reports ${lines.length} new error${lines.length === 1 ? '' : 's'} in files you changed${attempt > 1 ? ' (still present after your last attempt)' : ''}:`,
			...lines.slice(0, 30),
			'Fix them, or if they are expected (for example, pre-existing or intentionally deferred), say so explicitly in your final answer.',
		].join('\n');
	}

	/**
	 * Summarizes older turns into one handoff message and keeps the recent tail verbatim. Done in
	 * place on the loop's own array, at one boundary, so the prompt cache restarts only once.
	 */
	private async compactNative(session: ISessionState, runId: string, state: INativeState, messages: INativeLoopMessage[], input: {
		readonly provider: IModelProvider;
		readonly profile: IProviderProfile;
		readonly apiKey: string | undefined;
		readonly item: IVoltCatalogItem;
		readonly system: string;
		readonly contextWindow: number;
		readonly aggressive: boolean;
		readonly token: CancellationToken;
	}): Promise<boolean> {
		const window = effectiveWindow({ window: input.contextWindow, ...DEFAULT_COMPACTION });
		const boundary = compactionBoundary(messages, Math.floor(window * (input.aggressive ? 0.1 : 0.25)));
		if (boundary <= 0) {
			return false;
		}
		const older = messages.slice(0, boundary);
		const carry = { files: state.ledger.summary(), todo: state.todo };
		this.emit(session, runId, { type: 'notice', severity: 'info', title: 'Compacting the conversation to keep it within the model\'s context.' });
		let summary: string | undefined;
		try {
			let text = '';
			for await (const event of input.provider.stream({
				modelId: input.item.id,
				messages: [
					{ role: 'system', content: COMPACTION_SYSTEM },
					{ role: 'user', content: compactionRequest(serializeForSummary(older), carry) },
				],
				profile: input.profile,
				apiKey: input.apiKey,
				options: { ...this.resolvedOptions(input.item, undefined), [MODEL_OPTION_REASONING]: 'low' },
				maxOutputTokens: 8_000,
			}, input.token)) {
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				}
			}
			summary = text.trim() || undefined;
		} catch (err) {
			this.logService.warn('[volt] compaction summary failed; using a mechanical summary', err);
		}
		const next = applyCompaction(messages, boundary, summary ?? mechanicalSummary(older, carry));
		messages.splice(0, messages.length, ...next);
		state.ledger.invalidateReferences();
		state.promptTokens = estimateTokens(input.system) + totalTokens(messages);
		this.emit(session, runId, { type: 'compaction', stages: [summary ? 'summarize' : 'mechanical'], dropped: boundary });
		return true;
	}

	/**
	 * A read-only sub-agent: its own context, the read/search/web tools, the same model at a lower
	 * effort. The parent sees one progress line per step and gets back only the final report.
	 */
	private async runSubagent(session: ISessionState, parent: INativeState, request: ISubagentRequest, ctx: IToolContext): Promise<{ text: string; isError?: boolean }> {
		const item = this.catalog.find(c => c.ref === session.providerRef && c.enabled) ?? this.catalog.find(c => c.enabled);
		const profile = item ? this.profiles.find(p => p.id === item.profileId) : undefined;
		const provider = profile ? this.modelProviders.get(profile.providerId) : undefined;
		const runId = session.activeRun?.runId;
		if (!item || !profile || !provider || item.kind !== 'model' || !runId) {
			return { text: 'Sub-agents need a native model to be selected.', isError: true };
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const allowed = new Set([...SUBAGENT_TOOLS, ...(request.kind === 'research' ? ['web_search', 'web_fetch'] : [])]);
		const tools = this.workspaceTools(session, { ...parent, ledger: new FileLedger() }).filter(tool => allowed.has(tool.name));
		const registry = new Map(tools.map(tool => [tool.name, tool]));
		const root = this.executionRoot(session);
		const facts = this.environmentFacts(root);
		const system: INativeLoopMessage = { role: 'system', content: buildSubagentPrompt({ kind: request.kind, cwd: root?.fsPath, platform: facts.platform, date: facts.date }) };
		const options = { ...this.resolvedOptions(item, undefined) };
		if (item.optionDescriptors?.some(option => option.id === MODEL_OPTION_REASONING)) {
			const values = item.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(option => option.value) ?? [];
			options[MODEL_OPTION_REASONING] = closestLevel(request.kind === 'research' ? 'medium' : 'low', values.filter(value => value !== 'auto' && value !== 'off')) ?? 'low';
		}
		const source = new CancellationTokenSource(session.cancel?.token);
		const onAbort = () => source.cancel();
		ctx.signal.addEventListener('abort', onAbort);
		const progress = (status: string) => {
			if (ctx.callId) {
				this.emit(session, runId, { type: 'tool.progress', callId: ctx.callId, status: `${request.description}: ${status}` });
			}
		};
		try {
			const result = await runDeepseekLoop({
				stream: messages => new VoltLlmAdapter(provider).stream({
					modelId: item.id,
					messages: nativeToModelMessages([system, ...messages]),
					profile,
					apiKey,
					options,
					tools: toolSchemas(tools),
				}, source.token),
				execute: (calls, onResult) => runToolBatch(registry, calls, { cwd: root?.fsPath, signal: abortSignalFrom(source.token) }, { authorize: async () => ({ allow: true }), onResult }),
				authorize: async call => this.preauthorizeDeepseek(session, runId, profile, call, registry.get(call.name)) ?? 'rejected',
				preauthorize: call => this.preauthorizeDeepseek(session, runId, profile, call, registry.get(call.name)) ?? 'rejected',
				emit: event => {
					if (event.type === 'tool.start' && event.title) {
						progress(event.title);
					}
				},
				tool: name => registry.get(name),
				cwd: root?.fsPath,
			}, {
				messages: [{ role: 'user', content: request.prompt }],
				token: source.token,
				budget: { maxToolCalls: 80, maxModelCalls: 30 },
			});
			const text = result.assistant.trim();
			if (result.outcome === 'abort') {
				return { text: 'The sub-agent was cancelled.', isError: true };
			}
			if (!text) {
				return { text: 'The sub-agent finished without a report.', isError: true };
			}
			return { text: result.outcome === 'budget' ? `${text}\n\n(The sub-agent reached its step limit; this report may be partial.)` : text, ...(result.outcome === 'fail' ? { isError: true } : {}) };
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
			source.dispose();
		}
	}

	private async loadSkill(session: ISessionState, name: string): Promise<string | undefined> {
		const instructions = session.deepseek?.instructions ?? await this.workspaceInstructions(this.executionRoot(session));
		const doc = findInstruction(name, instructions.skills, instructions.rules);
		if (!doc) {
			return undefined;
		}
		let files = '';
		if (doc.folder) {
			const folder = URI.parse(doc.folder);
			const listed: string[] = [];
			const walk = async (dir: URI, depth: number) => {
				const stat = await this.fileService.resolve(dir).catch(() => undefined);
				for (const child of stat?.children ?? []) {
					if (listed.length >= 40) {
						return;
					}
					if (child.isDirectory) {
						if (depth < 2) {
							await walk(child.resource, depth + 1);
						}
					} else if (!/^skill\.md$/i.test(child.name)) {
						listed.push(child.resource.fsPath);
					}
				}
			};
			await walk(folder, 0);
			if (listed.length) {
				files = `\n\nFiles bundled with this skill (read them with read_file when the instructions refer to them):\n${listed.map(path => `- ${path}`).join('\n')}`;
			}
		}
		return `<skill name="${doc.name}">\n${doc.body}\n</skill>${files}`;
	}

	/** Skills and rules, reloaded at most every few seconds so edits to them apply to the next run. */
	private workspaceInstructions(root: URI | undefined): Promise<IInstructionsSnapshot> {
		const key = root?.toString() ?? '';
		const cached = this.instructionsByRoot.get(key);
		if (cached && Date.now() - cached.at < INSTRUCTIONS_TTL_MS) {
			return cached.value;
		}
		const value = this.pathService.userHome()
			.catch(() => undefined)
			.then(home => loadInstructions(this.fileService, root, home))
			.catch(() => ({ skills: [], rules: [], readRoots: [] }));
		this.instructionsByRoot.set(key, { at: Date.now(), value });
		return value;
	}

	/** Policy's answer when no person has to be asked; `undefined` when one does. */
	private preauthorizeDeepseek(session: ISessionState, runId: string, profile: IProviderProfile, call: IToolCall, tool: IVoltTool | undefined): ApprovalOutcome | undefined {
		if (!tool) {
			return 'rejected';
		}
		if (tool.group === 'meta' || (tool.group === 'shell' && tool.parallelSafe)) {
			return 'allowed-once';
		}
		const knobs = deepseekKnobs(this.accessMode);
		const decision = this.evaluateAccessRequest(this.accessRequest(session, runId, profile, call, tool), false) as IAccessDecision;
		if (decision.effect === 'allow') {
			return 'allowed-once';
		}
		if (decision.effect === 'deny') {
			return 'rejected';
		}
		return knobs.approval === 'never' ? 'allowed-once' : undefined;
	}

	private accessRequest(session: ISessionState, runId: string, profile: IProviderProfile, call: IToolCall, tool: IVoltTool): IAccessRequest {
		const action = actionForGroup(tool.group);
		const resource = resourceForCall(tool, call.args);
		return {
			id: generateUuid(),
			sessionId: session.sessionId,
			runId,
			providerId: profile.providerId,
			action,
			resource,
			risk: classifyRisk(action, resource.value),
			preview: { title: tool.name, detail: stringifyUnknown(call.args).slice(0, 400) },
			createdAt: Date.now(),
		};
	}

	private async authorizeDeepseek(session: ISessionState, runId: string, profile: IProviderProfile, call: IToolCall, tool: IVoltTool | undefined): Promise<ApprovalOutcome> {
		if (!tool) {
			return 'rejected';
		}
		if (tool.group === 'meta' || (tool.group === 'shell' && tool.parallelSafe)) {
			return 'allowed-once';
		}
		const knobs = deepseekKnobs(this.accessMode);
		const decision = await this.evaluateAccessRequest(this.accessRequest(session, runId, profile, call, tool), knobs.approval === 'ask');
		const step = resolveApproval({
			policy: knobs.approval,
			effect: decision.effect,
			cancelled: decision.policySource === 'cancelled',
			savedAllow: decision.effect === 'allow' && decision.policySource === 'session',
			answererAvailable: true,
		});
		return step.outcome ?? 'rejected';
	}

	private async execute(session: ISessionState, runId: string, request: IVoltSendRequest, intent?: IIntent): Promise<void> {
		const item = this.catalog.find(c => c.ref === session.providerRef && c.enabled) ?? this.catalog.find(c => c.enabled);
		if (!item) {
			this.emit(session, runId, { type: 'error', message: 'No model or ACP agent is connected. Open Volt Settings to add one.' });
			this.finish(session, runId, 'fail');
			return;
		}

		const profile = this.profiles.find(p => p.id === item.profileId);
		if (!profile) {
			this.emit(session, runId, { type: 'error', message: 'Selected connection is missing.' });
			this.finish(session, runId, 'fail');
			return;
		}

		if (item.kind === 'agent') {
			if (!intent) {
				this.emit(session, runId, { type: 'error', message: 'Agent run is missing its harness lead.' });
				this.finish(session, runId, 'fail');
				return;
			}
			await this.executeAgent(session, runId, request, profile, item, intent);
			return;
		}
		await this.executeDeepseek(session, runId, request, profile, item);
	}

	/** Detected once per project root; only consulted when the user asked to see something running. */
	private workspaceRunPlan(root: URI | undefined): Promise<IRunPlan> {
		const key = root?.toString() ?? '';
		let plan = this.runPlans.get(key);
		if (!plan) {
			plan = loadWorkspaceRunPlan(this.fileService, this.workspace, root).catch(() => ({ kind: 'unknown' }));
			this.runPlans.set(key, plan);
		}
		return plan;
	}

	private environmentFacts(root: URI | undefined): IEnvironmentFacts {
		return {
			cwd: root?.fsPath,
			platform: isWindows ? 'windows' : isMacintosh ? 'macos' : 'linux',
			shell: isWindows ? 'cmd' : 'zsh',
			date: new Date().toISOString().slice(0, 10),
		};
	}

	private workspaceProjectInstructions(root: URI | undefined): Promise<string | undefined> {
		const key = root?.toString() ?? '';
		let instructions = this.projectInstructionsByRoot.get(key);
		if (!instructions) {
			instructions = loadProjectInstructions(this.fileService, root).catch(() => undefined);
			this.projectInstructionsByRoot.set(key, instructions);
		}
		return instructions;
	}

	private effectiveGroups(session: ISessionState, intent: IIntent): CapabilityGroup[] {
		return mergeGrantedGroups(intent.groups, session.extraGroups ?? [], session.mode);
	}

	private async contextPackInput(session: ISessionState, mode: VoltMode, intent: IIntent, tools?: IVoltTool[]): Promise<IContextPackInput> {
		const root = this.executionRoot(session);
		const prepared = session.prepared;
		const brief = prepared ? formatTaskBrief(prepared.intel) : undefined;
		const memory = session.harness?.memory.promptBlock(intent.signals.join(' ') || (prepared?.intel.goal ?? ''));
		const evidence = session.harness?.controller.evidence.digest();
		const workerRole = prepared?.orchestration.workers[0]?.role ?? 'general';
		const worker = prepared && (prepared.orchestration.mode !== 'single' || workerRole === 'research')
			? workerFraming(workerRole)
			: undefined;
		return {
			mode,
			intent: { ...intent, groups: this.effectiveGroups(session, intent) },
			runPlan: intent.wantsPreview ? await this.workspaceRunPlan(root) : undefined,
			environment: this.environmentFacts(root),
			projectInstructions: await this.workspaceProjectInstructions(root),
			toolSnippets: tools?.length ? toolSnippets(tools) : undefined,
			...(brief ? { taskBrief: brief } : {}),
			...(memory ? { memory } : {}),
			...(evidence ? { evidence } : {}),
			...(worker ? { workerFraming: worker } : {}),
			...(prepared?.intel.shape ? { shape: prepared.intel.shape } : {}),
			...(session.harness?.skills.promptBlock() ? { skills: session.harness.skills.promptBlock() } : {}),
			...(remainingBudget(session.harness) ? { remaining: remainingBudget(session.harness) } : {}),
		};
	}


	private async executeAgent(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, intent: IIntent): Promise<void> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown agent provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		const startAgent = () => this.startAgentSession(session, provider, profile, item, request.mode, request.options);
		// Another model from the same CLI is another agent session: restart it; the recap carries the thread over.
		const hasLiveAgent = () => !!session.agentHandle && session.agentProviderId === provider.id && session.agentRef === item.ref && (provider.isLive?.(session.agentHandle) ?? true);
		await session.agentStarting?.catch(() => undefined);

		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					if (!hasLiveAgent()) {
						await startAgent();
					}
					provider.setRunContext?.(session.agentHandle!, { sessionId: session.sessionId, runId, mode: request.mode });
					const recap = conversationRecap(session.messages.slice(session.agentSynced ?? 0, -1));
					const lead = [recap, buildAcpLead(await this.contextPackInput(session, request.mode, intent))].filter(Boolean).join('\n\n') || undefined;
					let assistant = '';
					let restart = false;
					for await (const event of provider.send(session.agentHandle!, { text: request.text, mode: request.mode, lead }, profile, session.cancel!.token)) {
						if (event.type === 'text.delta' && event.delta) {
							assistant += event.delta;
						}
						if (event.type === 'error' && attempt === 0 && !session.cancel?.token.isCancellationRequested && isAcpTurnRestartable(event.message)) {
							restart = true;
							continue;
						}
						if (event.type === 'run.end') {
							if (restart && event.reason === 'fail') {
								break;
							}
							if (assistant) {
								session.messages.push({ role: 'assistant', content: assistant });
							}
							session.agentSynced = session.messages.length;
							this.finish(session, runId, event.reason);
							return;
						}
						if (!restart) {
							this.emit(session, runId, event);
						}
					}
					if (restart) {
						this.emit(session, runId, { type: 'retry', attempt: 2, delayMs: 0, message: 'Agent process died. Restarting and retrying.' });
						await startAgent();
						continue;
					}
					if (assistant) {
						session.messages.push({ role: 'assistant', content: assistant });
					}
					session.agentSynced = session.messages.length;
					this.finish(session, runId, 'done');
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (attempt === 0 && !session.cancel?.token.isCancellationRequested && isAcpTurnRestartable(message)) {
						this.emit(session, runId, { type: 'retry', attempt: 2, delayMs: 0, message: 'Agent process died. Restarting and retrying.' });
						session.agentHandle = undefined;
						session.agentProviderId = undefined;
						continue;
					}
					throw err;
				}
			}
			this.emit(session, runId, { type: 'error', message: 'Agent process died.', retryable: true });
			this.finish(session, runId, 'fail');
		} catch (err) {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, 'fail');
		}
	}

	private finish(session: ISessionState, runId: string, reason: 'done' | 'abort' | 'fail'): void {
		if (session.activeRun?.runId !== runId) {
			return;
		}
		const status = session.activeRun.status;
		if (status !== 'running' && status !== 'queued' && status !== 'waiting') {
			return;
		}
		session.activeRun = { ...session.activeRun, status: reason === 'done' ? 'completed' : reason === 'abort' ? 'cancelled' : 'failed', endedAt: Date.now() };
		this.emit(session, runId, { type: 'lifecycle', phase: reason === 'done' ? 'completed' : reason === 'abort' ? 'cancelled' : 'failed' });
		this.emit(session, runId, { type: 'run.end', runId, reason });
		session.prepared = undefined;
		session.harness = undefined;
		if (session.deepseek) {
			session.deepseek.running = false;
		}
	}


	private routableCatalog(): IRoutableModel[] {
		return this.catalog.map(item => ({
			ref: item.ref,
			label: item.label,
			kind: item.kind,
			providerId: item.providerId,
			capabilities: item.capabilities,
			enabled: item.enabled,
			healthy: this.detections.get(item.profileId)?.available !== false,
		}));
	}

	private emit(session: ISessionState, runId: string, event: IVoltEvent): void {
		const envelope: IVoltEventEnvelope = {
			seq: ++session.seq,
			runId,
			sessionId: session.sessionId,
			timestamp: Date.now(),
			event,
		};
		session.harness?.store.append(envelope);
		for (const listener of this.listeners.get(session.sessionId) ?? []) {
			listener(envelope);
		}
		this._onDidEmit.fire(envelope);
		const baselines = this.editBaselines.observe(session.sessionId, event);
		if (baselines) {
			void baselines.then(found => {
				for (const baseline of found) {
					this.emit(session, runId, { type: 'file.change', uri: baseline.uri, kind: baseline.kind, ...(baseline.before !== undefined ? { before: baseline.before } : {}), existed: baseline.existed });
				}
			}, err => this.logService.trace('[volt] edit baseline failed', err));
		}
	}

	/**
	 * A path an agent edited, as a URI inside the session's checkout. Edits outside it (the
	 * agent's own plan files, home config) are not part of the change set the user reviews.
	 */
	private editableUri(sessionId: string, path: string): URI | undefined {
		const session = this.sessions.get(sessionId);
		const root = session ? this.executionRoot(session) : this.workspace.getWorkspace().folders[0]?.uri;
		if (!root || !path) {
			return undefined;
		}
		const uri = path.includes('://')
			? URI.parse(path)
			: posix.isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)
				? root.with({ path: URI.file(path).path })
				: joinPath(root, path.replace(/^\.\//, ''));
		return isEqualOrParent(uri, root) ? uri : undefined;
	}

	private onAcpFileWrite(write: IAcpFileWrite): void {
		const session = this.sessions.get(write.sessionId);
		if (!session) {
			return;
		}
		const existed = write.before !== undefined;
		this.emit(session, write.runId || session.activeRun?.runId || '', {
			type: 'file.change',
			uri: write.uri,
			kind: existed ? 'edit' : 'create',
			...(existed ? { before: write.before } : {}),
			existed,
		});
	}

	private defaultRef(mode: VoltMode): string | undefined {
		const hint = modePolicy(mode).routingHint;
		const slot: keyof IVoltTaskModels = hint === 'fast' ? 'ask' : hint === 'reasoning' ? 'plan' : 'agent';
		return this.taskModels[slot] ?? this.taskModels.agent ?? this.catalog.find(c => c.enabled)?.ref;
	}

	private registerProviders(): void {
		for (const provider of [
			createOpenAIProvider(this.requestService),
			createOpenRouterProvider(this.requestService),
			createCompatProvider(this.requestService),
			createLMStudioProvider(this.requestService),
			new AnthropicProvider(this.requestService),
			new GeminiProvider(this.requestService),
			new OllamaProvider(this.requestService),
		]) {
			this.modelProviders.set(provider.id, provider);
		}
		for (const def of CLI_AGENT_DEFINITIONS) {
			const provider = new AcpAgentProvider(def.id, def.label, def.commands[0], [...def.acpArgs], this.stdio, this.workspace, this.fileService, this.logService, this.hostTools);
			provider.setAccessGate(this.accessGate);
			provider.setFileWriteObserver(write => this.onAcpFileWrite(write));
			this.agentProviders.set(provider.id, provider);
		}
		const generic = new AcpAgentProvider('acp-generic', 'Agent', 'agent', ['acp'], this.stdio, this.workspace, this.fileService, this.logService, this.hostTools);
		generic.setAccessGate(this.accessGate);
		generic.setFileWriteObserver(write => this.onAcpFileWrite(write));
		this.agentProviders.set(generic.id, generic);
	}

	private loadState(): void {
		this.profiles = this.readJson(VOLT_PROFILES_STORAGE_KEY, []);
		if (!this.profiles.length) {
			this.profiles = this.seedProfiles();
			this.saveProfiles();
		} else {
			let renamed = false;
			this.profiles = this.profiles.map(profile => {
				if (profile.kind !== 'agent') {
					return profile;
				}
				const label = displayProviderLabel(profile.label, profile.providerId);
				if (label === profile.label) {
					return profile;
				}
				renamed = true;
				return { ...profile, label };
			});
			if (renamed) {
				this.saveProfiles();
			}
		}
		this.ensureCliProfiles();
		this.enabled = new Set(this.readJson<string[]>(VOLT_ENABLED_MODELS_STORAGE_KEY, []));
		this.taskModels = this.readJson(VOLT_TASK_MODELS_STORAGE_KEY, {});
		this.modeProfiles = this.readJson(VOLT_MODE_PROFILES_STORAGE_KEY, {});
		this.modelOptions = this.readJson(VOLT_MODEL_OPTIONS_STORAGE_KEY, {});
		this.accessMode = normalizeVoltAccessMode(this.storageService.get(VOLT_ACCESS_MODE_STORAGE_KEY, StorageScope.APPLICATION));
		this.projectRules = this.readWorkspaceJson(VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, []);
		this.savedRules = this.readWorkspaceJson(VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, []);
		this.recompilePolicy();
		const revision = this.storageService.getNumber(VOLT_CATALOG_REVISION_STORAGE_KEY, StorageScope.APPLICATION) ?? 0;
		const cached = revision >= VOLT_CATALOG_REVISION ? this.readJson<IVoltCatalogItem[]>(VOLT_CATALOG_STORAGE_KEY, []) : [];
		this.catalog = Array.isArray(cached) ? cached : [];
		if (revision < VOLT_CATALOG_REVISION && this.enabled.size) {
			this.enabled = new Set();
			this.storageService.store(VOLT_ENABLED_MODELS_STORAGE_KEY, '[]', StorageScope.APPLICATION, StorageTarget.USER);
		}
		this.activeCatalogRef = this.storageService.get(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
		this.hydrateAgentModelsFromCatalog();
	}

	private persistCatalog(): void {
		this.storageService.store(VOLT_CATALOG_STORAGE_KEY, JSON.stringify(this.catalog), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(VOLT_CATALOG_REVISION_STORAGE_KEY, VOLT_CATALOG_REVISION, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** Reuses the last catalog so a restart does not wait on another CLI spawn. */
	private hydrateAgentModelsFromCatalog(): void {
		const byProfile = new Map<string, IModelInfo[]>();
		for (const item of this.catalog) {
			if (item.kind !== 'agent') {
				continue;
			}
			const models = byProfile.get(item.profileId) ?? [];
			models.push({
				id: item.id,
				label: item.label,
				capabilities: item.capabilities,
				...(item.optionDescriptors ? { optionDescriptors: item.optionDescriptors } : {}),
				...(item.detail ? { detail: item.detail } : {}),
				...(item.description ? { description: item.description } : {}),
				...(item.contextLabel ? { contextLabel: item.contextLabel } : {}),
			});
			byProfile.set(item.profileId, models);
		}
		for (const [profileId, models] of byProfile) {
			if (models.some(model => !!(model.optionDescriptors?.length || model.description || model.contextLabel))) {
				this.agentModels.set(profileId, models);
			}
		}
	}

	/**
	 * Every known CLI agent and on-device runtime gets a profile so the Providers page can report
	 * on it even when nothing is installed. Existing profiles win, so a user edited command or
	 * endpoint is never overwritten.
	 */
	private ensureCliProfiles(): void {
		if ((this.storageService.getNumber(VOLT_SEED_VERSION_STORAGE_KEY, StorageScope.APPLICATION) ?? 0) >= CLI_SEED_VERSION) {
			return;
		}
		const missing = (providerId: string) => !this.profiles.some(profile => profile.providerId === providerId);
		const added: IProviderProfile[] = CLI_AGENT_DEFINITIONS
			.filter(def => missing(def.id))
			.map(def => ({
				id: `seed-${def.id}`,
				label: def.label,
				kind: 'agent',
				providerId: def.id,
				enabled: true,
				transport: 'stdio',
				command: def.commands[0],
				args: [...def.acpArgs],
				authKind: 'cli',
				hasSecret: false,
			}) satisfies IProviderProfile);
		added.push(...this.seedProfiles().filter(profile => missing(profile.providerId)));
		if (added.length) {
			this.profiles = [...this.profiles, ...added];
			this.saveProfiles();
		}
		this.storageService.store(VOLT_SEED_VERSION_STORAGE_KEY, CLI_SEED_VERSION, StorageScope.APPLICATION, StorageTarget.USER);
	}

	/** On-device runtimes, which the picker collects under a single "Local" tab. */
	private seedProfiles(): IProviderProfile[] {
		return [
			{
				id: 'seed-ollama',
				label: 'Ollama',
				kind: 'model',
				providerId: 'ollama',
				enabled: true,
				transport: 'http',
				apiStyle: 'ollama',
				endpoint: { baseURL: 'http://127.0.0.1:11434' },
				authKind: 'none',
				hasSecret: false,
			},
			{
				id: 'seed-lmstudio',
				label: 'LM Studio',
				kind: 'model',
				providerId: 'lmstudio',
				enabled: true,
				transport: 'http',
				apiStyle: 'openai-compat',
				endpoint: { baseURL: 'http://127.0.0.1:1234/v1' },
				authKind: 'none',
				hasSecret: false,
			},
		];
	}

	private saveProfiles(): void {
		this.storageService.store(VOLT_PROFILES_STORAGE_KEY, JSON.stringify(this.profiles), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private readJson<T>(key: string, fallback: T): T {
		return this.parseJson(this.storageService.get(key, StorageScope.APPLICATION), fallback);
	}

	private readWorkspaceJson<T>(key: string, fallback: T): T {
		return this.parseJson(this.storageService.get(key, StorageScope.WORKSPACE) ?? this.storageService.get(key, StorageScope.APPLICATION), fallback);
	}

	private parseJson<T>(raw: string | undefined, fallback: T): T {
		if (!raw) {
			return fallback;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			return fallback;
		}
	}

	private evaluateAccessRequest(request: IAccessRequest, settleAsk = true): IAccessDecision | Promise<IAccessDecision> {
		const session = this.sessions.get(request.sessionId);
		const mode = session?.mode ?? (request.sessionId === TAB_PREDICTION_SESSION_ID ? 'ask' : 'agent');
		// In Plan and Ask the agent's plan approval (or question) is the user's call, whatever the
		// access mode: approving it is what lets the agent start changing files.
		if (request.action === 'question' && (mode === 'plan' || mode === 'ask')) {
			const decision: IAccessDecision = { requestId: request.id, effect: 'ask', scope: 'once', policySource: request.reason };
			return settleAsk ? this.askAccess(request, decision) : decision;
		}
		const key = `${mode}\0${memoKey(request.action, request.resource.value)}`;
		const cached = this.policyMemo.get(key);
		if (cached && cached.effect !== 'ask') {
			const decision = { ...cached, requestId: request.id };
			this.recordReceipt(request, decision, decision.effect === 'allow' ? 'allow' : 'denied');
			if (decision.effect === 'deny') {
				this.emitAccess(request, { type: 'access.blocked', request, policySource: decision.policySource ?? 'policy' });
			}
			return decision;
		}
		const policy: ICompiledPolicy = {
			...this.compiledPolicy,
			overlay: compilePolicy({ overlay: modeOverlay(mode) }).overlay,
		};
		const decision = evaluateAccess(request, policy, {
			accessMode: this.accessMode,
			delegateMedium: accessBridgeFor(request.providerId).delegatesMediumReview === true && this.accessMode === 'auto',
		});
		if (decision.effect === 'allow') {
			this.policyMemo.set(key, decision);
			this.recordReceipt(request, decision, 'allow');
			return decision;
		}
		if (decision.effect === 'deny') {
			this.policyMemo.set(key, decision);
			this.recordReceipt(request, decision, 'denied');
			this.emitAccess(request, { type: 'access.blocked', request, policySource: decision.policySource ?? 'policy' });
			return decision;
		}
		if (!settleAsk) {
			return decision;
		}
		return this.askAccess(request, decision);
	}

	private askAccess(request: IAccessRequest, decision: IAccessDecision): Promise<IAccessDecision> {
		const session = this.sessions.get(request.sessionId);
		if (session?.activeRun) {
			session.activeRun = { ...session.activeRun, status: 'waiting' };
		}
		this.emitAccess(request, { type: 'access.ask', request });
		return new Promise<IAccessDecision>(resolve => {
			this.pendingApprovals.set(request.id, { resolve, request: { ...request, reason: decision.policySource ?? request.reason } });
		});
	}

	private emitAccess(request: IAccessRequest, event: IVoltEvent): void {
		const session = this.sessions.get(request.sessionId);
		if (session) {
			this.emit(session, request.runId || session.activeRun?.runId || request.id, event);
		}
	}

	private recordReceipt(request: IAccessRequest, decision: IAccessDecision, result: IExecutionReceipt['decision']): void {
		this.receipts.push({
			executionId: generateUuid(),
			sessionId: request.sessionId,
			runId: request.runId,
			providerId: request.providerId,
			agentId: request.agentId,
			action: request.action,
			resource: request.resource.value,
			decision: result,
			policySource: decision.policySource ?? 'policy',
			risk: request.risk,
			startedAt: request.createdAt,
			completedAt: Date.now(),
		});
		if (this.receipts.length > RECEIPT_LIMIT) {
			this.receipts = this.receipts.slice(-RECEIPT_LIMIT);
		}
	}

	private denyPending(sessionId: string, reason: 'cancelled' | 'follow-up' = 'cancelled'): void {
		for (const [id, pending] of this.pendingApprovals) {
			if (pending.request.sessionId !== sessionId) {
				continue;
			}
			this.pendingApprovals.delete(id);
			const decision: IAccessDecision = { requestId: id, effect: 'deny', scope: 'once', policySource: reason === 'follow-up' ? 'session' : 'cancelled' };
			const session = this.sessions.get(sessionId);
			if (session?.activeRun) {
				session.activeRun = { ...session.activeRun, status: 'running' };
				this.emit(session, pending.request.runId, { type: 'access.resolved', requestId: id, effect: 'deny', scope: 'once' });
			}
			pending.resolve(decision);
		}
	}

	private recompilePolicy(): void {
		this.compiledPolicy = compilePolicy({
			system: SYSTEM_HARD_DENY,
			preset: presetRules(this.accessMode),
			project: this.projectRules,
			session: this.savedRules,
		});
		this.policyMemo.clear();
	}

	private async pushPolicyToAgents(): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.agentHandle && session.agentProviderId) {
				await this.agentProviders.get(session.agentProviderId)?.applyAccessPolicy?.(session.agentHandle, this.compiledPolicy);
			}
		}
	}

	private scheduleSaveAccess(): void {
		if (this.saveAccessHandle) {
			clearTimeout(this.saveAccessHandle);
		}
		this.saveAccessHandle = setTimeout(() => {
			this.saveAccessHandle = undefined;
			this.storageService.store(VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, JSON.stringify(this.projectRules), StorageScope.WORKSPACE, StorageTarget.USER);
			this.storageService.store(VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, JSON.stringify(this.savedRules), StorageScope.WORKSPACE, StorageTarget.USER);
		}, 250);
	}
}

function remainingBudget(harness: IRunHarness | undefined): { steps: number; tools: number; timeMs: number } | undefined {
	if (!harness) {
		return undefined;
	}
	const snap = harness.governor.snapshot();
	if (snap.cap.steps >= 1e12 && snap.cap.tools >= 1e12) {
		return undefined;
	}
	return { steps: snap.remaining.steps, tools: snap.remaining.tools, timeMs: snap.remaining.timeMs };
}

function abortSignalFrom(token: CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
		return controller.signal;
	}
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

/**
 * Turns an ACP agent has not seen (the user was on another model), newest kept when long, so
 * switching models mid-conversation keeps the thread instead of starting over.
 */
function conversationRecap(messages: readonly { role: string; content: string }[]): string | undefined {
	const turns = messages.filter(message => message.content.trim() && message.role !== 'system');
	if (!turns.length) {
		return undefined;
	}
	const lines: string[] = [];
	let used = 0;
	for (let i = turns.length - 1; i >= 0 && used < RECAP_CHARS; i--) {
		const text = turns[i].content.trim();
		const clipped = text.length > 4_000 ? `${text.slice(0, 4_000)} [...]` : text;
		lines.unshift(`${turns[i].role === 'assistant' ? 'Assistant' : 'User'}: ${clipped}`);
		used += clipped.length;
	}
	return [
		'<conversation_so_far>',
		'This conversation started with another model. Here is what was said before this message; continue from it.',
		...lines,
		'</conversation_so_far>',
	].join('\n');
}

/** `src/a.ts` for display, falling back to the absolute path outside the root. */
function relativeToRoot(root: URI, uri: URI): string {
	return relativePath(root, uri) ?? uri.fsPath;
}

const EFFORT_ORDER: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The option value nearest to `level` that the model actually offers, never above it when avoidable. */
function closestLevel(level: string, values: readonly string[]): string | undefined {
	if (!values.length) {
		return undefined;
	}
	if (values.includes(level)) {
		return level;
	}
	const rank = EFFORT_ORDER.indexOf(level);
	const ranked = values.map(value => ({ value, rank: EFFORT_ORDER.indexOf(value) })).filter(entry => entry.rank >= 0).sort((a, b) => a.rank - b.rank);
	const below = ranked.filter(entry => entry.rank <= rank);
	return (below.at(-1) ?? ranked[0])?.value ?? values[0];
}

function asToolEvent(event: { type: string;[key: string]: unknown }): IVoltEvent | undefined {
	if (event.type === 'plan' || event.type === 'file.change' || event.type === 'error') {
		return event as IVoltEvent;
	}
	return undefined;
}

registerSingleton(IAgentRuntimeService, AgentRuntimeService, InstantiationType.Delayed);
registerSingleton(IVoltStdioService, NullVoltStdioService, InstantiationType.Delayed);
