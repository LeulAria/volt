/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ISessionChangeEvent, ISessionState, reconcile, SessionPatcher, SessionTopicData } from '../../../platform/voltAgentServer/common/sessionPatch.js';
import { toWire } from '../../../platform/voltAgentServer/common/wire.js';
import type { IAgentAssistantMessage, IAgentMessage, IAgentUserMessage } from '../../../workbench/contrib/voltAgent/browser/editor/agentEditor.js';
import { agentMessagePlainText } from '../../../workbench/contrib/voltAgent/browser/context/agentContextUsage.js';
import { AgentSessionStatus } from '../../../workbench/services/voltRuntime/common/history/agentHistory.js';
import { AgentEditorInput, onDidCreateAgentEditorInput } from '../../../workbench/contrib/voltAgent/browser/editor/agentEditorInput.js';
import { IAgentSessionChange } from '../../../workbench/contrib/voltAgent/browser/editor/agentSessionController.js';

const NO_HOLDERS: ReadonlySet<number> = new Set();

/** Streaming changes are sent at most this often per chat a client shows. */
const PATCH_INTERVAL_MS = 50;
/**
 * And this often for a chat no client shows: with a hundred chats at work, every one of them at
 * 50 ms kept the server and the windows busy with chats nobody was looking at. Turn starts and ends
 * still go out at once, and a chat is brought up to date the moment a client shows it.
 */
const BACKGROUND_PATCH_INTERVAL_MS = 1000;
/**
 * A streaming patch compares only the current turn (from the last prompt on); the whole transcript
 * is compared at a turn's start and end, on a client's request, and at least this often.
 */
const WHOLE_DIFF_INTERVAL_MS = 5000;
/** Chats a client opened stay loaded on the server; idle ones beyond this are let go. */
const MAX_HELD = 48;

interface ITracked {
	readonly input: AgentEditorInput;
	readonly store: DisposableStore;
	loaded: boolean;
}

interface IHeld {
	readonly input: AgentEditorInput;
	/** Connections that have the chat open. */
	readonly holders: Set<number>;
	lastUsed: number;
}

/**
 * Publishes every chat's transcript. Run events are folded into messages by the chat's session
 * controller, exactly as in the desktop window; this host diffs the result and sends patches
 * (`session` topic), so every client renders the same messages. It also keeps chats a client
 * opened loaded, and runs the transcript operations a client asks for.
 */
export class ServerSessionHost extends Disposable {

	private readonly patchers = new Map<string, SessionPatcher>();
	private readonly tracked = new Map<string, ITracked>();
	private readonly held = new Map<string, IHeld>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** When each chat's whole transcript was last compared (see WHOLE_DIFF_INTERVAL_MS). */
	private readonly wholeDiffAt = new Map<string, number>();
	/** Per connection that said so (`session.watch`): the chats it shows. */
	private readonly watching = new Map<number, ReadonlySet<string>>();
	/** Per connection: the chats it has open (`session.open` without a `session.close` yet). */
	private readonly opened = new Map<number, Set<string>>();
	private connections: ReadonlySet<number> = new Set();

	/**
	 * `publish` sends session events: patches in their compact form, with `full` building the
	 * whole-message form for clients that take only that (see ISessionPatch).
	 */
	constructor(
		private readonly publish: (data: SessionTopicData, full?: () => SessionTopicData) => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(onDidCreateAgentEditorInput(input => this.track(input)));
		this._register(toDisposable(() => {
			for (const timer of this.timers.values()) {
				clearTimeout(timer);
			}
			for (const tracked of this.tracked.values()) {
				tracked.store.dispose();
			}
			for (const held of this.held.values()) {
				held.input.dispose();
			}
		}));
	}

	/** The input that owns `sessionId` now (the turn host's, or one a client holds). */
	private current(sessionId: string): ITracked | undefined {
		const tracked = this.tracked.get(sessionId);
		return tracked && !tracked.input.isDisposed() ? tracked : undefined;
	}

	private track(input: AgentEditorInput): void {
		const sessionId = input.sessionId;
		this.tracked.get(sessionId)?.store.dispose();
		const store = new DisposableStore();
		const tracked: ITracked = { input, store, loaded: false };
		this.tracked.set(sessionId, tracked);
		// Only a loaded transcript is compared with what clients hold: an empty one before its
		// history is read would look like the chat was cleared.
		void input.ensureLoaded().then(() => {
			if (this.tracked.get(sessionId) !== tracked) {
				return;
			}
			tracked.loaded = true;
			store.add(input.controller.onDidChange(change => this.onChange(sessionId, change)));
			store.add(input.controller.onDidBecomeIdle(() => this.publish({ type: 'idle', id: sessionId })));
			this.schedule(sessionId);
		}, err => this.logService.warn(`[volt agent server] could not load chat ${sessionId}`, err));
		store.add(input.onWillDispose(() => {
			if (this.tracked.get(sessionId) === tracked) {
				this.flush(sessionId);
				this.tracked.delete(sessionId);
			}
			store.dispose();
		}));
	}

