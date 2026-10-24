/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildChatSections, chatCounts, type IChatListItem, type IChatSection, selectProjects } from '@volt/client-core';
import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, RefreshControl, SectionList, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatRow } from '../src/home/ChatRow';
import { chatActions } from '../src/home/chatActions';
import { ConnectionPill, OfflineBanner } from '../src/home/Connection';
import { useChatItems, useClient, useCollections, useOptionalClient } from '../src/state/client';
import { useActiveEnvironment } from '../src/state/environments';
import { useTheme } from '../src/theme/theme';
import { Button, EmptyState, haptic, Icon, IconButton, Pill, T, Tap, VoltMark } from '../src/ui/core';
import { ActionSheet, ConfirmSheet, InputSheet, type ISheetAction } from '../src/ui/sheets';

export default function Home() {
	const environment = useActiveEnvironment();
	const client = useOptionalClient();
	if (!environment) {
		return <Welcome />;
	}
	if (!client) {
		return <Loading />;
	}
	return <ChatList />;
}

function Loading() {
	const { p } = useTheme();
	return (
		<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
			<Stack.Screen options={{ headerShown: false }} />
			<ActivityIndicator color={p.fgTertiary} />
		</View>
	);
}

function Welcome() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	return (
		<View style={{ flex: 1, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}>
			<Stack.Screen options={{ headerShown: false }} />
			<Animated.View entering={FadeIn.duration(400)} style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
				<VoltMark size={64} style={{ shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 10 } }} />
				<T variant="display" weight="800" style={{ letterSpacing: -1, marginTop: 8 }}>Your agents,{'\n'}in your pocket.</T>
				<T variant="callout" color={p.fgTertiary}>Pair with Volt on your computer to follow every chat live, answer questions, approve commands and start new work from anywhere.</T>
				<View style={{ gap: 14, marginTop: 18 }}>
					{([
						['laptop', 'In Volt, run Pair a Phone or Browser…'],
						['qr', 'Scan the code it shows'],
						['zap', 'Chats keep running on your computer'],
					] as const).map(([icon, text]) => (
						<View key={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
							<View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}>
								<Icon name={icon} size={18} color={p.fgSecondary} />
							</View>
							<T variant="body" color={p.fgSecondary} style={{ flex: 1 }}>{text}</T>
						</View>
					))}
				</View>
			</Animated.View>
			<View style={{ gap: 10 }}>
				<Button label="Scan pairing code" icon="qr" variant="primary" size="lg" onPress={() => router.push('/connect')} />
				<Button label="Enter code instead" variant="ghost" onPress={() => router.push({ pathname: '/connect', params: { manual: '1' } })} />
			</View>
		</View>
	);
}

