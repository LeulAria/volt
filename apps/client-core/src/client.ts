/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IConnectionStatus, type IWebSocketLike, type IWelcomeEvent, VoltConnection } from './connection';
import { chooseRoute, type ISavedEnvironment, wsUrl } from './environments';
import { KeyedNotifier, type Unsubscribe } from './events';
import { fileUri } from './format';
import { newChatId, uuid } from './ids';
import {
	CLIENT_TOPICS, errorMessage, type ICollectionDelta, type IEnvironmentDescriptor, type IEvent, type IPairedDevice, type IPairingCode, type ISessionPatch, type ISessionState, RemoteError, type SessionTopicData
} from './protocol';
import type { IPendingSend, PendingState } from './rows';
import type { Collections } from './selectors';
import { threadsOf } from './selectors';
import type { AccessMode, AgentMessage, ComposerMode, IOrchPrompt, IProjectRecord, IQuestionResponse } from './types';

/** Async key-value storage (localStorage on the web, AsyncStorage on phones). */
export interface IStorage {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
}

export interface IClientOptions {
	readonly environment: ISavedEnvironment;
	readonly clientKind: 'web' | 'mobile';
	/** Stable per install. */
	readonly clientId: string;
	readonly storage?: IStorage;
	readonly createSocket?: (url: string) => IWebSocketLike;
	/** Where to connect; default: the best saved route that answers as this environment. */
	readonly resolveBaseUrl?: () => Promise<string>;
	readonly log?: (message: string) => void;
}

export type TranscriptStatus = 'loading' | 'live' | 'cached' | 'error';

export interface ITranscript {
	readonly id: string;
	readonly messages: readonly AgentMessage[];
	readonly rev: number;
	readonly contextUsed?: number;
	readonly contextWindow?: number;
	readonly status: TranscriptStatus;
	readonly error?: string;
}

export interface IToast {
	readonly id: number;
	readonly kind: 'info' | 'success' | 'error';
	readonly message: string;
}

export type Delivery = 'auto' | 'queue' | 'now';

export interface ISendRequest {
	readonly threadId: string;
	readonly text: string;
	readonly mode?: ComposerMode;
	readonly modelRef?: string;
	readonly options?: Record<string, string | boolean>;
	readonly delivery?: Delivery;
}

export interface INewChatRequest extends Omit<ISendRequest, 'threadId' | 'delivery'> {
	readonly projectId: string;
	readonly accessMode?: AccessMode;
}

interface IOutboxItem {
	readonly threadId: string;
	readonly turnId: string;
	readonly prompt: IOrchPrompt;
	readonly delivery: Delivery;
	readonly createdAt: number;
	readonly projectId?: string;
	readonly accessMode?: AccessMode;
	/** `inflight`: sent on a socket that dropped before the answer; checked against the server's state. */
	state: 'unsent' | 'inflight';
}

/** What the state as of the last connection (or the cache) says about the client. */
export interface IClientStatus {
	readonly connection: IConnectionStatus;
	/** Welcomed on the current socket: what is shown is current. */
	readonly live: boolean;
	/** There is state to show (live, or loaded from the cache). */
	readonly ready: boolean;
	readonly baseUrl?: string;
}

const CACHED_COLLECTIONS = ['history', 'projects', 'orch.threads', 'runtime', 'sessions'];
const RUNTIME_CACHE_FIELDS = ['catalog', 'providerStatuses', 'modelOptions', 'enabledModels', 'accessMode', 'activeCatalogRef', 'modeProfiles', 'autoResumeDefault'];
const TRANSCRIPT_CACHE_LIMIT = 16;
const TRANSCRIPT_CACHE_MESSAGES = 160;
const RELEASE_GRACE_MS = 20_000;
const PENDING_EXPIRY_MS = 3 * 60_000;

/**
 * Everything a Volt client shows and does, over one connection to one environment. Views read
 * immutable snapshots through `get*` and subscribe to the keys they read:
 * - `status`: connection and readiness
 * - `col:<name>`: one mirrored collection (`history`, `orch.threads`, `runtime`, ...)
 * - `transcript:<chatId>`: an open chat's messages
 * - `pending:<chatId>`: prompts sent from here that the transcript doesn't show yet
 * - `toasts`
 */
export class VoltClient {

