/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IconName } from '@volt/client-core';
import { Children, type ReactNode, useEffect, useRef } from 'react';
import { ScrollView, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon, Ripple, T, Tap } from './core';

/**
 * Flat lists in the GitHub app's manner, in Volt's surfaces: bold section titles, rows with a
 * small coloured tile, hairlines that start after the tile, counts and a chevron on the right.
 */

export function SectionTitle({ title, action, onAction, first }: { readonly title: string; readonly action?: string; readonly onAction?: () => void; readonly first?: boolean }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: first ? 8 : 26, paddingBottom: 8 }}>
			<T variant="title2" weight="700" style={{ flex: 1, letterSpacing: -0.3 }}>{title}</T>
			{action ? (
				<Tap haptics="selection" onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={action}>
					<T variant="small" weight="600" color={p.accent}>{action}</T>
				</Tap>
			) : null}
		</View>
	);
}

/** A rounded square with a white glyph on a colour (GitHub's My Work tiles). */
export function Tile({ icon, color, size = 30, glyph }: { readonly icon?: IconName; readonly color: string; readonly size?: number; readonly glyph?: string }) {
	return (
		<View style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
			{icon ? <Icon name={icon} size={Math.round(size * 0.55)} color="#fff" strokeWidth={2} /> : null}
			{glyph ? <T variant={size >= 40 ? 'title3' : 'small'} weight="700" color="#fff">{glyph}</T> : null}
		</View>
	);
}

/** Rows on the canvas with inset hairlines between them. */
export function RowList({ children, inset = 58 }: { readonly children: ReactNode; readonly inset?: number }) {
	const { p } = useTheme();
	const items = Children.toArray(children).filter(Boolean);
	return (
		<View>
			{items.map((child, i) => (
				<View key={i}>
					{i ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: inset }} /> : null}
					{child}
				</View>
			))}
		</View>
	);
}

export function NavRow({ icon, color, tile, label, detail, count, countTone, right, chevron = true, onPress, onLongPress }: {
	readonly icon?: IconName;
	readonly color?: string;
	/** Replaces the icon tile (an avatar, a status icon). */
	readonly tile?: ReactNode;
	readonly label: string;
	readonly detail?: string;
	readonly count?: number;
	/** A count that wants attention (warning colour). */
	readonly countTone?: 'attention' | 'live';
	readonly right?: ReactNode;
	readonly chevron?: boolean;
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
}) {
	const { p } = useTheme();
	const countBg = countTone === 'attention' ? p.warning : countTone === 'live' ? p.info : undefined;
	return (
		<Ripple haptics="selection" onPress={onPress} onLongPress={onLongPress} disabled={!onPress && !onLongPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 16, paddingVertical: 10 }}>
			{tile ?? (icon ? <Tile icon={icon} color={color ?? p.fgTertiary} /> : null)}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="callout" weight="500" numberOfLines={1}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{detail}</T> : null}
			</View>
			{count !== undefined && count > 0 ? (
				countBg
					? <View style={{ minWidth: 22, height: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: countBg, alignItems: 'center', justifyContent: 'center' }}><T variant="footnote" weight="700" color="#111">{count}</T></View>
					: <T variant="callout" color={p.fgTertiary} style={{ fontVariant: ['tabular-nums'] }}>{count}</T>
			) : null}
			{right}
			{chevron ? <Icon name="chevronRight" size={16} color={p.fgQuaternary} /> : null}
		</Ripple>
	);
}

/** A horizontal row of filter chips (the Inbox's and Chats' filters). */
export function Chips<V extends string>({ value, options, onChange }: { readonly value: V; readonly options: readonly { readonly id: V; readonly label: string; readonly count?: number; readonly attention?: boolean }[]; readonly onChange: (value: V) => void }) {
	const { p } = useTheme();
	// The picked chip stays in view (a filter opened from Home may sit past the screen's edge).
	const scroller = useRef<ScrollView>(null);
	const offsets = useRef<Record<string, number>>({});
	const reveal = (x: number | undefined, animated: boolean) => x !== undefined && scroller.current?.scrollTo({ x: Math.max(0, x - 16), animated });
	useEffect(() => {
		reveal(offsets.current[value], true);
	}, [value]);
	return (
		<ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 6 }}>
			{options.map(option => {
				const on = option.id === value;
				return (
					<Ripple key={option.id} haptics="selection" onPress={() => onChange(option.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
						onLayout={e => {
							const first = offsets.current[option.id] === undefined;
							offsets.current[option.id] = e.nativeEvent.layout.x;
							if (on && first) {
								reveal(e.nativeEvent.layout.x, false);
							}
						}}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 13, borderRadius: 17, backgroundColor: on ? p.fillStrong : 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: on ? p.stroke : p.strokeFaint }}>
						<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgSecondary}>{option.label}</T>
						{option.count ? (
							<View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: option.attention ? p.warning : p.fill, alignItems: 'center', justifyContent: 'center' }}>
								<T variant="caption" weight="700" color={option.attention ? '#111' : p.fgSecondary}>{option.count}</T>
							</View>
						) : null}
					</Ripple>
				);
			})}
		</ScrollView>
	);
}

/**
 * A project's avatar: a folder glyph in a hairline circle, no colour (a git repository gets the
 * branching folder). The name is only its label for screen readers.
 */
export function ProjectAvatar({ name, size = 30, git }: { readonly name: string; readonly size?: number; readonly git?: boolean }) {
	const { p } = useTheme();
	return (
		<View accessibilityLabel={name} style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: p.stroke, alignItems: 'center', justifyContent: 'center' }}>
			<Icon name={git ? 'folderGit' : 'folder'} size={Math.round(size * 0.46)} color={p.fgSecondary} />
		</View>
	);
}

/**
 * Rows on one rounded surface with inset hairlines (Home's All chats / Projects / Settled list):
 * bare glyphs, no coloured tiles.
 */
export function CardGroup({ children, inset = 52, style }: { readonly children: ReactNode; readonly inset?: number; readonly style?: StyleProp<ViewStyle> }) {
	const { p } = useTheme();
	const rows = Children.toArray(children).filter(Boolean);
	return (
		<View style={[{ marginHorizontal: 16, marginTop: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', backgroundColor: p.surface, borderColor: p.strokeFaint }, style]}>
			{rows.map((row, i) => (
				<View key={i}>
					{i ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: inset }} /> : null}
					{row}
				</View>
			))}
		</View>
	);
}

/** One row of a {@link CardGroup}: a bare glyph, the label (and a detail), a count, a chevron. */
export function CardRow({ icon, tile, label, detail, count, countColor, onPress }: {
	readonly icon?: IconName;
	readonly tile?: ReactNode;
	readonly label: string;
	readonly detail?: string;
	readonly count?: number;
	readonly countColor?: string;
	readonly onPress: () => void;
}) {
	const { p } = useTheme();
	return (
		<Ripple onPress={onPress} accessibilityRole="button" accessibilityLabel={count ? `${label}, ${count}` : label}
			unstable_pressDelay={40}
			style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 14, paddingVertical: 9 }}>
			{tile ?? (icon ? <View style={{ width: 24, alignItems: 'center' }}><Icon name={icon} size={20} color={p.fgSecondary} /></View> : null)}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="callout" weight="500" numberOfLines={1}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{detail}</T> : null}
			</View>
			{count ? <T variant="callout" color={countColor ?? p.fgTertiary} style={{ fontVariant: ['tabular-nums'] }}>{count}</T> : null}
			<Icon name="chevronRight" size={16} color={p.fgQuaternary} />
		</Ripple>
	);
}
