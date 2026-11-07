/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRoute } from 'expo-router';
import type { NativeStackHeaderProps } from 'expo-router/native-stack';
import { type ReactNode, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { Extrapolation, interpolate, makeMutable, type SharedValue, useAnimatedScrollHandler, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/theme';
import { IconButton, T } from './core';

/** How far each screen's list has scrolled, by route, so its header (drawn outside the screen) can follow it. */
const offsets = new Map<string, SharedValue<number>>();
/** Where a screen's own big title ends: past it, the header shows the title instead. */
const reveals = new Map<string, SharedValue<number>>();

function shared(map: Map<string, SharedValue<number>>, key: string): SharedValue<number> {
	let value = map.get(key);
	if (!value) {
		value = makeMutable(0);
		map.set(key, value);
	}
	return value;
}

/**
 * The scroll handler a screen puts on its Animated list so the header follows it: a hairline fades
 * in once content runs under the header, and with `revealTitleAt` (the bottom of the screen's own
 * big title, in points) the header's title fades in as that title scrolls away.
 */
export function useHeaderScroll(revealTitleAt?: number) {
	const key = useRoute().key;
	const offset = shared(offsets, key);
	const reveal = shared(reveals, key);
	useEffect(() => {
		reveal.value = revealTitleAt ?? 0;
	}, [reveal, revealTitleAt]);
	useEffect(() => () => {
		offsets.delete(key);
		reveals.delete(key);
	}, [key]);
	return useAnimatedScrollHandler(event => {
		offset.value = event.contentOffset.y;
	});
}

const BAR = 48;

/**
 * The header of every pushed screen, Volt's own instead of the system bar: a bare back chevron,
 * the title centred between the side actions, the screen's `headerRight` actions as bare glyphs,
 * and a hairline that fades in once the list scrolls under it.
 */
export function StackHeader({ navigation, route, options, back }: NativeStackHeaderProps) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const offset = shared(offsets, route.key);
	const reveal = shared(reveals, route.key);
	const [sides, setSides] = useState({ left: 44, right: 44 });
	const sheet = Platform.OS === 'ios' && (options.presentation === 'modal' || options.presentation === 'formSheet' || options.presentation === 'pageSheet');
	const title = typeof options.headerTitle === 'string' ? options.headerTitle : options.title ?? '';
	const right = options.headerRight?.({ canGoBack: !!back, tintColor: p.fg });
	const left = options.headerLeft?.({ canGoBack: !!back, tintColor: p.fg, label: back?.title, href: back?.href });

	const line = useAnimatedStyle(() => ({ opacity: interpolate(offset.value, [0, 10], [0, 1], Extrapolation.CLAMP) }));
	const titleStyle = useAnimatedStyle(() => {
		if (!reveal.value) {
			return { opacity: 1, transform: [{ translateY: 0 }] };
		}
		const shown = interpolate(offset.value, [reveal.value - 28, reveal.value], [0, 1], Extrapolation.CLAMP);
		return { opacity: shown, transform: [{ translateY: (1 - shown) * 8 }] };
	});

	const inset = Math.max(sides.left, sides.right) + 4;
	return (
		<View style={{ paddingTop: sheet ? 6 : insets.top, backgroundColor: p.canvas }}>
			<View style={styles.bar}>
				<View style={styles.side} onLayout={e => {
					const width = e.nativeEvent.layout.width;
					setSides(s => s.left === width ? s : { ...s, left: width });
				}}>
					{left ?? (back || sheet ? (
						<IconButton icon={sheet && !back ? 'close' : sheet ? 'close' : 'chevronLeft'} size={sheet ? 21 : 25} color={p.fg} label={sheet ? 'Close' : 'Back'} onPress={() => navigation.goBack()} />
					) : null)}
				</View>
				<Animated.View pointerEvents="none" style={[styles.title, { left: inset, right: inset }, titleStyle]}>
					<Text numberOfLines={1} maxFontSizeMultiplier={1.4} style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: p.fg, letterSpacing: -0.2 }}>{title}</Text>
				</Animated.View>
				<View style={[styles.side, styles.right]} onLayout={e => {
					const width = e.nativeEvent.layout.width;
					setSides(s => s.right === width ? s : { ...s, right: width });
				}}>
					{right}
				</View>
			</View>
			<Animated.View style={[styles.line, { backgroundColor: p.stroke }, line]} />
		</View>
	);
}

