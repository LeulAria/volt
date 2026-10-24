/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IFileContent, type IGitStatus, selectProjects, shortPath } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Markdown } from '../../src/chat/Markdown';
import { ChatRow } from '../../src/home/ChatRow';
import { openChat, useChatMenu } from '../../src/home/useChatMenu';
import { useChatItems, useClient, useCollections, useOptionalClient, useStatus } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Button, EmptyState, Icon, T } from '../../src/ui/core';
import { NavRow, ProjectAvatar, RowList, SectionTitle } from '../../src/ui/rows';

const RECENT = 5;
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README'];

export default function ProjectScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return useOptionalClient() && id ? <Project projectId={id} /> : null;
}

/** A project, the way the GitHub app shows a repository: who it is, what's going on, its README. */
function Project({ projectId }: { readonly projectId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const status = useStatus();
	const cols = useCollections(['projects', 'history']);
	const project = useMemo(() => selectProjects(cols).find(pr => pr.id === projectId), [cols, projectId]);
	const items = useChatItems();
	const menu = useChatMenu();
	const chats = items.filter(item => item.projectId === projectId && !item.archived);
	const working = chats.filter(item => item.status === 'working' || item.status === 'queued').length;
	const needs = chats.filter(item => item.status === 'approval' || item.status === 'question').length;
	const [git, setGit] = useState<IGitStatus | undefined>();
	const [readme, setReadme] = useState<{ readonly name: string; readonly text: string } | undefined>();
	const path = project?.path;

	useEffect(() => {
		if (!path || !status.live) {
			return;
		}
		let cancelled = false;
		void client.gitStatus(path).then(next => !cancelled && setGit(next), () => undefined);
		void (async () => {
			for (const name of README_NAMES) {
				try {
					const file: IFileContent = await client.readFile(`${path}/${name}`);
					if (file.kind === 'text') {
						if (!cancelled) {
							setReadme({ name, text: file.text });
						}
						return;
					}
				} catch {
					// try the next name
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, path, status.live]);

	if (!project) {
		return <EmptyState icon="folder" title="Project not found" body="It may have been removed in Volt." />;
	}
	const files = () => router.push({ pathname: '/files', params: { root: project.path, dir: project.path, name: project.name } });
	const scm = () => router.push({ pathname: '/scm', params: { root: project.path, name: project.name } });

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: '' }} />
			<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
				<View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
						<ProjectAvatar name={project.name} size={44} />
						<View style={{ flex: 1, minWidth: 0 }}>
							<T variant="title1" weight="800" numberOfLines={1} style={{ letterSpacing: -0.5 }}>{project.name}</T>
							<T variant="footnote" mono color={p.fgTertiary} numberOfLines={1} ellipsizeMode="head">{shortPath(project.path, 60)}</T>
						</View>
					</View>
					<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
						{git?.branch ? <Fact icon="branch" text={git.branch} /> : null}
						<Fact icon="message" text={`${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}`} />
						{working ? <Fact icon="circleDashed" text={`${working} working`} color={p.info} /> : null}
						{needs ? <Fact icon="shieldAlert" text={`${needs} need you`} color={p.warning} /> : null}
						{git?.changes.length ? <Fact icon="fileDiff" text={`${git.changes.length} changed`} color={p.warning} /> : null}
					</View>
					<View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
						<Button label="New chat" icon="compose" variant="primary" flex onPress={() => router.push({ pathname: '/new', params: { project: project.id } })} />
						<Button label="Files" icon="folder" flex onPress={files} />
					</View>
				</View>

				<View style={{ marginTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<RowList>
						<NavRow icon="message" color={p.accent} label="Chats" count={chats.length} onPress={() => router.push({ pathname: '/chats', params: { filter: 'all', project: project.id } })} />
						<NavRow icon="fileDiff" color={p.warning} label="Source control" detail={git ? git.changes.length ? `${git.changes.length} uncommitted ${git.changes.length === 1 ? 'change' : 'changes'}` : 'No uncommitted changes' : undefined} count={git?.changes.length} onPress={scm} />
						<NavRow icon="pullRequest" color={p.success} label="Pull requests" onPress={() => router.push({ pathname: '/pulls', params: { root: project.path, name: project.name } })} />
						<NavRow icon="folder" color={p.violet} label="Browse files" onPress={files} />
					</RowList>
				</View>

				<SectionTitle title="Chats" action={chats.length > RECENT ? 'See all' : undefined} onAction={() => router.push({ pathname: '/chats', params: { filter: 'all', project: project.id } })} />
				{chats.length ? (
					<RowList inset={50}>
						{chats.slice(0, RECENT).map(item => <ChatRow key={item.id} item={item} onPress={openChat} onLongPress={menu.show} />)}
					</RowList>
				) : (
					<T variant="small" color={p.fgTertiary} style={{ paddingHorizontal: 16 }}>No chats in this project yet.</T>
				)}

				{readme ? (
					<View style={{ marginTop: 26, marginHorizontal: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, backgroundColor: p.surface }}>
							<Icon name="book" size={15} color={p.fgSecondary} />
							<T variant="small" weight="600">{readme.name}</T>
						</View>
						<View style={{ padding: 14 }}>
							<Markdown text={readme.text.slice(0, 20_000)} docKey={`readme:${project.id}`} />
						</View>
					</View>
				) : null}
			</ScrollView>
			{menu.sheets}
		</View>
	);
}

function Fact({ icon, text, color }: { readonly icon: 'branch' | 'message' | 'circleDashed' | 'shieldAlert' | 'fileDiff'; readonly text: string; readonly color?: string }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
			<Icon name={icon} size={14} color={color ?? p.fgTertiary} />
			<T variant="small" color={color ?? p.fgSecondary} weight={color ? '600' : '400'}>{text}</T>
		</View>
	);
}
