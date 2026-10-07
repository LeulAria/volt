/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { IAgentSessionLifecycle } from '../../../services/voltRuntime/common/history/agentHistory.js';

/** What the user did to a chat from the sidebar; each one can be undone for a few seconds. */
export type AgentLifecycleAction = 'settle' | 'unsettle' | 'snooze' | 'wake' | 'archive' | 'unarchive' | 'pin' | 'unpin';

/** How long the Undo notice stays after the latest action, as in T3 Code. */
export const AGENT_LIFECYCLE_UNDO_MS = 5_000;

export interface IAgentLifecycleUndoItem {
	readonly sessionId: string;
	readonly title: string;
	/** The chat's lifecycle before the action. */
	readonly previous: IAgentSessionLifecycle;
}

export interface IAgentLifecycleUndoEntry {
	readonly action: AgentLifecycleAction;
	/** Oldest first; one per chat. */
	readonly items: readonly IAgentLifecycleUndoItem[];
	/** The notice, and the undo with it, ends then. */
	readonly expiresAt: number;
}

/**
 * The one Undo the sidebar offers: the latest action, for {@link AGENT_LIFECYCLE_UNDO_MS} after it.
 * Actions of the same kind in a row join it and undo together; another kind replaces it.
 */
export class AgentLifecycleUndoStack {

	private entry: IAgentLifecycleUndoEntry | undefined;

	constructor(private readonly ttl: number = AGENT_LIFECYCLE_UNDO_MS) { }

	record(action: AgentLifecycleAction, item: IAgentLifecycleUndoItem, now: number): IAgentLifecycleUndoEntry {
		const live = this.current(now);
		const items = live?.action === action
			// The same chat twice keeps the state from before the first action: undo goes back to that.
			? live.items.some(existing => existing.sessionId === item.sessionId) ? live.items : [...live.items, item]
			: [item];
		this.entry = { action, items, expiresAt: now + this.ttl };
		return this.entry;
	}

	current(now: number): IAgentLifecycleUndoEntry | undefined {
		if (this.entry && now >= this.entry.expiresAt) {
			this.entry = undefined;
		}
		return this.entry;
	}

	/** The live entry, removed: undoing it twice must not happen. */
	take(now: number): IAgentLifecycleUndoEntry | undefined {
		const entry = this.current(now);
		this.entry = undefined;
		return entry;
	}

	clear(): void {
		this.entry = undefined;
	}
}

/** `Settled "Fix login"`, `Archived 3 chats`: the notice over the Undo button. */
export function lifecycleUndoLabel(entry: Pick<IAgentLifecycleUndoEntry, 'action' | 'items'>): string {
	const count = entry.items.length;
	const title = entry.items[0]?.title || localize('voltAgent.undo.untitled', "New Agent");
	switch (entry.action) {
		case 'settle': return count === 1 ? localize('voltAgent.undo.settled', "Settled \"{0}\"", title) : localize('voltAgent.undo.settledMany', "Settled {0} chats", count);
		case 'unsettle': return count === 1 ? localize('voltAgent.undo.unsettled', "Moved \"{0}\" out of Settled", title) : localize('voltAgent.undo.unsettledMany', "Moved {0} chats out of Settled", count);
		case 'snooze': return count === 1 ? localize('voltAgent.undo.snoozed', "Snoozed \"{0}\"", title) : localize('voltAgent.undo.snoozedMany', "Snoozed {0} chats", count);
		case 'wake': return count === 1 ? localize('voltAgent.undo.woke', "Unsnoozed \"{0}\"", title) : localize('voltAgent.undo.wokeMany', "Unsnoozed {0} chats", count);
		case 'archive': return count === 1 ? localize('voltAgent.undo.archived', "Archived \"{0}\"", title) : localize('voltAgent.undo.archivedMany', "Archived {0} chats", count);
		case 'unarchive': return count === 1 ? localize('voltAgent.undo.unarchived', "Unarchived \"{0}\"", title) : localize('voltAgent.undo.unarchivedMany', "Unarchived {0} chats", count);
		case 'pin': return count === 1 ? localize('voltAgent.undo.pinned', "Pinned \"{0}\"", title) : localize('voltAgent.undo.pinnedMany', "Pinned {0} chats", count);
		case 'unpin': return count === 1 ? localize('voltAgent.undo.unpinned', "Unpinned \"{0}\"", title) : localize('voltAgent.undo.unpinnedMany', "Unpinned {0} chats", count);
		default: {
			const unexpected: never = entry.action;
			return unexpected;
		}
	}
}
