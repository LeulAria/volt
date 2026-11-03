/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	activeRuns, archiveRunGroup, canPickRun, errorMessage, formatRunCost, formatRunTime, formatRunTokens, type IRunGroup, type IRunGroupRun, isRunLive, pickRunWinner, PROVIDER_COLORS,
	projectRecords, refreshRunStats, retryRunSetup, runGroupBase, runGroupSummary, runStatusLabel, runStatusOf, runStatusTone, runWorkMs, type RunWinnerAction, statusColor, stopRunGroup,
	winnerActionDetail, winnerActionLabel
} from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRunGroup } from '../../src/home/RunGroups';
import { useClient, useCollections, useNow, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Button, EmptyState, haptic, Icon, IconButton, StatusIcon, T, Tap } from '../../src/ui/core';
import { ConfirmSheet, Sheet } from '../../src/ui/sheets';

export default function RunGroupScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	return useOptionalClient() && id ? <RunGroupView groupId={id} /> : null;
}

function familyColor(family: string): string {
	return (PROVIDER_COLORS as Record<string, string>)[family] ?? PROVIDER_COLORS.generic;
}

/**
 * One prompt on several models, side by side (stacked on a phone): each run's status, time,
 * changes against the base and latest reply, with its chat a tap away. Stop a run or all of them,
 * and pick the winner (merge, check out its branch, or open a pull request), as on the desktop.
 */
function RunGroupView({ groupId }: { readonly groupId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const group = useRunGroup(groupId);
	const projects = useCollections(['projects']);
	const project = useMemo(() => group?.projectId ? projectRecords(projects).find(pr => pr.id === group.projectId) : undefined, [projects, group?.projectId]);
	const { width } = useWindowDimensions();
	const live = !!group?.rollup?.live;
	const now = useNow(1000, live);
	const [refreshing, setRefreshing] = useState(false);
	const [winner, setWinner] = useState<IRunGroupRun | undefined>();
	const [stopAll, setStopAll] = useState(false);

	useEffect(() => {
		void refreshRunStats(client, groupId).catch(() => undefined);
	}, [client, groupId]);

	if (!group) {
		return (
			<View style={{ flex: 1, backgroundColor: p.canvas }}>
				<Stack.Screen options={{ title: 'Compare models' }} />
				<EmptyState icon="layers" title="This comparison no longer exists." />
			</View>
		);
	}

	const runs = activeRuns(group);
	const columns = width >= 700 ? Math.min(runs.length, width >= 1100 ? 3 : 2) : 1;
	const winnerRun = group.winner ? group.runs.find(run => run.id === group.winner!.runId) : undefined;
	const clock = now || Date.now();

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{
				title: 'Compare models',
				headerRight: () => (
					<View style={{ flexDirection: 'row' }}>
						{live ? <IconButton icon="stop" label="Stop all" color={p.danger} onPress={() => setStopAll(true)} /> : null}
						{!group.archived ? <IconButton icon="archive" label="Archive this comparison" color={p.fg} onPress={() => {
							void archiveRunGroup(client, groupId).then(() => {
								haptic.success();
								client.toast('success', 'Comparison archived');
								router.back();
							}, err => client.toast('error', errorMessage(err)));
						}} /> : null}
					</View>
				),
			}} />
			<ScrollView
				contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 14 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					void refreshRunStats(client, groupId).catch(() => undefined).finally(() => setRefreshing(false));
				}} />}
			>
				<View style={{ gap: 6 }}>
					<T variant="title2" weight="700" style={{ letterSpacing: -0.3 }}>{group.title}</T>
					<View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
						<StatusIcon status={group.rollup?.status === 'needsInput' ? 'question' : group.rollup?.status === 'running' ? 'working' : group.rollup?.status === 'failed' ? 'failed' : group.rollup?.status === 'stopped' ? 'stopped' : 'unread'} size={14} />
						<T variant="small" color={p.fgSecondary}>{runGroupSummary(group)}</T>
						<T variant="small" color={p.fgQuaternary}>·</T>
						<Icon name="branch" size={12} color={p.fgTertiary} />
						<T variant="small" mono color={p.fgTertiary}>{`from ${runGroupBase(group)}`}</T>
						{project ? <><T variant="small" color={p.fgQuaternary}>·</T><T variant="small" color={p.fgTertiary}>{project.displayName}</T></> : null}
					</View>
				</View>

				{winnerRun && group.winner ? (
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: `${p.success}1A`, borderWidth: StyleSheet.hairlineWidth, borderColor: `${p.success}55` }}>
						<Icon name="checkCircle" size={18} color={p.success} />
						<T variant="small" weight="600" color={p.success} style={{ flex: 1 }}>{`${winnerRun.model.label} won · ${winnerActionLabel(group.winner.action, group.base.ref)}`}</T>
					</View>
				) : null}

				<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
					{runs.map(run => (
						<View key={run.id} style={{ width: columns === 1 ? '100%' : `${100 / columns - 2}%`, flexGrow: 1 }}>
							<RunCard group={group} run={run} now={clock} onPick={() => setWinner(run)} />
						</View>
					))}
				</View>

				{group.runs.length > runs.length ? (
					<T variant="footnote" color={p.fgQuaternary} align="center">{`${group.runs.length - runs.length} other run${group.runs.length - runs.length === 1 ? ' was' : 's were'} archived.`}</T>
				) : null}
			</ScrollView>

			<WinnerSheet group={group} run={winner} onClose={() => setWinner(undefined)} />
			<ConfirmSheet
				visible={stopAll}
				onClose={() => setStopAll(false)}
				title="Stop every run?"
				body="Live turns are cancelled and setups still running are aborted."
				confirm="Stop all"
				destructive
				onConfirm={() => void stopRunGroup(client, groupId).catch(err => client.toast('error', errorMessage(err)))}
			/>
		</View>
	);
}

