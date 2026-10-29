/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IDiffLine, parseUnifiedDiff } from '@volt/client-core';
import { memo, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useConversationPrefs } from '../state/prefs';
import { FONT, useTheme } from '../theme/theme';
import { T, Tap } from '../ui/core';

/** A diff line, or the hairline between two hunks. */
type Line = IDiffLine | { readonly kind: 'gap' };

const LINE = 20;
/** Lines drawn before "Show all" (a phone scrolls the transcript, not the card). */
const OPEN_LIMIT = 160;

function linesOf(diff: string): Line[] {
	const out: Line[] = [];
	for (const file of parseUnifiedDiff(diff)) {
		for (const hunk of file.hunks) {
			if (out.length) {
				out.push({ kind: 'gap' });
			}
			out.push(...hunk.lines);
		}
	}
	return out;
}

/**
 * The desktop's edit diff (agentTranscript.css `.volt-tr-diff`): 12/20 mono, a 52px gutter with
 * the line number and +/-, a 4px strip, tinted rows, 1px between hunks. `peek` draws the closed
 * card's first four lines fading into the card; otherwise long diffs stop at "Show all".
 */
export const TrDiff = memo(function TrDiff({ diff, peek, framed, streaming }: { readonly diff: string; readonly peek?: boolean; readonly framed?: boolean; readonly streaming?: boolean }) {
	const { p } = useTheme();
	const { themedDiffs, codeWrap } = useConversationPrefs();
	const lines = useMemo(() => linesOf(diff), [diff]);
	const [all, setAll] = useState(false);
	if (!lines.length) {
		return <T variant="small" color={p.fgQuaternary} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>{streaming ? 'Writing…' : 'No changes'}</T>;
	}
	const shown = peek ? lines.slice(0, 4) : all ? lines : lines.slice(0, OPEN_LIMIT);
	const body = (
		<View style={{ minWidth: '100%' }}>
			{shown.map((line, i) => line.kind === 'gap'
				? <View key={i} style={{ height: 1, backgroundColor: p.stroke }} />
				: <DiffLine key={i} line={line} themed={themedDiffs} wrap={codeWrap} />)}
		</View>
	);
	return (
		<View style={[{ backgroundColor: p.canvas, overflow: 'hidden' }, framed ? { borderWidth: 1, borderColor: p.stroke, borderRadius: 6 } : null, peek ? { height: Math.min(shown.length, 4) * LINE } : null]}>
			{codeWrap ? body : <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} scrollEnabled={!peek}>{body}</ScrollView>}
			{peek ? <Fade color={p.canvas} /> : null}
			{!peek && !all && lines.length > OPEN_LIMIT ? (
				<Tap haptics="selection" onPress={() => setAll(true)} style={{ height: 32, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderColor: p.strokeFaint }}>
					<T variant="footnote" weight="500" color={p.fgTertiary}>Show {lines.length - OPEN_LIMIT} more lines</T>
				</Tap>
			) : null}
		</View>
	);
});

const DiffLine = memo(function DiffLine({ line, themed, wrap }: { readonly line: IDiffLine; readonly themed: boolean; readonly wrap: boolean }) {
	const { p } = useTheme();
	const insert = line.kind === 'add';
	const del = line.kind === 'del';
	const fg = insert ? p.diffAddedFg : del ? p.diffRemovedFg : p.fgQuaternary;
	return (
		<View style={{ flexDirection: 'row', minHeight: LINE, backgroundColor: themed ? (insert ? p.diffAdded : del ? p.diffRemoved : 'transparent') : 'transparent' }}>
			<View style={{ width: 4, backgroundColor: insert || del ? fg : 'transparent', opacity: 0.6 }} />
			<View style={{ width: 52, flexDirection: 'row', paddingRight: 4 }}>
				<Text style={[styles.num, { color: fg, fontFamily: FONT.mono }]}>{line.newLine ?? line.oldLine ?? ''}</Text>
				<Text style={[styles.ind, { color: fg, fontFamily: FONT.mono }]}>{insert ? '+' : del ? '-' : ''}</Text>
			</View>
			<Text selectable numberOfLines={wrap ? undefined : 1} style={[styles.text, { color: p.fg, fontFamily: FONT.mono }]}>{line.text || ' '}</Text>
		</View>
	);
});

/** The closed card's fade: the peek's lower half melts into the card (mask-image: #000 45% → transparent). */
function Fade({ color }: { readonly color: string }) {
	return (
		<Svg style={StyleSheet.absoluteFill} pointerEvents="none">
			<Defs>
				<LinearGradient id="trFade" x1="0" y1="0" x2="0" y2="1">
					<Stop offset="0.45" stopColor={color} stopOpacity={0} />
					<Stop offset="1" stopColor={color} stopOpacity={1} />
				</LinearGradient>
			</Defs>
			<Rect x="0" y="0" width="100%" height="100%" fill="url(#trFade)" />
		</Svg>
	);
}

const styles = StyleSheet.create({
	num: { flex: 1, paddingHorizontal: 4, textAlign: 'right', fontSize: 11, lineHeight: LINE },
	ind: { width: 14, textAlign: 'center', fontSize: 12, lineHeight: LINE, fontWeight: '600' },
	text: { flexShrink: 1, paddingLeft: 8, paddingRight: 12, fontSize: 12, lineHeight: LINE },
});
