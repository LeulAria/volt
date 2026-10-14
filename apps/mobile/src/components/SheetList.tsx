import { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius } from '@/lib/theme';
import { CheckIcon } from './Icons';
import { Text } from './Text';

export interface ISheetItem {
	readonly key: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: ReactNode;
	readonly selected?: boolean;
}

/** A picker sheet's list, after the agent window's dropdown: icon, label, a line under it, a check. */
export function SheetList({ title, items, empty, onPick }: { readonly title: string; readonly items: readonly ISheetItem[]; readonly empty?: string; readonly onPick: (key: string) => void }) {
	const insets = useSafeAreaInsets();
	return (
		<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]} style={styles.scroll}>
			<Text size={12} weight="semibold" color={colors.textTertiary} style={styles.title}>{title.toUpperCase()}</Text>
			{items.length ? items.map(item => (
				<Pressable key={item.key} onPress={() => onPick(item.key)} style={({ pressed }) => [styles.item, item.selected && styles.selected, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ selected: item.selected }} accessibilityLabel={item.label}>
					{item.icon ? <View style={styles.icon}>{item.icon}</View> : null}
					<View style={styles.copy}>
						<Text size={14} weight={item.selected ? 'medium' : 'regular'} numberOfLines={1}>{item.label}</Text>
						{item.description ? <Text size={12} color={colors.textTertiary} numberOfLines={2}>{item.description}</Text> : null}
					</View>
					{item.selected ? <CheckIcon /> : null}
				</Pressable>
			)) : <Text size={13} color={colors.textTertiary} style={styles.empty}>{empty}</Text>}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	scroll: { backgroundColor: colors.surfaceRaised },
	content: { paddingTop: 22, paddingHorizontal: 10 },
	title: { paddingHorizontal: 12, paddingBottom: 8, letterSpacing: 0.6 },
	item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11, borderRadius: radius.md },
	selected: { backgroundColor: 'rgba(240,240,240,0.06)' },
	pressed: { backgroundColor: colors.pressed },
	icon: { width: 18, alignItems: 'center' },
	copy: { flex: 1, gap: 2 },
	empty: { padding: 12 },
});
