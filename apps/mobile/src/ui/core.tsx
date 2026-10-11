/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ChatStatus, type IconName, ICONS, RADIUS, statusColor, timer, TYPE } from '@volt/client-core';
import * as Haptics from 'expo-haptics';
import { memo, type ReactNode, useEffect } from 'react';
import { ActivityIndicator, Pressable, type PressableProps, type StyleProp, StyleSheet, Text, type TextProps, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useNow } from '../state/client';
import { FONT, useTheme } from '../theme/theme';

export const haptic = {
	selection: () => void Haptics.selectionAsync().catch(() => undefined),
	light: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined),
	medium: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined),
	success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
	warning: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined),
	error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined),
};

export const Icon = memo(function Icon({ name, size = 18, color, strokeWidth = 1.75 }: { readonly name: IconName; readonly size?: number; readonly color?: string; readonly strokeWidth?: number }) {
	const { p } = useTheme();
	const def = ICONS[name];
	const fill = 'fill' in def && def.fill;
	const c = color ?? p.fg;
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? c : 'none'} stroke={fill ? 'none' : c} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
			{def.paths.map((d, i) => <Path key={i} d={d} />)}
		</Svg>
	);
});

export type TextVariant = keyof typeof TYPE;

export interface ITProps extends TextProps {
	readonly variant?: TextVariant;
	readonly color?: string;
	readonly weight?: TextStyle['fontWeight'];
	readonly mono?: boolean;
	readonly align?: TextStyle['textAlign'];
	readonly children?: ReactNode;
}

/** Text in Volt's type scale. */
export function T({ variant = 'body', color, weight, mono, align, style, ...rest }: ITProps) {
	const { p } = useTheme();
	const t = TYPE[variant];
	return (
		<Text
			style={[{ fontSize: mono ? t.size - 1 : t.size, lineHeight: t.line, color: color ?? p.fg, ...(weight ? { fontWeight: weight } : {}), ...(mono ? { fontFamily: FONT.mono } : {}), ...(align ? { textAlign: align } : {}) }, style]}
			maxFontSizeMultiplier={1.6}
			{...rest}
		/>
	);
}

/** A pressable that dims and settles a little when pressed. */
export function Tap({ style, children, haptics, onPress, ...rest }: Omit<PressableProps, 'style'> & { readonly style?: StyleProp<ViewStyle>; readonly haptics?: keyof typeof haptic; readonly children?: ReactNode }) {
	return (
		<Pressable
			{...rest}
			onPress={e => {
				if (haptics) {
					haptic[haptics]();
				}
				onPress?.(e);
			}}
			style={({ pressed }) => [style, pressed && !rest.disabled ? styles.pressed : null, rest.disabled ? styles.disabled : null]}
		>
			{children}
		</Pressable>
	);
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ label, onPress, variant = 'secondary', icon, busy, disabled, size = 'md', style, flex }: {
	readonly label: string;
	readonly onPress?: () => void;
	readonly variant?: ButtonVariant;
	readonly icon?: IconName;
	readonly busy?: boolean;
	readonly disabled?: boolean;
	readonly size?: 'sm' | 'md' | 'lg';
	readonly style?: StyleProp<ViewStyle>;
	readonly flex?: boolean;
}) {
	const { p } = useTheme();
	const bg = variant === 'primary' ? p.primary : variant === 'ghost' ? 'transparent' : variant === 'danger' ? `${p.danger}1F` : p.fill;
	const fg = variant === 'primary' ? p.onPrimary : variant === 'danger' ? p.danger : variant === 'ghost' ? p.fgSecondary : p.fg;
	const height = size === 'sm' ? 32 : size === 'lg' ? 50 : 42;
	return (
		<Tap
			onPress={onPress}
			disabled={disabled || busy}
			haptics="light"
			accessibilityRole="button"
			accessibilityLabel={label}
			style={[{ height, paddingHorizontal: size === 'sm' ? 12 : 18, borderRadius: size === 'lg' ? 14 : 11, backgroundColor: bg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0, borderColor: p.stroke }, flex ? { flex: 1 } : null, style]}
		>
			{busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} color={fg} /> : null}
			<T variant={size === 'lg' ? 'callout' : size === 'sm' ? 'small' : 'body'} weight="600" color={fg}>{label}</T>
		</Tap>
	);
}

