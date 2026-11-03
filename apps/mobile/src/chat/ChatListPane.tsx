/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IChatListItem, relativeTime, statusColor } from '@volt/client-core';
import { router } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { SectionList, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatItems } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, IconButton, LiveTimer, StatusIcon, T } from '../ui/core';
import { ListItem, SectionHeader } from '../ui/list';
import { SearchField } from '../ui/SearchField';

interface IPaneSection {
	readonly key: string;
	readonly title: string;
	readonly data: readonly IChatListItem[];
}

/** How many of the latest chats the pane lists under Recent. */
const RECENT = 40;

/**
 * The chat list beside an open chat on a wide window (an open iPhone Duo or fold, a tablet), as
 * Mail and the desktop's agents sidebar keep theirs: search, what needs you or is working, pinned,
 * then the latest. Picking one swaps the chat on the right in place; this list keeps its scroll.
 */
export const ChatListPane = memo(function ChatListPane({ chatId, width }: { readonly chatId: string; readonly width: number }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const items = useChatItems();
	const [query, setQuery] = useState('');

	const sections = useMemo<IPaneSection[]>(() => {
		const q = query.trim().toLowerCase();
		const live = items.filter(item => !item.archived && (!q || `${item.title} ${item.projectName ?? ''} ${item.branch ?? ''}`.toLowerCase().includes(q)));
		if (q) {
			return live.length ? [{ key: 'results', title: 'Results', data: live }] : [];
		}
		const now = live.filter(item => item.status !== 'idle' && item.status !== 'unread' && item.status !== 'stopped');
		const pinned = live.filter(item => item.pinned && !now.includes(item));
		const shown = new Set([...now, ...pinned].map(item => item.id));
		const recent = live.filter(item => !shown.has(item.id) && !item.snoozed).slice(0, RECENT);
		return [
			...(now.length ? [{ key: 'now', title: 'Needs you or working', data: now }] : []),
			...(pinned.length ? [{ key: 'pinned', title: 'Pinned', data: pinned }] : []),
			...(recent.length ? [{ key: 'recent', title: 'Recent', data: recent }] : []),
		];
	}, [items, query]);

	const pick = (item: IChatListItem) => {
		if (item.id !== chatId) {
			haptic.selection();
			router.setParams({ id: item.id });
		}
	};

	return (
		<Animated.View entering={FadeIn.duration(220)} style={{ width, backgroundColor: p.canvas, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: p.stroke, paddingTop: insets.top, paddingLeft: insets.left }}>
			<View style={styles.bar}>
				<IconButton icon="chevronLeft" label="Back" size={25} color={p.fg} onPress={() => router.back()} />
				<T variant="title3" weight="700" numberOfLines={1} style={{ flex: 1, letterSpacing: -0.3 }}>Chats</T>
				<IconButton icon="compose" label="New chat" color={p.fg} onPress={() => router.push('/new')} />
			</View>
			<SearchField value={query} onChange={setQuery} placeholder="Search chats" />
			<SectionList
				sections={sections}
				keyExtractor={item => item.id}
				stickySectionHeadersEnabled={false}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
				renderSectionHeader={({ section }) => <View style={{ paddingTop: 8 }}><SectionHeader title={section.title} /></View>}
				renderItem={({ item }) => <PaneRow item={item} active={item.id === chatId} onPress={pick} />}
				ListEmptyComponent={<T variant="small" color={p.fgTertiary} align="center" style={{ paddingTop: 32 }}>{query.trim() ? 'No chats match.' : 'No chats yet.'}</T>}
			/>
		</Animated.View>
	);
});

/** One chat in the pane: its status, title, where it runs and when; the open one highlighted. */
const PaneRow = memo(function PaneRow({ item, active, onPress }: { readonly item: IChatListItem; readonly active: boolean; readonly onPress: (item: IChatListItem) => void }) {
	const { p } = useTheme();
	const live = item.status !== 'idle' && item.status !== 'unread';
	return (
		<ListItem selected={active} onPress={() => onPress(item)} accessibilityLabel={`${item.title}${item.statusLabel ? `, ${item.statusLabel}` : ''}`} style={{ minHeight: 54, gap: 10, paddingVertical: 8, alignItems: 'flex-start' }}>
			<View style={{ width: 16, alignItems: 'center', paddingTop: 3 }}><StatusIcon status={item.status} size={14} /></View>
			<View style={{ flex: 1, minWidth: 0, gap: 1 }}>
				<T variant="body" weight={item.unread || active ? '600' : '500'} numberOfLines={1} style={{ fontSize: 15 }}>{item.title}</T>
				<T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{[item.projectName, item.branch].filter(Boolean).join(' · ') || item.preview || ' '}</T>
			</View>
			{item.status === 'working' && item.workingSince
				? <LiveTimer since={item.workingSince} color={p.info} />
				: <T variant="footnote" color={live ? statusColor(item.status, p) : p.fgQuaternary}>{live ? item.statusLabel : relativeTime(item.updatedAt)}</T>}
		</ListItem>
	);
});

const styles = StyleSheet.create({
	bar: { height: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 4, paddingRight: 6, gap: 2 },
});
