/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { router, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/theme';
import { Button, Icon, T, VoltMark } from '../ui/core';

export function Loading() {
	const { p } = useTheme();
	return (
		<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
			<Stack.Screen options={{ headerShown: false }} />
			<ActivityIndicator color={p.fgTertiary} />
		</View>
	);
}

/** Before any computer is paired: what the app is for, and the way to pair. */
export function Welcome() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	return (
		<View style={{ flex: 1, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}>
			<Stack.Screen options={{ headerShown: false }} />
			<Animated.View entering={FadeIn.duration(400)} style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
				<VoltMark size={64} style={{ shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 10 } }} />
				<T variant="display" weight="800" style={{ letterSpacing: -1, marginTop: 8 }}>Your agents,{'\n'}in your pocket.</T>
				<T variant="callout" color={p.fgTertiary}>Pair with Volt on your computer to follow every chat live, answer questions, approve commands and start new work from anywhere.</T>
				<View style={{ gap: 14, marginTop: 18 }}>
					{([
						['laptop', 'In Volt, run Pair a Phone or Browser…'],
						['qr', 'Scan the code it shows'],
						['zap', 'Chats keep running on your computer'],
					] as const).map(([icon, text]) => (
						<View key={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
							<View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}>
								<Icon name={icon} size={18} color={p.fgSecondary} />
							</View>
							<T variant="body" color={p.fgSecondary} style={{ flex: 1 }}>{text}</T>
						</View>
					))}
				</View>
			</Animated.View>
			<View style={{ gap: 10 }}>
				<Button label="Scan pairing code" icon="qr" variant="primary" size="lg" onPress={() => router.push('/connect')} />
				<Button label="Enter code instead" variant="ghost" onPress={() => router.push({ pathname: '/connect', params: { manual: '1' } })} />
			</View>
		</View>
	);
}
