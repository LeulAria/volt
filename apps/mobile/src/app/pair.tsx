import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BrandMark } from '@/components/BrandMark';
import { ScanIcon } from '@/components/Icons';
import { Text } from '@/components/Text';
import { useVolt } from '@/lib/connection';
import { parsePairingUrl } from '@/lib/pairing';
import { colors, fonts, radius } from '@/lib/theme';

/** Pairing with Volt on a Mac: scan the code Volt shows, or paste its link. */
export default function PairScreen() {
	const insets = useSafeAreaInsets();
	const { pair } = useVolt();
	const params = useLocalSearchParams<{ url?: string }>();
	const [value, setValue] = useState(params.url ?? '');
	const [error, setError] = useState<string | undefined>();
	const [scanning, setScanning] = useState(false);
	const [permission, requestPermission] = useCameraPermissions();

	const connect = async (input: string) => {
		const pairing = parsePairingUrl(input);
		if (!pairing) {
			setError('That is not a Volt pairing link. It looks like http://192.168.1.20:47100/#token=…');
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
			return;
		}
		setError(undefined);
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		await pair(pairing);
		router.replace('/');
	};

	// Opened from a volt://pair?url=… link: pair right away.
	useEffect(() => {
		if (params.url) {
			void connect(params.url);
		}
	}, [params.url]); // eslint-disable-line react-hooks/exhaustive-deps

	const scan = async () => {
		if (!permission?.granted && !(await requestPermission()).granted) {
			setError('Volt needs the camera to scan the pairing code.');
			return;
		}
		setScanning(true);
	};

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
			<View style={[styles.content, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 }]}>
				<View style={styles.hero}>
					<BrandMark size={84} />
					<Text size={26} weight="semibold">Volt</Text>
					<Text size={14} color={colors.textTertiary} style={styles.center}>Follow and start agent runs on your Mac from your phone.</Text>
				</View>
				{scanning ? (
					<View style={styles.camera}>
						<CameraView
							style={StyleSheet.absoluteFill}
							barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
							onBarcodeScanned={({ data }) => {
								setScanning(false);
								void connect(data);
							}}
						/>
					</View>
				) : null}
				<View style={styles.form}>
					<Text size={12} weight="medium" color={colors.textTertiary}>In Volt on your Mac, run “Volt: Pair Mobile App”, then scan the code or paste the link.</Text>
					<TextInput
						value={value}
						onChangeText={text => {
							setValue(text);
							setError(undefined);
						}}
						placeholder="http://your-mac.local:47100/#token=…"
						placeholderTextColor={colors.textQuaternary}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="url"
						keyboardAppearance="dark"
						returnKeyType="go"
						onSubmitEditing={() => void connect(value)}
						style={styles.input}
						accessibilityLabel="Pairing link"
					/>
					{error ? <Text size={12} color={colors.red}>{error}</Text> : null}
					<View style={styles.buttons}>
						<Pressable style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]} onPress={() => void scan()} accessibilityRole="button" accessibilityLabel="Scan code">
							<ScanIcon size={16} />
							<Text size={14} weight="medium">Scan</Text>
						</Pressable>
						<Pressable style={({ pressed }) => [styles.button, styles.primary, !value.trim() && styles.disabled, pressed && styles.primaryPressed]} disabled={!value.trim()} onPress={() => void connect(value)} accessibilityRole="button" accessibilityLabel="Connect">
							<Text size={14} weight="semibold" color="#141414">Connect</Text>
						</Pressable>
					</View>
				</View>
			</View>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.sidebar },
	content: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between' },
	hero: { alignItems: 'center', gap: 12 },
	center: { textAlign: 'center', maxWidth: 300 },
	camera: { height: 240, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
	form: { gap: 12 },
	input: { height: 48, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, backgroundColor: '#1c1c1c', color: colors.text, paddingHorizontal: 14, ...fonts.regular, fontSize: 13 },
	buttons: { flexDirection: 'row', gap: 10 },
	button: { flex: 1, height: 48, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
	secondary: { backgroundColor: 'rgba(240,240,240,0.08)' },
	primary: { backgroundColor: '#f0f0f0' },
	primaryPressed: { backgroundColor: '#d8d8d8' },
	pressed: { backgroundColor: 'rgba(240,240,240,0.14)' },
	disabled: { opacity: 0.4 },
});
