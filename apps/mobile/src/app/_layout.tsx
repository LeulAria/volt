import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { useFonts, GeistMono_400Regular } from '@expo-google-fonts/geist-mono';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { VoltProvider, useVolt } from '@/lib/connection';
import { colors } from '@/lib/theme';

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(colors.sidebar);

function Navigator() {
	const { loaded } = useVolt();
	const [fontsLoaded] = useFonts({ GeistMono_400Regular });
	const ready = loaded && fontsLoaded;
	useEffect(() => {
		if (ready) {
			void SplashScreen.hideAsync();
		}
	}, [ready]);
	if (!ready) {
		return null;
	}
	const sheet = {
		presentation: 'formSheet',
		sheetAllowedDetents: 'fitToContents',
		sheetGrabberVisible: true,
		sheetCornerRadius: 22,
		headerShown: false,
		contentStyle: { backgroundColor: colors.surfaceRaised },
	} as const;
	return (
		<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.sidebar }, headerTitleStyle: { fontWeight: '600' } }}>
			<Stack.Screen name="index" />
			<Stack.Screen name="chat/[id]" options={{ contentStyle: { backgroundColor: colors.background } }} />
			<Stack.Screen name="pair" options={{ gestureEnabled: false, animation: 'fade' }} />
			<Stack.Screen name="settings" options={{ presentation: 'modal', contentStyle: { backgroundColor: colors.sidebar } }} />
			<Stack.Screen name="pick-model" options={sheet} />
			<Stack.Screen name="pick-project" options={sheet} />
			<Stack.Screen name="pick-access" options={sheet} />
		</Stack>
	);
}

export default function RootLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.sidebar }}>
			<SafeAreaProvider>
				<VoltProvider>
					<StatusBar style="light" />
					<Navigator />
				</VoltProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
