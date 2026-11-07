/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, type IAgentChange, uriPath } from '@volt/client-core';
import { router } from 'expo-router';
import { memo } from 'react';
import { View } from 'react-native';
import { FileIcon } from '../files/FileIcon';
import { useTheme } from '../theme/theme';
import { T } from '../ui/core';
import { ListItem } from '../ui/list';

const KIND: Record<IAgentChange['kind'], { readonly letter: string; readonly label: string }> = {
	added: { letter: 'A', label: 'Added' },
	modified: { letter: 'M', label: 'Modified' },
	deleted: { letter: 'D', label: 'Deleted' },
	renamed: { letter: 'R', label: 'Renamed' },
};

export function openChangeDiff(change: IAgentChange): void {
	const file = uriPath(change.uri) ?? change.path;
	router.push({ pathname: '/diff', params: { title: change.path, file, repoRoot: change.repoRoot, ...(change.oldBlob ? { oldBlob: change.oldBlob } : {}), ...(change.newBlob ? { newBlob: change.newBlob } : {}), kind: change.kind, additions: String(change.additions), deletions: String(change.deletions) } });
}

/** Edit patches handed to the diff screen by id (too big for route params). */
const editPatches = new Map<string, string>();
let nextEdit = 0;

/** The patch {@link openEditDiff} left under this id, if this app session still has it. */
export function editPatch(id: string | undefined): string | undefined {
	return id ? editPatches.get(id) : undefined;
}

/**
 * One edit from the transcript as the whole file with its changes marked: the diff screen undoes
 * `patch` on the file as it is now to get the other side. A new file needs no patch.
 */
export function openEditDiff(path: string, patch: string | undefined, created: boolean, counts: { readonly additions?: number; readonly deletions?: number }): void {
	const id = patch && !created ? `e${++nextEdit}` : undefined;
	if (id) {
		editPatches.set(id, patch!);
	}
	router.push({ pathname: '/diff', params: { file: path, full: '1', ...(created ? { kind: 'added' } : {}), ...(id ? { edit: id } : {}), ...(counts.additions !== undefined ? { additions: String(counts.additions) } : {}), ...(counts.deletions !== undefined ? { deletions: String(counts.deletions) } : {}) } });
}

export function changeTotals(changes: readonly IAgentChange[]): { readonly add: number; readonly del: number } {
	return changes.reduce((sum, c) => ({ add: sum.add + c.additions, del: sum.del + c.deletions }), { add: 0, del: 0 });
}

/**
 * One changed file as a row of VS Code's Source Control list: icon, name with its folder dimmed
 * beside it, +/- counts and the status letter in its colour; its diff on tap.
 */
export const ChangeRow = memo(function ChangeRow({ change }: { readonly change: IAgentChange; readonly first?: boolean; readonly last?: boolean }) {
	const { p } = useTheme();
	const dir = dirname(change.path);
	const color = change.kind === 'added' ? p.success : change.kind === 'deleted' ? p.danger : change.kind === 'renamed' ? p.violet : p.warning;
	return (
		<ListItem disabled={change.binary} onPress={() => openChangeDiff(change)} accessibilityLabel={`${basename(change.path)}, ${KIND[change.kind].label}`} style={{ minHeight: 42, gap: 10, paddingVertical: 6 }}>
			<FileIcon path={change.path} size={18} />
			<View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 7 }}>
				<T variant="body" numberOfLines={1} style={{ flexShrink: 1, maxWidth: '75%', textDecorationLine: change.kind === 'deleted' ? 'line-through' : 'none' }}>{basename(change.path)}</T>
				<T variant="footnote" color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head" style={{ flex: 1 }}>{change.kind === 'renamed' && change.oldPath ? `${change.oldPath} → ${dir || '.'}` : dir}</T>
			</View>
			{change.binary ? <T variant="footnote" color={p.fgTertiary}>binary</T> : (
				<View style={{ flexDirection: 'row', gap: 6 }}>
					{change.additions ? <T variant="footnote" mono color={p.diffAddedFg} style={{ fontVariant: ['tabular-nums'] }}>+{change.additions}</T> : null}
					{change.deletions ? <T variant="footnote" mono color={p.diffRemovedFg} style={{ fontVariant: ['tabular-nums'] }}>{'−'}{change.deletions}</T> : null}
				</View>
			)}
			<T variant="footnote" mono weight="700" color={color} style={{ width: 12, textAlign: 'center' }} accessibilityElementsHidden>{KIND[change.kind].letter}</T>
		</ListItem>
	);
});
