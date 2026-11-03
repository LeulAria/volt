/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { applySessionEdits, ISessionPatch, ISessionState, reconcile, SessionEdit, SessionTopicData } from '../../../../../platform/voltAgentServer/common/sessionPatch.js';
import { fromWire } from '../../../../../platform/voltAgentServer/common/wire.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import type { IAgentAssistantMessage, IAgentMessage } from './agentEditor.js';
import { AgentSessionRecord, IAgentSessionChange, IAgentSessionControl, IAgentSessionHost, IAgentTurnSpec } from './agentSessionController.js';

/**
 * Folds and expanded blocks are this window's: a patch for a streaming reply must not close what
 * the reader opened. The server's values fill in what the reader never touched.
 */
export function reconcileKeepingViewState(target: IAgentMessage, source: IAgentMessage): IAgentMessage {
	const viewState = takeViewState(target);
	const result = reconcile(target, source) as IAgentMessage;
	restoreViewState(result, viewState);
	return result;
}

/** The server's edits applied to a message in place, folds and expanded blocks kept as above. False when they do not fit it. */
export function applyEditsKeepingViewState(target: IAgentMessage, edits: readonly SessionEdit[]): boolean {
	const viewState = takeViewState(target);
	if (!applySessionEdits(target, edits, value => fromWire(value))) {
		return false;
	}
	restoreViewState(target, viewState);
	return true;
}

interface IMessageViewState {
	readonly blockState?: IAgentAssistantMessage['blockState'];
	readonly promptExpanded?: boolean;
}

function takeViewState(message: IAgentMessage): IMessageViewState {
	return message.kind === 'agent' ? { blockState: { ...message.blockState } } : message.kind === 'user' ? { promptExpanded: message.promptExpanded } : {};
}

function restoreViewState(result: IAgentMessage, { blockState, promptExpanded }: IMessageViewState): void {
	if (result.kind === 'agent' && blockState) {
		result.blockState = { ...result.blockState, ...blockState };
		for (const segment of result.segments ?? []) {
			const state = segment.kind === 'block' ? blockState[segment.block.id] : undefined;
			if (state && segment.kind === 'block' && 'expanded' in segment.block) {
				segment.block.expanded = state.expanded;
			}
		}
	} else if (result.kind === 'user' && promptExpanded !== undefined) {
		result.promptExpanded = promptExpanded;
	}
}

type SessionEventRoutes = Map<string, Set<(data: SessionTopicData) => void>>;

/** Per client: one listener on its session events, and the chats it hands each event to. */
const sessionRoutes = new WeakMap<IAgentServerClientService, { readonly routes: SessionEventRoutes; readonly listener: IDisposable }>();

/**
 * Hands a client's session events for one chat to `handler`. One listener per client looks the
 * chat up: a listener per chat would give every streamed chunk to every open chat, which with
 * fifty chats at work is fifty calls per chunk.
 */
function onSessionEventFor(client: IAgentServerClientService, sessionId: string, handler: (data: SessionTopicData) => void): IDisposable {
	let entry = sessionRoutes.get(client);
	if (!entry) {
		const routes: SessionEventRoutes = new Map();
		entry = {
			routes,
			listener: client.onSessionEvent(data => {
				const handlers = routes.get(data.id);
				if (handlers) {
					for (const route of [...handlers]) {
						route(data);
					}
				}
			}),
		};
		sessionRoutes.set(client, entry);
	}
	const { routes } = entry;
	let handlers = routes.get(sessionId);
	if (!handlers) {
		handlers = new Set();
		routes.set(sessionId, handlers);
	}
	const own = handlers;
	own.add(handler);
	return toDisposable(() => {
		own.delete(handler);
		if (!own.size && routes.get(sessionId) === own) {
			routes.delete(sessionId);
		}
		const current = sessionRoutes.get(client);
		if (!routes.size && current?.routes === routes) {
			current.listener.dispose();
			sessionRoutes.delete(client);
		}
	});
}

/**
 * Per client: the chats this window shows, by how many views show each. The agent server sends a
 * chat nobody shows its changes once a second instead of every 50 ms (see ServerSessionHost).
 */
class ShownChats {

	private readonly counts = new Map<string, number>();
	private sent: string | undefined;
	/** Held while any chat is shown. */
	private reconnect: IDisposable | undefined;

	constructor(private readonly client: IAgentServerClientService) { }

