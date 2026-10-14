import { StyleSheet, View } from 'react-native';
import type { AgentServerConnectionState } from '@/core/voltCore';
import { colors } from '@/lib/theme';
import { Text } from './Text';

const LABELS: Record<string, string> = {
	open: 'Connected',
	connecting: 'Connecting…',
	idle: 'Offline',
	closed: 'Reconnecting…',
	none: 'Not paired',
};

/** Whether this phone is talking to the agent server (after T3 Code's ConnectionStatusDot). */
export function ConnectionDot({ state, label = false }: { readonly state: AgentServerConnectionState | 'none'; readonly label?: boolean }) {
	const color = state === 'open' ? colors.green : state === 'none' ? colors.textQuaternary : colors.warning;
	return (
		<View style={styles.row} accessibilityLabel={LABELS[state] ?? state}>
			<View style={[styles.dot, { backgroundColor: color }]} />
			{label ? <Text size={12} color={colors.textTertiary}>{LABELS[state] ?? state}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	dot: { width: 7, height: 7, borderRadius: 3.5 },
});
