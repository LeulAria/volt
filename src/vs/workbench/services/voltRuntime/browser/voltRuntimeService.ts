/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { inlineResourceContext } from '../common/fileAttachments.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { DeferredPromise, disposableTimeout, IntervalTimer, raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
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
import { PREDICTOR_SKILL, predictorRequest, PredictorTask } from '../common/prediction/predictorSkill.js';
import { IPredictorLaunch, PredictorAgent } from './prediction/predictorAgent.js';
import { normalizeCursorModelId } from '../common/harness/cursorQuota.js';
import { IVoltSessionContextService } from '../common/sessionContext.js';
import './sessionContextService.js';
import { ISearchService } from '../../search/common/search.js';
import { evaluateAccess, memoKey } from '../common/access/accessBroker.js';
import { DEFAULT_ACCESS_MODE, isVoltAccessMode, normalizeVoltAccessMode, VOLT_ACCESS_CHATS_STORAGE_KEY, VOLT_ACCESS_MODE_STORAGE_KEY, VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, VoltAccessMode } from '../common/access/accessModes.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../common/access/accessPresets.js';
import { AccessDecisionScope, IAccessDecision, IAccessGate, IAccessRequest, ICompiledPolicy, IExecutionReceipt, IPermissionRule, PermissionEffect } from '../common/access/accessTypes.js';
import { compilePolicy } from '../common/access/policyCompiler.js';
import { accessBridgeFor } from './agents/bridges/accessBridges.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../common/capabilities.js';
import { IVoltEvent, IVoltEventEnvelope } from '../common/events.js';
import { IVoltModelOptions, MODEL_OPTION_REASONING, pickGenerationParams, resolveModelOptions, VOLT_MODEL_OPTIONS_STORAGE_KEY } from '../common/models/modelOptions.js';
import { modePolicy, VoltMode } from '../common/modes.js';
import { isCatalogModelEnabled, setCatalogModelEnabled } from '../common/models/modelVisibility.js';
import { displayProviderLabel, IProviderProfile, IProviderProfileDraft, secretKeyForProfile, VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, VOLT_CATALOG_REVISION, VOLT_CATALOG_REVISION_STORAGE_KEY, VOLT_CATALOG_STORAGE_KEY, VOLT_DEFAULT_HEALTH_INTERVAL, VOLT_DISABLED_MODELS_STORAGE_KEY, VOLT_ENABLED_MODELS_STORAGE_KEY, VOLT_HEALTH_INTERVAL_STORAGE_KEY, VOLT_MODE_PROFILES_STORAGE_KEY, VOLT_PROFILES_STORAGE_KEY, VOLT_SANDBOX_STORAGE_KEY, VOLT_SEED_VERSION_STORAGE_KEY, VOLT_TASK_MODELS_STORAGE_KEY } from '../common/profiles.js';
import { IAgentDetectResult, IAgentMessage, IAgentProvider, IAgentSandboxStart, IAgentSessionHandle, IAgentStartRequest, IDetectResult, IModelImage, IModelInfo, IModelMessage, IModelProvider, IModelRequest, IVoltCatalogItem, IVoltProviderStatus, VoltProviderState } from '../common/providers.js';
import { DEFAULT_SANDBOX_SETTINGS, IVoltSandboxSettings, normalizeSandboxSettings, sandboxLaunchKey, sandboxWorkspaceRoots } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { cheapestReasoningLevel, resolveTabModel } from '../common/models/modelAccess.js';
import { IAgentRuntimeService, IVoltAgentBackgroundTask, IVoltCompactionPlan, IVoltMcpServerStatus, IVoltSeedMessage, IVoltSeedOptions, IVoltTaskModels } from '../common/runtime.js';
import { countUserTurns, IVoltImageAttachment, IVoltSendRequest, IVoltSession } from '../common/session.js';
import { Schemas } from '../../../../base/common/network.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltCodeIndexService } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { codeIndexEnabled, INSTANT_GREP_TOOL_NAME, lspAllowedFor, readCodeIndexOptions, readFffSettings, readRtkExclusions, retrievalEnabled, rtkEnabled } from '../common/codeIntelligence.js';
import { ContextRetriever, IRetrievedContext, parsePorcelainZ } from './search/contextRetriever.js';
import { ISearchIndex, VoltSearch } from './search/voltSearch.js';
import { IAgentWorktreeSetupService } from '../common/git/worktreeSetupPlan.js';
import { agentCompactionPrompt, compactedHistory, compactInstructions, isCompactCommand } from '../common/compaction.js';
import { buildContextHandoff, compactionBudget, handoffBudget, HANDOFF_BUDGET_PERCENT_SETTING, HANDOFF_MAX_TOKENS_SETTING, handoffPath, handoffToolCall, HandoffReason, IContextHandoff, IHandoffActivity, IHandoffFile, IHandoffToolCall } from '../common/contextHandoff.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import './git/agentWorktreeSetupService.js';
import { withPlanModeInstruction } from '../common/plans.js';
import { ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, IVoltHostToolApproval, IVoltHostToolInvocation, IVoltHostToolService, VISUAL_TOOL_NAMES } from '../common/hostTools.js';
import { IVoltMemoryService } from '../common/memory/voltMemory.js';
import { AgentQuestionDraft, answeredQuestions, IAgentQuestionRequest, IAgentQuestionResponse } from '../common/questions.js';
import { AcpAgentProvider, IAcpBackgroundTask, IAcpFileWrite, IAcpSupervisionOptions } from './agents/acpProvider.js';
import { AcpLoopDetector } from '../common/harness/acpLoopDetector.js';
import { LOOP_NOTICE_TITLE } from '../common/harness/supervisor.js';
import { DeepseekDirective, IDeepseekStep, IDeepseekStreamOptions, PROMPT_CACHE_KEEPALIVE_SETTING, runDeepseekLoop, watchedStream } from '../common/deepseek/loop.js';
import { EditBaselineTracker } from './editBaselines.js';
import './host/hostToolService.js';
import './memory/voltMemoryService.js';
import { clearClaudeModelCache } from './agents/claudeCatalog.js';
import { CLI_AGENT_DEFINITIONS, cliAgentDefinition, detectCliAgent } from './agents/cliAgents.js';
import { NullVoltStdioService } from './host/nullStdioService.js';
import { loadProjectCheckFiles, loadWorkspaceRunPlan } from './host/workspaceRunPlan.js';
import { classifyIntent, IIntent, mergeGrantedGroups } from '../common/harness/intent.js';
import { buildAcpLead, IContextPackInput, IEnvironmentFacts } from '../common/harness/contextPack.js';
import { formatPrimerFiles, IPreflightPlan, IPrimerEntry, preflightPlan, PRIMER_SKIP_DIRS, primerCandidate, rankPrimerFiles, selectPrimerFiles } from '../common/harness/preflight.js';
import { formatWorkspaceContext, IWorkspaceSnapshot, WORKSPACE_SNAPSHOT_COMMAND_ID, workspaceContextKey } from '../common/harness/workspaceContext.js';
import { INativeLoopMessage } from '../common/harness/nativeLoop.js';
import { nativeToModelMessages } from '../common/harness/providerMessages.js';
import { PathLocks, runToolBatch } from '../common/harness/toolRuntime.js';
import { estimateTokens, totalTokens } from '../common/harness/contextEngine.js';
import { FileLedger } from '../common/harness/fileLedger.js';
import { alwaysRules, findInstruction, instructionsIndex, ISubagentDoc, rulesForPath } from '../common/harness/instructions.js';
import { IVoltHookRunContext, IVoltHooksService } from '../common/hooks/voltHooks.js';
import './hooks/voltHooksService.js';
import { EVIDENCE_GATE_SETTING, EvidenceObserver, PROOF_REVIEW_SETTING, resolveProofGate } from '../common/harness/evidenceObserver.js';
import { EXPERIENCE_SYSTEM, experienceRecord, experienceRequest, LEARN_FROM_RUNS_SETTING, lessonMemory, parseExperience, shouldReflect } from '../common/harness/experience.js';
import { searchArchivedHistory } from '../common/harness/historySearch.js';
import { parseStateOps, renderStateRead } from '../common/harness/appState.js';
import { AgentAppStateStore } from './state/agentAppState.js';
import { applyCompaction, clearOldToolResults, COMPACTION_SYSTEM, compactionBoundary, compactionRequest, DEFAULT_COMPACTION, dropBoundReasoning, effectiveWindow, ICarryForward, inContextCompactionRequest, isClearedToolResult, isVoltNote, mechanicalSummary, MIN_IN_CONTEXT_SUMMARY_CHARS, promptPrefixKey, pruneImages, serializeForSummary, shouldCompact, shouldCompactEarly } from '../common/harness/nativeCompaction.js';
import { chooseEffort, EffortLevel, higherEffort } from '../common/deepseek/effort.js';
import { IToolDocuments, runtimeToolDocuments } from './tools/fileTools.js';
import { ISubagentRequest, NATIVE_ASK_QUESTION_TOOL_NAME } from './tools/metaTools.js';
import { createRuntimeCodeIntel, IRuntimeCodeIntel } from './host/codeIntelHost.js';
import { McpHost } from './host/mcpHost.js';
import { INativeBackgroundAgent, INativeJournalEntry, NativeJournal } from './history/nativeJournal.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { affectsInstructions, IInstructionsSnapshot, loadInstructions } from './prompt/instructionsLoader.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { posix } from '../../../../base/common/path.js';
import { isEqual, isEqualOrParent, joinPath, relativePath } from '../../../../base/common/resources.js';
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
import { IProofReview, IReceiptLine, IRunReceipt, isReceiptWorthShowing, NO_CODE_IMPACT, receiptSummary } from '../common/harness/proofOfDone.js';
import { PROOF_REVIEW_SYSTEM, parseProofReview, proofReviewRequest, reviewDiff } from '../common/harness/proofReview.js';
import { decideContinuation, detectProjectChecks, ICheckReport, IProjectChecks, isSameCommand, ITodoEntry, mayMutateWorkspace, parseCheckOutput, regressionVerdict } from '../common/harness/verification.js';
import { AgentPool, ISpareRequest } from './agentPool.js';
import { RunTraceJournal } from './history/runTraceJournal.js';
import { ProofCaseJournal } from './history/proofCases.js';
import { isAcpTurnRestartable } from '../common/harness/sessionRetry.js';
import { TaskLifecycle } from '../common/harness/lifecycle.js';
import { IToolCall, IToolContext, IToolResult, IVoltTool, toolSchemas } from '../common/tools/tool.js';
import { deepseekKnobs, resolveApproval } from '../common/deepseek/approval.js';
import { VoltLlmAdapter } from './deepseek/voltLlmAdapter.js';
import { buildSubagentPrompt, customSubagentPrompt, nativeModelTurn } from '../common/deepseek/prompt.js';
import { ApprovalOutcome, StreamChunk } from '../common/deepseek/protocol.js';
import { endToolRun, ITrajectoryRequest, ITrajectoryRequestInput, recordStream, startToolRun } from '../common/harness/trajectory.js';
import { IVoltTrajectoryService } from '../common/trajectory.js';
import './trajectoryService.js';
import { turnWriteGate } from '../common/turnWriteGate.js';
import { createBuiltinTools } from './tools/registry.js';
import { loadProjectInstructions } from './prompt/projectInstructions.js';
import { IRunPlan } from '../common/runPlan.js';
import { isWindows, isMacintosh } from '../../../../base/common/platform.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import { createCompatProvider, createLMStudioProvider, createOpenAIProvider, createOpenRouterProvider } from './providers/openaiCompat.js';

const RECEIPT_LIMIT = 500;
/** Below this many files ripgrep is quick enough that CLI agents need no hint about instant_grep. */
const LARGE_INDEXED_PROJECT_FILES = 2_000;
/** Per-chat access picks kept; the oldest fall back to the default. */
const ACCESS_CHATS_LIMIT = 500;
/** Access-broker session id for the predictor agent (Tab, composer ghost text, dictation). */
const TAB_PREDICTION_SESSION_ID = 'volt-tab-prediction';

/** Bumped whenever the built-in profile list changes so existing installs pick it up. */
const CLI_SEED_VERSION = 5;

/** Idle chat agents kept warm per window, most recently used first. */
const MAX_IDLE_AGENTS = 3;
/** An idle chat agent older than this is stopped even within the cap. */
const IDLE_AGENT_TTL_MS = 15 * 60_000;
const IDLE_AGENT_CHECK_MS = 60_000;
/** Appended to a native fast-lane request: a small change is edited, checked and answered without a test run or browser. */
const FAST_LANE_NOTE = '[Volt] Small, well-scoped change: make the edit, check the files you changed for errors, and answer in a line or two. No test runs, builds, servers or browser unless the user asked for them.';
/** The second opinion's wait: past it the run finishes with its items claimed, not reviewed. */
const PROOF_REVIEW_TIMEOUT_MS = 90_000;
/** A changed file larger than this is named in the review diff, not read. */
const PROOF_REVIEW_FILE_BYTES = 512 * 1024;
/** Native model transcripts kept in memory between runs (the most recently run chats). */
const MAX_WARM_NATIVE = 4;
/** A native transcript idle this long goes to disk only; its chat's next run reads it back. */
const NATIVE_IDLE_TTL_MS = 15 * 60_000;
/** Warm spare agents for new chats (see AgentPool), across all models and folders. */
const MAX_SPARE_AGENTS = 2;
const SPARE_AGENT_TTL_MS = 10 * 60_000;
/** How long a new run waits for a cancelled one to let go of its agent session. */
const SETTLE_WAIT_AGENT_MS = 3_000;
const SETTLE_WAIT_NATIVE_MS = 1_500;
/** A deferred health check runs this long after the last run ends, not on top of a follow-up. */
const HEALTH_AFTER_RUN_MS = 15_000;
/** A health tick lists the CLIs' models again only this often (each list starts a throwaway agent). */
const MODEL_RELIST_MS = 6 * 60 * 60_000;
/** With saved detections, the startup check of every CLI runs this long after launch. */
const STARTUP_DETECT_DELAY_MS = 60_000;
/** CLI detections (`--version`, auth status for every CLI) this fresh are not repeated by a health tick or a relaunch. */
const DETECT_TTL_MS = 30 * 60_000;
const VOLT_DETECTIONS_STORAGE_KEY = 'volt.runtime.detections';
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
	/** How the request was classified (lane, budget, signals). */
	intent?: IIntent;
	/** Native: the transcript this run appends to. Detached from the session when the run is cancelled. */
	transcript?: INativeLoopMessage[];
	/** The latest to-do list the engine reported. */
	plan?: readonly ITodoEntry[];
	/** Engine event count at the last workspace change (0: none yet), and at the last passing run of the exact test command. */
	lastMutation: number;
	lastTestPass: number;
	/** A shell command that may have changed files ran: the changed-file list alone does not show what it touched. */
	shellMutated?: boolean;
	events: number;
	/** Tool calls in flight: what is known about each so far (ACP agents fill it in over several updates). */
	readonly calls: Map<string, { kind?: string; input: string; title?: string; classified?: boolean; test?: boolean }>;
	quality?: IQualityRun;
	/** The agent came from the pool or a cold start: a spare like it helps the next new chat. */
	spare?: ISpareRequest;
	/** Reasons this run was already sent back for (each at most once). */
	readonly continued: { regression: boolean; todos: boolean; errors?: number };
	/** Agent runs: files the agent changed, with their error counts before (for the new-errors check). */
	changedFiles?: Map<string, { readonly uri: URI; readonly baseline: ReadonlyMap<string, number> }>;
	regressed?: boolean;
	/** What the run did besides talking, kept with its reply for handoffs to other sessions. */
	activity?: { readonly tools: IHandoffToolCall[]; readonly files: IHandoffFile[]; readonly calls: Map<string, { kind?: string; name: string; title?: string; input: string; paths: string[] }> };
	/** Native runs: the proof keeper (evidence, contract, receipt); file changes reach it as they happen. */
	proof?: EvidenceObserver;
}

/** The chat's model, which the second opinion asks with a clean context. */
interface IProofModel {
	readonly provider: IModelProvider;
	readonly profile: IProviderProfile;
	readonly apiKey: string | undefined;
	readonly item: IVoltCatalogItem;
}

/** An agent session the chat moved away from (another model or provider), kept warm to switch back to. */
interface IParkedAgent {
	readonly handle: IAgentSessionHandle;
	readonly providerId: string;
	readonly ref: string;
	readonly cwd: string | undefined;
	/** How many of the chat's `messages` it has seen. */
	readonly synced: number;
	readonly parkedAt: number;
}

type AgentTurnResult =
	| { readonly kind: 'end'; readonly reason: 'done' | 'abort' | 'fail'; readonly assistant: string; readonly incomplete?: 'steps' }
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
	/** The user restarted the agent while a turn held it: the next prompt starts a fresh one. */
	restartPending?: boolean;
	/** Files the context retriever already showed this chat's agent with their code. */
	retrievalSeen?: Set<string>;
	/** Catalog ref the live agent session was started for. */
	agentRef?: string;
	/** Folder the live agent session was started in. A chat moved to another project needs a new one. */
	agentCwd?: string;
	/** Sandbox the live agent process was started under (see sandboxLaunchKey). */
	agentSandboxKey?: string;
	/** Last time the live agent started or finished a run; idle agents are let go oldest first. */
	agentUsedAt?: number;
	/** Last time a native run ended (or its transcript was read back); idle transcripts go to disk oldest first. */
	nativeUsedAt?: number;
	/** One notice after a checkout is created or restored. */
	announceWorktree?: boolean;
	/** The chat moved to another checkout: the next turn opens with this note and notice. */
	moved?: { readonly model: string; readonly announce: string; readonly announced?: boolean };
	/** A title was requested from the first message; set once it landed, so the agent's own titles stop replacing it. */
	titleState?: 'pending' | 'done';
	/** Agent sessions of models the chat moved away from; switching back resumes one with only the turns it missed. */
	parkedAgents?: IParkedAgent[];
	/** The chat was forked from another: its first agent is briefed as a fork. */
	forkedFrom?: string;
	/** The chat started from another chat's queued message: its first agent gets that chat as a condensed handoff. */
	continuedFrom?: IVoltSeedOptions['continuedFrom'];
	/** What the agent last heard about the window around the chat (see workspaceLead). */
	workspaceSent?: { readonly handle: IAgentSessionHandle; readonly key: string };
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
	/** System prompt and tools the transcript's reasoning was produced under (`promptPrefixKey`). */
	prefix?: string;
	/** File locks shared by this chat's runs and subagents, so their edits never interleave. */
	locks: PathLocks;
	/** Tool calls a crash cut off (from the live log): the next run settles them first (`replayInterrupted`). */
	interrupted?: readonly string[];
	/** Tool calls that waited for approval when Volt went down: nothing of them ran, so they are asked about again. */
	unapproved?: readonly string[];
	/** Background subagents still working (saved): a crash restarts them from their own transcripts. */
	background?: INativeBackgroundAgent[];
	/** Background reports in `inbox` the agent has not read yet (saved, so each is delivered once). */
	reports?: Set<string>;
}

/** Takes what waits in the chat's inbox; a background report taken is no longer owed. */
function claimInbox(state: INativeState): string[] {
	const claimed = state.inbox.splice(0, state.inbox.length);
	for (const message of claimed) {
		state.reports?.delete(message);
	}
	return claimed;
}

function journalEntry(state: INativeState): INativeJournalEntry {
	return {
		version: 1,
		messages: state.messages,
		synced: state.synced,
		effort: state.effort,
		todo: state.todo,
		prefix: state.prefix,
		savedAt: Date.now(),
		...(state.background?.length ? { background: state.background } : {}),
		...(state.reports?.size ? { reports: [...state.reports] } : {}),
	};
}

/**
 * The transcript as the live log saves it while a tool batch runs: the results that are in so far
 * follow the model's calls, and the calls still going are named, so a crash cuts off only them.
 */
function liveJournalEntry(state: INativeState, finished: ReadonlyMap<string, IToolResult>, dispatched: ReadonlySet<string>): INativeJournalEntry {
	return withRunningCalls(journalEntry(state), finished, dispatched);
}

/**
 * A saved transcript with the finished results of the batch still running after its calls, and
 * the others named: `running` once dispatched, `pending` while they wait for approval.
 */
function withRunningCalls(entry: INativeJournalEntry, finished: ReadonlyMap<string, IToolResult>, dispatched: ReadonlySet<string>): INativeJournalEntry {
	const open = entry.messages.at(-1);
	const calls = open?.role === 'assistant' ? open.toolCalls ?? [] : [];
	if (!calls.length) {
		return entry;
	}
	const done = calls.flatMap(call => {
		const result = finished.get(call.id);
		return result ? [nativeToolMessage(result)] : [];
	});
	const unfinished = calls.filter(call => !finished.has(call.id));
	const running = unfinished.filter(call => dispatched.has(call.id)).map(call => call.id);
	const pending = unfinished.filter(call => !dispatched.has(call.id)).map(call => call.id);
	return {
		...entry,
		messages: done.length ? [...entry.messages, ...done] : entry.messages,
		...(running.length ? { running } : {}),
		...(pending.length ? { pending } : {}),
	};
}

/**
 * A subagent's saved transcript, ready to go on: calls a crash cut off get the cut-off result,
 * then the note that sends it back to work. `report` when it had already finished its report.
 */
function resumedSubagent(entry: INativeJournalEntry | undefined): { readonly messages?: INativeLoopMessage[]; readonly report?: string } {
	const messages = entry?.messages.slice() ?? [];
	if (!messages.length) {
		return {};
	}
	const last = messages.at(-1)!;
	if (last.role === 'assistant' && !last.toolCalls?.length && last.content.trim()) {
		return { report: last.content.trim() };
	}
	const at = findLastIdx(messages, message => message.role === 'assistant' && !!message.toolCalls?.length);
	if (at >= 0) {
		const answered = new Set(messages.slice(at + 1).filter(message => message.role === 'tool').map(message => message.callId));
		const cut = messages[at].toolCalls!.filter(call => !answered.has(call.id));
		const unstarted = new Set(entry?.pending ?? []);
		let end = at + 1;
		while (end < messages.length && messages[end].role === 'tool') {
			end++;
		}
		messages.splice(end, 0, ...cut.map(call => ({ role: 'tool' as const, content: unstarted.has(call.id) ? NOT_STARTED_BEFORE_RESTART : INTERRUPTED_BY_RESTART, callId: call.id, name: call.name, isError: true })));
	}
	messages.push({ role: 'user', content: SUBAGENT_RESUMED });
	return { messages };
}