function ChatList() {
	const { p } = useTheme();
	const client = useClient();
	const insets = useSafeAreaInsets();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [query, setQuery] = useState('');
	const [archived, setArchived] = useState(false);
	const [projectId, setProjectId] = useState<string | undefined>();
	const [openShelves, setOpenShelves] = useState<Record<string, boolean>>({});
	const [menuFor, setMenuFor] = useState<IChatListItem | undefined>();
	const [renaming, setRenaming] = useState<IChatListItem | undefined>();
	const [deleting, setDeleting] = useState<IChatListItem | undefined>();
	const [projectSheet, setProjectSheet] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const sections = useMemo(() => buildChatSections(items, { query, archived, ...(projectId ? { projectId } : {}) }), [items, query, archived, projectId]);
	const counts = useMemo(() => chatCounts(items), [items]);
	const data = useMemo(() => sections.map(section => ({ ...section, data: section.shelf && !openShelves[section.key] && !query ? [] : section.items as IChatListItem[] })), [sections, openShelves, query]);
	const project = projects.find(pr => pr.id === projectId);

	const open = useCallback((item: IChatListItem) => router.push({ pathname: '/chat/[id]', params: { id: item.id } }), []);
	const longPress = useCallback((item: IChatListItem) => setMenuFor(item), []);

	const projectActions: ISheetAction[] = [
		{ label: 'All projects', icon: 'layers', checked: !projectId, onPress: () => setProjectId(undefined) },
		...projects.map(pr => ({ label: pr.name, detail: `${pr.chats} chats`, icon: 'folder' as const, checked: pr.id === projectId, onPress: () => setProjectId(pr.id) })),
	];

	return (
		<View style={{ flex: 1 }}>
			<Stack.Screen options={{
				title: 'Volt',
				headerLargeTitle: Platform.OS === 'ios',
				headerTransparent: Platform.OS === 'ios',
				headerBlurEffect: p.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight',
				headerLargeStyle: { backgroundColor: p.canvas },
				headerLeft: () => <ConnectionPill />,
				headerRight: () => (
					<View style={{ flexDirection: 'row' }}>
						<IconButton icon="folder" label="Files" onPress={() => router.push('/files')} color={p.fg} />
						<IconButton icon="settings" label="Settings" onPress={() => router.push('/settings')} color={p.fg} />
					</View>
				),
				...(Platform.OS === 'ios' ? {
					headerSearchBarOptions: {
						placeholder: 'Search chats',
						onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
						onCancelButtonPress: () => setQuery(''),
						hideWhenScrolling: true,
					},
				} : {}),
			}} />
			<SectionList
				sections={data}
				keyExtractor={item => item.id}
				contentInsetAdjustmentBehavior="automatic"
				stickySectionHeadersEnabled={false}
				keyboardDismissMode="on-drag"
				contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					haptic.light();
					client.reconnect();
					setTimeout(() => setRefreshing(false), 900);
				}} />}
				ListHeaderComponent={
					<View style={{ gap: 10, paddingBottom: 4 }}>
						<OfflineBanner />
						{Platform.OS !== 'ios' ? (
							<View style={{ marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, paddingHorizontal: 12, borderRadius: 12, backgroundColor: p.fill }}>
								<Icon name="search" size={16} color={p.fgTertiary} />
								<TextInput value={query} onChangeText={setQuery} placeholder="Search chats" placeholderTextColor={p.fgQuaternary} style={{ flex: 1, color: p.fg, fontSize: 16 }} />
							</View>
						) : null}
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 }}>
							<FilterTab label="Chats" on={!archived} count={counts.attention || undefined} attention={counts.attention > 0} onPress={() => setArchived(false)} />
							<FilterTab label="Archived" on={archived} onPress={() => setArchived(true)} />
							<View style={{ flex: 1 }} />
							<Pill label={project?.name ?? 'All projects'} icon="filter" onPress={() => setProjectSheet(true)} bg={projectId ? p.fillStrong : 'transparent'} color={projectId ? p.fg : p.fgTertiary} />
						</View>
					</View>
				}
				renderSectionHeader={({ section }) => <SectionHeader section={section as IChatSection} open={!!openShelves[section.key] || !!query} onToggle={() => setOpenShelves(s => ({ ...s, [section.key]: !s[section.key] }))} />}
				renderItem={({ item }) => <ChatRow item={item} onPress={open} onLongPress={longPress} />}
				ListEmptyComponent={
					<EmptyState
						icon={query ? 'search' : archived ? 'archive' : 'message'}
						title={query ? 'No chats match' : archived ? 'Nothing archived' : 'No chats yet'}
						body={query ? undefined : archived ? 'Archived chats show up here.' : `Start one here, or in Volt on ${client.environment.label}.`}
						action={!query && !archived ? <Button label="New chat" icon="compose" variant="primary" onPress={() => router.push('/new')} /> : undefined}
					/>
				}
			/>
			<View style={{ position: 'absolute', right: 18, bottom: insets.bottom + 18 }}>
				<Tap haptics="medium" onPress={() => router.push('/new')} accessibilityLabel="New chat" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 52, paddingHorizontal: 20, borderRadius: 26, backgroundColor: p.primary, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 }}>
					<Icon name="compose" size={19} color={p.onPrimary} />
					<T variant="callout" weight="700" color={p.onPrimary}>New chat</T>
				</Tap>
			</View>
			<ActionSheet visible={!!menuFor} onClose={() => setMenuFor(undefined)} title={menuFor?.title} subtitle={menuFor?.projectName}
				actions={menuFor ? [{ label: 'Open', icon: 'message', onPress: () => open(menuFor) }, ...chatActions(client, menuFor, { rename: () => setRenaming(menuFor), remove: () => setDeleting(menuFor) })] : []} />
			<ActionSheet visible={projectSheet} onClose={() => setProjectSheet(false)} title="Show chats from" actions={projectActions} />
			<InputSheet visible={!!renaming} onClose={() => setRenaming(undefined)} title="Rename chat" initial={renaming?.title} onSubmit={title => renaming && void client.rename(renaming.id, title)} />
			<ConfirmSheet visible={!!deleting} onClose={() => setDeleting(undefined)} title="Delete this chat?" body="Its transcript is removed from Volt on your computer. This can't be undone." confirm="Delete" destructive onConfirm={() => deleting && void client.deleteChat(deleting.id)} />
		</View>
	);
}

function FilterTab({ label, on, count, attention, onPress }: { readonly label: string; readonly on: boolean; readonly count?: number; readonly attention?: boolean; readonly onPress: () => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: on ? p.fillStrong : 'transparent' }}>
			<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgTertiary}>{label}</T>
			{count ? (
				<View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: attention ? p.warning : p.fillStrong, alignItems: 'center', justifyContent: 'center' }}>
					<T variant="caption" weight="700" color={attention ? '#111' : p.fgSecondary}>{count}</T>
				</View>
			) : null}
		</Tap>
	);
}

function SectionHeader({ section, open, onToggle }: { readonly section: IChatSection; readonly open: boolean; readonly onToggle: () => void }) {
	const { p } = useTheme();
	return (
		<Tap disabled={!section.shelf} haptics="selection" onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
			<T variant="footnote" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.3 }}>{section.title}</T>
			{section.shelf ? (
				<>
					<T variant="footnote" color={p.fgQuaternary}>{section.items.length}</T>
					<View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={12} color={p.fgQuaternary} /></View>
				</>
			) : null}
			<View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 6 }} />
		</Tap>
	);
}