export function IconButton({ icon, onPress, label, size = 20, color, style, haptics = 'selection', disabled }: {
	readonly icon: IconName;
	readonly onPress?: () => void;
	readonly label: string;
	readonly size?: number;
	readonly color?: string;
	readonly style?: StyleProp<ViewStyle>;
	readonly haptics?: keyof typeof haptic;
	readonly disabled?: boolean;
}) {
	const { p } = useTheme();
	return (
		<Tap onPress={onPress} haptics={haptics} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={[{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, style]}>
			<Icon name={icon} size={size} color={color ?? p.fgSecondary} />
		</Tap>
	);
}

export const STATUS_ICON: Record<ChatStatus, IconName> = {
	approval: 'shieldAlert',
	question: 'help',
	working: 'circleDashed',
	queued: 'queue',
	limit: 'clock',
	failed: 'alertCircle',
	unread: 'checkCircle',
	stopped: 'pause',
	idle: 'dot',
};

export function Spin({ children, active = true, duration = 2400 }: { readonly children: ReactNode; readonly active?: boolean; readonly duration?: number }) {
	const rotation = useSharedValue(0);
	useEffect(() => {
		if (active) {
			rotation.value = withRepeat(withTiming(360, { duration, easing: Easing.linear }), -1, false);
		} else {
			cancelAnimation(rotation);
			rotation.value = 0;
		}
		return () => cancelAnimation(rotation);
	}, [active, duration, rotation]);
	const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
	return <Animated.View style={style}>{children}</Animated.View>;
}

export function StatusIcon({ status, size = 15 }: { readonly status: ChatStatus; readonly size?: number }) {
	const { p } = useTheme();
	const color = status === 'idle' ? p.fgQuaternary : statusColor(status, p);
	const icon = <Icon name={STATUS_ICON[status]} size={status === 'idle' ? size - 4 : size} color={color} strokeWidth={status === 'working' ? 2 : 1.75} />;
	return status === 'working' ? <Spin>{icon}</Spin> : icon;
}

/** Text that breathes while the agent works on it. */
export function Shimmer({ children, active = true }: { readonly children: ReactNode; readonly active?: boolean }) {
	const opacity = useSharedValue(1);
	useEffect(() => {
		if (active) {
			opacity.value = withRepeat(withTiming(0.4, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
		} else {
			cancelAnimation(opacity);
			opacity.value = withTiming(1, { duration: 150 });
		}
		return () => cancelAnimation(opacity);
	}, [active, opacity]);
	const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
	return <Animated.View style={style}>{children}</Animated.View>;
}

export function LiveTimer({ since, color, variant = 'footnote' }: { readonly since: number; readonly color?: string; readonly variant?: TextVariant }) {
	const now = useNow(1000);
	return <T variant={variant} color={color} style={{ fontVariant: ['tabular-nums'] }}>{timer((now || Date.now()) - since)}</T>;
}

export function Card({ children, style, padded = true }: { readonly children: ReactNode; readonly style?: StyleProp<ViewStyle>; readonly padded?: boolean }) {
	const { p } = useTheme();
	return <View style={[{ backgroundColor: p.surface, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, ...(padded ? { padding: 14 } : {}), overflow: 'hidden' }, style]}>{children}</View>;
}

export function Divider({ inset = 0 }: { readonly inset?: number }) {
	const { p } = useTheme();
	return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.stroke, marginLeft: inset }} />;
}

export function EmptyState({ icon, title, body, action }: { readonly icon: IconName; readonly title: string; readonly body?: string; readonly action?: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ alignItems: 'center', paddingHorizontal: 32, paddingVertical: 40, gap: 10 }}>
			<View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
				<Icon name={icon} size={26} color={p.fgSecondary} />
			</View>
			<T variant="title3" weight="600" align="center">{title}</T>
			{body ? <T variant="small" color={p.fgTertiary} align="center">{body}</T> : null}
			{action ? <View style={{ marginTop: 8 }}>{action}</View> : null}
		</View>
	);
}

export function Pill({ label, icon, color, bg, onPress, onLongPress, maxWidth = 180 }: {
	readonly label: string;
	readonly icon?: IconName;
	readonly color?: string;
	readonly bg?: string;
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
	readonly maxWidth?: number;
}) {
	const { p } = useTheme();
	return (
		<Tap onPress={onPress} onLongPress={onLongPress} haptics="selection" style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: bg ?? p.fill, maxWidth }}>
			{icon ? <Icon name={icon} size={14} color={color ?? p.fgSecondary} /> : null}
			<T variant="small" weight="500" color={color ?? p.fgSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
		</Tap>
	);
}

export function Segmented<V extends string>({ value, options, onChange }: { readonly value: V; readonly options: readonly { readonly id: V; readonly label: string; readonly icon?: IconName }[]; readonly onChange: (value: V) => void }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', backgroundColor: p.fill, borderRadius: 10, padding: 2, gap: 2 }}>
			{options.map(option => {
				const on = option.id === value;
				return (
					<Tap key={option.id} haptics="selection" onPress={() => onChange(option.id)} style={{ flex: 1, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: on ? p.raised : 'transparent', ...(on ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 } : {}) }}>
						{option.icon ? <Icon name={option.icon} size={14} color={on ? p.fg : p.fgTertiary} /> : null}
						<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgTertiary}>{option.label}</T>
					</Tap>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	pressed: { opacity: 0.6, transform: [{ scale: 0.985 }] },
	disabled: { opacity: 0.4 },
});
