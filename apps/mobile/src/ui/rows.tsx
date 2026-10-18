/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IconName } from '@volt/client-core';
import { Children, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon, T, Tap } from './core';

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
		<Tap haptics="selection" onPress={onPress} onLongPress={onLongPress} disabled={!onPress && !onLongPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 16, paddingVertical: 10 }}>
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
		</Tap>
	);
}

/** A horizontal row of filter chips (the Inbox's and Chats' filters). */
export function Chips<V extends string>({ value, options, onChange }: { readonly value: V; readonly options: readonly { readonly id: V; readonly label: string; readonly count?: number; readonly attention?: boolean }[]; readonly onChange: (value: V) => void }) {
	const { p } = useTheme();
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 6 }}>
			{options.map(option => {
				const on = option.id === value;
				return (
					<Tap key={option.id} haptics="selection" onPress={() => onChange(option.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 13, borderRadius: 17, backgroundColor: on ? p.fillStrong : 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: on ? p.stroke : p.strokeFaint }}>
						<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgSecondary}>{option.label}</T>
						{option.count ? (
							<View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: option.attention ? p.warning : p.fill, alignItems: 'center', justifyContent: 'center' }}>
								<T variant="caption" weight="700" color={option.attention ? '#111' : p.fgSecondary}>{option.count}</T>
							</View>
						) : null}
					</Tap>
				);
			})}
		</ScrollView>
	);
}

/** A project's avatar: its initials on a colour picked from its name (stable across devices). */
export function ProjectAvatar({ name, size = 30 }: { readonly name: string; readonly size?: number }) {
	const initials = name.split(/[\s_\-./]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';
	return <Tile color={projectColor(name)} glyph={initials} size={size} />;
}

const PROJECT_COLORS = ['#5B7FC7', '#3F9C6D', '#C77B3F', '#8E68D6', '#C44B68', '#2F8B8B', '#A0883A', '#6A7A8C'];

export function projectColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]!;
}
