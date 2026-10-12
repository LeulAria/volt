/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildRows, type TranscriptRow } from '@volt/client-core';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, type NativeScrollEvent, type NativeSyntheticEvent, Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { usePending, useTranscript } from '../state/client';
import { useTheme } from '../theme/theme';
import { EmptyState, haptic, Icon, Tap } from '../ui/core';
import { RowView, rowGap } from './Rows';

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
	const cells = useMemo(() => {
		const rows = buildRows(transcript?.messages ?? [], pending);
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
	}, [transcript?.messages, pending]);

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
				keyboardDismissMode="interactive"
				keyboardShouldPersistTaps="handled"
				initialNumToRender={14}
				maxToRenderPerBatch={8}
				windowSize={13}
				removeClippedSubviews={Platform.OS === 'android'}
				contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: topInset + 12 }}
				showsVerticalScrollIndicator={false}
			/>
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
			<View style={{ alignSelf: 'flex-end', width: '62%', height: 44, borderRadius: 18, backgroundColor: p.fill }} />
			{[0.92, 0.78, 0.85, 0.4].map((w, i) => <View key={i} style={{ width: `${w * 100}%`, height: 12, borderRadius: 6, backgroundColor: p.fill }} />)}
		</View>
	);
}
