/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltPalette } from '@volt/client-core';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { FONT } from '../theme/theme';
import { diffsPage, diffsPayload } from './diffsPage';

export type DiffsEvent =
	| { readonly type: 'ready'; readonly ms: number }
	/** The diff's counts, before its lines draw; no hunks means both sides are the same. */
	| { readonly type: 'diff'; readonly additions: number; readonly deletions: number; readonly hunks: number; readonly ms: number }
	/** The first lines are on screen (`ms` since the text arrived). */
	| { readonly type: 'rendered'; readonly ms: number }
	| { readonly type: 'highlighted'; readonly ms: number }
	| { readonly type: 'error'; readonly message: string };

/** A diff of two texts, or one file (with `line` marked and scrolled to). `name` picks the language. */
export type DiffsSource =
	| { readonly name: string; readonly before: string; readonly after: string }
	| { readonly name: string; readonly text: string; readonly line?: number };

export interface IDiffsView {
	setWrap(wrap: boolean): void;
}

/**
 * A diff or a file drawn by @pierre/diffs in a WebView (diffsPage.ts): one column, line numbers
 * that stay put while the code scrolls sideways, changed words marked, unchanged stretches folded
 * (or all shown with `full`), Volt's colours and Geist Mono, virtualized so long files open at
 * once. Mount it before the text has loaded: the page starts while `source` is on its way, and
 * a skeleton covers it until the first lines draw. An `error` event means the caller shows its
 * own viewer.
 */
export const DiffsView = forwardRef<IDiffsView, {
	readonly p: IVoltPalette;
	readonly mode: 'diff' | 'file';
	readonly full?: boolean;
	readonly wrap: boolean;
	readonly source?: DiffsSource;
	readonly onEvent?: (event: DiffsEvent) => void;
}>(function DiffsView({ p, mode, full, wrap, source, onEvent }, ref) {
	const web = useRef<WebView>(null);
	const loaded = useRef(false);
	const [shown, setShown] = useState(false);
	// The page is built once per look: the text and wrapping go through `window.volt`, not a reload.
	const html = useMemo(() => diffsPage(p, { mode, full, wrap }), [p, mode, full]);
	const run = (js: string) => web.current?.injectJavaScript(`window.volt && ${js}; true;`);
	const send = (value: DiffsSource | undefined) => value && run(`window.volt.load(${JSON.stringify(value)})`);
	useImperativeHandle(ref, () => ({
		setWrap: on => run(`window.volt.wrap(${on})`),
	}), []);
	useEffect(() => {
		loaded.current = false;
	}, [html]);
	useEffect(() => {
		if (loaded.current) {
			send(source);
		}
	}, [source]);
	const onMessage = (e: WebViewMessageEvent) => {
		let event: DiffsEvent;
		try {
			event = JSON.parse(e.nativeEvent.data) as DiffsEvent;
		} catch {
			return;
		}
		if (event.type === 'rendered' || (event.type === 'diff' && !event.hunks)) {
			setShown(true);
		}
		onEvent?.(event);
	};
	return (
		<View style={{ flex: 1, backgroundColor: p.codeBg }}>
			<WebView
				ref={web}
				originWhitelist={['*']}
				source={{ html, baseUrl: 'https://volt.local/' }}
				onMessage={onMessage}
				onLoadEnd={() => {
					loaded.current = true;
					web.current?.injectJavaScript(diffsPayload());
					send(source);
				}}
				onContentProcessDidTerminate={() => web.current?.reload()}
				onShouldStartLoadWithRequest={request => request.url.startsWith('https://volt.local') || request.url === 'about:blank'}
				javaScriptEnabled
				bounces={false}
				overScrollMode="never"
				scrollEnabled={false}
				setSupportMultipleWindows={false}
				style={{ flex: 1, backgroundColor: p.codeBg }}
				containerStyle={{ flex: 1, backgroundColor: p.codeBg }}
			/>
			{!shown ? <Skeleton p={p} /> : null}
		</View>
	);
});

/** A made-up file's shape, as [indent, length] in characters per line (0 length: a blank line). */
const SHAPE: readonly (readonly [number, number])[] = [
	[0, 8], [1, 21], [1, 14], [1, 26], [0, 18], [0, 0], [0, 34], [0, 0], [0, 23], [1, 31], [1, 0], [1, 19], [2, 27],
	[2, 12], [1, 3], [0, 1], [0, 0], [0, 29], [1, 22], [2, 36], [2, 17], [3, 24], [2, 4], [1, 30], [1, 11], [0, 1],
	[0, 0], [0, 25], [1, 33], [1, 15], [2, 28], [1, 2], [0, 1], [0, 0], [0, 20], [1, 26], [1, 18], [0, 1],
];

/** The page's code metrics (diffsPage.ts: 12.5px Geist Mono on 20px lines, 4px above the first). */
const CODE = { line: 20, top: 4, gutter: 44, numberRight: 7, codeLeft: 54, char: 7.5, tab: 2 } as const;

/**
 * The code view's own layout, empty, until its first lines draw: line numbers in the gutter where
 * the real ones go, bars where the code will be, line for line. Still: no shimmer.
 */
function Skeleton({ p }: { readonly p: IVoltPalette }) {
	const [size, setSize] = useState({ width: 0, height: 0 });
	const rows = Math.max(1, Math.ceil((size.height - CODE.top) / CODE.line));
	return (
		<Animated.View exiting={FadeOut.duration(160)} pointerEvents="none" onLayout={e => setSize(e.nativeEvent.layout)}
			style={[StyleSheet.absoluteFill, { backgroundColor: p.codeBg, overflow: 'hidden', paddingTop: CODE.top }]}>
			{size.height ? Array.from({ length: rows }, (_, i) => {
				const [indent, length] = SHAPE[i % SHAPE.length]!;
				return (
					<View key={i} style={styles.row}>
						<Text style={[styles.number, { color: p.fgQuaternary, fontFamily: FONT.mono }]}>{i + 1}</Text>
						{length ? <View style={[styles.code, { marginLeft: CODE.codeLeft - CODE.gutter + indent * CODE.tab * CODE.char, width: length * CODE.char, backgroundColor: p.fill }]} /> : null}
					</View>
				);
			}) : null}
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	row: { height: CODE.line, flexDirection: 'row', alignItems: 'center' },
	number: { width: CODE.gutter - CODE.numberRight, textAlign: 'right', fontSize: 12.5, lineHeight: CODE.line, opacity: 0.55 },
	code: { height: 9, borderRadius: 4.5, marginRight: 0, opacity: 0.9 },
});
