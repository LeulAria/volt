/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { selectProjects } from '@volt/client-core';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { RunGroupRow, useRunGroups } from '../src/home/RunGroups';
import { useCollections, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { EmptyState } from '../src/ui/core';
import { Chips, RowList } from '../src/ui/rows';

export default function RunGroupsScreen() {
	return useOptionalClient() ? <RunGroups /> : null;
}

/** Every model comparison: one prompt run on several models, each in its own worktree. */
function RunGroups() {
	const { p } = useTheme();
	const groups = useRunGroups();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [filter, setFilter] = useState<'active' | 'archived'>('active');
	const shown = groups.filter(group => (filter === 'archived') === !!group.archived);
	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Chips value={filter} onChange={setFilter} options={[{ id: 'active', label: 'Active' }, { id: 'archived', label: 'Archived', count: groups.filter(group => group.archived).length }]} />
			<ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
				{shown.length ? (
					<RowList inset={50}>
						{shown.map(group => <RunGroupRow key={group.id} group={group} projectName={projects.find(pr => pr.id === group.projectId)?.name} />)}
					</RowList>
				) : (
					<EmptyState icon="layers" title={filter === 'archived' ? 'No archived comparisons' : 'No comparisons yet'} body="Start one from a new chat: open the model picker and turn on Compare models." />
				)}
			</ScrollView>
		</View>
	);
}
