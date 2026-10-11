/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IconName, RADIUS } from '@volt/client-core';
import { Children, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon, T, Tap } from './core';

/** A grouped list section, iOS Settings style in Volt's surfaces. */
export function Group({ title, footer, children }: { readonly title?: string; readonly footer?: string; readonly children: ReactNode }) {
	const { p } = useTheme();
	const items = Children.toArray(children).filter(Boolean);
	return (
		<View style={{ marginTop: 22, marginHorizontal: 16 }}>
			{title ? <T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, marginLeft: 14, marginBottom: 7 }}>{title.toUpperCase()}</T> : null}
			<View style={{ backgroundColor: p.surface, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>
				{items.map((child, i) => (
					<View key={i}>
						{i ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 52 }} /> : null}
						{child}
					</View>
				))}
			</View>
			{footer ? <T variant="footnote" color={p.fgTertiary} style={{ marginHorizontal: 14, marginTop: 7 }}>{footer}</T> : null}
		</View>
	);
}

export function ListRow({ icon, iconColor, iconBg, label, detail, value, chevron, onPress, right, destructive, checked }: {
	readonly icon?: IconName;
	readonly iconColor?: string;
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
		<Tap disabled={!onPress} haptics="selection" onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 14, paddingVertical: 9 }}>
			{icon ? (
				<View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: iconBg ?? p.fill, alignItems: 'center', justifyContent: 'center' }}>
					<Icon name={icon} size={16} color={iconColor ?? (destructive ? p.danger : p.fgSecondary)} />
				</View>
			) : null}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="body" color={destructive ? p.danger : p.fg} numberOfLines={1}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={2}>{detail}</T> : null}
			</View>
			{value ? <T variant="small" color={p.fgTertiary} numberOfLines={1} style={{ maxWidth: '45%' }}>{value}</T> : null}
			{right}
			{checked ? <Icon name="check" size={18} color={p.accent} strokeWidth={2.2} /> : null}
			{chevron ? <Icon name="chevronRight" size={15} color={p.fgQuaternary} /> : null}
		</Tap>
	);
}
