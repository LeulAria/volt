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
import { Icon, T, Tap } from '../ui/core';

const KIND: Record<IAgentChange['kind'], { readonly letter: string; readonly label: string }> = {
	added: { letter: 'A', label: 'Added' },
	modified: { letter: 'M', label: 'Modified' },
	deleted: { letter: 'D', label: 'Deleted' },
	renamed: { letter: 'R', label: 'Renamed' },
};

export function openChangeDiff(change: IAgentChange): void {
	const file = uriPath(change.uri) ?? change.path;
	router.push({ pathname: '/diff', params: { title: change.path, file, repoRoot: change.repoRoot, ...(change.oldBlob ? { oldBlob: change.oldBlob } : {}), ...(change.newBlob ? { newBlob: change.newBlob } : {}), kind: change.kind } });
}

export function changeTotals(changes: readonly IAgentChange[]): { readonly add: number; readonly del: number } {
	return changes.reduce((sum, c) => ({ add: sum.add + c.additions, del: sum.del + c.deletions }), { add: 0, del: 0 });
}

/** One changed file: icon, name and folder, +/- counts, A/M/D/R, and its diff on tap. */
export const ChangeRow = memo(function ChangeRow({ change, first, last }: { readonly change: IAgentChange; readonly first?: boolean; readonly last?: boolean }) {
	const { p } = useTheme();
	const dir = dirname(change.path);
	const color = change.kind === 'added' ? p.success : change.kind === 'deleted' ? p.danger : change.kind === 'renamed' ? p.violet : p.warning;
	return (
		<Tap
			haptics="selection"
			disabled={change.binary}
			onPress={() => openChangeDiff(change)}
			style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11, backgroundColor: p.surface, borderTopLeftRadius: first ? 14 : 0, borderTopRightRadius: first ? 14 : 0, borderBottomLeftRadius: last ? 14 : 0, borderBottomRightRadius: last ? 14 : 0 }}
		>
			<FileIcon path={change.path} />
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="body" weight="500" numberOfLines={1}>{basename(change.path)}</T>
				<T variant="caption" mono color={p.fgQuaternary} numberOfLines={1} ellipsizeMode="head">{change.kind === 'renamed' && change.oldPath ? `${change.oldPath} → ${dir || '.'}` : dir || '.'}</T>
			</View>
			{change.binary ? <T variant="footnote" color={p.fgTertiary}>binary</T> : (
				<View style={{ alignItems: 'flex-end' }}>
					{change.additions ? <T variant="footnote" mono color={p.diffAddedFg}>+{change.additions}</T> : null}
					{change.deletions ? <T variant="footnote" mono color={p.diffRemovedFg}>{'−'}{change.deletions}</T> : null}
				</View>
			)}
			<View style={{ width: 20, height: 20, borderRadius: 5, backgroundColor: `${color}22`, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={KIND[change.kind].label}>
				<T variant="caption" weight="800" color={color}>{KIND[change.kind].letter}</T>
			</View>
			<Icon name="chevronRight" size={14} color={p.fgQuaternary} />
		</Tap>
	);
});
