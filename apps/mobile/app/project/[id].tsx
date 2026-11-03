/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, type IChatListItem, type IFileContent, type IGitStatus, relativeTime, selectProjects, shortPath, statusColor } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Markdown } from '../../src/chat/Markdown';
import { FileIcon } from '../../src/files/FileIcon';
import { ChatRow } from '../../src/home/ChatRow';
import { openChat, useChatMenu } from '../../src/home/useChatMenu';
import { useChatItems, useClient, useCollections, useOptionalClient, useStatus } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { useReadableInset } from '../../src/ui/adaptive';
import { Button, EmptyState, Icon, Ripple, StatusIcon, T } from '../../src/ui/core';
import { useHeaderScroll } from '../../src/ui/header';
import { ListItem, ListRow } from '../../src/ui/list';
import { CardGroup, CardRow, ProjectAvatar, RowList, SectionTitle } from '../../src/ui/rows';
import { Sheet } from '../../src/ui/sheets';

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
	// The name scrolls away under the header, which then shows it.
	const onScroll = useHeaderScroll(52);
	const [detail, setDetail] = useState<Detail | undefined>();
	const inset = useReadableInset();

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
			<Stack.Screen options={{ title: project.name }} />
			<Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingBottom: insets.bottom + 32, paddingHorizontal: inset }}>
				<Animated.View entering={FadeIn.duration(220)} style={{ paddingHorizontal: 16, paddingTop: 4, gap: 12 }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
						<ProjectAvatar name={project.name} size={42} git={!!git?.branch} />
						<View style={{ flex: 1, minWidth: 0, gap: 1 }}>
							<T variant="title2" weight="700" numberOfLines={1} style={{ letterSpacing: -0.4 }}>{project.name}</T>
							<T variant="footnote" mono color={p.fgTertiary} numberOfLines={1} ellipsizeMode="head">{shortPath(project.path, 60)}</T>
						</View>
					</View>
				</Animated.View>
				{/* What's going on, as chips: each opens its details in a sheet. */}
				<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingTop: 14 }}>
					{git?.branch ? <Fact icon="branch" text={git.branch} onPress={() => setDetail('branch')} /> : null}
					<Fact icon="message" text={`${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}`} onPress={() => setDetail('chats')} />
					{working ? <Fact icon="circleDashed" text={`${working} working`} color={p.info} onPress={() => setDetail('working')} /> : null}
					{needs ? <Fact icon="shieldAlert" text={`${needs} need you`} color={p.warning} onPress={() => setDetail('needs')} /> : null}
					{git?.changes.length ? <Fact icon="fileDiff" text={`${git.changes.length} changed`} color={p.warning} onPress={() => setDetail('changed')} /> : null}
				</ScrollView>
				<View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 16 }}>
					<Button label="New chat" icon="messagePlus" variant="primary" size="lg" flex onPress={() => router.push({ pathname: '/new', params: { project: project.id } })} />
					<Button label="Files" icon="folderTree" size="lg" flex onPress={files} />
				</View>

				<CardGroup style={{ marginTop: 18 }}>
					<CardRow icon="message" label="Chats" count={chats.length} onPress={() => router.push({ pathname: '/chats', params: { filter: 'all', project: project.id } })} />
					<CardRow icon="branch" label="Source control" detail={git ? git.changes.length ? `${git.changes.length} uncommitted ${git.changes.length === 1 ? 'change' : 'changes'}` : 'No uncommitted changes' : undefined} count={git?.changes.length} onPress={scm} />
					<CardRow icon="pullRequest" label="Pull requests" onPress={() => router.push({ pathname: '/pulls', params: { root: project.path, name: project.name } })} />
					<CardRow icon="files" label="Browse files" onPress={files} />
				</CardGroup>

				<SectionTitle title="Chats" action={chats.length > RECENT ? 'See all' : undefined} onAction={() => router.push({ pathname: '/chats', params: { filter: 'all', project: project.id } })} />
				{chats.length ? (
					<RowList inset={50}>
						{chats.slice(0, RECENT).map(item => <ChatRow key={item.id} item={item} onPress={openChat} onLongPress={menu.show} />)}
					</RowList>
				) : (
					<T variant="small" color={p.fgTertiary} style={{ paddingHorizontal: 16 }}>No chats in this project yet.</T>
				)}

				{readme ? (
					<View style={{ marginTop: 28 }}>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingBottom: 10 }}>
							<Icon name="book" size={15} color={p.fgTertiary} />
							<T variant="small" weight="600" color={p.fgSecondary}>{readme.name}</T>
						</View>
						<View style={{ paddingHorizontal: 20 }}>
							<Markdown text={readme.text.slice(0, 20_000)} docKey={`readme:${project.id}`} baseDir={project.path} />
						</View>
					</View>
				) : null}
			</Animated.ScrollView>
			{menu.sheets}
			<DetailSheet detail={detail} onClose={() => setDetail(undefined)} project={project} chats={chats} git={git} />
		</View>
	);
}

