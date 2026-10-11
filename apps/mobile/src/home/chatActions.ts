/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltClient } from '@volt/client-core';
import type { ISheetAction } from '../ui/sheets';

export interface IChatActionTarget {
	readonly id: string;
	readonly pinned: boolean;
	readonly unread: boolean;
	readonly settled: boolean;
	readonly snoozed: boolean;
	readonly archived: boolean;
}

/** Every action on a chat, for the list's long press and the chat's details sheet. */
export function chatActions(client: VoltClient, chat: IChatActionTarget, handlers: { readonly rename: () => void; readonly remove: () => void }): ISheetAction[] {
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(8, 0, 0, 0);
	return [
		{ label: chat.pinned ? 'Unpin' : 'Pin', icon: 'pin', onPress: () => void client.setPinned(chat.id, !chat.pinned) },
		{ label: 'Rename', icon: 'pencil', onPress: handlers.rename },
		{ label: chat.unread ? 'Mark as read' : 'Mark as unread', icon: 'dot', onPress: () => chat.unread ? client.markRead(chat.id) : void client.markUnread(chat.id) },
		{ label: chat.settled ? 'Unsettle' : 'Settle', detail: chat.settled ? undefined : 'Move it out of the way until it needs you', icon: 'inbox', onPress: () => void client.setSettled(chat.id, !chat.settled) },
		...(chat.snoozed
			? [{ label: 'Wake', icon: 'sun' as const, onPress: () => void client.wake(chat.id) }]
			: [
				{ label: 'Snooze for 3 hours', icon: 'moon' as const, onPress: () => void client.snooze(chat.id, Date.now() + 3 * 3_600_000) },
				{ label: 'Snooze until tomorrow', icon: 'snooze' as const, onPress: () => void client.snooze(chat.id, tomorrow.getTime()) },
			]),
		{ label: chat.archived ? 'Unarchive' : 'Archive', icon: 'archive', onPress: () => void client.setArchived(chat.id, !chat.archived) },
		{ label: 'Delete', icon: 'trash', destructive: true, onPress: handlers.remove },
	];
}
