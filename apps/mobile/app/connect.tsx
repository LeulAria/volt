/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, formatCode, normalizeBaseUrl, normalizeCode, type PairingTarget, parsePairingLink } from '@volt/client-core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pairWith } from '../src/state/environments';
import { useTheme } from '../src/theme/theme';
import { Button, haptic, Icon, IconButton, T, Tap, VoltMark } from '../src/ui/core';

/**
 * Pairs this phone with Volt on a computer: scan the QR the computer shows, or type its address
 * and the one-time code. A link that opened the app (volt://pair) is shown for confirmation
 * first: a link from elsewhere must not pair with a machine the user didn't choose.
 */
export default function Connect() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const params = useLocalSearchParams<{ manual?: string; link?: string }>();
	const [permission, requestPermission] = useCameraPermissions();
	const [manual, setManual] = useState(params.manual === '1');
	const [address, setAddress] = useState('');
	const [code, setCode] = useState('');
	const [pending, setPending] = useState<PairingTarget | undefined>(() => params.link ? parsePairingLink(params.link) : undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const scanned = useRef(false);

	useEffect(() => {
		if (!manual && permission && !permission.granted && permission.canAskAgain) {
			void requestPermission();
		}
	}, [manual, permission, requestPermission]);

	const pair = async (target: PairingTarget) => {
		setBusy(true);
		setError(undefined);
		try {
			await pairWith(target);
			haptic.success();
			if (router.canDismiss()) {
				router.dismissAll();
			}
			router.replace('/');
		} catch (err) {
			haptic.error();
			setError(errorMessage(err));
			setBusy(false);
			scanned.current = false;
		}
	};

	const onScan = (data: string) => {
		if (scanned.current || busy) {
			return;
		}
		const target = parsePairingLink(data);
		if (!target) {
			setError('That QR code isn\'t a Volt pairing code.');
			return;
		}
		scanned.current = true;
		haptic.medium();
		void pair(target);
	};

	const submitManual = () => {
		const baseUrl = normalizeBaseUrl(address);
		if (!baseUrl) {
			setError('Enter the address Volt shows, like 192.168.1.20:47321.');
			return;
		}
		if (normalizeCode(code).length < 8) {
			setError('The code has 8 characters, like ABCD-2345.');
			return;
		}
		void pair({ kind: 'code', baseUrl, code: normalizeCode(code) });
	};

	const host = (target: PairingTarget) => target.baseUrl.replace(/^https?:\/\//, '');

	return (
		<View style={{ flex: 1, backgroundColor: '#000' }}>
			{!manual && permission?.granted && !pending ? (
				<CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : result => onScan(result.data)} />
			) : null}
			<View style={[StyleSheet.absoluteFill, { backgroundColor: manual || pending || !permission?.granted ? p.canvas : 'rgba(0,0,0,0.35)' }]} />

			<View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 6, paddingHorizontal: 12 }}>
				<IconButton icon="close" label="Close" color={manual || pending ? p.fg : '#fff'} onPress={() => router.back()} style={{ backgroundColor: manual || pending ? p.fill : 'rgba(255,255,255,0.15)' }} />
				<View style={{ flex: 1 }} />
				{!pending ? (
					<Tap haptics="selection" onPress={() => {
						setManual(m => !m);
						setError(undefined);
					}} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: manual ? p.fill : 'rgba(255,255,255,0.15)' }}>
						<Icon name={manual ? 'camera' : 'pencil'} size={15} color={manual ? p.fg : '#fff'} />
						<T variant="small" weight="600" color={manual ? p.fg : '#fff'}>{manual ? 'Scan instead' : 'Enter code'}</T>
					</Tap>
				) : null}
			</View>

			{pending ? (
				<Animated.View entering={FadeInDown.duration(260)} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
					<View style={{ width: 60, height: 60, borderRadius: 17, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' }}>
						<Icon name="laptop" size={28} color={p.onPrimary} />
					</View>
					<T variant="title1" weight="800" style={{ letterSpacing: -0.6 }}>Pair with this computer?</T>
					<T variant="callout" color={p.fgTertiary}>A link asked to pair this phone with Volt at <T variant="callout" mono color={p.fg}>{host(pending)}</T>. Only continue if you opened it from your own computer.</T>
					{error ? <ErrorLine text={error} /> : null}
					<View style={{ gap: 10, marginTop: 12 }}>
						<Button label="Pair" variant="primary" size="lg" busy={busy} onPress={() => void pair(pending)} />
						<Button label="Cancel" variant="ghost" onPress={() => {
							setPending(undefined);
							router.back();
						}} />
					</View>
				</Animated.View>
			) : manual || !permission?.granted ? (
				<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
					<Animated.View entering={FadeIn.duration(220)} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 14 }}>
						<VoltMark size={56} />
						<T variant="title1" weight="800" style={{ letterSpacing: -0.6 }}>Connect to Volt</T>
						<T variant="body" color={p.fgTertiary}>In Volt on your computer, run <T variant="body" weight="600" color={p.fgSecondary}>Pair a Phone or Browser…</T>. Enter the address and code it shows.</T>
						{!manual && permission && !permission.granted ? (
							<Tap haptics="light" onPress={() => void requestPermission()} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: p.fill }}>
								<Icon name="camera" size={18} color={p.fgSecondary} />
								<T variant="small" color={p.fgSecondary} style={{ flex: 1 }}>Allow the camera to scan the code instead</T>
								<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
							</Tap>
						) : null}
						<Field label="Address" value={address} onChangeText={setAddress} placeholder="192.168.1.20:47321" keyboardType="url" />
						<Field label="Code" value={code} onChangeText={value => setCode(formatCode(value).slice(0, 9))} placeholder="ABCD-2345" mono large onSubmit={submitManual} />
						{error ? <ErrorLine text={error} /> : null}
						<Button label="Connect" variant="primary" size="lg" busy={busy} onPress={submitManual} style={{ marginTop: 8 }} />
					</Animated.View>
				</KeyboardAvoidingView>
			) : (
				<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 }}>
					<View style={{ width: 250, height: 250 }}>
						{(['tl', 'tr', 'bl', 'br'] as const).map(corner => (
							<View key={corner} style={{
								position: 'absolute', width: 46, height: 46, borderColor: '#fff',
								...(corner.includes('t') ? { top: 0, borderTopWidth: 4 } : { bottom: 0, borderBottomWidth: 4 }),
								...(corner.includes('l') ? { left: 0, borderLeftWidth: 4 } : { right: 0, borderRightWidth: 4 }),
								borderTopLeftRadius: corner === 'tl' ? 22 : 0, borderTopRightRadius: corner === 'tr' ? 22 : 0,
								borderBottomLeftRadius: corner === 'bl' ? 22 : 0, borderBottomRightRadius: corner === 'br' ? 22 : 0,
							}} />
						))}
						{busy ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#fff" size="large" /></View> : null}
					</View>
					<View style={{ alignItems: 'center', gap: 6, paddingHorizontal: 32 }}>
						<T variant="title3" weight="700" color="#fff">{busy ? 'Connecting…' : 'Scan the pairing code'}</T>
						<T variant="small" color="rgba(255,255,255,0.75)" align="center">In Volt on your computer, run Pair a Phone or Browser… or open Settings › Devices in the browser.</T>
					</View>
					{error ? <View style={{ paddingHorizontal: 24 }}><ErrorLine text={error} light /></View> : null}
				</View>
			)}
		</View>
	);
}

