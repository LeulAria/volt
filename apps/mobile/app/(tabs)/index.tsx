/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { selectProjects, shortPath } from '@volt/client-core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { ChatRow } from '../../src/home/ChatRow';
import { RunGroupRow, useRunGroups } from '../../src/home/RunGroups';
import { ConnectionPill, OfflineBanner } from '../../src/home/Connection';
import { inboxCount } from '../../src/home/inbox';
import { openChat, useChatMenu } from '../../src/home/useChatMenu';
import { useChatItems, useClient, useCollections } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Button, EmptyState, haptic, IconButton } from '../../src/ui/core';
import { LargeHeader } from '../../src/ui/header';
import { NavRow, ProjectAvatar, RowList, SectionTitle } from '../../src/ui/rows';

const RECENT = 6;
const PROJECTS = 4;
const COMPARISONS = 3;

/**
 * Home, laid out like the GitHub app's: My work (what needs you, what runs, what's pinned...),
 * your projects, then the chats you touched last.
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

	const active = items.filter(item => !item.archived);
	const count = (test: (item: typeof items[number]) => boolean) => active.filter(test).length;
	const recent = active.filter(item => !item.snoozed).slice(0, RECENT);
	const chats = (filter: string) => router.push({ pathname: '/chats', params: { filter } });

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader
				title="Home"
				left={<ConnectionPill />}
				right={<>
					<IconButton icon="search" label="Search chats" color={p.fg} onPress={() => router.push({ pathname: '/chats', params: { filter: 'all', search: '1' } })} />
					<IconButton icon="compose" label="New chat" color={p.fg} onPress={() => router.push('/new')} />
				</>}
			/>
			<ScrollView
				contentContainerStyle={{ paddingBottom: 32 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					haptic.light();
					client.reconnect();
					setTimeout(() => setRefreshing(false), 900);
				}} />}
			>
				<OfflineBanner />
				<SectionTitle title="My work" first />
				<RowList>
					<NavRow icon="shieldAlert" color={p.warning} label="Needs you" detail="Approvals, questions and usage limits" count={inboxCount(items, 'needs')} countTone="attention" onPress={() => chats('needs')} />
					<NavRow icon="circleDashed" color={p.info} label="Working" count={count(item => item.status === 'working' || item.status === 'queued')} countTone="live" onPress={() => chats('working')} />
					<NavRow icon="checkCircle" color={p.success} label="Unread" count={count(item => item.unread)} onPress={() => chats('unread')} />
					<NavRow icon="pin" color={p.violet} label="Pinned" count={count(item => item.pinned)} onPress={() => chats('pinned')} />
					<NavRow icon="message" color={p.accent} label="All chats" count={active.length} onPress={() => chats('all')} />
					<NavRow icon="inbox" color="#14B8A6" label="Settled" detail="Done with for now; back when they need you" count={count(item => item.settled && !item.snoozed)} onPress={() => chats('settled')} />
					<NavRow icon="archive" color="#6B7280" label="Archived" count={items.length - active.length} onPress={() => chats('archived')} />
				</RowList>

				{groups.length ? (
					<>
						<SectionTitle title="Compare models" action={groups.length > COMPARISONS ? 'See all' : undefined} onAction={() => router.push('/groups')} />
						<RowList inset={50}>
							{groups.slice(0, COMPARISONS).map(group => <RunGroupRow key={group.id} group={group} projectName={projects.find(pr => pr.id === group.projectId)?.name} />)}
						</RowList>
					</>
				) : null}

				<SectionTitle title="Projects" action={projects.length > PROJECTS ? 'See all' : undefined} onAction={() => router.navigate('/projects')} />
				{projects.length ? (
					<RowList inset={60}>
						{projects.slice(0, PROJECTS).map(project => (
							<NavRow key={project.id} tile={<ProjectAvatar name={project.name} />} label={project.name} detail={shortPath(project.path)} count={project.chats}
								onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })} />
						))}
					</RowList>
				) : (
					<NavRow icon="folderPlus" color={p.accent} label="Add a project" detail="A folder on your computer" onPress={() => router.navigate('/projects')} />
				)}

				<SectionTitle title="Recent" action={active.length > RECENT ? 'See all' : undefined} onAction={() => chats('all')} />
				{recent.length ? (
					<RowList inset={50}>
						{recent.map(item => <ChatRow key={item.id} item={item} onPress={openChat} onLongPress={menu.show} />)}
					</RowList>
				) : (
					<EmptyState icon="message" title="No chats yet" body={`Start one here, or in Volt on ${client.environment.label}.`}
						action={<Button label="New chat" icon="compose" variant="primary" onPress={() => router.push('/new')} />} />
				)}
			</ScrollView>
			{menu.sheets}
		</View>
	);
}
