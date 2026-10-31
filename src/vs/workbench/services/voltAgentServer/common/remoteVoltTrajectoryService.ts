/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { applyTrajectorySync, ITrajectoryRequest } from '../../voltRuntime/common/harness/trajectory.js';
import { IVoltTrajectoryChat, IVoltTrajectoryService, IVoltTrajectorySyncResult, VOLT_TRAJECTORY_ENABLED_SETTING } from '../../voltRuntime/common/trajectory.js';
import { IAgentServerClientService } from './agentServerClient.js';

/** Chats whose requests this window keeps a copy of; the least recently read go first. */
const MAX_CACHED_CHATS = 6;

interface ICachedChat {
	requests: ITrajectoryRequest[];
	revisions: Record<string, string>;
	fetching: boolean;
	/** The server changed it while a fetch was out. */
	stale: boolean;
}

/**
 * The agent server's trajectories, as the Trajectory panel of this window reads them. The runs
 * (and their recording) happen in the server; this copies the chats the panel shows, fetching
 * only the requests that changed since the last read.
 */
export class RemoteVoltTrajectoryService extends Disposable implements IVoltTrajectoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private chatList: readonly IVoltTrajectoryChat[] = [];
	private chatsFetching = false;
	private chatsStale = false;
	private readonly cache = new Map<string, ICachedChat>();
	/** Labels this window gave the server, so each is sent once. */
	private readonly sentLabels = new Map<string, string>();

	constructor(
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(client.onServerEvent(event => {
			const data = event as { kind?: string; sessionId?: unknown };
			if (data.kind === 'trajectory.changed' && typeof data.sessionId === 'string') {
				this.serverChanged(data.sessionId);
			}
		}));
		this._register(client.onDidResync(() => {
			// A restarted server starts with nothing recorded; a reconnect may have missed changes.
			const shown = [...this.cache.keys()];
			this.cache.clear();
			this.sentLabels.clear();
			this.chatList = [];
			for (const sessionId of shown) {
				// Read again on the redraw.
				this._onDidChange.fire(sessionId);
			}
			void this.refreshChats();
		}));
		void client.whenReady.then(() => this.refreshChats());
	}

	get enabled(): boolean {
		return this.configurationService.getValue<boolean>(VOLT_TRAJECTORY_ENABLED_SETTING) !== false;
	}

	// The runs record in the server.
	begin(): ITrajectoryRequest | undefined {
		return undefined;
	}

	latest(): ITrajectoryRequest | undefined {
		return undefined;
	}

	changed(): void { }

	requests(sessionId: string): readonly ITrajectoryRequest[] {
		let chat = this.cache.get(sessionId);
		if (chat) {
			// Most recently read last.
			this.cache.delete(sessionId);
			this.cache.set(sessionId, chat);
		} else {
			chat = { requests: [], revisions: {}, fetching: false, stale: false };
			this.cache.set(sessionId, chat);
			if (this.cache.size > MAX_CACHED_CHATS) {
				this.cache.delete(this.cache.keys().next().value!);
			}
			void this.fetch(sessionId, chat);
		}
		return chat.requests;
	}

	chats(): readonly IVoltTrajectoryChat[] {
		return this.chatList;
	}

	setLabel(sessionId: string, label: string): void {
		const index = this.chatList.findIndex(chat => chat.sessionId === sessionId);
		// The server keeps labels of chats it has requests for, as the in-process service does.
		if (!label || index < 0 || this.chatList[index].label === label || this.sentLabels.get(sessionId) === label) {
			return;
		}
		this.sentLabels.set(sessionId, label);
		this.chatList = this.chatList.map((chat, i) => i === index ? { ...chat, label } : chat);
		this.client.send('trajectory.setLabel', sessionId, label);
	}

	clear(sessionId: string): void {
		const chat = this.cache.get(sessionId);
		if (chat) {
			chat.requests = [];
			chat.revisions = {};
		}
		this.chatList = this.chatList.filter(candidate => candidate.sessionId !== sessionId);
		this.client.send('trajectory.clear', sessionId);
		this._onDidChange.fire(sessionId);
	}

	private serverChanged(sessionId: string): void {
		const chat = this.cache.get(sessionId);
		if (chat) {
			// The sync brings the chat list along.
			void this.fetch(sessionId, chat);
		} else {
			void this.refreshChats(sessionId);
		}
	}

	private async fetch(sessionId: string, chat: ICachedChat): Promise<void> {
		if (chat.fetching) {
			chat.stale = true;
			return;
		}
		chat.fetching = true;
		try {
			const sync = await this.client.call<IVoltTrajectorySyncResult>('trajectory.sync', sessionId, chat.revisions);
			this.chatList = sync.chats;
			if (this.cache.get(sessionId) !== chat) {
				return;
			}
			chat.requests = applyTrajectorySync(chat.requests, sync);
			// Only the requests held here: one the server sent without its head is asked for whole next time.
			chat.revisions = Object.fromEntries(chat.requests.map(request => [request.id, sync.revisions[request.id]]));
		} catch (err) {
			this.logService.warn(`[volt trajectory] could not read the trajectory of ${sessionId} from the agent server`, err);
		} finally {
			chat.fetching = false;
		}
		if (chat.stale) {
			chat.stale = false;
			return this.fetch(sessionId, chat);
		}
		this._onDidChange.fire(sessionId);
	}

	private async refreshChats(changed?: string): Promise<void> {
		if (this.chatsFetching) {
			this.chatsStale = true;
			return;
		}
		this.chatsFetching = true;
		const before = new Map(this.chatList.map(chat => [chat.sessionId, chat]));
		try {
			this.chatList = await this.client.call<IVoltTrajectoryChat[]>('trajectory.chats');
		} catch (err) {
			this.logService.warn('[volt trajectory] could not list trajectories from the agent server', err);
		} finally {
			this.chatsFetching = false;
		}
		if (this.chatsStale) {
			this.chatsStale = false;
			return this.refreshChats(changed);
		}
		// Chats the panel shows without having read them yet (none on screen) redraw from here.
		const fired = new Set<string>();
		for (const chat of this.chatList) {
			const old = before.get(chat.sessionId);
			if (!this.cache.has(chat.sessionId) && (!old || old.requests !== chat.requests || old.label !== chat.label)) {
				fired.add(chat.sessionId);
			}
		}
		if (changed && !this.cache.has(changed)) {
			fired.add(changed);
		}
		for (const sessionId of fired) {
			this._onDidChange.fire(sessionId);
		}
	}
}
