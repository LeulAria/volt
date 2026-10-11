/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	approvalsFor, chatStatus, type ComposerMode, COMPOSER_MODES, historyOf, isStreaming, projectOf, questionsFor, runtimeOf, sessionsOf, statusColor, threadsOf
} from '@volt/client-core';
import { BlurView } from 'expo-blur';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../../src/chat/Composer';
import { Transcript } from '../../src/chat/Transcript';
import { ApprovalCard, LimitBanner, PausedBanner, QuestionCard, QueueChip } from '../../src/chat/Trays';
import { useClient, useCollections, useOptionalClient, useTranscript } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Icon, IconButton, LiveTimer, T, Tap } from '../../src/ui/core';

const CHAT_COLLECTIONS = ['history', 'orch.threads', 'orch.tasks', 'sessions', 'access', 'questions', 'projects', 'runtime'];
const HEADER_HEIGHT = 52;

export default function ChatScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const client = useOptionalClient();
	const { p } = useTheme();
	if (!client || !id) {
		return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={p.fgTertiary} /></View>;
	}
	return <ChatView chatId={id} />;
}

function ChatView({ chatId }: { readonly chatId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const cols = useCollections(CHAT_COLLECTIONS);
	const transcript = useTranscript(chatId);
	const meta = historyOf(cols)[chatId];
	const thread = threadsOf(cols)[chatId];
	const session = sessionsOf(cols)[chatId];
	const runtime = runtimeOf(cols);
	const project = projectOf(cols, chatId);
	const approvals = approvalsFor(cols, chatId);
	const questions = questionsFor(cols, chatId);
	const messages = transcript?.messages ?? [];
	const running = !!thread?.active || isStreaming(messages);
	const status = chatStatus(meta, thread, approvals.length, questions.length);

	const lastMode = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.kind === 'user' && m.mode) {
				return m.mode;
			}
		}
		return meta?.mode;
	}, [messages, meta?.mode]);
	const [mode, setMode] = useState<ComposerMode>('Agent');
	const [modelRef, setModelRef] = useState<string | undefined>();
	const [modelTouched, setModelTouched] = useState(false);
	useEffect(() => {
		setMode(COMPOSER_MODES.find(m => m.id.toLowerCase() === (lastMode ?? '').toLowerCase())?.id ?? 'Agent');
	}, [lastMode]);
	const effectiveModel = modelTouched ? modelRef : session?.providerRef ?? thread?.modelRef ?? runtime.activeCatalogRef;

	useFocusEffect(useCallback(() => {
		client.markRead(chatId);
	}, [client, chatId]));
	useEffect(() => {
		if (meta?.unread) {
			client.markRead(chatId);
		}
	}, [client, chatId, meta?.unread]);

	const top = insets.top + HEADER_HEIGHT;
	const subtitle = [project?.displayName ?? meta?.workspaceLabel, session?.worktreeBranch ?? meta?.worktreeBranch].filter(Boolean).join(' · ');
	const tone = status.status === 'idle' ? undefined : statusColor(status.status, p);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
				<Transcript chatId={chatId} topInset={top} />
				<Animated.View layout={LinearTransition.duration(220)} style={{ paddingBottom: Math.max(insets.bottom, 8), paddingTop: 6, gap: 8 }}>
					{approvals.length || questions.length || thread?.limit || (thread?.queue.length ?? 0) > 0 ? (
						<View style={{ paddingHorizontal: 10, gap: 8 }}>
							{approvals.map(request => <ApprovalCard key={request.id} request={request} />)}
							{questions[0] ? <QuestionCard key={questions[0].id} request={questions[0]} /> : null}
							{thread?.limit ? <LimitBanner chatId={chatId} thread={thread} /> : null}
							{thread && !thread.active && thread.pause && thread.pause !== 'limit' && thread.queue.length ? <PausedBanner chatId={chatId} thread={thread} /> : null}
							{thread ? <QueueChip chatId={chatId} thread={thread} /> : null}
						</View>
					) : null}
					<Composer
						draftKey={chatId}
						running={running}
						mode={mode}
						onModeChange={setMode}
						modelRef={effectiveModel}
						onModelChange={ref => {
							setModelTouched(true);
							setModelRef(ref);
						}}
						accessMode={session?.accessMode ?? runtime.accessMode}
						onAccessChange={m => void client.setAccessMode(m, chatId)}
						onSend={(text, delivery) => {
							client.send({ threadId: chatId, text, mode, ...(effectiveModel ? { modelRef: effectiveModel } : {}), delivery });
						}}
						onStop={() => void client.stop(chatId)}
					/>
				</Animated.View>
			</KeyboardAvoidingView>
			<View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>
				{Platform.OS === 'ios'
					? <BlurView intensity={80} tint={p.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} style={StyleSheet.absoluteFill} />
					: <View style={[StyleSheet.absoluteFill, { backgroundColor: p.canvas, opacity: 0.97 }]} />}
				<View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: HEADER_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 2 }}>
					<IconButton icon="chevronLeft" label="Back" size={24} color={p.fg} onPress={() => router.back()} />
					<Tap onPress={() => router.push({ pathname: '/details/[id]', params: { id: chatId } })} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} accessibilityLabel="Chat details">
						<T variant="callout" weight="700" numberOfLines={1} style={{ letterSpacing: -0.2 }}>{meta?.title || 'New chat'}</T>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
							{tone ? <T variant="footnote" weight="600" color={tone}>{status.label}</T> : null}
							{tone && subtitle ? <T variant="footnote" color={p.fgQuaternary}>{'·'}</T> : null}
							{subtitle ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1} style={{ flexShrink: 1 }}>{subtitle}</T> : null}
						</View>
					</Tap>
					{running && thread?.active ? (
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 9, borderRadius: 13, backgroundColor: `${p.info}22` }}>
							<ActivityIndicator size="small" color={p.info} style={{ transform: [{ scale: 0.6 }], width: 12 }} />
							<LiveTimer since={thread.active.at} color={p.info} />
						</View>
					) : null}
					<IconButton icon="settings" label="Chat details" color={p.fg} onPress={() => router.push({ pathname: '/details/[id]', params: { id: chatId } })} />
				</View>
			</View>
			{!meta && !messages.length && transcript?.status !== 'loading' && !client.getPending(chatId).length ? (
				<View style={{ position: 'absolute', top: top + 40, left: 24, right: 24, alignItems: 'center', gap: 6 }}>
					<Icon name="message" size={22} color={p.fgTertiary} />
					<T variant="small" color={p.fgTertiary} align="center">This chat isn't on your computer anymore.</T>
				</View>
			) : null}
		</View>
	);
}
