/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ISessionPatch, ISessionState, reconcile, SessionTopicData } from '../../../../../platform/voltAgentServer/common/sessionPatch.js';
import { fromWire } from '../../../../../platform/voltAgentServer/common/wire.js';
import { IAgentServerClientService } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import type { IAgentAssistantMessage, IAgentMessage } from './agentEditor.js';
import { IAgentSessionChange, IAgentSessionControl, IAgentSessionHost, IAgentTurnSpec, markReplyStopped } from './agentSessionController.js';

/**
 * Folds and expanded blocks are this window's: a patch for a streaming reply must not close what
 * the reader opened. The server's values fill in what the reader never touched.
 */
export function reconcileKeepingViewState(target: IAgentMessage, source: IAgentMessage): IAgentMessage {
	const blockState = target.kind === 'agent' ? { ...target.blockState } : undefined;
	const promptExpanded = target.kind === 'user' ? target.promptExpanded : undefined;
	const result = reconcile(target, source) as IAgentMessage;
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
	return result;
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
 * in-process controller would. Stop, truncate and skip go to the server.
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

	constructor(
		private host: IAgentSessionHost,
		@IAgentServerClientService private readonly client: IAgentServerClientService,
	) {
		super();
		this._register(client.onSessionEvent(data => this.onSessionEvent(data)));
		this._register(client.onDidResync(() => {
			if (this.rev >= 0) {
				void this.reopen();
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
				if (this.rev < 0 || data.rev <= this.rev) {
					return;
				}
				if (data.rev !== this.rev + 1 || !this.applyTo(this.host.messages, data)) {
					void this.reopen();
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

	stopReply(): boolean {
		// Shown as stopped right away; the server's copy follows and its patch confirms it.
		if (!markReplyStopped(this.host.messages.at(-1))) {
			return false;
		}
		this.client.send('session.stop', this.host.sessionId);
		this._onDidChange.fire({ kind: 'render' });
		return true;
	}

	truncate(removed: IAgentMessage | undefined, userTurns: number): void {
		this.client.send('session.truncate', this.host.sessionId, removed?.id, userTurns);
	}
}
