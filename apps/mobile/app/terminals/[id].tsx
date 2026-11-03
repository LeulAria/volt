/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatTerminals, isTerminalLive, type ITerminalInfo, type ITerminalStreamState, relativeTime, shellTokenColor, terminalStatusLabel, tokenizeShell } from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useCollections, useOptionalClient } from '../../src/state/client';
import { FONT, useTheme } from '../../src/theme/theme';
import { EmptyState, haptic, Icon, ShimmerText, Spinner, Tap } from '../../src/ui/core';

/**
 * A chat's terminals, as the desktop's Terminals tab: the agent's dev servers, test runs and
 * background commands, each with its live output. Stop and Restart reach the computer; typing
 * stays with Volt there.
 */
export default function TerminalsScreen() {
	const { id, terminal } = useLocalSearchParams<{ id: string; terminal?: string }>();
	const client = useOptionalClient();
	return client && id ? <Terminals chatId={id} initial={terminal} /> : null;
}

function Terminals({ chatId, initial }: { readonly chatId: string; readonly initial?: string }) {
	const { p } = useTheme();
	const cols = useCollections(['terminals']);
	const list = useMemo(() => chatTerminals(cols['terminals'], chatId), [cols, chatId]);
	const [selected, setSelected] = useState(initial);
	const current = list.find(t => t.id === selected) ?? list[0];
	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: list.length > 1 ? `Terminals · ${list.length}` : 'Terminal' }} />
			{list.length > 1 ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 8 }}>
					{list.map(info => <TerminalTab key={info.id} info={info} active={info.id === current?.id} onPress={() => setSelected(info.id)} />)}
				</ScrollView>
			) : null}
			{current ? <TerminalView key={current.id} info={current} /> : <EmptyState icon="terminal" title="No terminals" body="Commands the agent starts in the background show here." />}
		</View>
	);
}

function StatusDot({ info, size = 7 }: { readonly info: ITerminalInfo; readonly size?: number }) {
	const { p } = useTheme();
	const live = isTerminalLive(info.status);
	if (live && info.status !== 'ready' && info.status !== 'attention') {
		return <Spinner size={size + 4} color={p.info} />;
	}
	const color = info.status === 'ready' ? p.success : info.status === 'attention' ? p.warning : info.status === 'failed' ? p.danger : p.fgQuaternary;
	return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

const TerminalTab = memo(function TerminalTab({ info, active, onPress }: { readonly info: ITerminalInfo; readonly active: boolean; readonly onPress: () => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 10, borderRadius: 8, maxWidth: 220, backgroundColor: active ? p.fillStrong : p.fillFaint, borderWidth: 1, borderColor: active ? p.stroke : 'transparent' }}>
			<StatusDot info={info} />
			<Text numberOfLines={1} style={{ fontSize: 13, color: active ? p.fg : p.fgSecondary, flexShrink: 1 }}>{info.label || info.command}</Text>
		</Tap>
	);
});

function useTerminalStream(id: string): ITerminalStreamState {
	const client = useClient();
	const [state, setState] = useState<ITerminalStreamState>({ text: '', loading: true });
	useEffect(() => {
		const stream = client.openTerminal(id);
		setState(stream.current);
		const off = stream.onChange(setState);
		return () => {
			off();
			stream.dispose();
		};
	}, [client, id]);
	return state;
}

/** Output lines drawn at once; older ones wait behind "Show earlier output". */
const TAIL_LINES = 1500;