type Detail = 'branch' | 'chats' | 'working' | 'needs' | 'changed';

/** One fact about the project as a chip; tapping it opens the details. */
function Fact({ icon, text, color, onPress }: { readonly icon: 'branch' | 'message' | 'circleDashed' | 'shieldAlert' | 'fileDiff'; readonly text: string; readonly color?: string; readonly onPress: () => void }) {
	const { p } = useTheme();
	return (
		<Ripple onPress={onPress} accessibilityRole="button" accessibilityLabel={text}
			style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 13, borderRadius: 17, backgroundColor: color ? `${color}14` : p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: color ? `${color}40` : p.strokeFaint }}>
			<Icon name={icon} size={14} color={color ?? p.fgSecondary} />
			<T variant="small" color={color ?? p.fg} weight="500" numberOfLines={1}>{text}</T>
		</Ripple>
	);
}

/** A fact's details in a bottom sheet: the chats it counts, the changed files, or the branch's places. */
function DetailSheet({ detail, onClose, project, chats, git }: {
	readonly detail: Detail | undefined;
	readonly onClose: () => void;
	readonly project: { readonly id: string; readonly name: string; readonly path: string };
	readonly chats: readonly IChatListItem[];
	readonly git: IGitStatus | undefined;
}) {
	const { p } = useTheme();
	const go = (fn: () => void) => {
		onClose();
		setTimeout(fn, 260);
	};
	const list = detail === 'working' ? chats.filter(item => item.status === 'working' || item.status === 'queued')
		: detail === 'needs' ? chats.filter(item => item.status === 'approval' || item.status === 'question')
			: chats;
	const title = detail === 'branch' ? git?.branch ?? 'Branch'
		: detail === 'changed' ? `${git?.changes.length ?? 0} changed ${git?.changes.length === 1 ? 'file' : 'files'}`
			: detail === 'working' ? `${list.length} working` : detail === 'needs' ? `${list.length} need you` : `${list.length} ${list.length === 1 ? 'chat' : 'chats'}`;
	return (
		<Sheet visible={!!detail} onClose={onClose} title={title} subtitle={project.name}>
			{detail === 'branch' ? (
				<View>
					<ListRow icon="fileDiff" label="Source control" value={git?.changes.length ? `${git.changes.length} changed` : 'Clean'} chevron onPress={() => go(() => router.push({ pathname: '/scm', params: { root: project.path, name: project.name } }))} />
					<ListRow icon="pullRequest" label="Pull requests" chevron onPress={() => go(() => router.push({ pathname: '/pulls', params: { root: project.path, name: project.name } }))} />
					<ListRow icon="folder" label="Repository" value={shortPath(git?.repoRoot ?? project.path, 40)} />
				</View>
			) : detail === 'changed' ? (
				<View>
					{(git?.changes ?? []).map(change => (
						<ListItem key={`${change.staged ? 's' : 'w'}:${change.path}`} onPress={() => go(() => router.push({ pathname: '/diff', params: { file: change.path, title: change.rel, mode: 'git' } }))} accessibilityLabel={change.rel} style={{ minHeight: 42, gap: 10 }}>
							<FileIcon path={change.rel} size={18} />
							<View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 7 }}>
								<T variant="body" numberOfLines={1} style={{ flexShrink: 1, maxWidth: '75%' }}>{basename(change.rel)}</T>
								<T variant="footnote" color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>{dirname(change.rel) === '.' ? '' : dirname(change.rel)}</T>
							</View>
							<T variant="footnote" weight="700" mono color={change.status === 'D' ? p.danger : change.status === 'A' || change.status === '?' ? p.success : p.warning}>{change.status === '?' ? 'U' : change.status}</T>
						</ListItem>
					))}
				</View>
			) : (
				<View>
					{list.map(item => (
						<ListItem key={item.id} onPress={() => go(() => openChat(item))} accessibilityLabel={item.title} style={{ minHeight: 54, gap: 10, alignItems: 'flex-start', paddingVertical: 8 }}>
							<View style={{ width: 16, alignItems: 'center', paddingTop: 3 }}><StatusIcon status={item.status} size={14} /></View>
							<View style={{ flex: 1, minWidth: 0, gap: 1 }}>
								<T variant="body" weight={item.unread ? '600' : '500'} numberOfLines={1} style={{ fontSize: 15 }}>{item.title}</T>
								<T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{item.branch ?? item.preview ?? ' '}</T>
							</View>
							<T variant="footnote" color={item.status !== 'idle' && item.status !== 'unread' ? statusColor(item.status, p) : p.fgQuaternary}>{item.status !== 'idle' && item.status !== 'unread' ? item.statusLabel : relativeTime(item.updatedAt)}</T>
						</ListItem>
					))}
				</View>
			)}
		</Sheet>
	);
}
