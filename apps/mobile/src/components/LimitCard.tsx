import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { limitRecoveryView, nextLimitViewChange } from '@/core/voltCore';
import type { AgentClientServices, IOrchLimitStop } from '@/core/voltCore';
import { colors, radius } from '@/lib/theme';
import { GaugeIcon } from './Icons';
import { Text } from './Text';

interface Props {
	readonly services: AgentClientServices;
	readonly sessionId: string;
	readonly limit: IOrchLimitStop;
}

/**
 * "Usage limit reached": the agent window's limit card (agentLimitBanner.ts), drawn like its queue
 * card above the composer. Same view model and the same orchestrator call as desktop and web.
 */
export function LimitCard({ services, sessionId, limit }: Props) {
	const [now, setNow] = useState(() => Date.now());
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		const next = nextLimitViewChange(limit, now);
		if (next === undefined) {
			return;
		}
		const timer = setTimeout(() => setNow(Date.now()), next - now);
		return () => clearTimeout(timer);
	}, [limit, now]);
	useEffect(() => setError(undefined), [limit]);

	const view = limitRecoveryView(limit, now, services.history.get(sessionId));
	const choose = async (choice: { autoResume?: boolean; snooze?: boolean }) => {
		void Haptics.selectionAsync();
		setPending(true);
		try {
			setError(await services.orchestrator.setLimitRecovery(sessionId, limit.turnId, choice));
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not change limit recovery.');
		}
		setPending(false);
	};

	return (
		<View style={styles.card} accessibilityRole="summary">
			<View style={styles.head}>
				<GaugeIcon color={colors.textSecondary} />
				<Text size={13} weight="medium" color={colors.textSecondary} style={styles.title}>{view.title}</Text>
			</View>
			<Text size={12} color={error ? colors.red : colors.warning} numberOfLines={2}>{error ?? view.description}</Text>
			{view.canSchedule ? (
				<View style={styles.actions}>
					{!view.resetPassed ? (
						<Pressable onPress={() => choose({ snooze: !view.snoozed })} disabled={pending} accessibilityRole="button" accessibilityState={{ selected: view.snoozed, disabled: pending }} hitSlop={8} style={pending && styles.disabled}>
							<Text size={13} color={colors.textSecondary}>{pending ? 'Saving…' : view.snoozeLabel}</Text>
						</Pressable>
					) : null}
					<Pressable
						style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed, pending && styles.disabled]}
						onPress={() => choose({ autoResume: !view.autoResume })}
						disabled={pending}
						accessibilityRole="button"
						accessibilityState={{ selected: view.autoResume, disabled: pending }}
						hitSlop={6}
					>
						<Text size={13} weight="light" color="#141414">{pending ? 'Saving…' : view.resumeLabel}</Text>
					</Pressable>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	/** The queue card's look (agentEditor.css `.volt-agent-queue-card`). */
	card: {
		paddingVertical: 10,
		paddingHorizontal: 12,
		gap: 4,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: 'rgba(255,255,255,0.14)',
		backgroundColor: '#222222',
	},
	head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	title: { flexShrink: 1 },
	actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 14, marginTop: 6 },
	primary: { height: 30, paddingHorizontal: 14, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: '#f0f0f0' },
	primaryPressed: { backgroundColor: '#d8d8d8' },
	disabled: { opacity: 0.6 },
});
