/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatCode, normalizeBaseUrl, normalizeCode, type PairingTarget, parsePairingLink } from '@volt/client-core/src/environments';
import { errorMessage } from '@volt/client-core/src/protocol';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, type TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Scanner from '../../modules/volt-scanner';
import { pairWith } from '../state/environments';
import { Button, ErrorLine, Field, haptic, styles, usePalette, VoltMark } from './ui';

/**
 * Pairs this phone with Volt on a computer: scan the QR code its Settings › Devices shows, or
 * type the pairing link, or the address and the one-time code. A link that opened the app
 * (`volt://pair?url=…`) is confirmed first: a link from elsewhere must not pair this phone with
 * a machine the user didn't choose.
 */
export function ConnectScreen({ link, onPaired, onCancel }: {
	/** From a deep link: shown for confirmation before anything is sent. */
	readonly link?: PairingTarget;
	readonly onPaired: () => void;
	/** Back to the workbench (when a computer is already saved). */
	readonly onCancel?: () => void;
}) {
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const [address, setAddress] = useState('');
	const [code, setCode] = useState('');
	const [pending, setPending] = useState<PairingTarget | undefined>(link);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [canScan, setCanScan] = useState(false);
	const codeField = useRef<TextInput>(null);

	useEffect(() => setPending(link), [link]);
	useEffect(() => {
		let live = true;
		void Scanner.isAvailable().then(available => live && setCanScan(available));
		return () => {
			live = false;
		};
	}, []);

	const pair = async (target: PairingTarget) => {
		setBusy(true);
		setError(undefined);
		try {
			await pairWith(target);
			haptic('success');
			onPaired();
		} catch (err) {
			haptic('error');
			setError(errorMessage(err));
			setBusy(false);
		}
	};

	const scan = async () => {
		setError(undefined);
		try {
			const data = await Scanner.scan();
			if (!data) {
				return;
			}
			const target = parsePairingLink(data);
			if (!target) {
				haptic('error');
				setError('That QR code isn\'t a Volt pairing code.');
				return;
			}
			haptic('medium');
			void pair(target);
		} catch (err) {
			setError(errorMessage(err));
		}
	};

	const submit = () => {
		// A pasted pairing link carries its own code (or an owner token).
		const target = parsePairingLink(address);
		if (target) {
			void pair(target);
			return;
		}
		if (!address.trim()) {
			setError('Type the pairing link, or the computer\'s address, like 192.168.1.20:47321.');
			return;
		}
		const baseUrl = normalizeBaseUrl(address);
		if (!baseUrl) {
			setError(`"${address.trim()}" isn't an address. Type it like 192.168.1.20:47321.`);
			return;
		}
		if (normalizeCode(code).length < 8) {
			setError('Type the code your computer shows, like ABCD-2345.');
			codeField.current?.focus();
			return;
		}
		void pair({ kind: 'code', baseUrl, code: normalizeCode(code) });
	};

	const host = (target: PairingTarget) => target.baseUrl.replace(/^https?:\/\//, '');
	// A full pairing link needs no separate code.
	const linkHasCode = !!parsePairingLink(address);

	return (
		<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: p.canvas }}>
			<View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, minHeight: insets.top + 52, flexDirection: 'row', alignItems: 'center' }}>
				{onCancel && !pending ? <Button label="Cancel" variant="plain" onPress={onCancel} /> : null}
			</View>
			<ScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingBottom: insets.bottom + 24, gap: 14, maxWidth: 480, width: '100%', alignSelf: 'center' }}
			>
				{pending ? (
					<>
						<VoltMark />
						<Text accessibilityRole="header" style={[styles.title, { color: p.fg }]}>Pair with {host(pending)}?</Text>
						<Text style={[styles.body, { color: p.fgSecondary }]}>
							A link asked to pair this phone with Volt at <Text style={{ color: p.fg, fontWeight: '600' }}>{host(pending)}</Text>. Only continue if you opened it from your own computer.
						</Text>
						{error ? <ErrorLine text={error} /> : null}
						<View style={{ gap: 10, marginTop: 8 }}>
							<Button label="Pair" busy={busy} onPress={() => void pair(pending)} />
							<Button label="Cancel" variant="secondary" disabled={busy} onPress={() => {
								setPending(undefined);
								setError(undefined);
								onCancel?.();
							}} />
						</View>
					</>
				) : (
					<>
						<VoltMark />
						<Text accessibilityRole="header" style={[styles.title, { color: p.fg }]}>Connect to your computer</Text>
						<Text style={[styles.body, { color: p.fgSecondary }]}>On your computer open Volt Settings › Devices › Pair a Device.</Text>
						{canScan ? (
							<>
								<Button label="Scan Pairing Code" disabled={busy} onPress={() => void scan()} style={{ marginTop: 8 }} />
								<Text style={[styles.small, { color: p.fgTertiary, textAlign: 'center', marginTop: 4 }]}>or type the link or address it shows</Text>
							</>
						) : null}
						<Field
							label="Pairing link or address"
							value={address}
							onChangeText={value => {
								setAddress(value);
								setError(undefined);
							}}
							placeholder="192.168.1.20:47321"
							keyboardType="url"
							textContentType="URL"
							returnKeyType={linkHasCode ? 'go' : 'next'}
							onSubmitEditing={() => linkHasCode ? submit() : codeField.current?.focus()}
							editable={!busy}
						/>
						{linkHasCode ? null : (
							<Field
								ref={codeField}
								label="Code"
								mono
								value={code}
								onChangeText={value => {
									setCode(formatCode(value).slice(0, 9));
									setError(undefined);
								}}
								placeholder="ABCD-2345"
								autoCapitalize="characters"
								returnKeyType="go"
								onSubmitEditing={submit}
								editable={!busy}
							/>
						)}
						{error ? <ErrorLine text={error} /> : null}
						<Button label="Connect" variant={canScan ? 'secondary' : 'primary'} busy={busy} onPress={submit} style={{ marginTop: 4 }} />
					</>
				)}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}