function RunCard({ group, run, now, onPick }: { readonly group: IRunGroup; readonly run: IRunGroupRun; readonly now: number; readonly onPick: () => void }) {
	const { p } = useTheme();
	const client = useClient();
	const status = runStatusOf(group, run.id);
	const tone = runStatusTone(status);
	const isWinner = group.winner?.runId === run.id;
	const live = isRunLive(status) || status === 'needsInput';
	const failedStep = run.setup.steps.find(step => step.state === 'failed');
	const [busy, setBusy] = useState<'stop' | 'retry' | undefined>();
	const stats = run.stats;
	const metrics: { readonly label: string; readonly value: string; readonly color?: string }[] = [
		{ label: 'Time', value: run.workMs || run.activeSince ? formatRunTime(runWorkMs(run, now)) : '—' },
		{ label: 'Files', value: stats ? String(stats.files) : '—' },
		{ label: 'Lines', value: stats ? `+${stats.additions} −${stats.deletions}` : '—' },
		{ label: 'Tokens', value: formatRunTokens(run) },
		{ label: 'Cost', value: formatRunCost(run) },
	];
	return (
		<View style={{ borderRadius: 16, backgroundColor: p.surface, borderWidth: isWinner ? 1.5 : StyleSheet.hairlineWidth, borderColor: isWinner ? p.success : p.stroke, overflow: 'hidden' }}>
			<View style={{ padding: 14, gap: 10 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
					<View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: familyColor(run.model.family) }} />
					<T variant="callout" weight="700" numberOfLines={1} style={{ flex: 1, letterSpacing: -0.2 }}>{run.model.label}</T>
					{isWinner ? (
						<View style={{ height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: `${p.success}22`, justifyContent: 'center' }}>
							<T variant="caption" weight="700" color={p.success}>Winner</T>
						</View>
					) : null}
				</View>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<StatusIcon status={tone} size={13} />
					<T variant="small" weight="600" color={tone === 'idle' ? p.fgTertiary : statusColor(tone, p)} style={{ fontVariant: ['tabular-nums'] }}>{runStatusLabel(status, run, now)}</T>
				</View>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
					<Icon name="branch" size={12} color={p.fgQuaternary} />
					<T variant="caption" mono color={p.fgTertiary} numberOfLines={1} style={{ flex: 1 }}>{run.branch}</T>
				</View>

				<View style={{ flexDirection: 'row', borderRadius: 12, backgroundColor: p.fillFaint, paddingVertical: 8 }}>
					{metrics.map(metric => (
						<View key={metric.label} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
							<T variant="caption" color={p.fgQuaternary}>{metric.label}</T>
							<T variant="small" weight="600" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
								{metric.label === 'Lines' && stats ? <><T variant="small" weight="600" color={p.diffAddedFg}>{`+${stats.additions}`}</T><T variant="small" weight="600" color={p.diffRemovedFg}>{` −${stats.deletions}`}</T></> : metric.value}
							</T>
						</View>
					))}
				</View>

				{run.setup.error && (status === 'setupFailed') ? (
					<View style={{ gap: 4, padding: 10, borderRadius: 10, backgroundColor: `${p.danger}14` }}>
						<T variant="small" color={p.danger} numberOfLines={3}>{run.setup.error}</T>
						{failedStep?.tail ? <T variant="caption" mono color={p.fgTertiary} numberOfLines={4}>{failedStep.tail}</T> : null}
					</View>
				) : (
					<T variant="small" color={stats?.lastMessage ? p.fgSecondary : p.fgQuaternary} numberOfLines={4}>
						{stats?.lastMessage ?? (live ? 'No reply yet.' : 'No reply.')}
					</T>
				)}
			</View>

			<View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 14 }}>
				<Button size="sm" label="Open chat" icon="message" onPress={() => router.push({ pathname: '/chat/[id]', params: { id: run.id } })} flex />
				{live ? (
					<Button size="sm" label="Stop" icon="stop" variant="danger" busy={busy === 'stop'} onPress={() => {
						setBusy('stop');
						void stopRunGroup(client, group.id, run.id).catch(err => client.toast('error', errorMessage(err))).finally(() => setBusy(undefined));
					}} />
				) : null}
				{status === 'setupFailed' ? (
					<Button size="sm" label="Retry" icon="refresh" busy={busy === 'retry'} onPress={() => {
						setBusy('retry');
						void retryRunSetup(client, group.id, run.id).catch(err => client.toast('error', errorMessage(err))).finally(() => setBusy(undefined));
					}} />
				) : null}
				{!group.winner ? (
					<Button size="sm" label="Pick winner" icon="checkCircle" variant="primary" disabled={!canPickRun(group, run)} onPress={onPick} />
				) : null}
			</View>
		</View>
	);
}

