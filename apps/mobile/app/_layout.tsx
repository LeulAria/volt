/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ClientProvider, useOptionalClient } from '../src/state/client';
import { loadEnvironments, useActiveEnvironment, useEnvironments } from '../src/state/environments';
import { loadFonts, ThemeProvider, useTheme } from '../src/theme/theme';
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

	const [fonts, setFonts] = useState(false);
	useEffect(() => {
		void loadFonts().finally(() => setFonts(true));
		void loadEnvironments();
	}, []);
	const ready = loaded && fonts;
	useEffect(() => {
		if (ready) {
			void SplashScreen.hideAsync().catch(() => undefined);
		}
	}, [ready]);

	useEffect(() => {
		void SystemUI.setBackgroundColorAsync(p.canvas).catch(() => undefined);
	}, [p.canvas]);

	if (!ready) {
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
				<Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Home' }} />
				<Stack.Screen name="chats" options={{ title: 'Chats' }} />
				<Stack.Screen name="project/[id]" options={{ title: '' }} />
				<Stack.Screen name="scm" options={{ title: 'Source control' }} />
				<Stack.Screen name="pulls" options={{ title: 'Pull requests' }} />
				<Stack.Screen name="pull" options={{ title: 'Pull request' }} />
				<Stack.Screen name="pull-new" options={{ title: 'Open a pull request', presentation: 'modal' }} />
				<Stack.Screen name="settings/mcp" options={{ title: 'MCP servers' }} />
				<Stack.Screen name="subagent/[id]" options={{ title: 'Subagent' }} />
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
