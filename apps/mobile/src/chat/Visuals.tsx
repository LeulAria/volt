/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IRenderedPage, RADIUS, renderThemeFor } from '@volt/client-core';
import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOptionalClient } from '../state/client';
import { FONT, useTheme } from '../theme/theme';
import { haptic, Icon, IconButton, Shimmer, T, Tap } from '../ui/core';
import { useChatContext } from './context';
import { RichFrame } from './RichFrame';

/**
 * What the desktop draws in its own window, drawn here from the server: agents' pages and charts
 * (html_render, render_chart), mermaid diagrams and display math. Each is one HTML document from
 * serverRender.ts, in this app's colors, shown in a frame that grows to fit it.
 */

type Load = (theme: ReturnType<typeof renderThemeFor>) => Promise<IRenderedPage> | undefined;

function useRendered(load: Load, deps: readonly unknown[]): { readonly page?: IRenderedPage; readonly error?: string } {
	const { p } = useTheme();
	const theme = useMemo(() => renderThemeFor(p), [p]);
	const [state, setState] = useState<{ page?: IRenderedPage; error?: string }>({});
	useEffect(() => {
		let live = true;
		const pending = load(theme);
		if (!pending) {
			return;
		}
		pending.then(page => live && setState({ page }), err => live && setState({ error: err instanceof Error ? err.message : String(err) }));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [theme, ...deps]);
	return state;
}

//#region Full screen

interface IShownFrame {
	readonly html: string;
	readonly title: string;
	readonly baseUrl?: string;
}

let shown: IShownFrame | undefined;
const listeners = new Set<() => void>();

function showFrame(frame: IShownFrame | undefined): void {
	shown = frame;
	listeners.forEach(listener => listener());
}

/** Mounted once at the root: a page, chart or diagram opened full screen. */
export function FrameViewerHost() {
	const current = useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => shown, () => undefined);
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const close = () => showFrame(undefined);
	return (
		<Modal visible={!!current} animationType="slide" presentationStyle="pageSheet" onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
			<View style={{ flex: 1, backgroundColor: p.canvas, paddingBottom: insets.bottom }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.stroke }}>
					<T variant="body" weight="600" numberOfLines={1} style={{ flex: 1 }}>{current?.title || 'Visual'}</T>
					<Tap haptics="light" onPress={close} accessibilityLabel="Close" style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}>
						<T variant="small" weight="600">Done</T>
					</Tap>
				</View>
				{current ? (
					<Animated.View entering={FadeIn.duration(160)} style={{ flex: 1, paddingHorizontal: 12, paddingTop: 8 }}>
						<RichFrame html={current.html} {...(current.baseUrl ? { baseUrl: current.baseUrl } : {})} initialHeight={400} fill />
					</Animated.View>
				) : null}
			</View>
		</Modal>
	);
}

//#endregion

function CardHeader({ icon, title, children }: { readonly icon: Parameters<typeof Icon>[0]['name']; readonly title: string; readonly children?: React.ReactNode }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 38, paddingLeft: 12, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
			<Icon name={icon} size={14} color={p.fgTertiary} />
			<T variant="footnote" weight="500" color={p.fgSecondary} numberOfLines={1} style={{ flex: 1 }}>{title}</T>
			{children}
		</View>
	);
}

