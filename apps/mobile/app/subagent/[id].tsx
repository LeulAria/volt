/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, duration, errorMessage, type IAgentChange, type IOrchTask, relativeTime, statusColor, tasksOf } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChangeRow, changeTotals } from '../../src/chat/ChangeRow';
import { ChatContext } from '../../src/chat/context';
import { Markdown } from '../../src/chat/Markdown';
import { isTaskLive, TASK_STATE_LABEL, taskStatus } from '../../src/chat/Subagents';
import { Transcript } from '../../src/chat/Transcript';
import { FileIcon } from '../../src/files/FileIcon';
import { useClient, useCollections, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Button, EmptyState, haptic, Icon, LiveTimer, Segmented, StatusIcon, T, Tap } from '../../src/ui/core';

export default function SubagentScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const client = useOptionalClient();
	const { p } = useTheme();
	if (!client || !id) {
		return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={p.fgTertiary} /></View>;
	}
	return <Subagent taskId={id} />;
}

type Tab = 'overview' | 'transcript' | 'changes';

/**
 * One subagent, as the desktop's subagent card opens it: what it was asked, how it is doing,
 * what it found or why it failed, the files it changed and its own transcript.
 */
function Subagent({ taskId }: { readonly taskId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const task = tasksOf(useCollections(['orch.tasks']))[taskId] as IOrchTask | undefined;
	const [tab, setTab] = useState<Tab>('overview');
	const [changes, setChanges] = useState<readonly IAgentChange[] | undefined>();
	const [changesError, setChangesError] = useState<string | undefined>();
	const childId = task?.childId;

	const loadChanges = useCallback(async () => {
		if (!childId) {
			setChanges([]);
			return;
		}
		try {
			setChanges(await client.getChanges(childId, 'session'));
			setChangesError(undefined);
		} catch (err) {
			setChangesError(errorMessage(err));
		}
	}, [client, childId]);

	useEffect(() => {
		void loadChanges();
	}, [loadChanges, task?.state]);

	if (!task) {
		return (
			<View style={{ flex: 1, backgroundColor: p.canvas }}>
				<Stack.Screen options={{ title: 'Subagent' }} />
				<EmptyState icon="agents" title="This subagent is gone" body="Volt keeps subagents while their chat is open on your computer." />
			</View>
		);
	}

	const live = isTaskLive(task);
	const status = taskStatus(task);
	const tone = status === 'unread' ? p.success : statusColor(status, p);
	const stop = () => Alert.alert('Stop this subagent?', 'It stops where it is; the chat that started it hears that it was stopped.', [
		{ text: 'Cancel', style: 'cancel' },
		{ text: 'Stop', style: 'destructive', onPress: () => {
			haptic.warning();
			void client.cancelTask(task.id);
		} },
	]);
	const files = changes?.length ? undefined : task.files;
	const totals = changeTotals(changes ?? []);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: 'Subagent', headerRight: () => live ? <Button label="Stop" icon="stop" size="sm" variant="ghost" onPress={stop} /> : null }} />
			<View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
					<View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${tone}22`, alignItems: 'center', justifyContent: 'center' }}>
						<StatusIcon status={status} size={18} />
					</View>
					<View style={{ flex: 1, minWidth: 0 }}>
						<T variant="callout" weight="700" numberOfLines={2}>{task.title}</T>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
							<T variant="footnote" weight="600" color={tone}>{TASK_STATE_LABEL[task.state]}</T>
							{live && task.startedAt ? <LiveTimer since={task.startedAt} color={p.info} /> : task.startedAt && task.endedAt ? <T variant="footnote" color={p.fgTertiary}>{`· ${duration(task.endedAt - task.startedAt)}`}</T> : null}
						</View>
					</View>
				</View>
				<Segmented<Tab> value={tab} onChange={setTab} options={[
					{ id: 'overview', label: 'Overview' },
					{ id: 'transcript', label: 'Transcript' },
					{ id: 'changes', label: changes?.length ? `Changes · ${changes.length}` : 'Changes' },
				]} />
			</View>
			{tab === 'transcript' ? (
				childId ? (
					<ChatContext.Provider value={{ chatId: childId, readOnly: true, onMessageMenu: () => undefined, onRetry: () => undefined, onRedo: () => undefined }}>
						<Transcript chatId={childId} topInset={0} />
					</ChatContext.Provider>
				) : <EmptyState icon="message" title="No transcript" body="This subagent ran inside its agent, which keeps no separate transcript." />
			) : tab === 'changes' ? (
				<ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}>
					{changes === undefined && !changesError ? <ActivityIndicator color={p.fgTertiary} /> : null}
					{changesError ? <T variant="small" color={p.danger}>{changesError}</T> : null}
					{changes?.length ? (
						<>
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
								<T variant="small" weight="600" color={p.fgSecondary}>{changes.length} {changes.length === 1 ? 'file' : 'files'} changed</T>
								<T variant="small" mono color={p.diffAddedFg}>+{totals.add}</T>
								<T variant="small" mono color={p.diffRemovedFg}>{'−'}{totals.del}</T>
								{task.worktreeBranch ? <T variant="footnote" mono color={p.fgTertiary} numberOfLines={1} style={{ flex: 1, textAlign: 'right' }}>{task.worktreeBranch}</T> : null}
							</View>
							<View style={{ gap: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, borderRadius: 14 }}>
								{changes.map((change, i) => <ChangeRow key={`${change.turnId}:${change.path}`} change={change} first={i === 0} last={i === changes.length - 1} />)}
							</View>
						</>
					) : null}
					{files?.length ? (
						<Card title="Files it touched">
							{files.map((path, i) => (
								<Tap key={path} haptics="selection" onPress={() => router.push({ pathname: '/file', params: { path } })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 12, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
									<FileIcon path={path} size={18} />
									<T variant="small" numberOfLines={1} style={{ flex: 1 }}>{basename(path)}</T>
									<Icon name="chevronRight" size={13} color={p.fgQuaternary} />
								</Tap>
							))}
						</Card>
					) : null}
					{changes && !changes.length && !files?.length ? <EmptyState icon="fileDiff" title="No changes" body={live ? 'Nothing changed yet.' : 'This subagent didn\'t change any files.'} /> : null}
				</ScrollView>
			) : (
				<ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 14 }}>
					<Card>
						<Fact label="Model" value={task.modelLabel} />
						<Fact label="Role" value={task.role ?? task.kind} />
						<Fact label="Started" value={task.startedAt ? `${relativeTime(task.startedAt)} ago` : task.state === 'queued' ? 'Waiting for a slot' : undefined} />
						<Fact label="Steps" value={task.steps ? String(task.steps) : undefined} />
						<Fact label="Branch" value={task.worktreeBranch} mono />
						<Fact label="Ran in" value={task.source === 'harness' ? 'Its agent (a harness subagent)' : 'Volt'} />
					</Card>
					{live && task.activity ? (
						<Card title="Now">
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}>
								<ActivityIndicator size="small" color={p.info} />
								<T variant="small" color={p.fgSecondary} style={{ flex: 1 }}>{task.activity}</T>
							</View>
						</Card>
					) : null}
					{task.waitingOn ? (
						<Card title="Waiting for you">
							<View style={{ padding: 12, gap: 10 }}>
								<T variant="small" color={p.fgSecondary}>{task.waitingOn === 'approval' ? 'It needs an approval to go on.' : 'It asked a question.'} Answer it in its chat.</T>
								{childId ? <Button label="Open its chat" icon="message" onPress={() => router.push({ pathname: '/chat/[id]', params: { id: childId } })} /> : null}
							</View>
						</Card>
					) : null}
					{task.brief ? <Card title="Brief"><View style={{ padding: 12 }}><Markdown text={task.brief} compact /></View></Card> : null}
					{task.error ? <Card title="Error"><T variant="small" color={p.danger} style={{ padding: 12 }}>{task.error}</T></Card> : null}
					{task.result ? <Card title="Result"><View style={{ padding: 12 }}><Markdown text={task.result} compact /></View></Card> : null}
					{!task.brief && !task.result && !task.error && !live ? <T variant="small" color={p.fgTertiary}>No report from this subagent.</T> : null}
				</ScrollView>
			)}
		</View>
	);
}

function Card({ title, children }: { readonly title?: string; readonly children: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ gap: 6 }}>
			{title ? <T variant="caption" weight="700" color={p.fgTertiary} style={{ paddingHorizontal: 4, letterSpacing: 0.6, textTransform: 'uppercase' }}>{title}</T> : null}
			<View style={{ borderRadius: 14, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>{children}</View>
		</View>
	);
}

function Fact({ label, value, mono }: { readonly label: string; readonly value: string | undefined; readonly mono?: boolean }) {
	const { p } = useTheme();
	if (!value) {
		return null;
	}
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
			<T variant="small" color={p.fgTertiary} style={{ width: 70 }}>{label}</T>
			<T variant="small" mono={mono} numberOfLines={1} style={{ flex: 1 }}>{value}</T>
		</View>
	);
}