	add(sessionId: string): IDisposable {
		this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1);
		// A new connection knows nothing of what this window shows: it is told again.
		this.reconnect ??= this.client.onDidChangeState(state => {
			if (state === 'open') {
				this.sent = undefined;
				this.send();
			}
		});
		this.send();
		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			const count = (this.counts.get(sessionId) ?? 1) - 1;
			if (count > 0) {
				this.counts.set(sessionId, count);
			} else {
				this.counts.delete(sessionId);
			}
			this.send();
			if (!this.counts.size) {
				this.reconnect?.dispose();
				this.reconnect = undefined;
			}
		});
	}

	/** Tells the server what this window shows now; a chat it starts showing is sent what it missed at once. */
	private send(): void {
		const ids = [...this.counts.keys()].sort();
		const key = ids.join('\n');
		if (key !== this.sent && this.client.isReady) {
			this.sent = key;
			this.client.call('session.watch', ids).catch(() => undefined);
		}
	}

	has(sessionId: string): boolean {
		return this.counts.has(sessionId);
	}
}

const shownChats = new WeakMap<IAgentServerClientService, ShownChats>();

function shownChatsOf(client: IAgentServerClientService): ShownChats {
	let shown = shownChats.get(client);
	if (!shown) {
		shown = new ShownChats(client);
		shownChats.set(client, shown);
	}
	return shown;
}

/** After a reconnect, chats nobody shows reload this many at a time; a shown one goes first. */
const BACKGROUND_REOPENS = 4;
const reopenLimiters = new WeakMap<IAgentServerClientService, Limiter<void>>();

function reopenLimiter(client: IAgentServerClientService): Limiter<void> {
	let limiter = reopenLimiters.get(client);
	if (!limiter) {
		limiter = new Limiter<void>(BACKGROUND_REOPENS);
		reopenLimiters.set(client, limiter);
	}
	return limiter;
}

/** A chat's transcript as the server last sent it. */
export interface IRemoteTranscript {
	readonly messages: IAgentMessage[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
}

/**
 * The session controller of a chat whose agent runs in the agent server. The server's own
 * controller folds the run events; this one keeps the input's messages equal to the server's
 * (patches applied in place, so views keep their caches) and fires the same changes the
 * in-process controller would. A view's own changes (a stopped reply, a cut transcript) and
 * skips go to the server, which records them.
 */
export class RemoteAgentSessionControl extends Disposable implements IAgentSessionControl {

	private readonly _onDidChange = this._register(new Emitter<IAgentSessionChange>());
	readonly onDidChange: Event<IAgentSessionChange> = this._onDidChange.event;
	private readonly _onDidBecomeIdle = this._register(new Emitter<void>());
	readonly onDidBecomeIdle: Event<void> = this._onDidBecomeIdle.event;

	/** The revision the input's messages are at; -1 until the chat was opened. */
	private rev = -1;
	private opening: Promise<IRemoteTranscript> | undefined;
	/** Patches that arrived while the chat was being opened. */
	private early: ISessionPatch[] = [];
	private readonly route = this._register(new MutableDisposable());
	/** A reload waits its turn behind other chats' (queued), or is under way. */
	private reload: 'queued' | 'running' | undefined;

	constructor(
		private host: IAgentSessionHost,
		@IAgentServerClientService private readonly client: IAgentServerClientService,
	) {
		super();
		this.route.value = onSessionEventFor(client, host.sessionId, data => this.onSessionEvent(data));
		this._register(client.onDidResync(() => {
			if (this.rev >= 0) {
				this.requestReopen();
			}
		}));
		this._register({
			dispose: () => {
				if (this.rev >= 0 || this.opening) {
					client.send('session.close', this.host.sessionId);
				}
			},
		});
	}

	setHost(host: IAgentSessionHost): void {
		if (host.sessionId !== this.host.sessionId) {
			this.route.value = onSessionEventFor(this.client, host.sessionId, data => this.onSessionEvent(data));
		}
		this.host = host;
	}

	get isRunning(): boolean {
		const last = this.host.messages.at(-1);
		return last?.kind === 'agent' && !!last.activity?.streaming;
	}

	/** Opens the chat on the server and returns its transcript; patches follow from then on. */
	loadTranscript(): Promise<IRemoteTranscript> {
		this.opening ??= this.open().finally(() => this.opening = undefined);
		return this.opening;
	}

