/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IconName, selectProjects } from '@volt/client-core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { ChatRow } from '../../src/home/ChatRow';
import { ConnectionPill, OfflineBanner } from '../../src/home/Connection';
import { inboxCount } from '../../src/home/inbox';
import { RunGroupRow, useRunGroups } from '../../src/home/RunGroups';
import { openChat, useChatMenu } from '../../src/home/useChatMenu';
import { useChatItems, useClient, useCollections } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { leadingPaneWidth, RAIL_WIDTH, useAdaptive } from '../../src/ui/adaptive';
import { Button, EmptyState, haptic, Icon, IconButton, Ripple, Spin, T, Tap } from '../../src/ui/core';
import { LargeHeader, LargeTitle, useLargeTitleScroll } from '../../src/ui/header';
import { CardGroup, CardRow, RowList } from '../../src/ui/rows';

const RECENT = 6;
/** Recent gets its own column on a wide window, so it shows more. */
const RECENT_WIDE = 14;
const COMPARISONS = 3;

/**
 * Home: four one-line cards for what wants a look (needs you, working, unread, pinned), then one
 * grouped list (all chats, projects, settled, archived) whose rows open their own screens, then
 * the chats you touched last.
 */
export default function Home() {
	const { p } = useTheme();
	const client = useClient();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const groups = useRunGroups().filter(group => !group.archived);
	const menu = useChatMenu();
	const [refreshing, setRefreshing] = useState(false);
	const { scroll, onScroll } = useLargeTitleScroll();
	const layout = useAdaptive();
	const wide = layout.expanded;

	const active = items.filter(item => !item.archived);
	const count = (test: (item: typeof items[number]) => boolean) => active.filter(test).length;
	const recent = active.filter(item => !item.snoozed).slice(0, wide ? RECENT_WIDE : RECENT);
	const chats = (filter: string) => router.push({ pathname: '/chats', params: { filter } });
	const needs = inboxCount(items, 'needs');
	const working = count(item => item.status === 'working' || item.status === 'queued');

	const overview = (
		<>
			<View style={styles.grid}>
				<View style={styles.gridRow}>
					<WorkCard icon="shieldAlert" color={p.warning} label="Needs you" count={needs} alert onPress={() => chats('needs')} />
					<WorkCard icon="circleDashed" color={p.info} label="Working" count={working} spin={working > 0} onPress={() => chats('working')} />
				</View>
				<View style={styles.gridRow}>
					<WorkCard icon="checkCircle" color={p.success} label="Unread" count={count(item => item.unread)} onPress={() => chats('unread')} />
					<WorkCard icon="pin" color={p.violet} label="Pinned" count={count(item => item.pinned)} onPress={() => chats('pinned')} />
				</View>
			</View>

			<CardGroup>
				<CardRow icon="message" label="All chats" count={active.length} onPress={() => chats('all')} />
				<CardRow icon="folder" label="Projects" count={projects.length} onPress={() => router.push('/project')} />
				<CardRow icon="inbox" label="Settled" count={count(item => item.settled && !item.snoozed)} onPress={() => chats('settled')} />
				<CardRow icon="archive" label="Archived" count={items.length - active.length} onPress={() => chats('archived')} />
			</CardGroup>

			{groups.length ? (
				<>
					<Section title="Compare models" action={groups.length > COMPARISONS ? 'See all' : undefined} onAction={() => router.push('/groups')} />
					<RowList inset={50}>
						{groups.slice(0, COMPARISONS).map(group => <RunGroupRow key={group.id} group={group} projectName={projects.find(pr => pr.id === group.projectId)?.name} />)}
					</RowList>
				</>
			) : null}
		</>
	);
	const recentList = (
		<>
			<Section title="Recent" action={active.length > recent.length ? 'See all' : undefined} onAction={() => chats('all')} />
			{recent.length ? (
				<RowList inset={50}>
					{recent.map(item => <ChatRow key={item.id} item={item} onPress={openChat} onLongPress={menu.show} />)}
				</RowList>
			) : (
				<EmptyState icon="message" title="No chats yet" body={`Start one here, or in Volt on ${client.environment.label}.`}
					action={<Button label="New chat" icon="compose" variant="primary" onPress={() => router.push('/new')} />} />
			)}
		</>
	);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader
				title="Home"
				scroll={scroll}
				left={<ConnectionPill />}
				right={<>
					<IconButton icon="search" label="Search chats" color={p.fg} onPress={() => router.push({ pathname: '/chats', params: { filter: 'all', search: '1' } })} />
					<IconButton icon="compose" label="New chat" color={p.fg} onPress={() => router.push('/new')} />
				</>}
			/>
			<Animated.ScrollView
				onScroll={onScroll}
				scrollEventThrottle={16}
				contentContainerStyle={{ paddingBottom: 40 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					haptic.light();
					client.reconnect();
					setTimeout(() => setRefreshing(false), 900);
				}} />}
			>
				<LargeTitle title="Home" scroll={scroll} />
				<OfflineBanner />
				{wide ? (
					// Wide (an open Duo or fold, a tablet): the overview on the left, Recent on the right,
					// the two meeting at the hinge on a fold.
					<View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
						<View style={{ width: leadingPaneWidth(layout, RAIL_WIDTH) }}>{overview}</View>
						{/* Its title lines up with the cards' top, not with a section below them. */}
						<View style={{ flex: 1, minWidth: 0, marginTop: -20 }}>{recentList}</View>
					</View>
				) : <>{overview}{recentList}</>}
			</Animated.ScrollView>
			{menu.sheets}
		</View>
	);
}

/**
 * One of the four "my work" cards, one line high: the bare glyph in its colour, the label, the
 * count at the right. Every card shares the list's surface; an empty one dims its glyph and count.
 */
function WorkCard({ icon, color, label, count, alert, spin, onPress }: {
	readonly icon: IconName;
	readonly color: string;
	readonly label: string;
	readonly count: number;
	/** Shows the count in the card's colour while it is above zero (Needs you). */
	readonly alert?: boolean;
	readonly spin?: boolean;
	readonly onPress: () => void;
}) {
	const { p } = useTheme();
	const glyph = <Icon name={icon} size={18} color={count ? color : p.fgQuaternary} />;
	return (
		<Ripple haptics="selection" onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}, ${count}`}
			style={[styles.card, { backgroundColor: p.surface, borderColor: p.strokeFaint }]}>
			{spin ? <Spin>{glyph}</Spin> : glyph}
			<T variant="body" weight="500" color={count ? p.fg : p.fgTertiary} numberOfLines={1} style={{ flex: 1 }}>{label}</T>
			<T variant="title3" weight="600" color={alert && count ? color : count ? p.fg : p.fgQuaternary} style={{ fontVariant: ['tabular-nums'] }}>{count}</T>
		</Ripple>
	);
}

function Section({ title, action, onAction }: { readonly title: string; readonly action?: string; readonly onAction?: () => void }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 20, paddingTop: 28, paddingBottom: 10 }}>
			<T variant="title3" weight="700" style={{ flex: 1, letterSpacing: -0.2 }}>{title}</T>
			{action ? (
				<Tap haptics="selection" onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={action}>
					<T variant="small" weight="600" color={p.accent}>{action}</T>
				</Tap>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	grid: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
	gridRow: { flexDirection: 'row', gap: 8 },
	card: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: 50, paddingHorizontal: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
