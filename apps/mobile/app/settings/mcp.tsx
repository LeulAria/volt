/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IMcpServerStatus, selectProjects } from '@volt/client-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useCollections, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { T } from '../../src/ui/core';
import { Group, ListRow } from '../../src/ui/list';
import { ActionSheet } from '../../src/ui/sheets';

export default function McpScreen() {
	return useOptionalClient() ? <Mcp /> : null;
}

const STATE_LABEL: Record<IMcpServerStatus['state'], string> = { idle: 'Not started', connecting: 'Connecting', ready: 'Ready', error: 'Error' };

/** The MCP servers agents get: yours everywhere, and a project's own (pick the project). */
function Mcp() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [projectId, setProjectId] = useState<string | undefined>(projects[0]?.id);
	const project = projects.find(pr => pr.id === projectId);
	const [servers, setServers] = useState<readonly IMcpServerStatus[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [picking, setPicking] = useState(false);

	const load = useCallback(() => {
		setError(undefined);
		void client.listMcpServers(project?.path).then(setServers, err => {
			setServers([]);
			setError(errorMessage(err));
		});
	}, [client, project?.path]);
	useEffect(load, [load]);

	const color = (state: IMcpServerStatus['state']) => state === 'ready' ? p.success : state === 'error' ? p.danger : state === 'connecting' ? p.warning : p.fgTertiary;
	const group = (scope: IMcpServerStatus['scope'], title: string, footer: string) => {
		const list = (servers ?? []).filter(server => server.scope === scope);
		return (
			<Group title={title} footer={footer}>
				{list.length ? list.map(server => <ListRow key={`${scope}:${server.name}`} icon="plug" iconColor={color(server.state)} label={server.name} value={STATE_LABEL[server.state]} />) : <ListRow label="None" />}
			</Group>
		);
	};

	return (
		<ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={p.fgTertiary} />}>
			{projects.length ? (
				<Group title="Project">
					<ListRow icon="folder" label={project?.name ?? 'No project'} detail={project?.path} chevron onPress={() => setPicking(true)} />
				</Group>
			) : null}
			{!servers ? <ActivityIndicator style={{ marginTop: 40 }} color={p.fgTertiary} /> : (
				<>
					{error ? <View style={{ padding: 16 }}><T variant="small" color={p.danger}>{error}</T></View> : null}
					{group('user', 'Yours', 'From your Volt and agent settings on the computer; every chat gets them.')}
					{group('project', 'This project', 'From the project\'s .mcp.json and agent config.')}
				</>
			)}
			<ActionSheet visible={picking} onClose={() => setPicking(false)} title="Project" actions={projects.map(pr => ({ label: pr.name, icon: 'folder' as const, checked: pr.id === projectId, onPress: () => setProjectId(pr.id) }))} />
		</ScrollView>
	);
}
