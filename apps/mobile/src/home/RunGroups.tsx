/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IRunGroup, relativeTime, runGroupBase, runGroupById, runGroupOfChat, runGroupSummary, selectRunGroups } from '@volt/client-core';
import { router } from 'expo-router';
import { memo } from 'react';
import { View } from 'react-native';
import { useCollections } from '../state/client';
import { useTheme } from '../theme/theme';
import { Icon, StatusIcon, T, Tap } from '../ui/core';

const GROUP_COLLECTIONS = ['runGroups'];

/** Every model comparison on the computer, newest first. */
export function useRunGroups(): readonly IRunGroup[] {
	return selectRunGroups(useCollections(GROUP_COLLECTIONS));
}

export function useRunGroup(groupId: string): IRunGroup | undefined {
	return runGroupById(useCollections(GROUP_COLLECTIONS), groupId);
}

/** The comparison a chat is one of the runs of. */
export function useRunGroupOfChat(chatId: string): IRunGroup | undefined {
	return runGroupOfChat(useCollections(GROUP_COLLECTIONS), chatId);
}

export function openRunGroup(groupId: string): void {
	router.push({ pathname: '/group/[id]', params: { id: groupId } });
}

/** The group's status as a chat-list tone: someone waiting on you, then anything running. */
export function groupTone(group: IRunGroup): 'question' | 'working' | 'failed' | 'unread' | 'stopped' {
	switch (group.rollup?.status) {
		case 'needsInput': return 'question';
		case 'running': return 'working';
		case 'failed': return 'failed';
		case 'stopped': return 'stopped';
		default: return 'unread';
	}
}

/** One comparison in a list: its status, prompt, models and how far the runs got. */
export const RunGroupRow = memo(function RunGroupRow({ group, projectName }: { readonly group: IRunGroup; readonly projectName?: string }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={() => openRunGroup(group.id)} style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
			<View style={{ width: 22, alignItems: 'center', paddingTop: 2 }}>
				<StatusIcon status={groupTone(group)} size={17} />
			</View>
			<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<Icon name="layers" size={12} color={p.fgTertiary} />
					<T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>
						{projectName ? `${projectName}  ` : ''}<T variant="footnote" color={p.fgQuaternary}>{`from ${runGroupBase(group)}`}</T>
					</T>
					<View style={{ flex: 1 }} />
					<T variant="footnote" color={p.fgQuaternary}>{relativeTime(group.createdAt)}</T>
				</View>
				<T variant="callout" weight="600" numberOfLines={2} style={{ letterSpacing: -0.2 }}>{group.title}</T>
				<T variant="small" color={p.fgTertiary} numberOfLines={1}>{runGroupSummary(group)}</T>
			</View>
			<Icon name="chevronRight" size={15} color={p.fgQuaternary} />
		</Tap>
	);
});