/** Merge into the base, check its branch out, or open a pull request; the other runs are archived. */
function WinnerSheet({ group, run, onClose }: { readonly group: IRunGroup; readonly run: IRunGroupRun | undefined; readonly onClose: () => void }) {
	const { p } = useTheme();
	const client = useClient();
	const [action, setAction] = useState<RunWinnerAction>(group.base.ref ? 'merge' : 'checkout');
	const [removeOthers, setRemoveOthers] = useState(false);
	const [busy, setBusy] = useState(false);
	const others = run ? group.runs.filter(other => other.id !== run.id && !other.discarded && other.worktreePath && !other.worktreeRemoved).length : 0;
	const actions: readonly RunWinnerAction[] = group.base.ref ? ['merge', 'checkout', 'pr'] : ['checkout', 'pr'];
	const confirm = async () => {
		if (!run) {
			return;
		}
		setBusy(true);
		try {
			const result = await pickRunWinner(client, group.id, run.id, action, removeOthers);
			if (!result.ok) {
				client.toast('error', result.error ?? 'Could not pick the winner.');
				return;
			}
			haptic.success();
			onClose();
			if (result.kept?.length) {
				client.toast('info', `Kept ${result.kept.length} worktree${result.kept.length === 1 ? '' : 's'} that could not be removed.`);
			}
			if (result.pullRequest?.worktreePath) {
				router.push({ pathname: '/pull-new', params: { root: result.pullRequest.worktreePath, branch: result.pullRequest.branch } });
			} else {
				client.toast('success', `${run.model.label} won · ${winnerActionLabel(action, group.base.ref)}`);
			}
		} catch (err) {
			client.toast('error', errorMessage(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet visible={!!run} onClose={onClose} title={run ? `Pick ${run.model.label} as the winner?` : 'Pick winner'} subtitle={run?.branch}>
			{actions.map(id => (
				<Tap key={id} haptics="selection" onPress={() => setAction(id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: action === id ? p.fill : 'transparent' }}>
					<Icon name={id === 'merge' ? 'branch' : id === 'checkout' ? 'folder' : 'pullRequest'} size={19} color={action === id ? p.fg : p.fgSecondary} />
					<T variant="callout" weight={action === id ? '600' : '400'} style={{ flex: 1 }}>{winnerActionLabel(id, group.base.ref)}</T>
					{action === id ? <Icon name="check" size={18} color={p.accent} strokeWidth={2.2} /> : null}
				</Tap>
			))}
			{run ? <T variant="footnote" color={p.fgTertiary} style={{ paddingHorizontal: 12, paddingTop: 8 }}>{winnerActionDetail(action, group, run)}</T> : null}
			{others ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: 12 }}>
					<T variant="small" color={p.fgSecondary} style={{ flex: 1 }}>{`Also delete their worktrees and branches (${others})`}</T>
					<Switch value={removeOthers} onValueChange={setRemoveOthers} trackColor={{ true: p.danger, false: p.fillStrong }} />
				</View>
			) : null}
			<View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 8, paddingTop: 16 }}>
				<Button label="Cancel" variant="secondary" onPress={onClose} flex />
				<Button label="Pick winner" variant="primary" busy={busy} onPress={() => void confirm()} flex />
			</View>
		</Sheet>
	);
}
