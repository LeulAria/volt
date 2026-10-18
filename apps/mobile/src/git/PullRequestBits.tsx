/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IPullRequestChecks, type IPullRequestSummary, type IVoltPalette, type PullRequestState, relativeTime } from '@volt/client-core';
import { memo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon, T, Tap } from '../ui/core';

export function pullRequestColor(state: PullRequestState, p: IVoltPalette): string {
	return state === 'open' ? p.success : state === 'merged' ? p.violet : state === 'draft' ? p.fgTertiary : p.danger;
}

export const PULL_REQUEST_STATE_LABEL: Record<PullRequestState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

export function PullRequestStateIcon({ state, size = 17 }: { readonly state: PullRequestState; readonly size?: number }) {
	const { p } = useTheme();
	return <Icon name={state === 'merged' ? 'branch' : state === 'closed' ? 'xCircle' : 'pullRequest'} size={size} color={pullRequestColor(state, p)} />;
}

/** GitHub's state pill: Open (green), Draft (grey), Merged (purple), Closed (red). */
export function PullRequestStatePill({ state }: { readonly state: PullRequestState }) {
	const { p } = useTheme();
	const color = pullRequestColor(state, p);
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: color }}>
			<Icon name={state === 'merged' ? 'branch' : state === 'closed' ? 'xCircle' : 'pullRequest'} size={13} color="#fff" strokeWidth={2} />
			<T variant="footnote" weight="700" color="#fff">{PULL_REQUEST_STATE_LABEL[state]}</T>
		</View>
	);
}

export function ChecksBadge({ checks }: { readonly checks: IPullRequestChecks }) {
	const { p } = useTheme();
	if (checks.state === 'none' || !checks.total) {
		return null;
	}
	const color = checks.state === 'success' ? p.success : checks.state === 'failure' ? p.danger : p.warning;
	const text = checks.state === 'success' ? `${checks.passed}/${checks.total} checks` : checks.state === 'failure' ? `${checks.failed} failing` : `${checks.pending} running`;
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
			<Icon name={checks.state === 'success' ? 'checkCircle' : checks.state === 'failure' ? 'xCircle' : 'circleDashed'} size={13} color={color} />
			<T variant="footnote" color={color}>{text}</T>
		</View>
	);
}

/** A pull request in a list, as the GitHub app's: state icon, repo and number, title, branch, checks. */
export const PullRequestRow = memo(function PullRequestRow({ pr, onPress }: { readonly pr: IPullRequestSummary; readonly onPress: (pr: IPullRequestSummary) => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={() => onPress(pr)} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
			<View style={{ width: 22, alignItems: 'center', paddingTop: 2 }}><PullRequestStateIcon state={pr.state} /></View>
			<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>{pr.repo.owner}/{pr.repo.name} #{pr.number}</T>
					<View style={{ flex: 1 }} />
					<T variant="footnote" color={p.fgQuaternary}>{relativeTime(pr.updatedAt)}</T>
				</View>
				<T variant="callout" weight="600" numberOfLines={2} style={{ letterSpacing: -0.2 }}>{pr.title}</T>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
					<T variant="caption" mono color={p.fgQuaternary} numberOfLines={1}>{pr.headRefName}</T>
					<ChecksBadge checks={pr.checks} />
					{pr.reviewDecision === 'approved' ? <T variant="footnote" color={p.success}>Approved</T> : pr.reviewDecision === 'changesRequested' ? <T variant="footnote" color={p.danger}>Changes requested</T> : null}
					{pr.comments ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}><Icon name="message" size={12} color={p.fgQuaternary} /><T variant="footnote" color={p.fgQuaternary}>{pr.comments}</T></View> : null}
				</View>
			</View>
		</Tap>
	);
});