	readonly environment: ISavedEnvironment;
	readonly connection: VoltConnection;
	private readonly notifier = new KeyedNotifier();
	private cols: Collections = {};
	private live = false;
	private ready = false;
	private baseUrl: string | undefined;
	private status: IClientStatus;

	private readonly transcripts = new Map<string, ITranscript>();
	private readonly holds = new Map<string, number>();
	private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly opening = new Map<string, ISessionPatch[]>();
	private readonly pending = new Map<string, readonly IPendingSend[]>();
	private outbox: IOutboxItem[] = [];
	private readonly flushing = new Set<string>();
	private toasts: readonly IToast[] = [];
	private nextToastId = 1;

	private readonly dirtyKeys = new Set<string>();
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private cacheTimer: ReturnType<typeof setTimeout> | undefined;
	private lastCacheAt = 0;
	private disposed = false;
	private readonly unsubscribers: Unsubscribe[] = [];

	constructor(private readonly options: IClientOptions) {
		this.environment = options.environment;
		this.connection = new VoltConnection({
			resolveUrl: async () => {
				const base = options.resolveBaseUrl ? await options.resolveBaseUrl() : (await chooseRoute(this.environment)).baseUrl;
				this.baseUrl = base;
				return wsUrl(base);
			},
			token: options.environment.token,
			client: { kind: options.clientKind, id: options.clientId, topics: CLIENT_TOPICS },
			...(options.createSocket ? { createSocket: options.createSocket } : {}),
			...(options.log ? { log: options.log } : {}),
		});
		this.status = { connection: this.connection.status, live: false, ready: false };
		this.unsubscribers.push(
			this.connection.onStatus(status => this.onConnectionStatus(status)),
			this.connection.onWelcome(event => this.onWelcome(event)),
			this.connection.onEvent(event => this.onEvent(event)),
		);
	}

	//#region Lifecycle

	async start(): Promise<void> {
		await this.loadCache();
		if (!this.disposed) {
			this.connection.start();
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		void this.persistNow();
		this.unsubscribers.forEach(unsubscribe => unsubscribe());
		for (const timer of this.releaseTimers.values()) {
			clearTimeout(timer);
		}
		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
		}
		if (this.cacheTimer) {
			clearTimeout(this.cacheTimer);
		}
		this.connection.stop();
	}

	/** The app returned to the foreground: check the link instead of trusting it. */
	resume(): void {
		this.connection.probe();
	}

	/** The app went to the background: write the cache while there is time. */
	suspend(): void {
		void this.persistNow();
	}

	setNetworkAvailable(available: boolean): void {
		this.connection.setNetworkAvailable(available);
	}

	reconnect(): void {
		this.connection.retryNow();
	}

	//#endregion

	//#region Subscriptions and snapshots

	subscribe(key: string, listener: () => void): Unsubscribe {
		return this.notifier.subscribe(key, listener);
	}

	getStatus(): IClientStatus {
		return this.status;
	}

	getCollections(): Collections {
		return this.cols;
	}

	getCollection(name: string): Readonly<Record<string, unknown>> | undefined {
		return this.cols[name];
	}

	getTranscript(chatId: string): ITranscript | undefined {
		return this.transcripts.get(chatId);
	}

	getPending(chatId: string): readonly IPendingSend[] {
		return this.pending.get(chatId) ?? EMPTY_PENDING;
	}

	getToasts(): readonly IToast[] {
		return this.toasts;
	}

	private notifySoon(key: string): void {
		this.dirtyKeys.add(key);
		// One frame: a burst of patches and deltas renders once.
		this.notifyTimer ??= setTimeout(() => {
			this.notifyTimer = undefined;
			const keys = [...this.dirtyKeys];
			this.dirtyKeys.clear();
			this.notifier.batch(() => keys.forEach(k => this.notifier.notify(k)));
		}, 16);
	}

