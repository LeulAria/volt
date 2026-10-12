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
import type {
	AccessMode, AgentMessage, ComposerMode, IAgentChange, ICheckpointState, IFileContent, IFileEntry, IFileRoot, IGitStatus, IGrepMatch, IGrepOptions, IOrchPrompt, IProjectRecord,
	IPromptAttachment, IQuestionResponse, IRestorePreview, IUserMessage
} from './types';

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
	/** Images uploaded with {@link VoltClient.uploadAttachment}. */
	readonly attachments?: readonly IPromptAttachment[];
}

/** A picked or pasted image before it is uploaded: base64 without a `data:` prefix. */
export interface IAttachmentSource {
	readonly base64: string;
	readonly mime: string;
	readonly name?: string;
}

/** Editing a sent prompt: the new text (and images); the chat is cut back to before it. */
export interface IEditRequest {
	readonly text: string;
	readonly attachments?: readonly IPromptAttachment[];
	readonly mode?: ComposerMode;
	readonly modelRef?: string;
	readonly options?: Record<string, string | boolean>;
	/** Also put the files back as they were before the prompt ran. */
	readonly revertFiles?: boolean;
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
/** Images kept as data URLs; a phone keeps fewer. */
const ATTACHMENT_CACHE_CHARS = 48 * 1024 * 1024;
/** Images the model takes. */
export const SENDABLE_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
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
	private readonly attachmentUrls = new Map<string, string>();
	private attachmentChars = 0;
	private readonly attachmentLoads = new Map<string, Promise<string | undefined>>();
	private readonly checkpointStates = new Map<string, ICheckpointState>();

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

	/**
	 * Edits a sent prompt, the way the desktop's "edit and resend" does: a running reply is stopped,
	 * the prompt and everything after it leave the chat and the agent's context, files go back too
	 * when asked, and the edited prompt is sent in its place.
	 */
	async editMessage(chatId: string, turnId: string, request: IEditRequest): Promise<boolean> {
		if (!await this.cutBefore(chatId, turnId, request.revertFiles ?? false)) {
			return false;
		}
		this.send({ threadId: chatId, ...request, delivery: 'auto' });
		return true;
	}

	/** "Rewind to here": the prompt and everything after it leave the chat; the prompt is returned to edit. */
	async rewindTo(chatId: string, turnId: string, revertFiles = false): Promise<IUserMessage | undefined> {
		const message = this.userMessage(chatId, turnId);
		return message && await this.cutBefore(chatId, turnId, revertFiles) ? message : undefined;
	}

	/** Sends a prompt again as it was (the reply under it is replaced). */
	retryTurn(chatId: string, turnId: string): Promise<boolean> {
		const message = this.userMessage(chatId, turnId);
		if (!message) {
			return Promise.resolve(false);
		}
		const mode = message.mode as ComposerMode | undefined;
		return this.editMessage(chatId, turnId, { text: message.text, attachments: attachmentsOf(message), ...(mode ? { mode } : {}) });
	}

	private userMessage(chatId: string, turnId: string): IUserMessage | undefined {
		const message = this.transcripts.get(chatId)?.messages.find(m => m.kind === 'user' && m.id === turnId);
		return message?.kind === 'user' ? message : undefined;
	}

	private async cutBefore(chatId: string, turnId: string, revertFiles: boolean): Promise<boolean> {
		const messages = this.transcripts.get(chatId)?.messages ?? [];
		const index = messages.findIndex(m => m.kind === 'user' && m.id === turnId);
		if (index < 0) {
			this.toast('error', 'That message is no longer in the chat.');
			return false;
		}
		const userTurns = messages.slice(0, index).filter(m => m.kind === 'user').length;
		try {
			const thread = threadsOf(this.cols)[chatId];
			const last = messages[messages.length - 1];
			if (thread?.active || (last?.kind === 'agent' && last.activity?.streaming)) {
				await this.connection.call('session.skipCurrentRun', [chatId], { requireOpen: true }).catch(() => undefined);
				await this.connection.call('orchestrator.cancel', [chatId], { requireOpen: true });
			}
			if (revertFiles) {
				await this.connection.call('checkpoints.restoreCheckpoint', [chatId, turnId, { overwrite: true }], { requireOpen: true, timeoutMs: 60_000 });
			}
			await this.connection.call('session.truncate', [chatId, turnId], { requireOpen: true });
			await this.connection.call('runtime.truncateSession', [chatId, userTurns], { requireOpen: true });
			return true;
		} catch (err) {
			this.toast('error', `Couldn't edit: ${errorMessage(err)}`);
			return false;
		}
	}

	/**
	 * Puts an image in the server's attachment store (where the desktop keeps pasted images) and
	 * returns it ready to send. The preview is cached, so the sent bubble shows it at once.
	 */
	async uploadAttachment(source: IAttachmentSource): Promise<IPromptAttachment> {
		const mime = source.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : source.mime.toLowerCase();
		const ref = await this.connection.call<string>('history.putAttachment', [{ $u8: source.base64 }, mime], { requireOpen: true, timeoutMs: 120_000 });
		this.rememberAttachment(ref, `data:${mime};base64,${source.base64}`);
		return { id: uuid(), name: source.name || `image.${mime.split('/')[1] ?? 'png'}`, mime, ref, size: Math.floor(source.base64.length * 0.75) };
	}

