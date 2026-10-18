/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IPullRequestSummary } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GitActions } from '../src/git/GitActions';
import { PullRequestRow } from '../src/git/PullRequestBits';
import { useClient, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { EmptyState } from '../src/ui/core';
import { Chips } from '../src/ui/rows';

type StateFilter = 'open' | 'closed' | 'all';

export default function PullsScreen() {
	const { root, name } = useLocalSearchParams<{ root: string; name?: string }>();
	return useOptionalClient() && root ? <Pulls root={root} name={name} /> : null;
}

/** A project's pull requests, GitHub app style, with its branch control on top. */
function Pulls({ root, name }: { readonly root: string; readonly name?: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [state, setState] = useState<StateFilter>('open');
	const [list, setList] = useState<readonly IPullRequestSummary[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(false);

	const load = useCallback(() => {
		setLoading(true);
		void client.listPullRequests(root, { state, limit: 50 }).then(next => {
			setList(next);
			setError(undefined);
		}, err => {
			setList([]);
			setError(errorMessage(err));
		}).finally(() => setLoading(false));
	}, [client, root, state]);
	useEffect(load, [load]);

	const open = useCallback((pr: IPullRequestSummary) => router.push({ pathname: '/pull', params: { root, number: String(pr.number) } }), [root]);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: name ? `${name} · Pull requests` : 'Pull requests' }} />
			<FlatList
				data={list as IPullRequestSummary[] | undefined}
				keyExtractor={pr => pr.key}
				refreshControl={<RefreshControl refreshing={loading && !!list} onRefresh={load} tintColor={p.fgTertiary} />}
				contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
				ListHeaderComponent={
					<View style={{ gap: 8, paddingTop: 8 }}>
						<View style={{ paddingHorizontal: 16 }}><GitActions root={root} onChanged={load} /></View>
						<Chips value={state} onChange={setState} options={[{ id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }, { id: 'all', label: 'All' }]} />
					</View>
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 50 }} />}
				renderItem={({ item }) => <PullRequestRow pr={item} onPress={open} />}
				ListEmptyComponent={!list
					? <ActivityIndicator style={{ marginTop: 40 }} color={p.fgTertiary} />
					: <EmptyState icon={error ? 'alertCircle' : 'pullRequest'} title={error ? 'Couldn\'t load pull requests' : `No ${state === 'all' ? '' : `${state} `}pull requests`} body={error} />}
			/>
		</View>
	);
}
