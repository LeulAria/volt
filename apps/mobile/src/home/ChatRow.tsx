/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IChatListItem, type IconName, PROVIDER_COLORS, relativeTime, statusColor } from '@volt/client-core';
import { memo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { useClient } from '../state/client';
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
 * One chat in the home list: a card with its project, title and latest line, swipeable (pin and
 * archive to the left, settle to the right) and long-pressable for every action.
 */
export const ChatRow = memo(function ChatRow({ item, onPress, onLongPress }: { readonly item: IChatListItem; readonly onPress: (item: IChatListItem) => void; readonly onLongPress: (item: IChatListItem) => void }) {
	const { p } = useTheme();
	const client = useClient();
	const swipe = useRef<SwipeableMethods>(null);
	const statusTone = item.status === 'idle' ? undefined : statusColor(item.status, p);
	const close = () => swipe.current?.close();
	const dim = item.settled || item.snoozed;
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
				style={{ marginHorizontal: 16, marginVertical: 4, padding: 14, borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: item.status === 'approval' || item.status === 'question' ? `${statusTone}66` : p.strokeFaint, opacity: dim ? 0.62 : 1, gap: 4 }}
			>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<StatusIcon status={item.status} size={14} />
					{item.projectName ? <T variant="footnote" weight="500" color={p.fgSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>{item.projectName}</T> : null}
					{item.pinned ? <Icon name="pin" size={11} color={p.fgQuaternary} /> : null}
					{item.queued ? <Badge icon="queue" text={String(item.queued)} /> : null}
					{item.subagents ? <Badge icon="agents" text={String(item.subagents)} /> : null}
					<View style={{ flex: 1 }} />
					{item.status === 'working' && item.workingSince
						? <LiveTimer since={item.workingSince} color={p.info} />
						: <T variant="footnote" color={statusTone ?? p.fgQuaternary} weight={statusTone ? '600' : '400'}>{item.status !== 'idle' && item.status !== 'unread' ? item.statusLabel : relativeTime(item.updatedAt)}</T>}
					{item.unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.success, marginLeft: 2 }} /> : null}
				</View>
				<T variant="callout" weight={item.unread ? '700' : '600'} numberOfLines={2} style={{ letterSpacing: -0.2 }}>{item.title}</T>
				{item.error || item.preview ? <T variant="small" color={item.error ? p.danger : p.fgTertiary} numberOfLines={1}>{item.error ?? item.preview}</T> : null}
				{item.branch || item.model ? (
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
						{item.branch ? (
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
								<Icon name="branch" size={11} color={p.fgQuaternary} />
								<T variant="caption" mono color={p.fgQuaternary} numberOfLines={1}>{item.branch}</T>
							</View>
						) : null}
						{item.model ? (
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
								<View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: modelColor(item.model) }} />
								<T variant="caption" color={p.fgQuaternary} numberOfLines={1}>{item.model}</T>
							</View>
						) : null}
					</View>
				) : null}
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
