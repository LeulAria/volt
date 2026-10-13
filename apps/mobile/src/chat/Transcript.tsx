/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyToolDensity, buildRows, type TranscriptRow } from '@volt/client-core';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, type NativeScrollEvent, type NativeSyntheticEvent, Platform, StyleSheet, View, type ViewToken } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { usePending, useTranscript } from '../state/client';
import { useConversationPrefs } from '../state/prefs';
import { useTheme } from '../theme/theme';
import { EmptyState, haptic, Icon, Tap } from '../ui/core';
import { PinnedPrompt, RowView, rowGap } from './Rows';

interface ICell {
	readonly row: TranscriptRow;
	readonly gap: number;
}

const Cell = memo(function Cell({ cell, chatId }: { readonly cell: ICell; readonly chatId: string }) {
	return (
		<View style={{ paddingTop: cell.gap }}>
			<RowView row={cell.row} chatId={chatId} />
		</View>
	);
});

/**
 * The chat, newest at the bottom. An inverted list keeps the live end anchored as replies stream
 * in, without scroll bookkeeping; each row re-renders only when its own content changes.
 */
export function Transcript({ chatId, topInset }: { readonly chatId: string; readonly topInset: number }) {
	const { p } = useTheme();
	const transcript = useTranscript(chatId);
	const pending = usePending(chatId);
	const list = useRef<FlatList<ICell>>(null);
	const [away, setAway] = useState(false);
	// A cell keeps its object while its row and spacing hold, so only the rows a patch touched re-render.
	const cellCache = useRef(new WeakMap<TranscriptRow, ICell>());
	const { toolDensity } = useConversationPrefs();
	const cells = useMemo(() => {
		const rows = applyToolDensity(buildRows(transcript?.messages ?? [], pending), toolDensity);
		const out: ICell[] = new Array(rows.length);
		for (let i = 0; i < rows.length; i++) {
			const gap = rowGap(rows[i], rows[i - 1]);
			let cell = cellCache.current.get(rows[i]);
			if (!cell || cell.gap !== gap) {
				cell = { row: rows[i], gap };
				cellCache.current.set(rows[i], cell);
			}
			out[rows.length - 1 - i] = cell;
		}
		return out;
	}, [transcript?.messages, pending, toolDensity]);

	// For each cell, the prompt that opened its turn (the newest user row at or above it).
	const owners = useMemo(() => {
		const out: (number | undefined)[] = new Array(cells.length);
		let owner: number | undefined;
		for (let i = cells.length - 1; i >= 0; i--) {
			if (cells[i].row.kind === 'user') {
				owner = i;
			}
			out[i] = owner;
		}
		return out;
	}, [cells]);
	const latest = useRef({ cells, owners });
	latest.current = { cells, owners };
	const [pinned, setPinned] = useState<number | undefined>();
	// The turn at the top of the screen keeps its prompt in view once the prompt scrolls away.
	const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<ICell>[] }) => {
		const { cells: current, owners: owned } = latest.current;
		const seen = new Set<number>();
		let top = -1;
		for (const item of viewableItems) {
			if (item.index !== null && item.index !== undefined) {
				seen.add(item.index);
				top = Math.max(top, item.index);
			}
		}
		const owner = top >= 0 ? owned[top] : undefined;
		const next = owner !== undefined && !seen.has(owner) && current[owner]?.row.kind === 'user' ? owner : undefined;
		setPinned(prev => prev === next ? prev : next);
	}).current;
	const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 40 }).current;
	const pinnedRow = pinned !== undefined ? cells[pinned]?.row : undefined;

	const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
		const next = e.nativeEvent.contentOffset.y > 480;
		setAway(prev => prev === next ? prev : next);
	}, []);

	const renderItem = useCallback(({ item }: { item: ICell }) => <Cell cell={item} chatId={chatId} />, [chatId]);

	if (!cells.length) {
		return (
			<View style={{ flex: 1, justifyContent: 'center', paddingTop: topInset }}>
				{transcript?.status === 'error'
					? <EmptyState icon="alertCircle" title="Couldn't open this chat" body={transcript.error} />
					: transcript?.status === 'loading' || !transcript
						? <Skeleton />
						: <EmptyState icon="message" title="Nothing here yet" body="Send a message to get started." />}
			</View>
		);
	}

	return (
		<View style={{ flex: 1 }}>
			<FlatList
				ref={list}
				inverted
				data={cells}
				keyExtractor={cell => cell.row.key}
				renderItem={renderItem}
				onScroll={onScroll}
				scrollEventThrottle={64}
				onViewableItemsChanged={onViewableItemsChanged}
				viewabilityConfig={viewabilityConfig}
				onScrollToIndexFailed={info => list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })}
				keyboardDismissMode="interactive"
				keyboardShouldPersistTaps="handled"
				initialNumToRender={14}
				maxToRenderPerBatch={8}
				windowSize={13}
				removeClippedSubviews={Platform.OS === 'android'}
				contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: topInset + 12 }}
				showsVerticalScrollIndicator={false}
			/>
			{pinnedRow?.kind === 'user' ? (
				<Animated.View key={pinnedRow.key} entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)} style={{ position: 'absolute', left: 16, right: 16, top: topInset + 6 }}>
					<PinnedPrompt row={pinnedRow} onPress={() => {
						if (pinned !== undefined) {
							list.current?.scrollToIndex({ index: pinned, animated: true, viewPosition: 1 });
						}
					}} />
				</Animated.View>
			) : null}
			{away ? (
				<Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={{ position: 'absolute', right: 16, bottom: 10 }}>
					<Tap haptics="light" accessibilityLabel="Jump to latest" onPress={() => {
						haptic.light();
						list.current?.scrollToOffset({ offset: 0, animated: true });
					}} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: p.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }}>
						<Icon name="arrowDown" size={18} color={p.fgSecondary} />
					</Tap>
				</Animated.View>
			) : null}
		</View>
	);
}

function Skeleton() {
	const { p } = useTheme();
	return (
		<View style={{ paddingHorizontal: 20, gap: 14 }}>
			<View style={{ height: 40, borderRadius: 8, backgroundColor: p.fill }} />
			{[0.92, 0.78, 0.85, 0.4].map((w, i) => <View key={i} style={{ width: `${w * 100}%`, height: 12, borderRadius: 6, backgroundColor: p.fill }} />)}
		</View>
	);
}
