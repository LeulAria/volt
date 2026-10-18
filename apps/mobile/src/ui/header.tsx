/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/theme';
import { T } from './core';

/**
 * A tab's header, GitHub app style: a row of small actions over a large bold title. Tabs draw
 * their own (the tab navigator's header has no large title).
 */
export function LargeHeader({ title, left, right, subtitle }: { readonly title: string; readonly left?: ReactNode; readonly right?: ReactNode; readonly subtitle?: ReactNode }) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	return (
		<View style={{ paddingTop: insets.top + 4, backgroundColor: p.canvas }}>
			<View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 8 }}>
				<View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>{left}</View>
				<View style={{ flexDirection: 'row', alignItems: 'center' }}>{right}</View>
			</View>
			<View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
				<T variant="display" weight="800" style={{ letterSpacing: -0.8 }}>{title}</T>
				{subtitle}
			</View>
		</View>
	);
}