function nativeToolMessage(result: IToolResult): INativeLoopMessage {
	return { role: 'tool', content: result.text, callId: result.callId, name: result.name, ...(result.isError ? { isError: true } : {}) };
}

/**
 * pi-durable's replay policy: after a crash, a call that is safe to run twice (a read, a search, a
 * diff) runs again; anything else is reported as cut off, never silently repeated.
 */
function isReplaySafe(tool: IVoltTool | undefined): boolean {
	return !!tool && (!!tool.resumable || (tool.group !== 'meta' && (tool.idempotent ?? tool.parallelSafe)));
}

/** The journal key of a subagent's own transcript: one per call, so a re-run of that call finds it. */
function subagentJournalId(sessionId: string, callId: string): string {
	return `${sessionId}.sub-${(stringHash(callId, 0) >>> 0).toString(36)}`;
}

/** What a subagent is told when a crash cut it off and its call runs again. */
const SUBAGENT_RESUMED = '[Volt] Volt restarted while you were working, so your previous run was cut off part way. Continue the task where you left off (do not redo what is already done), then give your report as asked.';

/** Longest the calls replayed after a crash may take before the rest are reported as cut off. */
const REPLAY_TIMEOUT_MS = 20_000;
const INTERRUPTED_BY_RESTART = 'Volt restarted while this call was running, so it was cut off before it returned. It may have taken effect in part or in full: check its effect first (read the file, git status, list the output), then run it again only if it is still needed.';
const NOT_STARTED_BEFORE_RESTART = 'Volt restarted before this call started, so it did not run. Make it again if it is still needed.';

/** Languages whose editor services report diagnostics worth waiting for. */
const DIAGNOSED_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|c|cc|cpp|h|hpp|php|rb|swift|dart|vue|svelte|css|scss|less|json)$/i;
const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'grep', 'glob', 'diagnostics', 'code_nav', 'git_status', 'git_diff', 'git_log', 'git_show', 'skill', 'state_read'];
/** Claude Code tool names in a subagent's `tools:` list, as Volt's tools. */
const SUBAGENT_TOOL_ALIASES: Record<string, readonly string[]> = {
	read: ['read_file'],
	ls: ['list_dir'],
	grep: ['grep'],
	glob: ['glob'],
	bash: ['shell', 'job_output', 'job_wait', 'job_stop'],
	shell: ['shell', 'job_output', 'job_wait', 'job_stop'],
	edit: ['edit_file'],
	multiedit: ['edit_file'],
	write: ['write_file'],
	delete: ['delete_file'],
	webfetch: ['web_fetch'],
	websearch: ['web_search'],
	todowrite: ['todo'],
	skill: ['skill'],
};
/** Times stop hooks may send the agent back to work in one run. */
const MAX_HOOK_FOLLOWUPS = 5;
/**
 * Skills and rules are kept until a file under an instruction folder changes (file events, or a
 * write through Volt). The age limit only catches edits outside Volt to folders nothing watches.
 */
const INSTRUCTIONS_TTL_MS = 60_000;
/** How long a send waits for MCP servers still connecting. They keep connecting and join the next turn. */
const MCP_SEND_WAIT_MS = 150;

/** What a native turn reads before its request is built. */
interface INativeTurnInputs {
	readonly projectInstructions: string | undefined;
	readonly instructions: IInstructionsSnapshot;
	readonly mcpTools: IVoltTool[];
	readonly memoryContext: string | undefined;
}
/** Recap of turns an agent has not seen, in estimated tokens (a few thousand, not a second prompt). */
/** Sessions a chat keeps warm for switching back (per chat); idle ones go after IDLE_AGENT_TTL_MS. */
const MAX_PARKED_PER_CHAT = 2;

