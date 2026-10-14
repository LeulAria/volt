/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { DEFAULT_ACCESS_MODE, VoltAccessMode } from '../../voltRuntime/common/access/accessModes.js';
import { AccessDecisionScope, IAccessRequest, IExecutionReceipt, IPermissionRule, PermissionEffect } from '../../voltRuntime/common/access/accessTypes.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../voltRuntime/common/events.js';
import type { IHumanAction } from '../../voltRuntime/common/harness/humanLoop.js';
import type { IRunMetrics } from '../../voltRuntime/common/harness/runMetrics.js';
import { IVoltModelOptions } from '../../voltRuntime/common/models/modelOptions.js';
import { VoltMode } from '../../voltRuntime/common/modes.js';
import { IProviderProfile, IProviderProfileDraft } from '../../voltRuntime/common/profiles.js';
import { IAgentDetectResult, IModelMessage, IVoltCatalogItem, IVoltProviderStatus } from '../../voltRuntime/common/providers.js';
import type { IAgentQuestionRequest, IAgentQuestionResponse } from '../../voltRuntime/common/questions.js';
import { IAgentRuntimeService, IVoltMcpServerStatus, IVoltTaskModels } from '../../voltRuntime/common/runtime.js';
import { IVoltSendRequest, IVoltSession } from '../../voltRuntime/common/session.js';
import { IAgentServerClientService } from './agentServerClient.js';

/** What the server publishes per chat in the `sessions` collection. */
export interface IRemoteSessionSummary extends Omit<IVoltSession, 'messages'> {
	readonly userTurns: number;
	readonly canSteer: boolean;
	readonly commands: readonly string[];
	/** The chat a warm-pool alias stands for. */
	readonly chat?: string;
}

const CATALOG_KEYS = new Set(['catalog', 'catalogLoading']);
const PROFILE_KEYS = new Set(['profiles', 'taskModels', 'modeProfiles', 'enabledModels', 'modelOptions']);
const STATUS_KEYS = new Set(['providerStatuses', 'lastProviderCheck', 'healthInterval']);
const ACCESS_KEYS = new Set(['accessMode', 'projectRules', 'savedApprovals', 'receipts']);

/**
 * The agent runtime of the agent server, as this window sees it. Getters read the mirrored
 * `runtime`, `sessions`, `questions` and `access` collections; everything that acts is a call;
 * run events arrive on the `runtime.event` stream.
 */
