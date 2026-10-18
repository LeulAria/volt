/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, firstLine, historyOf, type IAgentChange } from '@volt/client-core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChangeRow, changeTotals } from '../../src/chat/ChangeRow';
import { useClient, useCollections, useOptionalClient, useTranscript } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { EmptyState, Segmented, T } from '../../src/ui/core';

export default function ChangesScreen() {
	const { id, turn } = useLocalSearchParams<{ id: string; turn?: string }>();
	const client = useOptionalClient();
	return client && id ? <Changes chatId={id} turn={turn} /> : null;
}

type Scope = 'session' | 'lastTurn' | 'turn';

interface ITurnSection {
	readonly key: string;
	readonly title: string;
	readonly add: number;
	readonly del: number;
	readonly data: readonly IAgentChange[];
}

/**
 * What the chat's agent changed in the project, from its checkpoints: the whole chat grouped by
 * the prompt that made each change (the desktop's turns view), the last turn, or one turn.
 */
function Changes({ chatId, turn }: { readonly chatId: string; readonly turn?: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const meta = historyOf(useCollections(['history']))[chatId];
	const transcript = useTranscript(chatId);
	const [scope, setScope] = useState<Scope>(turn ? 'turn' : 'session');
	const [changes, setChanges] = useState<readonly IAgentChange[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);

	const load = useCallback(async () => {
		try {
			setChanges(await client.getChanges(chatId, scope === 'turn' && turn ? { turnId: turn } : scope === 'turn' ? 'lastTurn' : scope));
			setError(undefined);
		} catch (err) {
			setError(errorMessage(err));
		}
	}, [client, chatId, scope, turn]);

	useEffect(() => {
		setChanges(undefined);
		void load();
	}, [load]);

	// Each turn's prompt, to title its group ("3. Add discounts to the cart").
	const prompts = useMemo(() => {
		const out = new Map<string, string>();
		let n = 0;
		for (const message of transcript?.messages ?? []) {
			if (message.kind === 'user' && message.id) {
				n++;
				out.set(message.id, `${n}. ${firstLine(message.text, 70) || 'Prompt'}`);
			}
		}
		return out;
	}, [transcript?.messages]);

	const sections = useMemo<ITurnSection[]>(() => {
		if (!changes?.length) {
			return [];
		}
		if (scope !== 'session') {
			const totals = changeTotals(changes);
			return [{ key: 'all', title: '', ...totals, data: changes }];
		}
		const groups = new Map<string, IAgentChange[]>();
		for (const change of changes) {
			groups.set(change.turnId, [...(groups.get(change.turnId) ?? []), change]);
		}
		return [...groups.entries()].map(([turnId, list]) => ({ key: turnId, title: prompts.get(turnId) ?? 'Earlier turn', ...changeTotals(list), data: list }));
	}, [changes, scope, prompts]);

	const totals = useMemo(() => changeTotals(changes ?? []), [changes]);
	const files = useMemo(() => new Set((changes ?? []).map(c => c.path)).size, [changes]);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: scope === 'turn' ? 'Turn changes' : 'Changes', headerBackTitle: meta?.title }} />
			<SectionList
				sections={sections as ITurnSection[]}
				keyExtractor={change => `${change.turnId}:${change.path}`}
				contentInsetAdjustmentBehavior="automatic"
				stickySectionHeadersEnabled={false}
				contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					void load().finally(() => setRefreshing(false));
				}} />}
				ListHeaderComponent={
					<View style={{ gap: 12, paddingTop: 12, paddingBottom: 4 }}>
						<Segmented<Scope> value={scope} onChange={setScope} options={[
							{ id: 'session', label: 'By turn' },
							{ id: 'lastTurn', label: 'Last turn' },
							...(turn ? [{ id: 'turn' as const, label: 'This turn' }] : []),
						]} />
						{changes?.length ? (
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
								<T variant="small" weight="600" color={p.fgSecondary}>{files} {files === 1 ? 'file' : 'files'} changed</T>
								<T variant="small" mono color={p.diffAddedFg}>+{totals.add}</T>
								<T variant="small" mono color={p.diffRemovedFg}>{'−'}{totals.del}</T>
							</View>
						) : null}
					</View>
				}
				renderSectionHeader={({ section }) => section.title ? (
					<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 }}>
						<T variant="footnote" weight="700" color={p.fgSecondary} numberOfLines={1} style={{ flex: 1 }}>{section.title}</T>
						<T variant="footnote" mono color={p.diffAddedFg}>+{section.add}</T>
						<T variant="footnote" mono color={p.diffRemovedFg}>{'−'}{section.del}</T>
					</View>
				) : <View style={{ height: 8 }} />}
				ListEmptyComponent={
					changes === undefined && !error
						? <View style={{ paddingTop: 60 }}><ActivityIndicator color={p.fgTertiary} /></View>
						: error
							? <EmptyState icon="alertCircle" title="Couldn't load the changes" body={error} />
							: <EmptyState icon="fileDiff" title="No changes" body={scope === 'session' ? 'The agent hasn\'t changed any files in this chat.' : 'That turn didn\'t change any files.'} />
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 46 }} />}
				renderItem={({ item, index, section }) => <ChangeRow change={item} first={index === 0} last={index === section.data.length - 1} />}
			/>
		</View>
	);
}
