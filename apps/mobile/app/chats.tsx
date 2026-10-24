/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildChatSections, type IChatListItem, type IChatSection, selectProjects } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatRow } from '../src/home/ChatRow';
import { inboxItems } from '../src/home/inbox';
import { openChat, useChatMenu } from '../src/home/useChatMenu';
import { useChatItems, useCollections, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { EmptyState, Icon, IconButton, T, Tap } from '../src/ui/core';
import { Chips } from '../src/ui/rows';
import { ActionSheet, type ISheetAction } from '../src/ui/sheets';

export type ChatsFilter = 'all' | 'needs' | 'working' | 'unread' | 'pinned' | 'archived';

const FILTERS: readonly { readonly id: ChatsFilter; readonly label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'needs', label: 'Needs you' },
	{ id: 'working', label: 'Working' },
	{ id: 'unread', label: 'Unread' },
	{ id: 'pinned', label: 'Pinned' },
	{ id: 'archived', label: 'Archived' },
];

export default function ChatsScreen() {
	return useOptionalClient() ? <Chats /> : null;
}

/**
 * Every chat, grouped as the desktop's agents list groups them (Pinned, Needs you, Working, then
 * by day; Snoozed and Settled folded), with filters, search and a project filter.
 */
function Chats() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const params = useLocalSearchParams<{ filter?: string; search?: string; project?: string }>();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const menu = useChatMenu();
	const [filter, setFilter] = useState<ChatsFilter>(FILTERS.some(f => f.id === params.filter) ? params.filter as ChatsFilter : 'all');
	const [query, setQuery] = useState('');
	const [projectId, setProjectId] = useState<string | undefined>(params.project);
	const [openShelves, setOpenShelves] = useState<Record<string, boolean>>({});
	const [projectSheet, setProjectSheet] = useState(false);
	const project = projects.find(pr => pr.id === projectId);

	const sections = useMemo((): IChatSection[] => {
		const scoped = projectId ? items.filter(item => item.projectId === projectId) : items;
		if (filter === 'all' || filter === 'archived') {
			return buildChatSections(scoped, { query, archived: filter === 'archived' });
		}
		const q = query.trim().toLowerCase();
		const picked = (filter === 'pinned' ? scoped.filter(item => item.pinned && !item.archived) : inboxItems(scoped, filter))
			.filter(item => !q || item.title.toLowerCase().includes(q) || item.preview.toLowerCase().includes(q));
		return picked.length ? [{ key: filter, title: FILTERS.find(f => f.id === filter)!.label, items: picked }] : [];
	}, [items, filter, query, projectId]);
	const data = useMemo(() => sections.map(section => ({ ...section, data: section.shelf && !openShelves[section.key] && !query ? [] : section.items as IChatListItem[] })), [sections, openShelves, query]);

	const projectActions: ISheetAction[] = [
		{ label: 'All projects', icon: 'layers', checked: !projectId, onPress: () => setProjectId(undefined) },
		...projects.map(pr => ({ label: pr.name, detail: `${pr.chats} chats`, icon: 'folder' as const, checked: pr.id === projectId, onPress: () => setProjectId(pr.id) })),
	];

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{
				title: project ? project.name : 'Chats',
				headerRight: () => (
					<View style={{ flexDirection: 'row' }}>
						<IconButton icon="filter" label="Show chats from" color={projectId ? p.accent : p.fg} onPress={() => setProjectSheet(true)} />
						<IconButton icon="compose" label="New chat" color={p.fg} onPress={() => router.push({ pathname: '/new', params: projectId ? { project: projectId } : {} })} />
					</View>
				),
			}} />
			<SectionList
				sections={data}
				keyExtractor={item => item.id}
				stickySectionHeadersEnabled={false}
				keyboardDismissMode="on-drag"
				contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
				ListHeaderComponent={
					<View style={{ paddingTop: 6 }}>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: p.fill, marginHorizontal: 16, marginBottom: 4 }}>
							<Icon name="search" size={16} color={p.fgTertiary} />
							<TextInput value={query} onChangeText={setQuery} autoFocus={params.search === '1'} placeholder="Search chats" placeholderTextColor={p.fgQuaternary} autoCapitalize="none" autoCorrect={false} selectionColor={p.accent} style={{ flex: 1, color: p.fg, fontSize: 16 }} />
						</View>
						<Chips value={filter} options={FILTERS} onChange={setFilter} />
					</View>
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 50 }} />}
				renderSectionHeader={({ section }) => <SectionHeader section={section as IChatSection} open={!!openShelves[section.key] || !!query} onToggle={() => setOpenShelves(s => ({ ...s, [section.key]: !s[section.key] }))} />}
				renderItem={({ item }) => <ChatRow item={item} onPress={openChat} onLongPress={menu.show} />}
				ListEmptyComponent={<EmptyState icon={query ? 'search' : 'message'} title={query ? 'No chats match' : 'No chats here'} />}
			/>
			<ActionSheet visible={projectSheet} onClose={() => setProjectSheet(false)} title="Show chats from" actions={projectActions} />
			{menu.sheets}
		</View>
	);
}

function SectionHeader({ section, open, onToggle }: { readonly section: IChatSection; readonly open: boolean; readonly onToggle: () => void }) {
	const { p } = useTheme();
	return (
		<Tap disabled={!section.shelf} haptics="selection" onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6, backgroundColor: p.canvas }}>
			<T variant="small" weight="700" color={p.fgSecondary}>{section.title}</T>
			<T variant="small" color={p.fgQuaternary}>{section.items.length}</T>
			{section.shelf ? <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={12} color={p.fgQuaternary} /></View> : null}
		</Tap>
	);
}
