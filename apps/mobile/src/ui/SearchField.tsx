/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { Icon } from './core';

/**
 * Volt's search: a bare glass and the text, no box around them, on a hairline that runs edge to
 * edge under it (the model picker's look, used for every search). `bleed` pulls the hairline out
 * through a padded container's sides so it still reaches both edges.
 */
export function SearchField({ value, onChange, placeholder, autoFocus, inset = 16, bleed = 0 }: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly placeholder: string;
	readonly autoFocus?: boolean;
	/** Space before the glass and after the text. */
	readonly inset?: number;
	readonly bleed?: number;
}) {
	const { p } = useTheme();
	return (
		<View>
			<View style={[styles.row, { paddingHorizontal: inset }]}>
				<Icon name="search" size={18} color={p.fgTertiary} />
				<TextInput
					value={value}
					onChangeText={onChange}
					placeholder={placeholder}
					placeholderTextColor={p.fgQuaternary}
					autoFocus={autoFocus}
					autoCapitalize="none"
					autoCorrect={false}
					keyboardAppearance={p.scheme}
					selectionColor={p.accent}
					clearButtonMode="while-editing"
					returnKeyType="search"
					style={[styles.input, { color: p.fg }]}
				/>
			</View>
			<View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.strokeFaint, marginHorizontal: -bleed }} />
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46 },
	input: { flex: 1, fontSize: 16, paddingVertical: 0 },
});
