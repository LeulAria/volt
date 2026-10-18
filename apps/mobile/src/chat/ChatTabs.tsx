/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildChatSections, type IChatListItem, relativeTime, statusColor } from '@volt/client-core';
import { router } from 'expo-router';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useChatItems, useClient } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, Icon, LiveTimer, StatusIcon, T, Tap } from '../ui/core';
import { Sheet } from '../ui/sheets';
import { closeRecentChat, useRecentChats } from './recentChats';

export const CHAT_TABS_HEIGHT = 40;

/** Opens another chat in place of this one (the back gesture still returns to the list). */
export function switchToChat(id: string): void {
	haptic.selection();
	router.replace({ pathname: '/chat/[id]', params: { id } });
}

/** How many recent chats stay live (their transcripts open) for quick back and forth. */
const KEEP_LIVE = 3;

/**
 * The chats opened on this phone as tabs under the chat header, like the agent tabs on the
 * desktop: status, title, a close button. The last few stay open so switching back is instant.
 */
export const ChatTabs = memo(function ChatTabs({ chatId }: { readonly chatId: string }) {
	const { p } = useTheme();
	const client = useClient();
	const recent = useRecentChats();
	const items = useChatItems();
	const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
	const tabs = useMemo(() => recent.filter(id => id === chatId || byId.has(id)), [recent, byId, chatId]);
	const scroll = useRef<ScrollView>(null);

	useEffect(() => {
		const holds = tabs.slice(0, KEEP_LIVE).filter(id => id !== chatId).map(id => client.retainTranscript(id));
		return () => holds.forEach(release => release());
	}, [client, tabs, chatId]);

	if (tabs.length < 2) {
		return null;
	}
	return (
		<ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} style={{ height: CHAT_TABS_HEIGHT }} contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: 12 }}>
			{tabs.map(id => {
				const item = byId.get(id);
				const active = id === chatId;
				return (
					<Tap
						key={id}
						haptics="selection"
						onPress={() => !active && switchToChat(id)}
						onLongPress={() => {
							haptic.medium();
							closeRecentChat(id);
						}}
						accessibilityLabel={`${item?.title ?? 'Chat'}${item?.statusLabel ? `, ${item.statusLabel}` : ''}`}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, maxWidth: 190, paddingLeft: 10, paddingRight: active ? 10 : 4, borderRadius: 9, backgroundColor: active ? p.fillStrong : p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: active ? p.stroke : 'transparent' }}
					>
						<StatusIcon status={item?.status ?? 'idle'} size={12} />
						<T variant="footnote" weight={active ? '600' : '500'} color={active ? p.fg : p.fgSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>{item?.title ?? 'New chat'}</T>
						{!active ? (
							<Tap haptics="light" hitSlop={8} onPress={() => closeRecentChat(id)} accessibilityLabel="Close tab" style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
								<Icon name="close" size={11} color={p.fgQuaternary} />
							</Tap>
						) : null}
					</Tap>
				);
			})}
		</ScrollView>
	);
});

interface ISwitcherSection {
	readonly key: string;
	readonly title: string;
	readonly items: readonly IChatListItem[];
}

/** Every chat to jump to: search, Pinned, what needs you or is running, then each project's. */
export function ChatSwitcher({ visible, onClose, chatId }: { readonly visible: boolean; readonly onClose: () => void; readonly chatId: string }) {
	const { p } = useTheme();
	const items = useChatItems();
	const [query, setQuery] = useState('');
	useEffect(() => {
		if (!visible) {
			setQuery('');
		}
	}, [visible]);

	const sections = useMemo<ISwitcherSection[]>(() => {
		if (query.trim()) {
			return buildChatSections(items, { query });
		}
		const live = items.filter(item => !item.archived);
		const pinned = live.filter(item => item.pinned);
		const now = live.filter(item => !item.pinned && item.status !== 'idle' && item.status !== 'unread' && item.status !== 'stopped');
		const shown = new Set([...pinned, ...now].map(item => item.id));
		const projects = new Map<string, IChatListItem[]>();
		for (const item of live) {
			if (shown.has(item.id) || item.settled || item.snoozed) {
				continue;
			}
			const key = item.projectName ?? 'No project';
			projects.set(key, [...(projects.get(key) ?? []), item]);
		}
		return [
			...(pinned.length ? [{ key: 'pinned', title: 'Pinned', items: pinned }] : []),
			...(now.length ? [{ key: 'now', title: 'Needs you or working', items: now }] : []),
			...[...projects.entries()].map(([title, list]) => ({ key: `project:${title}`, title, items: list.slice(0, 12) })),
		];
	}, [items, query]);

	return (
		<Sheet visible={visible} onClose={onClose} title="Switch chat">
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, marginHorizontal: 8, marginBottom: 4, paddingHorizontal: 10, borderRadius: 10, backgroundColor: p.fill }}>
				<Icon name="search" size={15} color={p.fgTertiary} />
				<TextInput value={query} onChangeText={setQuery} placeholder="Search chats" placeholderTextColor={p.fgQuaternary} style={{ flex: 1, color: p.fg, fontSize: 15 }} autoCorrect={false} keyboardAppearance={p.scheme} />
			</View>
			{!sections.length ? <T variant="small" color={p.fgTertiary} style={{ padding: 14 }}>No chats match.</T> : null}
			{sections.map(section => (
				<View key={section.key}>
					<T variant="caption" weight="700" color={p.fgTertiary} numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>{section.title}</T>
					{section.items.map(item => (
						<Tap key={item.id} haptics="selection" onPress={() => {
							onClose();
							if (item.id !== chatId) {
								setTimeout(() => switchToChat(item.id), 120);
							}
						}} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: item.id === chatId ? p.fill : 'transparent' }}>
							<View style={{ width: 18, alignItems: 'center' }}><StatusIcon status={item.status} size={15} /></View>
							<View style={{ flex: 1, minWidth: 0 }}>
								<T variant="callout" weight={item.unread ? '700' : '500'} numberOfLines={1}>{item.title}</T>
								<T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{[query.trim() || section.key === 'pinned' || section.key === 'now' ? item.projectName : undefined, item.branch].filter(Boolean).join(' · ') || item.preview || ' '}</T>
							</View>
							{item.status === 'working' && item.workingSince
								? <LiveTimer since={item.workingSince} color={p.info} />
								: <T variant="footnote" color={item.status !== 'idle' && item.status !== 'unread' ? statusColor(item.status, p) : p.fgQuaternary}>{item.status !== 'idle' && item.status !== 'unread' ? item.statusLabel : relativeTime(item.updatedAt)}</T>}
						</Tap>
					))}
				</View>
			))}
		</Sheet>
	);
}
