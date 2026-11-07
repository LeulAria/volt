/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { type IOpenPull, useOpenPulls } from '../../src/git/openPulls';
import { PullRequestRow } from '../../src/git/PullRequestBits';
import { useTheme } from '../../src/theme/theme';
import { useReadableInset } from '../../src/ui/adaptive';
import { EmptyState, IconButton } from '../../src/ui/core';
import { LargeHeader, LargeTitle, useLargeTitleScroll } from '../../src/ui/header';
import { SectionHeader } from '../../src/ui/list';

interface IRepoSection {
	readonly key: string;
	readonly title: string;
	readonly data: readonly IOpenPull[];
}

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList<IOpenPull, IRepoSection>);

/** Every open pull request across your projects, grouped by repository, newest first. */
export default function PullRequestsTab() {
	const { p } = useTheme();
	const { pulls, loading, loadedAt, refresh } = useOpenPulls();
	const { scroll, onScroll } = useLargeTitleScroll();
	const inset = useReadableInset(true);
	// Coming back to the tab picks up new ones (the loader skips it while they're fresh).
	useFocusEffect(useCallback(() => {
		if (loadedAt && Date.now() - loadedAt > 60_000) {
			refresh();
		}
	}, [loadedAt, refresh]));
	const sections = useMemo<IRepoSection[]>(() => {
		const byRepo = new Map<string, IOpenPull[]>();
		for (const pull of pulls) {
			const repo = `${pull.pr.repo.owner}/${pull.pr.repo.name}`;
			byRepo.set(repo, [...(byRepo.get(repo) ?? []), pull]);
		}
		return [...byRepo.entries()].map(([repo, data]) => ({ key: repo, title: `${repo}  ·  ${data.length}`, data }));
	}, [pulls]);
	const open = useCallback((pull: IOpenPull) => router.push({ pathname: '/pull', params: { root: pull.root, number: String(pull.pr.number) } }), []);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader title="Pull requests" scroll={scroll} right={<IconButton icon="refresh" label="Refresh" color={p.fg} disabled={loading} onPress={refresh} />} />
			<AnimatedSectionList
				onScroll={onScroll}
				scrollEventThrottle={16}
				sections={sections}
				keyExtractor={pull => pull.pr.key}
				stickySectionHeadersEnabled={false}
				contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: inset }}
				refreshControl={<RefreshControl refreshing={loading && !!loadedAt} onRefresh={refresh} tintColor={p.fgTertiary} />}
				ListHeaderComponent={<LargeTitle title="Pull requests" scroll={scroll} />}
				renderSectionHeader={({ section }) => <View style={{ paddingTop: 10, backgroundColor: p.canvas }}><SectionHeader title={section.title} /></View>}
				renderItem={({ item }) => <PullRequestRow pr={item.pr} onPress={() => open(item)} />}
				ListEmptyComponent={!loadedAt
					? <ActivityIndicator style={{ marginTop: 40 }} color={p.fgTertiary} />
					: <EmptyState icon="pullRequest" title="No open pull requests" body="Pull requests opened from your projects show up here." />}
			/>
		</View>
	);
}
