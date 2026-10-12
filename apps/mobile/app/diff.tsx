/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, diffText, errorMessage, type IFileDiff, languageForPath } from '@volt/client-core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { openFile } from '../src/chat/context';
import { DiffList, diffItems } from '../src/chat/Diff';
import { useClient, useOptionalClient } from '../src/state/client';
import { useTheme } from '../src/theme/theme';
import { EmptyState, IconButton, T } from '../src/ui/core';

type IParams = {
	/** The absolute path of the file (the right side, when no blob names it). */
	readonly file?: string;
	readonly title?: string;
	readonly repoRoot?: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly kind?: string;
	/** `git`: the file against its last commit, instead of a checkpoint's blobs. */
	readonly mode?: string;
};

export default function DiffScreen() {
	const params = useLocalSearchParams<IParams>();
	const client = useOptionalClient();
	return client && params.file ? <Diff params={params} /> : null;
}

/** One file's diff, both sides loaded from the computer: checkpoint blobs, or the last commit and the file now. */
function Diff({ params }: { readonly params: IParams }) {
	const { p } = useTheme();
	const client = useClient();
	const [diff, setDiff] = useState<IFileDiff | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [wrap, setWrap] = useState(false);
	const file = params.file!;
	const fence = languageForPath(file).fence;

	useEffect(() => {
		let live = true;
		const side = async (blob: string | undefined, current: boolean): Promise<string> => {
			if (blob && params.repoRoot) {
				return (await client.gitBlob(params.repoRoot, blob)).text;
			}
			if (!current) {
				return '';
			}
			const content = await client.readFile(file);
			if (content.kind !== 'text') {
				throw new Error(content.kind === 'tooLarge' ? 'The file is too large to compare here.' : 'This file isn\'t text.');
			}
			return content.text;
		};
		const load = async () => {
			const [before, after] = params.mode === 'git'
				? await Promise.all([client.gitShow(file).then(r => r.text), side(undefined, true).catch(() => '')])
				: await Promise.all([side(params.oldBlob, false), side(params.newBlob, params.kind !== 'deleted')]);
			return diffText(before, after, 3);
		};
		load().then(result => live && setDiff(result), err => live && setError(errorMessage(err)));
		return () => {
			live = false;
		};
	}, [client, file, params.repoRoot, params.oldBlob, params.newBlob, params.kind, params.mode]);

	const items = useMemo(() => diff ? diffItems(diff.hunks) : [], [diff]);
	const title = basename(params.title ?? file);

	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<Stack.Screen options={{
				title,
				headerRight: () => (
					<View style={{ flexDirection: 'row' }}>
						<IconButton icon={wrap ? 'minimize' : 'expand'} label={wrap ? 'Don\'t wrap lines' : 'Wrap lines'} color={p.fg} onPress={() => setWrap(w => !w)} />
						{params.kind !== 'deleted' ? <IconButton icon="file" label="Open file" color={p.fg} onPress={() => openFile(file)} /> : null}
					</View>
				),
			}} />
			{diff ? (
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
					<T variant="footnote" mono color={p.fgTertiary} numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>{params.title ?? file}</T>
					<T variant="footnote" mono color={p.diffAddedFg}>+{diff.additions}</T>
					<T variant="footnote" mono color={p.diffRemovedFg}>{'−'}{diff.deletions}</T>
				</View>
			) : null}
			{error ? <EmptyState icon="alertCircle" title="Couldn't load the diff" body={error} />
				: !diff ? <View style={{ paddingTop: 60 }}><ActivityIndicator color={p.fgTertiary} /></View>
					: !items.length ? <EmptyState icon="checkCircle" title="No differences" body="Both sides are the same." />
						: <DiffList items={items} wrap={wrap} fence={fence} />}
		</View>
	);
}
