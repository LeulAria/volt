/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ICatalogItem } from '@volt/client-core';
import { useState } from 'react';
import { RefreshControl, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useOptionalClient, useRuntime } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { haptic, T } from '../../src/ui/core';
import { Group, ListRow } from '../../src/ui/list';

const STATE_LABEL: Record<string, string> = { authenticated: 'Signed in', available: 'Available', disabled: 'Off', missing: 'Not installed', checking: 'Checking…' };

export default function ModelsScreen() {
	return useOptionalClient() ? <Models /> : null;
}

function Models() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const runtime = useRuntime();
	const [refreshing, setRefreshing] = useState(false);
	const byProfile = new Map<string, ICatalogItem[]>();
	for (const item of runtime.catalog ?? []) {
		const list = byProfile.get(item.profileId) ?? [];
		list.push(item);
		byProfile.set(item.profileId, list);
	}
	const providers = runtime.providerStatuses ?? [];
	const stateColor = (state: string) => state === 'authenticated' ? p.success : state === 'available' ? p.info : state === 'missing' ? p.danger : state === 'checking' ? p.warning : p.fgQuaternary;
	return (
		<ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
			refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={async () => {
				setRefreshing(true);
				await client.refreshProviders();
				setRefreshing(false);
			}} />}>
			{!providers.length ? (
				<Group footer="Connect a provider in Volt on your computer; sign-ins and keys stay there.">
					<ListRow label={runtime.catalogLoading ? 'Loading…' : 'No providers'} />
				</Group>
			) : providers.map(provider => {
				const models = byProfile.get(provider.profileId) ?? provider.models ?? [];
				return (
					<Group key={provider.profileId} title={provider.label} footer={[STATE_LABEL[provider.state] ?? provider.state, provider.account, provider.plan].filter(Boolean).join(' · ')}>
						<ListRow
							icon="cpu"
							iconColor={stateColor(provider.state)}
							label={provider.enabled ? 'On' : 'Off'}
							right={<Switch value={provider.enabled} onValueChange={next => {
								haptic.selection();
								void client.setProfileEnabled(provider.profileId, next);
							}} trackColor={{ true: p.success, false: p.fillStrong }} />}
						/>
						{provider.enabled ? models.map(model => (
							<View key={model.ref} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 54, paddingRight: 14, minHeight: 46, gap: 10 }}>
								<View style={{ flex: 1 }}>
									<T variant="body">{model.qualifier ? `${model.label} ${model.qualifier}` : model.label}</T>
									{model.contextLabel ? <T variant="footnote" color={p.fgTertiary}>{model.contextLabel}</T> : null}
								</View>
								<Switch value={runtime.enabledModels?.[model.ref] ?? model.enabled} onValueChange={next => {
									haptic.selection();
									void client.setModelEnabled(model.ref, next);
								}} trackColor={{ true: p.success, false: p.fillStrong }} />
							</View>
						)) : null}
					</Group>
				);
			})}
		</ScrollView>
	);
}