function Skeleton({ height, label }: { readonly height: number; readonly label: string }) {
	const { p } = useTheme();
	return (
		<View style={{ height, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
			<ActivityIndicator size="small" color={p.fgTertiary} />
			<Shimmer><T variant="footnote" color={p.fgTertiary}>{label}</T></Shimmer>
		</View>
	);
}

/** Inline frames stop growing here; the rest is a tap away, full screen. */
const INLINE_MAX = 560;

/** An agent's html_render page or render_chart dashboard, drawn in the reply. */
export const VisualCard = memo(function VisualCard({ visualRef, kind, title, height, detail, pending }: { readonly visualRef: string; readonly kind: 'chart' | 'html' | 'canvas'; readonly title: string; readonly height?: number; readonly detail?: string; readonly pending?: boolean }) {
	const { p } = useTheme();
	const client = useOptionalClient();
	const ctx = useChatContext();
	const canRender = !!client && !!visualRef && !pending && kind !== 'canvas';
	const { page, error } = useRendered(theme => canRender ? client!.renderVisual(visualRef, kind === 'chart' ? 'chart' : 'html', { theme }) : undefined, [visualRef, kind, canRender]);
	const [measured, setMeasured] = useState<number | undefined>();
	const guess = Math.min(INLINE_MAX, Math.max(kind === 'chart' ? 260 : 160, height ?? (kind === 'chart' ? 300 : 360)));
	const cut = (measured ?? 0) > INLINE_MAX;
	const label = title || (kind === 'chart' ? 'Chart' : kind === 'canvas' ? 'Canvas' : 'Page');
	const open = useCallback(() => page && showFrame({ html: page.html, title: label, ...(client?.origin ? { baseUrl: client.origin } : {}) }), [page, label, client]);
	const onPrompt = useCallback((text: string, send: boolean) => {
		if (send && client && ctx && !ctx.readOnly) {
			haptic.light();
			void client.send({ threadId: ctx.chatId, text });
		}
	}, [client, ctx]);
	return (
		<View style={{ marginVertical: 8, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.canvas, overflow: 'hidden' }}>
			<CardHeader icon={kind === 'chart' ? 'layers' : kind === 'canvas' ? 'palette' : 'globe'} title={label}>
				{page ? <IconButton icon="expand" size={15} color={p.fgTertiary} onPress={open} label="Open full screen" /> : null}
			</CardHeader>
			{kind === 'canvas' ? (
				<View style={{ padding: 14, gap: 4 }}>
					{detail ? <T variant="small">{detail}</T> : null}
					<T variant="footnote" color={p.fgTertiary}>Design canvases open in Volt on your computer.</T>
				</View>
			) : error ? (
				<View style={{ padding: 14, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
					<Icon name="alertCircle" size={14} color={p.fgTertiary} />
					<T variant="footnote" color={p.fgTertiary} style={{ flex: 1 }}>{error}</T>
				</View>
			) : page ? (
				<View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
					<RichFrame html={page.html} {...(client?.origin ? { baseUrl: client.origin } : {})} initialHeight={guess} maxHeight={INLINE_MAX} onHeight={setMeasured} onPrompt={onPrompt} />
					{cut ? (
						<Tap haptics="selection" onPress={open} style={{ height: 38, marginTop: 4, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
							<T variant="footnote" weight="600" color={p.fgSecondary}>Show all</T>
						</Tap>
					) : null}
				</View>
			) : (
				<Skeleton height={guess} label={pending ? (kind === 'chart' ? 'Drawing chart…' : 'Building page…') : 'Loading…'} />
			)}
		</View>
	);
});

/** A mermaid diagram, drawn the way the desktop draws it; the source while it streams in or if it can't be drawn. */
export const MermaidBlock = memo(function MermaidBlock({ source, fallback }: { readonly source: string; readonly fallback: React.ReactNode }) {
	const { p } = useTheme();
	const client = useOptionalClient();
	const { page, error } = useRendered(theme => client?.renderMermaid(source, { theme }), [source, client]);
	const [copied, setCopied] = useState(false);
	if (error || !client) {
		return <>{fallback}</>;
	}
	return (
		<View style={{ marginVertical: 8, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.codeBg, overflow: 'hidden' }}>
			<CardHeader icon="list" title="Diagram">
				<Tap haptics="light" onPress={() => {
					void Clipboard.setStringAsync(source);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 8, borderRadius: 8 }} accessibilityLabel="Copy diagram source">
					<Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? p.success : p.fgTertiary} />
				</Tap>
				{page ? <IconButton icon="expand" size={15} color={p.fgTertiary} onPress={() => showFrame({ html: page.html, title: 'Diagram' })} label="Open full screen" /> : null}
			</CardHeader>
			{page ? (
				<View style={{ padding: 8 }}>
					<RichFrame html={page.html} initialHeight={180} maxHeight={INLINE_MAX} />
				</View>
			) : <Skeleton height={140} label="Drawing diagram…" />}
		</View>
	);
});

/** A ```volt-chart fence: the chart drawn, the JSON while it streams in or if it isn't a chart. */
export const ChartFenceBlock = memo(function ChartFenceBlock({ spec, fallback }: { readonly spec: string; readonly fallback: React.ReactNode }) {
	const { p } = useTheme();
	const client = useOptionalClient();
	const { page, error } = useRendered(theme => client?.renderChart(spec, { theme }), [spec, client]);
	if (error || !client) {
		return <>{fallback}</>;
	}
	return (
		<View style={{ marginVertical: 8, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.canvas, overflow: 'hidden' }}>
			<CardHeader icon="layers" title="Chart">
				{page ? <IconButton icon="expand" size={15} color={p.fgTertiary} onPress={() => showFrame({ html: page.html, title: 'Chart' })} label="Open full screen" /> : null}
			</CardHeader>
			{page ? (
				<View style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
					<RichFrame html={page.html} initialHeight={280} maxHeight={INLINE_MAX} />
				</View>
			) : <Skeleton height={260} label="Drawing chart…" />}
		</View>
	);
});

/** Display math typeset with KaTeX; the formula's source until it is. */
export const MathBlock = memo(function MathBlock({ tex }: { readonly tex: string }) {
	const { p } = useTheme();
	const client = useOptionalClient();
	const { page, error } = useRendered(theme => client?.renderMath(tex, true, { theme }), [tex, client]);
	if (page && !error) {
		return (
			<View style={{ marginVertical: 6 }}>
				<RichFrame html={page.html} {...(client?.origin ? { baseUrl: client.origin } : {})} initialHeight={52} maxHeight={400} />
			</View>
		);
	}
	return (
		<View style={{ marginVertical: 6, padding: 12, borderRadius: RADIUS.md, backgroundColor: p.fillFaint }}>
			<Text selectable style={{ fontFamily: FONT.mono, fontSize: 13, color: error ? p.fg : p.fgTertiary }}>{tex}</Text>
		</View>
	);
});
