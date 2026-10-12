/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isImagePath, languageForPath } from '@volt/client-core';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon } from '../ui/core';

/** Seti's colours (the desktop's file icons) for the languages people open most. */
const COLORS: Record<string, readonly [string, string]> = {
	typescript: ['TS', '#519aba'], typescriptreact: ['TSX', '#519aba'], javascript: ['JS', '#cbcb41'], javascriptreact: ['JSX', '#519aba'],
	json: ['{}', '#cbcb41'], jsonc: ['{}', '#cbcb41'], markdown: ['MD', '#519aba'], mdx: ['MDX', '#519aba'], html: ['<>', '#e37933'], vue: ['V', '#8dc149'], svelte: ['S', '#cc3e44'],
	css: ['#', '#519aba'], scss: ['#', '#f55385'], less: ['#', '#519aba'], python: ['PY', '#519aba'], go: ['GO', '#519aba'], rust: ['RS', '#e37933'],
	java: ['J', '#cc3e44'], kotlin: ['K', '#a074c4'], swift: ['SW', '#e37933'], c: ['C', '#519aba'], cpp: ['C++', '#519aba'], csharp: ['C#', '#519aba'],
	ruby: ['RB', '#cc3e44'], php: ['PHP', '#a074c4'], shellscript: ['$', '#8dc149'], yaml: ['YML', '#a074c4'], toml: ['TML', '#6d8086'], xml: ['XML', '#e37933'],
	sql: ['SQL', '#f55385'], dockerfile: ['DKR', '#519aba'], graphql: ['GQL', '#f55385'], dart: ['DRT', '#519aba'], lua: ['LUA', '#519aba'],
	ignore: ['GIT', '#41535b'], dotenv: ['ENV', '#cbcb41'], makefile: ['MK', '#e37933'], diff: ['±', '#8dc149'], plaintext: ['TXT', '#6d8086'],
};

export const FileIcon = memo(function FileIcon({ path, kind = 'file', open, size = 22 }: { readonly path: string; readonly kind?: 'file' | 'dir'; readonly open?: boolean; readonly size?: number }) {
	const { p } = useTheme();
	if (kind === 'dir') {
		return <Icon name="folder" size={size - 2} color={open ? p.fgSecondary : p.fgTertiary} />;
	}
	if (isImagePath(path)) {
		return <Icon name="image" size={size - 3} color="#a074c4" />;
	}
	const [label, color] = COLORS[languageForPath(path).id] ?? COLORS.plaintext;
	return (
		<View style={[styles.badge, { width: size, height: size, backgroundColor: `${color}22`, borderColor: `${color}55` }]}>
			<Text style={[styles.label, { color, fontSize: label.length > 2 ? 7.5 : 9 }]} numberOfLines={1}>{label}</Text>
		</View>
	);
});

const styles = StyleSheet.create({
	badge: { borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
	label: { fontWeight: '800', letterSpacing: -0.3 },
});
