/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BottomTabBarProps } from 'expo-router/tabs';
import { Tabs } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useOpenPulls } from '../../src/git/openPulls';
import { inboxItems } from '../../src/home/inbox';
import { Loading, Welcome } from '../../src/home/Welcome';
import { useChatItems, useOptionalClient } from '../../src/state/client';
import { useActiveEnvironment } from '../../src/state/environments';
import { useTheme } from '../../src/theme/theme';
import { RAIL_WIDTH, useAdaptive } from '../../src/ui/adaptive';
import { haptic, T } from '../../src/ui/core';

/** Tabler's smart-home, then lucide's inbox, git-pull-request, layers and circle-user-round (from aria-icons), drawn with 1px lines. */
const TAB_ICONS: Record<string, readonly string[]> = {
	index: ['M19 8.71l-5.333 -4.148a2.666 2.666 0 0 0 -3.274 0l-5.334 4.148a2.665 2.665 0 0 0 -1.029 2.105v7.2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-7.2c0 -.823 -.38 -1.6 -1.03 -2.105', 'M16 15c-2.21 1.333 -5.792 1.333 -8 0'],
	inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
	prs: ['M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M13 6h3a2 2 0 0 1 2 2v7', 'M6 9v12'],
	projects: ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z', 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12', 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'],
	you: ['M18 20a6 6 0 0 0-12 0', 'M8 10a4 4 0 1 0 8 0a4 4 0 1 0-8 0Z', 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0Z'],
};
const ICON_SIZE = 24;
const STROKE = 1;
/** Wider than the bar is tall, so the circle spills past its top edge. */
const RIPPLE_SIZE = 92;

/**
 * Home, Inbox, Pull requests, Projects and You, as the GitHub app's bottom tabs; on a wide window
 * (an open iPhone Duo or fold, a tablet) they stand in a rail down the left side instead.
 */
export default function TabsLayout() {
	const environment = useActiveEnvironment();
	const client = useOptionalClient();
	const { p } = useTheme();
	const { expanded } = useAdaptive();
	if (!environment) {
		return <Welcome />;
	}
	if (!client) {
		return <Loading />;
	}
	return (
		<Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: p.canvas }, tabBarPosition: expanded ? 'left' : 'bottom' }} tabBar={props => <TabBar {...props} />}>
			<Tabs.Screen name="index" options={{ title: 'Home' }} />
			<Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
			<Tabs.Screen name="prs" options={{ title: 'PRs' }} />
			<Tabs.Screen name="projects" options={{ title: 'Projects' }} />
			<Tabs.Screen name="you" options={{ title: 'You' }} />
		</Tabs>
	);
}

function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const items = useChatItems();
	const badge = useMemo(() => inboxItems(items, 'all').filter(item => item.unread || item.status === 'approval' || item.status === 'question').length, [items]);
	const pulls = useOpenPulls().pulls.length;
	const { expanded } = useAdaptive();
	return (
		<View style={expanded
			? { width: RAIL_WIDTH, backgroundColor: p.sidebar, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: p.stroke, paddingTop: insets.top + 14, paddingBottom: Math.max(insets.bottom, 12), paddingLeft: insets.left, gap: 6 }
			: { flexDirection: 'row', backgroundColor: p.sidebar, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.stroke, paddingBottom: Math.max(insets.bottom, 8), paddingTop: 6 }}>
			{state.routes.map((route, index) => {
				const focused = state.index === index;
				return (
					<TabButton
						key={route.key}
						title={descriptors[route.key]?.options.title ?? route.name}
						icon={TAB_ICONS[route.name] ?? []}
						focused={focused}
						badge={route.name === 'inbox' ? badge : route.name === 'prs' ? pulls : 0}
						rail={expanded}
						onPress={() => {
							const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
							if (!focused && !event.defaultPrevented) {
								navigation.navigate(route.name, route.params);
							}
						}}
					/>
				);
			})}
		</View>
	);
}

/**
 * One tab with the YouTube app's touch feedback: an ink ripple spreads from the finger across the
 * tab and fades once released, while the icon dips and springs back.
 */
function TabButton({ title, icon, focused, badge, rail, onPress }: {
	readonly title: string;
	readonly icon: readonly string[];
	readonly focused: boolean;
	readonly badge: number;
	/** In the side rail: a fixed-height stop; like the bottom tabs, a press ripples and nothing stays highlighted. */
	readonly rail?: boolean;
	readonly onPress: () => void;
}) {
	const { p } = useTheme();
	const color = focused ? p.fg : p.fgTertiary;
	const spread = useSharedValue(0);
	const ink = useSharedValue(0);
	const pressed = useSharedValue(0);

	const onPressIn = () => {
		spread.value = 0;
		spread.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) });
		ink.value = withTiming(1, { duration: 90 });
		pressed.value = withTiming(1, { duration: 110 });
	};
	const onPressOut = () => {
		ink.value = withTiming(0, { duration: 420, easing: Easing.in(Easing.quad) });
		pressed.value = withSpring(0, { damping: 11, stiffness: 260, mass: 0.6 });
	};

	const rippleStyle = useAnimatedStyle(() => ({
		opacity: ink.value * 0.14,
		transform: [{ scale: 0.15 + 0.85 * spread.value }],
	}));
	const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.12 * pressed.value }] }));

	return (
		<Pressable
			accessibilityRole="tab"
			accessibilityState={{ selected: focused }}
			accessibilityLabel={title}
			onPressIn={onPressIn}
			onPressOut={onPressOut}
			onPress={() => {
				haptic.selection();
				onPress();
			}}
			style={rail ? styles.railTab : styles.tab}
		>
			<View pointerEvents="none" style={styles.rippleFrame}>
				<Animated.View style={[rail ? styles.railRipple : styles.ripple, { backgroundColor: p.fg }, rippleStyle]} />
			</View>
			<View pointerEvents="none" style={styles.content}>
				<Animated.View style={[iconStyle, rail ? styles.railPill : null]}>
					<Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round">
						{icon.map((d, i) => <Path key={i} d={d} />)}
					</Svg>
					{badge ? (
						<View style={{ position: 'absolute', top: rail ? -3 : -4, right: rail ? 2 : -10, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 9, backgroundColor: p.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: p.sidebar }}>
							<T variant="caption" weight="700" color={p.onPrimary} style={{ fontSize: 10, lineHeight: 12 }}>{badge > 99 ? '99+' : badge}</T>
						</View>
					) : null}
				</Animated.View>
				<T variant="caption" weight={focused ? '600' : '500'} color={color}>{title}</T>
			</View>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	tab: { flex: 1, minHeight: 50 },
	// Centred on the tab and free to spill past it, like the YouTube app's bottom bar.
	rippleFrame: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
	ripple: { width: RIPPLE_SIZE, height: RIPPLE_SIZE, borderRadius: RIPPLE_SIZE / 2 },
	railTab: { height: 64 },
	railRipple: { width: 60, height: 60, borderRadius: 30 },
	railPill: { width: 52, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
	content: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
});