	/** An attachment's image as a data URL, when it is loaded (see {@link loadAttachment}). */
	getAttachmentUrl(ref: string): string | undefined {
		return this.attachmentUrls.get(ref);
	}

	/** Loads an attachment's image; listeners of `attachment:<ref>` hear when it is there. */
	loadAttachment(ref: string): Promise<string | undefined> {
		const known = this.attachmentUrls.get(ref);
		if (known) {
			return Promise.resolve(known);
		}
		let load = this.attachmentLoads.get(ref);
		if (!load) {
			load = this.connection.call<{ bytes?: { $u8?: string }; mime?: string } | undefined>('history.getAttachment', [ref], { timeoutMs: 60_000 })
				.then(result => {
					const base64 = result?.bytes?.$u8;
					if (!base64) {
						return undefined;
					}
					const url = `data:${result?.mime ?? 'image/png'};base64,${base64}`;
					this.rememberAttachment(ref, url);
					return url;
				})
				.catch(() => undefined)
				.finally(() => this.attachmentLoads.delete(ref));
			this.attachmentLoads.set(ref, load);
		}
		return load;
	}

	private rememberAttachment(ref: string, url: string): void {
		const old = this.attachmentUrls.get(ref);
		if (old) {
			this.attachmentChars -= old.length;
			this.attachmentUrls.delete(ref);
		}
		this.attachmentUrls.set(ref, url);
		this.attachmentChars += url.length;
		for (const [key, value] of this.attachmentUrls) {
			if (this.attachmentChars <= ATTACHMENT_CACHE_CHARS || key === ref) {
				break;
			}
			this.attachmentUrls.delete(key);
			this.attachmentChars -= value.length;
		}
		this.notifier.notify(`attachment:${ref}`);
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
		this.send({ threadId: chatId, text: failed.text, ...(failed.attachments ? { attachments: failed.attachments } : {}) });
	}

	dismissPending(chatId: string, turnId: string): void {
		this.removePending(chatId, turnId);
		this.outbox = this.outbox.filter(item => item.turnId !== turnId);
		void this.persistOutbox();
	}

