/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, historyOf, type IAgentChange, uriPath } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FileIcon } from '../../src/files/FileIcon';
import { useClient, useCollections, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { EmptyState, Icon, Segmented, T, Tap } from '../../src/ui/core';

export default function ChangesScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const client = useOptionalClient();
	return client && id ? <Changes chatId={id} /> : null;
}

type Scope = 'session' | 'lastTurn';

const KIND: Record<IAgentChange['kind'], { readonly letter: string; readonly label: string }> = {
	added: { letter: 'A', label: 'Added' },
	modified: { letter: 'M', label: 'Modified' },
	deleted: { letter: 'D', label: 'Deleted' },
	renamed: { letter: 'R', label: 'Renamed' },
};

/** What the chat's agent changed in the project, from its checkpoints: every file, with a diff each. */
function Changes({ chatId }: { readonly chatId: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const meta = historyOf(useCollections(['history']))[chatId];
	const [scope, setScope] = useState<Scope>('session');
	const [changes, setChanges] = useState<readonly IAgentChange[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);

	const load = useCallback(async () => {
		try {
			setChanges(await client.getChanges(chatId, scope));
			setError(undefined);
		} catch (err) {
			setError(errorMessage(err));
		}
	}, [client, chatId, scope]);

	useEffect(() => {
		setChanges(undefined);
		void load();
	}, [load]);

	const totals = useMemo(() => (changes ?? []).reduce((sum, c) => ({ add: sum.add + c.additions, del: sum.del + c.deletions }), { add: 0, del: 0 }), [changes]);
	const kindColor = (kind: IAgentChange['kind']) => kind === 'added' ? p.success : kind === 'deleted' ? p.danger : kind === 'renamed' ? p.violet : p.warning;

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: 'Changes', headerBackTitle: meta?.title }} />
			<FlatList
				data={changes as IAgentChange[] | undefined}
				keyExtractor={change => `${change.turnId}:${change.path}`}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
				refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={() => {
					setRefreshing(true);
					void load().finally(() => setRefreshing(false));
				}} />}
				ListHeaderComponent={
					<View style={{ gap: 12, paddingTop: 12, paddingBottom: 10 }}>
						<Segmented<Scope> value={scope} onChange={setScope} options={[{ id: 'session', label: 'Whole chat' }, { id: 'lastTurn', label: 'Last turn' }]} />
						{changes?.length ? (
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
								<T variant="small" weight="600" color={p.fgSecondary}>{changes.length} {changes.length === 1 ? 'file' : 'files'} changed</T>
								<T variant="small" mono color={p.diffAddedFg}>+{totals.add}</T>
								<T variant="small" mono color={p.diffRemovedFg}>{'−'}{totals.del}</T>
							</View>
						) : null}
					</View>
				}
				ListEmptyComponent={
					changes === undefined && !error
						? <View style={{ paddingTop: 60 }}><ActivityIndicator color={p.fgTertiary} /></View>
						: error
							? <EmptyState icon="alertCircle" title="Couldn't load the changes" body={error} />
							: <EmptyState icon="fileDiff" title="No changes" body={scope === 'session' ? 'The agent hasn\'t changed any files in this chat.' : 'The last turn didn\'t change any files.'} />
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 46 }} />}
				renderItem={({ item, index }) => {
					const file = uriPath(item.uri) ?? item.path;
					const dir = dirname(item.path);
					const first = index === 0;
					const last = index === (changes?.length ?? 0) - 1;
					return (
						<Tap
							haptics="selection"
							disabled={item.binary}
							onPress={() => router.push({ pathname: '/diff', params: { title: item.path, file, repoRoot: item.repoRoot, ...(item.oldBlob ? { oldBlob: item.oldBlob } : {}), ...(item.newBlob ? { newBlob: item.newBlob } : {}), kind: item.kind } })}
							style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11, backgroundColor: p.surface, borderTopLeftRadius: first ? 14 : 0, borderTopRightRadius: first ? 14 : 0, borderBottomLeftRadius: last ? 14 : 0, borderBottomRightRadius: last ? 14 : 0 }}
						>
							<FileIcon path={item.path} />
							<View style={{ flex: 1, minWidth: 0 }}>
								<T variant="body" weight="500" numberOfLines={1}>{basename(item.path)}</T>
								<T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head">{item.kind === 'renamed' && item.oldPath ? `${item.oldPath} → ${dir || '.'}` : dir || '.'}</T>
							</View>
							{item.binary ? <T variant="footnote" color={p.fgTertiary}>binary</T> : (
								<View style={{ alignItems: 'flex-end' }}>
									{item.additions ? <T variant="footnote" mono color={p.diffAddedFg}>+{item.additions}</T> : null}
									{item.deletions ? <T variant="footnote" mono color={p.diffRemovedFg}>{'−'}{item.deletions}</T> : null}
								</View>
							)}
							<View style={{ width: 20, height: 20, borderRadius: 5, backgroundColor: `${kindColor(item.kind)}22`, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={KIND[item.kind].label}>
								<T variant="caption" weight="800" color={kindColor(item.kind)}>{KIND[item.kind].letter}</T>
							</View>
							<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
						</Tap>
					);
				}}
			/>
		</View>
	);
}
