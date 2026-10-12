/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ClientProvider, useOptionalClient } from '../src/state/client';
import { loadEnvironments, useActiveEnvironment, useEnvironments } from '../src/state/environments';
import { ThemeProvider, useTheme } from '../src/theme/theme';
import { ImageViewerHost } from '../src/ui/ImageViewer';
import { Toasts } from '../src/ui/sheets';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaProvider>
				<KeyboardProvider>
					<ThemeProvider>
						<Root />
					</ThemeProvider>
				</KeyboardProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}

function Root() {
	const { p, dark } = useTheme();
	const { loaded } = useEnvironments();
	const environment = useActiveEnvironment();

	useEffect(() => {
		void loadEnvironments().finally(() => void SplashScreen.hideAsync().catch(() => undefined));
	}, []);

	useEffect(() => {
		void SystemUI.setBackgroundColorAsync(p.canvas).catch(() => undefined);
	}, [p.canvas]);

	if (!loaded) {
		return null;
	}

	const sheet = Platform.OS === 'ios'
		? { presentation: 'formSheet' as const, sheetAllowedDetents: [0.62, 1], sheetGrabberVisible: true, sheetCornerRadius: 22, contentStyle: { backgroundColor: p.raised } }
		: { presentation: 'modal' as const, contentStyle: { backgroundColor: p.raised } };

	return (
		<ClientProvider environment={environment}>
			<StatusBar style={dark ? 'light' : 'dark'} />
			<Stack
				screenOptions={{
					headerStyle: { backgroundColor: p.canvas },
					headerTintColor: p.fg,
					headerTitleStyle: { color: p.fg, fontWeight: '600' },
					headerLargeTitleStyle: { color: p.fg, fontWeight: '800' },
					headerShadowVisible: false,
					headerBackButtonDisplayMode: 'minimal',
					contentStyle: { backgroundColor: p.canvas },
					animation: Platform.OS === 'android' ? 'fade_from_bottom' : 'default',
				}}
			>
				<Stack.Screen name="index" options={{ title: 'Volt' }} />
				<Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
				<Stack.Screen name="details/[id]" options={{ headerShown: false, ...sheet }} />
				<Stack.Screen name="new" options={{ headerShown: false, presentation: 'modal', contentStyle: { backgroundColor: p.canvas } }} />
				<Stack.Screen name="connect" options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
				<Stack.Screen name="pair" options={{ headerShown: false }} />
				<Stack.Screen name="settings/index" options={{ title: 'Settings', headerLargeTitle: Platform.OS === 'ios' }} />
				<Stack.Screen name="settings/devices" options={{ title: 'Devices' }} />
				<Stack.Screen name="settings/models" options={{ title: 'Models' }} />
				<Stack.Screen name="changes/[id]" options={{ title: 'Changes' }} />
				<Stack.Screen name="diff" options={{ title: 'Diff', contentStyle: { backgroundColor: p.codeBg } }} />
				<Stack.Screen name="files/index" options={{ title: 'Files' }} />
				<Stack.Screen name="file" options={{ title: 'File', contentStyle: { backgroundColor: p.codeBg } }} />
			</Stack>
			<ToastHost />
			<ImageViewerHost />
		</ClientProvider>
	);
}

function ToastHost() {
	const client = useOptionalClient();
	return client ? <Toasts /> : null;
}
