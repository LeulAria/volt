/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { callClock, callStatusLabel, type IVoiceCallRecord, type IVoiceTurn, VOICE_LANGUAGES, VOICE_NAMES, VOICE_SPEEDS } from '@volt/client-core';
import { router } from 'expo-router';
import { memo, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useClient } from '../../state/client';
import { useTheme } from '../../theme/theme';
import { Icon, T, Tap } from '../../ui/core';
import { Sheet } from '../../ui/sheets';
import { type IVoiceCallState, useVoiceCall } from './voiceCall';

const BARS = 46;

/** The line's loudness as bars, newest on the right; a dotted line while quiet. */
const CallWaveform = memo(function CallWaveform({ live }: { readonly live: boolean }) {
	const { p } = useTheme();
	const call = useVoiceCall();
	const [levels, setLevels] = useState<readonly number[]>(() => new Array(BARS).fill(0));
	useEffect(() => call?.onLevel(level => setLevels(prev => [...prev.slice(1), level])), [call]);
	return (
		<View accessibilityRole={live ? 'image' : 'progressbar'} accessibilityLabel={live ? 'Voice chat audio' : 'Connecting…'} style={{ flex: 1, minWidth: 64, height: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: live ? 0.74 : 0.36 }}>
			{levels.map((level, index) => {
				const height = live ? Math.max(2, Math.min(20, Math.pow(level, 0.7) * 32)) : 2;
				const edge = Math.min(1, Math.min(index, BARS - 1 - index) / 6);
				return <View key={index} style={{ width: 2, height, borderRadius: 1, backgroundColor: p.fg, opacity: 0.35 + 0.65 * edge }} />;
			})}
		</View>
	);
});

function useClock(since: number | undefined): string {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!since) {
			return undefined;
		}
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [since]);
	return since ? callClock(now - since) : '';
}

function RoundButton({ icon, label, onPress, tone = 'rest', small }: { readonly icon: 'mic' | 'micOff' | 'gear' | 'paragraph' | 'phoneOff' | 'close'; readonly label: string; readonly onPress: () => void; readonly tone?: 'rest' | 'on' | 'danger'; readonly small?: boolean }) {
	const { p } = useTheme();
	const size = small ? 28 : 36;
	const color = tone === 'danger' ? p.danger : tone === 'on' ? p.info : p.fgSecondary;
	const bg = tone === 'danger' ? `${p.danger}29` : tone === 'on' ? `${p.info}2E` : p.fill;
	return (
		<Tap haptics="selection" onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={label} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }}>
			<Icon name={icon} size={small ? 14 : 17} color={color} />
		</Tap>
	);
}

/**
 * The call's bar above the composer (Cursor's VoiceCallTray): "Voice chat" and its clock, the
 * line's waveform, Mute, Settings, View transcript and Hang up. On another chat it is the return
 * row; a call that could not start says why.
 */
export function VoiceTray({ chatKey }: { readonly chatKey: string }) {
	const { p } = useTheme();
	const call = useVoiceCall();
	const [sheet, setSheet] = useState<'settings' | 'transcript' | undefined>();
	const state = call?.state;
	const clock = useClock(state?.phase === 'live' ? state.connectedAt : undefined);
	if (!call || !state || state.phase === 'idle') {
		return null;
	}
	// Once the call works in a chat (a new chat's first task started one), that chat's composer holds it.
	const mine = state.chatId ? state.chatId === chatKey : state.originKey === chatKey;
	if (state.phase === 'failed') {
		if (!mine) {
			return null;
		}
		return (
			<Animated.View entering={FadeIn.duration(180)} accessibilityRole="alert" style={[styles.tray, { backgroundColor: p.raised, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
				<View style={{ flex: 1, gap: 2 }}>
					<T variant="small" color={p.fgSecondary}>Voice chat</T>
					<T variant="small">{state.error ?? 'The voice chat could not start.'}</T>
				</View>
				<RoundButton icon="close" label="Dismiss" small onPress={call.dismissFailure} />
			</Animated.View>
		);
	}
	if (!mine) {
		return (
			<Animated.View entering={FadeIn.duration(180)} style={[styles.tray, { backgroundColor: p.raised, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }]}>
				<T variant="small" color={p.fgSecondary} numberOfLines={1} style={{ flex: 1 }}>Voice chat {clock ? <T variant="small" color={p.fgTertiary}>{clock}</T> : null}</T>
				<RoundButton icon={state.muted ? 'micOff' : 'mic'} label={state.muted ? 'Unmute' : 'Mute'} small tone={state.muted ? 'on' : 'rest'} onPress={() => call.setMuted(!state.muted)} />
				<Tap haptics="selection" onPress={() => state.chatId && router.push(`/chat/${state.chatId}`)} accessibilityRole="button" accessibilityLabel="Return to the voice chat" style={{ height: 28, paddingHorizontal: 12, borderRadius: 14, justifyContent: 'center', backgroundColor: p.fill }}>
					<T variant="small" weight="600">Return</T>
				</Tap>
			</Animated.View>
		);
	}
	return (
		<Animated.View entering={FadeIn.duration(200)} style={[styles.tray, { backgroundColor: p.raised }]} accessibilityLabel="Voice chat">
			<View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
				<T variant="small" color={p.fgSecondary}>Voice chat</T>
				{state.phase === 'live' ? <T variant="small" color={p.fgTertiary} style={{ fontVariant: ['tabular-nums'] }}>{clock}</T> : null}
			</View>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
				<CallWaveform live={state.phase === 'live'} />
				<View style={{ flexDirection: 'row', gap: 8 }}>
					<RoundButton icon={state.muted ? 'micOff' : 'mic'} label={state.muted ? 'Unmute' : 'Mute'} tone={state.muted ? 'on' : 'rest'} onPress={() => call.setMuted(!state.muted)} />
					<RoundButton icon="gear" label="Settings" tone={sheet === 'settings' ? 'on' : 'rest'} onPress={() => setSheet('settings')} />
					<RoundButton icon="paragraph" label="View transcript" onPress={() => setSheet('transcript')} />
					<RoundButton icon="phoneOff" label="Hang up" tone="danger" onPress={call.hangUp} />
				</View>
			</View>
			<VoiceSettingsSheet visible={sheet === 'settings'} onClose={() => setSheet(undefined)} state={state} />
			<VoiceTranscriptSheet visible={sheet === 'transcript'} onClose={() => setSheet(undefined)} callId={state.callId} />
		</Animated.View>
	);
}

/** Voice, Speed and Language, as Cursor's tray menu; picking a voice applies it to the call. */
function VoiceSettingsSheet({ visible, onClose, state }: { readonly visible: boolean; readonly onClose: () => void; readonly state: IVoiceCallState }) {
	const { p } = useTheme();
	const call = useVoiceCall();
	const row = (label: string, checked: boolean, onPress: () => void) => (
		<Tap key={label} haptics="selection" onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: checked }} style={{ height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 }}>
			<T style={{ flex: 1 }}>{label}</T>
			{checked ? <Icon name="check" size={16} color={p.accent} /> : null}
		</Tap>
	);
	const label = (text: string) => <T variant="footnote" color={p.fgTertiary} style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 }}>{text}</T>;
	return (
		<Sheet visible={visible} onClose={onClose} title="Voice chat settings">
			{label('Speed')}
			<View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 4 }}>
				{VOICE_SPEEDS.map(speed => (
					<Tap key={speed} haptics="selection" onPress={() => call?.setSettings({ speed })} accessibilityRole="button" accessibilityState={{ selected: state.settings.speed === speed }} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: state.settings.speed === speed ? p.fillStrong : p.fill }}>
						<T variant="small" weight={state.settings.speed === speed ? '600' : '400'}>{speed}x</T>
					</Tap>
				))}
			</View>
			{label('Voice')}
			{VOICE_NAMES.map(voice => row(voice[0].toUpperCase() + voice.slice(1), state.settings.voice === voice, () => call?.setSettings({ voice })))}
			{label('Language')}
			{VOICE_LANGUAGES.map(language => row(language.label, state.settings.language === language.id, () => call?.setSettings({ language: language.id })))}
		</Sheet>
	);
}

