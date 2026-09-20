/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
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
import { ISearchService } from '../../search/common/search.js';
import { evaluateAccess, memoKey } from '../common/access/accessBroker.js';
import { DEFAULT_ACCESS_MODE, normalizeVoltAccessMode, VOLT_ACCESS_MODE_STORAGE_KEY, VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, VoltAccessMode } from '../common/access/accessModes.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../common/access/accessPresets.js';
import { AccessDecisionScope, IAccessDecision, IAccessGate, IAccessRequest, ICompiledPolicy, IExecutionReceipt, IPermissionRule, PermissionEffect } from '../common/access/accessTypes.js';
import { compilePolicy } from '../common/access/policyCompiler.js';
import { accessBridgeFor } from './agents/bridges/accessBridges.js';
import { DEFAULT_ACP_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from '../common/capabilities.js';
import { IVoltEvent, IVoltEventEnvelope } from '../common/events.js';
import { IVoltModelOptions, resolveModelOptions, VOLT_MODEL_OPTIONS_STORAGE_KEY } from '../common/models/modelOptions.js';
import { modePolicy, VoltMode } from '../common/modes.js';
import { displayProviderLabel, IProviderProfile, IProviderProfileDraft, secretKeyForProfile, VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, VOLT_CATALOG_STORAGE_KEY, VOLT_DEFAULT_HEALTH_INTERVAL, VOLT_ENABLED_MODELS_STORAGE_KEY, VOLT_HEALTH_INTERVAL_STORAGE_KEY, VOLT_MODE_PROFILES_STORAGE_KEY, VOLT_PROFILES_STORAGE_KEY, VOLT_SEED_VERSION_STORAGE_KEY, VOLT_TASK_MODELS_STORAGE_KEY } from '../common/profiles.js';
import { IAgentDetectResult, IAgentProvider, IAgentSessionHandle, IDetectResult, IModelInfo, IModelMessage, IModelProvider, IVoltCatalogItem, IVoltProviderStatus, VoltProviderState } from '../common/providers.js';
import { resolveTabModel } from '../common/models/modelAccess.js';
import { IAgentRuntimeService, IVoltTaskModels } from '../common/runtime.js';
import { IVoltRunSnapshot, IVoltSendRequest, IVoltSession } from '../common/session.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolService } from '../common/hostTools.js';
import { AcpAgentProvider } from './agents/acpProvider.js';
import './host/hostToolService.js';
import { CLI_AGENT_DEFINITIONS, cliAgentDefinition, detectCliAgent } from './agents/cliAgents.js';
import { NullVoltStdioService } from './host/nullStdioService.js';
import { compilePrompt } from './prompt/promptCompiler.js';
import { loadProjectCheckFiles, loadWorkspaceRunPlan } from './host/workspaceRunPlan.js';
import { IIntent, mergeGrantedGroups } from '../common/harness/intent.js';
import { buildAcpLead, IContextPackInput, IEnvironmentFacts } from '../common/harness/contextPack.js';
import { INativeLoopMessage, NativeFinishReason, runNativeLoop } from '../common/harness/nativeLoop.js';
import { nativeToModelMessages } from '../common/harness/providerMessages.js';
import { runToolBatch } from '../common/harness/toolRuntime.js';
import { stringifyUnknown } from '../common/harness/toolResult.js';
import { actionForGroup, resourceForCall } from '../common/harness/toolAccess.js';
import { classifyRisk } from '../common/access/riskClassifier.js';
import { CapabilityGroup, laneDefinition } from '../common/harness/lanes.js';
import { IRoutableModel, IRoleAssignments, canEscalate, escalate } from '../common/harness/modelRouter.js';
import { workerFraming } from '../common/harness/orchestrator.js';
import { planEntries } from '../common/harness/plan.js';
import { applyHumanAction, IHumanAction } from '../common/harness/humanLoop.js';
import { IPreparedRun, prepareRun } from '../common/harness/pipeline.js';
import { bindLoopController, compactTurn, compactionEvent, createRunHarness, IRunHarness, workFromHarness } from '../common/harness/runHarness.js';
import { parseFinishPayload, renderOutcome, synthesize } from '../common/harness/synthesis.js';
import { checkTranscriptPairs } from '../common/harness/invariants.js';
import { detectProjectChecks } from '../common/harness/verification.js';
import { speculativeReads } from '../common/harness/toolPlanner.js';
import { runPreStep } from '../common/harness/preStep.js';
import { EvalLedger } from '../common/harness/eval.js';
import { applyRestored } from '../common/harness/restore.js';
import { isAcpTurnRestartable } from '../common/harness/sessionRetry.js';
import { IFileSnapshot } from '../common/harness/stateManager.js';
import { TaskLifecycle } from '../common/harness/lifecycle.js';
import { formatTaskBrief } from '../common/harness/taskIntel.js';
import { IToolCall, IToolResult, IVoltTool, toolSchemas, toolSnippets, visibleTools } from '../common/tools/tool.js';
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
	/** The pre-loop pipeline result for the active run. */
	prepared?: IPreparedRun;
	harness?: IRunHarness;
}

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
	private healthCheckRunning = false;
	private accessMode: VoltAccessMode = DEFAULT_ACCESS_MODE;
	private projectRules: IPermissionRule[] = [];
	private savedRules: IPermissionRule[] = [];
	private compiledPolicy: ICompiledPolicy = compilePolicy({});
	private tabAgent: { ref: string; handle: IAgentSessionHandle; provider: IAgentProvider } | undefined;
	private readonly policyMemo = new Map<string, IAccessDecision>();
	private readonly pendingApprovals = new Map<string, { resolve: (decision: IAccessDecision) => void; request: IAccessRequest }>();
	private receipts: IExecutionReceipt[] = [];
	private saveAccessHandle: ReturnType<typeof setTimeout> | undefined;
	private runPlan: Promise<IRunPlan> | undefined;
	private projectInstructions: Promise<string | undefined> | undefined;
	private readonly evalLedger = new EvalLedger();

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog: Event<void> = this._onDidChangeCatalog.event;
	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles: Event<void> = this._onDidChangeProfiles.event;
	private readonly _onDidChangeProviderStatus = this._register(new Emitter<void>());
	readonly onDidChangeProviderStatus: Event<void> = this._onDidChangeProviderStatus.event;
	private readonly _onDidChangeAccess = this._register(new Emitter<void>());
	readonly onDidChangeAccess: Event<void> = this._onDidChangeAccess.event;
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
	) {
		super();
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
	}

	async send(sessionId: string, request: IVoltSendRequest): Promise<string> {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.mode = request.mode;
		session.providerRef = request.providerRef ?? session.providerRef ?? this.defaultRef(request.mode);
		const live = session.activeRun && (session.activeRun.status === 'running' || session.activeRun.status === 'waiting') && session.harness;
		if (live && session.activeRun && session.harness) {
			this.denyPending(sessionId, 'follow-up');
			session.messages.push({ role: 'user', content: request.text });
			session.harness.inbox.inject(request.text, { wake: true, target: 'turn' });
			this.emit(session, session.activeRun.runId, { type: 'human', action: 'redirect', detail: request.text });
			this.emit(session, session.activeRun.runId, { type: 'inbox', claimed: 0 });
			return session.activeRun.runId;
		}
		session.messages.push({ role: 'user', content: request.text });

		const catalogItem = this.catalog.find(item => item.ref === session.providerRef && item.enabled) ?? this.catalog.find(item => item.enabled);
		const folder = this.workspace.getWorkspace().folders[0];
		const hasWorkspace = this.workspace.getWorkspace().folders.length > 0;
		const hasGit = folder ? await this.fileService.exists(URI.joinPath(folder.uri, '.git')) : false;
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
			workspaceId: folder?.uri.toString(),
			accessMode: this.accessMode,
			environment: {
				hasWorkspace,
				hasGit,
				hasBrowserHost: true,
				hasNetwork: true,
				...(folder ? { cwd: folder.uri.fsPath } : {}),
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
		this.emit(session, runId, { type: 'envelope', id: prepared.envelope.id, mode: request.mode, permissions: prepared.envelope.permissions });
		this.emit(session, runId, { type: 'lifecycle', phase: 'planning' });
		this.emit(session, runId, { type: 'lane', lane: prepared.intent.lane, signals: prepared.intent.signals, wantsPreview: prepared.intent.wantsPreview, wantsWeb: prepared.intent.wantsWeb });
		if (prepared.mission) {
			this.emit(session, runId, { type: 'mission', phase: prepared.mission.phase, detail: prepared.mission.goal });
		}
		if (prepared.plan) {
			this.emit(session, runId, { type: 'plan', entries: planEntries(prepared.plan) });
		}
		if (prepared.clarify) {
			this.emit(session, runId, { type: 'clarify', question: prepared.clarify, reasons: prepared.intel.ambiguity.reasons });
			this.emit(session, runId, { type: 'text.delta', id: 'clarify', delta: prepared.clarify });
			this.finish(session, runId, 'done');
			return runId;
		}
		this.emit(session, runId, { type: 'lifecycle', phase: 'running' });
		void this.execute(session, runId, request, prepared.intent).catch(err => {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, 'fail');
		});
		return runId;
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
			session.harness?.inbox.inject(effect.inject, true);
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
		yield* provider.stream({
			modelId: item.id,
			messages,
			profile,
			apiKey,
			options: this.resolvedOptions(item, options),
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
		const ref = `agent:${profile.id}`;
		return [{
			ref,
			kind: 'agent',
			providerId: profile.providerId,
			profileId: profile.id,
			id: profile.providerId,
			label,
			qualifier: undefined,
			enabled: this.enabled.size ? this.enabled.has(ref) : true,
			capabilities: DEFAULT_ACP_CAPABILITIES,
		}];
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
		if (this.healthCheckRunning) {
			return;
		}
		this.healthCheckRunning = true;
		try {
			const results = await Promise.all(this.profiles.map(async profile => {
				const detect = profile.enabled
					? await this.detectProfile(profile).catch(() => ({ available: false, detail: 'Health check failed.' }) satisfies IDetectResult)
					: undefined;
				return [profile.id, detect] as const;
			}));
			this.detections = new Map(results.filter((entry): entry is readonly [string, IDetectResult] => !!entry[1]));
			this.lastProviderCheck = Date.now();
		} finally {
			this.healthCheckRunning = false;
		}
		await this.refreshCatalog();
		this._onDidChangeProviderStatus.fire();
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
		const models = await provider.listModels(profile).catch(() => []);
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

	private async execute(session: ISessionState, runId: string, request: IVoltSendRequest, intent: IIntent): Promise<void> {
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
			await this.executeAgent(session, runId, request, profile, item, intent);
			return;
		}
		await this.executeModel(session, runId, request, profile, item, intent);
	}

	/** Detected once per workspace; only consulted when the user asked to see something running. */
	private workspaceRunPlan(): Promise<IRunPlan> {
		this.runPlan ??= loadWorkspaceRunPlan(this.fileService, this.workspace).catch(() => ({ kind: 'unknown' }));
		return this.runPlan;
	}

	private environmentFacts(): IEnvironmentFacts {
		return {
			cwd: this.workspace.getWorkspace().folders[0]?.uri.fsPath,
			platform: isWindows ? 'windows' : isMacintosh ? 'macos' : 'linux',
			shell: isWindows ? 'cmd' : 'zsh',
			date: new Date().toISOString().slice(0, 10),
		};
	}

	private workspaceProjectInstructions(): Promise<string | undefined> {
		this.projectInstructions ??= loadProjectInstructions(this.fileService, this.workspace.getWorkspace().folders[0]?.uri).catch(() => undefined);
		return this.projectInstructions;
	}

	private effectiveGroups(session: ISessionState, intent: IIntent): CapabilityGroup[] {
		return mergeGrantedGroups(intent.groups, session.extraGroups ?? [], session.mode);
	}

	private builtinTools(session: ISessionState, intent: IIntent): IVoltTool[] {
		return createBuiltinTools({
			fileService: this.fileService,
			searchService: this.searchService,
			requestService: this.requestService,
			stdio: this.stdio,
			hostTools: this.hostTools,
			root: () => this.workspace.getWorkspace().folders[0]?.uri,
			meta: {
				grantGroups: requested => {
					session.extraGroups = mergeGrantedGroups(this.effectiveGroups(session, intent), requested, session.mode);
					return session.extraGroups;
				},
			},
		});
	}

	private visibleSessionTools(session: ISessionState, intent: IIntent): IVoltTool[] {
		return visibleTools(this.builtinTools(session, intent), this.effectiveGroups(session, intent));
	}

	private async contextPackInput(session: ISessionState, mode: VoltMode, intent: IIntent, tools?: IVoltTool[]): Promise<IContextPackInput> {
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
			runPlan: intent.wantsPreview ? await this.workspaceRunPlan() : undefined,
			environment: this.environmentFacts(),
			projectInstructions: await this.workspaceProjectInstructions(),
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

	private async executeModel(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, intent: IIntent): Promise<void> {
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown model provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const toolsFor = () => this.visibleSessionTools(session, intent);
		const prepared = session.prepared;
		const checks = detectProjectChecks(await loadProjectCheckFiles(this.fileService, this.workspace.getWorkspace().folders[0]?.uri));
		const harness = prepared ? createRunHarness(prepared, checks, () => this.harnessCapabilities(session, item.ref)) : undefined;
		session.harness = harness;
		harness?.lifecycle.tryTransition('planning');
		harness?.lifecycle.tryTransition('running');
		if (harness) {
			harness.seams.register('fs', this.fileService, 'host');
			harness.seams.register('tools', this.hostTools, 'host');
			harness.seams.register('eval', this.evalLedger, 'host');
			const start = harness.state.latestCheckpoint();
			if (start) {
				this.emit(session, runId, { type: 'checkpoint', id: start.id, label: start.label, kind: start.kind });
			}
			this.emit(session, runId, { type: 'title', text: harness.title });
		}
		const compiled = compilePrompt(await this.contextPackInput(session, request.mode, intent, toolsFor()), session.messages.slice(0, -1), request.text);
		const loopMessages: INativeLoopMessage[] = compiled.map(message => ({
			role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
			content: message.content,
		}));
		const cancel = session.cancel!.token;
		if (prepared && harness) {
			const reads = speculativeReads(prepared.tools);
			if (reads.length) {
				this.emit(session, runId, { type: 'prefetch', paths: reads.map(read => read.args.path) });
				const prefetchCalls = reads.map((read, index) => ({ id: `prefetch-${index}`, name: read.name, args: read.args }));
				for (const call of prefetchCalls) {
					this.emit(session, runId, { type: 'tool.start', callId: call.id, name: call.name, kind: 'read' });
				}
				const prefetchResults = await this.executeToolCalls(session, runId, profile, intent, prefetchCalls, cancel);
				for (const result of prefetchResults) {
					this.emit(session, runId, {
						type: 'tool.end',
						callId: result.callId,
						result: result.text,
						error: result.isError ? result.text : undefined,
						durationMs: result.durationMs,
					});
					if (!result.isError && result.text.trim()) {
						loopMessages.push({ role: 'user', content: `Prefetched ${result.name}:\n${result.text}` });
					}
				}
			}
			const scheduled = harness.scheduler.snapshot();
			this.emit(session, runId, { type: 'scheduler', queued: scheduled.queued, running: scheduled.leased });
		}
		let currentItem = item;
		const tried: string[] = [];
		try {
			const result = await runNativeLoop({
				stream: messages => {
					const nextProfile = this.profiles.find(entry => entry.id === currentItem.profileId) ?? profile;
					const nextProvider = this.modelProviders.get(nextProfile.providerId) ?? provider;
					return this.streamModelTurn(nextProvider, currentItem, nextProfile, apiKey, request, messages, toolsFor(), cancel);
				},
				execute: calls => this.executeToolCalls(session, runId, profile, intent, calls, cancel),
				emit: event => {
					if (event.type === 'file.change' && harness) {
						const path = event.uri.scheme === 'file' ? event.uri.fsPath : (event.uri.path || event.uri.fsPath);
						harness.controller.recordFileChange(0, path, event.kind);
						const before = event.existed === false
							? undefined
							: event.before !== undefined ? harness.state.snapshot(path, event.before) : undefined;
						harness.state.record(0, path, event.kind, before);
					}
					this.emit(session, runId, event);
				},
			}, {
				messages: loopMessages,
				budget: intent.budget,
				token: cancel,
				isPaused: () => !!session.paused || !!session.harness?.paused,
				canContinue: () => !session.harness || session.harness.governor.snapshot().exceeded.length === 0,
				claimInboxBatch: () => harness?.inbox.claimBatch() ?? { texts: [], opensTurn: false },
				prepareStep: ({ messages, claimed, step }) => runPreStep({ messages, claimed, step, target: 'step' }),
				...(harness ? {
					controller: bindLoopController(harness, {
						emit: event => this.emit(session, runId, event),
						onAction: async action => {
							if (action === 'escalate') {
								const next = escalate(currentItem.ref, this.routableCatalog(), this.taskModelRoles(), {
									lane: intent.lane,
									mode: request.mode,
									intel: prepared!.intel,
									explicitRef: currentItem.ref,
								}, tried);
								if (next) {
									tried.push(currentItem.ref);
									const found = this.catalog.find(c => c.ref === next.ref && c.enabled);
									if (found) {
										currentItem = found;
										this.emit(session, runId, { type: 'decision', title: 'escalate', detail: next.reason });
									}
								}
							}
							if (action === 'rollback') {
								const point = harness.state.latestCheckpoint();
								if (point) {
									const rolled = harness.state.rollback(point.id);
									if (rolled?.restored.length) {
										const report = await this.applyFileRestore(rolled.restored);
										this.emit(session, runId, {
											type: 'decision',
											title: 'rollback',
											detail: `Restored ${report.applied} file${report.applied === 1 ? '' : 's'} to ${point.label}.`,
										});
									}
								}
							}
							if (action === 'isolate') {
								const worker = prepared?.orchestration.workers[0];
								if (worker) {
									harness.worktrees.allocate(worker.id);
									this.emit(session, runId, { type: 'decision', title: 'isolate', detail: `Isolated ${worker.id} into a worktree.` });
								}
							}
							if (action === 'delegate') {
								const worker = prepared?.orchestration.workers.find(entry => entry.role !== 'general') ?? prepared?.orchestration.workers[1];
								if (worker) {
									harness.inbox.inject(workerFraming(worker.role), { wake: true, target: 'step' });
									this.emit(session, runId, { type: 'decision', title: 'delegate', detail: `Handed the next step to ${worker.title}.` });
								}
							}
							if (action === 'reset') {
								harness.inbox.inject('Context was compacted. Continue from the evidence digest. Do not redo work already listed there.', { wake: true, target: 'step' });
							}
						},
					}),
					prepareTurn: messages => {
						const next = compactTurn(harness, messages, currentItem.capabilities.contextWindow || 128_000);
						const compact = compactionEvent(harness);
						if (compact) {
							this.emit(session, runId, compact);
						}
						return next;
					},
					enqueueInbox: text => { harness.inbox.inject(text, { wake: true, target: 'step' }); },
					assertSurface: messages => {
						const report = checkTranscriptPairs(messages);
						if (!report.ok) {
							this.emit(session, runId, { type: 'error', message: report.failures[0]?.detail ?? 'Transcript invariant failed.', retryable: false });
						}
					},
				} : {}),
			});
			if (result.assistant) {
				session.messages.push({ role: 'assistant', content: result.assistant });
			}
			if (harness && laneDefinition(intent.lane).synthesize) {
				this.emitOutcome(session, runId, harness, result.assistant, result.outcome);
			}
			if (result.outcome === 'budget') {
				this.emit(session, runId, { type: 'error', message: 'Stopped at the lane budget. Send another message to continue.', retryable: true });
			}
			this.finish(session, runId, result.outcome === 'abort' || session.cancel?.token.isCancellationRequested ? 'abort' : result.outcome === 'fail' ? 'fail' : 'done');
		} catch (err) {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, session.cancel?.token.isCancellationRequested ? 'abort' : 'fail');
		} finally {
			session.harness = undefined;
		}
	}

	private async *streamModelTurn(
		provider: IModelProvider,
		item: IVoltCatalogItem,
		profile: IProviderProfile,
		apiKey: string | undefined,
		request: IVoltSendRequest,
		messages: readonly INativeLoopMessage[],
		tools: IVoltTool[],
		token: CancellationToken,
	) {
		const kinds = new Map(tools.map(tool => [tool.name, tool.kind]));
		let finish: NativeFinishReason | undefined;
		for await (const event of provider.stream({
			modelId: item.id,
			messages: nativeToModelMessages(messages),
			profile,
			apiKey,
			options: this.resolvedOptions(item, request.options),
			tools: toolSchemas(tools),
		}, token)) {
			if (token.isCancellationRequested) {
				yield { type: 'finish', reason: 'abort' as const };
				return;
			}
			if (event.type === 'finish') {
				finish = event.reason;
				continue;
			}
			if (event.type === 'tool.start') {
				yield { ...event, kind: kinds.get(event.name) ?? event.kind };
				continue;
			}
			yield event;
		}
		yield { type: 'finish', reason: token.isCancellationRequested ? 'abort' as const : finish ?? 'stop' };
	}

	private async executeToolCalls(
		session: ISessionState,
		runId: string,
		profile: IProviderProfile,
		intent: IIntent,
		calls: readonly IToolCall[],
		token: CancellationToken,
	): Promise<readonly IToolResult[]> {
		const tools = this.visibleSessionTools(session, intent);
		const registry = new Map(tools.map(tool => [tool.name, tool]));
		return runToolBatch(registry, calls, {
			cwd: this.workspace.getWorkspace().folders[0]?.uri.fsPath,
			signal: abortSignalFrom(token),
			emit: event => {
				const forwarded = asToolEvent(event);
				if (forwarded) {
					this.emit(session, runId, forwarded);
				}
			},
		}, {
			authorize: (call, tool) => this.authorizeTool(session, runId, profile, call, tool),
			cache: session.harness?.cache,
			dryRun: session.prepared?.strategy.policy.dryRun,
			maxParallel: session.harness?.governor.snapshot().remaining.parallel ?? session.prepared?.strategy.policy.parallelism ?? 4,
			fileTracker: session.harness?.files,
		});
	}

	private async authorizeTool(
		session: ISessionState,
		runId: string,
		profile: IProviderProfile,
		call: IToolCall,
		tool: IVoltTool,
	): Promise<{ allow: boolean; reason?: string }> {
		if (tool.group === 'meta') {
			return { allow: true };
		}
		const action = actionForGroup(tool.group);
		const resource = resourceForCall(tool, call.args);
		const decision = await this.evaluateAccessRequest({
			id: generateUuid(),
			sessionId: session.sessionId,
			runId,
			providerId: profile.providerId,
			action,
			resource,
			risk: classifyRisk(action, resource.value),
			preview: { title: tool.name, detail: stringifyUnknown(call.args).slice(0, 400) },
			createdAt: Date.now(),
		});
		return decision.effect === 'allow'
			? { allow: true }
			: { allow: false, reason: `Blocked by Volt access policy (${decision.policySource ?? 'policy'}).` };
	}

	private async executeAgent(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem, intent: IIntent): Promise<void> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown agent provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		const startAgent = async () => {
			if (session.agentHandle && session.agentProviderId) {
				await this.agentProviders.get(session.agentProviderId)?.dispose(session.agentHandle).catch(() => undefined);
			}
			session.agentHandle = await provider.start({
				mode: request.mode,
				profile,
				cwd: this.workspace.getWorkspace().folders[0]?.uri.fsPath,
				modelId: item.id === profile.providerId ? undefined : item.id,
				options: this.resolvedOptions(item, request.options),
			});
			session.agentProviderId = provider.id;
			await provider.applyAccessPolicy?.(session.agentHandle, this.compiledPolicy);
		};
		const hasLiveAgent = () => !!session.agentHandle && session.agentProviderId === provider.id && (provider.isLive?.(session.agentHandle) ?? true);

		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					if (!hasLiveAgent()) {
						await startAgent();
					}
					provider.setRunContext?.(session.agentHandle!, { sessionId: session.sessionId, runId, mode: request.mode });
					const lead = buildAcpLead(await this.contextPackInput(session, request.mode, intent));
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
	}

	private emitOutcome(session: ISessionState, runId: string, harness: IRunHarness, assistant: string, loopOutcome: string): void {
		const finish = parseFinishPayload(assistant) ?? finishFromEvidence(harness);
		const outcome = synthesize({
			intel: harness.prepared.intel,
			store: harness.controller.evidence,
			gates: harness.controller.gates,
			completion: harness.controller.completion,
			work: workFromHarness(harness),
			durationMs: Date.now() - (session.activeRun?.startedAt ?? Date.now()),
			...(harness.controller.plan ? { plan: harness.controller.plan } : {}),
			assistantSummary: finish?.summary ?? assistant,
			...(finish?.remaining ? { modelRemaining: finish.remaining } : {}),
			cancelled: loopOutcome === 'abort',
			failed: loopOutcome === 'fail',
		});
		this.emit(session, runId, { type: 'outcome', headline: outcome.headline, markdown: renderOutcome(outcome), status: outcome.status });
		const spend = harness.governor.snapshot();
		const progress = harness.controller.lastProgress;
		const sample = {
			lane: harness.prepared.intent.lane,
			strategy: harness.prepared.strategy.strategy,
			outcome: (loopOutcome === 'abort' ? 'abort' : loopOutcome === 'fail' ? 'fail' : loopOutcome === 'budget' ? 'budget' : 'done') as 'done' | 'abort' | 'fail' | 'budget',
			complete: harness.controller.completion.complete,
			steps: spend.spent.steps,
			tools: spend.spent.tools,
			toolErrors: harness.controller.evidence.all().filter(item => !item.ok).length,
			tokens: spend.spent.tokens,
			durationMs: Date.now() - (session.activeRun?.startedAt ?? Date.now()),
			recoveries: harness.obs.metrics().recoveries,
			doom: progress?.doomLoop ?? false,
			regression: progress?.regression ?? false,
			stuck: progress?.stuck ?? false,
			confidence: progress?.score ?? (harness.controller.completion.complete ? 0.8 : 0.3),
		};
		const report = this.evalLedger.record(sample);
		harness.evals.record(sample);
		this.emit(session, runId, {
			type: 'eval',
			score: report.score,
			successRate: report.meters.successRate,
			steps: report.meters.stepsPerTask,
			tokens: report.meters.tokensPerTask,
			hints: [...report.hints, ...this.evalLedger.hints()].map(hint => hint.message),
		});
	}

	private async applyFileRestore(restored: readonly IFileSnapshot[]): Promise<{ applied: number }> {
		return applyRestored(restored, {
			write: async (path, content) => {
				await this.fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
			},
			remove: async path => {
				const uri = URI.file(path);
				if (await this.fileService.exists(uri)) {
					await this.fileService.del(uri);
				}
			},
		});
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

	private taskModelRoles(): IRoleAssignments {
		return {
			...(this.taskModels.agent ? { coding: this.taskModels.agent } : {}),
			...(this.taskModels.plan ? { reasoning: this.taskModels.plan } : {}),
			...(this.taskModels.ask ? { fast: this.taskModels.ask } : {}),
		};
	}

	private harnessCapabilities(session: ISessionState, currentRef: string) {
		const prepared = session.prepared;
		if (!prepared) {
			return { canEscalate: false, canDelegate: false, canRollback: false, canReset: false };
		}
		const request = { lane: prepared.intent.lane, mode: session.mode, intel: prepared.intel };
		return {
			canEscalate: canEscalate(currentRef, this.routableCatalog(), request),
			canDelegate: prepared.orchestration.concurrency > 1,
			canRollback: session.harness?.state.canRollback() ?? false,
			canReset: laneDefinition(prepared.intent.lane).compaction,
			canIsolate: prepared.strategy.policy.isolateWorkers || prepared.orchestration.concurrency > 1,
		};
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
			this.agentProviders.set(provider.id, provider);
		}
		const generic = new AcpAgentProvider('acp-generic', 'Agent', 'agent', ['acp'], this.stdio, this.workspace, this.fileService, this.logService, this.hostTools);
		generic.setAccessGate(this.accessGate);
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
		const cached = this.readJson<IVoltCatalogItem[]>(VOLT_CATALOG_STORAGE_KEY, []);
		this.catalog = Array.isArray(cached) ? cached : [];
		this.activeCatalogRef = this.storageService.get(VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, StorageScope.APPLICATION) || undefined;
		this.hydrateAgentModelsFromCatalog();
	}

	private persistCatalog(): void {
		this.storageService.store(VOLT_CATALOG_STORAGE_KEY, JSON.stringify(this.catalog), StorageScope.APPLICATION, StorageTarget.MACHINE);
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
			if (models.some(model => model.description || model.contextLabel)) {
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

	private evaluateAccessRequest(request: IAccessRequest): IAccessDecision | Promise<IAccessDecision> {
		const session = this.sessions.get(request.sessionId);
		const mode = session?.mode ?? (request.sessionId === TAB_PREDICTION_SESSION_ID ? 'ask' : 'agent');
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

function finishFromEvidence(harness: IRunHarness): { summary?: string; remaining?: string[] } | undefined {
	const item = [...harness.controller.evidence.all()].reverse().find(entry => entry.tool === 'finish');
	return item ? parseFinishPayload(item.detail) : undefined;
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

function asToolEvent(event: { type: string;[key: string]: unknown }): IVoltEvent | undefined {
	if (event.type === 'plan' || event.type === 'file.change' || event.type === 'error') {
		return event as IVoltEvent;
	}
	return undefined;
}

registerSingleton(IAgentRuntimeService, AgentRuntimeService, InstantiationType.Delayed);
registerSingleton(IVoltStdioService, NullVoltStdioService, InstantiationType.Delayed);
