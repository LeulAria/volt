/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ACCESS_MODES, compactNumber, duration, firstLine, historyOf, modelLabel, projectOf, RADIUS, runtimeOf, sessionsOf, shortPath, tasksOf, threadsOf, uriPath
} from '@volt/client-core';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatActions } from '../../src/home/chatActions';
import { useClient, useCollections, useOptionalClient, useTranscript } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { haptic, Icon, IconButton, StatusIcon, T, Tap } from '../../src/ui/core';
import { ConfirmSheet, InputSheet, SheetRow } from '../../src/ui/sheets';

export default function DetailsScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const client = useOptionalClient();
	if (!client || !id) {
		return null;
	}
	return <Details chatId={id} />;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ marginTop: 18 }}>
			<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, marginLeft: 4, marginBottom: 8 }}>{title.toUpperCase()}</T>
			<View style={{ backgroundColor: p.surface, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>{children}</View>
		</View>
	);
}

function Line({ icon, label, value, mono }: { readonly icon: Parameters<typeof Icon>[0]['name']; readonly label: string; readonly value?: string; readonly mono?: boolean }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 46 }}>
			<Icon name={icon} size={17} color={p.fgTertiary} />
			<T variant="body" color={p.fgSecondary}>{label}</T>
			<T variant={mono ? 'footnote' : 'body'} mono={mono} numberOfLines={1} style={{ flex: 1, textAlign: 'right' }}>{value ?? ''}</T>
		</View>
	);
}