/** A call's transcript: the live call's lines as they come, or a saved call's. */
export function VoiceTranscriptSheet({ visible, onClose, callId }: { readonly visible: boolean; readonly onClose: () => void; readonly callId?: string }) {
	const { p } = useTheme();
	const client = useClient();
	const call = useVoiceCall();
	const [saved, setSaved] = useState<IVoiceCallRecord | undefined>();
	const live = !!callId && call?.state.callId === callId && call.active;
	useEffect(() => {
		if (visible && callId && !live) {
			void client.voiceCall(callId).then(setSaved);
		}
	}, [client, visible, callId, live]);
	const turns: readonly IVoiceTurn[] = live ? call!.state.turns : saved?.turns ?? [];
	const record = live ? { status: 'ongoing' as const, connectedAt: call!.state.connectedAt } : saved;
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!visible || !live) {
			return undefined;
		}
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [visible, live]);
	const started = saved?.startedAt ?? call?.state.connectedAt;
	const subtitle = [started ? new Date(started).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : undefined, record ? callStatusLabel(record, live, now) : undefined].filter(Boolean).join(' · ');
	return (
		<Sheet visible={visible} onClose={onClose} title="Voice call" subtitle={subtitle}>
			<View style={{ padding: 16, gap: 12 }}>
				{turns.length ? turns.map(turn => (
					turn.role === 'user' ? (
						<View key={turn.id} style={{ alignSelf: 'stretch', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: p.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
							<T>{turn.text}</T>
						</View>
					) : <T key={turn.id} color={turn.role === 'note' ? p.fgTertiary : p.fg} variant={turn.role === 'note' ? 'footnote' : 'body'} style={{ paddingHorizontal: 14 }}>{turn.text}</T>
				)) : <T variant="small" color={p.fgTertiary} align="center" style={{ paddingVertical: 24 }}>{live ? 'No speech transcribed yet' : 'Nothing was said on this call.'}</T>}
			</View>
		</Sheet>
	);
}

/** A call's card in the chat (Cursor's VoiceCallCard): Voice call, its status, View transcript. */
export const VoiceCallCard = memo(function VoiceCallCard({ call }: { readonly call: IVoiceCallRecord }) {
	const { p } = useTheme();
	const voice = useVoiceCall();
	const [open, setOpen] = useState(false);
	const live = voice?.state.callId === call.id && !!voice.active;
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!live) {
			return undefined;
		}
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [live]);
	const record = live ? { ...call, connectedAt: voice!.state.connectedAt } : call;
	return (
		<>
			<Tap haptics="selection" onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Voice call, ${callStatusLabel(record, live, now)}. View transcript`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: p.raised }}>
				<View style={{ flex: 1, gap: 2 }}>
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
						<Icon name="waveform" size={14} color={p.fg} />
						<T variant="small" weight="500">Voice call</T>
					</View>
					<T variant="footnote" color={p.fgTertiary} style={{ fontVariant: ['tabular-nums'] }}>{callStatusLabel(record, live, now)}</T>
				</View>
				<T variant="footnote" color={p.fgSecondary}>View transcript</T>
			</Tap>
			<VoiceTranscriptSheet visible={open} onClose={() => setOpen(false)} callId={call.id} />
		</>
	);
});

const styles = StyleSheet.create({
	tray: { borderRadius: 14, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10 },
});
