import { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { ACCESS_MODE_OPTIONS, currentModelRef, sendAgentPrompt, splitModelDisplayName, stopAgentTurn } from '@/core/voltCore';
import { useServerVersion, useServices } from '@/lib/connection';
import { usePickedModel } from '@/lib/modelChoice';
import { colors, fonts, radius } from '@/lib/theme';
import { BrandIcon } from './BrandIcon';
import { ArrowDownIcon, ChevronDownIcon, FolderIcon, SendIcon, ShieldIcon, StopIcon } from './Icons';
import { LimitCard } from './LimitCard';
import { Text } from './Text';
import { ThinkingDots } from './ThinkingDots';

interface Props {
	readonly sessionId: string;
	readonly isNewChat: boolean;
	readonly streaming: boolean;
	readonly status: string;
	readonly scrolledUp: boolean;
	readonly onScrollToEnd: () => void;
	readonly onSent: (sessionId: string) => void;
}

/** The agent window's composer, native: status chip, input box, model and access pickers, send/stop. */
export function Composer({ sessionId, isNewChat, streaming, status, scrolledUp, onScrollToEnd, onSent }: Props) {
	const services = useServices();
	useServerVersion(services);
	const picked = usePickedModel();
	const [text, setText] = useState('');
	const input = useRef<TextInput>(null);

	const modelRef = currentModelRef(services, isNewChat ? undefined : sessionId, picked);
	const model = modelRef ? services.runtime.resolveCatalogItem(modelRef) : undefined;
	const access = services.runtime.getAccessMode();
	const accessOption = ACCESS_MODE_OPTIONS.find(option => option.id === access);
	const project = services.projects.activeProject;
	const canSend = !!text.trim() && (!isNewChat || !!project);
	const thread = isNewChat ? undefined : services.orchestrator.getThread(sessionId);
	const limit = thread && !thread.active ? thread.limit : undefined;

	const send = () => {
		if (!text.trim()) {
			return;
		}
		if (isNewChat && !project) {
			router.push('/pick-project');
			return;
		}
		const sent = sendAgentPrompt(services, { text, sessionId, isNewChat, project, modelRef });
		if (!sent) {
			return;
		}
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		setText('');
		onSent(sent.sessionId);
		sent.done.catch(err => console.warn('[volt] send failed', err));
	};

	const stop = () => {
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
		void stopAgentTurn(services, sessionId);
	};

	return (
		<View style={styles.root}>
			{(status || scrolledUp) ? (
				<Animated.View style={styles.chips} entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} layout={LinearTransition}>
					{status ? (
						<View style={styles.chip} accessibilityLabel={status}>
							{streaming ? <ThinkingDots /> : null}
							<Text size={13} weight="light" color="#9a9a9a" numberOfLines={1}>{status}</Text>
						</View>
					) : null}
					{scrolledUp ? (
						<Pressable style={[styles.chip, styles.round]} onPress={onScrollToEnd} accessibilityLabel="Scroll to bottom" hitSlop={8}>
							<ArrowDownIcon color="#9a9a9a" />
						</Pressable>
					) : null}
				</Animated.View>
			) : null}
			{limit ? <LimitCard services={services} sessionId={sessionId} limit={limit} /> : null}
			<View style={styles.box}>
				<TextInput
					ref={input}
					value={text}
					onChangeText={setText}
					placeholder={isNewChat ? 'Plan, search, build anything' : 'Send follow-up'}
					placeholderTextColor="#8b8b8b"
					multiline
					style={styles.input}
					selectionColor={colors.link}
					keyboardAppearance="dark"
					accessibilityLabel="Message"
				/>
				<View style={styles.toolbar}>
					<Pressable style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]} onPress={() => router.push('/pick-model')} accessibilityLabel={`Model: ${model?.label ?? 'pick a model'}`}>
						{model ? <BrandIcon providerId={model.providerId} size={13} /> : null}
						<Text size={13} weight="light" color={colors.textSecondary} numberOfLines={1} style={styles.shrink}>{model ? splitModelDisplayName(model.label).name : 'Pick a model'}</Text>
						<ChevronDownIcon />
					</Pressable>
					<Pressable style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]} onPress={() => router.push('/pick-access')} accessibilityLabel={`Access: ${accessOption?.label ?? access}`}>
						<ShieldIcon filled={access === 'full-access' || access === 'auto'} />
						<Text size={13} weight="light" color={colors.textSecondary} numberOfLines={1}>{accessOption?.label ?? access}</Text>
						<ChevronDownIcon />
					</Pressable>
					<View style={styles.spacer} />
					{streaming && !text.trim() ? (
						<Pressable style={[styles.send, styles.sendOn]} onPress={stop} accessibilityLabel="Stop" hitSlop={8}>
							<StopIcon />
						</Pressable>
					) : (
						<Pressable style={[styles.send, canSend ? styles.sendOn : styles.sendOff]} onPress={send} disabled={!text.trim()} accessibilityLabel="Send" hitSlop={8}>
							<SendIcon color={canSend ? '#181818' : '#6b6b6b'} />
						</Pressable>
					)}
				</View>
			</View>
			{isNewChat ? (
				<View style={styles.landing}>
					<Pressable style={({ pressed }) => [styles.landingPick, pressed && styles.pillPressed]} onPress={() => router.push('/pick-project')} accessibilityLabel={`Project: ${project?.displayName ?? 'select a project'}`}>
						<FolderIcon />
						<Text size={13} color={project ? colors.textSecondary : colors.textTertiary} numberOfLines={1} style={styles.shrink}>{project?.displayName ?? 'Select project'}</Text>
						<ChevronDownIcon />
					</Pressable>
					<View style={styles.landingPick}>
						<Text size={13} color={colors.textTertiary}>This Mac</Text>
					</View>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { paddingHorizontal: 12, paddingTop: 6, gap: 8 },
	chips: { flexDirection: 'row', gap: 8, alignItems: 'center' },
	chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: '#222222', maxWidth: '80%' },
	round: { width: 30, paddingHorizontal: 0, justifyContent: 'center' },
	box: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: '#222222', paddingTop: 10, paddingBottom: 8, paddingHorizontal: 12, gap: 8 },
	input: { minHeight: 22, maxHeight: 150, color: colors.text, ...fonts.light, fontSize: 15, lineHeight: 22, padding: 0, textAlignVertical: 'top' },
	toolbar: { flexDirection: 'row', alignItems: 'center', gap: 4 },
	pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 8, borderRadius: radius.pill, maxWidth: 170 },
	pillPressed: { backgroundColor: colors.pressed },
	spacer: { flex: 1 },
	send: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
	sendOn: { backgroundColor: '#f0f0f0' },
	sendOff: { backgroundColor: 'rgba(240,240,240,0.12)' },
	landing: { flexDirection: 'row', gap: 6, paddingHorizontal: 2 },
	landingPick: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 8, borderRadius: radius.pill, maxWidth: 220 },
	shrink: { flexShrink: 1 },
});