function Details({ chatId }: { readonly chatId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const cols = useCollections(['history', 'orch.threads', 'orch.tasks', 'sessions', 'projects', 'runtime']);
	const transcript = useTranscript(chatId);
	const meta = historyOf(cols)[chatId];
	const thread = threadsOf(cols)[chatId];
	const session = sessionsOf(cols)[chatId];
	const runtime = runtimeOf(cols);
	const project = projectOf(cols, chatId);
	const tasks = Object.values(tasksOf(cols)).filter(task => task?.parentId === chatId).sort((a, b) => (b.createdAt ?? b.startedAt ?? 0) - (a.createdAt ?? a.startedAt ?? 0));
	const access = ACCESS_MODES.find(a => a.id === (session?.accessMode ?? runtime.accessMode)) ?? ACCESS_MODES[3];
	const folder = session?.worktreePath ?? session?.workingFolder ?? meta?.workspaceFolder ?? uriPath(project?.root);
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const used = transcript?.contextUsed;
	const windowSize = transcript?.contextWindow;

	return (
		<View style={{ flex: 1, backgroundColor: p.raised }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4, gap: 8 }}>
				<View style={{ flex: 1 }}>
					<T variant="title3" weight="700" numberOfLines={2}>{meta?.title || 'Chat'}</T>
					{project?.displayName || meta?.workspaceLabel ? <T variant="small" color={p.fgTertiary}>{project?.displayName ?? meta?.workspaceLabel}</T> : null}
				</View>
				<IconButton icon="close" label="Close" onPress={() => router.back()} style={{ backgroundColor: p.fill }} />
			</View>
			<ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}>
				<Section title="Chat">
					<Line icon="cpu" label="Model" value={modelLabel(runtime, session?.providerRef ?? thread?.modelRef)} />
					{folder ? <Line icon="folder" label="Folder" value={shortPath(folder, 34)} mono /> : null}
					{session?.worktreeBranch ?? meta?.worktreeBranch ? <Line icon="branch" label="Branch" value={session?.worktreeBranch ?? meta?.worktreeBranch} mono /> : null}
					{used && windowSize ? (
						<View style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 8 }}>
							<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
								<T variant="body" color={p.fgSecondary}>Context</T>
								<T variant="small" color={p.fgTertiary}>{compactNumber(used)} / {compactNumber(windowSize)}</T>
							</View>
							<View style={{ height: 6, borderRadius: 3, backgroundColor: p.fillStrong, overflow: 'hidden' }}>
								<View style={{ width: `${Math.min(100, (used / windowSize) * 100)}%`, height: 6, backgroundColor: used / windowSize > 0.85 ? p.warning : p.accent }} />
							</View>
						</View>
					) : null}
				</Section>

				<Section title="Work">
					<Tap haptics="selection" onPress={() => {
						router.back();
						router.push({ pathname: '/changes/[id]', params: { id: chatId } });
					}} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 48 }}>
						<Icon name="fileDiff" size={17} color={p.fgTertiary} />
						<T variant="body" style={{ flex: 1 }}>Changes</T>
						<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
					</Tap>
					{folder ? (
						<Tap haptics="selection" onPress={() => {
							router.back();
							router.push({ pathname: '/files', params: { root: folder, dir: folder, ...(project?.displayName ? { name: project.displayName } : {}) } });
						}} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
							<Icon name="folder" size={17} color={p.fgTertiary} />
							<T variant="body" style={{ flex: 1 }}>Files</T>
							<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
						</Tap>
					) : null}
				</Section>

				<Section title="Access">
					{ACCESS_MODES.map((mode, i) => (
						<Tap key={mode.id} haptics="selection" onPress={() => void client.setAccessMode(mode.id, chatId)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
							<Icon name={mode.id === 'supervised' ? 'shieldCheck' : mode.id === 'full-access' ? 'zap' : 'shield'} size={18} color={mode.id === access.id ? p.fg : p.fgTertiary} />
							<View style={{ flex: 1 }}>
								<T variant="body" weight={mode.id === access.id ? '600' : '400'}>{mode.label}</T>
								<T variant="footnote" color={p.fgTertiary}>{mode.description}</T>
							</View>
							{mode.id === access.id ? <Icon name="check" size={18} color={p.accent} strokeWidth={2.2} /> : null}
						</Tap>
					))}
				</Section>

				{thread?.queue.length ? (
					<Section title={`Queue · ${thread.queue.length}`}>
						{thread.queue.map((item, i) => (
							<View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4, minHeight: 48, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
								<T variant="small" numberOfLines={2} style={{ flex: 1 }}>{firstLine(item.prompt.text, 160)}</T>
								<IconButton icon="arrowUp" label="Send now" onPress={() => void client.sendQueuedNow(chatId, item.id)} />
								<IconButton icon="close" label="Remove" onPress={() => void client.removeQueued(chatId, item.id)} />
							</View>
						))}
					</Section>
				) : null}

				{tasks.length ? (
					<Section title={`Subagents · ${tasks.length}`}>
						{tasks.slice(0, 24).map((task, i) => {
							const live = task.state === 'running' || task.state === 'queued' || task.state === 'waiting';
							return (
								<Tap key={task.id} disabled={!task.childId} onPress={() => task.childId && router.push({ pathname: '/chat/[id]', params: { id: task.childId } })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
									<StatusIcon status={task.state === 'running' ? 'working' : task.state === 'waiting' ? 'question' : task.state === 'failed' ? 'failed' : task.state === 'queued' ? 'queued' : task.state === 'cancelled' || task.state === 'interrupted' ? 'stopped' : 'unread'} />
									<View style={{ flex: 1 }}>
										<T variant="body" weight="500" numberOfLines={1}>{task.title}</T>
										<T variant="footnote" color={p.fgTertiary} numberOfLines={1}>
											{live && task.activity ? task.activity : task.state}
											{task.startedAt && task.endedAt ? ` · ${duration(task.endedAt - task.startedAt)}` : ''}
											{task.modelLabel ? ` · ${task.modelLabel}` : ''}
										</T>
									</View>
									{live ? <IconButton icon="stop" label="Stop subagent" size={14} haptics="medium" onPress={() => void client.cancelTask(task.id)} /> : task.childId ? <Icon name="chevronRight" size={14} color={p.fgQuaternary} /> : null}
								</Tap>
							);
						})}
					</Section>
				) : null}

				<Section title="Actions">
					<View style={{ paddingHorizontal: 2, paddingVertical: 2 }}>
						{meta ? chatActions(client, { id: chatId, pinned: !!meta.pinned, unread: !!meta.unread, settled: !!meta.settled, snoozed: !!meta.snoozed, archived: !!meta.archived }, {
							rename: () => setRenaming(true),
							remove: () => setDeleting(true),
						}).map(action => <SheetRow key={action.label} action={action} onDone={() => haptic.selection()} />) : null}
					</View>
				</Section>
			</ScrollView>
			<InputSheet visible={renaming} onClose={() => setRenaming(false)} title="Rename chat" initial={meta?.title} onSubmit={title => void client.rename(chatId, title)} />
			<ConfirmSheet visible={deleting} onClose={() => setDeleting(false)} title="Delete this chat?" body="Its transcript is removed from Volt on your computer. This can't be undone." confirm="Delete" destructive onConfirm={() => {
				void client.deleteChat(chatId);
				if (router.canDismiss()) {
					router.dismissAll();
				}
			}} />
		</View>
	);
}
