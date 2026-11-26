/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISavedEnvironment } from '@volt/client-core/src/environments';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, haptic, styles, usePalette } from './ui';

/** The computers this phone is paired with: switch, pair another, or forget one. */
export function ComputersSheet({ visible, environments, activeId, signedOutOf, onSelect, onPairAnother, onForget, onClose }: {
	readonly visible: boolean;
	readonly environments: readonly ISavedEnvironment[];
	readonly activeId: string | undefined;
	/** The computer the user just signed out of in the workbench. */
	readonly signedOutOf?: string;
	readonly onSelect: (environmentId: string) => void;
	readonly onPairAnother: () => void;
	readonly onForget: (environmentId: string) => void;
	readonly onClose: () => void;
}) {
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const host = (env: ISavedEnvironment) => env.routes[0]?.baseUrl.replace(/^https?:\/\//, '') ?? '';
	const signedOut = environments.find(env => env.environmentId === signedOutOf);

	const confirmForget = (env: ISavedEnvironment) => {
		haptic('warning');
		Alert.alert(`Forget ${env.label}?`, 'This phone stops opening Volt on it. You can pair it again from Volt Settings › Devices.', [
			{ text: 'Cancel', style: 'cancel' },
			{ text: 'Forget', style: 'destructive', onPress: () => onForget(env.environmentId) },
		]);
	};

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
			onRequestClose={onClose}
			statusBarTranslucent
			navigationBarTranslucent
		>
			<View style={{ flex: 1, backgroundColor: p.canvas, paddingTop: Platform.OS === 'ios' ? 0 : insets.top }}>
				<View style={[sheet.header, { borderBottomColor: p.stroke }]}>
					<Text accessibilityRole="header" style={[sheet.title, { color: p.fg }]}>Computers</Text>
					<Button label="Done" variant="plain" onPress={onClose} style={sheet.done} />
				</View>
				<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
					{signedOut ? (
						<Text style={[styles.body, sheet.note, { color: p.fgSecondary }]}>
							You signed out of Volt on {signedOut.label}. Forget it on this phone, or tap it to sign in again.
						</Text>
					) : null}
					{environments.map(env => {
						const active = env.environmentId === activeId;
						return (
							<View key={env.environmentId} style={[sheet.row, { borderBottomColor: p.stroke }]}>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`${env.label}, ${host(env)}${active ? ', open' : ''}`}
									onPress={() => {
										haptic('selection');
										onSelect(env.environmentId);
									}}
									style={({ pressed }) => [sheet.rowMain, pressed && { backgroundColor: p.fill }]}
								>
									<View style={[sheet.dot, { backgroundColor: active ? p.accent : 'transparent', borderColor: active ? p.accent : p.fgTertiary }]} />
									<View style={{ flex: 1 }}>
										<Text numberOfLines={1} style={[sheet.label, { color: p.fg }]}>{env.label}</Text>
										<Text numberOfLines={1} style={[styles.small, { color: p.fgSecondary }]}>{host(env)}</Text>
									</View>
								</Pressable>
								<Button label="Forget" variant="danger" onPress={() => confirmForget(env)} style={sheet.forget} />
							</View>
						);
					})}
					<View style={{ padding: 16 }}>
						<Button label="Pair Another Computer" variant="secondary" onPress={onPairAnother} />
					</View>
				</ScrollView>
			</View>
		</Modal>
	);
}

const sheet = StyleSheet.create({
	header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingRight: 4, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
	title: { fontSize: 17, fontWeight: '600' },
	done: { paddingHorizontal: 12 },
	note: { paddingHorizontal: 16, paddingVertical: 12 },
	row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
	rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingLeft: 16, paddingVertical: 10 },
	dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
	label: { fontSize: 16, fontWeight: '500' },
	forget: { paddingHorizontal: 14, minHeight: 44 },
});