function TerminalView({ info }: { readonly info: ITerminalInfo }) {
	const { p } = useTheme();
	const client = useClient();
	const insets = useSafeAreaInsets();
	const stream = useTerminalStream(info.id);
	const scroll = useRef<ScrollView>(null);
	const [follow, setFollow] = useState(true);
	const [all, setAll] = useState(false);
	const live = isTerminalLive(info.status) && stream.exitCode === undefined;
	const tokens = useMemo(() => tokenizeShell(info.command), [info.command]);
	const { shown, hidden } = useMemo(() => {
		const lines = stream.text.replace(/\n+$/, '').split('\n');
		return all || lines.length <= TAIL_LINES ? { shown: lines.join('\n'), hidden: 0 } : { shown: lines.slice(-TAIL_LINES).join('\n'), hidden: lines.length - TAIL_LINES };
	}, [stream.text, all]);
	useEffect(() => {
		if (follow) {
			requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
		}
	}, [shown, follow]);
	const act = (label: string, run: () => Promise<unknown>) => {
		haptic.medium();
		run().catch(err => client.toast('error', `${label} failed: ${err instanceof Error ? err.message : String(err)}`));
	};
	return (
		<View style={{ flex: 1 }}>
			<View style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 10, gap: 6 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
					<StatusDot info={info} size={8} />
					<ShimmerText active={live && info.status !== 'ready'} color={info.status === 'failed' ? p.danger : p.fgSecondary} style={{ fontSize: 13, lineHeight: 20 }}>{terminalStatusLabel(info)}</ShimmerText>
					<Text style={{ fontSize: 13, lineHeight: 20, color: p.fgQuaternary }}>{`· ${relativeTime(info.endedAt ?? info.startedAt)}`}</Text>
					<View style={{ flex: 1 }} />
					{live ? (
						<Tap haptics="medium" hitSlop={6} onPress={() => act('Stop', () => client.stopTerminal(info.id))} style={[styles.action, { backgroundColor: p.fill }]}>
							<View style={{ width: 8, height: 8, borderRadius: 1.5, backgroundColor: p.fg }} />
							<Text style={[styles.actionText, { color: p.fg }]}>Stop</Text>
						</Tap>
					) : info.kind === 'terminal' ? (
						<Tap haptics="medium" hitSlop={6} onPress={() => act('Restart', () => client.restartTerminal(info.id))} style={[styles.action, { backgroundColor: p.fill }]}>
							<Icon name="refresh" size={12} color={p.fg} />
							<Text style={[styles.actionText, { color: p.fg }]}>Restart</Text>
						</Tap>
					) : null}
					<Tap haptics="light" hitSlop={6} onPress={() => {
						void Clipboard.setStringAsync(stream.text);
						haptic.light();
						client.toast('info', 'Output copied');
					}} style={[styles.action, { backgroundColor: p.fill, paddingHorizontal: 8 }]} accessibilityLabel="Copy output">
						<Icon name="copy" size={13} color={p.fg} />
					</Tap>
				</View>
				<Text selectable numberOfLines={3} style={{ fontFamily: FONT.mono, fontSize: 12, lineHeight: 18, color: p.fgQuaternary }}>
					{'$ '}
					{tokens.map((token, i) => {
						const color = token.kind === 'op' ? p.fgTertiary : shellTokenColor(token.kind, p.scheme);
						return color ? <Text key={i} style={{ color }}>{token.value}</Text> : token.value;
					})}
				</Text>
				{info.urls.length ? (
					<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
						{info.urls.map(url => (
							<Tap key={url} haptics="light" onPress={() => void Linking.openURL(url).catch(() => client.toast('error', `Couldn't open ${url} on this phone; it runs on your computer.`))} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 9, borderRadius: 999, backgroundColor: `${p.link}1F` }}>
								<Icon name="globe" size={12} color={p.link} />
								<Text numberOfLines={1} style={{ fontSize: 12, color: p.link, fontWeight: '500' }}>{url.replace(/^https?:\/\//, '')}</Text>
							</Tap>
						))}
					</View>
				) : null}
				{info.error && !live ? <Text selectable style={{ fontSize: 13, lineHeight: 18, color: p.danger }}>{info.error}</Text> : null}
			</View>
			<View style={{ flex: 1, marginHorizontal: 14, marginBottom: Math.max(insets.bottom, 12), borderRadius: 8, borderWidth: 1, borderColor: p.strokeFaint, backgroundColor: p.card, overflow: 'hidden' }}>
				<ScrollView
					ref={scroll}
					onScrollBeginDrag={() => setFollow(false)}
					onMomentumScrollEnd={e => {
						const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
						setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
					}}
					contentContainerStyle={{ padding: 10 }}
				>
					{hidden ? (
						<Tap haptics="selection" onPress={() => setAll(true)} style={{ paddingBottom: 8 }}>
							<Text style={{ fontSize: 12, color: p.fgTertiary }}>Show {hidden} earlier lines</Text>
						</Tap>
					) : null}
					{stream.loading && !stream.text ? <Spinner size={14} /> : (
						<Text selectable style={{ fontFamily: FONT.mono, fontSize: 12, lineHeight: 18, color: p.fgSecondary }}>
							{stream.gone ? 'This terminal\'s output is no longer kept.' : shown || (live ? 'Waiting for output…' : 'No output.')}
						</Text>
					)}
					{stream.exitCode !== undefined ? <Text style={{ marginTop: 6, fontFamily: FONT.mono, fontSize: 12, color: stream.exitCode ? p.danger : p.fgQuaternary }}>{`[exited${stream.exitCode !== null ? ` with ${stream.exitCode}` : ''}]`}</Text> : null}
				</ScrollView>
				{!follow ? (
					<Tap haptics="light" onPress={() => {
						setFollow(true);
						scroll.current?.scrollToEnd({ animated: true });
					}} style={{ position: 'absolute', right: 10, bottom: 10, width: 32, height: 32, borderRadius: 16, backgroundColor: p.raised, borderWidth: 1, borderColor: p.stroke, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Follow output">
						<Icon name="arrowDown" size={15} color={p.fgSecondary} />
					</Tap>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	action: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 999 },
	actionText: { fontSize: 13, fontWeight: '500' },
});
