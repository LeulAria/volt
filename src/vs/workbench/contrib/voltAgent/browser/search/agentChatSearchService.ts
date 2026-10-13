/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentHistoryService, IAgentSessionTranscript } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { ChatSearchIndex, IChatContentHit, IChatSearchTurnText, normalizeSearchText } from '../../common/agentChatSearch.js';

export const SEARCH_AGENT_CHATS_COMMAND_ID = 'voltAgent.searchChats';

export interface IAgentChatSearchProgress {
	/** Chats whose prompts and replies are searchable. */
	readonly indexed: number;
	readonly total: number;
	readonly building: boolean;
}

export const IAgentChatSearchService = createDecorator<IAgentChatSearchService>('agentChatSearchService');

/**
 * What every chat said, searchable. The index is built the first time someone searches, newest
 * chats first, a few at a time between frames, and kept current while a search is open: a chat that
 * moved on since is read again, a deleted one dropped. After that a query is a few milliseconds.
 */
export interface IAgentChatSearchService {
	readonly _serviceBrand: undefined;
	/** Fires as chats are indexed and as texts for snippets load: the same query may now find more. */
	readonly onDidChange: Event<void>;
	readonly progress: IAgentChatSearchProgress;
	/** Brings the index up to date and keeps it so while the returned disposable lives. */
	watch(): IDisposable;
	search(query: string, limit: number): IChatContentHit[];
	/** Reads chats whose hits came back without a snippet; {@link onDidChange} fires once they are in. */
	loadTexts(ids: readonly string[]): void;
	readonly loadingTexts: boolean;
}

/** Chats read at once while indexing. */
const READERS = 4;
/** Indexing yields to the UI after this much work. */
const SLICE_MS = 12;
/** Chats whose turn texts stay in memory for snippets. */
const TEXT_CACHE = 64;
const TEXT_CHARS = 20_000;
/** A chat that changes while a search is open is read again after this. */
const CATCH_UP_MS = 1500;

function sourceTurns(transcript: IAgentSessionTranscript | undefined): IChatSearchTurnText[] {
	return transcript?.turns.map(turn => ({ id: turn.id, user: turn.user.text ?? '', agent: turn.assistant?.text ?? '' })) ?? [];
}

export class AgentChatSearchService extends Disposable implements IAgentChatSearchService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly index = new ChatSearchIndex();
	/** Normalized turn texts of recently read chats, least recently read first. */
	private readonly texts = new Map<string, { readonly updatedAt: number; readonly turns: readonly IChatSearchTurnText[] }>();
	private readonly loading = new Set<string>();
	private readonly changed = this._register(new RunOnceScheduler(() => this._onDidChange.fire(), 80));
	private readonly catchUp = this._register(new RunOnceScheduler(() => this.sync(), CATCH_UP_MS));
	private watchers = 0;
	private stale = true;
	private building: Promise<void> | undefined;
	private indexed = 0;
	private total = 0;

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(history.onDidChange(() => {
			this.stale = true;
			if (this.watchers) {
				this.catchUp.schedule();
			}
		}));
	}

	get progress(): IAgentChatSearchProgress {
		return { indexed: this.indexed, total: this.total, building: !!this.building };
	}

	get loadingTexts(): boolean {
		return this.loading.size > 0;
	}

	watch(): IDisposable {
		this.watchers++;
		this.sync();
		let released = false;
		return toDisposable(() => {
			if (!released) {
				released = true;
				this.watchers--;
			}
		});
	}

	search(query: string, limit: number): IChatContentHit[] {
		return this.index.search(query, { limit, now: Date.now(), texts: id => this.textsFor(id) });
	}

	loadTexts(ids: readonly string[]): void {
		for (const id of ids) {
			if (this.loading.has(id) || this.textsFor(id)) {
				continue;
			}
			this.loading.add(id);
			void this.read(id).then(transcript => {
				const meta = this.history.get(id);
				if (!transcript || !meta) {
					return;
				}
				// Index the text the snippet comes from, so the hit and its snippet agree.
				const turns = sourceTurns(transcript);
				this.index.set({ id, updatedAt: meta.updatedAt, turns });
				this.remember(id, meta.updatedAt, turns);
			}).finally(() => {
				this.loading.delete(id);
				this.changed.schedule();
			});
		}
	}

	private sync(): void {
		if (this.building || !this.stale || this._store.isDisposed) {
			return;
		}
		this.building = this.build()
			.catch(err => this.logService.error('[volt chat search] indexing failed', err))
			.finally(() => {
				this.building = undefined;
				this._onDidChange.fire();
				if (this.stale && this.watchers) {
					this.catchUp.schedule();
				}
			});
	}

	private async build(): Promise<void> {
		await this.history.whenReady;
		this.stale = false;
		const sessions = this.history.list({ includeArchived: true })
			.filter(meta => !meta.subagent && meta.turnCount > 0)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const live = new Set(sessions.map(meta => meta.id));
		for (const id of this.index.ids()) {
			if (!live.has(id)) {
				this.index.delete(id);
				this.texts.delete(id);
			}
		}
		const todo = sessions.filter(meta => !this.index.has(meta.id, meta.updatedAt));
		this.total = sessions.length;
		this.indexed = this.total - todo.length;
		if (!todo.length) {
			return;
		}
		this.changed.schedule();
		let next = 0;
		let sliceStart = Date.now();
		const reader = async () => {
			while (next < todo.length && !this._store.isDisposed) {
				const meta = todo[next++];
				const turns = sourceTurns(await this.read(meta.id));
				this.index.set({ id: meta.id, updatedAt: meta.updatedAt, turns });
				// The newest chats are read first: theirs are the texts worth keeping for snippets.
				if (this.texts.size < TEXT_CACHE || this.texts.has(meta.id)) {
					this.remember(meta.id, meta.updatedAt, turns);
				}
				this.indexed++;
				if (!this.changed.isScheduled()) {
					this.changed.schedule();
				}
				if (Date.now() - sliceStart > SLICE_MS) {
					await timeout(0);
					sliceStart = Date.now();
				}
			}
		};
		await Promise.all(Array.from({ length: READERS }, () => reader()));
	}

	private async read(id: string): Promise<IAgentSessionTranscript | undefined> {
		try {
			return await this.history.readTranscript(id);
		} catch (err) {
			this.logService.warn(`[volt chat search] could not read chat ${id}`, err);
			return undefined;
		}
	}

	private textsFor(id: string): readonly IChatSearchTurnText[] | undefined {
		const entry = this.texts.get(id);
		return entry && this.index.has(id, entry.updatedAt) ? entry.turns : undefined;
	}

	private remember(id: string, updatedAt: number, turns: readonly IChatSearchTurnText[]): void {
		this.texts.delete(id);
		this.texts.set(id, {
			updatedAt,
			turns: turns.map(turn => ({ id: turn.id, user: normalizeSearchText(turn.user, TEXT_CHARS), agent: normalizeSearchText(turn.agent, TEXT_CHARS) })),
		});
		for (const oldest of this.texts.keys()) {
			if (this.texts.size <= TEXT_CACHE) {
				break;
			}
			this.texts.delete(oldest);
		}
	}
}

registerSingleton(IAgentChatSearchService, AgentChatSearchService, InstantiationType.Delayed);
