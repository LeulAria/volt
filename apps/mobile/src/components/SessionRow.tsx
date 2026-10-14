import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { compactSessionAge, sessionStatusBadge, type IAgentRepoInfo, type IAgentSessionMeta } from '@/core/voltCore';
import { sessionPlace } from '@/lib/home';
import { colors, radius } from '@/lib/theme';
import { BranchIcon } from './Icons';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';

interface Props {
	readonly session: IAgentSessionMeta;
	readonly now: number;
	readonly repos: ReadonlyMap<string, IAgentRepoInfo>;
	readonly modelLabel?: string;
	readonly onPress: (session: IAgentSessionMeta) => void;
}

/** A chat in the home list, laid out like the agent window's two-line row. */
export const SessionRow = memo(function SessionRow({ session, now, repos, modelLabel, onPress }: Props) {
	const place = sessionPlace(session, repos);
	const badge = sessionStatusBadge(session, now);
	const age = session.updatedAt ? compactSessionAge(session.updatedAt, now) : '';
	return (
		<Pressable
			onPress={() => onPress(session)}
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
			accessibilityRole="button"
			accessibilityLabel={`${session.title || 'New chat'}${badge ? `, ${badge.label}` : ''}`}
		>
			<View style={styles.line}>
				<Text size={10} weight="semibold" color={colors.textQuaternary} style={styles.initials}>{place.initials || '··'}</Text>
				<Text size={14} weight="medium" numberOfLines={1} style={styles.title}>{session.title || 'New chat'}</Text>
				{age ? <Text size={12} color={colors.textQuaternary}>{age}</Text> : null}
				<StatusBadge badge={badge} />
			</View>
			<View style={styles.line}>
				<View style={styles.initials} />
				<View style={styles.place}>
					{place.branch ? <BranchIcon /> : null}
					<Text size={12} color={colors.textTertiary} numberOfLines={1} style={styles.flex}>{place.branch ?? place.workspace ?? 'Untitled'}</Text>
				</View>
				{modelLabel ? <Text size={12} color={colors.textTertiary} numberOfLines={1}>{modelLabel}</Text> : null}
			</View>
		</Pressable>
	);
});

const styles = StyleSheet.create({
	row: { paddingHorizontal: 12, paddingVertical: 9, marginHorizontal: 8, borderRadius: radius.md, gap: 3 },
	pressed: { backgroundColor: colors.pressed },
	line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	initials: { width: 18, textAlign: 'center' },
	title: { flex: 1 },
	place: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
	flex: { flexShrink: 1 },
});
