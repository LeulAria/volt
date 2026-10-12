/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Clipboard from 'expo-clipboard';
import { useSyncExternalStore } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic, Icon, T, Tap } from './core';

interface IShown {
	readonly uri: string;
	readonly title?: string;
}

let shown: IShown | undefined;
const listeners = new Set<() => void>();

function set(next: IShown | undefined): void {
	shown = next;
	listeners.forEach(listener => listener());
}

/** Opens an image full screen (pinch to zoom on iOS; tap outside it or Close to leave). */
export function showImage(uri: string, title?: string): void {
	set({ uri, ...(title ? { title } : {}) });
}

/** Mounted once at the root: draws the image {@link showImage} opened. */
export function ImageViewerHost() {
	const current = useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => shown, () => undefined);
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const close = () => set(undefined);
	return (
		<Modal visible={!!current} transparent animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent supportedOrientations={['portrait', 'landscape']}>
			<View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }}>
				{current ? (
					<Animated.View entering={FadeIn.duration(180)} style={{ flex: 1 }}>
						<ScrollView
							style={{ flex: 1 }}
							contentContainerStyle={{ width, height, alignItems: 'center', justifyContent: 'center' }}
							maximumZoomScale={5}
							minimumZoomScale={1}
							centerContent
							showsHorizontalScrollIndicator={false}
							showsVerticalScrollIndicator={false}
							bouncesZoom
						>
							<Pressable onPress={close} style={StyleSheet.absoluteFill} accessibilityLabel="Close" />
							<Image source={{ uri: current.uri }} style={{ width, height: height - insets.top - insets.bottom - 80 }} resizeMode="contain" />
						</ScrollView>
					</Animated.View>
				) : null}
				<View style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
					<Tap haptics="light" onPress={close} accessibilityLabel="Close" style={styles.round}>
						<Icon name="close" size={20} color="#fff" />
					</Tap>
					<T variant="small" weight="600" color="rgba(255,255,255,0.85)" numberOfLines={1} style={{ flex: 1 }}>{current?.title ?? ''}</T>
					{current && !current.uri.startsWith('data:') ? (
						<Tap haptics="light" onPress={() => {
							void Clipboard.setStringAsync(current.uri);
							haptic.success();
						}} accessibilityLabel="Copy link" style={styles.round}>
							<Icon name="link" size={18} color="#fff" />
						</Tap>
					) : null}
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	round: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
});
