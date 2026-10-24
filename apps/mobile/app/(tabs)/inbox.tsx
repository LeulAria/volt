/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { ChatRow } from '../../src/home/ChatRow';
import { OfflineBanner } from '../../src/home/Connection';
import { INBOX_FILTERS, type InboxFilter, inboxItems } from '../../src/home/inbox';
import { openChat, useChatMenu } from '../../src/home/useChatMenu';
import { useChatItems, useClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { EmptyState, IconButton } from '../../src/ui/core';
import { LargeHeader } from '../../src/ui/header';
import { Chips } from '../../src/ui/rows';

const EMPTY: Record<InboxFilter, { title: string; body: string }> = {
	all: { title: 'All caught up', body: 'Chats that need you, finish or fail show up here.' },
	needs: { title: 'Nothing needs you', body: 'Approvals and questions from your agents show up here.' },
	unread: { title: 'No unread chats', body: 'Replies that finished while you were away show up here.' },
	working: { title: 'Nothing running', body: 'Chats show up here while their agents work.' },
	failed: { title: 'No failures', body: 'Chats whose last run failed show up here.' },
};

/** The Inbox: the GitHub app's notifications, for chats. Opening one marks it read. */
export default function Inbox() {
	const { p } = useTheme();
	const client = useClient();
	const items = useChatItems();
	const menu = useChatMenu();
	const [filter, setFilter] = useState<InboxFilter>('all');
	const list = useMemo(() => inboxItems(items, filter), [items, filter]);
	const options = useMemo(() => INBOX_FILTERS.map(option => {
		const n = option.id === 'all' ? 0 : inboxItems(items, option.id).length;
		return { ...option, count: n || undefined, attention: option.id === 'needs' };
	}), [items]);
	const unread = items.some(item => item.unread);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader title="Inbox" right={unread ? <IconButton icon="listChecks" label="Mark all as read" color={p.fg} onPress={() => void client.markAllRead()} /> : undefined} />
			<FlatList
				data={list}
				keyExtractor={item => item.id}
				contentContainerStyle={{ paddingBottom: 32 }}
				ListHeaderComponent={<View style={{ gap: 6, paddingBottom: 6 }}><OfflineBanner /><Chips value={filter} options={options} onChange={setFilter} /></View>}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 50 }} />}
				renderItem={({ item }) => <ChatRow item={item} onPress={openChat} onLongPress={menu.show} />}
				ListEmptyComponent={<EmptyState icon="inbox" title={EMPTY[filter].title} body={EMPTY[filter].body} />}
			/>
			{menu.sheets}
		</View>
	);
}
