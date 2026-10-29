/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	approvalsFor, attachmentsOf, chatStatus, chatTerminals, isTerminalLive, type ComposerMode, COMPOSER_MODES, historyOf, type IPromptAttachment, isStreaming, projectOf, questionsFor, runtimeOf, sessionsOf,
	statusColor, threadsOf, uriPath, uuid
} from '@volt/client-core';
import { BlurView } from 'expo-blur';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CHAT_TABS_HEIGHT, ChatSwitcher, ChatTabs } from '../../src/chat/ChatTabs';
import { Composer, type IComposerSendExtra } from '../../src/chat/Composer';
import { touchRecentChat, useRecentChats } from '../../src/chat/recentChats';
import { SubagentsTray, useChatTasks } from '../../src/chat/Subagents';
import { ChatContext, type IChatContext, type UserRowData } from '../../src/chat/context';
import { copyWithHaptic } from '../../src/chat/Markdown';
import { Transcript } from '../../src/chat/Transcript';
import { ApprovalCard, LimitBanner, PausedBanner, QuestionCard, QueueChip } from '../../src/chat/Trays';
import { useCheckpoints, useClient, useCollections, useOptionalClient, useStatus, useTranscript } from '../../src/state/client';
import { openRunGroup, useRunGroupOfChat } from '../../src/home/RunGroups';
import { useTheme } from '../../src/theme/theme';
import { haptic, Icon, IconButton, LiveTimer, T, Tap } from '../../src/ui/core';
import { ActionSheet, type ISheetAction } from '../../src/ui/sheets';

