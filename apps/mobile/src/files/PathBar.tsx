/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon } from '../ui/core';
import { FileIcon } from './FileIcon';

/** The home folder as `~`, so a path on the computer reads as it does in a terminal. */
function homeless(path: string): string {
	return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
}

/**
 * A file's path as VS Code's breadcrumbs: its folders dimmed with a chevron between each, then the
 * file's icon and name. It scrolls sideways and starts at the file's end; `right` sits after it
 * (counts, the language).
 */
export function PathBar({ path, right }: { readonly path: string; readonly right?: ReactNode }) {
	const { p } = useTheme();
	const scroller = useRef<ScrollView>(null);
	const parts = homeless(path).split('/').filter(Boolean);
	const file = parts.pop() ?? path;
	return (
		<View style={[styles.bar, { backgroundColor: p.canvas, borderColor: p.strokeFaint }]}>
			<ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}
				onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
				contentContainerStyle={styles.crumbs}>
				{parts.map((part, i) => (
					<View key={i} style={styles.crumb}>
						<Text style={[styles.folder, { color: p.fgTertiary }]} numberOfLines={1}>{part}</Text>
						<Icon name="chevronRight" size={11} color={p.fgQuaternary} />
					</View>
				))}
				<View style={styles.crumb}>
					<FileIcon path={file} size={14} />
					<Text style={[styles.file, { color: p.fg }]} numberOfLines={1}>{file}</Text>
				</View>
			</ScrollView>
			{right ? <View style={styles.right}>{right}</View> : null}
		</View>
	);
}

/** `+12 −4` as two small tinted counts. */
export function DiffCounts({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', gap: 6 }}>
			<Text style={[styles.count, { color: p.diffAddedFg }]}>+{additions}</Text>
			<Text style={[styles.count, { color: p.diffRemovedFg }]}>{'−'}{deletions}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	bar: { flexDirection: 'row', alignItems: 'center', height: 36, borderBottomWidth: StyleSheet.hairlineWidth },
	crumbs: { alignItems: 'center', paddingLeft: 14, paddingRight: 8, gap: 5 },
	crumb: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	folder: { fontSize: 13, lineHeight: 17 },
	file: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
	right: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 6, paddingRight: 14 },
	count: { fontSize: 12, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
