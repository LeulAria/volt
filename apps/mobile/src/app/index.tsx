import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { splitModelDisplayName, type IAgentSessionMeta } from '@/core/voltCore';
import { BrandMark } from '@/components/BrandMark';
import { ConnectionDot } from '@/components/ConnectionDot';
import { ChevronDownIcon, GearIcon, NewChatIcon } from '@/components/Icons';
import { SessionRow } from '@/components/SessionRow';
import { Text } from '@/components/Text';
import { useConnectionState, useServerVersion, useTicker, useVolt } from '@/lib/connection';
import { IHomeSection, useHomeSections } from '@/lib/home';
import { colors, radius } from '@/lib/theme';
import type { AgentClientServices } from '@/core/voltCore';

export default function Home() {
	const { pairing, services } = useVolt();
	if (!pairing || !services) {
		return <Redirect href="/pair" />;
	}
	return <HomeList services={services} />;
}

function HomeList({ services }: { readonly services: AgentClientServices }) {
	const insets = useSafeAreaInsets();
	const version = useServerVersion(services);
	const state = useConnectionState(services);
	const working = services.history.list().some(session => session.status === 'running');
	const now = useTicker(working ? 1000 : 30_000);
	const { sections, repos } = useHomeSections(services, version, now);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(['group:Settled']));
	const [refreshing, setRefreshing] = useState(false);

	const open = useCallback((session: IAgentSessionMeta) => {
		void Haptics.selectionAsync();
		router.push({ pathname: '/chat/[id]', params: { id: session.id } });
	}, []);
	const newChat = () => {
		void Haptics.selectionAsync();
		router.push({ pathname: '/chat/[id]', params: { id: 'new' } });
	};
	const refresh = async () => {
		setRefreshing(true);
		if (services.client.connection.state !== 'open') {
			services.client.connection.reconnect();
		}
		await services.client.whenReady;
		setTimeout(() => setRefreshing(false), 400);
	};
	const modelLabel = (session: IAgentSessionMeta) => {
		const label = session.model || services.orchestrator.getThread(session.id)?.modelLabel;
		return label ? splitModelDisplayName(label).name : undefined;
	};
	const visible = sections.map(section => collapsed.has(section.key) ? { ...section, data: [] as IAgentSessionMeta[] } : section);

	return (
		<View style={[styles.screen, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				<BrandMark label size={24} />
				<View style={styles.headerEnd}>
					<ConnectionDot state={state} />
					<Pressable onPress={() => router.push('/settings')} hitSlop={10} accessibilityLabel="Settings" style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
						<GearIcon size={20} />
					</Pressable>
				</View>
			</View>
			<Pressable onPress={newChat} style={({ pressed }) => [styles.newChat, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="New Chat">
				<NewChatIcon size={17} />
				<Text size={14} weight="medium">New Chat</Text>
			</Pressable>
			<SectionList<IAgentSessionMeta, IHomeSection>
				sections={visible}
				keyExtractor={item => item.id}
				stickySectionHeadersEnabled={false}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textTertiary} />}
				renderSectionHeader={({ section }) => (
					<Pressable
						style={styles.sectionHeader}
						onPress={() => setCollapsed(previous => {
							const next = new Set(previous);
							if (!next.delete(section.key)) {
								next.add(section.key);
							}
							return next;
						})}
						accessibilityRole="button"
						accessibilityLabel={`${section.title}, ${collapsed.has(section.key) ? 'collapsed' : 'expanded'}`}
					>
						<View style={collapsed.has(section.key) ? styles.chevronCollapsed : undefined}><ChevronDownIcon size={9} /></View>
						<Text size={11} weight="semibold" color={colors.textTertiary} style={styles.sectionTitle}>{section.title.toUpperCase()}</Text>
						<Text size={11} color={colors.textQuaternary}>{sections.find(s => s.key === section.key)?.data.length}</Text>
					</Pressable>
				)}
				renderItem={({ item }) => <SessionRow session={item} now={now} repos={repos} modelLabel={modelLabel(item)} onPress={open} />}
				ListEmptyComponent={
					<View style={styles.empty}>
						<Text size={13} color={colors.textTertiary} style={styles.center}>{state === 'open' ? 'No chats yet. Start one with New Chat.' : 'Connecting to Volt on your Mac…'}</Text>
					</View>
				}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.sidebar },
	header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, height: 52 },
	headerEnd: { flexDirection: 'row', alignItems: 'center', gap: 14 },
	iconButton: { padding: 4, borderRadius: radius.sm },
	pressed: { backgroundColor: colors.pressed },
	newChat: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 8, marginBottom: 6, paddingHorizontal: 12, height: 44, borderRadius: radius.md },
	sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
	sectionTitle: { letterSpacing: 0.6 },
	chevronCollapsed: { transform: [{ rotate: '-90deg' }] },
	empty: { paddingTop: 80, paddingHorizontal: 32 },
	center: { textAlign: 'center' },
});
