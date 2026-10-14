import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { BrandMark } from '@/components/BrandMark';
import { ConnectionDot } from '@/components/ConnectionDot';
import { Text } from '@/components/Text';
import { useConnectionState, useServerVersion, useVolt } from '@/lib/connection';
import { colors, radius } from '@/lib/theme';

export default function Settings() {
	const { pairing, services, unpair } = useVolt();
	useServerVersion(services);
	const state = useConnectionState(services);
	const disconnect = () => Alert.alert('Disconnect from this Mac?', 'You can pair again with the code Volt shows.', [
		{ text: 'Cancel', style: 'cancel' },
		{ text: 'Disconnect', style: 'destructive', onPress: () => void unpair().then(() => router.replace('/pair')) },
	]);
	return (
		<ScrollView style={styles.screen} contentContainerStyle={styles.content}>
			<View style={styles.hero}>
				<BrandMark size={56} />
				<Text size={18} weight="semibold">Volt</Text>
				<Text size={12} color={colors.textTertiary}>Version {Constants.expoConfig?.version ?? '0.1.0'}</Text>
			</View>
			<View style={styles.card}>
				<Row label="Agent server" value={pairing?.server ?? '—'} />
				<View style={styles.rule} />
				<View style={styles.row}>
					<Text size={13} color={colors.textSecondary}>Status</Text>
					<ConnectionDot state={state} label />
				</View>
				<View style={styles.rule} />
				<Row label="Projects" value={String(services?.projects.projects.length ?? 0)} />
				<View style={styles.rule} />
				<Row label="Chats" value={String(services?.history.list().length ?? 0)} />
			</View>
			<Pressable onPress={disconnect} style={({ pressed }) => [styles.card, styles.danger, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Disconnect">
				<Text size={14} weight="medium" color={colors.red}>Disconnect</Text>
			</Pressable>
		</ScrollView>
	);
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<View style={styles.row}>
			<Text size={13} color={colors.textSecondary}>{label}</Text>
			<Text size={13} color={colors.textTertiary} numberOfLines={1} style={styles.value}>{value}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.sidebar },
	content: { padding: 16, gap: 16, paddingTop: 32 },
	hero: { alignItems: 'center', gap: 8, paddingBottom: 8 },
	card: { borderRadius: radius.lg, backgroundColor: '#1c1c1c', paddingHorizontal: 16 },
	row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, gap: 16 },
	value: { flexShrink: 1, textAlign: 'right' },
	rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	danger: { alignItems: 'center', paddingVertical: 14 },
	pressed: { opacity: 0.7 },
});
