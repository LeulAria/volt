/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { relativeTime, selectProjects, shortPath } from '@volt/client-core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useChatItems, useClient, useCollections } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { EmptyState, Icon, IconButton, T } from '../../src/ui/core';
import { LargeHeader } from '../../src/ui/header';
import { NavRow, ProjectAvatar } from '../../src/ui/rows';
import { InputSheet } from '../../src/ui/sheets';
import { expandHome } from '../../src/home/paths';

/** Every project Volt knows, GitHub's repository list in Volt's surfaces. */
export default function Projects() {
	const { p } = useTheme();
	const client = useClient();
	const cols = useCollections(['projects', 'history']);
	const items = useChatItems();
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [query, setQuery] = useState('');
	const [adding, setAdding] = useState(false);
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

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader title="Projects" right={<IconButton icon="folderPlus" label="Add a project" color={p.fg} onPress={() => setAdding(true)} />} />
			<FlatList
				data={list}
				keyExtractor={project => project.id}
				keyboardDismissMode="on-drag"
				contentContainerStyle={{ paddingBottom: 32 }}
				ListHeaderComponent={
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: p.fill, marginHorizontal: 16, marginTop: 4, marginBottom: 10 }}>
						<Icon name="search" size={16} color={p.fgTertiary} />
						<TextInput value={query} onChangeText={setQuery} placeholder="Find a project" placeholderTextColor={p.fgQuaternary} autoCapitalize="none" autoCorrect={false} selectionColor={p.accent} style={{ flex: 1, color: p.fg, fontSize: 16 }} />
					</View>
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 70 }} />}
				renderItem={({ item: project }) => {
					const live = working.get(project.id) ?? 0;
					return (
						<NavRow
							tile={<ProjectAvatar name={project.name} size={40} />}
							label={project.name}
							detail={`${shortPath(project.path)}${project.lastActiveAt ? `  ·  ${relativeTime(project.lastActiveAt)}` : ''}`}
							right={live ? <T variant="footnote" weight="600" color={p.info}>{live} working</T> : <T variant="footnote" color={p.fgTertiary}>{project.chats} {project.chats === 1 ? 'chat' : 'chats'}</T>}
							onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
						/>
					);
				}}
				ListEmptyComponent={<EmptyState icon="folder" title={q ? 'No projects match' : 'No projects yet'} body={q ? undefined : 'Add a folder on your computer to start chats in it.'} />}
			/>
			<InputSheet visible={adding} onClose={() => setAdding(false)} title="Add a project" placeholder="~/code/my-app" confirm="Add"
				onSubmit={path => void client.addProject(expandHome(path, projects)).then(project => project && router.push({ pathname: '/project/[id]', params: { id: project.id } }))} />
		</View>
	);
}
