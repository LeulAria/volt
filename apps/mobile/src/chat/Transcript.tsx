/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { applyToolDensity, buildRows, type TranscriptRow } from '@volt/client-core';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, Platform, StyleSheet, View, type ViewProps, type ViewToken } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { usePending, useTranscript } from '../state/client';
import { useConversationPrefs } from '../state/prefs';
import { useTheme } from '../theme/theme';
import { EmptyState, haptic, Icon, Tap } from '../ui/core';
import { ChatContext, type IChatContext } from './context';
import { PinnedPrompt, RowView, rowGap, rowInset } from './Rows';

/** Height of the pinned prompt strip: the row under its bottom edge is the one being read. */
const PIN_STRIP = 96;

interface ICell {
	readonly row: TranscriptRow;
	readonly gap: number;
}

const Cell = memo(function Cell({ cell, chatId }: { readonly cell: ICell; readonly chatId: string }) {
	return (
		<View style={{ paddingTop: cell.gap, paddingHorizontal: rowInset(cell.row) }}>
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
	// "Worked for" folds: open ones, and turns watched while they ran (they start open, as on the desktop) unless folded.
	const [openWorked, setOpenWorked] = useState<ReadonlySet<string>>(() => new Set());
	const watched = useRef(new Set<string>());
	const [closedWorked, setClosedWorked] = useState<ReadonlySet<string>>(() => new Set());
	const parent = useContext(ChatContext);
	const onToggleWorked = useCallback((turnKey: string, open: boolean) => {
		haptic.selection();
		setOpenWorked(prev => {
			const next = new Set(prev);
			if (open) {
				next.add(turnKey);
			} else {
				next.delete(turnKey);
			}
			return next;
		});
		setClosedWorked(prev => {
			const next = new Set(prev);
			if (open) {
				next.delete(turnKey);
			} else {
				next.add(turnKey);
			}
			return next;
		});
	}, []);
	const ctx = useMemo<IChatContext | undefined>(() => parent ? { ...parent, onToggleWorked } : undefined, [parent, onToggleWorked]);
	const cells = useMemo(() => {
		const messages = transcript?.messages ?? [];
		const last = messages[messages.length - 1];
		if (last?.kind === 'agent' && last.activity?.streaming) {
			watched.current.add(`a:${last.id ?? `i${messages.length - 1}`}`);
		}
		const open = watched.current.size ? new Set([...watched.current, ...openWorked]) : openWorked;
		const rows = applyToolDensity(buildRows(messages, pending, { openWorked: open, closedWorked }), toolDensity);
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
	}, [transcript?.messages, pending, toolDensity, openWorked, closedWorked]);

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
	// The pinned prompt's row key, not its index: new rows shift every index of the inverted list.
	const [pinned, setPinned] = useState<string | undefined>();
	// Where each row sits, measured from the newest end (the list is inverted), the scroll offset and the viewport.
	const frames = useRef(new Map<string, { readonly y: number; readonly h: number }>());
	const scroll = useRef({ offset: 0, height: 0 });
	/**
	 * The turn being read is the one whose row sits just under the pinned strip; its prompt is
	 * pinned once that prompt has scrolled off the top. Geometry, not visibility: the strip hides
	 * the rows behind it, so "visible" would pick the turn above the one being read.
	 */
	const updatePinned = useCallback(() => {
		const { cells: current, owners: owned } = latest.current;
		const { offset, height } = scroll.current;
		if (!height) {
			return;
		}
		const screenTop = offset + height;
		const line = screenTop - PIN_STRIP;
		let at = -1;
		for (let i = 0; i < current.length; i++) {
			const frame = frames.current.get(current[i].row.key);
			if (frame && frame.y <= line && line < frame.y + frame.h) {
				at = i;
				break;
			}
		}
		const owner = at >= 0 ? owned[at] : undefined;
		const prompt = owner !== undefined ? current[owner] : undefined;
		const frame = prompt ? frames.current.get(prompt.row.key) : undefined;
		const next = prompt?.row.kind === 'user' && (!frame || frame.y + frame.h > screenTop + 1) ? prompt.row.key : undefined;
		setPinned(prev => prev === next ? prev : next);
	}, []);
	useEffect(updatePinned, [cells, updatePinned]);
	const CellRenderer = useMemo(() => function CellRenderer({ item, onLayout, ...props }: { readonly item: ICell; readonly onLayout?: (e: LayoutChangeEvent) => void } & ViewProps) {
		return <View {...props} onLayout={e => {
			onLayout?.(e);
			frames.current.set(item.row.key, { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height });
			updatePinned();
		}} />;
	}, [updatePinned]);
	const pinnedIndex = pinned !== undefined ? cells.findIndex(cell => cell.row.key === pinned) : -1;
	const pinnedRow = pinnedIndex >= 0 ? cells[pinnedIndex].row : undefined;

	const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
		const next = e.nativeEvent.contentOffset.y > 480;
		setAway(prev => prev === next ? prev : next);
		scroll.current = { offset: e.nativeEvent.contentOffset.y, height: e.nativeEvent.layoutMeasurement.height };
		updatePinned();
	}, [updatePinned]);

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
		<ChatContext.Provider value={ctx}>
		<View style={{ flex: 1 }}>
			<FlatList
				ref={list}
				inverted
				data={cells}
				keyExtractor={cell => cell.row.key}
				renderItem={renderItem}
				onScroll={onScroll}
				scrollEventThrottle={64}
				CellRendererComponent={CellRenderer}
				onLayout={e => {
					scroll.current = { ...scroll.current, height: e.nativeEvent.layout.height };
					updatePinned();
				}}
				onScrollToIndexFailed={info => list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })}
				keyboardDismissMode="interactive"
				keyboardShouldPersistTaps="handled"
				initialNumToRender={16}
				maxToRenderPerBatch={10}
				updateCellsBatchingPeriod={32}
				windowSize={11}
				removeClippedSubviews={Platform.OS === 'android'}
				// The list starts below the header (which is opaque): rows behind it would count as on screen
				// and pin the wrong prompt.
				style={{ marginTop: topInset }}
				contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 }}
				showsVerticalScrollIndicator={false}
			/>
			{pinnedRow?.kind === 'user' ? (
				<Animated.View key={pinnedRow.key} entering={FadeIn.duration(140)} exiting={FadeOut.duration(120)} style={{ position: 'absolute', left: 0, right: 0, top: topInset, paddingTop: 6, paddingBottom: 8, paddingHorizontal: 16, backgroundColor: p.canvas }}>
					{/* An opaque strip: the reply scrolling under it never shows above or through the prompt. */}
					<PinnedPrompt row={pinnedRow} onPress={() => {
						if (pinnedIndex >= 0) {
							list.current?.scrollToIndex({ index: pinnedIndex, animated: true, viewPosition: 1 });
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
		</ChatContext.Provider>
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
