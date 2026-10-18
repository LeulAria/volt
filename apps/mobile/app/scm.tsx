/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, errorMessage, type IGitChange, type IGitStatus } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FileIcon } from '../src/files/FileIcon';
import { useClient, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { Button, EmptyState, haptic, T, Tap } from '../src/ui/core';
import { GitActions } from '../src/git/GitActions';

export default function ScmScreen() {
	const { root, name } = useLocalSearchParams<{ root: string; name?: string }>();
	return useOptionalClient() && root ? <SourceControl root={root} name={name} /> : null;
}

const STATUS_LABEL: Record<IGitChange['status'], string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict', '?': 'Untracked' };

/** A project's uncommitted changes (VS Code's Source Control): diffs against HEAD and a commit box. */
function SourceControl({ root, name }: { readonly root: string; readonly name?: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [status, setStatus] = useState<IGitStatus | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState('');
	const [committing, setCommitting] = useState(false);

	const load = useCallback(() => {
		setLoading(true);
		void client.gitStatus(root).then(next => {
			setStatus(next);
			setError(undefined);
		}, err => setError(errorMessage(err))).finally(() => setLoading(false));
	}, [client, root]);
	useEffect(load, [load]);

	const commit = async () => {
		if (!message.trim()) {
			return;
		}
		setCommitting(true);
		try {
			const result = await client.gitCommit(root, message.trim());
			haptic.success();
			client.toast('success', `Committed ${result.commit.slice(0, 7)}`);
			setMessage('');
			load();
		} catch (err) {
			haptic.error();
			client.toast('error', `Couldn't commit: ${errorMessage(err)}`);
		} finally {
			setCommitting(false);
		}
	};

	const statusColor = (s: IGitChange['status']) => s === 'A' || s === '?' ? p.success : s === 'D' ? p.danger : s === 'U' ? p.violet : p.warning;
	const changes = status?.changes ?? [];

	return (
		<KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: name ? `${name}` : 'Source control' }} />
			<FlatList
				data={changes as IGitChange[]}
				keyExtractor={change => `${change.staged ? 's' : 'w'}:${change.path}`}
				refreshControl={<RefreshControl refreshing={loading && !!status} onRefresh={load} tintColor={p.fgTertiary} />}
				contentContainerStyle={{ paddingBottom: 16 }}
				ListHeaderComponent={
					<View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, gap: 12 }}>
						<GitActions root={root} onChanged={load} />
						{changes.length ? <T variant="small" weight="700" color={p.fgSecondary}>{changes.length} {changes.length === 1 ? 'change' : 'changes'}</T> : null}
					</View>
				}
				ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginLeft: 48 }} />}
				renderItem={({ item: change }) => (
					<Tap haptics="selection" onPress={() => router.push({ pathname: '/diff', params: { file: change.path, title: change.rel, mode: 'git' } })}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 50 }}>
						<FileIcon path={change.rel} size={18} />
						<View style={{ flex: 1, minWidth: 0 }}>
							<T variant="body" numberOfLines={1} style={{ textDecorationLine: change.status === 'D' ? 'line-through' : 'none' }}>{basename(change.rel)}</T>
							<T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head">{dirname(change.rel) === '.' ? STATUS_LABEL[change.status] : dirname(change.rel)}</T>
						</View>
						{change.additions ? <T variant="footnote" color={p.diffAddedFg}>+{change.additions}</T> : null}
						{change.deletions ? <T variant="footnote" color={p.diffRemovedFg}>-{change.deletions}</T> : null}
						<View style={{ width: 20, alignItems: 'center' }}><T variant="small" weight="700" mono color={statusColor(change.status)}>{change.status === '?' ? 'U' : change.status}</T></View>
					</Tap>
				)}
				ListEmptyComponent={loading && !status
					? <ActivityIndicator style={{ marginTop: 40 }} color={p.fgTertiary} />
					: <EmptyState icon={error ? 'alertCircle' : 'checkCircle'} title={error ? 'Couldn\'t read git' : 'Nothing to commit'} body={error ?? 'The working tree matches the last commit.'} />}
			/>
			{changes.length ? (
				<View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.sidebar }}>
					<View style={{ flex: 1, minHeight: 42, maxHeight: 120, borderRadius: 12, backgroundColor: p.fill, paddingHorizontal: 12, justifyContent: 'center' }}>
						<TextInput value={message} onChangeText={setMessage} multiline placeholder="Commit message" placeholderTextColor={p.fgQuaternary} selectionColor={p.accent} style={{ color: p.fg, fontSize: 16, paddingVertical: 10 }} />
					</View>
					<Button label="Commit" icon="check" variant="primary" busy={committing} disabled={!message.trim()} onPress={() => void commit()} />
				</View>
			) : null}
		</KeyboardAvoidingView>
	);
}
