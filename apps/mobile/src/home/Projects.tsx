/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { relativeTime, selectProjects, shortPath } from '@volt/client-core';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useChatItems, useCollections } from '../state/client';
import { useTheme } from '../theme/theme';
import { useReadableInset } from '../ui/adaptive';
import { Button, EmptyState, Icon, IconButton, T } from '../ui/core';
import { LargeHeader, LargeTitle, useHeaderScroll, useLargeTitleScroll } from '../ui/header';
import { ListItem } from '../ui/list';
import { ProjectAvatar } from '../ui/rows';
import { SearchField } from '../ui/SearchField';

/**
 * Every project Volt knows, as a flat list: an outlined folder, the name, its path dimmed, and how
 * many chats it has (or how many are working). The Projects tab shows it under a large title; Home
 * pushes it as its own screen with a back button (`pushed`). Add opens a picker of the computer's
 * folders.
 */
export function ProjectsList({ pushed }: { readonly pushed?: boolean }) {
	const { p } = useTheme();
	const cols = useCollections(['projects', 'history']);
	const items = useChatItems();
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [query, setQuery] = useState('');
	const { scroll, onScroll: onLargeScroll } = useLargeTitleScroll();
	const onHeaderScroll = useHeaderScroll();
	const inset = useReadableInset(!pushed);
	const working = useMemo(() => {
		const map = new Map<string, number>();
		for (const item of items) {
			if (item.projectId && (item.status === 'working' || item.status === 'queued')) {
				map.set(item.projectId, (map.get(item.projectId) ?? 0) + 1);
			}
		}
		return map;
	}, [items]);
	const q = query.trim().toLowerCase();
	const list = q ? projects.filter(project => project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q)) : projects;
	const add = <IconButton icon="folderPlus" label="Add a project" color={p.fg} onPress={() => router.push('/project/add')} />;

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			{pushed ? <Stack.Screen options={{ title: 'Projects', headerRight: () => add }} /> : <LargeHeader title="Projects" right={add} scroll={scroll} />}
			<Animated.FlatList
				data={list}
				keyExtractor={project => project.id}
				keyboardDismissMode="on-drag"
				onScroll={pushed ? onHeaderScroll : onLargeScroll}
				scrollEventThrottle={16}
				contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: inset }}
				ListHeaderComponent={
					<View>
						{pushed ? null : <LargeTitle title="Projects" scroll={scroll} />}
						<View style={{ marginBottom: 6 }}><SearchField value={query} onChange={setQuery} placeholder="Find a project" /></View>
					</View>
				}
				renderItem={({ item: project }) => {
					const live = working.get(project.id) ?? 0;
					return (
						<ListItem onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })} accessibilityLabel={project.name} style={{ minHeight: 58, gap: 13 }}>
							<ProjectAvatar name={project.name} size={36} />
							<View style={{ flex: 1, minWidth: 0, gap: 1 }}>
								<T variant="body" weight="500" numberOfLines={1} style={{ fontSize: 15 }}>{project.name}</T>
								<T variant="footnote" color={p.fgTertiary} numberOfLines={1} ellipsizeMode="middle">{shortPath(project.path)}{project.lastActiveAt ? `  ·  ${relativeTime(project.lastActiveAt)}` : ''}</T>
							</View>
							{live ? <T variant="footnote" weight="600" color={p.info}>{live} working</T> : <T variant="footnote" color={p.fgTertiary} style={{ fontVariant: ['tabular-nums'] }}>{project.chats || ''}</T>}
							<Icon name="chevronRight" size={15} color={p.fgQuaternary} />
						</ListItem>
					);
				}}
				ListEmptyComponent={<EmptyState icon="folder" title={q ? 'No projects match' : 'No projects yet'} body={q ? undefined : 'Add a folder on your computer to start chats in it.'}
					action={q ? undefined : <Button label="Add a project" icon="folderPlus" variant="primary" onPress={() => router.push('/project/add')} />} />}
			/>
		</View>
	);
}
