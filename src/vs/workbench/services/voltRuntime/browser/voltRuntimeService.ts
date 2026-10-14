/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
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
import { buildTitlePrompt, sanitizeTitle, titleCommandFor } from '../common/history/titleGeneration.js';
import { normalizeCursorModelId } from '../common/harness/cursorQuota.js';
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
import { IAgentDetectResult, IAgentMessage, IAgentProvider, IAgentSessionHandle, IAgentStartRequest, IDetectResult, IModelImage, IModelInfo, IModelMessage, IModelProvider, IVoltCatalogItem, IVoltProviderStatus, VoltProviderState } from '../common/providers.js';
import { resolveTabModel } from '../common/models/modelAccess.js';
import { IAgentRuntimeService, IVoltMcpServerStatus, IVoltTaskModels } from '../common/runtime.js';
import { IVoltImageAttachment, IVoltSendRequest, IVoltSession } from '../common/session.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, IVoltHostToolApproval, IVoltHostToolInvocation, IVoltHostToolService } from '../common/hostTools.js';
import { AgentQuestionDraft, answeredQuestions, IAgentQuestionRequest, IAgentQuestionResponse } from '../common/questions.js';
import { AcpAgentProvider, IAcpFileWrite, IAcpSupervisionOptions } from './agents/acpProvider.js';
import { AcpLoopDetector } from '../common/harness/acpLoopDetector.js';
import { LOOP_NOTICE_TITLE } from '../common/harness/supervisor.js';
import { DeepseekDirective, IDeepseekStep } from '../common/deepseek/loop.js';
import { EditBaselineTracker } from './editBaselines.js';
import './host/hostToolService.js';
import { clearClaudeModelCache } from './agents/claudeCatalog.js';
import { CLI_AGENT_DEFINITIONS, cliAgentDefinition, detectCliAgent } from './agents/cliAgents.js';
import { NullVoltStdioService } from './host/nullStdioService.js';
import { loadProjectCheckFiles, loadWorkspaceRunPlan } from './host/workspaceRunPlan.js';
import { classifyIntent, IIntent, mergeGrantedGroups } from '../common/harness/intent.js';
import { buildAcpLead, IContextPackInput, IEnvironmentFacts } from '../common/harness/contextPack.js';
import { INativeLoopMessage } from '../common/harness/nativeLoop.js';
import { nativeToModelMessages } from '../common/harness/providerMessages.js';
import { runToolBatch } from '../common/harness/toolRuntime.js';
import { estimateTokens, totalTokens } from '../common/harness/contextEngine.js';
import { FileLedger } from '../common/harness/fileLedger.js';
import { alwaysRules, findInstruction, instructionsIndex, rulesForPath } from '../common/harness/instructions.js';
import { applyCompaction, COMPACTION_SYSTEM, compactionBoundary, compactionRequest, DEFAULT_COMPACTION, effectiveWindow, mechanicalSummary, pruneImages, serializeForSummary, shouldCompact } from '../common/harness/nativeCompaction.js';
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
import { CapabilityGroup, VoltLane } from '../common/harness/lanes.js';
import { applyHumanAction, IHumanAction } from '../common/harness/humanLoop.js';
import { EvalLedger, evalSampleFromMetrics } from '../common/harness/eval.js';
import { formatRunMetrics, IRunMetrics, RunMetrics } from '../common/harness/runMetrics.js';
import { decideContinuation, detectProjectChecks, ICheckReport, IProjectChecks, isSameCommand, ITodoEntry, mayMutateWorkspace, parseCheckOutput, regressionVerdict } from '../common/harness/verification.js';
import { AgentPool, ISpareRequest } from './agentPool.js';
import { RunTraceJournal } from './history/runTraceJournal.js';
import { isAcpTurnRestartable } from '../common/harness/sessionRetry.js';
import { TaskLifecycle } from '../common/harness/lifecycle.js';
import { IToolCall, IToolContext, IVoltTool, toolSchemas } from '../common/tools/tool.js';
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

/** Idle chat agents kept warm per window, most recently used first. */
const MAX_IDLE_AGENTS = 3;
/** An idle chat agent older than this is stopped even within the cap. */
const IDLE_AGENT_TTL_MS = 15 * 60_000;
const IDLE_AGENT_CHECK_MS = 60_000;
/** Warm spare agents for new chats (see AgentPool), across all models and folders. */
const MAX_SPARE_AGENTS = 2;
const SPARE_AGENT_TTL_MS = 10 * 60_000;
/** How long a new run waits for a cancelled one to let go of its agent session. */
const SETTLE_WAIT_AGENT_MS = 3_000;
const SETTLE_WAIT_NATIVE_MS = 1_500;
/** A deferred health check runs this long after the last run ends, not on top of a follow-up. */
const HEALTH_AFTER_RUN_MS = 15_000;
/** Project checks Volt runs itself (the regression gate) are stopped after this. */
const CHECK_TIMEOUT_MS = 120_000;
/** A baseline slower than this is not started again for that folder; the gate needs a fast suite. */
const SLOW_CHECK_MS = 45_000;
const CHECK_INLINE_CHARS = 40_000;
const RUN_METRICS_KEPT = 200;

/**
 * ACP run supervision: WP2's supervisor with a loop detector that also uses the native loop's
 * near-duplicate and no-progress signals. The provider spreads these options into every prompt
 * turn's supervisor, so the getter hands each turn its own detector.
 */
const ACP_SUPERVISION: IAcpSupervisionOptions = {
	supervisor: {
		get detector() {
			return new AcpLoopDetector();
		},
	},
};
/** Paths whose changes do not invalidate a cached check result. */
const CHECK_NOISE = /\/(?:node_modules|\.git|coverage|\.nyc_output|dist|build|out|target|__pycache__|\.pytest_cache|\.next|\.turbo|\.cache)(?:\/|$)/;

function isRunActive(session: ISessionState): boolean {
	const status = session.activeRun?.status;
	return status === 'running' || status === 'queued' || status === 'waiting';
}

/**
 * One run, from send to settle. The session points at its current run; an engine (native loop or
 * ACP turn) holds its own run and checks it is still current before touching session state, so a
 * run that was cancelled or superseded can finish unwinding without writing into the next one.
 */
interface IRunState {
	readonly runId: string;
	readonly mode: VoltMode;
	readonly engine: 'native' | 'agent';
	readonly cancel: CancellationTokenSource;
	readonly metrics: RunMetrics;
	/** Completes once the engine has stopped (its loop or prompt returned). */
	readonly settled: DeferredPromise<void>;
	/** run.end was emitted; later engine events are dropped (file changes excepted). */
	ended: boolean;
	lane?: VoltLane;
	/** Native: the transcript this run appends to. Detached from the session when the run is cancelled. */
	transcript?: INativeLoopMessage[];
	/** The latest to-do list the engine reported. */
	plan?: readonly ITodoEntry[];
	/** Engine event count at the last workspace change (0: none yet), and at the last passing run of the exact test command. */
	lastMutation: number;
	lastTestPass: number;
	events: number;
	/** Tool calls in flight: what is known about each so far (ACP agents fill it in over several updates). */
	readonly calls: Map<string, { kind?: string; input: string; title?: string; classified?: boolean; test?: boolean }>;
	quality?: IQualityRun;
	/** The agent came from the pool or a cold start: a spare like it helps the next new chat. */
	spare?: ISpareRequest;
	/** Reasons this run was already sent back for (each at most once). */
	readonly continued: { regression: boolean; todos: boolean };
	regressed?: boolean;
}

type AgentTurnResult =
	| { readonly kind: 'end'; readonly reason: 'done' | 'abort' | 'fail'; readonly assistant: string }
	| { readonly kind: 'restart' }
	| { readonly kind: 'stale' };

/** The regression gate's state for one run. */
interface IQualityRun {
	readonly root: URI;
	readonly rootKey: string;
	readonly command: string;
	/** Project check result before the run's changes; undefined when unavailable. */
	baseline: Promise<ICheckReport | undefined>;
	/** The baseline exec still running, so the run's first change can stop it. */
	baselineExecId?: string;
	/** The run changed the workspace (or ran a command that may have) before the baseline finished. */
	tainted: boolean;
	/** The agent's own run of the exact test command before any change, used when Volt's baseline was stopped. */
	agentBaseline?: ICheckReport;
}

interface ISessionState extends IVoltSession {
	seq: number;
	agentHandle?: IAgentSessionHandle;
	agentProviderId?: string;
	/** The current (or last) run. */
	run?: IRunState;
	/** Extra capability groups granted mid-session by `request_capabilities`. */
	extraGroups?: CapabilityGroup[];
	/** In-process DeepSeek loop for native models. The open workspace folder is the cwd. */
	deepseek?: INativeState;
	/** How many of `messages` the current ACP agent session has seen. */
	agentSynced?: number;
	/**
	 * An agent session that joined the chat late (a model handoff, a replaced process): it saw the
	 * conversation as a recap, so the title it names would come from the recap, not the chat.
	 */
	agentJoinedLate?: IAgentSessionHandle;
	/** Catalog ref the live agent session was started for. */
	agentRef?: string;
	/** Folder the live agent session was started in. A chat moved to another project needs a new one. */
	agentCwd?: string;
	/** Last time the live agent started or finished a run; idle agents are let go oldest first. */
	agentUsedAt?: number;
	/** One notice after a checkout is created or restored. */
	announceWorktree?: boolean;
	/** A title was requested from the first message; set once it landed, so the agent's own titles stop replacing it. */
	titleState?: 'pending' | 'done';
}