	private setStatus(patch: Partial<IClientStatus>): void {
		this.status = { ...this.status, ...patch, ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}) };
		this.notifier.notify('status');
	}

	//#endregion

	//#region Connection

	private onConnectionStatus(connection: IConnectionStatus): void {
		const live = connection.phase === 'open' && this.live;
		if (connection.phase !== 'open') {
			this.live = false;
			for (const [id, transcript] of this.transcripts) {
				if (transcript.status === 'live') {
					this.transcripts.set(id, { ...transcript, status: 'cached' });
					this.notifySoon(`transcript:${id}`);
				}
			}
		}
		this.setStatus({ connection, live });
	}

	private onWelcome({ welcome, newEpoch }: IWelcomeEvent): void {
		if (welcome.snapshot) {
			const names = new Set([...Object.keys(this.cols), ...Object.keys(welcome.snapshot.collections)]);
			this.cols = { ...welcome.snapshot.collections };
			names.forEach(name => this.notifySoon(`col:${name}`));
		}
		this.live = true;
		this.ready = true;
		this.setStatus({ connection: this.connection.status, live: true, ready: true });
		// Chats on screen: their transcripts are taken again (the server may have restarted, or let them go).
		for (const [id, count] of this.holds) {
			if (count > 0) {
				void this.openTranscript(id, newEpoch);
			}
		}
		// After a resume the missed events follow the welcome: let them land before deciding what was delivered.
		setTimeout(() => this.drainOutbox(), welcome.resumed ? 400 : 0);
		this.scheduleCache();
	}

	private onEvent(event: IEvent): void {
		switch (event.topic) {
			case 'col':
				this.applyDelta(event.data as ICollectionDelta);
				return;
			case 'session':
				this.onSessionData(event.data as SessionTopicData);
				return;
			case 'server': {
				const notice = event.data as { kind?: string; severity?: number; message?: string };
				if (notice.kind === 'notification' && notice.message) {
					// Severity: 1 info, 2 warning, 3 error (VS Code's Severity).
					this.toast(notice.severity === 3 ? 'error' : 'info', notice.message);
				}
				return;
			}
		}
	}

	private applyDelta(delta: ICollectionDelta): void {
		if (!delta || typeof delta.col !== 'string') {
			return;
		}
		const next: Record<string, unknown> = { ...(this.cols[delta.col] ?? {}) };
		for (const key of delta.del ?? []) {
			delete next[key];
		}
		Object.assign(next, delta.put ?? {});
		this.cols = { ...this.cols, [delta.col]: next };
		this.notifySoon(`col:${delta.col}`);
		if (delta.col === 'orch.threads') {
			this.settlePendingFromThreads();
		}
		this.scheduleCache();
	}

	//#endregion

	//#region Transcripts

	/** Keeps a chat's transcript open (and live) while the returned function isn't called. */
	retainTranscript(chatId: string): () => void {
		this.holds.set(chatId, (this.holds.get(chatId) ?? 0) + 1);
		const timer = this.releaseTimers.get(chatId);
		if (timer) {
			clearTimeout(timer);
			this.releaseTimers.delete(chatId);
		}
		const current = this.transcripts.get(chatId);
		if (!current) {
			this.transcripts.set(chatId, { id: chatId, messages: [], rev: -1, status: 'loading' });
			void this.loadCachedTranscript(chatId);
		}
		if (this.live && (!current || current.status !== 'live') && !this.opening.has(chatId)) {
			void this.openTranscript(chatId, false);
		}
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const count = (this.holds.get(chatId) ?? 1) - 1;
			this.holds.set(chatId, count);
			if (count <= 0) {
				this.releaseTimers.set(chatId, setTimeout(() => this.releaseTranscript(chatId), RELEASE_GRACE_MS));
			}
		};
	}

	private releaseTranscript(chatId: string): void {
		this.releaseTimers.delete(chatId);
		if ((this.holds.get(chatId) ?? 0) > 0) {
			return;
		}
		this.holds.delete(chatId);
		const transcript = this.transcripts.get(chatId);
		if (transcript) {
			void this.cacheTranscript(transcript);
			this.transcripts.set(chatId, { ...transcript, status: 'cached' });
		}
		if (this.live) {
			this.connection.call('session.close', [chatId], { requireOpen: true }).catch(() => undefined);
		}
	}

	private async openTranscript(chatId: string, reset: boolean): Promise<void> {
		if (this.opening.has(chatId)) {
			return;
		}
		this.opening.set(chatId, []);
		const before = this.transcripts.get(chatId);
		if (before && (reset || before.status !== 'live')) {
			this.transcripts.set(chatId, { ...before, rev: -1, status: before.messages.length ? before.status === 'live' ? 'cached' : before.status : 'loading' });
			this.notifySoon(`transcript:${chatId}`);
		}
		try {
			const state = await this.connection.call<ISessionState>('session.open', [chatId], { timeoutMs: 30_000 });
			let messages = [...(state.messages as AgentMessage[])];
			let rev = state.rev;
			let contextUsed = state.contextUsed;
			let contextWindow = state.contextWindow;
			for (const patch of (this.opening.get(chatId) ?? []).filter(p => p.rev > state.rev).sort((a, b) => a.rev - b.rev)) {
				const applied = applyPatch(messages, rev, patch);
				if (!applied) {
					break;
				}
				messages = applied;
				rev = patch.rev;
				contextUsed = patch.contextUsed ?? contextUsed;
				contextWindow = patch.contextWindow ?? contextWindow;
			}
			this.transcripts.set(chatId, {
				id: chatId,
				messages: reconcileMessages(this.transcripts.get(chatId)?.messages ?? [], messages),
				rev,
				...(contextUsed !== undefined ? { contextUsed } : {}),
				...(contextWindow !== undefined ? { contextWindow } : {}),
				status: 'live',
			});
			this.settlePendingFromTranscript(chatId);
		} catch (err) {
			const current = this.transcripts.get(chatId);
			if (current && !(err instanceof RemoteError && (err.code === 'Disconnected' || err.code === 'Stopped'))) {
				this.transcripts.set(chatId, { ...current, status: current.messages.length ? 'cached' : 'error', error: errorMessage(err) });
			}
		} finally {
			this.opening.delete(chatId);
			this.notifySoon(`transcript:${chatId}`);
		}
	}

	private onSessionData(data: SessionTopicData): void {
		if (!data || typeof data.id !== 'string' || data.type !== 'patch') {
			return;
		}
		const early = this.opening.get(data.id);
		if (early) {
			early.push(data);
			return;
		}
		const transcript = this.transcripts.get(data.id);
		if (!transcript || transcript.status !== 'live' || data.rev <= transcript.rev) {
			return;
		}
		const messages = applyPatch(transcript.messages, transcript.rev, data);
		if (!messages) {
			void this.openTranscript(data.id, true);
			return;
		}
		this.transcripts.set(data.id, {
			...transcript,
			messages,
			rev: data.rev,
			...(data.contextUsed !== undefined ? { contextUsed: data.contextUsed } : {}),
			...(data.contextWindow !== undefined ? { contextWindow: data.contextWindow } : {}),
		});
		this.notifySoon(`transcript:${data.id}`);
		this.settlePendingFromTranscript(data.id);
	}

	//#endregion

	//#region Sending

	/** Sends a prompt. It shows at once as a pending bubble and survives going offline (outbox). */
	send(request: ISendRequest): string {
		const turnId = uuid();
		this.enqueue({
			threadId: request.threadId,
			turnId,
			prompt: promptOf(request),
			delivery: request.delivery ?? 'auto',
			createdAt: Date.now(),
			state: 'unsent',
		}, request.text);
		return turnId;
	}

	/** Starts a chat in a project with its first prompt; resolves its id at once. */
	startChat(request: INewChatRequest): string {
		const threadId = newChatId();
		this.enqueue({
			threadId,
			turnId: uuid(),
			prompt: promptOf(request),
			delivery: 'auto',
			createdAt: Date.now(),
			projectId: request.projectId,
			...(request.accessMode ? { accessMode: request.accessMode } : {}),
			state: 'unsent',
		}, request.text);
		return threadId;
	}

	/** Sends a failed prompt again. */
	retrySend(chatId: string, turnId: string): void {
		const failed = this.getPending(chatId).find(p => p.turnId === turnId);
		if (!failed) {
			return;
		}
		this.removePending(chatId, turnId);
		this.send({ threadId: chatId, text: failed.text });
	}

	dismissPending(chatId: string, turnId: string): void {
		this.removePending(chatId, turnId);
		this.outbox = this.outbox.filter(item => item.turnId !== turnId);
		void this.persistOutbox();
	}

	private enqueue(item: IOutboxItem, text: string): void {
		this.setPending(item.threadId, { turnId: item.turnId, text, state: 'sending', at: item.createdAt });
		this.outbox.push(item);
		void this.persistOutbox();
		void this.flush(item);
	}

	private async flush(item: IOutboxItem): Promise<void> {
		if (!this.live || this.flushing.has(item.turnId)) {
			return;
		}
		this.flushing.add(item.turnId);
		item.state = 'inflight';
		void this.persistOutbox();
		try {
			if (item.projectId) {
				await this.connection.call('projects.bindSession', [item.threadId, item.projectId], { requireOpen: true });
			}
			if (item.accessMode) {
				await this.connection.call('runtime.setAccessMode', [item.accessMode, item.threadId], { requireOpen: true }).catch(() => undefined);
			}
			const result = await this.connection.call<{ outcome: string; reason?: string }>('orchestrator.submit', [item.threadId, item.prompt, item.delivery, item.turnId], { requireOpen: true });
			this.removeFromOutbox(item.turnId);
			if (result.outcome === 'rejected') {
				this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'failed', at: item.createdAt, error: result.reason ?? 'Volt did not take the prompt.' });
				this.toast('error', result.reason ? `Not sent: ${result.reason}` : 'Volt did not take the prompt.');
			} else if (result.outcome === 'queued' || result.outcome === 'steered') {
				// Queued prompts show in the queue tray; steers land inside the running reply.
				this.removePending(item.threadId, item.turnId);
			}
		} catch (err) {
			const code = err instanceof RemoteError ? err.code : '';
			if (code === 'Disconnected' || code === 'Timeout') {
				// It may have run: checked against the chat's state when the connection is back.
				item.state = 'inflight';
			} else if (code === 'Offline' || code === 'Stopped') {
				item.state = 'unsent';
			} else {
				this.removeFromOutbox(item.turnId);
				this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'failed', at: item.createdAt, error: errorMessage(err) });
				this.toast('error', `Couldn't send: ${errorMessage(err)}`);
			}
			void this.persistOutbox();
		} finally {
			this.flushing.delete(item.turnId);
		}
	}

	private drainOutbox(): void {
		const threads = threadsOf(this.cols);
		for (const item of [...this.outbox]) {
			if (item.state === 'inflight') {
				const thread = threads[item.threadId];
				const delivered = thread && (thread.active?.id === item.turnId || thread.queue.some(q => q.id === item.turnId) || thread.last?.turnId === item.turnId);
				if (delivered) {
					this.removeFromOutbox(item.turnId);
					continue;
				}
			}
			void this.flush(item);
		}
	}

	private removeFromOutbox(turnId: string): void {
		this.outbox = this.outbox.filter(item => item.turnId !== turnId);
		void this.persistOutbox();
	}

	private setPending(chatId: string, send: IPendingSend): void {
		const list = this.getPending(chatId).filter(p => p.turnId !== send.turnId);
		this.pending.set(chatId, [...list, send]);
		this.notifySoon(`pending:${chatId}`);
	}

	private removePending(chatId: string, turnId: string): void {
		const list = this.getPending(chatId);
		if (list.some(p => p.turnId === turnId)) {
			this.pending.set(chatId, list.filter(p => p.turnId !== turnId));
			this.notifySoon(`pending:${chatId}`);
		}
	}

	private settlePendingFromTranscript(chatId: string): void {
		const list = this.getPending(chatId);
		if (!list.length) {
			return;
		}
		const shown = new Set((this.transcripts.get(chatId)?.messages ?? []).filter(m => m.kind === 'user' && m.id).map(m => m.id!));
		const now = Date.now();
		const next = list.filter(p => !shown.has(p.turnId) && (p.state === 'failed' || now - p.at < PENDING_EXPIRY_MS));
		if (next.length !== list.length) {
			this.pending.set(chatId, next);
			this.notifySoon(`pending:${chatId}`);
		}
	}

	private settlePendingFromThreads(): void {
		const threads = threadsOf(this.cols);
		for (const [chatId, list] of this.pending) {
			const thread = threads[chatId];
			if (!thread || !list.length) {
				continue;
			}
			const queued = new Set(thread.queue.map(q => q.id));
			const next = list.filter(p => !queued.has(p.turnId));
			if (next.length !== list.length) {
				this.pending.set(chatId, next);
				this.notifySoon(`pending:${chatId}`);
			}
		}
	}

	//#endregion

	//#region Actions

	/** Calls a server method; failures become an error toast and resolve undefined. */
	async run<T>(method: string, params: readonly unknown[] = [], failure?: string): Promise<T | undefined> {
		try {
			return await this.connection.call<T>(method, params);
		} catch (err) {
			this.toast('error', failure ? `${failure}: ${errorMessage(err)}` : errorMessage(err));
			return undefined;
		}
	}

	stop(chatId: string): Promise<unknown> {
		return this.run('orchestrator.cancel', [chatId], 'Couldn\'t stop');
	}

	respondToApproval(requestId: string, effect: 'allow' | 'deny', scope: 'once' | 'always' = 'once'): Promise<unknown> {
		return this.run('runtime.respondToAccessRequest', [requestId, effect, scope], 'Couldn\'t answer');
	}

	answerQuestions(requestId: string, response: IQuestionResponse): Promise<unknown> {
		return this.run('runtime.respondToQuestions', [requestId, response], 'Couldn\'t answer');
	}

	dismissQuestions(requestId: string): Promise<unknown> {
		return this.answerQuestions(requestId, { outcome: 'cancelled', answers: [], dismissed: true });
	}

	resumeLimit(chatId: string): Promise<unknown> {
		return this.run('orchestrator.resumeLimit', [chatId], 'Couldn\'t resume');
	}

	resumeQueue(chatId: string): Promise<unknown> {
		return this.run('orchestrator.dispatch', [{ type: 'queue.resume', threadId: chatId }], 'Couldn\'t resume');
	}

	removeQueued(chatId: string, itemId: string): Promise<unknown> {
		return this.run('orchestrator.dispatch', [{ type: 'queue.remove', threadId: chatId, itemId }], 'Couldn\'t remove');
	}

	sendQueuedNow(chatId: string, itemId: string): Promise<unknown> {
		return this.run('orchestrator.dispatch', [{ type: 'queue.sendNow', threadId: chatId, itemId }], 'Couldn\'t send');
	}

	clearQueue(chatId: string): Promise<unknown> {
		return this.run('orchestrator.dispatch', [{ type: 'queue.clear', threadId: chatId }], 'Couldn\'t clear the queue');
	}

	cancelTask(taskId: string): Promise<unknown> {
		return this.run('orchestrator.dispatch', [{ type: 'task.cancel', taskId, reason: 'Stopped from a paired device' }], 'Couldn\'t stop the subagent');
	}

	rename(chatId: string, title: string): Promise<unknown> {
		return this.run('history.rename', [chatId, title.trim() || undefined], 'Couldn\'t rename');
	}

	setPinned(chatId: string, pinned: boolean): Promise<unknown> {
		return this.run('history.setPinned', [chatId, pinned]);
	}

	setArchived(chatId: string, archived: boolean): Promise<unknown> {
		return this.run('history.setArchived', [chatId, archived]);
	}

	setSettled(chatId: string, settled: boolean): Promise<unknown> {
		return this.run('history.setSettled', [chatId, settled, { byUser: true }]);
	}

	snooze(chatId: string, until: number | undefined): Promise<unknown> {
		return this.run('history.setSnoozed', [chatId, true, until]);
	}

	wake(chatId: string): Promise<unknown> {
		return this.run('history.setSnoozed', [chatId, false]);
	}

	deleteChat(chatId: string): Promise<unknown> {
		return this.run('history.delete', [chatId], 'Couldn\'t delete');
	}

	markRead(chatId: string): void {
		const meta = this.cols['history']?.[chatId] as { unread?: boolean; wokeAt?: number } | undefined;
		if (meta?.unread) {
			void this.connection.call('history.setUnread', [chatId, false]).catch(() => undefined);
		}
		if (meta?.wokeAt) {
			void this.connection.call('history.clearWoke', [chatId]).catch(() => undefined);
		}
	}

	markUnread(chatId: string): Promise<unknown> {
		return this.run('history.setUnread', [chatId, true]);
	}

	markAllRead(): Promise<unknown> {
		return this.run('history.markAllRead', []);
	}

	setAccessMode(mode: AccessMode, chatId?: string): Promise<unknown> {
		return this.run('runtime.setAccessMode', chatId ? [mode, chatId] : [mode], 'Couldn\'t change access');
	}

	setModelEnabled(ref: string, enabled: boolean): Promise<unknown> {
		return this.run('runtime.setModelEnabled', [ref, enabled]);
	}

	setModelOptions(ref: string, options: Record<string, string | boolean>): Promise<unknown> {
		return this.run('runtime.setModelOptions', [ref, options]);
	}

	setActiveModel(ref: string): Promise<unknown> {
		return this.run('runtime.setActiveCatalogRef', [ref]);
	}

	refreshProviders(): Promise<unknown> {
		return this.run('runtime.refreshProviders', [], 'Couldn\'t refresh providers');
	}

	setProfileEnabled(profileId: string, enabled: boolean): Promise<unknown> {
		return this.run('runtime.setProfileEnabled', [profileId, enabled]);
	}

	async addProject(path: string, name?: string): Promise<IProjectRecord | undefined> {
		return this.run<IProjectRecord>('projects.registerProject', [fileUri(path.trim()), name?.trim() || undefined], 'Couldn\'t add the project');
	}

	searchHistory(query: string): Promise<unknown> {
		return this.run('history.search', [query]);
	}

	//#endregion

	//#region Pairing

	environmentInfo(): Promise<IEnvironmentDescriptor | undefined> {
		return this.run<IEnvironmentDescriptor>('pairing.environment', []);
	}

	createPairingCode(): Promise<IPairingCode | undefined> {
		return this.run<IPairingCode>('pairing.createCode', [], 'Couldn\'t make a pairing code');
	}

	listDevices(): Promise<readonly IPairedDevice[] | undefined> {
		return this.run<readonly IPairedDevice[]>('pairing.devices', []);
	}

	revokeDevice(deviceId: string): Promise<boolean | undefined> {
		return this.run<boolean>('pairing.revoke', [deviceId], 'Couldn\'t remove the device');
	}

	renameDevice(deviceId: string, label: string): Promise<boolean | undefined> {
		return this.run<boolean>('pairing.rename', [deviceId, label], 'Couldn\'t rename the device');
	}

	//#endregion

	//#region Toasts

	toast(kind: IToast['kind'], message: string, ms = kind === 'error' ? 5_000 : 3_000): void {
		const toast: IToast = { id: this.nextToastId++, kind, message };
		this.toasts = [...this.toasts.slice(-2), toast];
		this.notifier.notify('toasts');
		setTimeout(() => this.dismissToast(toast.id), ms);
	}

	dismissToast(id: number): void {
		if (this.toasts.some(t => t.id === id)) {
			this.toasts = this.toasts.filter(t => t.id !== id);
			this.notifier.notify('toasts');
		}
	}

	//#endregion

	//#region Cache

	private key(name: string): string {
		return `volt.${this.environment.environmentId}.${name}`;
	}

	private async loadCache(): Promise<void> {
		const storage = this.options.storage;
		if (!storage) {
			return;
		}
		try {
			const [cols, outbox] = await Promise.all([storage.getItem(this.key('cols')), storage.getItem(this.key('outbox'))]);
			if (cols && !this.live) {
				const parsed = JSON.parse(cols) as Collections;
				if (parsed && typeof parsed === 'object') {
					this.cols = parsed;
					this.ready = true;
					Object.keys(parsed).forEach(name => this.notifySoon(`col:${name}`));
					this.setStatus({ ready: true });
				}
			}
			if (outbox) {
				const items = JSON.parse(outbox) as IOutboxItem[];
				if (Array.isArray(items)) {
					this.outbox = items.filter(item => item && typeof item.turnId === 'string');
					for (const item of this.outbox) {
						this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'sending', at: item.createdAt });
					}
				}
			}
		} catch {
			// a corrupt cache is ignored
		}
	}

	private async loadCachedTranscript(chatId: string): Promise<void> {
		const json = await this.options.storage?.getItem(this.key(`t.${chatId}`)).catch(() => null);
		if (!json) {
			return;
		}
		try {
			const messages = JSON.parse(json) as AgentMessage[];
			const current = this.transcripts.get(chatId);
			if (Array.isArray(messages) && current && current.status !== 'live' && !current.messages.length) {
				this.transcripts.set(chatId, { ...current, messages, status: 'cached' });
				this.notifySoon(`transcript:${chatId}`);
			}
		} catch {
			// ignored
		}
	}

	private async cacheTranscript(transcript: ITranscript): Promise<void> {
		const storage = this.options.storage;
		if (!storage || !transcript.messages.length || transcript.messages.some(m => m.kind === 'agent' && m.activity?.streaming)) {
			return;
		}
		try {
			await storage.setItem(this.key(`t.${transcript.id}`), JSON.stringify(transcript.messages.slice(-TRANSCRIPT_CACHE_MESSAGES)));
			const index = JSON.parse(await storage.getItem(this.key('tindex')) ?? '[]') as string[];
			const next = [transcript.id, ...index.filter(id => id !== transcript.id)];
			for (const old of next.splice(TRANSCRIPT_CACHE_LIMIT)) {
				await storage.removeItem(this.key(`t.${old}`));
			}
			await storage.setItem(this.key('tindex'), JSON.stringify(next));
		} catch {
			// out of space: the cache is a nicety
		}
	}

	private scheduleCache(): void {
		if (!this.options.storage || this.cacheTimer) {
			return;
		}
		const wait = Math.max(2_000, 15_000 - (Date.now() - this.lastCacheAt));
		this.cacheTimer = setTimeout(() => {
			this.cacheTimer = undefined;
			void this.persistCollections();
		}, wait);
	}

	private async persistCollections(): Promise<void> {
		const storage = this.options.storage;
		if (!storage || !this.ready) {
			return;
		}
		this.lastCacheAt = Date.now();
		const subset: Record<string, unknown> = {};
		for (const name of CACHED_COLLECTIONS) {
			const value = this.cols[name];
			if (!value) {
				continue;
			}
			subset[name] = name === 'runtime' ? Object.fromEntries(RUNTIME_CACHE_FIELDS.filter(f => f in value).map(f => [f, value[f]])) : value;
		}
		try {
			await storage.setItem(this.key('cols'), JSON.stringify(subset));
		} catch {
			// ignored
		}
	}

	private async persistOutbox(): Promise<void> {
		try {
			await this.options.storage?.setItem(this.key('outbox'), JSON.stringify(this.outbox));
		} catch {
			// ignored
		}
	}

	async persistNow(): Promise<void> {
		await this.persistCollections();
		await Promise.all([...this.transcripts.values()].map(t => this.cacheTranscript(t)));
	}

	/** Forgets everything cached for this environment (it was removed). */
	async clearCache(): Promise<void> {
		const storage = this.options.storage;
		if (!storage) {
			return;
		}
		const index = JSON.parse(await storage.getItem(this.key('tindex')).catch(() => '[]') ?? '[]') as string[];
		await Promise.all([...index.map(id => storage.removeItem(this.key(`t.${id}`))), storage.removeItem(this.key('tindex')), storage.removeItem(this.key('cols')), storage.removeItem(this.key('outbox'))]).catch(() => undefined);
	}

	//#endregion
}

