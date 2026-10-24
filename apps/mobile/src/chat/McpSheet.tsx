/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IMcpServerStatus } from '@volt/client-core';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useClient } from '../state/client';
import { useTheme } from '../theme/theme';
import { Icon, T, Tap } from '../ui/core';
import { Sheet } from '../ui/sheets';

const STATE: Record<IMcpServerStatus['state'], string> = { idle: 'Starts with the next run', connecting: 'Connecting…', ready: 'Connected', error: 'Failed to start' };

/**
 * The MCP servers this chat's agents get (the project's and your own), as the desktop's `@`
 * menu lists them. Tapping one mentions it in the message (`@mcp/name`).
 */
export function McpSheet({ visible, onClose, folder, onMention }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly folder?: string;
	readonly onMention: (server: IMcpServerStatus) => void;
}) {
	const { p } = useTheme();
	const client = useClient();
	const [servers, setServers] = useState<readonly IMcpServerStatus[] | undefined>();
	const [error, setError] = useState<string | undefined>();

	const load = useCallback(() => {
		setError(undefined);
		client.listMcpServers(folder).then(setServers, err => setError(errorMessage(err)));
	}, [client, folder]);

	useEffect(() => {
		if (visible) {
			load();
		}
	}, [visible, load]);

	const tone = (state: IMcpServerStatus['state']) => state === 'ready' ? p.success : state === 'error' ? p.danger : state === 'connecting' ? p.info : p.fgQuaternary;
	const groups = (['project', 'user'] as const).map(scope => ({ scope, items: (servers ?? []).filter(s => s.scope === scope) })).filter(g => g.items.length);

	return (
		<Sheet visible={visible} onClose={onClose} title="MCP servers" subtitle="Tools your agents can call. Tap one to mention it.">
			{servers === undefined && !error ? <View style={{ paddingVertical: 24 }}><ActivityIndicator color={p.fgTertiary} /></View> : null}
			{error ? <T variant="small" color={p.danger} style={{ padding: 12 }}>{error}</T> : null}
			{servers?.length === 0 ? <T variant="small" color={p.fgTertiary} style={{ padding: 12 }}>No MCP servers are set up. Add them in Volt on your computer (Settings › MCP), or in the project's .cursor/mcp.json.</T> : null}
			{groups.map(group => (
				<View key={group.scope}>
					<T variant="caption" weight="700" color={p.fgTertiary} style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6, letterSpacing: 0.6, textTransform: 'uppercase' }}>{group.scope === 'project' ? 'This project' : 'Yours'}</T>
					<View style={{ borderRadius: 14, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>
						{group.items.map((server, i) => (
							<Tap key={server.name} haptics="selection" onPress={() => {
								onMention(server);
								onClose();
							}} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
								<View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: p.fill, alignItems: 'center', justifyContent: 'center' }}>
									<Icon name="server" size={16} color={p.fgSecondary} />
								</View>
								<View style={{ flex: 1, minWidth: 0 }}>
									<T variant="callout" weight="500" numberOfLines={1}>{server.name}</T>
									<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
										<View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone(server.state) }} />
										<T variant="footnote" color={p.fgTertiary}>{STATE[server.state]}</T>
									</View>
								</View>
								<Icon name="plus" size={16} color={p.fgQuaternary} />
							</Tap>
						))}
					</View>
				</View>
			))}
			{servers?.length ? (
				<Tap haptics="selection" onPress={load} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44, marginTop: 6 }}>
					<Icon name="refresh" size={14} color={p.fgTertiary} />
					<T variant="small" color={p.fgTertiary}>Refresh</T>
				</Tap>
			) : null}
		</Sheet>
	);
}