export class AgentRuntimeService extends Disposable implements IAgentRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, ISessionState>();
	private readonly listeners = new Map<string, Set<(e: IVoltEventEnvelope) => void>>();
	private readonly modelProviders = new Map<string, IModelProvider>();
	private readonly agentProviders = new Map<string, IAgentProvider>();
	private profiles: IProviderProfile[] = [];
	private enabled = new Set<string>();
	/** Models turned off in Settings. Survives a catalog refresh, unlike deleting from an empty whitelist. */
	private disabled = new Set<string>();
	private taskModels: IVoltTaskModels = {};
	private activeCatalogRef: string | undefined;
	private modeProfiles: Partial<Record<VoltMode, string>> = {};
	private catalog: IVoltCatalogItem[] = [];
	private catalogLoading = false;
	private catalogRefresh: Promise<void> | undefined;
	private modelOptions: Record<string, IVoltModelOptions> = {};
	private detections = new Map<string, IDetectResult>();
	private readonly detectionsInFlight = new Map<string, Promise<IDetectResult>>();
	private readonly agentModels = new Map<string, IModelInfo[]>();
	private lastProviderCheck: number | undefined;
	/** When the model lists were last fetched (see healthCheck). */
	private modelsListedAt = 0;
	private readonly healthTimer = this._register(new IntervalTimer());
	private providerRefresh: Promise<void> | undefined;
	private providerRefreshAgain = false;
	/** The default for chats that never picked one (Settings). */
	private accessMode: VoltAccessMode = DEFAULT_ACCESS_MODE;
	/** Chats that picked their own access mode from the composer. */
	private accessChats: Record<string, VoltAccessMode> = {};
	private sandboxDefaults: IVoltSandboxSettings = DEFAULT_SANDBOX_SETTINGS;
	private sandboxChats: Record<string, IVoltSandboxSettings> = {};
	private projectRules: IPermissionRule[] = [];
	private savedRules: IPermissionRule[] = [];
	/** One compiled policy per access mode in use; rebuilt when rules change. */
	private readonly policyByMode = new Map<VoltAccessMode, ICompiledPolicy>();
	/** The agent session behind every prediction when an agent serves Tab (see warmPredictor). */
	private readonly predictor: PredictorAgent;
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
	/** API keys by profile id, so a send does not decrypt over IPC every turn. Dropped when the secret changes. */
	private readonly apiKeys = new Map<string, Promise<string | undefined>>();
	/** Chats whose `sessionStart` hooks ran. */
	private readonly hookStartedSessions = new Set<string>();
	/** Times a `stop` hook sent the agent back to work in the current run, per chat. */
	private readonly hookFollowups = new Map<string, number>();
	private readonly codeIntel: IRuntimeCodeIntel;
	private readonly searchIndex: ISearchIndex;
	/** Every search Volt runs: the agent's tools and the context retriever (index, FFF, ripgrep). */
	private readonly search: VoltSearch;
	private readonly retriever: ContextRetriever;
	/** `git status` per root, briefly cached: the retriever ranks changed files up. */
	private readonly workingTreeChangesByRoot = new Map<string, { readonly at: number; readonly value: Promise<ReadonlySet<string>> }>();
	private readonly mcpHost: McpHost;
	private readonly journal: NativeJournal;
	private readonly nativeRestores = new Map<string, Promise<void>>();
	/** Journal keys of the background subagents working in this window. */
	private readonly liveBackground = new Set<string>();
	/** Chats whose finished run is being reflected on (one at a time). */
	private readonly reflecting = new Set<string>();
	/** Each project's shared app state, on disk (`state_read` / `state_update`). */
	private readonly appState: AgentAppStateStore;
	/**
	 * Chats whose native transcript is on disk only, with how many text messages it covered: never
	 * loaded since the chat was opened (seedSession), or let go when idle or forgotten. It is read
	 * back from the journal when the composer is about to send (prewarm) or at the run's start.
	 */
	private readonly releasedNative = new Map<string, number>();
	/** Edits made while a chat's native transcript was on disk only: applied once it is read back. */
	private readonly nativeCuts = new Map<string, { readonly userTurns: number; readonly synced: number }>();
	private readonly evalLedger = new EvalLedger();
	private readonly traces: RunTraceJournal;
	/** Every gated run's request, contract and receipt: the cases an eval replays. */
	private readonly proofCases: ProofCaseJournal;
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
	/** The test run started after a chat's last run ended (exec id), by chat. */
	private readonly postRunChecks = new Map<string, string>();
	/** Title generation waiting for the chat's first reply text, or for the end of its run (see send). */
	private readonly deferredTitles = new Map<string, { readonly start: () => void; readonly until: 'reply' | 'end' }>();

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog: Event<void> = this._onDidChangeCatalog.event;
	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles: Event<void> = this._onDidChangeProfiles.event;
	private readonly _onDidChangeProviderStatus = this._register(new Emitter<void>());
	readonly onDidChangeProviderStatus: Event<void> = this._onDidChangeProviderStatus.event;
	private readonly _onDidChangeAccess = this._register(new Emitter<void>());
	readonly onDidChangeAccess: Event<void> = this._onDidChangeAccess.event;
	private readonly _onDidChangeAgentBackgroundTask = this._register(new Emitter<IVoltAgentBackgroundTask>());
	readonly onDidChangeAgentBackgroundTask: Event<IVoltAgentBackgroundTask> = this._onDidChangeAgentBackgroundTask.event;
	/** Which agent session runs each background task, for stopping it. */
	private readonly backgroundTaskOwners = new Map<string, { readonly provider: AcpAgentProvider; readonly providerSessionId: string }>();
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
		@IVoltMemoryService private readonly memory: IVoltMemoryService,
		@ISearchService private readonly searchService: ISearchService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IAgentWorktreeSetupService private readonly worktreeSetup: IAgentWorktreeSetupService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IPathService private readonly pathService: IPathService,
		@IMarkerService markerService: IMarkerService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVoltHooksService private readonly hooks: IVoltHooksService,
		@IVoltCodeIndexService codeIndexService: IVoltCodeIndexService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoltTrajectoryService private readonly trajectory: IVoltTrajectoryService,
	) {
		super();
		this.codeIntel = this._register(createRuntimeCodeIntel(markerService, textModelService, languageFeaturesService, fileService));
		// Worktrees are outside the workspace folders; their language servers are opt-in (Settings > Code Intelligence).
		this.codeIntel.setLspPolicy(uri => lspAllowedFor(this.configurationService, !this.workspace.isInsideWorkspace(uri)));
		this.searchIndex = {
			service: codeIndexService,
			enabled: () => codeIndexEnabled(this.configurationService),
			options: () => readCodeIndexOptions(this.configurationService),
			fff: () => readFffSettings(this.configurationService),
		};
		this.search = this._register(new VoltSearch(searchService, this.searchIndex, fileService.onDidFilesChange));
		this.retriever = new ContextRetriever(this.search, fileService);
		this.mcpHost = this._register(new McpHost(fileService, stdio, requestService, logService));
		this.journal = this._register(new NativeJournal(joinPath(environmentService.userRoamingDataHome, 'voltNative'), fileService, logService));
		this.traces = this._register(new RunTraceJournal(joinPath(environmentService.userRoamingDataHome, 'voltTraces'), fileService, logService));
		this.proofCases = new ProofCaseJournal(joinPath(environmentService.userRoamingDataHome, 'voltProofs', 'cases.jsonl'), fileService, logService);
		this.appState = new AgentAppStateStore(joinPath(environmentService.userRoamingDataHome, 'voltState'), fileService, logService);
		this.agentPool = this._register(new AgentPool({
			maxSpares: MAX_SPARE_AGENTS,
			ttlMs: SPARE_AGENT_TTL_MS,
			newAlias: () => `volt-pool-${generateUuid()}`,
			onError: err => this.logService.trace('[volt] spare agent failed', err),
		}));
		this.editBaselines = new EditBaselineTracker(fileService, (sessionId, path) => this.editableUri(sessionId, path));
		this.registerProviders();
		this.hostTools.setApprover({ approve: (request, token) => this.approveHostTool(request, token) });
		this._register(fileService.onDidFilesChange(e => {
			const changed = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
			this.invalidateChecks(changed);
			this.invalidateInstructions(changed);
		}));
		this._register(fileService.onDidRunOperation(e => this.invalidateInstructions(e.target ? [e.resource, e.target.resource] : [e.resource])));
		this._register(this.secretStorage.onDidChangeSecret(key => {
			for (const id of [...this.apiKeys.keys()]) {
				if (secretKeyForProfile(id) === key) {
					this.apiKeys.delete(id);
				}
			}
		}));
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
		// One detection pass feeds the catalog too (refreshing both separately probed every CLI
		// twice), and the model lists hydrated from storage are kept so a restart does not respawn
		// each CLI to list models again. With the last run's detections and catalog saved, the
		// pass waits until launch is over: it spawns every CLI (`--version`, auth status).
		const startRefresh = () => {
			this.providerRefresh ??= this.executeProviderRefresh(true).finally(() => {
				this.providerRefresh = undefined;
			});
		};
		if (this.detections.size && this.catalog.length) {
			// Saved detections younger than DETECT_TTL_MS are as good as a fresh check: the health tick takes over.
			if (Date.now() - (this.lastProviderCheck ?? 0) >= DETECT_TTL_MS) {
				this._register(disposableTimeout(startRefresh, STARTUP_DETECT_DELAY_MS));
			}
		} else {
			startRefresh();
		}
		this.scheduleHealthChecks();
		this.predictor = this._register(new PredictorAgent(ref => this.launchPredictor(ref), this.logService));
	}

	/** Each chat keeps its agent process warm for follow-ups; this keeps that from growing without bound. */
	private readonly agentReaper = this._register(new RunOnceScheduler(() => this.releaseIdleAgents(), IDLE_AGENT_CHECK_MS));

	private releaseIdleAgents(): void {
		const now = Date.now();
		// Native transcripts: the few most recently run stay in memory; the rest wait on disk.
		const warm = [...this.sessions.values()]
			.filter(session => session.deepseek && !isRunActive(session) && !(session.run && !session.run.ended))
			.sort((a, b) => (b.nativeUsedAt ?? 0) - (a.nativeUsedAt ?? 0));
		let warmKept = 0;
		for (const session of warm) {
			if (warmKept < MAX_WARM_NATIVE && now - (session.nativeUsedAt ?? 0) < NATIVE_IDLE_TTL_MS) {
				warmKept++;
				continue;
			}
			this.releaseNative(session);
		}
		if (warmKept) {
			this.agentReaper.schedule();
		}
		// Sessions parked by a model switch: kept while fresh, at most MAX_IDLE_AGENTS over all chats.
		const parked = [...this.sessions.values()].flatMap(session => (session.parkedAgents ?? []).map(agent => ({ session, agent })))
			.sort((a, b) => b.agent.parkedAt - a.agent.parkedAt);
		parked.forEach(({ session, agent }, index) => {
			if (index >= MAX_IDLE_AGENTS || now - agent.parkedAt >= IDLE_AGENT_TTL_MS) {
				this.releaseParked(session, candidate => candidate === agent);
			}
		});
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

	/** Disposes the chat's parked agent sessions (all, or those `which` picks). */
	private releaseParked(session: ISessionState, which?: (agent: IParkedAgent) => boolean): void {
		const parked = session.parkedAgents;
		if (!parked?.length) {
			return;
		}
		const released = which ? parked.filter(which) : parked.slice();
		session.parkedAgents = parked.filter(agent => !released.includes(agent));
		for (const agent of released) {
			void this.agentProviders.get(agent.providerId)?.dispose(agent.handle).catch(err => this.logService.trace('[volt] releasing a parked agent failed', err));
		}
	}

	/**
	 * The chat moves to another model: its live agent session stays warm instead of being stopped,
	 * so switching back resumes it with only the turns it missed.
	 */
	private parkSessionAgent(session: ISessionState): void {
		const handle = session.agentHandle;
		const providerId = session.agentProviderId;
		const provider = providerId ? this.agentProviders.get(providerId) : undefined;
		if (!handle || !providerId || !provider || !session.agentRef || !(provider.isLive?.(handle) ?? true)) {
			return;
		}
		session.agentHandle = undefined;
		session.agentProviderId = undefined;
		const parked: IParkedAgent = { handle, providerId, ref: session.agentRef, cwd: session.agentCwd, synced: session.agentSynced ?? 0, parkedAt: Date.now() };
		session.agentRef = undefined;
		session.agentCwd = undefined;
		session.agentSynced = 0;
		// One per model: a newer session of the same model replaces the older one.
		this.releaseParked(session, agent => agent.ref === parked.ref && agent.cwd === parked.cwd);
		session.parkedAgents = [parked, ...session.parkedAgents ?? []];
		this.releaseParked(session, agent => session.parkedAgents!.indexOf(agent) >= MAX_PARKED_PER_CHAT);
		this.agentReaper.schedule();
	}

	/** A parked session of exactly this model and folder that is still alive, taken out of the parking. */
	private takeParkedAgent(session: ISessionState, provider: IAgentProvider, item: IVoltCatalogItem, cwd: string | undefined): IParkedAgent | undefined {
		const parked = session.parkedAgents?.find(agent => agent.providerId === provider.id && agent.ref === item.ref && agent.cwd === cwd);
		if (!parked) {
			return undefined;
		}
		session.parkedAgents = session.parkedAgents!.filter(agent => agent !== parked);
		if (!(provider.isLive?.(parked.handle) ?? true) || parked.synced > session.messages.length) {
			void provider.dispose(parked.handle).catch(() => undefined);
			return undefined;
		}
		return parked;
	}

	/** Stops a chat's idle agent. Its next prompt starts a new one and recaps the conversation. */
	private releaseAgent(session: ISessionState): void {
		const handle = session.agentHandle;
		const provider = session.agentProviderId ? this.agentProviders.get(session.agentProviderId) : undefined;
		session.agentHandle = undefined;
		session.agentProviderId = undefined;
		session.agentRef = undefined;
		session.agentCwd = undefined;
		session.agentSandboxKey = undefined;
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

	seedSession(key: string, messages: readonly IVoltSeedMessage[], options?: IVoltSeedOptions): void {
		const session = this.getOrCreateSession(key) as ISessionState;
		if (options?.forkedFrom) {
			session.forkedFrom = options.forkedFrom;
		}
		if (session.messages.length || session.activeRun) {
			return;
		}
		if (options?.continuedFrom) {
			session.continuedFrom = options.continuedFrom;
		}
		session.messages = messages.filter(message => message.content.trim() || message.activity?.tools.length || message.activity?.files.length).map(message => ({
			role: message.role,
			content: message.content,
			...(message.model ? { model: message.model } : {}),
			...(message.activity ? { activity: message.activity } : {}),
			...(message.compacted ? { compacted: true } : {}),
		}));
		// The saved native transcript carries tool calls and results the text history does not. It is
		// read when this chat is about to run, not when it is opened: browsing chats keeps none in memory.
		if (!session.deepseek) {
			this.releasedNative.set(key, session.messages.length);
		}
	}

	releaseSession(key: string): void {
		const session = this.sessions.get(key);
		// `activeRun` stays set (completed, failed) after a run: only one still going keeps the chat.
		if (!session || isRunActive(session) || (session.run && !session.run.ended)) {
			return;
		}
		this.disposeSessionAgent(session);
		this.releaseParked(session);
		this.releaseNative(session);
		session.retrievalSeen = undefined;
	}

	/** Moves an idle chat's native transcript to disk only; the journal brings it back before its next run. */
	private releaseNative(session: ISessionState): void {
		if (!session.deepseek || isRunActive(session) || (session.run && !session.run.ended)) {
			return;
		}
		// The journal reads the state as it writes, so the pending save goes out before it is dropped.
		void this.journal.release(session.sessionId);
		session.deepseek = undefined;
		session.nativeUsedAt = undefined;
		this.releasedNative.set(session.sessionId, session.messages.length);
		this.nativeRestores.delete(session.sessionId);
	}

	/** A chat whose native transcript is on disk only gets it back from the journal (prewarm, or a run's start). */
	private restoreReleasedNative(session: ISessionState): void {
		const seeded = this.releasedNative.get(session.sessionId);
		if (seeded === undefined) {
			return;
		}
		this.releasedNative.delete(session.sessionId);
		if (session.deepseek?.messages.length) {
			this.nativeCuts.delete(session.sessionId);
			return;
		}
		this.nativeRestores.set(session.sessionId, this.journal.load(session.sessionId).then(entry => {
			const cut = this.nativeCuts.get(session.sessionId);
			this.nativeCuts.delete(session.sessionId);
			if (!entry || session.deepseek?.messages.length) {
				return;
			}
			const state = this.nativeState(session);
			state.messages.push(...entry.messages);
			state.synced = Math.min(entry.synced, seeded);
			state.effort = entry.effort as EffortLevel | undefined;
			state.todo = entry.todo;
			state.prefix = entry.prefix;
			state.interrupted = entry.running;
			state.unapproved = entry.pending;
			if (entry.background?.length) {
				state.background = [...entry.background];
			}
			if (entry.reports?.length) {
				state.reports = new Set(entry.reports);
				state.inbox.push(...entry.reports);
			}
			session.nativeUsedAt = Date.now();
			if (cut) {
				this.cutNative(session.sessionId, state, cut.userTurns, cut.synced);
			}
		}, () => undefined));
	}

	/** Drops native turns from user turn `userTurns` on (an edit and resend, a restored checkpoint). */
	private cutNative(sessionId: string, state: INativeState, userTurns: number, synced: number): void {
		let turns = 0;
		const nativeCut = state.messages.findIndex(message => message.role === 'user' && message.turn && turns++ === userTurns);
		if (nativeCut >= 0) {
			state.messages.splice(nativeCut);
			state.synced = synced;
		} else {
			// Compaction merged the turns; start the model transcript over from the text history.
			state.messages.splice(0);
			state.synced = 0;
		}
		// Steers go with the edited turns; background reports are still owed.
		state.inbox.splice(0, state.inbox.length, ...state.reports ?? []);
		state.ledger.invalidateReferences();
		void this.journal.schedule(sessionId, () => journalEntry(state), true);
	}

	rememberWorktree(sessionId: string, path: string | undefined, branch: string | undefined): void {
		if (!path || !branch) {
			return;
		}
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.worktreePath = path;
		session.worktreeBranch = branch;
	}

	relocate(sessionId: string, path: string | undefined, branch: string | undefined, note: { readonly model: string; readonly announce: string }): boolean {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		if (session.run && !session.run.ended) {
			return false;
		}
		session.worktreePath = path || undefined;
		session.worktreeBranch = path ? branch : undefined;
		session.announceWorktree = false;
		session.moved = note;
		this.history.open(sessionId).setMeta({ worktreePath: path ?? '', ...(path && branch ? { worktreeBranch: branch } : {}) });
		// The live agent keeps its folder until the next turn, which resumes it in the new one (see executeAgent).
		this.logService.info(`[volt] ${sessionId} now works in ${path ?? 'the project checkout'}`);
		return true;
	}

	workingFolder(sessionId: string): string | undefined {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		return this.executionRoot(session)?.fsPath;
	}

	supportsCommand(sessionId: string, name: string): boolean {
		const session = this.sessions.get(sessionId);
		if (name === 'compact') {
			// Every chat can compact: the agent's own /compact, Volt's summarizer, or a hand-off summary.
			return !!session?.messages.some(message => message.role === 'assistant');
		}
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

	async steerAsync(sessionId: string, text: string, images?: readonly IVoltImageAttachment[]): Promise<boolean> {
		if (!images?.length && this.steer(sessionId, text)) {
			return true;
		}
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (!session || !run || !this.agentSteerable(session)) {
			return false;
		}
		const provider = this.agentProviders.get(session.agentProviderId!);
		const delivered = await provider?.steer?.(session.agentHandle!, text, this.modelImages(images)).catch(() => false) ?? false;
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
			const titleItem = pinned ?? catalogItem;
			const start = () => void this.generateTitle(session, request, titleItem, !!pinned);
			if (titleItem?.kind === 'agent') {
				// A CLI title is a process start (`claude -p`, `codex exec`): it waits for the first reply
				// text, or the end of the run, so it does not compete with the turn's own startup.
				this.deferredTitles.set(session.sessionId, { start, until: 'reply' });
			} else if (titleItem && titleItem.profileId === catalogItem?.profileId && servedLocally(this.profiles.find(p => p.id === titleItem.profileId))) {
				// One local server runs one request at a time: sent first, the title would hold up the
				// run's first step, and between steps it would evict the run's cached prompt.
				this.deferredTitles.set(session.sessionId, { start, until: 'end' });
			} else {
				start();
			}
		}
		const engine = catalogItem?.kind === 'agent' ? 'agent' : 'native';
		const run = this.beginRun(session, request.mode, engine, sendAt);
		try {
			await this.prepareWorktree(session, request, () => !this.isCurrent(session, run));
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
		run.intent = intent;
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
		// cursor-agent has no light print mode: a title call carries its whole ~16k-token agent prompt
		// (5 cents on Grok 4.7, measured 2026-10-09). Without a pinned title model the first line stays the title.
		if (!pinned && this.profiles.find(p => p.id === item?.profileId)?.providerId === 'cursor-acp') {
			session.titleState = undefined;
			return;
		}
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
		const run = async (model: string | undefined) => {
			const argv = titleCommandFor(profile.providerId, command, prompt, model);
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
		};
		const chatModel = item ? titleAgentModel(item) : undefined;
		const text = await run(pinned ? chatModel : undefined);
		// The CLI's own default can be a model the account may not use (Codex on a ChatGPT plan):
		// the chat's model is one it runs.
		return text === undefined && !pinned && chatModel ? run(chatModel) : text;
	}

	async generateText(prompt: string, options?: { readonly sessionId?: string; readonly timeoutMs?: number; readonly slot?: 'title' | 'git' }): Promise<string | undefined> {
		const git = options?.slot === 'git' && this.taskModels.git ? this.catalog.find(item => item.ref === this.taskModels.git && item.enabled) : undefined;
		const pinned = git ?? (this.taskModels.title ? this.catalog.find(item => item.ref === this.taskModels.title && item.enabled) : undefined);
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
		const apiKey = await this.apiKey(profile);
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
	 * bound to this chat until a send adopts it. For a native model it fills the caches a send
	 * reads before its request instead (see prewarmNative).
	 */
	prewarmAgent(sessionId: string, providerRef: string | undefined, mode: VoltMode): void {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		if (session.run && !session.run.ended) {
			return;
		}
		const ref = providerRef ?? session.providerRef ?? this.defaultRef(mode);
		const item = this.catalog.find(candidate => candidate.ref === ref && candidate.enabled);
		const profile = item ? this.profiles.find(candidate => candidate.id === item.profileId) : undefined;
		if (item && profile && item.kind !== 'agent') {
			this.prewarmNative(session, profile, mode);
			return;
		}
		const provider = profile ? this.agentProviders.get(profile.providerId) : undefined;
		if (!item || item.kind !== 'agent' || !profile || !provider) {
			return;
		}
		const cwd = this.executionRoot(session)?.fsPath;
		if (session.agentHandle && session.agentRef === item.ref && session.agentCwd === cwd && session.agentSandboxKey === this.sandboxKey(session.sessionId) && (provider.isLive?.(session.agentHandle) ?? true)) {
			return;
		}
		const sandbox = this.sandboxStart(session.sessionId, cwd);
		const spare = this.spareRequest(provider, profile, item, cwd, undefined, sandbox);
		if (this.agentPool.has(spare.key)) {
			return;
		}
		// A spare under an alias serves whichever chat sends first, but its browser tools reach the
		// chat only when the host tool service follows aliases. Otherwise park one for this chat in
		// the provider (its host MCP URL names the chat), which `start` adopts.
		const perChat = provider as IAgentProvider & Partial<Pick<AcpAgentProvider, 'prewarmSpare' | 'hasSpare'>>;
		if (!this.aliasHost() && perChat.prewarmSpare && perChat.hasSpare) {
			// One chat in view at a time: stop spares other providers parked for chats left behind.
			for (const other of this.agentProviders.values()) {
				if (other !== provider) {
					(other as Partial<Pick<AcpAgentProvider, 'releaseSpares'>>).releaseSpares?.(session.sessionId);
				}
			}
			const request = this.agentStartRequest(session.sessionId, profile, item, cwd, undefined, mode, sandbox);
			if (!perChat.hasSpare(request)) {
				void perChat.prewarmSpare(request);
			}
			return;
		}
		this.agentPool.ensure(spare);
	}

	/**
	 * A native model's warm-up: fills what a send reads before its request (skills and rules,
	 * project instructions, memory, hook definitions, the API key) and starts MCP servers, so the
	 * send finds them cached. Every part is cached and shared, so calling this on each focus is cheap.
	 */
	private prewarmNative(session: ISessionState, profile: IProviderProfile, mode: VoltMode): void {
		// The composer is about to send: read the chat's native transcript now, not on the send.
		this.restoreReleasedNative(session);
		const root = this.executionRoot(session);
		void this.nativeTurnInputs(root, modePolicy(mode).allowMcp);
		void this.hooks.definitions(root?.fsPath).catch(() => undefined);
		void this.apiKey(profile).catch(() => undefined);
	}

	private agentStartRequest(sessionId: string, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined, mode: VoltMode, sandbox?: IAgentSandboxStart): IAgentStartRequest {
		return {
			sessionId,
			mode,
			profile,
			cwd,
			modelId: item.id === profile.providerId ? undefined : item.id,
			options: this.resolvedOptions(item, options),
			...(sandbox ? { sandbox } : {}),
		};
	}

	private sandboxKey(sessionId: string): string {
		return sandboxLaunchKey(this.getSandboxSettings(sessionId));
	}

	/** The chat's sandbox as an agent start asks for it; undefined when the chat runs unconfined. */
	private sandboxStart(sessionId: string, cwd: string | undefined): IAgentSandboxStart | undefined {
		const settings = this.getSandboxSettings(sessionId);
		if (settings.level === 'off') {
			return undefined;
		}
		const session = this.sessions.get(sessionId) as ISessionState | undefined;
		const project = session ? this.projectRoot(session)?.fsPath : undefined;
		return { settings, workspaceRoots: sandboxWorkspaceRoots(cwd, project, !!session?.worktreePath) };
	}

	/** Pool key: an agent can serve a chat when all of these match. */
	private poolKey(provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined, sandbox: IAgentSandboxStart | undefined): string {
		const resolved = this.resolvedOptions(item, options);
		const sorted = Object.keys(resolved).sort().map(key => [key, resolved[key]]);
		return JSON.stringify([provider.id, profile.id, item.ref, cwd ?? '', sorted, sandboxLaunchKey(sandbox?.settings)]);
	}

	private spareRequest(provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, cwd: string | undefined, options: IVoltModelOptions | undefined, sandbox: IAgentSandboxStart | undefined): ISpareRequest {
		return {
			key: this.poolKey(provider, profile, item, cwd, options, sandbox),
			providerId: provider.id,
			start: async alias => {
				const handle = await provider.start(this.agentStartRequest(alias, profile, item, cwd, options, 'agent', sandbox));
				try {
					await provider.applyAccessPolicy?.(handle, this.policyFor(undefined));
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
		const handle = await provider.start(this.agentStartRequest(session.sessionId, profile, item, cwd, options, mode, this.sandboxStart(session.sessionId, cwd)));
		if (!this.isCurrent(session, run) && session.agentHandle) {
			// A newer run already has an agent; this cancelled run's start is not needed.
			void provider.dispose(handle).catch(() => undefined);
			return;
		}
		this.disposeSessionAgent(session);
		this.bindAgent(session, provider, item, cwd, handle);
		await provider.applyAccessPolicy?.(handle, this.policyFor(session.sessionId));
	}

	private bindAgent(session: ISessionState, provider: IAgentProvider, item: IVoltCatalogItem, cwd: string | undefined, handle: IAgentSessionHandle): void {
		session.agentHandle = handle;
		session.agentProviderId = provider.id;
		session.agentRef = item.ref;
		session.agentCwd = cwd;
		session.agentSandboxKey = this.sandboxKey(session.sessionId);
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
			this.cutNative(sessionId, state, userTurns, session.messages.length);
		} else if (this.releasedNative.has(sessionId) || this.nativeRestores.has(sessionId)) {
			// The transcript is on disk only (or still being read): the cut waits for it. The earliest cut wins.
			const previous = this.nativeCuts.get(sessionId);
			if (!previous || userTurns < previous.userTurns) {
				this.nativeCuts.set(sessionId, { userTurns, synced: session.messages.length });
			}
		}
		// An ACP agent cannot forget turns; the next message starts a fresh agent with a recap.
		if (session.agentHandle && (session.agentSynced ?? 0) > session.messages.length) {
			this.disposeSessionAgent(session);
			session.agentSynced = 0;
		}
		this.releaseParked(session, agent => agent.synced > session.messages.length);
	}

	async restartAgent(sessionId: string, options?: { readonly cancel?: boolean }): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		const run = session?.run;
		if (run && !run.ended && !options?.cancel) {
			this.logService.info(`[volt] not restarting the agent of ${sessionId}: a turn is running`);
			return false;
		}
		this.forgetAgentSetup();
		if (!session) {
			// Nothing started yet: the chat's first agent reads the new setup anyway.
			return true;
		}
		// Set before the cancel: a queued prompt that starts while this turn unwinds starts fresh too.
		session.restartPending = true;
		if (run && !run.ended) {
			await this.cancel(sessionId);
		}
		// A cancelled turn holds its agent until it unwinds; disposing it under the turn would race it.
		await this.waitSettled(run, SETTLE_WAIT_AGENT_MS);
		if (session.restartPending && !(session.run && !session.run.ended)) {
			session.restartPending = false;
			this.releaseAgent(session);
		}
		// Parked sessions started with the old setup too.
		this.releaseParked(session);
		return true;
	}

	/**
	 * Drops what a fresh agent would reuse instead of reading again: spares started with the old
	 * setup, skills and rules read a moment ago, and MCP servers that failed to start.
	 */
	private forgetAgentSetup(): void {
		this.instructionsByRoot.clear();
		this.mcpHost.forgetFailed();
		this.agentPool.clear();
		for (const provider of this.agentProviders.values()) {
			if (provider instanceof AcpAgentProvider) {
				void provider.disposeSpares().catch(() => undefined);
			}
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
		const next = setCatalogModelEnabled(ref, enabled, this.disabled, this.enabled);
		this.disabled = new Set(next.hidden);
		this.enabled = new Set(next.whitelist);
		this.storageService.store(VOLT_DISABLED_MODELS_STORAGE_KEY, JSON.stringify(next.hidden), StorageScope.APPLICATION, StorageTarget.USER);
		this.storageService.store(VOLT_ENABLED_MODELS_STORAGE_KEY, JSON.stringify(next.whitelist), StorageScope.APPLICATION, StorageTarget.USER);
		this.catalog = this.catalog.map(item => item.ref === ref ? { ...item, enabled: this.isModelShown(item.ref) } : item);
		this._onDidChangeCatalog.fire();
	}

	isModelEnabled(ref: string): boolean {
		return this.isModelShown(ref);
	}

	/** Empty whitelist means show all, except models the user explicitly hid. */
	private isModelShown(ref: string): boolean {
		return isCatalogModelEnabled(ref, this.disabled, this.enabled);
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
	 * One stateless completion. Chat models go through HTTP with `messages` as they are. Agent refs
	 * go to the predictor's warm ACP session, which knows `task` from its skill.
	 */
	async *streamModel(ref: string, messages: IModelMessage[], options: IVoltModelOptions | undefined, token: CancellationToken, task: PredictorTask): AsyncIterable<IVoltEvent> {
		const item = this.catalog.find(c => c.ref === ref);
		if (!item) {
			throw new Error(`Unknown catalog ref ${ref}`);
		}
		const profile = this.profiles.find(p => p.id === item.profileId);
		if (!profile) {
			throw new Error(`Missing profile for catalog ref ${ref}`);
		}
		if (item.kind === 'agent') {
			yield* this.predictor.ask(item.ref, task, predictorRequest(task, messages), token);
			return;
		}
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			throw new Error(`Unknown model provider ${profile.providerId}`);
		}
		const apiKey = await this.apiKey(profile);
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

	warmPredictor(ref: string | undefined): void {
		const item = ref ? this.catalog.find(candidate => candidate.ref === ref) : undefined;
		this.predictor.warm(item?.kind === 'agent' ? item.ref : undefined);
	}

	/**
	 * Starts the predictor's session on `ref`'s agent: text-only, read-only, on the cheapest reasoning
	 * level, with the predictor skill as its system prompt where the agent takes one.
	 */
	private async launchPredictor(ref: string): Promise<IPredictorLaunch> {
		const item = this.catalog.find(candidate => candidate.ref === ref && candidate.kind === 'agent');
		const profile = item && this.profiles.find(candidate => candidate.id === item.profileId);
		const provider = profile && this.agentProviders.get(profile.providerId);
		if (!item || !profile || !provider) {
			throw new Error(`No agent serves ${ref}`);
		}
		const ownPrompt = provider.takesSystemPrompt?.() === true;
		const reasoning = cheapestReasoningLevel(item);
		const request: IAgentStartRequest = {
			mode: 'ask',
			profile,
			// An agent on Volt's own prompt runs away from the project: it loads no project instructions or
			// settings, and every request brings its own context. Others keep the folder (Codex wants a repository).
			cwd: ownPrompt && !isWindows ? '/tmp' : this.workspace.getWorkspace().folders[0]?.uri.fsPath,
			modelId: item.id === profile.providerId ? undefined : item.id,
			options: reasoning ? { [MODEL_OPTION_REASONING]: reasoning } : {},
			textOnly: { systemPrompt: PREDICTOR_SKILL },
		};
		const handle = await provider.start(request);
		provider.setRunContext?.(handle, { sessionId: TAB_PREDICTION_SESSION_ID, runId: 'tab', mode: 'ask' });
		if (!ownPrompt) {
			// It keeps its tools, so it runs read-only.
			await provider.applyAccessPolicy?.(handle, compilePolicy({ overlay: modeOverlay('ask') }));
		}
		return { provider, handle, profile, ownPrompt };
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

	/** Runs again when a provider is switched off mid-probe, so that probe cannot put its models back. */
	private async doRefreshCatalog(): Promise<void> {
		let stamp = '';
		do {
			stamp = this.profileEnabledStamp();
			await this.refreshCatalogOnce();
		} while (this.profileEnabledStamp() !== stamp);
	}

	private profileEnabledStamp(): string {
		return this.profiles.map(profile => `${profile.id}:${profile.enabled ? 1 : 0}`).join('\n');
	}

	/**
	 * Providers are queried in parallel and the picker is updated as each one answers, so the
	 * first CLI to respond is visible immediately instead of waiting on the slowest probe.
	 * Profiles that are off are dropped here. Leaving their previous rows in place is what
	 * kept a disabled agent in the chat model picker.
	 */
	private async refreshCatalogOnce(): Promise<void> {
		this.catalogLoading = true;
		if (!this.catalog.length) {
			this._onDidChangeCatalog.fire();
		}
		const enabledIds = new Set(this.profiles.filter(profile => profile.enabled).map(profile => profile.id));
		const byProfile = new Map<string, IVoltCatalogItem[]>();
		for (const item of this.catalog) {
			if (!enabledIds.has(item.profileId)) {
				continue;
			}
			const existing = byProfile.get(item.profileId) ?? [];
			existing.push(item);
			byProfile.set(item.profileId, existing);
		}
		const publish = () => {
			this.catalog = [...byProfile.values()].flat();
			this._onDidChangeCatalog.fire();
		};
		publish();
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
			const apiKey = await this.apiKey(profile);
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
					enabled: this.isModelShown(ref),
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
					enabled: this.isModelShown(ref),
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

	private async executeProviderRefresh(keepModelCache = false): Promise<void> {
		if (!keepModelCache) {
			clearClaudeModelCache();
			this.agentModels.clear();
		}
		const results = await Promise.all(this.profiles.map(async profile => {
			const detect = profile.enabled
				? await this.detectProfile(profile).catch(() => ({ available: false, detail: 'Health check failed.' }) satisfies IDetectResult)
				: undefined;
			return [profile.id, detect] as const;
		}));
		this.detections = new Map(results.filter((entry): entry is readonly [string, IDetectResult] => !!entry[1]));
		this.lastProviderCheck = Date.now();
		this.storageService.store(VOLT_DETECTIONS_STORAGE_KEY, JSON.stringify({ at: this.lastProviderCheck, detections: [...this.detections] }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await this.refreshCatalog();
		// A startup refresh lists only what storage had no lists for; both count as listed now.
		this.modelsListedAt = Date.now();
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
		if (!enabled) {
			const next = this.catalog.filter(item => item.profileId !== profileId);
			if (next.length !== this.catalog.length) {
				this.catalog = next;
				this._onDidChangeCatalog.fire();
			}
		}
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

	private onAgentBackgroundTask(provider: AcpAgentProvider, task: IAcpBackgroundTask): void {
		if (!task.sessionId) {
			return;
		}
		const chatId = this.chatFor(task.sessionId);
		const key = `${chatId}\0${task.taskId}`;
		if (task.state === 'running') {
			this.backgroundTaskOwners.set(key, { provider, providerSessionId: task.providerSessionId });
		} else {
			this.backgroundTaskOwners.delete(key);
		}
		this._onDidChangeAgentBackgroundTask.fire({
			chatId,
			taskId: task.taskId,
			label: task.description ?? task.name ?? task.taskType ?? 'Background task',
			state: task.state,
			...(task.summary ? { summary: task.summary } : {}),
			...(task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
		});
	}

	async stopAgentBackgroundTask(chatId: string, taskId: string): Promise<void> {
		const owner = this.backgroundTaskOwners.get(`${chatId}\0${taskId}`);
		await owner?.provider.stopBackgroundTask(owner.providerSessionId, taskId);
	}

	getAccessMode(sessionId?: string): VoltAccessMode {
		return (sessionId ? this.accessChats[sessionId] : undefined) ?? this.accessMode;
	}

	async setAccessMode(mode: VoltAccessMode, sessionId?: string): Promise<void> {
		const next = normalizeVoltAccessMode(mode);
		if (sessionId) {
			// A chat's pick holds for that chat only; the default stays what Settings says.
			if (this.accessChats[sessionId] === next) {
				return;
			}
			const chats = { ...this.accessChats, [sessionId]: next };
			const ids = Object.keys(chats);
			for (const id of ids.slice(0, Math.max(0, ids.length - ACCESS_CHATS_LIMIT))) {
				delete chats[id];
			}
			this.accessChats = chats;
			this.storageService.store(VOLT_ACCESS_CHATS_STORAGE_KEY, JSON.stringify(this.accessChats), StorageScope.APPLICATION, StorageTarget.USER);
			this._onDidChangeAccess.fire();
			await this.pushPolicyToAgent(sessionId);
			return;
		}
		this.accessMode = next;
		this.storageService.store(VOLT_ACCESS_MODE_STORAGE_KEY, this.accessMode, StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeAccess.fire();
		await this.pushPolicyToAgents();
	}

	/** The compiled rules for a chat's access mode (the default mode without a chat). */
	private policyFor(sessionId: string | undefined): ICompiledPolicy {
		const mode = this.getAccessMode(sessionId);
		let policy = this.policyByMode.get(mode);
		if (!policy) {
			policy = compilePolicy({
				system: SYSTEM_HARD_DENY,
				preset: presetRules(mode),
				project: this.projectRules,
				session: this.savedRules,
			});
			this.policyByMode.set(mode, policy);
		}
		return policy;
	}

	getSandboxSettings(sessionId: string): IVoltSandboxSettings {
		return this.sandboxChats[sessionId] ?? this.sandboxDefaults;
	}

	async setSandboxSettings(sessionId: string, settings: IVoltSandboxSettings): Promise<void> {
		this.sandboxChats = { ...this.sandboxChats, [sessionId]: normalizeSandboxSettings(settings) };
		this.storeSandbox();
	}

	getDefaultSandboxSettings(): IVoltSandboxSettings {
		return this.sandboxDefaults;
	}

	async setDefaultSandboxSettings(settings: IVoltSandboxSettings): Promise<void> {
		this.sandboxDefaults = normalizeSandboxSettings(settings);
		this.storeSandbox();
	}

	private storeSandbox(): void {
		this.storageService.store(VOLT_SANDBOX_STORAGE_KEY, JSON.stringify({ defaults: this.sandboxDefaults, chats: this.sandboxChats }), StorageScope.APPLICATION, StorageTarget.USER);
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
		// A page or chart spec can be hundreds of KB; the visual's stored copy is what the transcript keeps.
		const visualTool = (VISUAL_TOOL_NAMES as readonly string[]).includes(call.name);
		this.emit(session, session.activeRun?.runId || session.sessionId, {
			type: 'host.tool',
			name: call.name,
			args: visualTool ? { ...(typeof call.args.title === 'string' ? { title: call.args.title } : {}) } : call.args,
			...(call.result.text ? { text: call.result.text } : {}),
			...(call.result.image ? { image: call.result.image } : {}),
			...(call.result.error ? { error: call.result.error } : {}),
			...(call.result.visual ? { visual: call.result.visual } : {}),
		});
		// browser_run `edits`: the agent changed files through Volt, so they join the chat's change set.
		for (const change of call.result.changes ?? []) {
			this.emit(session, session.activeRun?.runId || session.sessionId, { type: 'file.change', uri: change.uri, kind: change.kind, ...(change.before !== undefined ? { before: change.before } : {}), existed: change.existed });
		}
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

	/**
	 * Merges the caller's selections over the stored ones and fills in provider defaults. API models
	 * also carry the sampling pins from Settings; agent CLIs choose their own and never get them.
	 */
	private resolvedOptions(item: IVoltCatalogItem, requested: IVoltModelOptions | undefined): IVoltModelOptions {
		const merged = { ...this.getModelOptions(item.ref), ...requested };
		const resolved = resolveModelOptions(item.optionDescriptors, merged);
		return item.kind === 'model' ? { ...resolved, ...pickGenerationParams(merged) } : resolved;
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

	/**
	 * Overlapping probes of one profile share a detection. The constructor starts the catalog and the
	 * provider refresh together, and each detected every profile: twice the `which`, `--version` and
	 * auth spawns at startup. Keyed by the whole profile, so an edited profile is probed afresh.
	 */
	private detectProfile(profile: IProviderProfile): Promise<IDetectResult> {
		const key = JSON.stringify(profile);
		let detection = this.detectionsInFlight.get(key);
		if (!detection) {
			const started = this.probeProfile(profile).finally(() => {
				if (this.detectionsInFlight.get(key) === started) {
					this.detectionsInFlight.delete(key);
				}
			});
			this.detectionsInFlight.set(key, started);
			detection = started;
		}
		return detection;
	}

	private async probeProfile(profile: IProviderProfile): Promise<IDetectResult> {
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
			// Nor while no Volt window has focus: a night in the background was hundreds of spawns and
			// failed localhost probes. The first tick after the user is back runs as usual. (The agent
			// server has no window: it refreshes on every tick.)
			const doc = (globalThis as { document?: Document }).document;
			if (doc && !doc.hasFocus()) {
				return;
			}
			void this.healthCheck();
		}, seconds * 1000);
	}

	/**
	 * A health tick checks each CLI is still there and signed in at most every {@link DETECT_TTL_MS}
	 * (each check spawns every CLI), and lists models again only every {@link MODEL_RELIST_MS}:
	 * listing starts a throwaway agent per CLI (Cursor's loads the user's MCP servers and a
	 * language server). The Providers page's Refresh does both at once.
	 */
	private healthCheck(): Promise<void> {
		if (this.providerRefresh) {
			return this.providerRefresh;
		}
		if (Date.now() - (this.lastProviderCheck ?? 0) < DETECT_TTL_MS) {
			return Promise.resolve();
		}
		this.providerRefresh = this.executeProviderRefresh(Date.now() - this.modelsListedAt < MODEL_RELIST_MS).finally(() => {
			this.providerRefresh = undefined;
		});
		return this.providerRefresh;
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
		this.emit(session, runId, { type: 'run.start', runId, mode, ...(session.providerRef ? { providerRef: session.providerRef } : {}) });
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
	private async prepareWorktree(session: ISessionState, request: IVoltSendRequest, isCancelled: () => boolean): Promise<void> {
		const project = this.projectRoot(session);
		if (session.worktreePath && session.worktreeBranch) {
			if (!project) {
				throw new Error('Open a folder before using a worktree.');
			}
			const recreated = await this.worktrees.ensure(project.fsPath, session.worktreePath, session.worktreeBranch);
			if (recreated) {
				session.announceWorktree = true;
				// A checkout recreated from its branch has none of what setup installed.
				await this.worktreeSetup.run(session.sessionId, { repoRoot: project.fsPath, worktreePath: session.worktreePath, branch: session.worktreeBranch, isCancelled });
			} else if (this.worktreeSetup.needsRetry(session.sessionId)) {
				// The last setup failed or was cancelled: finish it before the agent works there.
				await this.worktreeSetup.retry(session.sessionId, { isCancelled });
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
		await this.worktreeSetup.run(session.sessionId, { repoRoot: project.fsPath, worktreePath: created.path, branch: created.branch, isCancelled });
	}

	private noteWorktree(session: ISessionState, runId: string): void {
		if (session.moved && !session.moved.announced) {
			session.moved = { ...session.moved, announced: true };
			this.emit(session, runId, { type: 'notice', severity: 'info', title: session.moved.announce, ...(session.worktreePath ? { description: session.worktreePath } : {}) });
			return;
		}
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
			search: this.search,
			codeIndex: this.searchIndex,
			rtk: () => rtkEnabled(this.configurationService),
			rtkExclusions: () => readRtkExclusions(this.configurationService),
			meta: {
				grantGroups: () => session.extraGroups ?? [],
				...(state ? {
					loadSkill: name => this.loadSkill(session, name),
					runSubagent: (request, ctx) => this.runSubagent(session, state, request, ctx),
					subagents: () => (state.instructions?.subagents ?? []).map(agent => ({ name: agent.name, description: agent.description, readonly: agent.readonly, background: agent.background })),
					askQuestion: (draft, ctx) => this.askQuestionsUntil(session.sessionId, session.run?.runId, draft, ctx.signal),
					searchHistory: async (query, limit) => searchArchivedHistory(await this.journal.readArchive(session.sessionId), query, limit),
				} : {}),
				readState: async path => renderStateRead(await this.appState.read(this.appStateKey(session)), path),
				updateState: async (raw, expectRevision) => {
					const parsed = parseStateOps(raw);
					if ('error' in parsed) {
						return { text: parsed.error, isError: true };
					}
					const result = await this.appState.update(this.appStateKey(session), parsed.ops, expectRevision);
					return 'error' in result ? { text: result.error, isError: true } : { text: `Updated: the state is at revision ${result.file.revision}.` };
				},
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
			const host = runtimeToolDocuments();
			if (host) {
				return host.dirtyText(uri);
			}
			const model = this.textFileService.files.get(uri);
			return model?.isDirty() ? model.textEditorModel?.getValue() : undefined;
		},
		writeOpen: async (uri, text) => {
			const host = runtimeToolDocuments();
			if (host) {
				return host.writeOpen(uri, text);
			}
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

	/** Records a native model request for the Trajectory panel; the stream itself passes through unchanged. */
	private traceStream(stream: AsyncIterable<StreamChunk>, traced: { request?: ITrajectoryRequest }, input: Omit<ITrajectoryRequestInput, 'id' | 'index'>): AsyncIterable<StreamChunk> {
		const request = this.trajectory.begin(input);
		traced.request = request;
		return request ? recordStream(stream, request, () => this.trajectory.changed(input.sessionId)) : stream;
	}

	/** Times a batch's tool calls against the request whose answer asked for them; returns the result hook. */
	private traceTools(sessionId: string, request: ITrajectoryRequest | undefined, calls: readonly IToolCall[]): (result: IToolResult) => void {
		if (!request) {
			return () => { };
		}
		for (const call of calls) {
			startToolRun(request, call);
		}
		this.trajectory.changed(sessionId);
		return result => {
			endToolRun(request, result);
			this.trajectory.changed(sessionId);
		};
	}

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
		// Reads that do not depend on the previous run (or on the prompt hooks) start now and run
		// alongside the settle wait and the hooks: skills and rules, memory, MCP connections, the key.
		const allowMcp = modePolicy(request.mode).allowMcp;
		const early = this.nativeTurnInputs(this.executionRoot(session), allowMcp);
		// The code the message names, searched while the turn gets ready (snippets, ~1.5k tokens at most).
		const retrieval = isCompactCommand(request.text) || isVoltNote(request.text) ? undefined : this.retrieveContext(session, run, request.text, false);
		const apiKeyRead = this.apiKey(profile);
		void apiKeyRead.catch(() => undefined);
		// A cancelled run's tools may still be finishing; give them a moment before this one starts its own.
		await this.waitSettled(previous, SETTLE_WAIT_NATIVE_MS);
		const apiKey = await apiKeyRead;
		const root = this.executionRoot(session);
		const cwd = root?.fsPath;
		// The proof keeper (the run's contract, evidence and receipt) reads the project's checks meanwhile.
		const evidence = this.evidenceObserver(session, run, request, root);
		this.restoreReleasedNative(session);
		await this.nativeRestores.get(session.sessionId);
		this.nativeRestores.delete(session.sessionId);
		if (!this.isCurrent(session, run)) {
			return;
		}
		const state = this.nativeState(session);
		if (isCompactCommand(request.text)) {
			await this.compactNativeNow(session, run, state, provider, profile, apiKey, item);
			return;
		}
		// This run appends to its own copy; cancelling detaches it, so a loop that is still unwinding
		// cannot push tool results after the next run's user message.
		const transcript = state.messages.slice();
		state.messages = transcript;
		run.transcript = transcript;
		state.cwd = cwd;
		const journal = () => journalEntry(state);
		// Results of the batch that is running, until the loop adds them to the transcript.
		const finished = new Map<string, IToolResult>();
		// Calls of that batch that started; the rest wait for approval.
		const dispatched = new Set<string>();
		const checkpoint = () => {
			if (this.isCurrent(session, run)) {
				this.journal.log(session.sessionId, journal, () => liveJournalEntry(state, finished, dispatched));
			}
		};
		state.changed.clear();
		state.ledger.resumeReferences();
		const images = this.modelImages(request.images);
		// A model Volt runs itself reads a folded paste inline, as ACP agents with embedded context do.
		const pasted = inlineResourceContext(request.resources);
		const hookContext = (): IVoltHookRunContext => ({
			sessionId: session.sessionId,
			runId: run.runId,
			root: this.executionRoot(session)?.fsPath,
			cwd,
			model: item.id,
			mode: request.mode,
			stop: reason => this.stopRunForHook(session, run, reason),
		});
		const hookNotes = await this.promptHooks(session, run, request, hookContext());
		if (hookNotes === undefined || !this.isCurrent(session, run)) {
			return;
		}
		const retrieved = await retrieval;
		const observer = await evidence;
		if (!this.isCurrent(session, run)) {
			return;
		}
		run.proof = observer;
		// A small request says so in the message (the system prompt stays cached): edit, check, answer.
		const laneNote = run.lane === 'fast' && modePolicy(request.mode).allowWrites ? FAST_LANE_NOTE : undefined;
		// A run held to its proof from the start reads the contract with the request, so it plans the checks.
		const proofNote = isVoltNote(request.text) ? undefined : observer?.contractNote();
		const promptText = [request.text, pasted, hookNotes.length ? `<hook_context>\n${hookNotes.join('\n\n')}\n</hook_context>` : undefined, retrieved?.text, laneNote, proofNote].filter(Boolean).join('\n\n');
		// A chat started from another chat's queued message reads that chat condensed, not mirrored whole.
		const continued = session.continuedFrom && !state.messages.length ? this.contextHandoff(session, item, false) : undefined;
		this.syncNativeTranscript(session, state, promptText, images, continued?.text);
		if (continued) {
			this.emitContextHandoff(session, run, item, continued, false);
		}

		// The root can only differ from the early read if the chat moved while the previous run settled.
		const { projectInstructions, instructions, mcpTools, memoryContext } = await (isEqual(early.root, root) ? early : this.nativeTurnInputs(root, allowMcp)).read();
		if (!this.isCurrent(session, run)) {
			return;
		}
		state.instructions = instructions;
		const facts = this.environmentFacts(root);
		const tools = [...this.workspaceTools(session, state), ...mcpTools];
		// After a move the model reads where it works now before the prompt.
		const moved = session.moved?.model;
		session.moved = undefined;
		const turn = nativeModelTurn({
			text: moved ? `${moved}\n\n${request.text}` : request.text,
			mode: request.mode,
			cwd,
			platform: facts.platform,
			shell: facts.shell,
			date: facts.date,
			projectInstructions,
			rules: alwaysRules(instructions.rules),
			skills: instructionsIndex(instructions.skills, instructions.rules),
			memory: memoryContext,
			tools,
		});
		const selected = tools.filter(tool => turn.toolNames.includes(tool.name));
		// Hooks run around every call; the schemas sent to the model are the tools' own.
		const registry = new Map(selected.map(tool => [tool.name, this.hooks.wrapTool(tool, hookContext)]));
		const cancel = run.cancel.token;
		const options = this.runOptions(item, request, state);
		const schemas = toolSchemas(selected);
		const contextWindow = item.capabilities.contextWindow || DEFAULT_MODEL_CAPABILITIES.contextWindow;
		const serverClearsToolResults = profile.providerId === 'anthropic' && (!profile.endpoint?.baseURL || /^https:\/\/api\.anthropic\.com\/?$/.test(profile.endpoint.baseURL));
		const system: INativeLoopMessage = { role: 'system', content: turn.prompt };
		// Claude signs its reasoning over the system prompt and tools. When either changed since the
		// last run (mode, date, rules, memory, MCP tools), replaying the old blocks would be rejected.
		const prefix = promptPrefixKey(turn.prompt, schemas);
		if (state.prefix !== prefix) {
			if (dropBoundReasoning(transcript)) {
				this.journal.invalidate(session.sessionId);
				this.logService.info(`[volt] system prompt or tools changed in ${session.sessionId}; dropped earlier Claude reasoning`);
			}
			state.prefix = prefix;
		}
		if (state.interrupted || state.unapproved) {
			const interrupted = { running: state.interrupted ?? [], pending: state.unapproved ?? [] };
			state.interrupted = state.unapproved = undefined;
			// A call that waited for a person waits again, as it would have in the loop.
			const approve = async (call: IToolCall): Promise<ApprovalOutcome> => {
				const tool = registry.get(call.name);
				if (!tool) {
					return 'rejected';
				}
				return tool.group === 'meta' ? 'allowed-once' : this.preauthorizeDeepseek(session, run.runId, profile, call, tool) ?? await this.authorizeDeepseek(session, run.runId, profile, call, tool);
			};
			await this.replayInterrupted(session, run, state, interrupted, registry, { cwd, sessionId: session.sessionId, mode: request.mode }, approve);
			if (!this.isCurrent(session, run)) {
				return;
			}
		}
		// Background subagents a crash cut off go on from their own transcripts; their reports arrive as before.
		for (const agent of state.background?.filter(agent => !this.liveBackground.has(agent.id)) ?? []) {
			this.logService.info(`[volt] restarting the background ${agent.label} subagent of ${session.sessionId}`);
			void this.runSubagent(session, state, agent.request, { callId: agent.callId, signal: new AbortController().signal, cwd, sessionId: session.sessionId, mode: request.mode }, true);
		}
		// The request on the wire now, for the Trajectory panel; its answer's tool calls are timed against it.
		const traced: { request?: ITrajectoryRequest; step?: number } = {};
		const emit = (event: IVoltEvent) => {
			if (event.type === 'usage' && this.isCurrent(session, run)) {
				state.promptTokens = event.used ?? event.input + (event.cache ?? 0) + (event.cacheWrite ?? 0);
			}
			if (event.type === 'usage' && event.costUsd !== undefined && traced.request) {
				traced.request.costUsd = event.costUsd;
				this.trajectory.changed(session.sessionId);
			}
			this.emitEngine(session, run, event);
		};
		const cached = { tools: schemas, options };
		const compactionPolicy = { window: contextWindow, ...DEFAULT_COMPACTION };
		// Compactions so far: a background summary is placed only on the transcript it was written for.
		let compactions = 0;
		const compact = async (messages: INativeLoopMessage[], aggressive: boolean, prepared?: IPreparedCompaction) => {
			const shrank = await this.compactNative(session, run, state, messages, {
				provider, profile, apiKey, item, system: turn.prompt, contextWindow, aggressive, token: cancel, cached, ...(prepared ? { prepared } : {}),
			});
			if (shrank) {
				compactions++;
			}
			return shrank;
		};
		const background: { job?: IBackgroundCompaction; failedAt?: number } = {};
		/** The summary the next compaction will use, written while the agent works (pi-durable). */
		const startBackgroundCompaction = (messages: readonly INativeLoopMessage[]) => {
			const boundary = compactionBoundary(messages, Math.floor(effectiveWindow(compactionPolicy) * 0.25));
			if (boundary <= 0) {
				return;
			}
			const cts = new CancellationTokenSource(cancel);
			const job: IBackgroundCompaction = {
				boundary,
				compactions,
				cts,
				done: false,
				summary: this.inContextSummary(messages.slice(), { files: state.ledger.summary(), todo: state.todo }, { provider, profile, apiKey, item, system: turn.prompt, token: cts.token, cached }),
			};
			void job.summary.finally(() => {
				job.done = true;
			});
			background.job = job;
			this.logService.info(`[volt] started a background compaction summary in ${session.sessionId}`);
		};
		/** Near the context limit: place the background summary once it is in, or wait for it (or compact) at the limit. */
		const compactIfDue = async (messages: INativeLoopMessage[], estimate: number): Promise<boolean> => {
			let job = background.job;
			if (job && job.compactions !== compactions) {
				job.cts.dispose(true);
				job = background.job = undefined;
			}
			const due = shouldCompact(estimate, compactionPolicy);
			if (job && (job.done || due)) {
				background.job = undefined;
				const summary = await job.summary;
				job.cts.dispose();
				if (summary && job.compactions === compactions && job.boundary < messages.length && !cancel.isCancellationRequested) {
					return compact(messages, false, { boundary: job.boundary, summary });
				}
				// It failed: the next attempt is the regular one, at the limit.
				background.failedAt = compactions;
				return due && !cancel.isCancellationRequested ? compact(messages, false) : false;
			}
			if (due) {
				return compact(messages, false);
			}
			if (!job && background.failedAt !== compactions && shouldCompactEarly(estimate, compactionPolicy)) {
				startBackgroundCompaction(messages);
			}
			return false;
		};
		// Where this run's own messages start, for the reflection after it.
		const runFrom = transcript.length;
		const proofModel: IProofModel = { provider, profile, apiKey, item };
		run.metrics.mark('prompt');
		try {
			const openStream = (messages: readonly INativeLoopMessage[], streamOptions: IDeepseekStreamOptions | undefined) => linkedStream(cancel, streamOptions?.signal, token => new VoltLlmAdapter(provider).stream({
				modelId: item.id,
				messages: nativeToModelMessages([system, ...messages]),
				profile,
				apiKey,
				options,
				tools: schemas,
				...(streamOptions?.maxOutputTokens ? { maxOutputTokens: streamOptions.maxOutputTokens } : {}),
			}, token));
			const result = await runDeepseekLoop({
				stream: (messages, _token, streamOptions) => this.traceStream(openStream(messages, streamOptions), traced, {
					sessionId: session.sessionId,
					runId: run.runId,
					...(traced.step !== undefined ? { step: traced.step } : {}),
					provider: profile.providerId,
					model: item.id,
					modelLabel: item.label,
					system: system.content,
					messages,
					tools: schemas,
					options,
					...(streamOptions?.maxOutputTokens ? { maxOutputTokens: streamOptions.maxOutputTokens } : {}),
				}),
				// Claude's prompt cache lasts five minutes: kept while a long tool or an approval holds the run.
				// Not traced: the ping is aborted at its first chunk, so it is not a request of the run.
				...(keepsPromptCacheBriefly(profile.providerId, item.id) && this.configurationService.getValue<boolean>(PROMPT_CACHE_KEEPALIVE_SETTING) !== false ? {
					keepAlive: async (messages: readonly INativeLoopMessage[], streamOptions: IDeepseekStreamOptions) => {
						const abort = new AbortController();
						const iterator = openStream(messages, { ...streamOptions, signal: abort.signal })[Symbol.asyncIterator]();
						try {
							// The first chunk means the prompt was read, and with it the cached prefix.
							await iterator.next();
						} finally {
							abort.abort();
							await iterator.return?.().catch(() => undefined);
						}
					},
				} : {}),
				execute: (calls, onResult) => {
					// The model's calls are on disk before they run, and each result as it lands.
					for (const call of calls) {
						dispatched.add(call.id);
					}
					const traceResult = this.traceTools(session.sessionId, traced.request, calls);
					checkpoint();
					return runToolBatch(registry, calls, {
						cwd,
						signal: abortSignalFrom(cancel),
						sessionId: session.sessionId,
						mode: request.mode,
						emit: event => this.onToolEvent(session, run, state, event),
					}, {
						authorize: async () => ({ allow: true }),
						onResult: result => {
							finished.set(result.callId, result);
							traceResult(result);
							checkpoint();
							onResult?.(result);
						},
						locks: state.locks,
					});
				},
				authorize: call => this.authorizeDeepseek(session, run.runId, profile, call, registry.get(call.name)),
				preauthorize: call => this.preauthorizeDeepseek(session, run.runId, profile, call, registry.get(call.name)),
				emit,
				tool: name => registry.get(name),
				cwd,
				sessionId: session.sessionId,
				contextWindow,
				maxOutputTokens: 128_000,
				prepareTurn: async (messages, step) => {
					traced.step = step;
					if (!this.isCurrent(session, run)) {
						return;
					}
					state.ledger.nextStep();
					// The last batch's results are in the transcript now.
					finished.clear();
					dispatched.clear();
					// Old screenshots are pruned in batches, so the cached prompt prefix rarely changes.
					let edited = pruneImages(messages) > 0;
					if (step > 1 || messages.length > 2) {
						let estimate = Math.max(state.promptTokens, estimateTokens(turn.prompt) + totalTokens(messages));
						// Anthropic's own API clears old tool results server-side; everyone else gets the same here.
						if (!serverClearsToolResults) {
							const before = messages.slice();
							const freed = clearOldToolResults(messages, estimate, contextWindow);
							if (freed) {
								edited = true;
								// What was cleared stays in storage, where search_history finds it.
								void this.journal.archive(session.sessionId, before.filter((message, i) => message !== messages[i]
									&& ((message.role === 'tool' && message.content !== messages[i].content) || (message.role === 'assistant' && message.toolCalls !== messages[i].toolCalls))));
								estimate = Math.max(state.promptTokens - freed, estimateTokens(turn.prompt) + totalTokens(messages));
								this.logService.info(`[volt] cleared ${freed} tokens of old tool results in ${session.sessionId}`);
							}
						}
						edited = await compactIfDue(messages, estimate) || edited;
					}
					if (edited) {
						this.journal.invalidate(session.sessionId);
					}
					checkpoint();
				},
				onResponse: () => checkpoint(),
				recoverOverflow: async messages => {
					const shrank = await compact(messages, true);
					if (shrank) {
						this.journal.invalidate(session.sessionId);
					}
					return shrank;
				},
				reviewCompletion: modePolicy(request.mode).allowWrites ? input => this.reviewNativeCompletion(session, run, state, input.attempt) : undefined,
			}, {
				messages: transcript,
				token: cancel,
				isPaused: () => !!session.paused,
				claimInbox: () => this.isCurrent(session, run) ? claimInbox(state) : [],
				controller: {
					afterStep: async step => {
						const sendBack = await this.proveStep(session, run, observer, step, proofModel);
						const directive = withSendBack(await this.afterNativeStep(session, run, state, step), sendBack);
						if (directive.kind !== 'continue' || !step.wantsToFinish || cancel.isCancellationRequested) {
							return directive;
						}
						return (await this.stopHooks(session, step.assistant, hookContext())) ?? directive;
					},
				},
			});
			if (!this.isCurrent(session, run)) {
				return;
			}
			if (result.assistant) {
				void this.hooks.run('afterAgentResponse', hookContext(), { text: result.assistant });
			}
			// The receipt goes on the transcript before run.end, so it sits under the answer it proves.
			const receipt = observer && result.outcome === 'done' && !cancel.isCancellationRequested ? this.settleProof(session, run, observer, request, item) : undefined;
			if (observer || result.lessons?.length) {
				run.metrics.noteEvidence(observer ? observer.summary(result.lessons, receipt) : { complete: result.outcome === 'done', reason: '', changedFiles: 0, lessons: result.lessons ?? [] });
			}
			const nativeActivity = this.runActivity(run);
			if (result.assistant || nativeActivity) {
				session.messages.push({ role: 'assistant', content: result.assistant ?? '', model: item.label, ...(nativeActivity ? { activity: nativeActivity } : {}) });
			}
			state.synced = session.messages.length;
			if (result.stopped?.by === 'loop') {
				// The same tray an ACP agent's loop gets.
				this.emit(session, run.runId, { type: 'notice', severity: 'warning', title: LOOP_NOTICE_TITLE, description: result.stopped.reason });
			}
			if (result.outcome === 'budget') {
				this.emit(session, run.runId, { type: 'notice', severity: 'info', title: 'Reached the step limit for one run.', description: 'With Keep working on, Volt continues it in a fresh run; otherwise send "continue".' });
			}
			const aborted = result.outcome === 'abort' || cancel.isCancellationRequested;
			if (aborted || result.outcome !== 'done') {
				// Completed runs already went through the stop hooks before the loop let them end.
				void this.hooks.run('stop', hookContext(), protocol => protocol === 'claude' ? { stop_hook_active: false } : { status: aborted ? 'aborted' : 'error', loop_count: this.hookFollowups.get(session.sessionId) ?? 0 });
			}
			this.finish(session, run, aborted ? 'abort' : result.outcome === 'fail' ? 'fail' : 'done', !aborted && result.outcome === 'budget' ? 'steps' : undefined);
			if (!aborted) {
				// A compaction moved the run's start: the kept transcript is then the record.
				void this.reflectOnRun(session, transcript, compactions ? 0 : runFrom, { outcome: result.outcome, writes: modePolicy(request.mode).allowWrites }, { provider, profile, apiKey, item });
			}
		} catch (err) {
			if (this.isCurrent(session, run)) {
				this.emit(session, run.runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
				this.finish(session, run, cancel.isCancellationRequested ? 'abort' : 'fail');
			}
		} finally {
			background.job?.cts.dispose(true);
			if (session.run === run) {
				state.synced = Math.max(state.synced, session.messages.length);
			}
			// Always the session's transcript, never this run's detached copy.
			void this.journal.schedule(session.sessionId, journal, true);
		}
	}

	/**
	 * A crash cut the last run off while tools ran (the live log names them). Each call gets its
	 * result before the model hears anything else, right after the call: the ones safe to run twice
	 * run again now, saving the model a round trip, and the rest are reported as cut off, so it
	 * checks their effect instead of repeating a write or a command blindly.
	 */
	private async replayInterrupted(session: ISessionState, run: IRunState, state: INativeState, interrupted: { readonly running: readonly string[]; readonly pending: readonly string[] }, registry: ReadonlyMap<string, IVoltTool>, context: Omit<IToolContext, 'signal'>, approve: (call: IToolCall) => Promise<ApprovalOutcome>): Promise<void> {
		const messages = state.messages;
		const unstarted = new Set(interrupted.pending);
		const wanted = new Set([...interrupted.running, ...interrupted.pending]);
		const at = findLastIdx(messages, message => message.role === 'assistant' && !!message.toolCalls?.some(call => wanted.has(call.id)));
		if (at < 0) {
			return;
		}
		let end = at + 1;
		const answered = new Set<string>();
		for (; end < messages.length && messages[end].role === 'tool'; end++) {
			answered.add(messages[end].callId ?? '');
		}
		const open = messages[at].toolCalls!.filter(call => wanted.has(call.id) && !answered.has(call.id));
		if (!open.length) {
			return;
		}
		const cut = open.filter(call => !unstarted.has(call.id));
		const safe = cut.filter(call => isReplaySafe(registry.get(call.name)));
		const results = new Map<string, IToolResult>();
		/** Why a call that waited for approval did not run, when it was not approved this time. */
		const refused = new Map<string, string>();
		// Quick calls get a time cap; a resumable one (a subagent) carries on its own work for as long as it takes.
		const replay = async (calls: readonly IToolCall[], capMs: number | undefined) => {
			if (!calls.length) {
				return;
			}
			const controller = new AbortController();
			const timer = capMs ? setTimeout(() => controller.abort(), capMs) : undefined;
			const cancelled = run.cancel.token.onCancellationRequested(() => controller.abort());
			try {
				for (const result of await runToolBatch(registry, calls, { ...context, signal: controller.signal }, { authorize: async () => ({ allow: true }), locks: state.locks })) {
					if (result && !controller.signal.aborted) {
						results.set(result.callId, result);
					}
				}
			} catch (err) {
				this.logService.trace('[volt] replaying cut-off tool calls failed', err);
			} finally {
				clearTimeout(timer);
				cancelled.dispose();
			}
		};
		// Calls that waited for approval never ran: they are asked about again and run like any call.
		const reapprove = async () => {
			const calls = open.filter(call => unstarted.has(call.id));
			const decisions = await Promise.all(calls.map(approve));
			const allowed = calls.filter((call, i) => {
				const decision = decisions[i];
				if (decision !== 'allowed-once') {
					refused.set(call.id, decision === 'cancelled' ? 'Cancelled.' : decision === 'unavailable' ? 'Approval was unavailable.' : 'Blocked by Volt access policy.');
				}
				return decision === 'allowed-once';
			});
			if (allowed.some(call => !registry.get(call.name)?.parallelSafe)) {
				await turnWriteGate(session.sessionId);
			}
			await replay(allowed, undefined);
		};
		await Promise.all([
			replay(safe.filter(call => !registry.get(call.name)?.resumable), REPLAY_TIMEOUT_MS),
			replay(safe.filter(call => registry.get(call.name)?.resumable), undefined),
			reapprove(),
		]);
		if (!this.isCurrent(session, run) || state.messages !== messages) {
			return;
		}
		messages.splice(end, 0, ...open.map(call => {
			const result = results.get(call.id);
			const content = refused.get(call.id) ?? (unstarted.has(call.id) ? NOT_STARTED_BEFORE_RESTART : INTERRUPTED_BY_RESTART);
			return result ? nativeToolMessage(result) : { role: 'tool' as const, content, callId: call.id, name: call.name, isError: true };
		}));
		this.journal.invalidate(session.sessionId);
		this.logService.info(`[volt] resumed ${session.sessionId} after a crash: ${results.size} of ${open.length} cut-off call(s) run again (${unstarted.size} had waited for approval)`);
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
			locks: new PathLocks(),
		};
		return session.deepseek;
	}

	/**
	 * The native transcript and `session.messages` can drift apart when the user switches between
	 * a native model and an ACP agent. Turns the native transcript has not seen are mirrored in as
	 * plain text before the new message, so a model switch never loses the conversation.
	 */
	private syncNativeTranscript(session: ISessionState, state: INativeState, text: string, images?: IModelImage[], handoff?: string): void {
		if (handoff) {
			// The unseen turns arrive as this condensed handoff, ahead of the new message.
			text = `${handoff}\n\n${text}`;
		}
		const unseen = handoff ? [] : session.messages.slice(state.synced, -1);
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
		// The effort is part of the cached prompt: a change re-processes the whole chat. Within a chat
		// Auto only ever raises it, so a short follow-up does not throw away a long cached prefix.
		const chosen = chooseEffort(request.text, { mode: request.mode, previous: state.effort, attachments: attachmentNames(request).length });
		const level = state.effort ? higherEffort(chosen, state.effort) : chosen;
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
			if (current && (event.kind === 'edit' || event.kind === 'create' || event.kind === 'delete')) {
				run.proof?.noteFileChange(event.uri.fsPath, event.kind, typeof event.before === 'string' ? event.before : undefined, typeof event.existed === 'boolean' ? event.existed : undefined);
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
		const steered = claimInbox(state);
		const gate = await this.qualityContinuation(session, run);
		const message = [...steered, ...(gate ? [gate] : [])].join('\n\n');
		return message ? { kind: 'inject', message } : { kind: 'continue' };
	}

	/**
	 * The proof keeper for a native run: built from the request (a continuation's is the one it
	 * continues), the run's intent and the project's checks (read once per folder and cached). A
	 * failure to build it leaves the run unobserved, never stopped.
	 */
	private evidenceObserver(session: ISessionState, run: IRunState, request: IVoltSendRequest, root: URI | undefined): Promise<EvidenceObserver | undefined> {
		const intent = run.intent;
		if (!intent) {
			return Promise.resolve(undefined);
		}
		const typed = isVoltNote(request.text) ? findLastIdx(session.messages, message => message.role === 'user' && !!message.content.trim() && !isVoltNote(message.content)) : -1;
		const text = typed >= 0 ? session.messages[typed].content : request.text;
		const checks = root ? this.projectChecksFor(root).catch((): IProjectChecks => ({})) : Promise.resolve<IProjectChecks>({});
		return checks.then(value => new EvidenceObserver({
			text,
			intent,
			checks: value,
			readOnly: !modePolicy(request.mode).allowWrites,
			hasPriorTurns: session.messages.filter(message => message.role === 'user').length > 1,
			...(root ? { root: root.fsPath } : {}),
			gate: resolveProofGate(this.configurationService.getValue<unknown>(EVIDENCE_GATE_SETTING)),
		})).catch(err => {
			this.logService.trace('[volt] the proof keeper could not start', err);
			return undefined;
		});
	}

	/**
	 * One step through the proof keeper. On a finishing step of a gated run: the receipt as it
	 * stands, then (once its checks hold) the second opinion, and the message that sends the model
	 * back when either does not hold. Never fatal: a failure here lets the run finish.
	 */
	private async proveStep(session: ISessionState, run: IRunState, observer: EvidenceObserver | undefined, step: IDeepseekStep, model: IProofModel): Promise<string | undefined> {
		if (!observer) {
			return undefined;
		}
		try {
			observer.observe(step);
			if (!step.wantsToFinish || !this.isCurrent(session, run) || run.cancel.token.isCancellationRequested) {
				return undefined;
			}
			let receipt = observer.receipt();
			if (!receipt.gated) {
				return undefined;
			}
			const items = observer.reviewDue(receipt);
			if (items && this.configurationService.getValue<boolean>(PROOF_REVIEW_SETTING) !== false) {
				this.emit(session, run.runId, { type: 'lifecycle', phase: 'verifying' });
				observer.noteReview(await this.reviewProof(run, observer, receipt, items, model));
				if (!this.isCurrent(session, run) || run.cancel.token.isCancellationRequested) {
					return undefined;
				}
				receipt = observer.receipt();
			}
			const message = observer.sendBack(receipt);
			if (message) {
				run.metrics.noteContinuation();
				this.logService.info(`[volt] run ${run.runId} goes back to work: ${receiptSummary(receipt)}`);
				this.emit(session, run.runId, { type: 'notice', severity: 'info', title: localize('volt.proof.sentBack', "The finish is not proven yet. Asking the agent to close the gaps."), description: 'Volt check' });
			}
			return message;
		} catch (err) {
			this.logService.trace('[volt] the proof check failed on a step', err);
			return undefined;
		}
	}

	/**
	 * The second opinion: one low-effort request on the chat's own model with a clean context (the
	 * request, the run's diff, the checks that passed, its final answer; none of its reasoning).
	 * Undefined when it could not run or gave no verdict: the items then stay claimed, never passed.
	 */
	private async reviewProof(run: IRunState, observer: EvidenceObserver, receipt: IRunReceipt, items: readonly IReceiptLine[], model: IProofModel): Promise<IProofReview | undefined> {
		const files = await Promise.all(observer.reviewFiles().map(async change => ({
			path: change.path,
			before: change.before,
			existed: change.existed,
			after: await this.fileService.readFile(URI.file(change.fsPath), { limits: { size: PROOF_REVIEW_FILE_BYTES } }).then(content => content.value.toString(), () => undefined),
		})));
		const passed = receipt.lines.filter(line => line.status === 'proven' && line.command).map(line => `${line.command}: ${line.detail ?? 'passed'}`);
		const cts = new CancellationTokenSource(run.cancel.token);
		const timer = setTimeout(() => cts.cancel(), PROOF_REVIEW_TIMEOUT_MS);
		let text = '';
		try {
			for await (const event of watchedStream(token => model.provider.stream({
				modelId: model.item.id,
				messages: [
					{ role: 'system', content: PROOF_REVIEW_SYSTEM },
					{ role: 'user', content: proofReviewRequest({ request: observer.request, items, passed, diff: reviewDiff(files), answer: observer.finalAnswer }) },
				],
				profile: model.profile,
				apiKey: model.apiKey,
				options: { ...this.resolvedOptions(model.item, undefined), [MODEL_OPTION_REASONING]: 'low' },
				maxOutputTokens: 1_500,
			}, token), cts.token)) {
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				}
			}
		} catch (err) {
			this.logService.info(`[volt] the second opinion on run ${run.runId} could not run: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
		const review = parseProofReview(text, items.length);
		this.logService.info(`[volt] second opinion on run ${run.runId}: ${review ? `${review.verdict}${review.summary ? ` (${review.summary})` : ''}` : 'no verdict'}`);
		return review;
	}

	/**
	 * The run's receipt as it ends: on the transcript when it says something (a quick edit that
	 * checked nothing gets no card), and kept as a replayable eval case when it was binding.
	 */
	private settleProof(session: ISessionState, run: IRunState, observer: EvidenceObserver, request: IVoltSendRequest, item: IVoltCatalogItem): IRunReceipt | undefined {
		try {
			const receipt = observer.receipt();
			if (isReceiptWorthShowing(receipt)) {
				this.emit(session, run.runId, { type: 'receipt', runId: run.runId, receipt });
			}
			if (receipt.gated) {
				const root = this.executionRoot(session);
				this.proofCases.record({
					sessionId: session.sessionId,
					runId: run.runId,
					...(root ? { project: root.fsPath } : {}),
					request: observer.request,
					mode: request.mode,
					model: item.id,
					lane: run.lane ?? 'agent',
					contract: [...observer.contract.items, ...(observer.contract.floor ? [observer.contract.floor] : [])].map(line => ({ text: line.text, kind: line.kind, ...(line.command ? { command: line.command } : {}) })),
					receipt,
				});
			}
			this.logService.info(`[volt] run ${run.runId} ${receiptSummary(receipt)}`);
			return receipt;
		} catch (err) {
			this.logService.trace('[volt] the run receipt could not be written', err);
			return undefined;
		}
	}

	/**
	 * A file change in a CLI agent's run (Claude Code, Codex): remembers the file's error counts as
	 * they were (the editor's markers lag the write), so the run can be checked for new errors.
	 */
	private noteAgentChange(session: ISessionState, runId: string, uri: URI, kind: 'edit' | 'create' | 'delete'): void {
		this.search.invalidate();
		const run = session.run;
		if (!run || run.engine !== 'agent' || run.runId !== runId || run.ended || kind === 'delete') {
			return;
		}
		const files = run.changedFiles ??= new Map();
		const key = uri.toString();
		if (!files.has(key)) {
			files.set(key, { uri, baseline: this.codeIntel.errorCounts(uri) });
		}
		this.codeIntel.noteWrite(uri);
	}

	/** When a CLI agent wants to stop: new compiler or linter errors in its files send it back (twice at most). */
	private async agentErrorGate(session: ISessionState, run: IRunState): Promise<string | undefined> {
		const attempts = run.continued.errors ?? 0;
		if (!run.changedFiles?.size || attempts >= 2 || !modePolicy(run.mode).allowWrites || run.cancel.token.isCancellationRequested) {
			return undefined;
		}
		const message = await this.reviewNewErrors([...run.changedFiles.values()].map(file => [file.uri, file.baseline] as const), this.executionRoot(session)?.fsPath, attempts + 1);
		if (!message || !this.isCurrent(session, run)) {
			return undefined;
		}
		run.continued.errors = attempts + 1;
		run.metrics.noteContinuation();
		this.logService.info(`[volt] run ${run.runId} continues: new errors in changed files`);
		this.emit(session, run.runId, { type: 'notice', severity: 'info', title: localize('volt.check.newErrors', "Files the agent changed have new errors. Asking it to fix them."), description: 'Volt check' });
		return message;
	}

	/** New compiler or linter errors in the files the run changed (language services already know). */
	private reviewCompletion(state: INativeState, attempt: number): Promise<string | undefined> {
		return this.reviewNewErrors(state.changed.entries(), state.cwd, attempt);
	}

	/** The message that sends an agent back when files it changed have errors they did not have before. */
	private async reviewNewErrors(changed: Iterable<readonly [URI, ReadonlyMap<string, number>]>, cwd: string | undefined, attempt: number): Promise<string | undefined> {
		const files = [...changed].filter(([uri]) => DIAGNOSED_EXTENSIONS.test(uri.path));
		if (!files.length) {
			return undefined;
		}
		const found = await Promise.all(files.map(async ([uri, baseline]) => ({ uri, added: await this.codeIntel.newErrors(uri, baseline).catch(() => []) })));
		const root = cwd ? URI.file(cwd) : undefined;
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
	/**
	 * `/compact` in a native chat: Volt's summarizer folds everything but the latest exchange into a
	 * summary, as it does on its own near the context limit, and nothing is sent to the model.
	 */
	private async compactNativeNow(session: ISessionState, run: IRunState, state: INativeState, provider: IModelProvider, profile: IProviderProfile, apiKey: string | undefined, item: IVoltCatalogItem): Promise<void> {
		// The /compact message is a command, not part of the conversation.
		if (session.messages.at(-1)?.role === 'user' && isCompactCommand(session.messages.at(-1)!.content)) {
			session.messages.pop();
		}
		const messages = state.messages.slice();
		const compacted = await this.compactNative(session, run, state, messages, {
			provider, profile, apiKey, item, system: '', contextWindow: item.capabilities.contextWindow || DEFAULT_MODEL_CAPABILITIES.contextWindow, aggressive: true, token: run.cancel.token, keepTokens: 0,
		});
		if (!this.isCurrent(session, run)) {
			return;
		}
		if (compacted) {
			state.messages = messages;
			state.synced = session.messages.length;
			this.journal.schedule(session.sessionId, () => journalEntry(state));
		}
		const id = generateUuid();
		const text = compacted ? 'Compacted the conversation: earlier turns are now a summary the model continues from.' : 'Nothing to compact yet: the conversation is already short.';
		this.emit(session, run.runId, { type: 'text.start', id });
		this.emit(session, run.runId, { type: 'text.delta', id, delta: text });
		this.emit(session, run.runId, { type: 'text.end', id });
		this.finish(session, run, 'done');
	}

	private async compactNative(session: ISessionState, run: IRunState, state: INativeState, messages: INativeLoopMessage[], input: {
		readonly provider: IModelProvider;
		readonly profile: IProviderProfile;
		readonly apiKey: string | undefined;
		readonly item: IVoltCatalogItem;
		readonly system: string;
		readonly contextWindow: number;
		readonly aggressive: boolean;
		readonly token: CancellationToken;
		/** Tokens of recent turns to keep verbatim; `/compact` keeps only the latest exchange. */
		readonly keepTokens?: number;
		/** The run's own tools and options: the summary is then asked for on top of its cached prompt. */
		readonly cached?: { readonly tools: IModelRequest['tools']; readonly options: IVoltModelOptions };
		/** A summary already written in the background, and where it cuts. */
		readonly prepared?: IPreparedCompaction;
	}): Promise<boolean> {
		const window = effectiveWindow({ window: input.contextWindow, ...DEFAULT_COMPACTION });
		const boundary = input.prepared?.boundary ?? compactionBoundary(messages, input.keepTokens ?? Math.floor(window * (input.aggressive ? 0.1 : 0.25)));
		if (boundary <= 0) {
			return false;
		}
		const older = messages.slice(0, boundary);
		const carry = { files: state.ledger.summary(), todo: state.todo };
		const compactionId = generateUuid();
		const startedAt = Date.now();
		const preTokens = estimateTokens(input.system) + totalTokens(messages);
		this.emitEngine(session, run, { type: 'context.compaction', id: compactionId, status: 'running', trigger: 'auto', preTokens });
		void this.hooks.run('preCompact', { sessionId: session.sessionId, runId: run.runId, root: this.executionRoot(session)?.fsPath, cwd: state.cwd, model: input.item.id, mode: session.mode }, protocol => protocol === 'claude'
			? { trigger: input.keepTokens !== undefined ? 'manual' : 'auto', custom_instructions: '' }
			: { trigger: input.keepTokens !== undefined ? 'manual' : 'auto', context_tokens: preTokens });
		// An overflowing prompt cannot carry the request on top of itself; that goes to the summarizer.
		let summary = input.prepared?.summary ?? (input.cached && !input.aggressive ? await this.inContextSummary(messages, carry, { ...input, cached: input.cached }) : undefined);
		if (!summary && !input.token.isCancellationRequested) {
			try {
				let text = '';
				for await (const event of watchedStream(token => input.provider.stream({
					modelId: input.item.id,
					messages: [
						{ role: 'system', content: COMPACTION_SYSTEM },
						{ role: 'user', content: compactionRequest(serializeForSummary(older), carry) },
					],
					profile: input.profile,
					apiKey: input.apiKey,
					options: { ...this.resolvedOptions(input.item, undefined), [MODEL_OPTION_REASONING]: 'low' },
					maxOutputTokens: 8_000,
				}, token), input.token)) {
					if (event.type === 'text.delta' && event.delta) {
						text += event.delta;
					}
				}
				summary = text.trim() || undefined;
			} catch (err) {
				this.logService.warn('[volt] compaction summary failed; using a mechanical summary', err);
			}
		}
		// Out of view, not out of storage: search_history reads it back.
		void this.journal.archive(session.sessionId, older.filter(message => !isClearedToolResult(message)));
		const next = applyCompaction(messages, boundary, summary ?? mechanicalSummary(older, carry), true);
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
	 * The handoff summary as the next user turn of the run's own request: same system prompt, tools,
	 * options, and history, so the provider reads the whole conversation from its prompt cache (a
	 * cache read costs a tenth of fresh input on most providers) and the summarizer sees every tool
	 * result unclipped. `undefined` when the model did not return a usable summary.
	 */
	private async inContextSummary(messages: readonly INativeLoopMessage[], carry: ICarryForward, input: {
		readonly provider: IModelProvider;
		readonly profile: IProviderProfile;
		readonly apiKey: string | undefined;
		readonly item: IVoltCatalogItem;
		readonly system: string;
		readonly token: CancellationToken;
		readonly cached: { readonly tools: IModelRequest['tools']; readonly options: IVoltModelOptions };
	}): Promise<string | undefined> {
		let text = '';
		let cut = false;
		try {
			for await (const event of watchedStream(token => input.provider.stream({
				modelId: input.item.id,
				messages: nativeToModelMessages([{ role: 'system', content: input.system }, ...messages, { role: 'user', content: inContextCompactionRequest(carry) }]),
				profile: input.profile,
				apiKey: input.apiKey,
				options: input.cached.options,
				tools: input.cached.tools,
				// The output limit is outside the cached prefix; thinking at the run's effort counts toward it.
				maxOutputTokens: IN_CONTEXT_SUMMARY_OUTPUT_TOKENS,
			}, token), input.token)) {
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				} else if (event.type === 'finish' && event.reason === 'length') {
					cut = true;
				}
			}
		} catch (err) {
			this.logService.warn('[volt] in-context compaction failed; using the separate summarizer', err);
			return undefined;
		}
		if (cut) {
			this.logService.info('[volt] in-context compaction hit its output limit; using the separate summarizer');
			return undefined;
		}
		const summary = text.trim();
		if (summary.length < MIN_IN_CONTEXT_SUMMARY_CHARS) {
			this.logService.info(`[volt] in-context compaction returned ${summary.length} characters; using the separate summarizer`);
			return undefined;
		}
		return summary;
	}

	/**
	 * A sub-agent: its own context and transcript, the parent's model at a lower effort, and only its
	 * final report comes back. The built-in ones (explore, research) are read-only. A subagent
	 * defined in a file (`.volt/agents/<name>.md`, `.claude/agents`, `.cursor/agents`, plugins)
	 * follows its own instructions with its own model, may edit when it is not `readonly`, keeps to
	 * its `tools:` list, and with `is_background` reports back later while the parent carries on.
	 */
	private async runSubagent(session: ISessionState, parent: INativeState, request: ISubagentRequest, ctx: IToolContext, restarted = false): Promise<{ text: string; isError?: boolean }> {
		const definition = request.agent ? parent.instructions?.subagents?.find(agent => agent.name.toLowerCase() === request.agent!.toLowerCase()) : undefined;
		const parentItem = this.catalog.find(c => c.ref === session.providerRef && c.enabled) ?? this.catalog.find(c => c.enabled);
		const item = definition ? this.subagentModel(definition.model, parentItem) : parentItem;
		const profile = item ? this.profiles.find(p => p.id === item.profileId) : undefined;
		const provider = profile ? this.modelProviders.get(profile.providerId) : undefined;
		const run = session.run && !session.run.ended ? session.run : undefined;
		const runId = run?.runId;
		if (!item || !profile || !provider || item.kind !== 'model' || !run || !runId) {
			return { text: 'Sub-agents need a native model to be selected.', isError: true };
		}
		const label = definition?.name ?? request.kind;
		const root = this.executionRoot(session);
		const hookContext = (): IVoltHookRunContext => ({
			sessionId: session.sessionId,
			runId,
			root: root?.fsPath,
			cwd: root?.fsPath,
			model: item.id,
			mode: session.mode,
			stop: reason => this.stopRunForHook(session, run, reason),
		});
		const started = await this.hooks.run('subagentStart', hookContext(), { subagent_type: label, description: request.description, prompt: request.prompt });
		if (started.blocked !== undefined || started.stopRun) {
			return { text: `A hook did not let the ${label} subagent start: ${started.blocked ?? started.stopRun}`, isError: true };
		}
		const apiKey = await this.apiKey(profile);
		// A background one restarted after a crash stays in the background, whatever its file says now.
		const background = restarted || !!definition?.background;
		const allowed = this.subagentToolNames(request, definition, background);
		const writes = !!definition && !definition.readonly;
		const tools = this.workspaceTools(session, { ...parent, ledger: new FileLedger() })
			.filter(tool => allowed.has(tool.name))
			.map(tool => this.hooks.wrapTool(tool, hookContext));
		const registry = new Map(tools.map(tool => [tool.name, tool]));
		const facts = this.environmentFacts(root);
		const system: INativeLoopMessage = {
			role: 'system',
			content: definition
				? customSubagentPrompt(definition, { cwd: root?.fsPath, platform: facts.platform, date: facts.date, writes, tools: [...registry.keys()] })
				: buildSubagentPrompt({ kind: request.kind, cwd: root?.fsPath, platform: facts.platform, date: facts.date }),
		};
		const options = { ...this.resolvedOptions(item, undefined) };
		if (item.optionDescriptors?.some(option => option.id === MODEL_OPTION_REASONING) && (!definition || definition.model === 'inherit' || definition.model === 'fast')) {
			const values = item.optionDescriptors.find(option => option.id === MODEL_OPTION_REASONING)?.options?.map(option => option.value) ?? [];
			options[MODEL_OPTION_REASONING] = closestLevel(request.kind === 'research' || (definition && definition.model !== 'fast') ? 'medium' : 'low', values.filter(value => value !== 'auto' && value !== 'off')) ?? 'low';
		}
		// A background subagent outlives the call that started it, but not the chat's run being stopped.
		const source = new CancellationTokenSource(run.cancel.token);
		const onAbort = () => source.cancel();
		if (!background) {
			ctx.signal.addEventListener('abort', onAbort);
		}
		const progress = (status: string) => {
			if (!background && ctx.callId && !run.ended) {
				this.emit(session, runId, { type: 'tool.progress', callId: ctx.callId, status: `${request.description}: ${status}` });
			}
		};
		// Its transcript is saved step by step under the call's id (pi-durable's owned child): after a
		// crash the same call, re-run when the chat resumes, carries on from there instead of starting over.
		const journalId = ctx.callId ? subagentJournalId(session.sessionId, ctx.callId) : undefined;
		if (journalId && this.liveBackground.has(journalId)) {
			return { text: `The ${label} subagent is already working in the background.` };
		}
		const resumed = journalId ? resumedSubagent(await this.journal.load(journalId)) : {};
		if (journalId && resumed.report !== undefined) {
			void this.journal.delete(journalId);
			if (background) {
				this.deliverBackgroundReport(session, run, parent, label, { text: resumed.report }, journalId);
				return { text: `The ${label} subagent had already finished; its report is in.` };
			}
			return { text: resumed.report };
		}
		if (resumed.messages) {
			progress('continuing after a restart');
			this.logService.info(`[volt] resumed the ${label} subagent of ${session.sessionId} from its saved transcript (${resumed.messages.length} messages)`);
		}
		const transcript: INativeLoopMessage[] = resumed.messages ?? [{ role: 'user', content: request.prompt }];
		const subagentWindow = item.capabilities.contextWindow || DEFAULT_MODEL_CAPABILITIES.contextWindow;
		const childEntry = (): INativeJournalEntry => ({ version: 1, messages: transcript, synced: 0, savedAt: Date.now() });
		const finishedCalls = new Map<string, IToolResult>();
		const startedCalls = new Set<string>();
		const save = () => {
			if (journalId) {
				this.journal.log(journalId, childEntry, () => withRunningCalls(childEntry(), finishedCalls, startedCalls));
			}
		};
		const traced: { request?: ITrajectoryRequest } = {};
		const work = async (): Promise<{ text: string; isError?: boolean }> => {
			try {
				const result = await runDeepseekLoop({
					stream: messages => this.traceStream(new VoltLlmAdapter(provider).stream({
						modelId: item.id,
						messages: nativeToModelMessages([system, ...messages]),
						profile,
						apiKey,
						options,
						tools: toolSchemas(tools),
					}, source.token), traced, {
						sessionId: session.sessionId,
						runId,
						provider: profile.providerId,
						model: item.id,
						modelLabel: item.label,
						agent: label,
						system: system.content,
						messages,
						tools: toolSchemas(tools),
						options,
					}),
					execute: (calls, onResult) => {
						for (const call of calls) {
							startedCalls.add(call.id);
						}
						const traceResult = this.traceTools(session.sessionId, traced.request, calls);
						save();
						return runToolBatch(registry, calls, {
							cwd: root?.fsPath,
							signal: abortSignalFrom(source.token),
							sessionId: session.sessionId,
							mode: writes ? session.mode : 'ask',
							// Its edits count as the chat's changes (review, diagnostics), without drawing its tool cards.
							...(writes ? { emit: (event: { type: string;[key: string]: unknown }) => { if (event.type === 'file.change') { this.onToolEvent(session, run, parent, event); } } } : {}),
						}, {
							authorize: async () => ({ allow: true }),
							onResult: result => {
								finishedCalls.set(result.callId, result);
								traceResult(result);
								save();
								onResult?.(result);
							},
							locks: parent.locks,
						});
					},
					prepareTurn: async messages => {
						finishedCalls.clear();
						startedCalls.clear();
						// A long subagent compacts like the main agent, so it never runs out of context.
						if (shouldCompact(estimateTokens(system.content) + totalTokens(messages), { window: subagentWindow, ...DEFAULT_COMPACTION })) {
							await this.compactSubagent(messages, { provider, profile, apiKey, item, system: system.content, window: subagentWindow, token: source.token, cached: { tools: toolSchemas(tools), options } });
						}
						save();
					},
					recoverOverflow: messages => this.compactSubagent(messages, { provider, profile, apiKey, item, system: system.content, window: subagentWindow, token: source.token, aggressive: true }),
					onResponse: () => save(),
					// A subagent that edits asks for approval like the main agent; a read-only one never needs to.
					authorize: async call => writes
						? this.authorizeDeepseek(session, runId, profile, call, registry.get(call.name))
						: this.preauthorizeDeepseek(session, runId, profile, call, registry.get(call.name)) ?? 'rejected',
					preauthorize: call => this.preauthorizeDeepseek(session, runId, profile, call, registry.get(call.name)) ?? (writes ? undefined : 'rejected'),
					emit: event => {
						if (event.type === 'tool.start' && event.title) {
							progress(event.title);
						}
					},
					tool: name => registry.get(name),
					cwd: root?.fsPath,
					sessionId: session.sessionId,
				}, {
					messages: transcript,
					token: source.token,
					budget: writes ? { maxToolCalls: 200, maxModelCalls: 60 } : { maxToolCalls: 80, maxModelCalls: 30 },
				});
				// Its report goes into the parent's transcript now; a stop leaves the copy (the call is not re-run).
				if (journalId && result.outcome !== 'abort') {
					void this.journal.delete(journalId);
				}
				const text = result.assistant.trim();
				let report: { text: string; isError?: boolean };
				if (result.outcome === 'abort') {
					report = { text: `The ${label} subagent was cancelled.`, isError: true };
				} else if (!text) {
					report = { text: `The ${label} subagent finished without a report.`, isError: true };
				} else {
					report = { text: result.outcome === 'budget' ? `${text}\n\n(The sub-agent reached its step limit; this report may be partial.)` : text, ...(result.outcome === 'fail' ? { isError: true } : {}) };
				}
				void this.hooks.run('subagentStop', hookContext(), { subagent_type: label, status: report.isError ? 'error' : 'completed', result: report.text.slice(0, 8_000) });
				return report;
			} finally {
				ctx.signal.removeEventListener('abort', onAbort);
				source.dispose();
			}
		};
		if (!background) {
			return work();
		}
		// It is on the chat's saved list until its report is in: a crash starts it again from its transcript.
		if (journalId) {
			this.liveBackground.add(journalId);
			parent.background = [...(parent.background ?? []).filter(agent => agent.id !== journalId), { id: journalId, callId: ctx.callId!, label, request }];
			void this.journal.schedule(session.sessionId, () => journalEntry(parent), true);
		}
		void work().then(report => this.deliverBackgroundReport(session, run, parent, label, report, journalId), err => this.deliverBackgroundReport(session, run, parent, label, { text: err instanceof Error ? err.message : String(err), isError: true }, journalId));
		return { text: `Started the ${label} subagent in the background. Its report will arrive as a message when it finishes; carry on with other work meanwhile.` };
	}

	/**
	 * A subagent's compaction: the summary on top of its own cached request (the separate summarizer
	 * when that fails or the prompt overflowed), then its kept tail. Nothing is shown in the parent's
	 * chat; the subagent just keeps going. Returns true when the transcript shrank.
	 */
	private async compactSubagent(messages: INativeLoopMessage[], input: {
		readonly provider: IModelProvider;
		readonly profile: IProviderProfile;
		readonly apiKey: string | undefined;
		readonly item: IVoltCatalogItem;
		readonly system: string;
		readonly window: number;
		readonly token: CancellationToken;
		readonly aggressive?: boolean;
		readonly cached?: { readonly tools: IModelRequest['tools']; readonly options: IVoltModelOptions };
	}): Promise<boolean> {
		const window = effectiveWindow({ window: input.window, ...DEFAULT_COMPACTION });
		const boundary = compactionBoundary(messages, Math.floor(window * (input.aggressive ? 0.1 : 0.25)));
		if (boundary <= 0) {
			return false;
		}
		const older = messages.slice(0, boundary);
		const carry: ICarryForward = {};
		let summary = input.cached && !input.aggressive ? await this.inContextSummary(messages, carry, { ...input, cached: input.cached }) : undefined;
		if (!summary && !input.token.isCancellationRequested) {
			try {
				let text = '';
				for await (const event of watchedStream(token => input.provider.stream({
					modelId: input.item.id,
					messages: [
						{ role: 'system', content: COMPACTION_SYSTEM },
						{ role: 'user', content: compactionRequest(serializeForSummary(older), carry) },
					],
					profile: input.profile,
					apiKey: input.apiKey,
					options: { ...this.resolvedOptions(input.item, undefined), [MODEL_OPTION_REASONING]: 'low' },
					maxOutputTokens: 8_000,
				}, token), input.token)) {
					if (event.type === 'text.delta' && event.delta) {
						text += event.delta;
					}
				}
				summary = text.trim() || undefined;
			} catch (err) {
				this.logService.warn('[volt] subagent compaction summary failed; using a mechanical summary', err);
			}
		}
		messages.splice(0, messages.length, ...applyCompaction(messages, boundary, summary ?? mechanicalSummary(older, carry)));
		return true;
	}

	/**
	 * The experience reflector (Harness2): after a substantial run, one cheap side request reads its
	 * record and keeps at most one lesson with evidence as a project memory, or nothing. Off with
	 * `volt.agent.learnFromRuns`.
	 */
	private async reflectOnRun(session: ISessionState, messages: readonly INativeLoopMessage[], from: number, run: { readonly outcome: 'done' | 'fail' | 'abort' | 'budget'; readonly writes: boolean }, input: {
		readonly provider: IModelProvider;
		readonly profile: IProviderProfile;
		readonly apiKey: string | undefined;
		readonly item: IVoltCatalogItem;
	}): Promise<void> {
		if (this.configurationService.getValue<boolean>(LEARN_FROM_RUNS_SETTING) === false || this.reflecting.has(session.sessionId)) {
			return;
		}
		const own = messages.slice(from);
		const toolCalls = own.reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0);
		const toolErrors = own.filter(message => message.role === 'tool' && message.isError).length;
		if (!shouldReflect({ ...run, toolCalls, toolErrors })) {
			return;
		}
		this.reflecting.add(session.sessionId);
		try {
			let text = '';
			for await (const event of watchedStream(token => input.provider.stream({
				modelId: input.item.id,
				messages: [
					{ role: 'system', content: EXPERIENCE_SYSTEM },
					{ role: 'user', content: experienceRequest(experienceRecord(messages, from)) },
				],
				profile: input.profile,
				apiKey: input.apiKey,
				options: { ...this.resolvedOptions(input.item, undefined), [MODEL_OPTION_REASONING]: 'low' },
				maxOutputTokens: 2_000,
			}, token), CancellationToken.None)) {
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				}
			}
			const experience = parseExperience(text);
			if (!experience) {
				this.logService.info(`[volt] reflection on ${session.sessionId}: nothing worth keeping`);
				return;
			}
			const draft = lessonMemory(experience, await this.memory.list('project'));
			if (draft) {
				await this.memory.write(draft);
				this.logService.info(`[volt] reflection on ${session.sessionId} kept a lesson: ${draft.description}`);
			}
		} catch (err) {
			this.logService.trace('[volt] run reflection failed', err);
		} finally {
			this.reflecting.delete(session.sessionId);
		}
	}

	/** Whose app state a chat shares: its project (the folder it works in), or this machine's when it has none. */
	private appStateKey(session: ISessionState): string {
		return this.executionRoot(session)?.toString() ?? 'no-folder';
	}

	/** The tools a subagent gets: built-ins read only; a defined one by its `tools:` list or its read/write setting. */
	private subagentToolNames(request: ISubagentRequest, definition: ISubagentDoc | undefined, background: boolean): Set<string> {
		const readOnly = new Set([...SUBAGENT_TOOLS, 'web_search', 'web_fetch']);
		if (!definition) {
			return new Set([...SUBAGENT_TOOLS, ...(request.kind === 'research' ? ['web_search', 'web_fetch'] : [])]);
		}
		let names: Set<string>;
		if (definition.tools?.length) {
			names = new Set(['skill']);
			for (const tool of definition.tools) {
				const key = tool.trim().replace(/\(.*\)$/, '').toLowerCase();
				for (const mapped of SUBAGENT_TOOL_ALIASES[key] ?? [tool.trim()]) {
					names.add(mapped);
				}
			}
		} else if (definition.readonly) {
			names = readOnly;
		} else {
			// Everything the main agent has, except starting more subagents and asking the user mid-way in the background.
			names = new Set(['read_file', 'list_dir', 'edit_file', 'write_file', 'delete_file', 'grep', 'glob', 'diagnostics', 'code_nav', 'shell', 'job_output', 'job_wait', 'job_stop', 'git_status', 'git_diff', 'git_log', 'git_show', 'web_search', 'web_fetch', 'skill', 'todo', 'state_read', 'state_update', ...(background ? [] : [NATIVE_ASK_QUESTION_TOOL_NAME])]);
		}
		if (definition.readonly) {
			names = new Set([...names].filter(name => readOnly.has(name)));
		}
		names.delete('task');
		return names;
	}

	/** `inherit` (or nothing usable) keeps the chat's model; a model id, a label, or an alias such as `sonnet` picks an enabled native model. */
	private subagentModel(model: string, fallback: IVoltCatalogItem | undefined): IVoltCatalogItem | undefined {
		const wanted = model.trim().toLowerCase();
		if (!wanted || wanted === 'inherit' || wanted === 'fast' || wanted === 'default') {
			return fallback;
		}
		const models = this.catalog.filter(candidate => candidate.enabled && candidate.kind === 'model');
		return models.find(candidate => candidate.ref.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted)
			?? models.find(candidate => candidate.label.toLowerCase() === wanted)
			?? (fallback && fallback.kind === 'model' && fallback.id.toLowerCase().includes(wanted) ? fallback : undefined)
			?? models.find(candidate => candidate.id.toLowerCase().includes(wanted) || candidate.label.toLowerCase().includes(wanted))
			?? fallback;
	}

	/** A background subagent's report goes to the chat's agent while it runs, else onto the chat as a notice. */
	private deliverBackgroundReport(session: ISessionState, run: IRunState, parent: INativeState, label: string, report: { text: string; isError?: boolean }, id?: string): void {
		const message = `<subagent_report name="${label}"${report.isError ? ' status="error"' : ''}>\n${report.text}\n</subagent_report>`;
		if (id) {
			// Off the list and owed to the agent, in one save: a crash now delivers it once, never twice or never.
			this.liveBackground.delete(id);
			void this.journal.delete(id);
			parent.background = parent.background?.filter(agent => agent.id !== id);
			(parent.reports ??= new Set()).add(message);
			void this.journal.schedule(session.sessionId, () => journalEntry(parent), true);
		}
		if (this.isCurrent(session, run) && !run.ended) {
			parent.inbox.push(message);
			this.emit(session, run.runId, { type: 'inbox', claimed: 0 });
			return;
		}
		// The run already ended: the next prompt carries the report, and the user sees it now.
		parent.inbox.push(message);
		this.emit(session, run.runId, { type: 'notice', severity: report.isError ? 'warning' : 'info', title: `The ${label} subagent finished.`, description: report.text.slice(0, 600) });
	}

	/**
	 * `sessionStart` (once per chat) and `beforeSubmitPrompt` hooks. Undefined when a hook refused
	 * the prompt (the run is ended); otherwise the context the hooks asked to add to it.
	 */
	private async promptHooks(session: ISessionState, run: IRunState, request: IVoltSendRequest, context: IVoltHookRunContext): Promise<string[] | undefined> {
		this.hookFollowups.delete(session.sessionId);
		const notes: string[] = [];
		const refuse = (title: string, reason: string, userMessage?: string) => {
			this.emit(session, run.runId, { type: 'notice', severity: 'warning', title, description: [reason, userMessage && userMessage !== reason ? userMessage : undefined].filter(Boolean).join('\n') });
			this.finish(session, run, 'abort');
			return undefined;
		};
		if (!this.hookStartedSessions.has(session.sessionId)) {
			this.hookStartedSessions.add(session.sessionId);
			const resumed = session.messages.filter(message => message.role === 'user').length > 1;
			const started = await this.hooks.run('sessionStart', context, protocol => protocol === 'claude'
				? { source: resumed ? 'resume' : 'startup' }
				: { session_id: session.sessionId, is_background_agent: false, composer_mode: request.mode });
			if (started.blocked !== undefined || started.stopRun) {
				return refuse('A session hook stopped this chat.', started.blocked ?? started.stopRun ?? '', started.userMessage);
			}
			notes.push(...started.context);
		}
		const submitted = await this.hooks.run('beforeSubmitPrompt', context, protocol => protocol === 'claude' ? { prompt: request.text } : { prompt: request.text, attachments: [] });
		if (submitted.blocked !== undefined || submitted.stopRun) {
			return refuse('A hook blocked this prompt.', submitted.blocked ?? submitted.stopRun ?? '', submitted.userMessage);
		}
		if (submitted.userMessage) {
			this.emit(session, run.runId, { type: 'notice', severity: 'info', title: submitted.userMessage });
		}
		notes.push(...submitted.context);
		return notes;
	}

	/** `stop` hooks when the agent wants to finish: a follow-up sends it back to work, a few times per run at most. */
	private async stopHooks(session: ISessionState, assistant: string, context: IVoltHookRunContext): Promise<{ readonly kind: 'inject'; readonly message: string } | undefined> {
		const loops = this.hookFollowups.get(session.sessionId) ?? 0;
		const result = await this.hooks.run('stop', context, protocol => protocol === 'claude'
			? { stop_hook_active: loops > 0, last_assistant_message: assistant.slice(-4_000) }
			: { status: 'completed', loop_count: loops });
		const followup = result.followup?.trim();
		if (result.stopRun || !followup || loops >= MAX_HOOK_FOLLOWUPS) {
			return undefined;
		}
		this.hookFollowups.set(session.sessionId, loops + 1);
		if (context.runId) {
			this.emit(session, context.runId, { type: 'notice', severity: 'info', title: 'A stop hook sent the agent back to work.', description: followup.slice(0, 300) });
		}
		return { kind: 'inject', message: followup };
	}

	/** A hook answered "stop": end the run the way Stop does, and say why. */
	private stopRunForHook(session: ISessionState, run: IRunState, reason: string): void {
		if (!this.isCurrent(session, run) || run.ended) {
			return;
		}
		this.emit(session, run.runId, { type: 'notice', severity: 'warning', title: 'A hook stopped the run.', description: reason });
		this.cancelRun(session, run);
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

	/**
	 * What a native turn reads before its request. The file reads start at once; MCP servers start
	 * connecting at once too, but the tool list is taken when `read` is called, so servers that come
	 * up meanwhile (during the settle wait and the prompt hooks) are in it.
	 */
	private nativeTurnInputs(root: URI | undefined, allowMcp: boolean): { readonly root: URI | undefined; read(): Promise<INativeTurnInputs> } {
		const home = this.pathService.userHome().catch(() => undefined);
		const projectInstructions = this.workspaceProjectInstructions(root);
		const instructions = this.workspaceInstructions(root);
		const memoryContext = this.memory.context().catch(() => undefined);
		if (allowMcp) {
			void home.then(dir => this.mcpHost.prewarm(root, dir)).catch(() => undefined);
		}
		return {
			root,
			read: async () => {
				const [project, snapshot, mcpTools, memory] = await Promise.all([
					projectInstructions,
					instructions,
					// Never held for a server still starting: it joins the next turn instead.
					allowMcp ? home.then(dir => this.mcpHost.tools(root, dir, MCP_SEND_WAIT_MS)).catch(() => []) : Promise.resolve([]),
					memoryContext,
				]);
				return { projectInstructions: project, instructions: snapshot, mcpTools, memoryContext: memory };
			},
		};
	}

	/** The profile's API key, read from secret storage once and kept until the secret changes. */
	private apiKey(profile: IProviderProfile): Promise<string | undefined> {
		if (!profile.hasSecret) {
			return Promise.resolve(undefined);
		}
		const cached = this.apiKeys.get(profile.id);
		if (cached) {
			return cached;
		}
		const value = this.secretStorage.get(secretKeyForProfile(profile.id));
		this.apiKeys.set(profile.id, value);
		value.catch(() => {
			if (this.apiKeys.get(profile.id) === value) {
				this.apiKeys.delete(profile.id);
			}
		});
		return value;
	}

	/** Drops cached skills and rules when a file under an instruction folder changed. */
	private invalidateInstructions(resources: readonly URI[]): void {
		if (this.instructionsByRoot.size && resources.some(affectsInstructions)) {
			this.instructionsByRoot.clear();
		}
	}

	/** Skills and rules, kept until one of their files changes (see INSTRUCTIONS_TTL_MS). */
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
		const knobs = deepseekKnobs(this.getAccessMode(session.sessionId));
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
		const knobs = deepseekKnobs(this.getAccessMode(session.sessionId));
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

	/**
	 * The turn primer (common/harness/preflight.ts) on a chat's first turn with an ACP agent: the
	 * relevant project files and, for UI work, the app serving in the chat's browser with the audits
	 * the request names. Bounded in time; whatever fails or runs late is left out.
	 */
	private async turnPrimer(session: ISessionState, run: IRunState, request: IVoltSendRequest, intent: IIntent): Promise<string | undefined> {
		if (session.messages.some(message => message.role === 'assistant')) {
			return undefined;
		}
		const plan = preflightPlan(request.text, intent);
		const root = this.executionRoot(session);
		if (!plan || !root || root.scheme !== Schemas.file) {
			return undefined;
		}
		const started = Date.now();
		const browserTools = this.hostTools.getMcpServers().length > 0 && this.hostTools.listTools().some(tool => tool.name === 'browser_run');
		const [files, browser] = await Promise.all([
			plan.files ? raceTimeout(this.primerFiles(root, request.text, !!intent.uiWork).catch(() => undefined), 5000) : undefined,
			plan.browser && browserTools ? raceTimeout(this.browserPreflight(session, run, request.mode, root, plan).catch(err => {
				this.logService.warn('[volt] browser preflight failed', err);
				return undefined;
			}), 25_000) : undefined,
		]);
		if (!this.isCurrent(session, run)) {
			return undefined;
		}
		this.logService.info(`[volt] primer for run ${run.runId}: ${files ? `${files.length} chars of files` : 'no files'}, ${browser ? `browser ${browser.length} lines` : 'no browser'} in ${Date.now() - started} ms`);
		return [files, browser?.join('\n')].filter(Boolean).join('\n\n') || undefined;
	}

	private async browserPreflight(session: ISessionState, run: IRunState, mode: VoltMode, root: URI, plan: IPreflightPlan): Promise<readonly string[] | undefined> {
		const start = (await this.workspaceRunPlan(root)).start;
		const allowStart = !!start && modePolicy(mode).allowTerminal && this.policyAllows(session, run, start);
		const result = await this.hostTools.preflightBrowser(session.sessionId, { cwd: root.fsPath, start, allowStart, a11y: plan.a11y, widths: plan.widths, perf: plan.perf }, run.cancel.token);
		return result.lines.length ? result.lines : undefined;
	}

	/** The project's files an agent most likely needs for `request`, as primer text (see selectPrimerFiles). */
	private async primerFiles(root: URI, request: string, uiWork: boolean): Promise<string | undefined> {
		const entries: IPrimerEntry[] = [];
		const walk = async (dir: URI, rel: string, depth: number): Promise<void> => {
			if (depth > 6 || entries.length >= 3000) {
				return;
			}
			const stat = await this.fileService.resolve(dir, { resolveMetadata: true }).catch(() => undefined);
			const folders: Promise<void>[] = [];
			for (const child of stat?.children ?? []) {
				const path = rel ? `${rel}/${child.name}` : child.name;
				if (child.isDirectory) {
					if (!PRIMER_SKIP_DIRS.has(child.name) && !child.name.startsWith('.')) {
						folders.push(walk(child.resource, path, depth + 1));
					}
				} else if (!child.name.startsWith('.') || child.name === '.env.example') {
					entries.push({ path, size: child.size ?? 0 });
				}
			}
			await Promise.all(folders);
		};
		await walk(root, '', 0);
		const candidates = entries.filter(primerCandidate);
		if (!candidates.length) {
			return undefined;
		}
		const small = candidates.length <= 60 && candidates.reduce((sum, entry) => sum + entry.size, 0) <= 96 * 1024;
		const toRead = small ? candidates : rankPrimerFiles(candidates, request, new Map(), uiWork).slice(0, 30);
		const contents = new Map<string, string>();
		await Promise.all(toRead.map(async entry => {
			const text = await this.fileService.readFile(joinPath(root, entry.path)).then(content => content.value.toString(), () => undefined);
			if (text !== undefined && !text.includes('\u0000')) {
				contents.set(entry.path, text);
			}
		}));
		return formatPrimerFiles(selectPrimerFiles(rankPrimerFiles(candidates, request, contents, uiWork), contents));
	}

	/**
	 * What the user has open beside the chat (right-panel tabs, the device and its app, terminals,
	 * git), for agents that cannot see Volt's window. Sent when this agent session has not heard it
	 * or it changed, so an unchanged window costs nothing; workspace_status has the details. The
	 * window answers within a bounded time or the turn goes without.
	 */
	private async workspaceLead(session: ISessionState, handle: IAgentSessionHandle): Promise<string | undefined> {
		const snapshot = await this.commandService.executeCommand<IWorkspaceSnapshot | undefined>(WORKSPACE_SNAPSHOT_COMMAND_ID, session.sessionId).catch(() => undefined);
		if (!snapshot) {
			return undefined;
		}
		const key = workspaceContextKey(snapshot);
		if (session.workspaceSent?.handle === handle && session.workspaceSent.key === key) {
			return undefined;
		}
		session.workspaceSent = { handle, key };
		return formatWorkspaceContext(snapshot);
	}

	/** What `buildAcpLead` reads, and nothing else: the lead is built on every turn's critical path. */
	private async contextPackInput(session: ISessionState, mode: VoltMode, intent: IIntent, withMemory: boolean): Promise<IContextPackInput> {
		const root = this.executionRoot(session);
		return {
			...(withMemory ? { memory: await this.memory.context() } : {}),
			mode,
			intent: { ...intent, groups: this.effectiveGroups(session, intent) },
			runPlan: intent.wantsPreview ? await this.workspaceRunPlan(root) : undefined,
			environment: this.environmentFacts(root),
			...(intent.shape ? { shape: intent.shape } : {}),
			...(mode === 'multitask' ? { taskModels: [...new Set(this.listCatalog().filter(item => item.enabled).map(item => item.label))] } : {}),
			visuals: this.hostTools.getMcpServers().length > 0 && this.hostTools.listTools().some(tool => tool.group === 'visuals'),
			...(withMemory && await this.largeIndexedProject(root) ? { codeIndexed: true } : {}),
			browserTools: this.hostTools.getMcpServers().length > 0 && this.hostTools.listTools().some(tool => tool.name === 'browser_run'),
			...(intent.wantsGit && this.hostTools.getMcpServers().length > 0 && this.hostTools.listTools().some(tool => tool.name === 'propose_commits') ? { commitReview: true } : {}),
		};
	}

	/**
	 * The code a message names, found before the agent's first step (Settings > Code Intelligence).
	 * Volt's own models get snippets within ~1.5k tokens; CLI agents, which read files themselves,
	 * get a short list of files. Nothing when the message names nothing code-like.
	 */
	private async retrieveContext(session: ISessionState, run: IRunState, text: string, forAgent: boolean): Promise<IRetrievedContext | undefined> {
		const root = this.executionRoot(session);
		if (!root || root.scheme !== Schemas.file || !retrievalEnabled(this.configurationService)) {
			return undefined;
		}
		try {
			const result = await this.retriever.retrieve(root, text, {
				budgetTokens: forAgent ? 400 : 1_500,
				deadlineMs: forAgent ? 300 : 500,
				snippets: !forAgent,
				...(session.retrievalSeen ? { seen: session.retrievalSeen } : {}),
				changed: () => this.workingTreeChanges(root),
				indexOnly: this.otherRunsActive(session),
				token: run.cancel.token,
			});
			if (result && this.isCurrent(session, run)) {
				run.metrics.noteRetrieval(result);
				const seen = session.retrievalSeen ??= new Set();
				for (const path of result.withCode) {
					seen.add(path);
				}
				this.logService.trace(`[volt] retrieval: ${result.ms}ms, ${result.searches} searches, ${result.tokens} tokens, ${result.files.length} files${result.partial ? ' (cut short)' : ''}`);
			}
			return result;
		} catch (err) {
			this.logService.trace('[volt] retrieval failed', err);
			return undefined;
		}
	}

	/** Another chat's run is going: background work for this one should not compete with it for every core. */
	private otherRunsActive(session: ISessionState): boolean {
		for (const other of this.sessions.values()) {
			if (other !== session && isRunActive(other)) {
				return true;
			}
		}
		return false;
	}

	/** Files the work tree has changed, relative to the repository root (cached for a few seconds). */
	private workingTreeChanges(root: URI): Promise<ReadonlySet<string>> {
		const key = root.toString();
		const cached = this.workingTreeChangesByRoot.get(key);
		if (cached && Date.now() - cached.at < 5_000) {
			return cached.value;
		}
		const value = this.stdio.exec({ id: `volt-status-${generateUuid().slice(0, 8)}`, command: 'git status --porcelain=v1 -z --untracked-files=normal', cwd: root.fsPath, timeoutMs: 2_000, inlineChars: 400_000 })
			.then(result => result.exitCode === 0 ? parsePorcelainZ(result.combined) : new Set<string>(), () => new Set<string>());
		this.workingTreeChangesByRoot.set(key, { at: Date.now(), value });
		return value;
	}

	/** Worth telling a CLI agent about instant_grep: a big project whose index is ready. */
	private async largeIndexedProject(root: URI | undefined): Promise<boolean> {
		if (!root || root.scheme !== Schemas.file || !this.searchIndex.enabled() || !this.hostTools.getMcpServers().length || !this.hostTools.listTools().some(tool => tool.name === INSTANT_GREP_TOOL_NAME)) {
			return false;
		}
		const [status] = await this.searchIndex.service.status([root.fsPath]).catch(() => []);
		return status?.state === 'ready' && status.files >= LARGE_INDEXED_PROJECT_FILES;
	}

	private async executeAgent(session: ISessionState, run: IRunState, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, intent: IIntent, previous: IRunState | undefined): Promise<void> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, run.runId, { type: 'error', message: `Unknown agent provider ${profile.providerId}` });
			this.finish(session, run, 'fail');
			return;
		}
		const token = run.cancel.token;
		// A short list of the files the message names, found while the agent starts.
		const retrieval = isCompactCommand(request.text) || isVoltNote(request.text) ? undefined : this.retrieveContext(session, run, request.text, true);
		// Another model from the same CLI is another agent session: restart it; the recap carries the thread over.
		const hasLiveAgent = () => !!session.agentHandle && session.agentProviderId === provider.id && session.agentRef === item.ref
			&& session.agentCwd === this.executionRoot(session)?.fsPath && session.agentSandboxKey === this.sandboxKey(session.sessionId) && (provider.isLive?.(session.agentHandle) ?? true);
		// One prompt at a time per agent session: a cancelled turn lets go of the agent before the
		// next prompt is written, or the agent is replaced.
		if (previous?.engine === 'agent' && !await this.waitSettled(previous, SETTLE_WAIT_AGENT_MS) && this.isCurrent(session, run) && session.agentHandle) {
			this.logService.info('[volt] the cancelled turn did not release its agent in time; using another one');
			this.disposeSessionAgent(session);
			session.agentSynced = 0;
		}
		if (session.restartPending && this.isCurrent(session, run)) {
			// Restarted while the previous turn held the agent (see restartAgent).
			session.restartPending = false;
			this.releaseAgent(session);
		}
		const turns: string[] = [];
		let voltCompaction = false;
		// A bare `/compact` with no live session that compacts itself: Volt's handoff summary, no model call.
		if (isCompactCommand(request.text) && !compactInstructions(request.text) && !(hasLiveAgent() && (provider.supportsCommand?.(session.agentHandle!, 'compact') ?? false))) {
			this.compactWithHandoff(session, run, item);
			return;
		}
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (!this.isCurrent(session, run)) {
					return;
				}
				try {
					let reused = false;
					const reusedAgent = hasLiveAgent();
					if (reusedAgent) {
						run.metrics.setAgentSource('live');
					} else if (attempt === 0 && await this.resumeAgentElsewhere(session, run, provider, profile, item, request)) {
						run.metrics.setAgentSource('live');
					} else {
						const cwd = this.executionRoot(session)?.fsPath;
						// Back on a model the chat was on before: its session is still warm, and only the turns it missed go to it.
						const parked = attempt === 0 ? this.takeParkedAgent(session, provider, item, cwd) : undefined;
						if (attempt === 0) {
							// The session being left stays warm for switching back.
							this.parkSessionAgent(session);
						}
						if (parked) {
							this.disposeSessionAgent(session);
							this.bindAgent(session, provider, item, cwd, parked.handle);
							session.agentSynced = parked.synced;
							reused = true;
							run.metrics.setAgentSource('live');
						} else {
							await this.acquireAgent(session, run, provider, profile, item, request, intent, attempt > 0);
						}
					}
					const handle = session.agentHandle;
					if (!this.isCurrent(session, run) || !handle) {
						return;
					}
					run.metrics.mark('agentReady');
					provider.setRunContext?.(handle, { sessionId: session.sessionId, runId: run.runId, mode: request.mode });
					const handoff = this.contextHandoff(session, item, reused);
					if (handoff && !reused) {
						session.agentJoinedLate = handle;
					}
					// After a move: the conversation so far happened in the old folder.
					const moved = session.moved?.model;
					// The turn primer (first turn only): the relevant files and the app open in the chat's browser.
					const primer = attempt === 0 ? await this.turnPrimer(session, run, request, intent) : undefined;
					const [pack, workspace] = await Promise.all([this.contextPackInput(session, request.mode, intent, !reusedAgent && !reused), this.workspaceLead(session, handle)]);
					const lead = [handoff?.text, moved, buildAcpLead(pack), (await retrieval)?.text, primer, workspace].filter(Boolean).join('\n\n') || undefined;
					if (moved && session.moved?.model === moved) {
						session.moved = undefined;
					}
					if (!this.isCurrent(session, run)) {
						return;
					}
					if (handoff) {
						this.emitContextHandoff(session, run, item, handoff, reused);
					}
					const images = this.modelImages(request.images);
					// An agent with no /compact of its own writes a hand-off summary that replaces the history.
					voltCompaction = isCompactCommand(request.text) && !(provider.supportsCommand?.(handle, 'compact') ?? false);
					const text = voltCompaction ? agentCompactionPrompt(compactInstructions(request.text)) : request.text;
					const first = await this.agentTurn(session, run, provider, handle, profile, { text: request.mode === 'plan' ? withPlanModeInstruction(text) : text, mode: request.mode, lead, ...(images ? { images } : {}), ...(request.resources?.length ? { resources: request.resources } : {}) }, attempt === 0);
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
					let incomplete = first.incomplete;
					// The agent wants to stop. Volt's checks may send it back once per reason. A run cut at its
					// budget is not finished: the orchestrator continues it in a fresh run instead.
					while (reason === 'done' && !incomplete && !voltCompaction) {
						const message = await this.qualityContinuation(session, run) ?? await this.agentErrorGate(session, run);
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
						incomplete = next.incomplete;
					}
					if (!this.isCurrent(session, run)) {
						return;
					}
					const assistant = turns.filter(text => text.trim()).join('\n\n');
					const agentActivity = this.runActivity(run);
					if (assistant || agentActivity) {
						session.messages.push({ role: 'assistant', content: assistant, model: item.label, ...(agentActivity ? { activity: agentActivity } : {}) });
					}
					session.agentSynced = session.messages.length;
					if (voltCompaction && reason === 'done' && assistant.trim()) {
						// The summary is the whole context now; the next prompt starts a fresh agent briefed with it.
						const dropped = session.messages.length;
						session.messages = compactedHistory(assistant);
						this.releaseAgent(session);
						this.releaseParked(session);
						this.emit(session, run.runId, { type: 'compaction', stages: ['handoff'], dropped });
						this.emit(session, run.runId, { type: 'notice', severity: 'info', title: 'Conversation compacted', description: 'The next message starts a fresh agent session that sees only this summary.' });
					}
					this.finish(session, run, reason, incomplete);
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
		let incomplete: 'steps' | undefined;
		run.metrics.mark('prompt');
		for await (const event of provider.send(handle, message, profile, token)) {
			if (!this.isCurrent(session, run)) {
				continue;
			}
			if (event.type === 'run.end') {
				if (!reason) {
					reason = event.reason;
					incomplete = event.incomplete;
				}
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
		return { kind: 'end', reason: reason ?? 'done', assistant, ...(incomplete ? { incomplete } : {}) };
	}

	/** A warm spare when one fits (or is about to), otherwise a cold start bound to this chat. */
	/** After a move the same agent conversation continues in the new folder; the agent keeps what it has seen. */
	private async resumeAgentElsewhere(session: ISessionState, run: IRunState, provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, request: IVoltSendRequest): Promise<boolean> {
		const handle = session.agentHandle;
		const cwd = this.executionRoot(session)?.fsPath;
		if (!handle || !provider.resumeIn || session.agentProviderId !== provider.id || session.agentRef !== item.ref || session.agentCwd === cwd) {
			return false;
		}
		const resumed = await provider.resumeIn(handle, this.agentStartRequest(session.sessionId, profile, item, cwd, request.options, request.mode));
		if (!resumed || !this.isCurrent(session, run)) {
			if (resumed) {
				void provider.dispose(resumed).catch(() => undefined);
			}
			return false;
		}
		session.agentHandle = resumed;
		session.agentCwd = cwd;
		session.agentUsedAt = Date.now();
		await provider.applyAccessPolicy?.(resumed, this.policyFor(session.sessionId));
		return true;
	}

	/**
	 * The conversation the session about to answer has not seen, sized to the receiving model's
	 * window: everything before this prompt for a new session, only the missed turns for one the
	 * chat comes back to.
	 */
	private contextHandoff(session: ISessionState, item: IVoltCatalogItem, reused: boolean): (IContextHandoff & { readonly fromLabel?: string }) | undefined {
		const synced = Math.min(session.agentSynced ?? 0, Math.max(0, session.messages.length - 1));
		const unseen = session.messages.slice(synced, -1);
		if (!unseen.length) {
			return undefined;
		}
		const earlier = session.messages.slice(0, -1);
		const fromLabel = findLast(reused ? unseen : earlier, message => message.role === 'assistant' && message.model && message.model !== item.label)?.model;
		const forked = !!session.forkedFrom;
		session.forkedFrom = undefined;
		const continued = reused ? undefined : session.continuedFrom;
		session.continuedFrom = undefined;
		const reason: HandoffReason = reused ? 'return' : continued ? 'continue' : forked ? 'fork' : fromLabel ? 'switch' : 'resume';
		const handoff = buildContextHandoff({
			messages: unseen,
			budget: this.handoffBudgetFor(item),
			reason,
			firstTurn: countUserTurns(session.messages.slice(0, synced)) + 1,
			...(fromLabel ? { fromLabel } : {}),
			toLabel: item.label,
			// Turns left out are read from the chat they happened in.
			threadId: continued?.id ?? session.sessionId,
			...(continued ? { fromChat: continued.title, ...(continued.live ? { lastTurnLive: true } : {}) } : {}),
		});
		return handoff && { ...handoff, ...(fromLabel ? { fromLabel } : {}) };
	}

	/** The divider over the turn: what was handed to the agent, and how the budget was spent. */
	private emitContextHandoff(session: ISessionState, run: IRunState, item: IVoltCatalogItem, handoff: IContextHandoff & { readonly fromLabel?: string }, reused: boolean): void {
		this.emit(session, run.runId, {
			type: 'context.handoff',
			reason: handoff.reason,
			...(handoff.fromLabel ? { fromLabel: handoff.fromLabel } : {}),
			toLabel: item.label,
			tokens: handoff.tokens,
			budget: handoff.budget,
			reused,
			turns: handoff.turns,
			verbatimTurns: handoff.verbatimTurns,
			condensedTurns: handoff.condensedTurns,
			omittedTurns: handoff.omittedTurns,
			toolCalls: handoff.toolCalls,
			files: handoff.files.length,
			text: handoff.text,
		});
	}

	private handoffBudgetFor(item: IVoltCatalogItem): number {
		const setting = (key: string) => {
			const value = this.configurationService.getValue<unknown>(key);
			return typeof value === 'number' ? value : undefined;
		};
		return handoffBudget({ contextWindow: item.capabilities.contextWindow, percent: setting(HANDOFF_BUDGET_PERCENT_SETTING), maxTokens: setting(HANDOFF_MAX_TOKENS_SETTING) });
	}

	/**
	 * `/compact` for an agent that has none of its own (or no live session to run it in): the
	 * conversation becomes Volt's handoff summary (recent turns verbatim, older ones condensed),
	 * and the next prompt starts a fresh session briefed with it. Nothing is sent to a model.
	 */
	private compactWithHandoff(session: ISessionState, run: IRunState, item: IVoltCatalogItem): void {
		if (session.messages.at(-1)?.role === 'user' && isCompactCommand(session.messages.at(-1)!.content)) {
			// The /compact message is a command, not part of the conversation.
			session.messages.pop();
		}
		const id = generateUuid();
		const startedAt = Date.now();
		this.emit(session, run.runId, { type: 'context.compaction', id, status: 'running', trigger: 'manual' });
		const handoff = buildContextHandoff({ messages: session.messages, budget: compactionBudget(item.capabilities.contextWindow), reason: 'compact', threadId: session.sessionId });
		if (!handoff) {
			this.emit(session, run.runId, { type: 'context.compaction', id, status: 'failed', error: 'Nothing to compact yet.' });
			this.finish(session, run, 'done');
			return;
		}
		session.messages = [{ role: 'assistant', content: handoff.text, model: item.label, compacted: true }];
		// Sessions that hold the long history would bring it back.
		this.releaseAgent(session);
		this.releaseParked(session);
		this.compactionPlans.delete(session.sessionId);
		this.emit(session, run.runId, { type: 'context.compaction', id, status: 'completed', trigger: 'manual', postTokens: handoff.tokens, durationMs: Date.now() - startedAt, summary: handoff.text });
		// The meter's reading until the next session reports its own: the summary (the meter adds the prompt base).
		this.emit(session, run.runId, { type: 'usage', input: 0, output: 0, used: handoff.tokens });
		this.finish(session, run, 'done');
	}

	private readonly compactionPlans = new Map<string, { readonly key: string; readonly plan: IVoltCompactionPlan | undefined }>();

	compactionPlan(sessionId: string, providerRef: string | undefined): IVoltCompactionPlan | undefined {
		const session = this.sessions.get(sessionId);
		if (!session || !session.messages.some(message => message.role === 'assistant')) {
			return undefined;
		}
		const ref = providerRef ?? session.providerRef;
		const item = this.catalog.find(candidate => candidate.ref === ref && candidate.enabled);
		if (!item) {
			return undefined;
		}
		if (item.kind !== 'agent') {
			return { kind: 'native', label: item.label };
		}
		const provider = session.agentProviderId ? this.agentProviders.get(session.agentProviderId) : undefined;
		if (session.agentHandle && session.agentRef === item.ref && provider && (provider.isLive?.(session.agentHandle) ?? true) && (provider.supportsCommand?.(session.agentHandle, 'compact') ?? false)) {
			return { kind: 'native', label: item.label };
		}
		// Built once per transcript length: the chip asks on every meter refresh.
		const key = `${item.ref}\0${session.messages.length}\0${session.messages.at(-1)?.content.length ?? 0}`;
		const cached = this.compactionPlans.get(sessionId);
		if (cached?.key === key) {
			return cached.plan;
		}
		const handoff = buildContextHandoff({ messages: session.messages, budget: compactionBudget(item.capabilities.contextWindow), reason: 'compact' });
		const plan: IVoltCompactionPlan | undefined = handoff ? { kind: 'handoff', tokens: handoff.tokens, label: item.label } : undefined;
		this.compactionPlans.set(sessionId, { key, plan });
		return plan;
	}

	private async acquireAgent(session: ISessionState, run: IRunState, provider: IAgentProvider, profile: IProviderProfile, item: IVoltCatalogItem, request: IVoltSendRequest, intent: IIntent, restart: boolean): Promise<void> {
		const cwd = this.executionRoot(session)?.fsPath;
		const sandbox = this.sandboxStart(session.sessionId, cwd);
		const spareRequest = this.spareRequest(provider, profile, item, cwd, request.options, sandbox);
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
		const parked = (provider as IAgentProvider & Partial<Pick<AcpAgentProvider, 'hasSpare'>>).hasSpare?.(this.agentStartRequest(session.sessionId, profile, item, cwd, request.options, request.mode, sandbox));
		await this.startAgentSession(session, run, provider, profile, item, request.mode, request.options);
		run.metrics.setAgentSource(restart ? 'restart' : parked ? 'pool' : 'cold');
	}

	private finish(session: ISessionState, run: IRunState, reason: 'done' | 'abort' | 'fail', incomplete?: 'steps'): void {
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
		if (reason === 'fail') {
			// The agent that asked is gone: its open question or approval can never reach it, and a
			// tray left open would keep the next run "waiting", out of the silent-run watchdog's sight.
			this.denyPending(session.sessionId);
		}
		if (session.agentHandle) {
			session.agentUsedAt = Date.now();
			this.agentReaper.schedule();
		}
		if (run.engine === 'native' && session.deepseek) {
			session.nativeUsedAt = Date.now();
			this.agentReaper.schedule();
		}
		this.emit(session, run.runId, { type: 'lifecycle', phase: reason === 'done' ? 'completed' : reason === 'abort' ? 'cancelled' : 'failed' });
		this.emit(session, run.runId, { type: 'run.end', runId: run.runId, reason, ...(incomplete && reason === 'done' ? { incomplete } : {}) });
		void run.settled.p.then(() => run.cancel.dispose());
		this.recordRun(session, run);
		this.afterRun(run);
		if (reason === 'done') {
			// Once the run's tools have unwound; the turn is already over for the user.
			void run.settled.p.then(() => this.checkAfterRun(session, run));
		}
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
					void this.healthCheck();
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
		if (event.type === 'file.change' && URI.isUri(event.uri)) {
			this.noteAgentChange(session, runId, event.uri, event.kind);
		}
		for (const listener of this.listeners.get(session.sessionId) ?? []) {
			listener(envelope);
		}
		this._onDidEmit.fire(envelope);
		if (this.deferredTitles.size && (event.type === 'text.delta' || event.type === 'run.end')) {
			const deferred = this.deferredTitles.get(session.sessionId);
			if (deferred && (event.type === 'run.end' || deferred.until === 'reply')) {
				this.deferredTitles.delete(session.sessionId);
				deferred.start();
			}
		}
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
		this.observeForHandoff(session, run, event);
		this.emit(session, run.runId, event);
	}

	/** Keeps what the run did (tool calls by what they touched, files it changed) for handoffs to other sessions. */
	private observeForHandoff(session: ISessionState, run: IRunState, event: IVoltEvent): void {
		const activity: NonNullable<IRunState['activity']> = run.activity ??= { tools: [], files: [], calls: new Map() };
		const cwd = run.engine === 'agent' ? session.agentCwd ?? this.executionRoot(session)?.fsPath : this.executionRoot(session)?.fsPath;
		switch (event.type) {
			case 'tool.start':
				activity.calls.set(event.callId, { kind: event.kind, name: event.name, title: event.title, input: event.input ?? '', paths: [...event.locations?.map(location => location.path) ?? [], ...event.diffs?.map(diff => diff.path) ?? []] });
				return;
			case 'tool.input.delta': {
				const call = activity.calls.get(event.callId);
				if (call) {
					call.input = event.append ? call.input + event.delta : event.delta;
				}
				return;
			}
			case 'tool.update': {
				const call = activity.calls.get(event.callId);
				if (call) {
					call.kind = event.kind ?? call.kind;
					call.title = event.title ?? call.title;
					call.paths.push(...event.locations?.map(location => location.path) ?? [], ...event.diffs?.map(diff => diff.path) ?? []);
				}
				return;
			}
			case 'tool.end': {
				const call = activity.calls.get(event.callId);
				activity.calls.delete(event.callId);
				if (!call) {
					return;
				}
				const failed = !!event.error || (event.exitCode !== undefined && event.exitCode !== 0);
				activity.tools.push(handoffToolCall({ ...call, title: event.title ?? call.title, paths: [...call.paths, ...event.diffs?.map(diff => diff.path) ?? []], failed }, cwd));
				for (const diff of event.diffs ?? []) {
					activity.files.push({ path: handoffPath(diff.path, cwd), kind: diff.oldText === null ? 'create' : 'edit' });
				}
				return;
			}
			case 'file.change':
				activity.files.push({ path: handoffPath(event.uri.fsPath, cwd), kind: event.kind });
				return;
		}
	}

	/** The run's activity as a reply carries it, or undefined when it only talked. */
	private runActivity(run: IRunState): IHandoffActivity | undefined {
		const activity = run.activity;
		return activity && (activity.tools.length || activity.files.length) ? { tools: activity.tools.slice(), files: activity.files.slice() } : undefined;
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
			run.shellMutated = true;
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
	 * Gets the regression gate ready without running anything: the project's test command (write
	 * modes, projects that declare one, and only when the access policy already lets it run without
	 * asking: Volt never prompts for its own checks), with a cached result for the same files as the
	 * baseline. The tests themselves run after the run ends (see checkAfterRun), so they never compete
	 * with the agent for CPU and never hold the turn open.
	 */
	private startQualityGate(session: ISessionState, run: IRunState): void {
		// A check left over from the previous turn would race this run's changes.
		this.cancelPostRunCheck(session.sessionId);
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
			// A change made since the send already dropped the cached result, so this is never stale.
			const cached = this.checkCache.get(rootKey);
			const baseline = cached && isSameCommand(cached.command, command) ? cached : undefined;
			run.quality = { root, rootKey, command, baseline: Promise.resolve(baseline), tainted: false };
		}, err => this.logService.trace('[volt] project checks unavailable', err));
	}

	/**
	 * After a run that changed files ends: runs the project's tests in the background (unless the
	 * agent already ran them after its last change and they passed, or they are known to be slow),
	 * compares with the baseline, and reports new failures as a notice. The result also becomes the
	 * baseline of the next run. The next send in the chat stops a check that is still running.
	 */
	private checkAfterRun(session: ISessionState, run: IRunState): void {
		const quality = run.quality;
		// `session.run` moved on when the chat already sent again: that run's changes are under way.
		if (!quality || session.run !== run || !modePolicy(run.mode).allowWrites || !run.lastMutation || run.lastTestPass >= run.lastMutation || this.slowChecks.has(quality.rootKey)) {
			return;
		}
		// Styles, docs and images cannot break a test suite: no background run (and no fans) for them.
		const changed = run.engine === 'native' ? [...(session.deepseek?.changed.keys() ?? [])] : [...(run.changedFiles?.values() ?? [])].map(file => file.uri);
		if (!run.shellMutated && changed.length && changed.every(uri => NO_CODE_IMPACT.test(uri.path))) {
			return;
		}
		const id = `volt-check-${generateUuid()}`;
		this.postRunChecks.set(session.sessionId, id);
		void quality.baseline.then(async cached => {
			const before = cached ?? quality.agentBaseline;
			const after = this.postRunChecks.get(session.sessionId) === id ? await this.runCheck(quality.root, quality.command, id) : undefined;
			if (this.postRunChecks.get(session.sessionId) !== id) {
				return;
			}
			this.postRunChecks.delete(session.sessionId);
			if (!after) {
				return;
			}
			if (after.durationMs > SLOW_CHECK_MS) {
				this.slowChecks.add(quality.rootKey);
			}
			this.cacheCheck(quality.root, after);
			const verdict = regressionVerdict(before, after);
			if (!verdict.regressed) {
				return;
			}
			run.regressed = true;
			const count = verdict.newFailures.length;
			const listed = verdict.newFailures.slice(0, 5).map(name => `- ${name}`).join('\n');
			this.emit(session, run.runId, {
				type: 'notice',
				severity: 'warning',
				title: count
					? localize('volt.check.newFailures', "{0} test(s) that passed before this run now fail.", count)
					: localize('volt.check.regressed', "The tests passed before this run and fail now."),
				description: [
					verdict.detail,
					listed || undefined,
					localize('volt.check.followUp', "Volt ran `{0}` after the run. Ask the agent to fix the failures, or review the changes.", quality.command),
				].filter(Boolean).join('\n'),
			});
		}).catch(err => this.logService.trace('[volt] post-run check failed', err));
	}

	/** Stops the chat's post-run check, if one is still running. */
	private cancelPostRunCheck(sessionId: string): void {
		const id = this.postRunChecks.get(sessionId);
		if (id) {
			this.postRunChecks.delete(sessionId);
			void this.stdio.cancelExec(id).catch(() => undefined);
		}
	}

	/**
	 * Called when the engine wants to stop: open to-dos may send the agent back, once. The tests are
	 * not run here, so the run ends as soon as the agent is done; checkAfterRun reports a regression
	 * afterwards. Returns the message that sends the agent back, or undefined to let it stop.
	 */
	private async qualityContinuation(session: ISessionState, run: IRunState): Promise<string | undefined> {
		if (!this.isCurrent(session, run) || run.cancel.token.isCancellationRequested) {
			return undefined;
		}
		const writes = modePolicy(session.mode).allowWrites;
		const decision = decideContinuation({ writes, verdict: undefined, after: undefined, todos: run.plan, used: run.continued });
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
		const policy: ICompiledPolicy = { ...this.policyFor(session.sessionId), overlay: compilePolicy({ overlay: modeOverlay(session.mode) }).overlay };
		return evaluateAccess(request, policy, { accessMode: this.getAccessMode(session.sessionId) }).effect === 'allow';
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
			this._register(provider.onDidChangeBackgroundTasks(task => this.onAgentBackgroundTask(provider, task)));
			this.agentProviders.set(provider.id, provider);
		}
		const generic = new AcpAgentProvider('acp-generic', 'Agent', 'agent', ['acp'], this.stdio, this.workspace, this.fileService, this.logService, this.hostTools);
		generic.setAccessGate(this.accessGate);
		generic.setFileWriteObserver(write => this.onAcpFileWrite(write));
		generic.setQuestionAsker((sessionId, runId, draft) => this.askQuestions(sessionId, runId, draft));
		generic.setSupervisionOptions(ACP_SUPERVISION);
		this._register(generic.onDidChangeBackgroundTasks(task => this.onAgentBackgroundTask(generic, task)));
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
		this.disabled = new Set(this.readJson<string[]>(VOLT_DISABLED_MODELS_STORAGE_KEY, []));
		this.taskModels = this.readJson(VOLT_TASK_MODELS_STORAGE_KEY, {});
		this.modeProfiles = this.readJson(VOLT_MODE_PROFILES_STORAGE_KEY, {});
		this.modelOptions = this.readJson(VOLT_MODEL_OPTIONS_STORAGE_KEY, {});
		this.accessMode = normalizeVoltAccessMode(this.storageService.get(VOLT_ACCESS_MODE_STORAGE_KEY, StorageScope.APPLICATION));
		const storedChats = this.readJson<Record<string, unknown>>(VOLT_ACCESS_CHATS_STORAGE_KEY, {});
		this.accessChats = Object.fromEntries(Object.entries(storedChats).filter((entry): entry is [string, VoltAccessMode] => isVoltAccessMode(entry[1])));
		const storedSandbox = this.readJson<{ defaults?: unknown; chats?: Record<string, unknown> }>(VOLT_SANDBOX_STORAGE_KEY, {});
		this.sandboxDefaults = normalizeSandboxSettings(storedSandbox.defaults);
		this.sandboxChats = Object.fromEntries(Object.entries(storedSandbox.chats ?? {}).map(([id, value]) => [id, normalizeSandboxSettings(value)]));
		this.projectRules = this.readWorkspaceJson(VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, []);
		this.savedRules = this.readWorkspaceJson(VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, []);
		this.recompilePolicy();
		const revision = this.storageService.getNumber(VOLT_CATALOG_REVISION_STORAGE_KEY, StorageScope.APPLICATION) ?? 0;
		const cached = revision >= VOLT_CATALOG_REVISION ? this.readJson<IVoltCatalogItem[]>(VOLT_CATALOG_STORAGE_KEY, []) : [];
		const enabledIds = new Set(this.profiles.filter(profile => profile.enabled).map(profile => profile.id));
		this.catalog = (Array.isArray(cached) ? cached : [])
			.filter(item => enabledIds.has(item.profileId))
			.map(item => ({ ...item, enabled: this.isModelShown(item.ref) }));
		if (revision < VOLT_CATALOG_REVISION && this.enabled.size) {
			this.enabled = new Set();
			this.storageService.store(VOLT_ENABLED_MODELS_STORAGE_KEY, '[]', StorageScope.APPLICATION, StorageTarget.USER);
		}
		this.activeCatalogRef = this.storageService.get(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
		this.hydrateAgentModelsFromCatalog();
		// The last run's CLI detections, so the Providers page and the catalog have them before this run checks again.
		const saved = this.readJson<{ at?: number; detections?: [string, IDetectResult][] }>(VOLT_DETECTIONS_STORAGE_KEY, {});
		if (Array.isArray(saved.detections) && typeof saved.at === 'number') {
			this.detections = new Map(saved.detections.filter(([id, detect]) => enabledIds.has(id) && typeof detect?.available === 'boolean'));
			this.lastProviderCheck = saved.at;
		}
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
		const stored = this.storageService.getNumber(VOLT_SEED_VERSION_STORAGE_KEY, StorageScope.APPLICATION) ?? 0;
		if (stored >= CLI_SEED_VERSION) {
			return;
		}
		let migrated = false;
		if (stored < 4) {
			this.profiles = this.profiles.map(profile => {
				if (profile.providerId !== 'grok' || profile.args?.length !== 1 || profile.args[0] !== 'acp') {
					return profile;
				}
				migrated = true;
				return { ...profile, args: ['agent', 'stdio'] };
			});
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
		}
		if (added.length || migrated) {
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
		const accessMode = this.getAccessMode(request.sessionId);
		const key = `${accessMode}\0${mode}\0${memoKey(request.action, request.resource.value)}`;
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
			...this.policyFor(request.sessionId),
			overlay: compilePolicy({ overlay: modeOverlay(mode) }).overlay,
		};
		const decision = evaluateAccess(request, policy, {
			accessMode,
			delegateMedium: accessBridgeFor(request.providerId).delegatesMediumReview === true && accessMode === 'auto',
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
		const answer = new Promise<IAccessDecision>(resolve => {
			this.pendingApprovals.set(request.id, { resolve, request: { ...request, reason: decision.policySource ?? request.reason } });
		});
		// Pending first: listeners read the pending list when the event fires (the agent server publishes it then).
		this.emitAccess(request, { type: 'access.ask', request });
		return answer;
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
		this.policyByMode.clear();
		this.policyMemo.clear();
	}

	private async pushPolicyToAgents(): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.agentHandle && session.agentProviderId) {
				await this.agentProviders.get(session.agentProviderId)?.applyAccessPolicy?.(session.agentHandle, this.policyFor(session.sessionId));
			}
		}
		for (const spare of this.agentPool.readySpares()) {
			await this.agentProviders.get(spare.providerId)?.applyAccessPolicy?.(spare.handle, this.policyFor(undefined));
		}
	}

	/** A chat changed its access mode: its running agent switches now, mid-turn included. */
	private async pushPolicyToAgent(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session?.agentHandle && session.agentProviderId) {
			await this.agentProviders.get(session.agentProviderId)?.applyAccessPolicy?.(session.agentHandle, this.policyFor(sessionId));
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

const TITLE_TIMEOUT_MS = 30_000;
/**
 * Room for the handoff summary plus the thinking before it; a summary cut off at this limit is not
 * used. High enough that a Claude thinking budget (derived from it, up to 24K) stays the run's own:
 * a different budget would miss the cached messages.
 */
const IN_CONTEXT_SUMMARY_OUTPUT_TOKENS = 32_000;

/** A compaction summary written ahead of time, and the first message it keeps. */
interface IPreparedCompaction {
	readonly boundary: number;
	readonly summary: string;
}

/** A background compaction summary in flight (see `shouldCompactEarly`). */
interface IBackgroundCompaction {
	readonly boundary: number;
	/** The run's compaction count when it started: after another compaction its boundary means nothing. */
	readonly compactions: number;
	readonly cts: CancellationTokenSource;
	readonly summary: Promise<string | undefined>;
	done: boolean;
}

/** Ollama, or a server on this machine (LM Studio, llama.cpp): one GPU, usually one request at a time. */
function servedLocally(profile: IProviderProfile | undefined): boolean {
	if (!profile) {
		return false;
	}
	if (profile.providerId === 'ollama') {
		return true;
	}
	try {
		const host = profile.endpoint?.baseURL ? new URL(profile.endpoint.baseURL).hostname : '';
		return host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || host.startsWith('127.');
	} catch {
		return false;
	}
}
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

/** The controller's directive with the evidence harness's send-back added (a finish it does not accept). */
function withSendBack(directive: DeepseekDirective, sendBack: string | undefined): DeepseekDirective {
	if (!sendBack || directive.kind === 'stop') {
		return directive;
	}
	return directive.kind === 'inject' ? { kind: 'inject', message: `${directive.message}\n\n${sendBack}` } : { kind: 'inject', message: sendBack };
}

/** Providers whose prompt cache Volt writes with the five-minute lifetime: Claude, direct or through OpenRouter. */
function keepsPromptCacheBriefly(providerId: string, modelId: string): boolean {
	return providerId === 'anthropic' || (providerId === 'openrouter' && /(?:^|[/~])anthropic\/|claude/i.test(modelId));
}