	private enqueue(item: IOutboxItem, text: string): void {
		const attachments = promptAttachments(item.prompt);
		this.setPending(item.threadId, { turnId: item.turnId, text, state: 'sending', at: item.createdAt, ...(attachments.length ? { attachments } : {}) });
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
				this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'failed', at: item.createdAt, error: result.reason ?? 'Volt did not take the prompt.', attachments: promptAttachments(item.prompt) });
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
				this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'failed', at: item.createdAt, error: errorMessage(err), attachments: promptAttachments(item.prompt) });
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

	//#region Checkpoints and changes

	/** A chat's checkpoints: the server's published copy, or the one loaded here. */
	getCheckpoints(chatId: string): ICheckpointState | undefined {
		return (this.cols['checkpoints']?.[chatId] as ICheckpointState | undefined) ?? this.checkpointStates.get(chatId);
	}

	/** Loads a chat's checkpoints (the server only publishes them once a run or a load touched them). */
	async loadCheckpoints(chatId: string): Promise<ICheckpointState | undefined> {
		try {
			const checkpoints = await this.connection.call<ICheckpointState['checkpoints']>('checkpoints.loadCheckpoints', [chatId], { requireOpen: true });
			const state: ICheckpointState = { checkpoints: Array.isArray(checkpoints) ? checkpoints : [], canRedo: this.getCheckpoints(chatId)?.canRedo ?? false };
			this.checkpointStates.set(chatId, state);
			this.notifier.notify(`checkpoints:${chatId}`);
			return state;
		} catch {
			return undefined;
		}
	}

	/** What restoring the files to before `turnId` would do. */
	previewRestore(chatId: string, turnId: string): Promise<IRestorePreview | undefined> {
		return this.run<IRestorePreview>('checkpoints.previewRestore', [chatId, turnId], 'Couldn\'t check the files');
	}

	/** Puts the files back as they were before `turnId` ran (the desktop's Restore Checkpoint). */
	async restoreCheckpoint(chatId: string, turnId: string, overwrite = false): Promise<IRestorePreview | undefined> {
		const result = await this.run<IRestorePreview>('checkpoints.restoreCheckpoint', [chatId, turnId, { overwrite }], 'Couldn\'t restore the checkpoint');
		if (result?.applied) {
			this.toast('success', result.files.length ? `Restored ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}` : 'Files already match the checkpoint');
		}
		return result;
	}

	/** Undoes the latest restore of a chat. */
	async redoCheckpoint(chatId: string): Promise<IRestorePreview | undefined> {
		const result = await this.run<IRestorePreview>('checkpoints.redo', [chatId, { overwrite: true }], 'Couldn\'t redo');
		if (result?.applied) {
			this.toast('success', 'Changes put back');
		}
		return result;
	}

	/** Files the agent changed: over the whole chat, in its last turn that changed any, or in one turn. */
	async getChanges(chatId: string, scope: 'session' | 'lastTurn' | { readonly turnId: string } = 'session'): Promise<readonly IAgentChange[]> {
		return await this.connection.call<readonly IAgentChange[]>('checkpoints.getChanges', [chatId, scope], { timeoutMs: 60_000 }) ?? [];
	}

	//#endregion

	//#region Files (throw RemoteError; the views show it where it happened)

	listRoots(): Promise<readonly IFileRoot[]> {
		return this.connection.call<readonly IFileRoot[]>('files.roots', []);
	}

	listDir(path: string): Promise<readonly IFileEntry[]> {
		return this.connection.call<readonly IFileEntry[]>('files.list', [path]);
	}

	readFile(path: string): Promise<IFileContent> {
		return this.connection.call<IFileContent>('files.read', [path], { timeoutMs: 60_000 });
	}

	/** `mtime`: the version it was read at; a newer one on disk fails with `Conflict`. */
	writeFile(path: string, text: string, options: { readonly mtime?: number; readonly create?: boolean } = {}): Promise<{ readonly mtime: number; readonly size: number }> {
		return this.connection.call('files.write', [path, text, options], { requireOpen: true, timeoutMs: 60_000 });
	}

	createFile(path: string, kind: 'file' | 'dir' = 'file'): Promise<IFileEntry> {
		return this.connection.call<IFileEntry>('files.create', [path, kind], { requireOpen: true });
	}

	renamePath(from: string, to: string): Promise<boolean> {
		return this.connection.call<boolean>('files.rename', [from, to], { requireOpen: true });
	}

	deletePath(path: string): Promise<boolean> {
		return this.connection.call<boolean>('files.delete', [path], { requireOpen: true });
	}

	/** Every file under a root (relative, `/`-separated), for quick open. */
	fileIndex(root: string): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
		return this.connection.call('files.index', [root], { timeoutMs: 60_000 });
	}

	grep(root: string, query: string, options: IGrepOptions = {}): Promise<{ readonly matches: readonly IGrepMatch[]; readonly truncated: boolean }> {
		return this.connection.call('files.grep', [root, query, options], { timeoutMs: 60_000 });
	}

	gitStatus(root: string): Promise<IGitStatus> {
		return this.connection.call<IGitStatus>('files.gitStatus', [root], { timeoutMs: 30_000 });
	}

	/** A file as git has it at `ref` (default HEAD): the left side of a diff. */
	gitShow(path: string, ref = 'HEAD'): Promise<{ readonly text: string; readonly exists: boolean }> {
		return this.connection.call('files.gitShow', [path, ref], { timeoutMs: 30_000 });
	}

	gitBlob(repoRoot: string, sha: string): Promise<{ readonly text: string; readonly exists: boolean }> {
		return this.connection.call('files.gitBlob', [repoRoot, sha], { timeoutMs: 30_000 });
	}

	/** Stages every change in the root's repository and commits it. */
	gitCommit(root: string, message: string): Promise<{ readonly commit: string }> {
		return this.connection.call('files.gitCommit', [root, message], { requireOpen: true, timeoutMs: 60_000 });
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
						const attachments = promptAttachments(item.prompt);
						this.setPending(item.threadId, { turnId: item.turnId, text: item.prompt.text, state: 'sending', at: item.createdAt, ...(attachments.length ? { attachments } : {}) });
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

/**
 * The prompt the orchestrator takes. Images ride as the desktop composer's image mentions (frozen:
 * an attachment ref instead of bytes): the server's turn host thaws them and sends the pixels.
 */
function promptOf(request: Pick<ISendRequest, 'text' | 'mode' | 'modelRef' | 'options' | 'attachments'>): IOrchPrompt {
	const mentions = (request.attachments ?? []).map(a => ({ label: a.name, kind: 'image', image: { id: a.id, mime: a.mime, ref: a.ref, name: a.name } }));
	return {
		text: request.text,
		display: mentions.length ? { text: request.text, mentions } : { text: request.text },
		mode: request.mode ?? 'Agent',
		...(request.modelRef ? { modelRef: request.modelRef } : {}),
		...(request.options && Object.keys(request.options).length ? { options: request.options } : {}),
	};
}

/** The images a stored prompt carries. */
function promptAttachments(prompt: IOrchPrompt): IPromptAttachment[] {
	const mentions = (prompt.display as { mentions?: unknown } | undefined)?.mentions;
	return Array.isArray(mentions) ? attachmentsOf({ kind: 'user', text: prompt.text, mentions }) : [];
}

/** The images of a sent prompt, ready to send again. */
export function attachmentsOf(message: Pick<IUserMessage, 'mentions'> & { readonly kind: 'user'; readonly text: string }): IPromptAttachment[] {
	const out: IPromptAttachment[] = [];
	for (const mention of message.mentions ?? []) {
		const image = mention.image;
		if (image?.ref) {
			out.push({ id: image.id ?? uuid(), name: mention.label ?? image.name ?? 'image', mime: image.mime ?? 'image/png', ref: image.ref });
		}
	}
	return out;
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
