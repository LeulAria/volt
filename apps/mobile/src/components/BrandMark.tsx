import { Image, StyleSheet, View } from 'react-native';
import { Text } from './Text';

const ICON = require('../../assets/icon.png');

/** Volt's logo, with the name beside it when `label` is set. */
export function BrandMark({ size = 22, label = false }: { readonly size?: number; readonly label?: boolean }) {
	return (
		<View style={styles.row} accessibilityRole="image" accessibilityLabel="Volt">
			<Image source={ICON} style={{ width: size, height: size, borderRadius: size * 0.2237 }} />
			{label ? <Text weight="semibold" size={Math.round(size * 0.72)}>Volt</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
