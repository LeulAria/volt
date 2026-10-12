/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, type IFileEntry, type IFileRoot, type IGitChange, shortPath, type VoltClient } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openFile } from '../../src/chat/context';
import { FileIcon } from '../../src/files/FileIcon';
import { fuzzyFilter } from '../../src/files/fuzzy';
import { useClient, useOptionalClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { EmptyState, Icon, T, Tap } from '../../src/ui/core';

export default function FilesScreen() {
	const params = useLocalSearchParams<{ root?: string; dir?: string; name?: string }>();
	const client = useOptionalClient();
	if (!client) {
		return null;
	}
	return params.root && params.dir ? <Folder root={params.root} dir={params.dir} name={params.name} /> : <Roots />;
}

/** File lists for quick open, kept a little while per folder. */
const indexes = new Map<string, { readonly at: number; readonly files: Promise<readonly string[]> }>();

function fileIndex(client: VoltClient, root: string): Promise<readonly string[]> {
	const hit = indexes.get(root);
	if (hit && Date.now() - hit.at < 30_000) {
		return hit.files;
	}
	const files = client.fileIndex(root).then(r => r.files);
	indexes.set(root, { at: Date.now(), files });
	files.catch(() => indexes.delete(root));
	return files;
}

function SearchField({ value, onChange, placeholder }: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: p.fill, marginHorizontal: 16, marginTop: 8, marginBottom: 6 }}>
			<Icon name="search" size={16} color={p.fgTertiary} />
			<TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={p.fgQuaternary} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" selectionColor={p.accent} style={{ flex: 1, color: p.fg, fontSize: 16 }} />
		</View>
	);
}

function Row({ icon, title, detail, right, onPress, onLongPress }: { readonly icon: ReactNode; readonly title: string; readonly detail?: string; readonly right?: ReactNode; readonly onPress: () => void; readonly onLongPress?: () => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} onLongPress={onLongPress} style={styles.row}>
			<View style={styles.icon}>{icon}</View>
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="body" numberOfLines={1}>{title}</T>
				{detail ? <T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head">{detail}</T> : null}
			</View>
			{right}
		</Tap>
	);
}

/** Projects and chat worktrees Volt has open on the computer. */
function Roots() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [roots, setRoots] = useState<readonly IFileRoot[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const load = useCallback(() => client.listRoots().then(r => {
		setRoots(r.filter(root => !root.scratch));
		setError(undefined);
	}, err => setError(errorMessage(err))), [client]);
	useEffect(() => {
		void load();
	}, [load]);
	const open = (root: IFileRoot) => router.push({ pathname: '/files', params: { root: root.path, dir: root.path, name: root.name } });
	const sections = useMemo(() => {
		const projects = (roots ?? []).filter(r => r.kind === 'project');
		const worktrees = (roots ?? []).filter(r => r.kind === 'worktree');
		return [...projects.map(r => ({ root: r, header: projects[0] === r ? 'Projects' : undefined })), ...worktrees.map(r => ({ root: r, header: worktrees[0] === r ? 'Chat worktrees' : undefined }))];
	}, [roots]);
	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: 'Files' }} />
			<FlatList
				data={sections}
				keyExtractor={item => item.root.id}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
				refreshControl={<RefreshControl refreshing={false} tintColor={p.fgTertiary} onRefresh={() => void load()} />}
				ListEmptyComponent={roots === undefined && !error ? <View style={{ paddingTop: 60 }}><ActivityIndicator color={p.fgTertiary} /></View>
					: <EmptyState icon={error ? 'alertCircle' : 'folder'} title={error ? 'Couldn\'t list the projects' : 'No projects yet'} body={error ?? 'Projects you open in Volt, or add when starting a chat, show up here.'} />}
				renderItem={({ item }) => (
					<View>
						{item.header ? <T variant="caption" weight="700" color={p.fgTertiary} style={styles.header}>{item.header.toUpperCase()}</T> : null}
						<Row
							icon={<Icon name={item.root.kind === 'worktree' ? 'branch' : 'folder'} size={20} color={p.fgSecondary} />}
							title={item.root.name}
							detail={shortPath(item.root.path, 52)}
							right={<Icon name="chevronRight" size={14} color={p.fgQuaternary} />}
							onPress={() => open(item.root)}
						/>
					</View>
				)}
			/>
		</View>
	);
}

