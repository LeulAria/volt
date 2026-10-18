/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ScrollView, StyleSheet, View } from 'react-native';
import { useConnectionTone } from '../../src/home/Connection';
import { SettingsBody } from '../../src/settings/Settings';
import { useChatItems, useClient } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { Icon, T } from '../../src/ui/core';
import { LargeHeader } from '../../src/ui/header';

/** You: the computer this phone follows (the GitHub app's profile header), then every setting. */
export default function You() {
	const { p } = useTheme();
	const client = useClient();
	const items = useChatItems();
	const { tone, text } = useConnectionTone();
	const color = tone === 'ok' ? p.success : tone === 'busy' ? p.info : tone === 'warn' ? p.warning : p.danger;
	const working = items.filter(item => item.status === 'working').length;
	return (
		<View style={{ flex: 1, backgroundColor: p.canvas }}>
			<LargeHeader title="You" />
			<ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 4, padding: 14, borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					<View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' }}>
						<Icon name="laptop" size={24} color={p.onPrimary} />
					</View>
					<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
						<T variant="title3" weight="700" numberOfLines={1}>{client.environment.label}</T>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
							<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
							<T variant="small" color={p.fgSecondary}>{text}</T>
						</View>
						<T variant="footnote" color={p.fgTertiary}>{items.filter(item => !item.archived).length} chats{working ? ` · ${working} working` : ''}</T>
					</View>
				</View>
				<SettingsBody />
			</ScrollView>
		</View>
	);
}
