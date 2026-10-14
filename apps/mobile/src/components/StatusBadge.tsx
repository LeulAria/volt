import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, cancelAnimation } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import type { AgentHomeStatusBadgeKind, IAgentHomeStatusBadge } from '@/core/voltCore';
import { colors } from '@/lib/theme';
import { Text } from './Text';

/** The agent window's badge colors (agentHomePane.css). */
const BADGE_COLORS: Record<AgentHomeStatusBadgeKind, string> = {
	input: '#7c8cf0',
	done: colors.green,
	working: colors.blue,
	woke: colors.warning,
	limited: colors.warning,
	interrupted: colors.warning,
	failed: colors.red,
	draft: colors.textTertiary,
};

function BadgeGlyph({ kind, color }: { readonly kind: AgentHomeStatusBadgeKind; readonly color: string }) {
	switch (kind) {
		case 'working':
			return (
				<Svg width={13} height={13} viewBox="0 0 16 16" fill="none">
					<Circle cx={8} cy={8} r={6} stroke={color} strokeWidth={1.4} strokeDasharray="2.2 2.2" />
				</Svg>
			);
		case 'done':
			return (
				<Svg width={13} height={13} viewBox="0 0 16 16" fill="none">
					<Circle cx={8} cy={8} r={6} stroke={color} strokeWidth={1.3} />
					<Path d="M5.4 8.2l1.8 1.8 3.4-3.6" stroke={color} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
				</Svg>
			);
		case 'failed':
		case 'interrupted':
		case 'limited':
			return (
				<Svg width={13} height={13} viewBox="0 0 16 16" fill="none">
					<Circle cx={8} cy={8} r={6} stroke={color} strokeWidth={1.3} />
					<Path d="M8 4.8v3.8M8 10.9v.1" stroke={color} strokeWidth={1.4} strokeLinecap="round" />
				</Svg>
			);
		default:
			return (
				<Svg width={13} height={13} viewBox="0 0 16 16" fill="none">
					<Circle cx={8} cy={8} r={6} stroke={color} strokeWidth={1.3} />
					<Circle cx={8} cy={8} r={2} fill={color} />
				</Svg>
			);
	}
}

/** "Working 45s", "Done", "Interrupted": the badge at the end of a chat row. */
export function StatusBadge({ badge }: { readonly badge: IAgentHomeStatusBadge | undefined }) {
	const spin = useSharedValue(0);
	const working = badge?.kind === 'working';
	useEffect(() => {
		if (working) {
			spin.value = withRepeat(withTiming(360, { duration: 2400, easing: Easing.linear }), -1, false);
		} else {
			cancelAnimation(spin);
			spin.value = 0;
		}
	}, [working, spin]);
	const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }));
	if (!badge) {
		return null;
	}
	const color = BADGE_COLORS[badge.kind] ?? colors.textTertiary;
	return (
		<View style={styles.badge}>
			<Animated.View style={spinStyle}><BadgeGlyph kind={badge.kind} color={color} /></Animated.View>
			<Text size={12} color={color} numberOfLines={1}>{badge.label}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	badge: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
});
