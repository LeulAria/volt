/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAgentHistoryService, IAgentSessionMeta, sessionLifecycle } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { AgentLifecycleAction, AgentLifecycleUndoStack, IAgentLifecycleUndoEntry } from '../../common/agentLifecycleUndo.js';

/** True while the sidebar shows an Undo notice; Cmd+Z runs it then. */
export const AgentLifecycleUndoContext = new RawContextKey<boolean>('voltAgentLifecycleUndo', false, localize('voltAgent.lifecycleUndoContext', "Whether the agent sidebar offers to undo the last settle, snooze, archive or pin."));

export const AGENT_LIFECYCLE_UNDO_COMMAND_ID = 'volt.agent.undoLifecycle';

export const IAgentThreadLifecycleService = createDecorator<IAgentThreadLifecycleService>('agentThreadLifecycleService');

/**
 * Settle, snooze, archive and pin as the sidebar does them: each records the chat's state before,
 * so the notice it shows (and Cmd+Z) can put it back for a few seconds.
 */
export interface IAgentThreadLifecycleService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeNotice: Event<void>;
	/** The Undo on offer, if any. */
	readonly notice: IAgentLifecycleUndoEntry | undefined;

	/** Un-settling here is by hand: automatic settling holds off until the user's next prompt. */
	setSettled(sessionId: string, settled: boolean): Promise<void>;
	/** `until` absent with `snoozed`: until woken by hand. */
	setSnoozed(sessionId: string, snoozed: boolean, until?: number): Promise<void>;
	setArchived(sessionId: string, archived: boolean): Promise<void>;
	setPinned(sessionId: string, pinned: boolean): Promise<void>;
	/** Undoes the notice's actions. False when nothing was on offer. */
	undo(): Promise<boolean>;
	dismiss(): void;
}

export class AgentThreadLifecycleService extends Disposable implements IAgentThreadLifecycleService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeNotice = this._register(new Emitter<void>());
	readonly onDidChangeNotice = this._onDidChangeNotice.event;

	private readonly stack = new AgentLifecycleUndoStack();
	private readonly expiry = this._register(new RunOnceScheduler(() => this.sync(), 0));
	private readonly undoAvailable: IContextKey<boolean>;

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.undoAvailable = AgentLifecycleUndoContext.bindTo(contextKeyService);
	}

	get notice(): IAgentLifecycleUndoEntry | undefined {
		return this.stack.current(Date.now());
	}

	setSettled(sessionId: string, settled: boolean): Promise<void> {
		return this.run(sessionId, settled ? 'settle' : 'unsettle', meta => !!meta.settled !== settled, () => this.history.setSettled(sessionId, settled, { byUser: true }));
	}

	setSnoozed(sessionId: string, snoozed: boolean, until?: number): Promise<void> {
		return this.run(sessionId, snoozed ? 'snooze' : 'wake', meta => snoozed || !!meta.snoozed, () => this.history.setSnoozed(sessionId, snoozed, until));
	}

	setArchived(sessionId: string, archived: boolean): Promise<void> {
		return this.run(sessionId, archived ? 'archive' : 'unarchive', meta => !!meta.archived !== archived, () => this.history.setArchived(sessionId, archived));
	}

	setPinned(sessionId: string, pinned: boolean): Promise<void> {
		return this.run(sessionId, pinned ? 'pin' : 'unpin', meta => !!meta.pinned !== pinned, () => this.history.setPinned(sessionId, pinned));
	}

	async undo(): Promise<boolean> {
		const entry = this.stack.take(Date.now());
		this.sync();
		if (!entry) {
			return false;
		}
		// Newest first, so a chat touched twice ends where it started.
		for (const item of [...entry.items].reverse()) {
			await this.history.restoreLifecycle(item.sessionId, item.previous);
		}
		return true;
	}

	dismiss(): void {
		this.stack.clear();
		this.sync();
	}

	private async run(sessionId: string, action: AgentLifecycleAction, changes: (meta: IAgentSessionMeta) => boolean, apply: () => Promise<void>): Promise<void> {
		const meta = this.history.get(sessionId);
		if (meta && changes(meta)) {
			this.stack.record(action, { sessionId, title: meta.title, previous: sessionLifecycle(meta) }, Date.now());
			this.sync();
		}
		await apply();
	}

	/** Context key and listeners follow the stack; a timer ends the notice when it runs out. */
	private sync(): void {
		const notice = this.notice;
		this.undoAvailable.set(!!notice);
		if (notice) {
			this.expiry.schedule(Math.max(0, notice.expiresAt - Date.now()));
		} else {
			this.expiry.cancel();
		}
		this._onDidChangeNotice.fire();
	}
}

registerSingleton(IAgentThreadLifecycleService, AgentThreadLifecycleService, InstantiationType.Delayed);