function Field({ label, value, onChangeText, placeholder, mono, large, keyboardType, onSubmit }: {
	readonly label: string;
	readonly value: string;
	readonly onChangeText: (value: string) => void;
	readonly placeholder: string;
	readonly mono?: boolean;
	readonly large?: boolean;
	readonly keyboardType?: 'url' | 'default';
	readonly onSubmit?: () => void;
}) {
	const { p } = useTheme();
	return (
		<View style={{ gap: 6 }}>
			<T variant="footnote" weight="600" color={p.fgTertiary} style={{ marginLeft: 4 }}>{label}</T>
			<TextInput
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={p.fgQuaternary}
				autoCapitalize={mono ? 'characters' : 'none'}
				autoCorrect={false}
				keyboardType={keyboardType ?? 'default'}
				returnKeyType={onSubmit ? 'go' : 'next'}
				onSubmitEditing={onSubmit}
				selectionColor={p.accent}
				style={{ height: large ? 58 : 50, borderRadius: 14, paddingHorizontal: 16, backgroundColor: p.fill, color: p.fg, fontSize: large ? 24 : 17, letterSpacing: large ? 4 : 0, fontFamily: mono ? 'Menlo' : undefined, textAlign: large ? 'center' : 'left' }}
			/>
		</View>
	);
}

function ErrorLine({ text, light }: { readonly text: string; readonly light?: boolean }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: 12, backgroundColor: light ? 'rgba(0,0,0,0.55)' : `${p.danger}14` }}>
			<Icon name="alertCircle" size={16} color={p.danger} />
			<T variant="small" color={light ? '#fff' : p.fg} style={{ flex: 1 }}>{text}</T>
		</View>
	);
}
