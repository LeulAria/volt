/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IGitRepoStatus } from '@volt/client-core';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { Button, haptic, Icon, T } from '../src/ui/core';

export default function NewPullScreen() {
	const { root, branch } = useLocalSearchParams<{ root: string; branch?: string }>();
	return useOptionalClient() && root ? <NewPull root={root} branch={branch} /> : null;
}

function titleFromBranch(branch: string | undefined): string {
	const name = (branch ?? '').split('/').pop() ?? '';
	const words = name.replace(/[-_]+/g, ' ').trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** Opens a pull request for the checked out branch (pushed first when it needs to be). */
function NewPull({ root, branch }: { readonly root: string; readonly branch?: string }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const [status, setStatus] = useState<IGitRepoStatus | undefined>();
	const [title, setTitle] = useState(titleFromBranch(branch));
	const [body, setBody] = useState('');
	const [draft, setDraft] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void client.gitRepoStatus(root).then(setStatus, () => undefined);
	}, [client, root]);

	const create = async () => {
		setBusy(true);
		try {
			const pr = await client.createPullRequest(root, { title: title.trim(), ...(body.trim() ? { body: body.trim() } : {}), draft });
			haptic.success();
			router.replace({ pathname: '/pull', params: { root, number: String(pr.number) } });
		} catch (err) {
			haptic.error();
			client.toast('error', `Couldn't open the pull request: ${errorMessage(err)}`);
		} finally {
			setBusy(false);
		}
	};

	const field = { borderRadius: 12, backgroundColor: p.fill, paddingHorizontal: 12, color: p.fg, fontSize: 16 } as const;
	return (
		<KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{ title: 'Open a pull request' }} />
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 24 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.surface }}>
					<Icon name="branch" size={15} color={p.fgTertiary} />
					<T variant="small" mono color={p.fgSecondary} numberOfLines={1} style={{ flex: 1 }}>{status?.defaultBranch ?? 'main'} ← {status?.branch ?? branch}</T>
					{status?.aheadOfDefault ? <T variant="footnote" color={p.fgTertiary}>{status.aheadOfDefault} {status.aheadOfDefault === 1 ? 'commit' : 'commits'}</T> : null}
				</View>
				{status && status.files?.length ? <T variant="footnote" color={p.warning}>{status.files.length} uncommitted {status.files.length === 1 ? 'change stays' : 'changes stay'} out of the pull request. Commit them first to include them.</T> : null}
				<View style={{ gap: 6 }}>
					<T variant="small" weight="600" color={p.fgSecondary}>Title</T>
					<TextInput value={title} onChangeText={setTitle} placeholder="What does this change?" placeholderTextColor={p.fgQuaternary} selectionColor={p.accent} style={[field, { height: 46 }]} />
				</View>
				<View style={{ gap: 6 }}>
					<T variant="small" weight="600" color={p.fgSecondary}>Description</T>
					<TextInput value={body} onChangeText={setBody} multiline placeholder="Optional. Markdown works." placeholderTextColor={p.fgQuaternary} selectionColor={p.accent} style={[field, { minHeight: 140, paddingTop: 12, textAlignVertical: 'top' }]} />
				</View>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
					<View style={{ flex: 1 }}>
						<T variant="body">Draft</T>
						<T variant="footnote" color={p.fgTertiary}>Not ready for review yet</T>
					</View>
					<Switch value={draft} onValueChange={setDraft} trackColor={{ true: p.success, false: p.fillStrong }} />
				</View>
				<Button label={draft ? 'Open draft pull request' : 'Open pull request'} icon="pullRequest" variant="primary" size="lg" busy={busy} disabled={!title.trim()} onPress={() => void create()} />
			</ScrollView>
		</KeyboardAvoidingView>
	);
}
