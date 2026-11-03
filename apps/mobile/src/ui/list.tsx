/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IconName } from '@volt/client-core';
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon, Ripple, T } from './core';

/**
 * Lists in VS Code's manner: a small uppercase section header, then square rows that run edge to
 * edge with no card, no tile and no separators; a pressed row ripples from the finger.
 */
export function Group({ title, footer, right, children }: { readonly title?: string; readonly footer?: string; readonly right?: ReactNode; readonly children: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ marginTop: 18 }}>
			{title ? <SectionHeader title={title} right={right} /> : null}
			{children}
			{footer ? <T variant="footnote" color={p.fgTertiary} style={{ marginHorizontal: 16, marginTop: 6, marginBottom: 2 }}>{footer}</T> : null}
		</View>
	);
}

/** VS Code's pane header: an uppercase caption, with room for a value or action at the right. */
export function SectionHeader({ title, right }: { readonly title: string; readonly right?: ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 30, paddingHorizontal: 16, paddingTop: 4 }}>
			<T variant="caption" weight="700" color={p.fgTertiary} numberOfLines={1} style={{ flex: 1, letterSpacing: 0.7 }}>{title.toUpperCase()}</T>
			{right}
		</View>
	);
}

/** A row that answers a press with an ink ripple from the finger; `selected` keeps it filled. */
export function ListItem({ onPress, onLongPress, disabled, style, children, accessibilityLabel, selected }: {
	readonly onPress?: () => void;
	readonly onLongPress?: () => void;
	readonly disabled?: boolean;
	readonly style?: StyleProp<ViewStyle>;
	readonly children: ReactNode;
	readonly accessibilityLabel?: string;
	readonly selected?: boolean;
}) {
	const { p } = useTheme();
	if (!onPress && !onLongPress) {
		return <View style={[styles.row, selected ? { backgroundColor: p.fill } : null, style]}>{children}</View>;
	}
	return (
		<Ripple onPress={onPress} onLongPress={onLongPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel} unstable_pressDelay={40} selected={selected} style={[styles.row, style]}>
			{children}
		</Ripple>
	);
}

export function ListRow({ icon, iconColor, label, detail, value, chevron, onPress, right, destructive, checked }: {
	readonly icon?: IconName;
	readonly iconColor?: string;
	/** @deprecated Rows draw bare glyphs now; kept so callers compile. */
	readonly iconBg?: string;
	readonly label: string;
	readonly detail?: string;
	readonly value?: string;
	readonly chevron?: boolean;
	readonly onPress?: () => void;
	readonly right?: ReactNode;
	readonly destructive?: boolean;
	readonly checked?: boolean;
}) {
	const { p } = useTheme();
	return (
		<ListItem onPress={onPress} accessibilityLabel={label}>
			{icon ? (
				<View style={styles.glyph}>
					<Icon name={icon} size={19} color={iconColor ?? (destructive ? p.danger : p.fgSecondary)} />
				</View>
			) : null}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="body" color={destructive ? p.danger : p.fg} numberOfLines={1} style={{ fontSize: 15 }}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={2}>{detail}</T> : null}
			</View>
			{value ? <T variant="small" color={p.fgTertiary} numberOfLines={1} style={{ maxWidth: '45%' }}>{value}</T> : null}
			{right}
			{checked ? <Icon name="check" size={18} color={p.fg} /> : null}
			{chevron ? <Icon name="chevronRight" size={15} color={p.fgQuaternary} /> : null}
		</ListItem>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 16, paddingVertical: 7 },
	glyph: { width: 22, alignItems: 'center' },
});
