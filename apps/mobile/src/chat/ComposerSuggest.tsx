/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, type IMcpServerStatus, type VoltClient } from '@volt/client-core';
import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { FileIcon } from '../files/FileIcon';
import { fuzzyFilter } from '../files/fuzzy';
import { useTheme } from '../theme/theme';
import { Icon, T, Tap } from '../ui/core';

/** The word being typed at the cursor when it starts a mention (`@que`) or a command (`/rev`, first word only). */
export interface ITrigger {
	readonly kind: '@' | '/';
	readonly query: string;
	/** Where the token starts in the text (at its `@` or `/`). */
	readonly start: number;
	readonly end: number;
}

export function triggerAt(text: string, cursor: number): ITrigger | undefined {
	const before = text.slice(0, cursor);
	const match = /(^|\s)([@/])([^\s@/]*(?:\/[^\s@]*)*)$/.exec(before);
	if (!match) {
		return undefined;
	}
	const kind = match[2] as '@' | '/';
	const start = before.length - match[3].length - 1;
	// A command is the message's first word, as on the desktop.
	if (kind === '/' && before.slice(0, start).trim()) {
		return undefined;
	}
	return { kind, query: match[3], start, end: cursor };
}

/** A `/` entry: one of the agent's own commands, or a Volt command/skill when the server lists them. */
export interface ISlashItem {
	readonly name: string;
	readonly description?: string;
	readonly type?: string;
}

const SLASH_TYPE: Record<string, string> = { 'builtin-command': 'command', skill: 'skill', command: 'command', subagent: 'subagent', rule: 'rule' };

/**
 * The `/` list for a chat: what the desktop's slash menu shows for its project (built-in
 * commands, skills, commands, subagents and rules on disk), then the commands the chat's agent
 * advertised itself.
 */
