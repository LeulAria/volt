/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BottomTabBarProps } from 'expo-router/tabs';
import type { IconName } from '@volt/client-core';
import { Tabs } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { inboxItems } from '../../src/home/inbox';
import { Loading, Welcome } from '../../src/home/Welcome';
import { useChatItems, useOptionalClient } from '../../src/state/client';
import { useActiveEnvironment } from '../../src/state/environments';
import { useTheme } from '../../src/theme/theme';
import { Icon, T, Tap } from '../../src/ui/core';

const TAB_ICONS: Record<string, IconName> = { index: 'home', inbox: 'inbox', projects: 'layers', you: 'user' };

/** Home, Inbox, Projects and You, as the GitHub app's bottom tabs. */
export default function TabsLayout() {
	const environment = useActiveEnvironment();
	const client = useOptionalClient();
	if (!environment) {
		return <Welcome />;
	}
	if (!client) {
		return <Loading />;
	}
	return (
		<Tabs screenOptions={{ headerShown: false }} tabBar={props => <TabBar {...props} />}>
			<Tabs.Screen name="index" options={{ title: 'Home' }} />
			<Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
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
	return (
		<View style={{ flexDirection: 'row', backgroundColor: p.sidebar, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.stroke, paddingBottom: Math.max(insets.bottom, 8), paddingTop: 6 }}>
			{state.routes.map((route, index) => {
				const focused = state.index === index;
				const title = descriptors[route.key]?.options.title ?? route.name;
				const color = focused ? p.fg : p.fgTertiary;
				return (
					<Tap
						key={route.key}
						haptics="selection"
						accessibilityRole="tab"
						accessibilityState={{ selected: focused }}
						accessibilityLabel={title}
						onPress={() => {
							const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
							if (!focused && !event.defaultPrevented) {
								navigation.navigate(route.name, route.params);
							}
						}}
						style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 46 }}
					>
						<View>
							<Icon name={TAB_ICONS[route.name] ?? 'dot'} size={23} color={color} strokeWidth={focused ? 2.1 : 1.75} />
							{route.name === 'inbox' && badge ? (
								<View style={{ position: 'absolute', top: -4, right: -10, minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 9, backgroundColor: p.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: p.sidebar }}>
									<T variant="caption" weight="700" color={p.onPrimary} style={{ fontSize: 10, lineHeight: 12 }}>{badge > 99 ? '99+' : badge}</T>
								</View>
							) : null}
						</View>
						<T variant="caption" weight={focused ? '600' : '500'} color={color}>{title}</T>
					</Tap>
				);
			})}
		</View>
	);
}
