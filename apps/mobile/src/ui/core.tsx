/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ChatStatus, type IconName, ICONS, RADIUS, statusColor, timer, TYPE } from '@volt/client-core';
import * as Haptics from 'expo-haptics';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, type PressableProps, type StyleProp, StyleSheet, Text, type TextProps, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, interpolate, makeMutable, type SharedValue, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
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

/** Volt's app icon (brand/volt-icon.png, cropped to its squircle). */
export function VoltMark({ size, style }: { readonly size: number; readonly style?: StyleProp<ViewStyle> }) {
	return (
		<View style={[{ width: size, height: size }, style]}>
			<Image source={require('../../assets/volt-mark.png')} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />
		</View>
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

/**
 * One clock for every live verb ("Exploring", "Running"), so rows drawn at different times sweep
 * in step, as the desktop locks its shimmers to the page clock. It runs while any shimmer shows.
 */
const shimmerClock = makeMutable(0);
let shimmerUsers = 0;

function useShimmerClock(active: boolean): void {
	useEffect(() => {
		if (!active) {
			return;
		}
		if (shimmerUsers++ === 0) {
			shimmerClock.value = 0;
			shimmerClock.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1, false);
		}
		return () => {
			if (--shimmerUsers === 0) {
				cancelAnimation(shimmerClock);
			}
		};
	}, [active]);
}

/** Layout keys that belong on the shimmer's wrapper, so it sits in a row as the bare text did. */
const OUTER_KEYS = ['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'minWidth', 'maxWidth', 'width'] as const;

/** The band's soft edge: three widths of the bright copy, each faint, stacked so the middle is brightest. */
const SHIMMER_BANDS = [{ width: 0.55, opacity: 0.35 }, { width: 0.35, opacity: 0.45 }, { width: 0.18, opacity: 0.6 }] as const;

/**
 * Text with a light band sweeping across it while it is live (agentTranscript.css
 * `.volt-tr-action.shimmer`): the text sits in the quiet tone and a bright copy shows through a
 * window that slides left to right. Still, it takes `color`.
 */
export const ShimmerText = memo(function ShimmerText({ active, color, from, to, style, children, numberOfLines }: {
	readonly active: boolean;
	readonly color: string;
	readonly from?: string;
	readonly to?: string;
	readonly style?: StyleProp<TextStyle>;
	readonly children: ReactNode;
	readonly numberOfLines?: number;
}) {
	const { p } = useTheme();
	useShimmerClock(active);
	const [width, setWidth] = useState(0);
	if (!active) {
		return <Text numberOfLines={numberOfLines} maxFontSizeMultiplier={1.6} style={[style, { color }]}>{children}</Text>;
	}
	const flat = StyleSheet.flatten(style) ?? {};
	const outer: Record<string, unknown> = {};
	const inner: Record<string, unknown> = { ...flat };
	for (const key of OUTER_KEYS) {
		if (key in inner) {
			outer[key] = inner[key];
			delete inner[key];
		}
	}
	const high = to ?? p.fgSecondary;
	return (
		<View style={outer as ViewStyle}>
			<Text numberOfLines={numberOfLines} maxFontSizeMultiplier={1.6} onLayout={e => setWidth(e.nativeEvent.layout.width)} style={[inner as TextStyle, { color: from ?? p.fgQuaternary }]}>{children}</Text>
			{width ? SHIMMER_BANDS.map((band, i) => (
				<ShimmerBand key={i} width={width} band={band.width * width} opacity={band.opacity} clock={shimmerClock}>
					<Text numberOfLines={numberOfLines} maxFontSizeMultiplier={1.6} style={[inner as TextStyle, { color: high, width }]}>{children}</Text>
				</ShimmerBand>
			)) : null}
		</View>
	);
});

/** One window onto the bright copy, sliding across; the copy moves the other way so it stays in register. */
function ShimmerBand({ width, band, opacity, clock, children }: { readonly width: number; readonly band: number; readonly opacity: number; readonly clock: SharedValue<number>; readonly children: ReactNode }) {
	// Every band shares one centre, which runs from past the left edge to past the right.
	const reach = width * SHIMMER_BANDS[0].width;
	const windowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(clock.value, [0, 1], [-reach, width + reach]) - band / 2 }] }), [width, band, reach]);
	const copyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: band / 2 - interpolate(clock.value, [0, 1], [-reach, width + reach]) }] }), [width, band, reach]);
	return (
		<Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, width: band, overflow: 'hidden', opacity }, windowStyle]}>
			<Animated.View style={[{ position: 'absolute', top: 0, left: 0 }, copyStyle]}>{children}</Animated.View>
		</Animated.View>
	);
}

