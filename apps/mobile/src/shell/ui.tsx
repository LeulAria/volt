/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Haptics from 'expo-haptics';
import { forwardRef } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, type StyleProp, StyleSheet, Text, TextInput, type TextInputProps, useColorScheme, View, type ViewStyle } from 'react-native';
import type { HapticStyle } from './bridge';
import { type IPalette, palette } from './theme';

/** The few native screens' building blocks: system font, Volt's colours, 44 pt touch targets. */

export function usePalette(): IPalette {
	return palette(useColorScheme() !== 'light');
}

export function haptic(style: HapticStyle): void {
	const done = (promise: Promise<void>) => void promise.catch(() => undefined);
	switch (style) {
		case 'selection': return done(Haptics.selectionAsync());
		case 'light': return done(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
		case 'medium': return done(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
		case 'success': return done(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
		case 'warning': return done(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
		case 'error': return done(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
	}
}

export function VoltMark({ size = 56 }: { readonly size?: number }) {
	return <Image source={require('../../assets/volt-mark.png')} style={{ width: size, height: size, borderRadius: size * 0.22 }} accessibilityIgnoresInvertColors />;
}

export function Button({ label, onPress, variant = 'primary', busy, disabled, style, colors }: {
	readonly label: string;
	readonly onPress: () => void;
	readonly variant?: 'primary' | 'secondary' | 'plain' | 'danger';
	readonly busy?: boolean;
	readonly disabled?: boolean;
	readonly style?: StyleProp<ViewStyle>;
	/** The workbench's scheme over the page; the system's elsewhere. */
	readonly colors?: IPalette;
}) {
	const system = usePalette();
	const p = colors ?? system;
	const fg = variant === 'primary' ? p.onAccent : variant === 'danger' ? p.danger : variant === 'plain' ? p.accent : p.fg;
	const bg = variant === 'primary' ? p.accent : variant === 'secondary' ? p.fill : 'transparent';
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
			disabled={disabled || busy}
			onPress={onPress}
			style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }, variant === 'secondary' && { borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }, style]}
		>
			{busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>}
		</Pressable>
	);
}

export const Field = forwardRef<TextInput, TextInputProps & { readonly label: string; readonly mono?: boolean }>(function Field({ label, mono, style, ...props }, ref) {
	const p = usePalette();
	return (
		<View style={{ gap: 6 }}>
			<Text style={[styles.fieldLabel, { color: p.fgSecondary }]}>{label}</Text>
			<TextInput
				ref={ref}
				placeholderTextColor={p.fgTertiary}
				autoCorrect={false}
				autoCapitalize="none"
				selectionColor={p.accent}
				style={[styles.field, { backgroundColor: p.fill, borderColor: p.stroke, color: p.fg }, mono && styles.mono, style]}
				{...props}
			/>
		</View>
	);
});

export function ErrorLine({ text }: { readonly text: string }) {
	const p = usePalette();
	return (
		<View accessibilityRole="alert" style={[styles.error, { backgroundColor: `${p.danger}1A` }]}>
			<Text style={[styles.body, { color: p.fg }]}>{text}</Text>
		</View>
	);
}

export const styles = StyleSheet.create({
	button: { minHeight: 48, borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
	buttonLabel: { fontSize: 16, fontWeight: '600' },
	fieldLabel: { fontSize: 13, fontWeight: '500', marginLeft: 2 },
	field: { minHeight: 48, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, borderWidth: StyleSheet.hairlineWidth },
	mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', letterSpacing: 2, fontSize: 18, textAlign: 'center' },
	error: { padding: 12, borderRadius: 10 },
	title: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
	body: { fontSize: 15, lineHeight: 21 },
	small: { fontSize: 13, lineHeight: 18 },
});
