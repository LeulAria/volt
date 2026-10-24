/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IChatListItem } from '@volt/client-core';

/** The Inbox's filters: everything that wants a look, or one kind of it. */
export type InboxFilter = 'all' | 'needs' | 'unread' | 'working' | 'failed';

export const INBOX_FILTERS: readonly { readonly id: InboxFilter; readonly label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'needs', label: 'Needs you' },
	{ id: 'unread', label: 'Unread' },
	{ id: 'working', label: 'Working' },
	{ id: 'failed', label: 'Failed' },
];

function needsYou(item: IChatListItem): boolean {
	return item.status === 'approval' || item.status === 'question' || item.status === 'limit';
}

function matches(item: IChatListItem, filter: InboxFilter): boolean {
	switch (filter) {
		case 'needs': return needsYou(item);
		case 'unread': return item.unread;
		case 'working': return item.status === 'working' || item.status === 'queued';
		case 'failed': return item.status === 'failed';
		case 'all': return needsYou(item) || item.unread || item.status === 'failed' || item.status === 'working' || item.status === 'queued';
	}
}

/**
 * The Inbox: chats that need an answer, finished while you were away, failed, or are working,
 * as the GitHub app's notifications list them. What needs you comes first, then newest.
 */
export function inboxItems(items: readonly IChatListItem[], filter: InboxFilter): IChatListItem[] {
	return items
		.filter(item => !item.archived && !item.snoozed && matches(item, filter))
		.sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.updatedAt - a.updatedAt);
}

export function inboxCount(items: readonly IChatListItem[], filter: InboxFilter): number {
	return inboxItems(items, filter).length;
}