	private onChange(sessionId: string, change: IAgentSessionChange): void {
		// 'activity' changed the messages without changing what is drawn (more reasoning): a patch carries it too.
		if (change.kind === 'render' || change.kind === 'activity') {
			this.schedule(sessionId);
			return;
		}
		// Lifecycle changes go out right after the messages they describe.
		this.flush(sessionId);
		const event: ISessionChangeEvent = {
			id: sessionId,
			change: {
				kind: change.kind,
				...(change.turnId ? { turnId: change.turnId } : {}),
				...(change.aborted ? { aborted: true } : {}),
				...(change.failed ? { failed: true } : {}),
			},
		};
		this.publish({ type: 'change', ...event });
	}

	private schedule(sessionId: string): void {
		if (this.timers.has(sessionId)) {
			return;
		}
		this.timers.set(sessionId, setTimeout(() => {
			this.timers.delete(sessionId);
			this.flush(sessionId, true);
		}, this.shown(sessionId) ? PATCH_INTERVAL_MS : BACKGROUND_PATCH_INTERVAL_MS));
	}

	/**
	 * A client shows the chat. One that never said what it shows (the phone app) shows the chats it
	 * has open: it opens a chat while it is on screen and closes it soon after.
	 */
	private shown(sessionId: string): boolean {
		for (const connectionId of this.connections) {
			if ((this.watching.get(connectionId) ?? this.opened.get(connectionId))?.has(sessionId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The chats `connectionId` shows now (it replaces what it said before). A chat it starts showing
	 * is sent its changes at once, before this returns, so the client draws it up to date.
	 */
	watch(connectionId: number, sessionIds: readonly string[]): void {
		const before = this.watching.get(connectionId);
		const next = new Set(sessionIds);
		this.watching.set(connectionId, next);
		for (const sessionId of next) {
			if (!before?.has(sessionId)) {
				this.flush(sessionId);
			}
		}
	}

	/**
	 * Sends what changed in the chat's transcript since the last patch. A `streaming` flush compares
	 * only the current turn, unless the whole transcript was last compared a while ago.
	 */
	private flush(sessionId: string, streaming = false): void {
		const timer = this.timers.get(sessionId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.timers.delete(sessionId);
		}
		const tracked = this.current(sessionId);
		if (!tracked?.loaded) {
			return;
		}
		const input = tracked.input;
		// Tool arguments streamed since the last patch are parsed once, here (the window does it per frame).
		input.controller.flushStreamedInput?.();
		const patcher = this.patcherFor(sessionId, input.messages);
		const now = Date.now();
		const whole = !streaming || now - (this.wholeDiffAt.get(sessionId) ?? 0) >= WHOLE_DIFF_INTERVAL_MS;
		if (whole) {
			this.wholeDiffAt.set(sessionId, now);
		}
		const patches = patcher.diffPatches(input.messages, { contextUsed: input.contextUsed, contextWindow: input.contextWindow }, whole ? 0 : currentTurnStart(input.messages));
		if (patches) {
			this.publish({ type: 'patch', ...patches.compact }, () => ({ type: 'patch', ...patches.full }));
		}
	}

	private patcherFor(sessionId: string, messages: readonly IAgentMessage[]): SessionPatcher {
		let patcher = this.patchers.get(sessionId);
		if (!patcher) {
			patcher = new SessionPatcher(sessionId, toWire);
			patcher.reset(messages);
			this.patchers.set(sessionId, patcher);
		}
		return patcher;
	}

	private wireMessages(messages: readonly IAgentMessage[]): unknown[] {
		return toWire(messages) as unknown[];
	}

	//#region Client operations

	/** The chat's live input, loading the chat (held, see {@link trim}) when nothing has it yet. */
	private async inputFor(sessionId: string): Promise<AgentEditorInput> {
		let tracked = this.current(sessionId);
		if (!tracked) {
			const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(sessionId));
			this.held.set(sessionId, { input, holders: new Set(), lastUsed: Date.now() });
			tracked = this.current(sessionId);
		}
		const input = tracked?.input ?? AgentEditorInput.acquire(sessionId, this.instantiationService);
		await input.ensureLoaded();
		return input;
	}

	/** Loads the chat (keeping it loaded while `connectionId` holds it) and returns its transcript. */
	async open(sessionId: string, connectionId: number): Promise<ISessionState> {
		this.markOpened(connectionId, sessionId, true);
		const input = await this.inputFor(sessionId);
		const held = this.held.get(sessionId);
		if (held) {
			held.holders.add(connectionId);
			held.lastUsed = Date.now();
		}
		this.trim();
		// Bring every client to the current state first; then this one starts at the same revision.
		this.flush(sessionId);
		const patcher = this.patcherFor(sessionId, input.messages);
		const last = input.messages.at(-1);
		return {
			id: sessionId,
			rev: patcher.rev,
			messages: this.wireMessages(input.messages),
			...(input.contextUsed !== undefined ? { contextUsed: input.contextUsed } : {}),
			...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
			running: last?.kind === 'agent' && !!last.activity?.streaming,
		};
	}

	/** The connections that have the chat open now. */
	holders(sessionId: string): ReadonlySet<number> {
		return this.held.get(sessionId)?.holders ?? NO_HOLDERS;
	}

	close(sessionId: string, connectionId: number): void {
		this.markOpened(connectionId, sessionId, false);
		const held = this.held.get(sessionId);
		if (held) {
			held.holders.delete(connectionId);
			held.lastUsed = Date.now();
			this.trim();
		}
	}

	private markOpened(connectionId: number, sessionId: string, open: boolean): void {
		let chats = this.opened.get(connectionId);
		if (open) {
			if (!chats) {
				chats = new Set();
				this.opened.set(connectionId, chats);
			}
			chats.add(sessionId);
		} else if (chats?.delete(sessionId) && !chats.size) {
			this.opened.delete(connectionId);
		}
	}

	/** Only these connections are still there: the others no longer hold or show any chat. */
	releaseExcept(live: ReadonlySet<number>): void {
		this.connections = new Set(live);
		for (const shows of [this.watching, this.opened]) {
			for (const connectionId of [...shows.keys()]) {
				if (!live.has(connectionId)) {
					shows.delete(connectionId);
				}
			}
		}
		for (const held of this.held.values()) {
			for (const holder of [...held.holders]) {
				if (!live.has(holder)) {
					held.holders.delete(holder);
				}
			}
		}
		this.trim();
	}

	skipCurrentRun(sessionId: string): void {
		this.current(sessionId)?.input.controller.skipCurrentRun();
	}

	/**
	 * A window cut the transcript before the message with `messageId` (an edited or retried prompt,
	 * a rewind). The window also tells the runtime how many prompts are left.
	 */
	async truncate(sessionId: string, messageId: string): Promise<void> {
		const input = await this.inputFor(sessionId);
		const messages = input.messages;
		const index = messages.findIndex(message => message.id === messageId && message.kind === 'user');
		const stub: IAgentUserMessage = { kind: 'user', id: messageId, text: '' };
		const removed = index >= 0 ? messages[index] : stub;
		if (index >= 0) {
			messages.splice(index);
		}
		input.recordTruncate(removed);
		this.flush(sessionId);
		this.trim();
	}

	/**
	 * A window changed a reply itself (stopped it, edited its plan): the server's copy takes the
	 * window's and records it, so it is the one every client and the history see.
	 */
	async recordAssistant(sessionId: string, message: IAgentAssistantMessage, final: boolean, status: AgentSessionStatus): Promise<void> {
		const input = await this.inputFor(sessionId);
		const index = input.messages.findIndex(candidate => candidate.kind === 'agent' && candidate.id === message.id);
		const target = index >= 0 ? reconcile(input.messages[index], message) as IAgentAssistantMessage : message;
		if (index >= 0) {
			input.messages[index] = target;
		}
		input.recordAssistant(target, final, status, agentMessagePlainText(target));
		this.flush(sessionId);
		this.trim();
	}

	/** Lets go of chats nobody holds, oldest first, beyond the cap; never one that is running. */
	private trim(): void {
		const idle = [...this.held.entries()]
			.filter(([, held]) => !held.holders.size && !held.input.controller.isRunning)
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		while (this.held.size > MAX_HELD && idle.length) {
			const [sessionId, held] = idle.shift()!;
			this.held.delete(sessionId);
			held.input.dispose();
		}
	}

	//#endregion
}

/** Where the current turn starts: its prompt. A streaming reply (steers included) comes after it. */
function currentTurnStart(messages: readonly IAgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].kind === 'user') {
			return i;
		}
	}
	return 0;
}
