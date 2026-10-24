/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IPullRequestDetail, type IPullRequestFilePatch, type PullRequestMergeMethod, relativeTime } from '@volt/client-core';
import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { InlineDiff } from '../src/chat/Diff';
import { Markdown } from '../src/chat/Markdown';
import { ChecksBadge, PullRequestStatePill } from '../src/git/PullRequestBits';
import { useClient, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { Button, EmptyState, haptic, Icon, IconButton, Segmented, T, Tap } from '../src/ui/core';
import { ActionSheet, ConfirmSheet, InputSheet, type ISheetAction } from '../src/ui/sheets';

type Tab = 'conversation' | 'checks' | 'files';

export default function PullScreen() {
	const { root, number } = useLocalSearchParams<{ root: string; number: string }>();
	return useOptionalClient() && root && number ? <Pull root={root} number={Number(number)} /> : null;
}

const MERGE_LABEL: Record<PullRequestMergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

/** One pull request: its state, conversation, checks and files, with Merge, Ready and comments. */
function Pull({ root, number }: { readonly root: string; readonly number: number }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [pr, setPr] = useState<IPullRequestDetail | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [tab, setTab] = useState<Tab>('conversation');
	const [files, setFiles] = useState<readonly IPullRequestFilePatch[] | undefined>();
	const [openFile, setOpenFile] = useState<string | undefined>();
	const [mergeSheet, setMergeSheet] = useState(false);
	const [confirmMerge, setConfirmMerge] = useState<PullRequestMergeMethod | undefined>();
	const [commenting, setCommenting] = useState(false);
	const [busy, setBusy] = useState(false);

	const load = useCallback(() => {
		void client.getPullRequest(root, number).then(next => {
			setPr(next);
			setError(undefined);
		}, err => setError(errorMessage(err)));
	}, [client, root, number]);
	useEffect(load, [load]);
	useEffect(() => {
		if (tab === 'files' && !files) {
			void client.pullRequestFiles(root, number).then(setFiles, () => setFiles([]));
		}
	}, [client, files, number, root, tab]);

	const act = async (action: () => Promise<unknown>, done: string) => {
		setBusy(true);
		try {
			await action();
			haptic.success();
			client.toast('success', done);
			load();
		} catch (err) {
			haptic.error();
			client.toast('error', errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	if (!pr) {
		return error ? <EmptyState icon="alertCircle" title="Couldn't load the pull request" body={error} /> : <ActivityIndicator style={{ marginTop: 60 }} color={p.fgTertiary} />;
	}
	const methods = (['squash', 'merge', 'rebase'] as const).filter(method => pr.mergeOptions[method]);
	const mergeActions: ISheetAction[] = methods.map(method => ({ label: MERGE_LABEL[method], icon: 'branch', onPress: () => setConfirmMerge(method) }));
	const open = pr.state === 'open' || pr.state === 'draft';

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: `#${pr.number}`, headerRight: () => <IconButton icon="external" label="Open on GitHub" color={p.fg} onPress={() => void Linking.openURL(pr.url)} /> }} />
			<ScrollView refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={p.fgTertiary} />} contentContainerStyle={{ paddingBottom: insets.bottom + 110 }}>
				<View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
					<T variant="footnote" color={p.fgTertiary}>{pr.repo.owner}/{pr.repo.name} #{pr.number}</T>
					<T variant="title2" weight="700" style={{ letterSpacing: -0.3 }}>{pr.title}</T>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
						<PullRequestStatePill state={pr.state} />
						<T variant="small" color={p.fgTertiary}><T variant="small" weight="600" color={p.fgSecondary}>{pr.author.login}</T> · {relativeTime(pr.updatedAt)}</T>
					</View>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
						<Icon name="branch" size={13} color={p.fgTertiary} />
						<T variant="footnote" mono color={p.fgSecondary}>{pr.baseRefName} ← {pr.headRefName}</T>
						<T variant="footnote" color={p.diffAddedFg}>+{pr.additions}</T>
						<T variant="footnote" color={p.diffRemovedFg}>-{pr.deletions}</T>
						<T variant="footnote" color={p.fgTertiary}>{pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}</T>
					</View>
				</View>
				<MergeBox pr={pr} />
				<View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
					<Segmented value={tab} onChange={setTab} options={[{ id: 'conversation', label: 'Conversation' }, { id: 'checks', label: `Checks${pr.checks.total ? ` ${pr.checks.total}` : ''}` }, { id: 'files', label: `Files ${pr.changedFiles}` }]} />
				</View>
				{tab === 'conversation' ? (
					<View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 14 }}>
						<Comment author={pr.author.login} at={pr.createdAt} body={pr.body || '_No description._'} />
						{[...pr.conversation.map(c => ({ id: c.id, author: c.author.login, at: c.createdAt, body: c.body, state: undefined as string | undefined })), ...pr.reviewList.filter(r => r.body || r.state !== 'COMMENTED').map(r => ({ id: r.id, author: r.author.login, at: r.at, body: r.body, state: r.state }))]
							.sort((a, b) => a.at - b.at)
							.map(item => <Comment key={item.id} author={item.author} at={item.at} body={item.body} state={item.state} />)}
						<Button label="Comment" icon="message" onPress={() => setCommenting(true)} />
					</View>
				) : tab === 'checks' ? (
					<View style={{ paddingTop: 10 }}>
						{pr.checkRuns.length ? pr.checkRuns.map(run => (
							<Tap key={`${run.workflow}:${run.name}`} haptics="selection" disabled={!run.url} onPress={() => run.url && void Linking.openURL(run.url)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
								<Icon name={run.state === 'success' ? 'checkCircle' : run.state === 'failure' || run.state === 'cancelled' ? 'xCircle' : run.state === 'pending' ? 'circleDashed' : 'circle'} size={17} color={run.state === 'success' ? p.success : run.state === 'failure' || run.state === 'cancelled' ? p.danger : run.state === 'pending' ? p.warning : p.fgTertiary} />
								<View style={{ flex: 1, minWidth: 0 }}>
									<T variant="body" numberOfLines={1}>{run.name}</T>
									{run.workflow || run.summary ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{[run.workflow, run.summary].filter(Boolean).join(' · ')}</T> : null}
								</View>
								{run.required ? <T variant="caption" color={p.fgQuaternary}>Required</T> : null}
							</Tap>
						)) : <EmptyState icon="checkCircle" title="No checks" />}
						{pr.checks.failed ? <View style={{ padding: 16 }}><Button label="Re-run failed checks" icon="refresh" busy={busy} onPress={() => void act(() => client.rerunFailedChecks(root, pr.number), 'Checks restarted')} /></View> : null}
					</View>
				) : (
					<View style={{ paddingTop: 10 }}>
						{!files ? <ActivityIndicator style={{ marginTop: 24 }} color={p.fgTertiary} /> : files.map(file => (
							<View key={file.path} style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
								<Tap haptics="selection" onPress={() => setOpenFile(openFile === file.path ? undefined : file.path)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 11 }}>
									<Icon name={openFile === file.path ? 'chevronDown' : 'chevronRight'} size={13} color={p.fgTertiary} />
									<T variant="small" mono numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>{file.path}</T>
									<T variant="footnote" color={p.diffAddedFg}>+{file.additions}</T>
									<T variant="footnote" color={p.diffRemovedFg}>-{file.deletions}</T>
								</Tap>
								{openFile === file.path ? (file.patch ? <InlineDiff diff={`--- a/${file.previousPath ?? file.path}\n+++ b/${file.path}\n${file.patch}`} /> : <T variant="footnote" color={p.fgTertiary} style={{ padding: 16 }}>No text diff (binary or too large).</T>) : null}
							</View>
						))}
					</View>
				)}
			</ScrollView>
			{open && pr.viewerCanMerge ? (
				<View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: p.sidebar, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
					{pr.state === 'draft'
						? <Button label="Ready for review" icon="check" variant="primary" flex busy={busy} onPress={() => void act(() => client.markPullRequestReady(root, pr.number), 'Ready for review')} />
						: <Button label={pr.readyToMerge ? 'Merge' : pr.mergeable === 'conflicting' ? 'Conflicts' : 'Merge…'} icon="branch" variant={pr.readyToMerge ? 'primary' : 'secondary'} flex busy={busy} disabled={pr.mergeable === 'conflicting' || !methods.length} onPress={() => setMergeSheet(true)} />}
				</View>
			) : null}
			<ActionSheet visible={mergeSheet} onClose={() => setMergeSheet(false)} title="Merge pull request" subtitle={pr.readyToMerge ? undefined : 'Checks or reviews are not all green yet.'} actions={mergeActions} />
			<ConfirmSheet visible={!!confirmMerge} onClose={() => setConfirmMerge(undefined)} title={confirmMerge ? `${MERGE_LABEL[confirmMerge]}?` : ''}
				body={`#${pr.number} goes into ${pr.baseRefName}${pr.mergeOptions.deleteBranchOnMerge ? ` and ${pr.headRefName} is deleted` : ''}.`} confirm="Merge"
				onConfirm={() => confirmMerge && void act(() => client.mergePullRequest(root, pr.number, { method: confirmMerge, headOid: pr.headRefOid, deleteBranch: pr.mergeOptions.deleteBranchOnMerge }), `Merged #${pr.number}`)} />
			<InputSheet visible={commenting} onClose={() => setCommenting(false)} title="Comment" placeholder="Leave a comment" confirm="Comment"
				onSubmit={body => body.trim() && void act(() => client.commentOnPullRequest(root, pr.number, body.trim()), 'Comment posted')} />
		</View>
	);
}