	private async open(): Promise<IRemoteTranscript> {
		this.early = [];
		await this.client.whenReady;
		const state = await this.client.call<ISessionState>('session.open', this.host.sessionId);
		// Straight into the input's own array, in the same task the answer arrived in: a patch that
		// comes next finds the transcript at `state.rev`.
		const messages = this.host.messages;
		reconcile(messages, state.messages);
		this.host.contextUsed = state.contextUsed;
		this.host.contextWindow = state.contextWindow;
		this.rev = state.rev;
		const early = this.early.filter(patch => patch.rev > state.rev).sort((a, b) => a.rev - b.rev);
		this.early = [];
		for (const patch of early) {
			if (!this.applyTo(messages, patch)) {
				break;
			}
		}
		return { messages, contextUsed: this.host.contextUsed, contextWindow: this.host.contextWindow };
	}

	/** The chat is on screen until the returned handle is disposed: the server sends its changes at full rate. */
	watch(): IDisposable {
		const handle = shownChatsOf(this.client).add(this.host.sessionId);
		if (this.reload === 'queued') {
			void this.runReopen();
		}
		return handle;
	}

	/**
	 * Reloads the transcript after a reconnect or a missed patch. A chat on screen reloads now;
	 * the others take turns, so a reconnect with a hundred chats open is not a hundred reloads at once.
	 */
	private requestReopen(): void {
		if (this.reload) {
			return;
		}
		if (shownChatsOf(this.client).has(this.host.sessionId)) {
			void this.runReopen();
			return;
		}
		this.reload = 'queued';
		void reopenLimiter(this.client).queue(async () => {
			if (this.reload === 'queued' && !this._store.isDisposed) {
				await this.runReopen();
			}
		});
	}

	private async runReopen(): Promise<void> {
		this.reload = 'running';
		try {
			await this.reopen();
		} finally {
			this.reload = undefined;
		}
	}

	/** After a resync or a missed patch: take the server's transcript as it is now. */
	private async reopen(): Promise<void> {
		try {
			const wasRunning = this.isRunning;
			this.rev = -1;
			await this.loadTranscript();
			this._onDidChange.fire({ kind: 'render' });
			if (wasRunning && !this.isRunning) {
				this._onDidChange.fire({ kind: 'runEnd' });
				this._onDidBecomeIdle.fire();
			}
		} catch {
			// The connection dropped again; the next resync reopens.
		}
	}

	private onSessionEvent(data: SessionTopicData): void {
		if (data.id !== this.host.sessionId) {
			return;
		}
		switch (data.type) {
			case 'patch':
				if (this.opening && this.rev < 0) {
					this.early.push(data);
					return;
				}
				// A reload on its way brings this change too.
				if (this.rev < 0 || data.rev <= this.rev || this.reload === 'queued') {
					return;
				}
				if (data.rev !== this.rev + 1 || !this.applyTo(this.host.messages, data)) {
					this.requestReopen();
					return;
				}
				this._onDidChange.fire({ kind: 'render' });
				return;
			case 'change':
				if (this.rev >= 0) {
					this._onDidChange.fire({ ...data.change });
				}
				return;
			case 'idle':
				this._onDidBecomeIdle.fire();
				return;
		}
	}

	/** Applies one patch in place; false when it doesn't fit (the caller reopens). */
	private applyTo(messages: IAgentMessage[], patch: ISessionPatch): boolean {
		if (patch.rev !== this.rev + 1 && this.rev >= 0) {
			return false;
		}
		messages.length = Math.min(messages.length, patch.len);
		for (const { i, edits } of patch.edit ?? []) {
			if (i >= messages.length || !applyEditsKeepingViewState(messages[i], edits)) {
				return false;
			}
		}
		for (const { i, message } of patch.set) {
			if (i > messages.length) {
				return false;
			}
			const next = fromWire<IAgentMessage>(message);
			messages[i] = i < messages.length ? reconcileKeepingViewState(messages[i], next) : next;
		}
		if (messages.length !== patch.len) {
			return false;
		}
		if (patch.contextUsed !== undefined) {
			this.host.contextUsed = patch.contextUsed;
		}
		if (patch.contextWindow !== undefined) {
			this.host.contextWindow = patch.contextWindow;
		}
		this.rev = patch.rev;
		return true;
	}

	skipCurrentRun(): void {
		this.client.send('session.skipCurrentRun', this.host.sessionId);
	}

	beginTurn(_spec: IAgentTurnSpec): IAgentAssistantMessage {
		throw new Error('Turns start in the agent server.');
	}

	endUnstartedTurn(): void {
		// The server's controller closes turns it could not start.
	}

	recordSteer(): boolean {
		return false;
	}

	forwardRecord(record: AgentSessionRecord): void {
		if (record.kind === 'assistant') {
			this.client.send('session.recordAssistant', this.host.sessionId, record.message, record.final, record.status);
		} else {
			this.client.send('session.truncate', this.host.sessionId, record.messageId);
		}
	}
}