/**
 * A tab's header, the system apps' large title done by hand: a row of small actions that stays put
 * over the list. The big title is the list's first row ({@link LargeTitle}); with `scroll` (from
 * {@link useLargeTitleScroll}) the row takes a small centred copy of the title, and a hairline, once
 * the big one has scrolled away. Without `scroll` the big title sits under the row.
 */
export function LargeHeader({ title, left, right, subtitle, scroll }: {
	readonly title: string;
	readonly left?: ReactNode;
	readonly right?: ReactNode;
	readonly subtitle?: ReactNode;
	readonly scroll?: SharedValue<number>;
}) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const small = useAnimatedStyle(() => {
		const shown = interpolate(scroll?.value ?? 0, [LARGE_TITLE - 22, LARGE_TITLE], [0, 1], Extrapolation.CLAMP);
		return { opacity: shown, transform: [{ translateY: (1 - shown) * 6 }] };
	});
	const line = useAnimatedStyle(() => ({ opacity: interpolate(scroll?.value ?? 0, [LARGE_TITLE - 4, LARGE_TITLE + 10], [0, 1], Extrapolation.CLAMP) }));
	return (
		<View style={{ paddingTop: insets.top + 2, backgroundColor: p.canvas, zIndex: 1 }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 8 }}>
				<View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
					{/* At the left where the big title was; not beside a left control (Home's computer pill). */}
					{left ?? (scroll ? (
						<Animated.View pointerEvents="none" style={[styles.smallTitle, small]}>
							<T variant="title3" weight="700" numberOfLines={1} style={{ letterSpacing: -0.3 }}>{title}</T>
						</Animated.View>
					) : null)}
				</View>
				<View style={{ flexDirection: 'row', alignItems: 'center' }}>{right}</View>
			</View>
			{scroll ? <Animated.View style={[styles.line, { backgroundColor: p.stroke }, line]} /> : <LargeTitle title={title} subtitle={subtitle} />}
		</View>
	);
}

/** A tab's big title, as the first row of its list (it scrolls away under the {@link LargeHeader}). */
export function LargeTitle({ title, subtitle, scroll }: { readonly title: string; readonly subtitle?: ReactNode; readonly scroll?: SharedValue<number> }) {
	// Pulled down, the title grows a little from its left edge, as the system's does.
	const stretch = useAnimatedStyle(() => ({
		transform: [{ scale: interpolate(scroll?.value ?? 0, [-90, 0], [1.07, 1], Extrapolation.CLAMP) }],
		opacity: interpolate(scroll?.value ?? 0, [0, LARGE_TITLE - 8], [1, 0], Extrapolation.CLAMP),
	}));
	return (
		<Animated.View style={[{ minHeight: LARGE_TITLE, paddingHorizontal: 20, paddingBottom: 6, justifyContent: 'flex-end', transformOrigin: 'left center' }, stretch]}>
			<T variant="title1" weight="700" style={{ letterSpacing: -0.6 }}>{title}</T>
			{subtitle}
		</Animated.View>
	);
}

const LARGE_TITLE = 44;

/** The scroll handler and offset a tab's list shares with its {@link LargeHeader}. */
export function useLargeTitleScroll() {
	const key = `large:${useRoute().key}`;
	const offset = shared(offsets, key);
	useEffect(() => () => {
		offsets.delete(key);
	}, [key]);
	const onScroll = useAnimatedScrollHandler(event => {
		offset.value = event.contentOffset.y;
	});
	return { scroll: offset, onScroll };
}

const styles = StyleSheet.create({
	bar: { height: BAR, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
	side: { minWidth: 44, flexDirection: 'row', alignItems: 'center' },
	right: { marginLeft: 'auto', justifyContent: 'flex-end' },
	title: { position: 'absolute', top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	smallTitle: { flexShrink: 1, paddingLeft: 12 },
	line: { height: StyleSheet.hairlineWidth },
});