/** A codicon-style spinner: a three-quarter ring that turns (the desktop's `codicon-loading`). */
export function Spinner({ size = 13, color }: { readonly size?: number; readonly color?: string }) {
	const { p } = useTheme();
	const c = color ?? p.iconTertiary;
	return (
		<Spin duration={900}>
			<Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth={1.6} strokeLinecap="round">
				<Path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />
			</Svg>
		</Spin>
	);
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

export function Pill({ label, icon, glyph, color, bg, onPress, onLongPress, maxWidth = 180 }: {
	readonly label: string;
	readonly icon?: IconName;
	/** Drawn in place of `icon` (a brand mark). */
	readonly glyph?: ReactNode;
	readonly color?: string;
	readonly bg?: string;
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
	readonly maxWidth?: number;
}) {
	const { p } = useTheme();
	return (
		<Tap onPress={onPress} onLongPress={onLongPress} haptics="selection" style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: bg ?? p.fill, maxWidth }}>
			{glyph ?? (icon ? <Icon name={icon} size={14} color={color ?? p.fgSecondary} /> : null)}
			<T variant="small" weight="500" color={color ?? p.fgSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
		</Tap>
	);
}

/**
 * Tabs in Material's manner: equal-width labels over a hairline, the picked one bright with an
 * indicator under it that slides across when the pick changes.
 */
export function Tabs<V extends string>({ value, options, onChange }: { readonly value: V; readonly options: readonly { readonly id: V; readonly label: string; readonly icon?: IconName }[]; readonly onChange: (value: V) => void }) {
	const { p } = useTheme();
	const [width, setWidth] = useState(0);
	const index = Math.max(0, options.findIndex(option => option.id === value));
	const slot = options.length ? width / options.length : 0;
	const x = useSharedValue(0);
	const placed = useRef(false);
	useEffect(() => {
		if (!slot) {
			return;
		}
		// The first placement jumps; later picks slide.
		x.value = placed.current ? withTiming(index * slot, { duration: 240, easing: Easing.out(Easing.cubic) }) : index * slot;
		placed.current = true;
	}, [index, slot, x]);
	const indicator = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
	return (
		<View accessibilityRole="tablist" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.stroke }}>
			{options.map(option => {
				const on = option.id === value;
				return (
					<Pressable key={option.id} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={option.label}
						onPress={() => {
							if (!on) {
								haptic.selection();
								onChange(option.id);
							}
						}}
						style={({ pressed }) => [styles.tab, pressed ? { backgroundColor: p.fillFaint } : null]}>
						{option.icon ? <Icon name={option.icon} size={15} color={on ? p.fg : p.fgTertiary} /> : null}
						<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgTertiary} numberOfLines={1}>{option.label}</T>
					</Pressable>
				);
			})}
			{slot ? (
				<Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, bottom: -StyleSheet.hairlineWidth, width: slot, height: 2, alignItems: 'center' }, indicator]}>
					<View style={{ width: '62%', height: 2, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: p.fg }} />
				</Animated.View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	pressed: { opacity: 0.6, transform: [{ scale: 0.985 }] },
	disabled: { opacity: 0.4 },
	tab: { flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 6 },
});
