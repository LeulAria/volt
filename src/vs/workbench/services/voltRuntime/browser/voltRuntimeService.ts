/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { evaluateAccess, memoKey } from '../common/access/accessBroker.js';
import { DEFAULT_ACCESS_MODE, normalizeVoltAccessMode, VOLT_ACCESS_MODE_STORAGE_KEY, VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY, VOLT_ACCESS_SAVED_RULES_STORAGE_KEY, VoltAccessMode } from '../common/access/accessModes.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../common/access/accessPresets.js';
import { AccessDecisionScope, IAccessDecision, IAccessGate, IAccessRequest, ICompiledPolicy, IExecutionReceipt, IPermissionRule, PermissionEffect } from '../common/access/accessTypes.js';
import { compilePolicy } from '../common/access/policyCompiler.js';
import { accessBridgeFor } from './agents/bridges/accessBridges.js';
import { DEFAULT_ACP_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from '../common/capabilities.js';
import { IVoltEvent, IVoltEventEnvelope } from '../common/events.js';
import { IVoltModelOptions, resolveModelOptions, VOLT_MODEL_OPTIONS_STORAGE_KEY } from '../common/modelOptions.js';
import { modePolicy, VoltMode } from '../common/modes.js';
import { displayProviderLabel, IProviderProfile, IProviderProfileDraft, secretKeyForProfile, VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY, VOLT_CATALOG_STORAGE_KEY, VOLT_DEFAULT_HEALTH_INTERVAL, VOLT_ENABLED_MODELS_STORAGE_KEY, VOLT_HEALTH_INTERVAL_STORAGE_KEY, VOLT_MODE_PROFILES_STORAGE_KEY, VOLT_PROFILES_STORAGE_KEY, VOLT_SEED_VERSION_STORAGE_KEY, VOLT_TASK_MODELS_STORAGE_KEY } from '../common/profiles.js';
import { IAgentDetectResult, IAgentProvider, IAgentSessionHandle, IDetectResult, IModelInfo, IModelMessage, IModelProvider, IVoltCatalogItem, IVoltProviderStatus, VoltProviderState } from '../common/providers.js';
import { resolveTabModel } from '../common/modelAccess.js';
import { IAgentRuntimeService, IVoltTaskModels } from '../common/runtime.js';
import { IVoltRunSnapshot, IVoltSendRequest, IVoltSession } from '../common/session.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { AcpAgentProvider } from './agents/acpProvider.js';
import { CLI_AGENT_DEFINITIONS, cliAgentDefinition, detectCliAgent } from './cliAgents.js';
import { NullVoltStdioService } from './nullStdioService.js';
import { compilePrompt } from './promptCompiler.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import { createCompatProvider, createLMStudioProvider, createOpenAIProvider, createOpenRouterProvider } from './providers/openaiCompat.js';

const RECEIPT_LIMIT = 500;
/** Access-broker session id for Tab completions that ride an ACP agent. */
const TAB_PREDICTION_SESSION_ID = 'volt-tab-prediction';

/** Bumped whenever the built-in profile list changes so existing installs pick it up. */
const CLI_SEED_VERSION = 2;

interface ISessionState extends IVoltSession {
	seq: number;
	agentHandle?: IAgentSessionHandle;
	agentProviderId?: string;
	cancel?: CancellationTokenSource;
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

	async send(sessionId: string, request: IVoltSendRequest): Promise<string> {
		const session = this.getOrCreateSession(sessionId) as ISessionState;
		session.mode = request.mode;
		session.providerRef = request.providerRef ?? session.providerRef ?? this.defaultRef(request.mode);
		session.messages.push({ role: 'user', content: request.text });

		const runId = generateUuid();
		const run: IVoltRunSnapshot = {
			runId,
			sessionId,
			status: 'running',
			startedAt: Date.now(),
			providerRef: session.providerRef,
		};
		session.activeRun = run;
		session.cancel?.dispose(true);
		session.cancel = new CancellationTokenSource();

		this.emit(session, runId, { type: 'run.start', runId, mode: request.mode });
		void this.execute(session, runId, request).catch(err => {
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

	private async execute(session: ISessionState, runId: string, request: IVoltSendRequest): Promise<void> {
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
			await this.executeAgent(session, runId, request, profile, item);
			return;
		}
		await this.executeModel(session, runId, request, profile, item);
	}

	private async executeModel(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem): Promise<void> {
		const provider = this.modelProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown model provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		const apiKey = profile.hasSecret ? await this.secretStorage.get(secretKeyForProfile(profile.id)) : undefined;
		const messages = compilePrompt(request.mode, session.messages.slice(0, -1), request.text);
		let assistant = '';
		try {
			for await (const event of provider.stream({
				modelId: item.id,
				messages,
				profile,
				apiKey,
				options: this.resolvedOptions(item, request.options),
			}, session.cancel!.token)) {
				if (event.type === 'text.delta' && event.delta) {
					assistant += event.delta;
				}
				this.emit(session, runId, event);
			}
			if (assistant) {
				session.messages.push({ role: 'assistant', content: assistant });
			}
			this.finish(session, runId, session.cancel?.token.isCancellationRequested ? 'abort' : 'done');
		} catch (err) {
			this.emit(session, runId, { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
			this.finish(session, runId, session.cancel?.token.isCancellationRequested ? 'abort' : 'fail');
		}
	}

	private async executeAgent(session: ISessionState, runId: string, request: IVoltSendRequest, profile: IProviderProfile, item: IVoltCatalogItem): Promise<void> {
		const provider = this.agentProviders.get(profile.providerId);
		if (!provider) {
			this.emit(session, runId, { type: 'error', message: `Unknown agent provider ${profile.providerId}` });
			this.finish(session, runId, 'fail');
			return;
		}
		try {
			if (!session.agentHandle || session.agentProviderId !== provider.id) {
				if (session.agentHandle && session.agentProviderId) {
					await this.agentProviders.get(session.agentProviderId)?.dispose(session.agentHandle);
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
			}
			provider.setRunContext?.(session.agentHandle, { sessionId: session.sessionId, runId, mode: request.mode });
			let assistant = '';
			for await (const event of provider.send(session.agentHandle, { text: request.text, mode: request.mode }, profile, session.cancel!.token)) {
				if (event.type === 'text.delta' && event.delta) {
					assistant += event.delta;
				}
				if (event.type === 'run.end') {
					if (assistant) {
						session.messages.push({ role: 'assistant', content: assistant });
					}
					this.finish(session, runId, event.reason);
					return;
				}
				this.emit(session, runId, event);
			}
			if (assistant) {
				session.messages.push({ role: 'assistant', content: assistant });
			}
			this.finish(session, runId, 'done');
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
		this.emit(session, runId, { type: 'run.end', runId, reason });
	}

	private emit(session: ISessionState, runId: string, event: IVoltEvent): void {
		const envelope: IVoltEventEnvelope = {
			seq: ++session.seq,
			runId,
			sessionId: session.sessionId,
			timestamp: Date.now(),
			event,
		};
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
			const provider = new AcpAgentProvider(def.id, def.label, def.commands[0], [...def.acpArgs], this.stdio, this.workspace, this.fileService, this.logService);
			provider.setAccessGate(this.accessGate);
			this.agentProviders.set(provider.id, provider);
		}
		const generic = new AcpAgentProvider('acp-generic', 'Agent', 'agent', ['acp'], this.stdio, this.workspace, this.fileService, this.logService);
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

	private denyPending(sessionId: string): void {
		for (const [id, pending] of this.pendingApprovals) {
			if (pending.request.sessionId !== sessionId) {
				continue;
			}
			this.pendingApprovals.delete(id);
			pending.resolve({ requestId: id, effect: 'deny', scope: 'once', policySource: 'cancelled' });
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

registerSingleton(IAgentRuntimeService, AgentRuntimeService, InstantiationType.Delayed);
registerSingleton(IVoltStdioService, NullVoltStdioService, InstantiationType.Delayed);
