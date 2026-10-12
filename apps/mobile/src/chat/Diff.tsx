/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { highlight, type IDiffHunk, type IDiffLine, type IVoltPalette, parseUnifiedDiff, wordChanges } from '@volt/client-core';
import { memo, type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FONT, useTheme } from '../theme/theme';
import { T, Tap } from '../ui/core';

/**
 * Diffs drawn like the desktop's review editor, in one column: a hunk header, old and new line
 * numbers, added and removed lines on tinted rows, and the words that changed between a removed
 * line and the added line that replaced it marked a shade stronger.
 */

type Range = readonly (readonly [number, number])[];

export type DiffItem =
	| { readonly type: 'hunk'; readonly key: string; readonly text: string }
	| { readonly type: 'line'; readonly key: string; readonly line: IDiffLine; readonly words?: Range }
	| { readonly type: 'gap'; readonly key: string; readonly count: number };

const LINE_HEIGHT = 18;
const CHAR_WIDTH = 7.25;

/** The rows a list draws for these hunks, with the changed words of each replaced line paired up. */
export function diffItems(hunks: readonly IDiffHunk[], keyPrefix = ''): DiffItem[] {
	const items: DiffItem[] = [];
	let lastOldEnd = 0;
	hunks.forEach((hunk, h) => {
		const skipped = hunk.oldStart - 1 - lastOldEnd;
		if (h > 0 && skipped > 0) {
			items.push({ type: 'gap', key: `${keyPrefix}g${h}`, count: skipped });
		}
		items.push({ type: 'hunk', key: `${keyPrefix}h${h}`, text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ''}` });
		const words = new Map<number, Range>();
		const lines = hunk.lines;
		for (let i = 0; i < lines.length;) {
			if (lines[i].kind !== 'del') {
				i++;
				continue;
			}
			let d = i;
			while (d < lines.length && lines[d].kind === 'del') {
				d++;
			}
			let a = d;
			while (a < lines.length && lines[a].kind === 'add') {
				a++;
			}
			const pairs = Math.min(d - i, a - d);
			for (let k = 0; k < pairs; k++) {
				const changes = wordChanges(lines[i + k].text, lines[d + k].text);
				if (changes.del.length) {
					words.set(i + k, changes.del);
				}
				if (changes.add.length) {
					words.set(d + k, changes.add);
				}
			}
			i = a;
		}
		lines.forEach((line, i) => items.push({ type: 'line', key: `${keyPrefix}${h}:${i}`, line, ...(words.has(i) ? { words: words.get(i)! } : {}) }));
		lastOldEnd = hunk.oldStart - 1 + hunk.oldLines;
	});
	return items;
}

function gutterWidth(items: readonly DiffItem[]): number {
	let max = 1;
	for (const item of items) {
		if (item.type === 'line') {
			max = Math.max(max, item.line.oldLine ?? 0, item.line.newLine ?? 0);
		}
	}
	return String(max).length * 7 + 10;
}

function contentWidth(items: readonly DiffItem[], gutter: number): number {
	let longest = 0;
	for (const item of items) {
		if (item.type === 'line') {
			longest = Math.max(longest, item.line.text.length);
		}
	}
	return Math.ceil(Math.min(longest, 600) * CHAR_WIDTH) + gutter * 2 + 40;
}

function lineColors(p: IVoltPalette, kind: IDiffLine['kind']): { readonly bg: string; readonly sign: string; readonly word: string } {
	return kind === 'add'
		? { bg: p.diffAdded, sign: p.diffAddedFg, word: `${p.diffAddedFg}45` }
		: kind === 'del'
			? { bg: p.diffRemoved, sign: p.diffRemovedFg, word: `${p.diffRemovedFg}45` }
			: { bg: 'transparent', sign: p.fgQuaternary, word: 'transparent' };
}

export const DiffRow = memo(function DiffRow({ item, gutter, wrap, fence }: { readonly item: DiffItem; readonly gutter: number; readonly wrap: boolean; readonly fence?: string }) {
	const { p } = useTheme();
	const tokens = useMemo(() => item.type === 'line' && fence && !item.words && item.line.text.length < 400 ? highlight(item.line.text, fence)[0] : undefined, [item, fence]);
	if (item.type === 'hunk') {
		return (
			<View style={[styles.hunk, { backgroundColor: `${p.info}14`, borderColor: p.strokeFaint }]}>
				<Text numberOfLines={1} style={[styles.mono, { color: p.info, paddingLeft: 10, opacity: 0.85 }]}>{item.text}</Text>
			</View>
		);
	}
	if (item.type === 'gap') {
		return (
			<View style={[styles.gap, { backgroundColor: p.fillFaint }]}>
				<Text style={[styles.mono, { color: p.fgQuaternary, paddingLeft: 10, fontSize: 11 }]}>{`⋯ ${item.count} unchanged ${item.count === 1 ? 'line' : 'lines'}`}</Text>
			</View>
		);
	}
	const { line, words } = item;
	const colors = lineColors(p, line.kind);
	const text = line.text || ' ';
	let body: ReactNode = text;
	if (words?.length) {
		const parts: ReactNode[] = [];
		let at = 0;
		words.forEach(([start, end], i) => {
			if (start > at) {
				parts.push(text.slice(at, start));
			}
			parts.push(<Text key={i} style={{ backgroundColor: colors.word, borderRadius: 2 }}>{text.slice(start, end)}</Text>);
			at = end;
		});
		if (at < text.length) {
			parts.push(text.slice(at));
		}
		body = parts;
	} else if (tokens?.length) {
		body = tokens.map((token, i) => token.k === 'plain' ? token.v : <Text key={i} style={{ color: p.syntax[token.k] }}>{token.v}</Text>);
	}
	return (
		<View style={[styles.line, { backgroundColor: colors.bg }]}>
			<Text style={[styles.mono, styles.num, { width: gutter, color: p.fgQuaternary }]}>{line.oldLine ?? ''}</Text>
			<Text style={[styles.mono, styles.num, { width: gutter, color: p.fgQuaternary }]}>{line.newLine ?? ''}</Text>
			<Text style={[styles.mono, styles.sign, { color: colors.sign }]}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</Text>
			<Text selectable numberOfLines={wrap ? undefined : 1} style={[styles.mono, styles.text, { color: line.kind === 'context' ? p.fgSecondary : p.fg }, wrap ? styles.wrap : null]}>{body}</Text>
		</View>
	);
});

/** A full file's diff, virtualized; `wrap` off scrolls sideways instead. */
export function DiffList({ items, wrap, fence, header }: { readonly items: readonly DiffItem[]; readonly wrap: boolean; readonly fence?: string; readonly header?: ReactElement }) {
	const { p } = useTheme();
	const gutter = useMemo(() => gutterWidth(items), [items]);
	const width = useMemo(() => contentWidth(items, gutter), [items, gutter]);
	const list = (
		<FlatList
			data={items as DiffItem[]}
			keyExtractor={item => item.key}
			renderItem={({ item }) => <DiffRow item={item} gutter={gutter} wrap={wrap} fence={fence} />}
			initialNumToRender={40}
			maxToRenderPerBatch={40}
			windowSize={15}
			ListHeaderComponent={header}
			contentContainerStyle={{ paddingBottom: 40 }}
			style={wrap ? { flex: 1, backgroundColor: p.codeBg } : { width: Math.max(width, 360), backgroundColor: p.codeBg }}
		/>
	);
	if (wrap) {
		return list;
	}
	return (
		<ScrollView horizontal bounces={false} style={{ flex: 1, backgroundColor: p.codeBg }} contentContainerStyle={{ minWidth: '100%' }}>
			{list}
		</ScrollView>
	);
}

const COLLAPSED_LINES = 60;

/** A unified diff inside the transcript (an edit block): the first lines, then "Show all". */
export const InlineDiff = memo(function InlineDiff({ diff, fence }: { readonly diff: string; readonly fence?: string }) {
	const { p } = useTheme();
	const [expanded, setExpanded] = useState(false);
	const items = useMemo(() => parseUnifiedDiff(diff).flatMap((file, f) => diffItems(file.hunks, `f${f}:`)), [diff]);
	const gutter = useMemo(() => gutterWidth(items), [items]);
	const width = useMemo(() => contentWidth(items, gutter), [items, gutter]);
	if (!items.length) {
		return <T variant="footnote" color={p.fgTertiary} style={{ padding: 12 }}>No line changes to show.</T>;
	}
	const long = items.length > COLLAPSED_LINES;
	const shown = long && !expanded ? items.slice(0, COLLAPSED_LINES - 15) : items.slice(0, 1500);
	return (
		<View style={{ backgroundColor: p.codeBg }}>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
				<View style={{ minWidth: width, paddingVertical: 4 }}>
					{shown.map(item => <DiffRow key={item.key} item={item} gutter={gutter} wrap={false} fence={fence} />)}
				</View>
			</ScrollView>
			{long ? (
				<Tap haptics="selection" onPress={() => setExpanded(e => !e)} style={{ height: 38, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<T variant="footnote" weight="600" color={p.fgSecondary}>{expanded ? 'Show less' : `Show all ${items.filter(i => i.type === 'line').length} lines`}</T>
				</Tap>
			) : null}
		</View>
	);
});

const styles = StyleSheet.create({
	mono: { fontFamily: FONT.mono, fontSize: 12, lineHeight: LINE_HEIGHT },
	line: { flexDirection: 'row', minHeight: LINE_HEIGHT },
	num: { textAlign: 'right', paddingRight: 6, fontSize: 10.5 },
	sign: { width: 14, textAlign: 'center' },
	text: { paddingRight: 12 },
	wrap: { flex: 1 },
	hunk: { height: 24, justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginVertical: 2 },
	gap: { height: 22, justifyContent: 'center' },
});