export class RemoteAgentRuntimeService extends Disposable implements IAgentRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this._onDidChangeCatalog.event;
	private readonly _onDidChangeProfiles = this._register(new Emitter<void>());
	readonly onDidChangeProfiles = this._onDidChangeProfiles.event;
	private readonly _onDidChangeProviderStatus = this._register(new Emitter<void>());
	readonly onDidChangeProviderStatus = this._onDidChangeProviderStatus.event;
	private readonly _onDidChangeAccess = this._register(new Emitter<void>());
	readonly onDidChangeAccess = this._onDidChangeAccess.event;
	private readonly _onDidChangeQuestions = this._register(new Emitter<string>());
	readonly onDidChangeQuestions = this._onDidChangeQuestions.event;
	private readonly _onDidChangeActiveCatalog = this._register(new Emitter<void>());
	readonly onDidChangeActiveCatalog = this._onDidChangeActiveCatalog.event;
	private readonly _onDidEmit = this._register(new Emitter<IVoltEventEnvelope>());
	readonly onDidEmit: Event<IVoltEventEnvelope> = this._onDidEmit.event;

	private readonly listeners = new Map<string, Set<(e: IVoltEventEnvelope) => void>>();
	/** Session objects handed out, updated in place as the server's summaries change. */
	private readonly sessions = new Map<string, IVoltSession>();
	private readonly requested = new Set<string>();

	constructor(@IAgentServerClientService private readonly client: IAgentServerClientService) {
		super();
		this._register(client.onDidChangeCollection(e => this.onCollection(e.col, e.keys)));
		this._register(client.onRuntimeEvent(envelope => {
			this._onDidEmit.fire(envelope);
			for (const listener of [...this.listeners.get(envelope.sessionId) ?? []]) {
				listener(envelope);
			}
		}));
	}

	private onCollection(col: string, keys: readonly string[]): void {
		if (col === 'runtime') {
			const changed = new Set(keys);
			const any = (set: Set<string>) => keys.some(key => set.has(key));
			if (any(CATALOG_KEYS)) {
				this._onDidChangeCatalog.fire();
			}
			if (any(PROFILE_KEYS)) {
				this._onDidChangeProfiles.fire();
				this._onDidChangeCatalog.fire();
			}
			if (any(STATUS_KEYS)) {
				this._onDidChangeProviderStatus.fire();
			}
			if (any(ACCESS_KEYS)) {
				this._onDidChangeAccess.fire();
			}
			if (changed.has('activeCatalogRef') || changed.has('tabModelRef')) {
				this._onDidChangeActiveCatalog.fire();
			}
		} else if (col === 'sessions') {
			for (const key of keys) {
				this.refreshSession(key);
			}
		} else if (col === 'questions') {
			for (const key of keys) {
				this._onDidChangeQuestions.fire(key);
			}
		} else if (col === 'access') {
			this._onDidChangeAccess.fire();
		}
	}

	private value<T>(key: string): T | undefined {
		return this.client.mirror.get<T>('runtime', key);
	}

	//#region Sessions

	private summary(sessionId: string): IRemoteSessionSummary | undefined {
		return this.client.mirror.get<IRemoteSessionSummary>('sessions', sessionId);
	}

	getOrCreateSession(key: string): IVoltSession {
		let session = this.sessions.get(key);
		if (!session) {
			session = { sessionId: key, conversationId: key, mode: 'agent', messages: [] };
			this.sessions.set(key, session);
			this.refreshSession(key);
		}
		if (!this.summary(key) && !this.requested.has(key) && this.client.isReady) {
			this.requested.add(key);
			this.client.send('runtime.getOrCreateSession', key);
		}
		return session;
	}

	/** Keeps a handed-out session object in step with the server's summary (callers hold on to it). */
	private refreshSession(key: string): void {
		const session = this.sessions.get(key) as Record<string, unknown> | undefined;
		const summary = this.summary(key);
		if (!session || !summary) {
			return;
		}
		for (const field of ['conversationId', 'mode', 'providerRef', 'profileId', 'activeRun', 'lastLane', 'paused', 'worktreePath', 'worktreeBranch'] as const) {
			if (summary[field] === undefined) {
				delete session[field];
			} else {
				session[field] = summary[field];
			}
		}
	}

	seedSession(): void {
		// The server's own copy of the chat seeded its model transcript when it loaded the chat.
	}

	truncateSession(sessionId: string, userTurns: number): void {
		this.client.send('runtime.truncateSession', sessionId, userTurns);
	}

	prewarmAgent(sessionId: string, providerRef: string | undefined, mode: VoltMode): void {
		this.client.send('runtime.prewarmAgent', sessionId, providerRef, mode);
	}

	rememberWorktree(sessionId: string, path: string | undefined, branch: string | undefined): void {
		this.client.send('runtime.rememberWorktree', sessionId, path, branch);
	}

	send(sessionId: string, request: IVoltSendRequest): Promise<string> {
		return this.client.call('runtime.send', sessionId, request);
	}

	canSteer(sessionId: string): boolean {
		return !!this.summary(sessionId)?.canSteer;
	}

	supportsCommand(sessionId: string, name: string): boolean {
		return !!this.summary(sessionId)?.commands.includes(name);
	}

	steer(sessionId: string, text: string): boolean {
		if (!this.canSteer(sessionId)) {
			return false;
		}
		this.client.send('runtime.steerAsync', sessionId, text);
		return true;
	}

	steerAsync(sessionId: string, text: string): Promise<boolean> {
		return this.client.call('runtime.steerAsync', sessionId, text);
	}

	cancel(sessionId: string): Promise<void> {
		return this.client.call('runtime.cancel', sessionId);
	}

	pause(sessionId: string): Promise<void> {
		return this.client.call('runtime.pause', sessionId);
	}

	resume(sessionId: string): Promise<void> {
		return this.client.call('runtime.resume', sessionId);
	}

	forkSession(sessionId: string): Promise<string> {
		return this.client.call('runtime.forkSession', sessionId);
	}

	redirect(sessionId: string, text: string): Promise<string> {
		return this.client.call('runtime.redirect', sessionId, text);
	}

	applyHuman(sessionId: string, action: IHumanAction): Promise<void> {
		return this.client.call('runtime.applyHuman', sessionId, action);
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

	chatFor(sessionId: string): string {
		return this.summary(sessionId)?.chat ?? sessionId;
	}

	//#endregion

	//#region Catalog, profiles, providers

	listCatalog(): IVoltCatalogItem[] {
		return this.value<IVoltCatalogItem[]>('catalog') ?? [];
	}

	isCatalogLoading(): boolean {
		return this.client.isReady ? !!this.value<boolean>('catalogLoading') : true;
	}

	listProfiles(): IProviderProfile[] {
		return this.value<IProviderProfile[]>('profiles') ?? [];
	}

	upsertProfile(draft: IProviderProfileDraft, secret?: string): Promise<IProviderProfile> {
		return this.client.call('runtime.upsertProfile', draft, secret);
	}

	deleteProfile(id: string): Promise<void> {
		return this.client.call('runtime.deleteProfile', id);
	}

	setModelEnabled(ref: string, enabled: boolean): Promise<void> {
		return this.client.call('runtime.setModelEnabled', ref, enabled);
	}

	isModelEnabled(ref: string): boolean {
		return this.value<Record<string, boolean>>('enabledModels')?.[ref] ?? true;
	}

	getTaskModels(): IVoltTaskModels {
		return this.value<IVoltTaskModels>('taskModels') ?? {};
	}

	setTaskModel(slot: keyof IVoltTaskModels, ref: string | undefined): Promise<void> {
		return this.client.call('runtime.setTaskModel', slot, ref);
	}

	getModeProfile(mode: VoltMode): string | undefined {
		return this.value<Record<string, string | null>>('modeProfiles')?.[mode] ?? undefined;
	}

	setModeProfile(mode: VoltMode, profileId: string | undefined): Promise<void> {
		return this.client.call('runtime.setModeProfile', mode, profileId);
	}

	refreshCatalog(): Promise<void> {
		return this.client.call('runtime.refreshCatalog');
	}

	detectAgents(): Promise<IAgentDetectResult[]> {
		return this.client.call('runtime.detectAgents');
	}

	listProviderStatuses(): IVoltProviderStatus[] {
		return this.value<IVoltProviderStatus[]>('providerStatuses') ?? [];
	}

	refreshProviders(): Promise<void> {
		return this.client.call('runtime.refreshProviders');
	}

	setProfileEnabled(profileId: string, enabled: boolean): Promise<void> {
		return this.client.call('runtime.setProfileEnabled', profileId, enabled);
	}

	getLastProviderCheck(): number | undefined {
		return this.value<number>('lastProviderCheck');
	}

	getHealthCheckInterval(): number {
		return this.value<number>('healthInterval') ?? 0;
	}

	setHealthCheckInterval(seconds: number): Promise<void> {
		return this.client.call('runtime.setHealthCheckInterval', seconds);
	}

	getModelOptions(ref: string): IVoltModelOptions {
		return this.value<Record<string, IVoltModelOptions>>('modelOptions')?.[ref] ?? {};
	}

	setModelOptions(ref: string, options: IVoltModelOptions): Promise<void> {
		return this.client.call('runtime.setModelOptions', ref, options);
	}

	resolveCatalogItem(ref: string): IVoltCatalogItem | undefined {
		return this.listCatalog().find(item => item.ref === ref);
	}

	getActiveCatalogRef(): string | undefined {
		return this.value<string>('activeCatalogRef');
	}

	setActiveCatalogRef(ref: string | undefined): Promise<void> {
		return this.client.call('runtime.setActiveCatalogRef', ref);
	}

	resolveTabModelRef(): string | undefined {
		return this.value<string>('tabModelRef');
	}

	/** One completion, run by the server; its events are replayed here once it finishes. */
	async *streamModel(ref: string, messages: IModelMessage[], options: IVoltModelOptions | undefined, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const events = await this.client.call<IVoltEvent[]>('runtime.streamModel', ref, messages, options);
		for (const event of events) {
			if (token.isCancellationRequested) {
				return;
			}
			yield event;
		}
	}

	//#endregion

	//#region Access and questions

	getAccessMode(): VoltAccessMode {
		return this.value<VoltAccessMode>('accessMode') ?? DEFAULT_ACCESS_MODE;
	}

	setAccessMode(mode: VoltAccessMode): Promise<void> {
		return this.client.call('runtime.setAccessMode', mode);
	}

	respondToAccessRequest(requestId: string, effect: Extract<PermissionEffect, 'allow' | 'deny'>, scope?: AccessDecisionScope, pattern?: string): void {
		this.client.send('runtime.respondToAccessRequest', requestId, effect, scope, pattern);
	}

	getPendingQuestions(sessionId: string): readonly IAgentQuestionRequest[] {
		return this.client.mirror.get<IAgentQuestionRequest[]>('questions', sessionId) ?? [];
	}

	respondToQuestions(requestId: string, response: IAgentQuestionResponse): boolean {
		const known = this.client.mirror.values<IAgentQuestionRequest[]>('questions').some(list => list.some(request => request.id === requestId));
		if (known) {
			this.client.send('runtime.respondToQuestions', requestId, response);
		}
		return known;
	}

	listPendingAccessRequests(sessionId?: string): IAccessRequest[] {
		const pending = this.client.mirror.get<IAccessRequest[]>('access', 'pending') ?? [];
		return sessionId ? pending.filter(request => request.sessionId === sessionId) : pending;
	}

	listReceipts(sessionId?: string): IExecutionReceipt[] {
		const receipts = this.value<IExecutionReceipt[]>('receipts') ?? [];
		return sessionId ? receipts.filter(receipt => receipt.sessionId === sessionId) : receipts;
	}

	listProjectRules(): IPermissionRule[] {
		return this.value<IPermissionRule[]>('projectRules') ?? [];
	}

	setProjectRules(rules: IPermissionRule[]): Promise<void> {
		return this.client.call('runtime.setProjectRules', rules);
	}

	listSavedApprovals(): IPermissionRule[] {
		return this.value<IPermissionRule[]>('savedApprovals') ?? [];
	}

	revokeSavedApproval(index: number): Promise<void> {
		return this.client.call('runtime.revokeSavedApproval', index);
	}

	getRunMetrics(sessionId?: string): readonly IRunMetrics[] {
		const metrics = this.value<IRunMetrics[]>('runMetrics') ?? [];
		return sessionId ? metrics.filter(entry => entry.sessionId === sessionId) : metrics;
	}

	listMcpServers(root: URI | undefined): Promise<readonly IVoltMcpServerStatus[]> {
		return this.client.call('runtime.listMcpServers', root);
	}

	generateText(prompt: string, options?: { readonly sessionId?: string; readonly timeoutMs?: number }): Promise<string | undefined> {
		return this.client.call('runtime.generateText', prompt, options);
	}

	//#endregion
}