export async function loadSlashItems(client: VoltClient, chatId: string | undefined, folder: string | undefined): Promise<ISlashItem[]> {
	const items: ISlashItem[] = [];
	if (folder) {
		try {
			for (const item of await client.slashCommands(folder)) {
				items.push({ name: item.name, ...(item.summary || item.description ? { description: item.summary || item.description } : {}), type: SLASH_TYPE[item.type] ?? item.type });
			}
		} catch {
			// an older server: only the agent's own commands
		}
	}
	const known = new Set(items.map(item => item.name));
	for (const name of chatId ? client.sessionCommands(chatId) : []) {
		const clean = name.replace(/^\//, '');
		if (!known.has(clean)) {
			items.push({ name: clean, type: 'agent' });
		}
	}
	return items;
}

const fileIndexCache = new Map<string, Promise<readonly string[]>>();

/** Every file under a folder, relative (cached for the session: the list is only for picking). */
export function projectFiles(client: VoltClient, folder: string): Promise<readonly string[]> {
	let load = fileIndexCache.get(folder);
	if (!load) {
		load = client.fileIndex(folder).then(result => result.files, err => {
			fileIndexCache.delete(folder);
			throw err;
		});
		fileIndexCache.set(folder, load);
	}
	return load;
}

const ROW = 44;

/** The list over the composer while a `@` or `/` token is typed. */
export const ComposerSuggest = memo(function ComposerSuggest({ trigger, client, chatId, folder, onPickFile, onPickSlash, onPickMcp }: {
	readonly trigger: ITrigger;
	readonly client: VoltClient;
	readonly chatId?: string;
	readonly folder?: string;
	readonly onPickFile: (rel: string) => void;
	readonly onPickSlash: (item: ISlashItem) => void;
	readonly onPickMcp: (server: IMcpServerStatus) => void;
}) {
	const { p } = useTheme();
	const [files, setFiles] = useState<readonly string[] | undefined>();
	const [slash, setSlash] = useState<readonly ISlashItem[] | undefined>();
	const [mcp, setMcp] = useState<readonly IMcpServerStatus[]>([]);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let live = true;
		if (trigger.kind === '@') {
			if (folder) {
				projectFiles(client, folder).then(list => live && setFiles(list), err => live && setError(err instanceof Error ? err.message : String(err)));
			} else {
				setFiles([]);
			}
			void client.listMcpServers(folder).then(list => live && setMcp(list), () => undefined);
		} else {
			void loadSlashItems(client, chatId, folder).then(list => live && setSlash(list));
		}
		return () => {
			live = false;
		};
	}, [trigger.kind, client, chatId, folder]);

	const fileMatches = useMemo(() => files ? (trigger.query ? fuzzyFilter(trigger.query, files, 40) : files.slice(0, 40)) : undefined, [files, trigger.query]);
	const mcpMatches = useMemo(() => trigger.kind === '@' ? mcp.filter(server => !trigger.query || `mcp/${server.name}`.toLowerCase().includes(trigger.query.toLowerCase())).slice(0, 6) : [], [mcp, trigger]);
	const slashMatches = useMemo(() => {
		const q = trigger.query.toLowerCase();
		return (slash ?? []).filter(item => !q || item.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, 40);
	}, [slash, trigger.query]);

	const loading = trigger.kind === '@' ? fileMatches === undefined && !error : slash === undefined;
	const empty = trigger.kind === '@' ? !loading && !fileMatches?.length && !mcpMatches.length : !loading && !slashMatches.length;

	return (
		<Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)} style={{ marginBottom: 6, maxHeight: ROW * 5 + 34, borderRadius: 16, backgroundColor: p.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 30 }}>
				<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}>{trigger.kind === '@' ? 'Files' : 'Commands'}</T>
				{trigger.query ? <T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} style={{ flex: 1 }}>{trigger.kind}{trigger.query}</T> : null}
			</View>
			<ScrollView keyboardShouldPersistTaps="always" bounces={false}>
				{loading ? <View style={{ height: ROW, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={p.fgTertiary} /></View> : null}
				{error ? <T variant="small" color={p.danger} style={{ paddingHorizontal: 14, paddingVertical: 10 }}>{error}</T> : null}
				{empty ? <T variant="small" color={p.fgTertiary} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>{trigger.kind === '@' ? (folder ? 'No files match.' : 'This chat has no project folder.') : 'No commands match. The agent lists its commands once it has run.'}</T> : null}
				{trigger.kind === '@' ? (
					<>
						{fileMatches?.map(rel => (
							<Tap key={rel} haptics="selection" onPress={() => onPickFile(rel)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: ROW, paddingHorizontal: 14 }}>
								<FileIcon path={rel} size={18} />
								<T variant="callout" numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%' }}>{basename(rel)}</T>
								<T variant="footnote" color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>{dirname(rel)}</T>
							</Tap>
						))}
						{mcpMatches.map(server => (
							<Tap key={`mcp:${server.name}`} haptics="selection" onPress={() => onPickMcp(server)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: ROW, paddingHorizontal: 14 }}>
								<Icon name="server" size={17} color={p.fgSecondary} />
								<T variant="callout" numberOfLines={1} style={{ flex: 1 }}>{server.name}</T>
								<T variant="footnote" color={p.fgQuaternary}>MCP</T>
							</Tap>
						))}
					</>
				) : slashMatches.map(item => (
					<Tap key={item.name} haptics="selection" onPress={() => onPickSlash(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: ROW, paddingHorizontal: 14, paddingVertical: 6 }}>
						<View style={{ width: 22, alignItems: 'center' }}><T variant="callout" mono weight="700" color={p.fgTertiary}>/</T></View>
						<View style={{ flex: 1, minWidth: 0 }}>
							<T variant="callout" weight="500" numberOfLines={1}>{item.name}</T>
							{item.description ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{item.description}</T> : null}
						</View>
						{item.type ? <T variant="caption" color={p.fgQuaternary}>{item.type}</T> : null}
					</Tap>
				))}
			</ScrollView>
		</Animated.View>
	);
});
