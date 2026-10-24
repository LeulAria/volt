/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IGitRepoStatus, type IPullRequestSummary } from '@volt/client-core';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useClient } from '../state/client';
import { useTheme } from '../theme/theme';
import { Button, haptic, Icon, T, Tap } from '../ui/core';
import { InputSheet } from '../ui/sheets';
import { ChecksBadge, PullRequestStateIcon } from './PullRequestBits';

/**
 * A folder's branch and its pull request, the desktop's "Commit, Push & PR" control on a phone:
 * the branch with ahead/behind, Pull and Push, a new branch, then the branch's pull request
 * (state, checks, open it) or a way to open one.
 */
export function GitActions({ root, onChanged }: { readonly root: string; readonly onChanged?: () => void }) {
	const { p } = useTheme();
	const client = useClient();
	const [status, setStatus] = useState<IGitRepoStatus | undefined>();
	const [pr, setPr] = useState<IPullRequestSummary | null | undefined>();
	const [busy, setBusy] = useState<'push' | 'pull' | 'branch' | undefined>();
	const [branching, setBranching] = useState(false);

	const load = useCallback(async () => {
		try {
			const next = await client.gitRepoStatus(root);
			setStatus(next);
			setPr(next.isRepo && next.repo && next.branch && !next.isDefaultBranch ? await client.pullRequestForBranch(root).catch(() => null) ?? null : null);
		} catch {
			setStatus(undefined);
			setPr(null);
		}
	}, [client, root]);
	useEffect(() => {
		void load();
	}, [load]);

	const run = async (kind: 'push' | 'pull' | 'branch', action: () => Promise<unknown>, done: string) => {
		setBusy(kind);
		try {
			await action();
			haptic.success();
			client.toast('success', done);
			await load();
			onChanged?.();
		} catch (err) {
			haptic.error();
			client.toast('error', errorMessage(err));
		} finally {
			setBusy(undefined);
		}
	};

	if (!status) {
		return <View style={{ height: 44, justifyContent: 'center' }}><ActivityIndicator color={p.fgTertiary} /></View>;
	}
	if (!status.isRepo) {
		return <T variant="small" color={p.fgTertiary}>Not a git repository.</T>;
	}
	const canPush = !!status.repo || !!status.remote;
	const canOpenPr = !!status.repo && status.auth?.signedIn !== false && !status.isDefaultBranch && !pr;

	return (
		<View style={{ borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.surface, overflow: 'hidden' }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 }}>
				<Icon name="branch" size={17} color={p.fgSecondary} />
				<View style={{ flex: 1, minWidth: 0 }}>
					<T variant="body" weight="600" mono numberOfLines={1}>{status.branch ?? 'Detached HEAD'}</T>
					<T variant="footnote" color={p.fgTertiary} numberOfLines={1}>
						{status.upstream ? `${status.upstream === status.branch || status.upstream.endsWith(`/${status.branch}`) ? 'Tracking its remote' : status.upstream}${status.ahead ? `  ↑${status.ahead}` : ''}${status.behind ? `  ↓${status.behind}` : ''}${!status.ahead && !status.behind ? '  · up to date' : ''}` : canPush ? 'Not pushed yet' : 'No remote'}
					</T>
				</View>
				<Tap haptics="selection" onPress={() => setBranching(true)} accessibilityLabel="New branch" hitSlop={8} style={{ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.fill }}>
					{busy === 'branch' ? <ActivityIndicator size="small" color={p.fgTertiary} /> : <Icon name="plus" size={17} color={p.fgSecondary} />}
				</Tap>
			</View>
			{canPush ? (
				<View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
					<Button label={status.behind ? `Pull ${status.behind}` : 'Pull'} icon="arrowDown" size="sm" flex busy={busy === 'pull'} disabled={!status.upstream} onPress={() => void run('pull', () => client.gitPull(root), 'Pulled')} />
					<Button label={status.ahead ? `Push ${status.ahead}` : 'Push'} icon="arrowUp" size="sm" flex busy={busy === 'push'} disabled={!!status.upstream && !status.ahead} onPress={() => void run('push', () => client.gitPush(root), 'Pushed')} />
				</View>
			) : null}
			{pr ? (
				<Tap haptics="selection" onPress={() => router.push({ pathname: '/pull', params: { root, number: String(pr.number) } })}
					style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<PullRequestStateIcon state={pr.state} />
					<View style={{ flex: 1, minWidth: 0 }}>
						<T variant="body" weight="600" numberOfLines={1}>#{pr.number} {pr.title}</T>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
							<ChecksBadge checks={pr.checks} />
							<T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>{pr.baseRefName} ← {pr.headRefName}</T>
						</View>
					</View>
					{pr.readyToMerge ? <T variant="footnote" weight="700" color={p.success}>Ready</T> : null}
					<Icon name="chevronRight" size={15} color={p.fgQuaternary} />
				</Tap>
			) : canOpenPr ? (
				<Tap haptics="selection" onPress={() => router.push({ pathname: '/pull-new', params: { root, branch: status.branch ?? '' } })}
					style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<Icon name="pullRequest" size={17} color={p.success} />
					<T variant="body" weight="600" color={p.success} style={{ flex: 1 }}>Open a pull request</T>
					<Icon name="chevronRight" size={15} color={p.fgQuaternary} />
				</Tap>
			) : status.repo && status.auth?.signedIn === false ? (
				<View style={{ paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<T variant="footnote" color={p.fgTertiary}>Sign in to GitHub on your computer (gh auth login) to see pull requests.</T>
				</View>
			) : null}
			<InputSheet visible={branching} onClose={() => setBranching(false)} title="New branch" placeholder="feature/my-change" confirm="Create"
				onSubmit={name => name.trim() && void run('branch', () => client.gitCreateBranch(root, name.trim()), `On ${name.trim()}`)} />
		</View>
	);
}