const CHAT_COLLECTIONS = ['history', 'orch.threads', 'orch.tasks', 'sessions', 'access', 'questions', 'projects', 'runtime', 'terminals'];
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
	const live = useStatus().live;
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
	const terminals = useMemo(() => chatTerminals(cols['terminals'], chatId), [cols, chatId]);
	const liveTerminals = terminals.filter(t => isTerminalLive(t.status)).length;

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
	const folder = session?.worktreePath ?? session?.workingFolder ?? meta?.workspaceFolder ?? uriPath(project?.root);

	// Sent messages: the menu, editing in the composer, rewinds and checkpoint restores.
	const checkpoints = useCheckpoints(chatId);
	const [menuRow, setMenuRow] = useState<UserRowData | undefined>();
	const [editing, setEditing] = useState<{ readonly turnId: string; readonly mode?: string } | undefined>();
	const [prefill, setPrefill] = useState<{ readonly key: number; readonly text: string; readonly attachments: readonly IPromptAttachment[] }>({ key: 0, text: '', attachments: [] });
	const [redoTurnId, setRedoTurnId] = useState<string | undefined>();
	const hasCheckpoint = useCallback((turnId: string) => !!checkpoints?.checkpoints.some(c => c.turnId === turnId), [checkpoints]);
	const fill = useCallback((text: string, attachments: readonly IPromptAttachment[]) => setPrefill(prev => ({ key: prev.key + 1, text, attachments })), []);
	const latest = useRef({ messages, running, hasCheckpoint });
	latest.current = { messages, running, hasCheckpoint };

	const retry = useCallback((turnId: string) => {
		const { messages: all } = latest.current;
		const index = all.findIndex(m => m.kind === 'user' && m.id === turnId);
		const later = index >= 0 ? all.slice(index + 1).filter(m => m.kind === 'user').length : 0;
		const go = () => {
			haptic.medium();
			void client.retryTurn(chatId, turnId);
		};
		if (later || latest.current.running) {
			Alert.alert('Retry this message?', later ? `The reply and the ${later} ${later === 1 ? 'message' : 'messages'} after it are removed, then the message is sent again.` : 'The running reply is stopped and the message is sent again.', [
				{ text: 'Cancel', style: 'cancel' },
				{ text: 'Retry', onPress: go },
			]);
		} else {
			go();
		}
	}, [client, chatId]);

	const context = useMemo<IChatContext>(() => ({
		chatId,
		...(folder ? { folder } : {}),
		onMessageMenu: row => setMenuRow(row),
		onRetry: retry,
		onStop: () => {
			haptic.medium();
			void client.stop(chatId);
		},
		...(redoTurnId && checkpoints?.canRedo ? { redoTurnId } : {}),
		onRedo: () => {
			haptic.medium();
			void client.redoCheckpoint(chatId).then(result => {
				if (result?.applied) {
					setRedoTurnId(undefined);
				}
			});
		},
	}), [chatId, folder, retry, redoTurnId, checkpoints?.canRedo, client]);

	const startEdit = (row: UserRowData) => {
		setEditing({ turnId: row.turnId!, ...(row.mode ? { mode: row.mode } : {}) });
		const known = COMPOSER_MODES.find(m => m.id.toLowerCase() === (row.mode ?? '').toLowerCase());
		if (known) {
			setMode(known.id);
		}
		fill(row.text, rowAttachments(row));
	};

	const cancelEdit = () => {
		setEditing(undefined);
		fill('', []);
	};

	const rewind = (row: UserRowData) => {
		const turnId = row.turnId!;
		const go = (revert: boolean) => {
			haptic.medium();
			void client.rewindTo(chatId, turnId, revert).then(message => {
				if (message) {
					fill(message.text, attachmentsOf(message));
				}
			});
		};
		Alert.alert('Rewind to before this message?', 'This message and everything after it leave the chat and the agent\'s context. The message comes back to the composer.', [
			{ text: 'Cancel', style: 'cancel' },
			...(hasCheckpoint(turnId) ? [{ text: 'Rewind and revert files', style: 'destructive' as const, onPress: () => go(true) }] : []),
			{ text: 'Rewind', onPress: () => go(false) },
		]);
	};

	const restore = async (row: UserRowData) => {
		const turnId = row.turnId!;
		const preview = await client.previewRestore(chatId, turnId);
		if (!preview) {
			return;
		}
		const changed = preview.files.filter(f => f.action !== 'none').length;
		if (!changed) {
			client.toast('info', 'The files already match this checkpoint.');
			return;
		}
		const conflicts = preview.conflicts.length;
		Alert.alert(
			'Discard changes up to this checkpoint?',
			`${changed} ${changed === 1 ? 'file goes' : 'files go'} back to how ${changed === 1 ? 'it was' : 'they were'} before this message.${conflicts ? ` ${conflicts} of them changed since the agent last wrote ${conflicts === 1 ? 'it' : 'them'}; those edits are overwritten.` : ''} You can redo this until the next message.`,
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Restore', style: 'destructive', onPress: () => {
						haptic.warning();
						void client.restoreCheckpoint(chatId, turnId, conflicts > 0).then(result => {
							if (result?.applied) {
								setRedoTurnId(turnId);
							}
						});
					},
				},
			],
		);
	};

	const messageActions = (row: UserRowData): ISheetAction[] => {
		// Alerts wait for the sheet to finish closing (iOS shows one modal at a time).
		const later = (fn: () => void) => () => setTimeout(fn, 380);
		const actions: ISheetAction[] = [
			{ label: 'Edit', detail: 'Change it and send again; later messages are removed', icon: 'pencil', onPress: () => startEdit(row) },
			{ label: 'Retry', detail: 'Send it again as it is', icon: 'refresh', onPress: later(() => retry(row.turnId!)) },
			{ label: 'Copy', icon: 'copy', onPress: () => copyWithHaptic(row.text) },
			{ label: 'Rewind to here', detail: 'Remove it and everything after; edit it in the composer', icon: 'history', onPress: later(() => rewind(row)) },
		];
		if (hasCheckpoint(row.turnId!)) {
			actions.push({ label: 'Restore checkpoint', detail: 'Put the files back as they were before this message', icon: 'undo', destructive: true, onPress: later(() => void restore(row)) });
		}
		return actions;
	};

	const send = (text: string, delivery: 'auto' | 'queue' | 'now', attachments: readonly IPromptAttachment[], extra?: IComposerSendExtra): boolean => {
		const options = { mode, ...(effectiveModel ? { modelRef: effectiveModel } : {}), ...(attachments.length ? { attachments } : {}), ...(extra ? { mentions: extra.mentions, displayText: extra.displayText } : {}) };
		if (!editing) {
			client.send({ threadId: chatId, text, delivery, ...options });
			return true;
		}
		const turnId = editing.turnId;
		const go = (revertFiles: boolean) => {
			haptic.medium();
			void client.editMessage(chatId, turnId, { text, ...options, revertFiles }).then(ok => {
				if (ok) {
					setEditing(undefined);
					fill('', []);
				}
			});
		};
		Alert.alert('Send the edited message?', 'The original message and everything after it are replaced.', [
			{ text: 'Cancel', style: 'cancel' },
			...(hasCheckpoint(turnId) ? [{ text: 'Send and revert files', style: 'destructive' as const, onPress: () => go(true) }] : []),
			{ text: 'Send', onPress: () => go(false) },
		]);
		return false;
	};

	useFocusEffect(useCallback(() => {
		client.markRead(chatId);
		touchRecentChat(chatId);
	}, [client, chatId]));
	const [switcher, setSwitcher] = useState(false);
	const tasks = useChatTasks(chatId);
	const tabCount = useRecentChats().length;
	useEffect(() => {
		// A chat's orchestrator tree (its subagents, queue) loads on demand, as a desktop window opening it asks.
		if (client.getStatus().live) {
			client.connection.call('orchestrator.ensureThreadLoaded', [chatId]).catch(() => undefined);
		}
	}, [client, chatId, live]);
	useEffect(() => {
		if (meta?.unread) {
			client.markRead(chatId);
		}
	}, [client, chatId, meta?.unread]);

	const tabsShown = tabCount > 1;
	const top = insets.top + HEADER_HEIGHT + (tabsShown ? CHAT_TABS_HEIGHT : 0);
	const subtitle = [project?.displayName ?? meta?.workspaceLabel, session?.worktreeBranch ?? meta?.worktreeBranch].filter(Boolean).join(' · ');
	const tone = status.status === 'idle' ? undefined : statusColor(status.status, p);
	// One of a comparison's runs: the header leads back to the comparison.
	const runGroup = useRunGroupOfChat(chatId);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<ChatContext.Provider value={context}>
				<KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
					<Transcript chatId={chatId} topInset={top} />
					<Animated.View layout={LinearTransition.duration(220)} style={{ paddingBottom: Math.max(insets.bottom, 8), paddingTop: 6, gap: 8 }}>
						{approvals.length || questions.length || thread?.limit || (thread?.queue.length ?? 0) > 0 || tasks.length ? (
							<View style={{ paddingHorizontal: 16, gap: 8 }}>
								<SubagentsTray chatId={chatId} />
								{approvals.map(request => <ApprovalCard key={request.id} request={request} onBuildPlan={() => setMode('Agent')} />)}
								{questions[0] ? <QuestionCard key={questions[0].id} request={questions[0]} /> : null}
								{thread?.limit ? <LimitBanner chatId={chatId} thread={thread} /> : null}
								{thread && !thread.active && thread.pause && thread.pause !== 'limit' && thread.queue.length ? <PausedBanner chatId={chatId} thread={thread} /> : null}
								{thread ? <QueueChip chatId={chatId} thread={thread} /> : null}
							</View>
						) : null}
						<Composer
							draftKey={chatId}
							chatId={chatId}
							folder={folder}
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
							onSend={send}
							onStop={() => void client.stop(chatId)}
							contextUsed={transcript?.contextUsed}
							contextWindow={transcript?.contextWindow}
							prefill={prefill}
							placeholder={editing ? 'Edit your message…' : undefined}
							banner={editing ? (
								<Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(140)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, paddingLeft: 12, paddingRight: 4, height: 36, borderRadius: 12, backgroundColor: `${p.info}1A`, borderWidth: StyleSheet.hairlineWidth, borderColor: `${p.info}44` }}>
									<Icon name="pencil" size={14} color={p.info} />
									<T variant="small" weight="600" color={p.info} style={{ flex: 1 }}>Editing message</T>
									<Tap haptics="selection" onPress={cancelEdit} hitSlop={6} style={{ height: 28, paddingHorizontal: 10, borderRadius: 8, justifyContent: 'center' }}>
										<T variant="small" weight="600" color={p.fgSecondary}>Cancel</T>
									</Tap>
								</Animated.View>
							) : undefined}
						/>
					</Animated.View>
				</KeyboardAvoidingView>
			</ChatContext.Provider>
			<View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>
				{Platform.OS === 'ios'
					? <BlurView intensity={80} tint={p.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} style={StyleSheet.absoluteFill} />
					: <View style={[StyleSheet.absoluteFill, { backgroundColor: p.canvas, opacity: Platform.OS === 'web' ? 1 : 0.97 }]} />}
				<View style={{ position: 'absolute', left: 0, right: 0, bottom: tabsShown ? CHAT_TABS_HEIGHT : 0, height: HEADER_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 2 }}>
					<IconButton icon="chevronLeft" label="Back" size={24} color={p.fg} onPress={() => router.back()} />
					<Tap haptics="selection" onPress={() => setSwitcher(true)} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} accessibilityLabel="Switch chat">
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
							<Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color: p.fg, flexShrink: 1 }}>{meta?.title || 'New chat'}</Text>
							<Icon name="chevronDown" size={12} color={p.iconTertiary} />
						</View>
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
					{runGroup ? <IconButton icon="layers" label={`Compare models: ${runGroup.runs.length} runs`} color={p.fg} onPress={() => openRunGroup(runGroup.id)} /> : null}
					{terminals.length ? (
						<View>
							<IconButton icon="terminal" label={`Terminals, ${terminals.length}`} color={p.fg} onPress={() => router.push({ pathname: '/terminals/[id]', params: { id: chatId } })} />
							{liveTerminals ? <View pointerEvents="none" style={{ position: 'absolute', top: 7, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: p.info, borderWidth: 1.5, borderColor: p.canvas }} /> : null}
						</View>
					) : null}
					<IconButton icon="fileDiff" label="Changes" color={p.fg} onPress={() => router.push({ pathname: '/changes/[id]', params: { id: chatId } })} />
					<IconButton icon="settings" label="Chat details" color={p.fg} onPress={() => router.push({ pathname: '/details/[id]', params: { id: chatId } })} />
				</View>
				{tabsShown ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}><ChatTabs chatId={chatId} /></View> : null}
			</View>
			<ChatSwitcher visible={switcher} onClose={() => setSwitcher(false)} chatId={chatId} />
			<ActionSheet visible={!!menuRow} onClose={() => setMenuRow(undefined)} title="Message" subtitle={menuRow ? firstWords(menuRow.text) : undefined} actions={menuRow ? messageActions(menuRow) : []} />
			{!meta && !messages.length && transcript?.status !== 'loading' && !client.getPending(chatId).length ? (
				<View style={{ position: 'absolute', top: top + 40, left: 24, right: 24, alignItems: 'center', gap: 6 }}>
					<Icon name="message" size={22} color={p.fgTertiary} />
					<T variant="small" color={p.fgTertiary} align="center">This chat isn't on your computer anymore.</T>
				</View>
			) : null}
		</View>
	);
}

/** A sent message's images, ready to send again. */
function rowAttachments(row: UserRowData): IPromptAttachment[] {
	return (row.images ?? []).map(image => ({ id: uuid(), name: image.name, mime: image.mime, ref: image.ref }));
}

function firstWords(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