/** GitHub's merge box: checks, reviews and whether it can merge. */
function MergeBox({ pr }: { readonly pr: IPullRequestDetail }) {
	const { p } = useTheme();
	if (pr.state === 'merged' || pr.state === 'closed') {
		return null;
	}
	const lines: { icon: 'checkCircle' | 'xCircle' | 'circleDashed' | 'alertCircle'; color: string; text: string }[] = [];
	if (pr.checks.total) {
		lines.push(pr.checks.state === 'success' ? { icon: 'checkCircle', color: p.success, text: 'All checks have passed' }
			: pr.checks.state === 'failure' ? { icon: 'xCircle', color: p.danger, text: `${pr.checks.failed} failing ${pr.checks.failed === 1 ? 'check' : 'checks'}` }
				: { icon: 'circleDashed', color: p.warning, text: `${pr.checks.pending} ${pr.checks.pending === 1 ? 'check' : 'checks'} running` });
	}
	if (pr.reviewDecision) {
		lines.push(pr.reviewDecision === 'approved' ? { icon: 'checkCircle', color: p.success, text: 'Approved' } : pr.reviewDecision === 'changesRequested' ? { icon: 'xCircle', color: p.danger, text: 'Changes requested' } : { icon: 'alertCircle', color: p.warning, text: 'Review required' });
	}
	lines.push(pr.mergeable === 'conflicting' ? { icon: 'xCircle', color: p.danger, text: 'This branch has conflicts' } : pr.readyToMerge ? { icon: 'checkCircle', color: p.success, text: 'Ready to merge' } : { icon: 'alertCircle', color: p.fgTertiary, text: pr.mergeState === 'behind' ? 'Behind the base branch' : pr.mergeState === 'blocked' ? 'Merging is blocked' : 'Not ready to merge yet' });
	return (
		<View style={{ marginHorizontal: 16, marginTop: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.surface, overflow: 'hidden' }}>
			{lines.map((line, i) => (
				<View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
					<Icon name={line.icon} size={17} color={line.color} />
					<T variant="body" weight="500">{line.text}</T>
				</View>
			))}
			{pr.checks.failing.length ? <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}><ChecksBadge checks={pr.checks} /><T variant="footnote" color={p.fgTertiary} numberOfLines={2}>{pr.checks.failing.join(', ')}</T></View> : null}
		</View>
	);
}

function Comment({ author, at, body, state }: { readonly author: string; readonly at: number; readonly body: string; readonly state?: string }) {
	const { p } = useTheme();
	return (
		<View style={{ borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: p.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
				<View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: p.fillStrong, alignItems: 'center', justifyContent: 'center' }}><T variant="caption" weight="700">{author.slice(0, 1).toUpperCase()}</T></View>
				<T variant="small" weight="600">{author}</T>
				{state && state !== 'COMMENTED' ? <T variant="footnote" weight="600" color={state === 'APPROVED' ? p.success : state === 'CHANGES_REQUESTED' ? p.danger : p.fgTertiary}>{state === 'APPROVED' ? 'approved' : state === 'CHANGES_REQUESTED' ? 'requested changes' : state.toLowerCase()}</T> : null}
				<View style={{ flex: 1 }} />
				<T variant="footnote" color={p.fgQuaternary}>{relativeTime(at)}</T>
			</View>
			<View style={{ padding: 12 }}><Markdown text={body} compact /></View>
		</View>
	);
}