/** A folder's entries; typing searches every file under the project. */
function Folder({ root, dir, name }: { readonly root: string; readonly dir: string; readonly name?: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [entries, setEntries] = useState<readonly IFileEntry[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState<readonly string[] | undefined>();
	const [changes, setChanges] = useState<ReadonlyMap<string, IGitChange>>(new Map());
	const atRoot = dir === root;

	const load = useCallback(async () => {
		try {
			setEntries(await client.listDir(dir));
			setError(undefined);
		} catch (err) {
			setError(errorMessage(err));
		}
	}, [client, dir]);

	useEffect(() => {
		void load();
		// Git's view of the folder: modified files get a dot, like the desktop explorer.
		void client.gitStatus(root).then(status => setChanges(new Map(status.changes.map(change => [change.path, change])))).catch(() => undefined);
	}, [load, client, root]);

	useEffect(() => {
		if (query && !index) {
			void fileIndex(client, root).then(setIndex, () => setIndex([]));
		}
	}, [query, index, client, root]);

	const results = useMemo(() => query && index ? fuzzyFilter(query, index, 120) : undefined, [query, index]);
	const changedDirs = useMemo(() => {
		const set = new Set<string>();
		for (const path of changes.keys()) {
			for (let d = dirname(path); d && d.length >= root.length; d = dirname(d)) {
				set.add(d);
				if (d === root) {
					break;
				}
			}
		}
		return set;
	}, [changes, root]);
	const statusColor = (status: IGitChange['status']) => status === 'A' || status === '?' ? p.success : status === 'D' ? p.danger : status === 'U' ? p.violet : p.warning;
	const title = atRoot ? name ?? basename(root) : basename(dir);
	const join = (rel: string) => `${root.endsWith('/') ? root.slice(0, -1) : root}/${rel}`;

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title }} />
			{results ? (
				<FlatList
					data={results}
					keyExtractor={rel => rel}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
					ListHeaderComponent={<SearchField value={query} onChange={setQuery} placeholder={`Search files in ${name ?? basename(root)}`} />}
					ListEmptyComponent={<EmptyState icon="search" title="No files match" />}
					renderItem={({ item: rel }) => <Row icon={<FileIcon path={rel} />} title={basename(rel)} detail={dirname(rel) || '.'} onPress={() => openFile(join(rel))} />}
				/>
			) : (
				<FlatList
					data={entries as IFileEntry[] | undefined}
					keyExtractor={entry => entry.path}
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
					refreshControl={<RefreshControl refreshing={false} tintColor={p.fgTertiary} onRefresh={() => void load()} />}
					ListHeaderComponent={
						<View>
							<SearchField value={query} onChange={setQuery} placeholder={`Search files in ${name ?? basename(root)}`} />
							{!atRoot ? <T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head" style={{ marginHorizontal: 20, marginBottom: 4 }}>{dir.slice(root.length + 1)}</T> : null}
						</View>
					}
					ListEmptyComponent={entries === undefined && !error ? <View style={{ paddingTop: 60 }}><ActivityIndicator color={p.fgTertiary} /></View>
						: <EmptyState icon={error ? 'alertCircle' : 'folder'} title={error ? 'Couldn\'t open this folder' : 'Empty folder'} body={error} />}
					renderItem={({ item: entry }) => {
						const change = changes.get(entry.path);
						const dirty = entry.kind === 'dir' ? changedDirs.has(entry.path) : !!change;
						return (
							<Row
								icon={<FileIcon path={entry.path} kind={entry.kind} />}
								title={entry.name}
								right={
									<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
										{change ? <T variant="caption" weight="800" color={statusColor(change.status)}>{change.status === '?' ? 'U' : change.status}</T> : dirty ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.warning }} /> : null}
										{entry.kind === 'dir' ? <Icon name="chevronRight" size={14} color={p.fgQuaternary} /> : null}
									</View>
								}
								onPress={() => entry.kind === 'dir'
									? router.push({ pathname: '/files', params: { root, dir: entry.path, ...(name ? { name } : {}) } })
									: openFile(entry.path)}
								onLongPress={change && entry.kind === 'file' ? () => router.push({ pathname: '/diff', params: { file: entry.path, title: entry.path.slice(root.length + 1), mode: 'git' } }) : undefined}
							/>
						);
					}}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 48, paddingVertical: 6 },
	icon: { width: 24, alignItems: 'center' },
	header: { letterSpacing: 0.6, marginHorizontal: 20, marginTop: 18, marginBottom: 4 },
});
