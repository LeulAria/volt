import { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { EmbedCommand, EmbedEvent } from '@/core/voltCore';
import { Composer } from '@/components/Composer';
import { ConnectionDot } from '@/components/ConnectionDot';
import { BackIcon } from '@/components/Icons';
import { Text } from '@/components/Text';
import { useConnectionState, useServerVersion, useVolt } from '@/lib/connection';
import { embedUrl } from '@/lib/pairing';
import { colors, radius } from '@/lib/theme';

type ThreadState = Extract<EmbedEvent, { type: 'state' }>;

/**
 * A chat: the native header and composer around the web app's thread view, so the transcript
 * (markdown, math, diagrams, tool rows, approvals, questions) is the agent window's own renderer.
 */
export default function ChatScreen() {
	const params = useLocalSearchParams<{ id: string }>();
	const { pairing, services } = useVolt();
	const insets = useSafeAreaInsets();
	useServerVersion(services);
	const connection = useConnectionState(services);
	const web = useRef<WebView>(null);
	const [ready, setReady] = useState(false);
	const startsNew = params.id === 'new';
	const [sessionId, setSessionId] = useState(() => startsNew ? `agent-${Crypto.randomUUID()}` : params.id);
	const [thread, setThread] = useState<ThreadState | undefined>();
	// The page loads once; later chats are opened in it by command.
	const source = useMemo(() => pairing ? { uri: embedUrl(pairing, startsNew ? undefined : sessionId) } : undefined, [pairing]); // eslint-disable-line react-hooks/exhaustive-deps

	const command = useCallback((message: EmbedCommand) => {
		web.current?.injectJavaScript(`window.voltEmbed && window.voltEmbed.receive(${JSON.stringify(message)}); true;`);
	}, []);

	const onMessage = useCallback((event: WebViewMessageEvent) => {
		let message: EmbedEvent;
		try {
			message = JSON.parse(event.nativeEvent.data) as EmbedEvent;
		} catch {
			return;
		}
		switch (message.type) {
			case 'ready':
				setReady(true);
				break;
			case 'state':
				setThread(message);
				break;
			case 'link':
				void Linking.openURL(message.url);
				break;
		}
	}, []);

	if (!pairing || !services || !source) {
		return null;
	}
	const meta = services.history.get(sessionId);
	const hasMessages = (thread?.chat === sessionId && thread.messages > 0) || (meta?.turnCount ?? 0) > 0;
	const isNewChat = !hasMessages;
	const projectId = services.projects.bindingFor(sessionId)?.projectId;
	const projectName = projectId ? services.projects.getProject(projectId)?.displayName : undefined;
	const title = meta?.title || (isNewChat ? 'New Chat' : 'Chat');

	const onSent = (id: string) => {
		if (id !== sessionId || thread?.chat !== id) {
			setSessionId(id);
			command({ type: 'open', chat: id });
		}
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top }]}>
			<View style={styles.header}>
				<Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Back" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
					<BackIcon />
				</Pressable>
				<View style={styles.titleBlock}>
					<Text size={14} weight="semibold" numberOfLines={1}>{title}</Text>
					{projectName ? <Text size={11} color={colors.textTertiary} numberOfLines={1}>{projectName}</Text> : null}
				</View>
				<View style={styles.headerEnd}><ConnectionDot state={connection} /></View>
			</View>
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<View style={styles.flex}>
					<WebView
						ref={web}
						source={source}
						onMessage={onMessage}
						originWhitelist={['*']}
						style={[styles.web, !ready && styles.hidden]}
						containerStyle={styles.webContainer}
						scrollEnabled={false}
						bounces={false}
						overScrollMode="never"
						hideKeyboardAccessoryView
						keyboardDisplayRequiresUserAction={false}
						contentInsetAdjustmentBehavior="never"
						automaticallyAdjustContentInsets={false}
						setSupportMultipleWindows={false}
						allowsBackForwardNavigationGestures={false}
						onContentProcessDidTerminate={() => web.current?.reload()}
					/>
					{!ready ? (
						<Animated.View entering={FadeIn.delay(300)} style={styles.loading} pointerEvents="none">
							<Text size={13} color={colors.textQuaternary}>{isNewChat ? '' : 'Loading chat…'}</Text>
						</Animated.View>
					) : null}
					{isNewChat && ready ? (
						<View style={styles.landing} pointerEvents="none">
							<Text size={20} weight="semibold" color={colors.textSecondary}>What should Volt build?</Text>
							<Text size={13} color={colors.textTertiary} style={styles.center}>Runs on your Mac. Follow it here, on the web, or in Volt.</Text>
						</View>
					) : null}
				</View>
				<View style={{ paddingBottom: Math.max(insets.bottom, 10) }}>
					<Composer
						sessionId={sessionId}
						isNewChat={isNewChat}
						streaming={!!thread?.streaming && thread.chat === sessionId}
						status={thread?.chat === sessionId ? thread.status : ''}
						scrolledUp={!!thread?.scrolledUp}
						onScrollToEnd={() => command({ type: 'scrollToEnd' })}
						onSent={onSent}
					/>
				</View>
			</KeyboardAvoidingView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.background },
	flex: { flex: 1 },
	header: { flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	back: { padding: 6, borderRadius: radius.sm },
	pressed: { backgroundColor: colors.pressed },
	titleBlock: { flex: 1, alignItems: 'center' },
	headerEnd: { width: 34, alignItems: 'center' },
	web: { flex: 1, backgroundColor: colors.background },
	webContainer: { backgroundColor: colors.background },
	hidden: { opacity: 0 },
	loading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
	landing: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 36 },
	center: { textAlign: 'center' },
});
