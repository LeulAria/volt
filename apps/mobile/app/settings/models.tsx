/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ICatalogItem } from '@volt/client-core';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useOptionalClient, useRuntime } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { haptic, Switch, T } from '../../src/ui/core';
import { useHeaderScroll } from '../../src/ui/header';
import { Group, ListRow } from '../../src/ui/list';

const STATE_LABEL: Record<string, string> = { authenticated: 'Signed in', available: 'Available', disabled: 'Off', missing: 'Not installed', checking: 'Checking…' };

export default function ModelsScreen() {
	return useOptionalClient() ? <Models /> : null;
}

function Models() {
	const onHeaderScroll = useHeaderScroll();
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
		<Animated.ScrollView onScroll={onHeaderScroll} scrollEventThrottle={16} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
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
					<Group key={provider.profileId} title={provider.label} footer={[provider.account, provider.plan].filter(Boolean).join(' · ') || undefined}
						right={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
							<View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateColor(provider.state) }} />
							<T variant="caption" color={p.fgTertiary}>{STATE_LABEL[provider.state] ?? provider.state}</T>
						</View>}>
						<ListRow
							label={provider.enabled ? 'On' : 'Off'}
							detail={provider.enabled ? `${models.length} ${models.length === 1 ? 'model' : 'models'}` : 'Its models are hidden from the picker'}
							right={<Switch value={provider.enabled} accessibilityLabel={`${provider.label} on`} onValueChange={next => {
								haptic.selection();
								void client.setProfileEnabled(provider.profileId, next);
							}} />}
						/>
						{provider.enabled ? models.map(model => (
							<ListRow
								key={model.ref}
								label={model.qualifier ? `${model.label} ${model.qualifier}` : model.label}
								detail={model.contextLabel}
								right={<Switch value={runtime.enabledModels?.[model.ref] ?? model.enabled} accessibilityLabel={model.label} onValueChange={next => {
									haptic.selection();
									void client.setModelEnabled(model.ref, next);
								}} />}
							/>
						)) : null}
					</Group>
				);
			})}
		</Animated.ScrollView>
	);
}
