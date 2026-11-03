/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IChatListItem, type IconName, PROVIDER_COLORS, relativeTime, statusColor } from '@volt/client-core';
import { memo, useRef } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { useClient } from '../state/client';
import { useRunGroupOfChat } from './RunGroups';
import { useTheme } from '../theme/theme';
import { haptic, Icon, LiveTimer, StatusIcon, T, Tap } from '../ui/core';

function SwipeAction({ icon, label, color, progress, onPress, align }: { readonly icon: IconName; readonly label: string; readonly color: string; readonly progress: SharedValue<number>; readonly onPress: () => void; readonly align: 'left' | 'right' }) {
	const { p } = useTheme();
	const style = useAnimatedStyle(() => ({
		opacity: interpolate(progress.value, [0, 0.6, 1], [0, 0.6, 1]),
		transform: [{ scale: interpolate(progress.value, [0, 1], [0.6, 1]) }],
	}));
	return (
		<Tap onPress={onPress} accessibilityLabel={label} style={{ width: 72, alignItems: 'center', justifyContent: 'center', gap: 5 }}>
			<Animated.View style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }, style]}>
				<Icon name={icon} size={19} color="#fff" />
			</Animated.View>
			<T variant="caption" weight="600" color={p.fgSecondary} align={align === 'left' ? 'left' : 'right'}>{label}</T>
		</Tap>
	);
}

/**
 * One chat in a list, GitHub-notification style: its status, project and branch, title and latest
 * line, swipeable (pin and archive to the left, settle to the right) and long-pressable for every action.
 */
export const ChatRow = memo(function ChatRow({ item, onPress, onLongPress }: { readonly item: IChatListItem; readonly onPress: (item: IChatListItem) => void; readonly onLongPress: (item: IChatListItem) => void }) {
	const { p } = useTheme();
	const client = useClient();
	const swipe = useRef<SwipeableMethods>(null);
	const statusTone = item.status === 'idle' ? undefined : statusColor(item.status, p);
	const close = () => swipe.current?.close();
	const dim = item.settled || item.snoozed;
	const runGroup = useRunGroupOfChat(item.id);
	return (
		<ReanimatedSwipeable
			ref={swipe}
			friction={1.8}
			leftThreshold={64}
			rightThreshold={64}
			overshootLeft={false}
			overshootRight={false}
			onSwipeableWillOpen={() => haptic.medium()}
			renderLeftActions={progress => (
				<View style={{ flexDirection: 'row', paddingLeft: 12 }}>
					<SwipeAction icon={item.snoozed ? 'sun' : 'inbox'} label={item.snoozed ? 'Wake' : item.settled ? 'Unsettle' : 'Settle'} color={p.success} progress={progress} align="left" onPress={() => {
						close();
						void (item.snoozed ? client.wake(item.id) : client.setSettled(item.id, !item.settled));
					}} />
				</View>
			)}
			renderRightActions={progress => (
				<View style={{ flexDirection: 'row', paddingRight: 12 }}>
					<SwipeAction icon="pin" label={item.pinned ? 'Unpin' : 'Pin'} color={p.accent} progress={progress} align="right" onPress={() => {
						close();
						void client.setPinned(item.id, !item.pinned);
					}} />
					<SwipeAction icon="archive" label={item.archived ? 'Restore' : 'Archive'} color="#6B7280" progress={progress} align="right" onPress={() => {
						close();
						void client.setArchived(item.id, !item.archived);
					}} />
				</View>
			)}
		>
			<Tap
				onPress={() => onPress(item)}
				onLongPress={() => {
					haptic.medium();
					onLongPress(item);
				}}
				delayLongPress={320}
				style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: p.canvas, opacity: dim ? 0.62 : 1 }}
			>
				<View style={{ width: 22, alignItems: 'center', paddingTop: 2 }}>
					<StatusIcon status={item.status} size={17} />
				</View>
				<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
						<T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>
							{item.projectName ?? 'No project'}{item.branch ? <T variant="footnote" color={p.fgQuaternary}>{`  ${item.branch}`}</T> : null}
						</T>
						{item.pinned ? <Icon name="pin" size={11} color={p.fgQuaternary} /> : null}
						<View style={{ flex: 1 }} />
						{item.status === 'working' && item.workingSince
							? <LiveTimer since={item.workingSince} color={p.info} />
							: <T variant="footnote" color={statusTone && item.status !== 'unread' ? statusTone : p.fgQuaternary} weight={statusTone && item.status !== 'unread' ? '600' : '400'}>{item.status !== 'idle' && item.status !== 'unread' ? item.statusLabel : relativeTime(item.updatedAt)}</T>}
						{item.unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent, marginLeft: 2 }} /> : null}
					</View>
					<T variant="callout" weight={item.unread ? '700' : '600'} numberOfLines={2} style={{ letterSpacing: -0.2 }}>{item.title}</T>
					{item.error || (item.preview && item.preview !== item.title) ? <T variant="small" color={item.error ? p.danger : p.fgTertiary} numberOfLines={1}>{item.error ?? item.preview}</T> : null}
					{item.draft || item.queued || item.subagents || item.model || runGroup ? (
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
							{item.draft ? <Badge icon="pencil" text="Draft" /> : null}
							{item.queued ? <Badge icon="queue" text={`${item.queued} queued`} /> : null}
							{runGroup ? <Badge icon="layers" text={`Compare · ${runGroup.runs.length} models`} /> : null}
							{item.subagents ? <Badge icon="agents" text={`${item.subagents} ${item.subagents === 1 ? 'subagent' : 'subagents'}`} /> : null}
							{item.model ? (
								<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
									<View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: modelColor(item.model) }} />
									<T variant="caption" color={p.fgQuaternary} numberOfLines={1}>{item.model}</T>
								</View>
							) : null}
						</View>
					) : null}
				</View>
			</Tap>
		</ReanimatedSwipeable>
	);
});

function modelColor(model: string): string {
	const m = model.toLowerCase();
	return m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku') || m.includes('fable') ? PROVIDER_COLORS.claude
		: m.includes('gpt') || m.includes('codex') || m.includes('o3') || m.includes('o4') ? PROVIDER_COLORS.codex
			: m.includes('gemini') ? PROVIDER_COLORS.gemini
				: m.includes('grok') ? PROVIDER_COLORS.grok
					: PROVIDER_COLORS.generic;
}

function Badge({ icon, text }: { readonly icon: IconName; readonly text: string }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 18, paddingHorizontal: 6, borderRadius: 6, backgroundColor: p.fill }}>
			<Icon name={icon} size={10} color={p.fgTertiary} />
			<T variant="caption" color={p.fgTertiary}>{text}</T>
		</View>
	);
}