/** Native-model conversation state that outlives a single run. */
interface INativeState {
	messages: INativeLoopMessage[];
	inbox: string[];
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
/** Recap of turns an agent has not seen, in estimated tokens (a few thousand, not a second prompt). */
const RECAP_TOKENS = 4_000;
const RECAP_MESSAGE_CHARS = 3_000;

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
	private readonly pendingQuestions = new Map<string, { request: IAgentQuestionRequest; waiters: Set<(response: IAgentQuestionResponse) => void> }>();
	/** Answers no agent call was waiting for yet (an MCP call between long-polls); collected by the next wait. */
	private readonly unclaimedAnswers = new Map<string, IAgentQuestionResponse>();
	private readonly _onDidChangeQuestions = this._register(new Emitter<string>());
	readonly onDidChangeQuestions: Event<string> = this._onDidChangeQuestions.event;
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
	private readonly traces: RunTraceJournal;
	private readonly agentPool: AgentPool;
	/** Spare agents start under an alias session id; this maps it to the chat that adopted the spare. */
	private readonly sessionAliases = new Map<string, string>();
	private readonly runMetrics: IRunMetrics[] = [];
	/** A health check came due during a run and waits for the runs to end. */
	private healthDeferred = false;
	private healthAfterRun: ReturnType<typeof setTimeout> | undefined;
	private readonly projectChecks = new Map<string, { readonly at: number; readonly value: Promise<IProjectChecks> }>();
	/** Last known result of the project's test command per folder, valid until a file there changes. */
	private readonly checkCache = new Map<string, ICheckReport>();
	private readonly slowChecks = new Set<string>();

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
		this.traces = this._register(new RunTraceJournal(joinPath(environmentService.userRoamingDataHome, 'voltTraces'), fileService, logService));
		this.agentPool = this._register(new AgentPool({
			maxSpares: MAX_SPARE_AGENTS,
			ttlMs: SPARE_AGENT_TTL_MS,
			newAlias: () => `volt-pool-${generateUuid()}`,
			onError: err => this.logService.trace('[volt] spare agent failed', err),
		}));
		this.editBaselines = new EditBaselineTracker(fileService, (sessionId, path) => this.editableUri(sessionId, path));
		this.registerProviders();
		this.hostTools.setApprover({ approve: (request, token) => this.approveHostTool(request, token) });
		this._register(fileService.onDidFilesChange(e => this.invalidateChecks([...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted])));
		this._register(toDisposable(() => {
			if (this.healthAfterRun !== undefined) {
				clearTimeout(this.healthAfterRun);
			}
		}));
		this.hostTools.setQuestionHandler({
			ask: (sessionId, draft) => this.openQuestions(this.chatFor(sessionId), undefined, draft).id,
			wait: (requestId, ms, token) => this.waitForAnswers(requestId, ms, token),
		});
		this._register(this.hostTools.onDidInvokeTool(call => this.onHostToolResult(call)));
		this.loadState();
		this.watchSharedModelChoice();
		void this.refreshCatalog();
		void this.refreshProviders();
		this.scheduleHealthChecks();
		this._register(toDisposable(() => void this.disposeTabAgent()));
	}

	/** Each chat keeps its agent process warm for follow-ups; this keeps that from growing without bound. */
	private readonly agentReaper = this._register(new RunOnceScheduler(() => this.releaseIdleAgents(), IDLE_AGENT_CHECK_MS));

	private releaseIdleAgents(): void {
		const now = Date.now();
		const idle = [...this.sessions.values()]
			.filter(session => session.agentHandle && !isRunActive(session))
			.sort((a, b) => (b.agentUsedAt ?? 0) - (a.agentUsedAt ?? 0));
		let kept = 0;
		for (const session of idle) {
			if (kept < MAX_IDLE_AGENTS && now - (session.agentUsedAt ?? 0) < IDLE_AGENT_TTL_MS) {
				kept++;
				continue;
			}
			this.releaseAgent(session);
		}
		if (kept) {
			this.agentReaper.schedule();
		}
	}

	/** Stops a chat's idle agent. Its next prompt starts a new one and recaps the conversation. */
	private releaseAgent(session: ISessionState): void {
		const handle = session.agentHandle;
		const provider = session.agentProviderId ? this.agentProviders.get(session.agentProviderId) : undefined;
		session.agentHandle = undefined;
		session.agentProviderId = undefined;
		session.agentRef = undefined;
		session.agentCwd = undefined;
		session.agentSynced = 0;
		this.forgetAliases(session.sessionId);
		if (handle) {
			void provider?.dispose(handle).catch(err => this.logService.trace('[volt] releasing idle agent failed', err));
		}
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
			if (!entry || session.deepseek?.messages.length) {
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

	supportsCommand(sessionId: string, name: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session?.agentHandle || !session.agentProviderId) {
			return false;
		}
		return this.agentProviders.get(session.agentProviderId)?.supportsCommand?.(session.agentHandle, name) ?? false;
	}

	canSteer(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return !!session && (this.nativeLive(session) || this.agentSteerable(session));
	}

	/** A live ACP turn whose agent takes `_session/steering`. */
	private agentSteerable(session: ISessionState): boolean {
		if (!session.run || session.run.ended || session.run.engine !== 'agent' || !session.agentHandle || !session.agentProviderId) {
			return false;
		}
		return this.agentProviders.get(session.agentProviderId)?.canSteer?.(session.agentHandle) ?? false;
	}

	async steerAsync(sessionId: string, text: string): Promise<boolean> {
		if (this.steer(sessionId, text)) {
			return true;
		}
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (!session || !run || !this.agentSteerable(session)) {
			return false;
		}
		const provider = this.agentProviders.get(session.agentProviderId!);
		const delivered = await provider?.steer?.(session.agentHandle!, text).catch(() => false) ?? false;
		if (delivered && this.isCurrent(session, run)) {
			session.messages.push({ role: 'user', content: text, steer: true });
			// The agent saw it in this turn; the next recap must not send it again.
			session.agentSynced = Math.max(session.agentSynced ?? 0, session.messages.length);
			this.emit(session, run.runId, { type: 'human', action: 'redirect', detail: text });
		}
		return delivered;
	}

	steer(sessionId: string, text: string): boolean {
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (!session || !run || !this.nativeLive(session)) {
			return false;
		}
		this.denyPending(sessionId, 'follow-up');
		session.messages.push({ role: 'user', content: text, steer: true });
		this.nativeState(session).inbox.push(text);
		this.emit(session, run.runId, { type: 'human', action: 'redirect', detail: text });
		this.emit(session, run.runId, { type: 'inbox', claimed: 0 });
		return true;
	}

	async send(sessionId: string, request: IVoltSendRequest): Promise<string> {
		const sendAt = Date.now();
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.mode = request.mode;
		session.providerRef = request.providerRef ?? session.providerRef ?? this.defaultRef(request.mode);
		// A native run reads follow-ups between steps; there is nothing to restart.
		if (session.run && this.steer(sessionId, request.text)) {
			return session.run.runId;
		}
		// One run per chat: a live run is cancelled through the same path as Stop. It keeps
		// unwinding in the background, but can no longer write into this one.
		const previous = session.run;
		if (previous && !previous.ended) {
			this.cancelRun(session, previous);
		}
		session.messages.push({ role: 'user', content: request.text });
		const catalogItem = this.catalog.find(item => item.ref === session.providerRef && item.enabled) ?? this.catalog.find(item => item.enabled);
		if (!session.titleState && session.messages.filter(message => message.role === 'user').length === 1) {
			session.titleState = 'pending';
			const pinned = this.taskModels.title ? this.catalog.find(item => item.ref === this.taskModels.title && item.enabled) : undefined;
			void this.generateTitle(session, request, pinned ?? catalogItem, !!pinned);
		}
		const engine = catalogItem?.kind === 'agent' ? 'agent' : 'native';
		const run = this.beginRun(session, request.mode, engine, sendAt);
		try {
			await this.prepareWorktree(session, request);
		} catch (err) {
			this.emit(session, run.runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, run, 'fail');
			run.settled.complete();
			return run.runId;
		}
		if (!this.isCurrent(session, run)) {
			run.settled.complete();
			return run.runId;
		}
		this.noteWorktree(session, run.runId);
		// Only what the ACP lead and the transcript read: the lane, its signals, the request shape.
		const root = this.executionRoot(session);
		const intent = classifyIntent(request.text, request.mode, {
			hasWorkspace: !!root,
			priorLane: session.lastLane,
			attachments: attachmentNames(request),
		});
		session.lastLane = intent.lane;
		run.lane = intent.lane;
		if (session.activeRun?.runId === run.runId) {
			session.activeRun = { ...session.activeRun, lane: intent.lane };
		}
		if (engine === 'agent') {
			this.emit(session, run.runId, { type: 'lifecycle', phase: 'planning' });
		}
		this.emit(session, run.runId, { type: 'lane', lane: intent.lane, signals: intent.signals, wantsPreview: intent.wantsPreview, wantsWeb: intent.wantsWeb });
		this.emit(session, run.runId, { type: 'lifecycle', phase: 'running' });
		run.metrics.mark('prepared');
		this.startQualityGate(session, run);
		void this.execute(session, run, request, intent, previous)
			.catch(err => {
				this.emit(session, run.runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
				this.finish(session, run, 'fail');
			})
			.finally(() => run.settled.complete());
		return run.runId;
	}

	/**
	 * Names the chat from its first message while the agent works on it: one small call with no
	 * tools. It runs on the text generation model when one is pinned in Settings, as that model
	 * with its saved options; otherwise on the chat's own provider (Haiku for Claude, low effort
	 * for Codex, the native model at its lowest reasoning). Failures keep the first-line title.
	 */
	private async generateTitle(session: ISessionState, request: IVoltSendRequest, item: IVoltCatalogItem | undefined, pinned: boolean): Promise<void> {
		const prompt = buildTitlePrompt(request.text, attachmentNames(request));
		let raw: string | undefined;
		try {
			raw = await this.generateWith(item, pinned, prompt, TITLE_TIMEOUT_MS, 2000);
		} catch (err) {
			this.logService.trace('[volt runtime] title generation failed', err);
		}
		const title = sanitizeTitle(raw);
		if (!title) {
			session.titleState = undefined;
			return;
		}
		session.titleState = 'done';
		await this.history.setAgentTitle(session.sessionId, title);
	}

	/** Runs `prompt` once, with no tools, on `item`: a native model streams it, a CLI agent answers in print mode. */
	private async generateWith(item: IVoltCatalogItem | undefined, pinned: boolean, prompt: string, timeoutMs: number, maxChars: number): Promise<string | undefined> {
		const profile = item ? this.profiles.find(p => p.id === item.profileId) : undefined;
		if (item?.kind === 'model' && profile) {
			return this.generateTitleWithModel(item, profile, prompt, pinned, timeoutMs, Math.max(400, Math.ceil(maxChars / 2)));
		}
		if (!profile) {
			return undefined;
		}
		const definition = cliAgentDefinition(profile.providerId);
		const command = profile.command && definition?.commands.includes(profile.command) ? profile.command : undefined;
		const argv = titleCommandFor(profile.providerId, command, prompt, pinned && item ? titleAgentModel(item) : undefined);
		if (!argv) {
			return undefined;
		}
		const result = await this.stdio.exec({
			id: `title-${generateUuid().slice(0, 8)}`,
			command: argv.map(quoteShellArg).join(' '),
			// Away from the project, so the CLI loads no project instructions for a one-liner.
			cwd: isWindows ? undefined : '/tmp',
			timeoutMs,
			inlineChars: maxChars,
		});
		return result.exitCode === 0 ? result.stdout : undefined;
	}

	async generateText(prompt: string, options?: { readonly sessionId?: string; readonly timeoutMs?: number }): Promise<string | undefined> {
		const pinned = this.taskModels.title ? this.catalog.find(item => item.ref === this.taskModels.title && item.enabled) : undefined;
		const chatRef = options?.sessionId ? this.sessions.get(options.sessionId)?.providerRef : undefined;
		const item = pinned
			?? (chatRef ? this.catalog.find(candidate => candidate.ref === chatRef && candidate.enabled) : undefined)
			?? this.catalog.find(candidate => candidate.enabled);
		try {
			return await this.generateWith(item, !!pinned, prompt, options?.timeoutMs ?? GENERATED_TEXT_TIMEOUT_MS, 20_000);
		} catch (err) {
			this.logService.trace('[volt runtime] text generation failed', err);
			return undefined;
		}
	}

	private async generateTitleWithModel(item: IVoltCatalogItem, profile: IProviderProfile, prompt: string, pinned: boolean, timeoutMs = TITLE_TIMEOUT_MS, maxOutputTokens = 400): Promise<string | undefined> {
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			return undefined;
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const options = { ...this.resolvedOptions(item, undefined) };
		const levels = item.optionDescriptors?.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(option => option.value) ?? [];
		if (levels.length && !pinned) {
			options[MODEL_OPTION_REASONING] = levels.includes('off') ? 'off' : closestLevel('low', levels.filter(value => value !== 'auto')) ?? levels[0];
		}
		const source = new CancellationTokenSource();
		const timer = setTimeout(() => source.cancel(), timeoutMs);
		let text = '';
		try {
			for await (const event of provider.stream({ modelId: item.id, profile, apiKey, options, messages: [{ role: 'user', content: prompt }], maxOutputTokens }, source.token)) {
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				} else if (event.type === 'error') {
					return undefined;
				}
			}
		} finally {
			clearTimeout(timer);
			source.dispose();
		}
		return text;
	}

	/**
	 * Gets an agent ready before the first message, so a send does not pay the cold start
	 * (spawn, initialize, session/new, config: about 5-9 s for cursor-agent). The spare is not
	 * bound to this chat until a send adopts it. Native models need no warm-up.
	 */
	prewarmAgent(sessionId: string, providerRef: string | undefined, mode: VoltMode): void {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		if (session.run && !session.run.ended) {
			return;
		}
		const ref = providerRef ?? session.providerRef ?? this.defaultRef(mode);
		const item = this.catalog.find(candidate => candidate.ref === ref && candidate.enabled);
		const profile = item ? this.profiles.find(candidate => candidate.id === item.profileId) : undefined;
		const provider = profile ? this.agentProviders.get(profile.providerId) : undefined;
		if (!item || item.kind !== 'agent' || !profile || !provider) {
			return;
		}
		const cwd = this.executionRoot(session)?.fsPath;
		if (session.agentHandle && session.agentRef === item.ref && session.agentCwd === cwd && (provider.isLive?.(session.agentHandle) ?? true)) {
			return;
		}
		const spare = this.spareRequest(provider, profile, item, cwd, undefined);
		if (this.agentPool.has(spare.key)) {
			return;
		}
		// A spare under an alias serves whichever chat sends first, but its browser tools reach the
		// chat only when the host tool service follows aliases. Otherwise park one for this chat in
		// the provider (its host MCP URL names the chat), which `start` adopts.
		const perChat = provider as IAgentProvider & Partial<Pick<AcpAgentProvider, 'prewarmSpare' | 'hasSpare'>>;
		if (!this.aliasHost() && perChat.prewarmSpare && perChat.hasSpare) {
			const request = this.agentStartRequest(session.sessionId, profile, item, cwd, undefined, mode);
			if (!perChat.hasSpare(request)) {
				void perChat.prewarmSpare(request);
			}
			return;
		}
		this.agentPool.ensure(spare);
	}

	private agentStartRequest(sessionId: string, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined, mode: VoltMode): IAgentStartRequest {
		return {
			sessionId,
			mode,
			profile,
			cwd,
			modelId: item.id === profile.providerId ? undefined : item.id,
			options: this.resolvedOptions(item, options),
		};
	}

	/** Pool key: an agent can serve a chat when all of these match. */
	private poolKey(provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined): string {
		const resolved = this.resolvedOptions(item, options);
		const sorted = Object.keys(resolved).sort().map(key => [key, resolved[key]]);
		return JSON.stringify([provider.id, profile.id, item.ref, cwd ?? '', sorted]);
	}

	private spareRequest(provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined): ISpareRequest {
		return {
			key: this.poolKey(provider, profile, item, cwd, options),
			providerId: provider.id,
			start: async alias => {
				const handle = await provider.start(this.agentStartRequest(alias, profile, item, cwd, options, 'agent'));
				try {
					await provider.applyAccessPolicy?.(handle, this.compiledPolicy);
				} catch (err) {
					await provider.dispose(handle).catch(() => undefined);
					throw err;
				}
				return handle;
			},
			dispose: handle => provider.dispose(handle),
			isLive: handle => provider.isLive?.(handle) ?? true,
		};
	}

	private async startAgentSession(session: ISessionState, run: IRunState, provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, mode: VoltMode, options: IVoltModelOptions | undefined): Promise<void> {
		const cwd = this.executionRoot(session)?.fsPath;
		// The provider adopts a spare it parked for this chat (see prewarmAgent), else starts cold.
		const handle = await provider.start(this.agentStartRequest(session.sessionId, profile, item, cwd, options, mode));
		if (!this.isCurrent(session, run) && session.agentHandle) {
			// A newer run already has an agent; this cancelled run's start is not needed.
			void provider.dispose(handle).catch(() => undefined);
			return;
		}
		this.disposeSessionAgent(session);
		this.bindAgent(session, provider, item, cwd, handle);
		await provider.applyAccessPolicy?.(handle, this.compiledPolicy);
	}

	private bindAgent(session: ISessionState, provider: IAgentProvider, item: IVoltCatalogItem, cwd: string | undefined, handle: IAgentSessionHandle): void {
		session.agentHandle = handle;
		session.agentProviderId = provider.id;
		session.agentRef = item.ref;
		session.agentCwd = cwd;
		session.agentUsedAt = Date.now();
		// A fresh agent process has seen nothing of this conversation yet.
		session.agentSynced = 0;
	}

	/** Lets go of the chat's current agent, if any. */
	private disposeSessionAgent(session: ISessionState): void {
		const handle = session.agentHandle;
		const provider = session.agentProviderId ? this.agentProviders.get(session.agentProviderId) : undefined;
		session.agentHandle = undefined;
		session.agentProviderId = undefined;
		this.forgetAliases(session.sessionId);
		if (handle) {
			void provider?.dispose(handle).catch(() => undefined);
		}
	}

	truncateSession(sessionId: string, userTurns: number): void {
		const session = this.sessions.get(sessionId);
		if (!session || (session.run && !session.run.ended)) {
			return;
		}
		let seen = 0;
		const cut = session.messages.findIndex(message => message.role === 'user' && !message.steer && seen++ === userTurns);
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
			this.disposeSessionAgent(session);
			session.agentSynced = 0;
		}
	}

	async cancel(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.denyPending(sessionId);
		if (session.run && !session.run.ended) {
			this.cancelRun(session, session.run);
		}
	}

	/**
	 * The one way a run is stopped (Stop, a new send, a human takeover). The engine sees its token
	 * cancelled (an ACP provider sends `session/cancel` once from it) and unwinds on its own; the
	 * run ends now so the chat is free immediately.
	 */
	private cancelRun(session: ISessionState, run: IRunState): void {
		this.denyPending(session.sessionId);
		run.cancel.cancel();
		this.finish(session, run, 'abort');
	}

	async pause(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.paused = true;
		const runId = session.activeRun?.runId;
		if (runId && session.activeRun) {
			session.activeRun = { ...session.activeRun, status: 'waiting' };
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
		const runId = session.activeRun?.runId;
		if (runId && session.activeRun) {
			session.activeRun = { ...session.activeRun, status: 'running' };
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
		if (session.run && this.steer(sessionId, text)) {
			return session.run.runId;
		}
		const runId = session.activeRun?.runId;
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
		const effect = applyHumanAction(action, new TaskLifecycle(), undefined);
		const runId = session.activeRun?.runId ?? generateUuid();
		if (effect.phase === 'paused' || action.kind === 'pause' || action.kind === 'takeover') {
			session.paused = true;
		}
		if (effect.phase === 'running' && action.kind === 'resume') {
			session.paused = false;
		}
		if ((effect.stop || action.kind === 'stop' || action.kind === 'takeover') && session.run && !session.run.ended) {
			this.cancelRun(session, session.run);
		}
		if (effect.inject && this.nativeLive(session)) {
			this.nativeState(session).inbox.push(effect.inject);
		}
		if (effect.approval) {
			this.respondToAccessRequest(effect.approval.requestId, effect.approval.effect, 'once');
		}
		this.emit(session, runId, { type: 'human', action: action.kind, detail: effect.reason });
	}

	getRunMetrics(sessionId?: string): readonly IRunMetrics[] {
		return sessionId ? this.runMetrics.filter(metrics => metrics.sessionId === sessionId) : this.runMetrics.slice();
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

	getPendingQuestions(sessionId: string): readonly IAgentQuestionRequest[] {
		return [...this.pendingQuestions.values()].map(item => item.request).filter(request => request.sessionId === sessionId);
	}

	respondToQuestions(requestId: string, response: IAgentQuestionResponse): boolean {
		const pending = this.pendingQuestions.get(requestId);
		if (!pending) {
			return false;
		}
		this.pendingQuestions.delete(requestId);
		const { request } = pending;
		const session = this.sessions.get(request.sessionId);
		if (session) {
			if (session.activeRun?.status === 'waiting' && !this.hasPendingInput(request.sessionId)) {
				session.activeRun = { ...session.activeRun, status: 'running' };
			}
			this.emit(session, request.runId || session.activeRun?.runId || request.id, {
				type: 'question.resolved',
				requestId,
				outcome: response.outcome,
				answers: answeredQuestions(request, response),
				...(response.note?.trim() ? { note: response.note.trim() } : {}),
			});
		}
		this._onDidChangeQuestions.fire(request.sessionId);
		let delivered = pending.waiters.size > 0;
		if (delivered) {
			for (const waiter of pending.waiters) {
				waiter(response);
			}
		} else if (response.outcome !== 'cancelled' && (session?.activeRun?.status === 'running' || session?.activeRun?.status === 'waiting')) {
			// The agent is between long-polls: its next `await_answers` collects this.
			this.unclaimedAnswers.set(requestId, response);
			delivered = true;
		}
		return delivered;
	}

	/** Shows `draft` in the chat's question tray. The answers come through `waitForAnswers`. */
	private openQuestions(sessionId: string, runId: string | undefined, draft: AgentQuestionDraft): IAgentQuestionRequest {
		const session = this.sessions.get(sessionId);
		const request: IAgentQuestionRequest = {
			...draft,
			id: generateUuid(),
			sessionId,
			runId: runId || session?.activeRun?.runId || '',
		};
		if (session?.activeRun) {
			session.activeRun = { ...session.activeRun, status: 'waiting' };
		}
		this.pendingQuestions.set(request.id, { request, waiters: new Set() });
		if (session) {
			this.emit(session, request.runId || request.id, { type: 'question.ask', request });
		}
		this._onDidChangeQuestions.fire(sessionId);
		return request;
	}

	/**
	 * The user's answers to `requestId`, or undefined when `ms` passes first. An agent whose tool
	 * calls time out (Cursor's MCP client gives up after 60s) polls again; the tray stays up between.
	 */
	private waitForAnswers(requestId: string, ms: number | undefined, token: CancellationToken): Promise<IAgentQuestionResponse | undefined> {
		const unclaimed = this.unclaimedAnswers.get(requestId);
		if (unclaimed) {
			this.unclaimedAnswers.delete(requestId);
			return Promise.resolve(unclaimed);
		}
		const pending = this.pendingQuestions.get(requestId);
		if (!pending) {
			return Promise.resolve({ outcome: 'cancelled', answers: [] });
		}
		return new Promise(resolve => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (response: IAgentQuestionResponse | undefined) => {
				pending.waiters.delete(waiter);
				listener.dispose();
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				resolve(response);
			};
			const waiter = (response: IAgentQuestionResponse) => done(response);
			pending.waiters.add(waiter);
			const listener = token.onCancellationRequested(() => done(undefined));
			if (ms !== undefined) {
				timer = setTimeout(() => done(undefined), ms);
			}
		});
	}

	/** Shows `draft` and resolves with the answers, for wires without a timeout (ACP requests). */
	private async askQuestions(sessionId: string, runId: string | undefined, draft: AgentQuestionDraft): Promise<IAgentQuestionResponse> {
		const request = this.openQuestions(sessionId, runId, draft);
		return await this.waitForAnswers(request.id, undefined, CancellationToken.None) ?? { outcome: 'cancelled', answers: [] };
	}

	/** For the native `ask_question` tool: the tray closes (as cancelled) when the call is aborted. */
	private async askQuestionsUntil(sessionId: string, runId: string | undefined, draft: AgentQuestionDraft, signal: AbortSignal): Promise<IAgentQuestionResponse> {
		const request = this.openQuestions(sessionId, runId, draft);
		const source = new CancellationTokenSource();
		const onAbort = () => source.cancel();
		signal.addEventListener('abort', onAbort);
		if (signal.aborted) {
			source.cancel();
		}
		try {
			const response = await this.waitForAnswers(request.id, undefined, source.token);
			if (response) {
				return response;
			}
			this.respondToQuestions(request.id, { outcome: 'cancelled', answers: [] });
			return { outcome: 'cancelled', answers: [] };
		} finally {
			signal.removeEventListener('abort', onAbort);
			source.dispose();
		}
	}

	/**
	 * A host tool call the chat's mode would not run on its own (Ask and Plan: running page
	 * scripts, leaving localhost): the user decides, in the same approval card as other requests.
	 */
	private async approveHostTool(request: IVoltHostToolApproval, token: CancellationToken): Promise<boolean> {
		const sessionId = this.chatFor(request.sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		const access: IAccessRequest = {
			id: generateUuid(),
			sessionId,
			runId: session.activeRun?.runId ?? '',
			providerId: 'volt',
			action: 'browser',
			resource: { type: 'tool', value: request.name },
			risk: 'medium',
			preview: { title: request.name, detail: `${request.name}: ${request.reason}` },
			createdAt: Date.now(),
		};
		const pending = this.askAccess(access, { requestId: access.id, effect: 'ask', scope: 'once', policySource: 'mode' });
		const cancelled = token.onCancellationRequested(() => {
			if (this.pendingApprovals.has(access.id)) {
				this.respondToAccessRequest(access.id, 'deny', 'once');
			}
		});
		try {
			return (await pending).effect === 'allow';
		} finally {
			cancelled.dispose();
		}
	}

	private hasPendingInput(sessionId: string): boolean {
		return [...this.pendingApprovals.values()].some(item => item.request.sessionId === sessionId)
			|| [...this.pendingQuestions.values()].some(item => item.request.sessionId === sessionId);
	}

	private onHostToolResult(call: IVoltHostToolInvocation): void {
		const session = this.sessions.get(this.chatFor(call.sessionId));
		if (!session || call.name === ASK_QUESTION_TOOL_NAME || call.name === AWAIT_ANSWERS_TOOL_NAME) {
			return;
		}
		this.emit(session, session.activeRun?.runId || session.sessionId, {
			type: 'host.tool',
			name: call.name,
			args: call.args,
			...(call.result.text ? { text: call.result.text } : {}),
			...(call.result.image ? { image: call.result.image } : {}),
			...(call.result.error ? { error: call.result.error } : {}),
		});
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

	async listMcpServers(root: URI | undefined): Promise<readonly IVoltMcpServerStatus[]> {
		const home = await this.pathService.userHome().catch(() => undefined);
		return this.mcpHost.servers(root, home);
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
		if (!models?.length) {
			// A probe that times out (the CLI is busy serving a live chat, say) answers with nothing.
			// Keep the models we already list, or the picker drops the agent and the chat falls back
			// to some other provider's model on its next turn.
			return this.agentModels.get(profile.id) ?? this.listedAgentModels(profile.id);
		}
		this.agentModels.set(profile.id, models);
		return models;
	}

	private listedAgentModels(profileId: string): IModelInfo[] {
		return this.catalog
			.filter(item => item.kind === 'agent' && item.profileId === profileId)
			.map(item => ({
				id: item.id,
				label: item.label,
				capabilities: item.capabilities,
				...(item.optionDescriptors ? { optionDescriptors: item.optionDescriptors } : {}),
				...(item.detail ? { detail: item.detail } : {}),
				...(item.description ? { description: item.description } : {}),
				...(item.contextLabel ? { contextLabel: item.contextLabel } : {}),
			}));
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
		this.healthTimer.cancelAndSet(() => {
			// Probes spawn throwaway agents (initialize, session/new, model lists); never during a run.
			if (this.anyRunLive()) {
				this.healthDeferred = true;
				return;
			}
			void this.refreshProviders();
		}, seconds * 1000);
	}

	private beginRun(session: ISessionState, mode: VoltMode, engine: 'native' | 'agent', sendAt: number): IRunState {
		const runId = generateUuid();
		const run: IRunState = {
			runId,
			mode,
			engine,
			cancel: new CancellationTokenSource(),
			metrics: new RunMetrics(runId, session.sessionId, engine, mode, sendAt, session.providerRef),
			settled: new DeferredPromise<void>(),
			ended: false,
			lastMutation: 0,
			lastTestPass: -1,
			events: 0,
			calls: new Map(),
			continued: { regression: false, todos: false },
		};
		session.run = run;
		session.activeRun = {
			runId,
			sessionId: session.sessionId,
			status: 'running',
			startedAt: Date.now(),
			providerRef: session.providerRef,
		};
		this.emit(session, runId, { type: 'run.start', runId, mode });
		return run;
	}

	/** The run is the chat's current one and has not ended: it may change session state. */
	private isCurrent(session: ISessionState, run: IRunState): boolean {
		return session.run === run && !run.ended;
	}

	private nativeLive(session: ISessionState): boolean {
		return !!session.run && !session.run.ended && session.run.engine === 'native';
	}

	private anyRunLive(): boolean {
		for (const session of this.sessions.values()) {
			if (session.run && !session.run.ended) {
				return true;
			}
		}
		return false;
	}

	/** True when `run` (a cancelled predecessor) stopped within `ms`. */
	private async waitSettled(run: IRunState | undefined, ms: number): Promise<boolean> {
		if (!run || run.settled.isSettled) {
			return true;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			run.settled.p.then(() => true),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
		]);
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		return settled;
	}

	chatFor(sessionId: string): string {
		return this.sessionAliases.get(sessionId) ?? sessionId;
	}

	private forgetAliases(sessionId: string): void {
		for (const [alias, target] of [...this.sessionAliases]) {
			if (target === sessionId) {
				this.setAlias(alias, undefined);
			}
		}
	}

	/**
	 * Spare agents run under an alias, so host tool calls from them name the alias. Questions and
	 * tool results come through this service and are mapped here; browser tools are routed by the
	 * host tool service, which can only follow the alias when it offers `setSessionAlias`.
	 */
	private aliasHost(): (IVoltHostToolService & { setSessionAlias(alias: string, sessionId: string | undefined): void }) | undefined {
		const service = this.hostTools as IVoltHostToolService & { setSessionAlias?(alias: string, sessionId: string | undefined): void };
		return typeof service.setSessionAlias === 'function' ? service as IVoltHostToolService & { setSessionAlias(alias: string, sessionId: string | undefined): void } : undefined;
	}

	private setAlias(alias: string, sessionId: string | undefined): void {
		if (sessionId) {
			this.sessionAliases.set(alias, sessionId);
		} else {
			this.sessionAliases.delete(alias);
		}
		this.aliasHost()?.setSessionAlias(alias, sessionId);
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
		const created = await this.worktrees.create(project.fsPath, request.worktreeTarget);
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
					askQuestion: (draft, ctx) => this.askQuestionsUntil(session.sessionId, session.run?.runId, draft, ctx.signal),
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
	private async executeDeepseek(session: ISessionState, run: IRunState, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, previous: IRunState | undefined): Promise<void> {
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, run.runId, { type: 'error', message: `Unknown model provider ${profile.providerId}` });
			this.finish(session, run, 'fail');
			return;
		}
		// A cancelled run's tools may still be finishing; give them a moment before this one starts its own.
		await this.waitSettled(previous, SETTLE_WAIT_NATIVE_MS);
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const root = this.executionRoot(session);
		const cwd = root?.fsPath;
		await this.nativeRestores.get(session.sessionId);
		this.nativeRestores.delete(session.sessionId);
		if (!this.isCurrent(session, run)) {
			return;
		}
		const state = this.nativeState(session);
		// This run appends to its own copy; cancelling detaches it, so a loop that is still unwinding
		// cannot push tool results after the next run's user message.
		const transcript = state.messages.slice();
		state.messages = transcript;
		run.transcript = transcript;
		state.cwd = cwd;
		const journal = () => ({ version: 1 as const, messages: state.messages, synced: state.synced, effort: state.effort, todo: state.todo, savedAt: Date.now() });
		state.changed.clear();
		state.ledger.resumeReferences();
		const images = this.modelImages(request.images);
		this.syncNativeTranscript(session, state, request.text, images);

		const [projectInstructions, instructions, mcpTools] = await Promise.all([
			this.workspaceProjectInstructions(root),
			this.workspaceInstructions(root),
			// MCP servers get a short, bounded wait: a slow server joins the next run instead of stalling this one.
			modePolicy(request.mode).allowMcp
				? this.pathService.userHome().catch(() => undefined).then(home => this.mcpHost.tools(root, home, transcript.length > 1 ? 1_500 : 4_000)).catch(() => [])
				: Promise.resolve([]),
		]);
		if (!this.isCurrent(session, run)) {
			return;
		}
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
		const cancel = run.cancel.token;
		const options = this.runOptions(item, request, state);
		const schemas = toolSchemas(selected);
		const contextWindow = item.capabilities.contextWindow || DEFAULT_MODEL_CAPABILITIES.contextWindow;
		const system: INativeLoopMessage = { role: 'system', content: turn.prompt };
		const emit = (event: IVoltEvent) => {
			if (event.type === 'usage' && this.isCurrent(session, run)) {
				state.promptTokens = event.used ?? event.input + (event.cache ?? 0) + (event.cacheWrite ?? 0);
			}
			this.emitEngine(session, run, event);
		};
		const compact = (messages: INativeLoopMessage[], aggressive: boolean) => this.compactNative(session, run, state, messages, {
			provider, profile, apiKey, item, system: turn.prompt, contextWindow, aggressive, token: cancel,
		});
		run.metrics.mark('prompt');
		try {
			const result = await runDeepseekLoop({
				stream: (messages, _token, streamOptions) => linkedStream(cancel, streamOptions?.signal, token => new VoltLlmAdapter(provider).stream({
					modelId: item.id,
					messages: nativeToModelMessages([system, ...messages]),
					profile,
					apiKey,
					options,
					tools: schemas,
					...(streamOptions?.maxOutputTokens ? { maxOutputTokens: streamOptions.maxOutputTokens } : {}),
				}, token)),
				execute: (calls, onResult) => runToolBatch(registry, calls, {
					cwd,
					signal: abortSignalFrom(cancel),
					sessionId: session.sessionId,
					mode: request.mode,
					emit: event => this.onToolEvent(session, run, state, event),
				}, { authorize: async () => ({ allow: true }), onResult }),
				authorize: call => this.authorizeDeepseek(session, run.runId, profile, call, registry.get(call.name)),
				preauthorize: call => this.preauthorizeDeepseek(session, run.runId, profile, call, registry.get(call.name)),
				emit,
				tool: name => registry.get(name),
				cwd,
				contextWindow,
				maxOutputTokens: 128_000,
				prepareTurn: async (messages, step) => {
					if (!this.isCurrent(session, run)) {
						return;
					}
					state.ledger.nextStep();
					// Old screenshots are pruned in batches, so the cached prompt prefix rarely changes.
					pruneImages(messages);
					this.journal.schedule(session.sessionId, journal);
					if (step > 1 || messages.length > 2) {
						const estimate = Math.max(state.promptTokens, estimateTokens(turn.prompt) + totalTokens(messages));
						if (shouldCompact(estimate, { window: contextWindow, ...DEFAULT_COMPACTION })) {
							await compact(messages, false);
						}
					}
				},
				recoverOverflow: messages => compact(messages, true),
				reviewCompletion: modePolicy(request.mode).allowWrites ? input => this.reviewNativeCompletion(session, run, state, input.attempt) : undefined,
			}, {
				messages: transcript,
				token: cancel,
				isPaused: () => !!session.paused,
				claimInbox: () => this.isCurrent(session, run) ? state.inbox.splice(0, state.inbox.length) : [],
				controller: { afterStep: step => this.afterNativeStep(session, run, state, step) },
			});
			if (!this.isCurrent(session, run)) {
				return;
			}
			if (result.assistant) {
				session.messages.push({ role: 'assistant', content: result.assistant, model: item.label });
			}
			state.synced = session.messages.length;
			if (result.stopped?.by === 'loop') {
				// The same tray an ACP agent's loop gets.
				this.emit(session, run.runId, { type: 'notice', severity: 'warning', title: LOOP_NOTICE_TITLE, description: result.stopped.reason });
			}
			if (result.outcome === 'budget') {
				this.emit(session, run.runId, { type: 'notice', severity: 'warning', title: 'Paused at the step limit for one run.', description: 'Send "continue" to keep going from here.' });
			}
			const aborted = result.outcome === 'abort' || cancel.isCancellationRequested;
			this.finish(session, run, aborted ? 'abort' : result.outcome === 'fail' ? 'fail' : 'done');
		} catch (err) {
			if (this.isCurrent(session, run)) {
				this.emit(session, run.runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
				this.finish(session, run, cancel.isCancellationRequested ? 'abort' : 'fail');
			}
		} finally {
			if (session.run === run) {
				state.synced = Math.max(state.synced, session.messages.length);
			}
			// Always the session's transcript, never this run's detached copy.
			void this.journal.schedule(session.sessionId, journal, true);
		}
	}

	/**
	 * The user's images in the form providers take. Capability flags are often unknown for listed
	 * models, so they always go along; each provider sends them only where its API takes images.
	 */
	private modelImages(images: readonly IVoltImageAttachment[] | undefined): IModelImage[] | undefined {
		if (!images?.length) {
			return undefined;
		}
		return images.map(image => ({ mediaType: image.mediaType, data: image.data }));
	}

	private nativeState(session: ISessionState): INativeState {
		session.deepseek ??= {
			messages: [],
			inbox: [],
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
	private syncNativeTranscript(session: ISessionState, state: INativeState, text: string, images?: IModelImage[]): void {
		const unseen = session.messages.slice(state.synced, -1);
		for (const message of unseen) {
			if (!message.content.trim() || message.role === 'system') {
				continue;
			}
			state.messages.push(message.role === 'assistant' ? { role: 'assistant', content: message.content } : { role: 'user', content: message.content, ...(message.steer ? {} : { turn: true }) });
		}
		const tail = state.messages.at(-1);
		if (!(tail?.role === 'user' && tail.content === text && !images?.length)) {
			state.messages.push({ role: 'user', content: text, turn: true, ...(images?.length ? { images } : {}) });
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
		const level = chooseEffort(request.text, { mode: request.mode, previous: state.effort, attachments: attachmentNames(request).length });
		state.effort = level;
		const values = (descriptor.options ?? []).map(option => option.value).filter(value => value !== 'auto' && value !== 'off');
		options[MODEL_OPTION_REASONING] = closestLevel(level, values) ?? level;
		return options;
	}

	private onToolEvent(session: ISessionState, run: IRunState, state: INativeState, event: { type: string;[key: string]: unknown }): void {
		const current = this.isCurrent(session, run);
		if (event.type === 'file.change' && URI.isUri(event.uri)) {
			if (current && !state.changed.has(event.uri)) {
				state.changed.set(event.uri, this.codeIntel.errorCounts(event.uri));
			}
			this.codeIntel.noteWrite(event.uri);
		}
		if (current && event.type === 'plan' && Array.isArray(event.entries)) {
			state.todo = (event.entries as { content: string; status: string }[]).map(entry => `- [${entry.status}] ${entry.content}`).join('\n');
		}
		const forwarded = asToolEvent(event);
		if (forwarded) {
			this.emitEngine(session, run, forwarded);
		}
	}

	/**
	 * Before the model is allowed to stop: new compiler or linter errors in the files it changed
	 * (language services already know, so this costs a second), then the project's tests against
	 * the baseline, then its open to-dos.
	 */
	private async reviewNativeCompletion(session: ISessionState, run: IRunState, state: INativeState, attempt: number): Promise<string | undefined> {
		return this.isCurrent(session, run) ? this.reviewCompletion(state, attempt) : undefined;
	}

	/**
	 * The native loop's controller. On a finishing step: steering text that arrived too late for
	 * the last model call goes in now, and the regression gate and open to-dos may send the model
	 * back (once per reason).
	 */
	private async afterNativeStep(session: ISessionState, run: IRunState, state: INativeState, step: IDeepseekStep): Promise<DeepseekDirective> {
		if (!step.wantsToFinish || !this.isCurrent(session, run)) {
			return { kind: 'continue' };
		}
		const steered = state.inbox.splice(0, state.inbox.length);
		const gate = await this.qualityContinuation(session, run);
		const message = [...steered, ...(gate ? [gate] : [])].join('\n\n');
		return message ? { kind: 'inject', message } : { kind: 'continue' };
	}

	/** New compiler or linter errors in the files the run changed (language services already know). */
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
	private async compactNative(session: ISessionState, run: IRunState, state: INativeState, messages: INativeLoopMessage[], input: {
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
		const compactionId = generateUuid();
		const startedAt = Date.now();
		const preTokens = estimateTokens(input.system) + totalTokens(messages);
		this.emitEngine(session, run, { type: 'context.compaction', id: compactionId, status: 'running', trigger: 'auto', preTokens });
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
		this.emitEngine(session, run, {
			type: 'context.compaction',
			id: compactionId,
			status: 'completed',
			postTokens: state.promptTokens,
			durationMs: Date.now() - startedAt,
			...(summary ? { summary } : {}),
		});
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
		const run = session.run && !session.run.ended ? session.run : undefined;
		const runId = run?.runId;
		if (!item || !profile || !provider || item.kind !== 'model' || !run || !runId) {
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
		const source = new CancellationTokenSource(run.cancel.token);
		const onAbort = () => source.cancel();
		ctx.signal.addEventListener('abort', onAbort);
		const progress = (status: string) => {
			if (ctx.callId && !run.ended) {
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
				execute: (calls, onResult) => runToolBatch(registry, calls, { cwd: root?.fsPath, signal: abortSignalFrom(source.token), sessionId: session.sessionId, mode: 'ask' }, { authorize: async () => ({ allow: true }), onResult }),
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

	private async execute(session: ISessionState, run: IRunState, request: IVoltSendRequest, intent: IIntent, previous: IRunState | undefined): Promise<void> {
		const item = this.catalog.find(c => c.ref === session.providerRef && c.enabled) ?? this.catalog.find(c => c.enabled);
		if (!item) {
			this.emit(session, run.runId, { type: 'error', message: 'No model or ACP agent is connected. Open Volt Settings to add one.' });
			this.finish(session, run, 'fail');
			return;
		}

		const profile = this.profiles.find(p => p.id === item.profileId);
		if (!profile) {
			this.emit(session, run.runId, { type: 'error', message: 'Selected connection is missing.' });
			this.finish(session, run, 'fail');
			return;
		}

		if (item.kind === 'agent') {
			await this.executeAgent(session, run, request, profile, item, intent, previous);
			return;
		}
		await this.executeDeepseek(session, run, request, profile, item, previous);
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

	/** What `buildAcpLead` reads, and nothing else: the lead is built on every turn's critical path. */
	private async contextPackInput(session: ISessionState, mode: VoltMode, intent: IIntent): Promise<IContextPackInput> {
		const root = this.executionRoot(session);
		return {
			mode,
			intent: { ...intent, groups: this.effectiveGroups(session, intent) },
			runPlan: intent.wantsPreview ? await this.workspaceRunPlan(root) : undefined,
			environment: this.environmentFacts(root),
			...(intent.shape ? { shape: intent.shape } : {}),
			...(mode === 'multitask' ? { taskModels: [...new Set(this.listCatalog().filter(item => item.enabled).map(item => item.label))] } : {}),
		};
	}

	private async executeAgent(session: ISessionState, run: IRunState, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, intent: IIntent, previous: IRunState | undefined): Promise<void> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, run.runId, { type: 'error', message: `Unknown agent provider ${profile.providerId}` });
			this.finish(session, run, 'fail');
			return;
		}
		const token = run.cancel.token;
		// Another model from the same CLI is another agent session: restart it; the recap carries the thread over.
		const hasLiveAgent = () => !!session.agentHandle && session.agentProviderId === provider.id && session.agentRef === item.ref
			&& session.agentCwd === this.executionRoot(session)?.fsPath && (provider.isLive?.(session.agentHandle) ?? true);
		// One prompt at a time per agent session: a cancelled turn lets go of the agent before the
		// next prompt is written, or the agent is replaced.
		if (previous?.engine === 'agent' && !await this.waitSettled(previous, SETTLE_WAIT_AGENT_MS) && this.isCurrent(session, run) && session.agentHandle) {
			this.logService.info('[volt] the cancelled turn did not release its agent in time; using another one');
			this.disposeSessionAgent(session);
			session.agentSynced = 0;
		}
		const turns: string[] = [];
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (!this.isCurrent(session, run)) {
					return;
				}
				try {
					if (hasLiveAgent()) {
						run.metrics.setAgentSource('live');
					} else {
						await this.acquireAgent(session, run, provider, profile, item, request, intent, attempt > 0);
					}
					const handle = session.agentHandle;
					if (!this.isCurrent(session, run) || !handle) {
						return;
					}
					run.metrics.mark('agentReady');
					provider.setRunContext?.(handle, { sessionId: session.sessionId, runId: run.runId, mode: request.mode });
					const recap = conversationRecap(session.messages.slice(session.agentSynced ?? 0, -1));
					if (recap) {
						session.agentJoinedLate = handle;
					}
					const lead = [recap, buildAcpLead(await this.contextPackInput(session, request.mode, intent))].filter(Boolean).join('\n\n') || undefined;
					if (!this.isCurrent(session, run)) {
						return;
					}
					const images = this.modelImages(request.images);
					const first = await this.agentTurn(session, run, provider, handle, profile, { text: request.text, mode: request.mode, lead, ...(images ? { images } : {}) }, attempt === 0);
					if (first.kind === 'stale') {
						return;
					}
					if (first.kind === 'restart') {
						this.emit(session, run.runId, { type: 'retry', attempt: 2, delayMs: 0, message: 'Agent process died. Restarting and retrying.' });
						this.disposeSessionAgent(session);
						continue;
					}
					turns.push(first.assistant);
					let reason = first.reason;
					// The agent wants to stop. Volt's checks may send it back once per reason.
					while (reason === 'done') {
						const message = await this.qualityContinuation(session, run);
						if (!message || !this.isCurrent(session, run)) {
							break;
						}
						const next = await this.agentTurn(session, run, provider, handle, profile, { text: message, mode: request.mode }, false);
						if (next.kind === 'stale') {
							return;
						}
						if (next.kind === 'restart') {
							reason = 'fail';
							break;
						}
						turns.push(next.assistant);
						reason = next.reason;
					}
					if (!this.isCurrent(session, run)) {
						return;
					}
					const assistant = turns.filter(text => text.trim()).join('\n\n');
					if (assistant) {
						session.messages.push({ role: 'assistant', content: assistant, model: item.label });
					}
					session.agentSynced = session.messages.length;
					this.finish(session, run, reason);
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (attempt === 0 && !token.isCancellationRequested && isAcpTurnRestartable(message) && this.isCurrent(session, run)) {
						this.emit(session, run.runId, { type: 'retry', attempt: 2, delayMs: 0, message: 'Agent process died. Restarting and retrying.' });
						this.disposeSessionAgent(session);
						continue;
					}
					throw err;
				}
			}
			if (this.isCurrent(session, run)) {
				this.emit(session, run.runId, { type: 'error', message: 'Agent process died.', retryable: true });
				this.finish(session, run, 'fail');
			}
		} catch (err) {
			if (this.isCurrent(session, run)) {
				this.emit(session, run.runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
				this.finish(session, run, token.isCancellationRequested ? 'abort' : 'fail');
			}
		}
	}

	/**
	 * One `session/prompt`. Events of a run that is no longer current are drained, not shown: the
	 * provider's prompt settles on its own once the cancel reaches the agent, and the run is
	 * settled only then, so the next prompt never overlaps it.
	 */
	private async agentTurn(session: ISessionState, run: IRunState, provider: IAgentProvider, handle: IAgentSessionHandle, profile: IProviderProfile, message: IAgentMessage, mayRestart: boolean): Promise<AgentTurnResult> {
		const token = run.cancel.token;
		let assistant = '';
		let textId: string | undefined;
		let restart = false;
		let reason: 'done' | 'abort' | 'fail' | undefined;
		run.metrics.mark('prompt');
		for await (const event of provider.send(handle, message, profile, token)) {
			if (!this.isCurrent(session, run)) {
				continue;
			}
			if (event.type === 'run.end') {
				reason ??= event.reason;
				continue;
			}
			if (event.type === 'error' && mayRestart && !token.isCancellationRequested && isAcpTurnRestartable(event.message)) {
				restart = true;
				continue;
			}
			if (restart) {
				continue;
			}
			if (event.type === 'text.delta' && event.delta) {
				// Another message of the same turn is another paragraph, as the transcript shows it.
				if (textId !== undefined && event.id !== textId && assistant && !assistant.endsWith('\n')) {
					assistant += '\n\n';
				}
				textId = event.id;
				assistant += event.delta;
			}
			if (event.type === 'title' && session.agentJoinedLate === handle) {
				// Codex titled a handed-off chat "<conversation_so_far> This conversation started...".
				continue;
			}
			this.emitEngine(session, run, event);
		}
		if (!this.isCurrent(session, run)) {
			return { kind: 'stale' };
		}
		if (restart && reason !== 'done') {
			return { kind: 'restart' };
		}
		return { kind: 'end', reason: reason ?? 'done', assistant };
	}

	/** A warm spare when one fits (or is about to), otherwise a cold start bound to this chat. */
	private async acquireAgent(session: ISessionState, run: IRunState, provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, request: IVoltSendRequest, intent: IIntent, restart: boolean): Promise<void> {
		const cwd = this.executionRoot(session)?.fsPath;
		const spareRequest = this.spareRequest(provider, profile, item, cwd, request.options);
		run.spare = spareRequest;
		// A spare's browser tools reach this chat only when the host tool service maps its alias.
		if (this.aliasHost() || !(intent.wantsPreview || intent.matchesDesign)) {
			const spare = await this.agentPool.take(spareRequest.key);
			if (spare) {
				if (!this.isCurrent(session, run) && session.agentHandle) {
					void provider.dispose(spare.handle).catch(() => undefined);
					return;
				}
				this.disposeSessionAgent(session);
				this.bindAgent(session, provider, item, cwd, spare.handle);
				this.setAlias(spare.alias, session.sessionId);
				run.metrics.setAgentSource(restart ? 'restart' : 'pool');
				return;
			}
		}
		// The provider may hold a spare it parked for this chat (prewarmAgent without alias support).
		const parked = (provider as IAgentProvider & Partial<Pick<AcpAgentProvider, 'hasSpare'>>).hasSpare?.(this.agentStartRequest(session.sessionId, profile, item, cwd, request.options, request.mode));
		await this.startAgentSession(session, run, provider, profile, item, request.mode, request.options);
		run.metrics.setAgentSource(restart ? 'restart' : parked ? 'pool' : 'cold');
	}

	private finish(session: ISessionState, run: IRunState, reason: 'done' | 'abort' | 'fail'): void {
		if (!this.isCurrent(session, run)) {
			return;
		}
		run.ended = true;
		run.metrics.end(reason);
		if (session.activeRun?.runId === run.runId) {
			session.activeRun = { ...session.activeRun, status: reason === 'done' ? 'completed' : reason === 'abort' ? 'cancelled' : 'failed', endedAt: Date.now() };
		}
		if (reason !== 'done') {
			const state = session.deepseek;
			if (run.engine === 'native' && state && run.transcript && state.messages === run.transcript) {
				// The loop may still be unwinding into its array; the session keeps what it had now.
				state.messages = run.transcript.slice();
				state.synced = session.messages.length;
			}
			if (run.engine === 'agent' && run.metrics.hasPrompted && session.agentHandle) {
				// The agent saw this turn's prompt even though it never answered it in full.
				session.agentSynced = Math.max(session.agentSynced ?? 0, session.messages.length);
			}
		}
		if (run.quality?.baselineExecId) {
			void this.stdio.cancelExec(run.quality.baselineExecId).catch(() => undefined);
		}
		if (session.agentHandle) {
			session.agentUsedAt = Date.now();
			this.agentReaper.schedule();
		}
		this.emit(session, run.runId, { type: 'lifecycle', phase: reason === 'done' ? 'completed' : reason === 'abort' ? 'cancelled' : 'failed' });
		this.emit(session, run.runId, { type: 'run.end', runId: run.runId, reason });
		void run.settled.p.then(() => run.cancel.dispose());
		this.recordRun(session, run);
		this.afterRun(run);
	}

	/** Timings to the log and the trace, a sample to the eval ledger. */
	private recordRun(session: ISessionState, run: IRunState): void {
		const metrics = run.metrics.snapshot();
		this.runMetrics.push(metrics);
		if (this.runMetrics.length > RUN_METRICS_KEPT) {
			this.runMetrics.splice(0, this.runMetrics.length - RUN_METRICS_KEPT);
		}
		this.logService.info(`[volt timing] ${formatRunMetrics(metrics)}`);
		this.traces.recordMetrics(metrics);
		void this.traces.flush(session.sessionId);
		this.evalLedger.record(evalSampleFromMetrics(metrics, {
			lane: run.lane ?? 'agent',
			regression: run.regressed,
			unfinished: (run.plan ?? []).some(entry => entry.status === 'pending' || entry.status === 'in_progress'),
		}));
	}

	/** Work that waits for runs to end: a spare for the next new chat, deferred health checks. */
	private afterRun(run: IRunState): void {
		const metrics = run.metrics.snapshot();
		if (run.spare && metrics.outcome === 'done' && (metrics.agentSource === 'pool' || metrics.agentSource === 'cold')) {
			// This chat keeps its agent; the next new chat should not pay a cold start either. Not after
			// a failure: a provider that is out of quota or signed out would only fail again.
			this.agentPool.ensure(run.spare);
		}
		if (this.healthDeferred && !this.anyRunLive() && this.healthAfterRun === undefined) {
			this.healthAfterRun = setTimeout(() => {
				this.healthAfterRun = undefined;
				if (this.healthDeferred && !this.anyRunLive()) {
					this.healthDeferred = false;
					void this.refreshProviders();
				}
			}, HEALTH_AFTER_RUN_MS);
		}
	}

	private emit(session: ISessionState, runId: string, event: IVoltEvent): void {
		const envelope: IVoltEventEnvelope = {
			seq: ++session.seq,
			runId,
			sessionId: session.sessionId,
			timestamp: Date.now(),
			event,
		};
		this.traces.record(envelope);
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

	/** An event the engine (model or agent) produced for `run`. Dropped once the run has ended, except real file changes. */
	private emitEngine(session: ISessionState, run: IRunState, event: IVoltEvent): void {
		if (event.type === 'title' && session.titleState === 'done') {
			return;
		}
		if (!this.isCurrent(session, run)) {
			if (event.type === 'file.change') {
				this.emit(session, run.runId, event);
			}
			return;
		}
		run.events++;
		run.metrics.observe(event);
		this.observeForGate(session, run, event);
		this.emit(session, run.runId, event);
	}

	// --- quality gate --------------------------------------------------------------------------

	/** Tracks what the regression gate needs: workspace changes, to-dos, and the agent's own test runs. */
	private observeForGate(session: ISessionState, run: IRunState, event: IVoltEvent): void {
		switch (event.type) {
			case 'plan':
				run.plan = event.entries;
				return;
			case 'file.change':
				this.noteMutation(session, run);
				return;
			case 'tool.start':
				run.calls.set(event.callId, { kind: event.kind, input: event.input ?? '', title: event.title });
				this.classifyCall(session, run, event.callId);
				return;
			case 'tool.input.delta': {
				const call = run.calls.get(event.callId);
				if (call) {
					call.input = event.append ? call.input + event.delta : event.delta;
					this.classifyCall(session, run, event.callId);
				}
				return;
			}
			case 'tool.update': {
				const call = run.calls.get(event.callId);
				if (call) {
					call.kind = event.kind ?? call.kind;
					call.title = event.title ?? call.title;
					this.classifyCall(session, run, event.callId);
				}
				return;
			}
			case 'tool.end':
				this.classifyCall(session, run, event.callId);
				this.noteCallEnd(run, event);
				run.calls.delete(event.callId);
				return;
		}
	}

	private classifyCall(session: ISessionState, run: IRunState, callId: string): void {
		const call = run.calls.get(callId);
		if (!call || call.classified) {
			return;
		}
		if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
			call.classified = true;
			this.noteMutation(session, run);
			return;
		}
		if (call.kind !== 'execute') {
			return;
		}
		const command = commandOfCall(call.input, call.title);
		if (!command) {
			return;
		}
		call.classified = true;
		const quality = run.quality;
		if (quality && (isSameCommand(command, quality.command) || TEST_COMMAND.test(command))) {
			call.test = isSameCommand(command, quality.command);
			// Two test runs at once can fight over ports and temp files; the agent's wins.
			this.stopBaseline(quality);
			return;
		}
		if (mayMutateWorkspace(command)) {
			this.noteMutation(session, run);
		}
	}

	private noteCallEnd(run: IRunState, event: Extract<IVoltEvent, { type: 'tool.end' }>): void {
		const quality = run.quality;
		const call = run.calls.get(event.callId);
		if (!quality || !call?.test) {
			return;
		}
		const output = toolOutputText(event);
		const exitCode = event.exitCode ?? exitCodeOf(event.result);
		const report = parseCheckOutput(quality.command, output, event.error ? (exitCode ?? 1) : exitCode ?? null);
		if (report.ok && !event.error) {
			run.lastTestPass = run.events;
		}
		if (!run.lastMutation && !quality.agentBaseline && (report.parsed || report.counts)) {
			quality.agentBaseline = report;
		}
	}

	private noteMutation(session: ISessionState, run: IRunState): void {
		run.lastMutation = run.events;
		if (run.quality) {
			this.stopBaseline(run.quality);
		}
		const root = this.executionRoot(session);
		if (root) {
			this.checkCache.delete(root.toString());
		}
	}

	/** The run changed something (or started its own tests) before Volt's baseline finished: that baseline is void. */
	private stopBaseline(quality: IQualityRun): void {
		if (quality.baselineExecId) {
			quality.tainted = true;
			void this.stdio.cancelExec(quality.baselineExecId).catch(() => undefined);
			quality.baselineExecId = undefined;
		}
	}

	/**
	 * Snapshots the project's test status before the run's changes, so the end of the run can tell
	 * new failures from old ones. Write modes only, projects that declare a test command only, and
	 * only when the access policy already lets that command run without asking: Volt never prompts
	 * for its own checks. A cached result for the same files is reused.
	 */
	private startQualityGate(session: ISessionState, run: IRunState): void {
		if (!modePolicy(run.mode).allowWrites) {
			return;
		}
		const root = this.executionRoot(session);
		if (!root) {
			return;
		}
		void this.projectChecksFor(root).then(checks => {
			const command = checks.test;
			if (!command || !this.isCurrent(session, run) || !this.policyAllows(session, run, command)) {
				return;
			}
			const rootKey = root.toString();
			const quality: IQualityRun = { root, rootKey, command, baseline: Promise.resolve(undefined), tainted: false };
			run.quality = quality;
			const cached = this.checkCache.get(rootKey);
			if (cached && isSameCommand(cached.command, command)) {
				quality.baseline = Promise.resolve(cached);
				return;
			}
			if (run.lastMutation || this.slowChecks.has(rootKey)) {
				return;
			}
			const id = `volt-check-${generateUuid()}`;
			quality.baselineExecId = id;
			quality.baseline = this.runCheck(root, command, id).then(report => {
				if (quality.baselineExecId === id) {
					quality.baselineExecId = undefined;
				}
				if (!report || quality.tainted) {
					return undefined;
				}
				if (report.durationMs > SLOW_CHECK_MS) {
					this.slowChecks.add(rootKey);
				}
				this.cacheCheck(root, report);
				return report;
			});
		}, err => this.logService.trace('[volt] project checks unavailable', err));
	}

	/**
	 * Called when the engine wants to stop. Runs the tests again if the run changed files (unless the
	 * agent already ran the same command after its last change and it passed), compares with the
	 * baseline, and looks at open to-dos. Returns the message that sends the agent back, at most once
	 * per reason, or undefined to let it stop.
	 */
	private async qualityContinuation(session: ISessionState, run: IRunState): Promise<string | undefined> {
		if (!this.isCurrent(session, run) || run.cancel.token.isCancellationRequested) {
			return undefined;
		}
		const writes = modePolicy(session.mode).allowWrites;
		const quality = run.quality;
		let verdict: ReturnType<typeof regressionVerdict> | undefined;
		let after: ICheckReport | undefined;
		if (writes && quality && !run.continued.regression && run.lastMutation && run.lastTestPass < run.lastMutation) {
			const before = await quality.baseline ?? quality.agentBaseline;
			if (before && this.isCurrent(session, run)) {
				after = await this.runCheck(quality.root, quality.command, `volt-check-${generateUuid()}`, run.cancel.token);
				if (after && this.isCurrent(session, run)) {
					verdict = regressionVerdict(before, after);
					run.regressed = verdict.regressed;
					this.cacheCheck(quality.root, after);
				}
			}
		}
		if (!this.isCurrent(session, run)) {
			return undefined;
		}
		const decision = decideContinuation({ writes, verdict, after, todos: run.plan, used: run.continued });
		if (!decision.message) {
			return undefined;
		}
		for (const reason of decision.reasons) {
			run.continued[reason] = true;
		}
		run.metrics.noteContinuation();
		this.logService.info(`[volt] run ${run.runId} continues: ${decision.reasons.join(', ')}`);
		this.emit(session, run.runId, { type: 'notice', severity: 'info', title: decision.notice ?? 'Asking the agent to continue.', description: 'Volt check' });
		return decision.message;
	}

	private projectChecksFor(root: URI): Promise<IProjectChecks> {
		const key = root.toString();
		const cached = this.projectChecks.get(key);
		if (cached && Date.now() - cached.at < 30_000) {
			return cached.value;
		}
		const value = loadProjectCheckFiles(this.fileService, root).then(detectProjectChecks);
		this.projectChecks.set(key, { at: Date.now(), value });
		return value;
	}

	/** The policy lets `command` run in this chat's mode without asking anyone. No receipts, no prompts. */
	private policyAllows(session: ISessionState, run: IRunState, command: string): boolean {
		const request: IAccessRequest = {
			id: generateUuid(),
			sessionId: session.sessionId,
			runId: run.runId,
			providerId: 'volt',
			action: 'shell',
			resource: { type: 'command', value: command },
			risk: classifyRisk('shell', command),
			createdAt: Date.now(),
		};
		const policy: ICompiledPolicy = { ...this.compiledPolicy, overlay: compilePolicy({ overlay: modeOverlay(session.mode) }).overlay };
		return evaluateAccess(request, policy, { accessMode: this.accessMode }).effect === 'allow';
	}

	private async runCheck(root: URI, command: string, id: string, token?: CancellationToken): Promise<ICheckReport | undefined> {
		const listener = token?.onCancellationRequested(() => void this.stdio.cancelExec(id).catch(() => undefined));
		try {
			const result = await this.stdio.exec({ id, command, cwd: root.fsPath, timeoutMs: CHECK_TIMEOUT_MS, inlineChars: CHECK_INLINE_CHARS, env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
			if (result.cancelled || token?.isCancellationRequested) {
				return undefined;
			}
			const report = parseCheckOutput(command, result.combined || `${result.stdout}\n${result.stderr}`, result.exitCode, result.durationMs, result.timedOut);
			this.logService.info(`[volt check] \`${command}\` in ${root.fsPath}: ${report.timedOut ? 'timed out' : report.ok ? 'passed' : 'failed'}${report.counts ? ` (${report.counts.pass} passed, ${report.counts.fail} failed)` : ''} in ${report.durationMs}ms`);
			return report;
		} catch (err) {
			this.logService.trace(`[volt] project check \`${command}\` could not run`, err);
			return undefined;
		} finally {
			listener?.dispose();
		}
	}

	/** Only folders the workbench watches: an unwatched checkout could change without the cache hearing of it. */
	private cacheCheck(root: URI, report: ICheckReport): void {
		if (!report.timedOut && this.workspace.isInsideWorkspace(root)) {
			this.checkCache.set(root.toString(), report);
		}
	}

	private invalidateChecks(resources: readonly URI[]): void {
		if (!this.checkCache.size) {
			return;
		}
		for (const key of [...this.checkCache.keys()]) {
			const root = URI.parse(key);
			if (resources.some(resource => isEqualOrParent(resource, root) && !CHECK_NOISE.test(resource.path.slice(root.path.length)))) {
				this.checkCache.delete(key);
			}
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
			provider.setQuestionAsker((sessionId, runId, draft) => this.askQuestions(sessionId, runId, draft));
			provider.setSupervisionOptions(ACP_SUPERVISION);
			this.agentProviders.set(provider.id, provider);
		}
		const generic = new AcpAgentProvider('acp-generic', 'Agent', 'agent', ['acp'], this.stdio, this.workspace, this.fileService, this.logService, this.hostTools);
		generic.setAccessGate(this.accessGate);
		generic.setFileWriteObserver(write => this.onAcpFileWrite(write));
		generic.setQuestionAsker((sessionId, runId, draft) => this.askQuestions(sessionId, runId, draft));
		generic.setSupervisionOptions(ACP_SUPERVISION);
		this.agentProviders.set(generic.id, generic);
		this._register(toDisposable(() => {
			for (const provider of this.agentProviders.values()) {
				if (provider instanceof AcpAgentProvider) {
					void provider.disposeSpares().catch(() => undefined);
				}
			}
		}));
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

	/**
	 * The picked model and its options (effort, context, fast) live in application storage, so
	 * every window shares them. Reload when another window writes; otherwise this window keeps a
	 * stale copy and its next write puts the old effort back.
	 */
	private watchSharedModelChoice(): void {
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, VOLT_MODEL_OPTIONS_STORAGE_KEY, this._store)(() => {
			const next = this.readJson<Record<string, IVoltModelOptions>>(VOLT_MODEL_OPTIONS_STORAGE_KEY, {});
			if (JSON.stringify(next) === JSON.stringify(this.modelOptions)) {
				return;
			}
			this.modelOptions = next;
			this._onDidChangeCatalog.fire();
		}));
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, this._store)(() => {
			const next = this.storageService.get(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
			if (next === this.activeCatalogRef) {
				return;
			}
			this.activeCatalogRef = next;
			this._onDidChangeActiveCatalog.fire();
		}));
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
		for (const [id, pending] of [...this.pendingQuestions]) {
			if (pending.request.sessionId === sessionId) {
				this.respondToQuestions(id, { outcome: 'cancelled', answers: [] });
			}
		}
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
		for (const spare of this.agentPool.readySpares()) {
			await this.agentProviders.get(spare.providerId)?.applyAccessPolicy?.(spare.handle, this.compiledPolicy);
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

/**
 * Streams `open(token)` with a token that cancels with `parent` and when `signal` aborts (the loop
 * gave up on a stalled or runaway stream), so the provider tears its HTTP request down.
 */
async function* linkedStream<T>(parent: CancellationToken, signal: AbortSignal | undefined, open: (token: CancellationToken) => AsyncIterable<T>): AsyncIterable<T> {
	if (!signal) {
		yield* open(parent);
		return;
	}
	const source = new CancellationTokenSource(parent);
	const onAbort = () => source.cancel();
	signal.addEventListener('abort', onAbort);
	if (signal.aborted) {
		source.cancel();
	}
	try {
		yield* open(source.token);
	} finally {
		signal.removeEventListener('abort', onAbort);
		source.dispose();
	}
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
 * Turns an ACP agent has not seen (the user was on another model, or its process was replaced),
 * newest kept within a token budget, so switching models keeps the thread instead of starting
 * over, without sending a second prompt's worth of history.
 */
function conversationRecap(messages: readonly { role: string; content: string; model?: string }[]): string | undefined {
	const turns = messages.filter(message => message.content.trim() && message.role !== 'system');
	if (!turns.length) {
		return undefined;
	}
	const lines: string[] = [];
	let used = 0;
	for (let i = turns.length - 1; i >= 0 && used < RECAP_TOKENS; i--) {
		const text = turns[i].content.trim();
		const clipped = text.length > RECAP_MESSAGE_CHARS ? `${text.slice(0, RECAP_MESSAGE_CHARS)} [...]` : text;
		const speaker = turns[i].role === 'assistant' ? (turns[i].model ? `Assistant (${turns[i].model})` : 'Assistant') : 'User';
		lines.unshift(`${speaker}: ${clipped}`);
		used += estimateTokens(clipped);
	}
	return [
		'<conversation_so_far>',
		'This conversation started with another model. Here is what was said before this message; continue from it.',
		...lines,
		'</conversation_so_far>',
	].join('\n');
}

const TITLE_TIMEOUT_MS = 30_000;
/** Commit messages and pull request descriptions read a diff, so they get longer than a title. */
const GENERATED_TEXT_TIMEOUT_MS = 90_000;

function quoteShellArg(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Names the intent router and effort heuristics see for a message's attachments. */
function attachmentNames(request: IVoltSendRequest): string[] {
	return [...(request.mentions ?? []), ...(request.images ?? []).map((image, index) => image.name ?? `Image${index + 1}`)];
}

/** A test runner invocation, for telling the agent's own test runs apart from other commands. */
const TEST_COMMAND = /\b(?:jest|vitest|mocha|ava|pytest|rspec|phpunit|go test|cargo test|dotnet test|node --test)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i;

/** The shell command of an execute call: `command` in its input, else the title without backticks. */
/** The `--model` an agent CLI takes for a pinned text generation model, or undefined for its default. */
function titleAgentModel(item: IVoltCatalogItem): string | undefined {
	const id = item.providerId === 'cursor-acp' ? normalizeCursorModelId(item.id) : item.id;
	return id && id !== 'default' && id !== 'auto' ? id : undefined;
}

function commandOfCall(input: string, title: string | undefined): string | undefined {
	if (input.trim()) {
		try {
			const parsed = JSON.parse(input) as Record<string, unknown>;
			const command = parsed.command ?? parsed.cmd;
			if (typeof command === 'string' && command.trim()) {
				return command.trim();
			}
			if (Array.isArray(command) && command.every(part => typeof part === 'string')) {
				return command.join(' ');
			}
		} catch {
			return input.trim();
		}
	}
	const fromTitle = title?.replace(/^`+|`+$/g, '').trim();
	return fromTitle || undefined;
}

/** A tool result as plain text: native results carry `output`; ACP results nest text in content blocks. */
function toolOutputText(event: Extract<IVoltEvent, { type: 'tool.end' }>): string {
	if (typeof event.output === 'string') {
		return event.output;
	}
	const parts: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (depth > 6 || value === null || value === undefined) {
			return;
		}
		if (typeof value === 'string') {
			parts.push(value);
		} else if (Array.isArray(value)) {
			value.forEach(item => visit(item, depth + 1));
		} else if (typeof value === 'object') {
			const record = value as Record<string, unknown>;
			for (const key of ['text', 'stdout', 'stderr', 'output', 'content', 'formattedOutput']) {
				visit(record[key], depth + 1);
			}
		}
	};
	visit(event.result, 0);
	return parts.join('\n');
}

function exitCodeOf(result: unknown, depth = 0): number | undefined {
	if (!result || typeof result !== 'object' || depth > 4) {
		return undefined;
	}
	const record = result as Record<string, unknown>;
	for (const key of ['exitCode', 'exit_code', 'code']) {
		if (typeof record[key] === 'number') {
			return record[key] as number;
		}
	}
	for (const value of Object.values(record)) {
		const found = exitCodeOf(value, depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
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