const EMPTY_PENDING: readonly IPendingSend[] = [];

function promptOf(request: Pick<ISendRequest, 'text' | 'mode' | 'modelRef' | 'options'>): IOrchPrompt {
	return {
		text: request.text,
		display: { text: request.text },
		mode: request.mode ?? 'Agent',
		...(request.modelRef ? { modelRef: request.modelRef } : {}),
		...(request.options && Object.keys(request.options).length ? { options: request.options } : {}),
	};
}

/**
 * Applies a patch to a copy of `messages`: unchanged messages keep their objects (row caches are
 * keyed on them). Undefined when the patch doesn't follow `rev` (the caller reopens the chat).
 */
export function applyPatch(messages: readonly AgentMessage[], rev: number, patch: ISessionPatch): AgentMessage[] | undefined {
	if (patch.rev !== rev + 1) {
		return undefined;
	}
	const next = messages.slice(0, Math.min(messages.length, patch.len));
	for (const { i, message } of patch.set) {
		if (i > next.length) {
			return undefined;
		}
		next[i] = message as AgentMessage;
	}
	return next.length === patch.len ? next : undefined;
}

/** A reloaded transcript keeps the objects of messages that didn't change (same JSON). */
function reconcileMessages(previous: readonly AgentMessage[], next: AgentMessage[]): AgentMessage[] {
	if (!previous.length) {
		return next;
	}
	return next.map((message, i) => {
		const old = previous[i];
		return old && old.kind === message.kind && old.id === message.id && JSON.stringify(old) === JSON.stringify(message) ? old : message;
	});
}

/** The state a pending prompt is in, for labels. */
export function pendingLabel(state: PendingState): string {
	return state === 'failed' ? 'Not sent' : state === 'queued' ? 'Queued' : 'Sending…';
}
