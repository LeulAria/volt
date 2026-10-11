/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ACCESS_MODES, type IEnvironmentDescriptor, modelLabel, providerName, routeLabel } from '@volt/client-core';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionTone } from '../../src/home/Connection';
import { useClient, useOptionalClient, useRuntime, useStatus } from '../../src/state/client';
import { activate, forget, useEnvironments } from '../../src/state/environments';
import { useTheme } from '../../src/theme/theme';
import { Segmented, T } from '../../src/ui/core';
import { Group, ListRow } from '../../src/ui/list';
import { ActionSheet, ConfirmSheet, type ISheetAction } from '../../src/ui/sheets';

export default function SettingsScreen() {
	const { p, preference, setPreference } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useOptionalClient();
	const { catalog } = useEnvironments();
	return (
		<ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
			<Group title="Computers" footer="Chats run on your computer. Pair as many as you like and switch between them here.">
				{catalog.environments.map(env => (
					<ListRow key={env.environmentId} icon="laptop" label={env.label} detail={env.routes.map(r => routeLabel(r.kind)).join(' · ')}
						checked={env.environmentId === client?.environment.environmentId} onPress={() => void activate(env.environmentId)} />
				))}
				<ListRow icon="plus" iconColor={p.accent} label="Pair another computer" onPress={() => router.push('/connect')} />
			</Group>
			{client ? <Connected /> : null}
			<Group title="Appearance">
				<View style={{ padding: 12 }}>
					<Segmented value={preference} onChange={setPreference} options={[
						{ id: 'system', label: 'System', icon: 'contrast' },
						{ id: 'light', label: 'Light', icon: 'sun' },
						{ id: 'dark', label: 'Dark', icon: 'moon' },
					]} />
				</View>
			</Group>
			<Group title="About">
				<ListRow icon="bolt" label="Volt" value={`${Constants.expoConfig?.version ?? '0.1.0'} · ${Platform.OS === 'ios' ? 'iOS' : 'Android'}`} />
			</Group>
		</ScrollView>
	);
}

function Connected() {
	const { p } = useTheme();
	const client = useClient();
	const status = useStatus();
	const runtime = useRuntime();
	const { tone, text } = useConnectionTone();
	const [info, setInfo] = useState<IEnvironmentDescriptor | undefined>();
	const [sheet, setSheet] = useState<'model' | 'access' | undefined>();
	const [removing, setRemoving] = useState(false);
	useEffect(() => {
		if (status.live) {
			void client.environmentInfo().then(setInfo);
		}
	}, [client, status.live]);
	const env = client.environment;
	const access = ACCESS_MODES.find(a => a.id === runtime.accessMode) ?? ACCESS_MODES[3];
	const route = env.routes.find(r => r.baseUrl === status.baseUrl) ?? env.routes[0];
	const color = tone === 'ok' ? p.success : tone === 'busy' ? p.info : tone === 'warn' ? p.warning : p.danger;

	const actions: ISheetAction[] = sheet === 'model'
		? (runtime.catalog ?? []).filter(item => runtime.enabledModels?.[item.ref] ?? item.enabled).map(item => ({
			label: item.qualifier ? `${item.label} ${item.qualifier}` : item.label, detail: providerName(item.providerId), checked: item.ref === runtime.activeCatalogRef,
			onPress: () => void client.setActiveModel(item.ref),
		}))
		: ACCESS_MODES.map(a => ({ label: a.label, detail: a.description, checked: a.id === access.id, onPress: () => void client.setAccessMode(a.id) }));

	return (
		<>
			<Group title={env.label}>
				<ListRow icon="wifi" iconColor={color} label={text} detail={route ? `${routeLabel(route.kind)} · ${route.baseUrl.replace(/^https?:\/\//, '')}` : undefined} onPress={tone === 'ok' ? undefined : () => client.reconnect()} right={tone === 'ok' ? undefined : <T variant="small" weight="600" color={p.accent}>Retry</T>} />
				{info ? <ListRow icon="server" label="Volt server" value={`v${info.serverVersion} · ${info.platform.os}`} /> : null}
				<ListRow icon="phone" label="Devices" detail="Paired phones and browsers" chevron onPress={() => router.push('/settings/devices')} />
				<ListRow icon="cpu" label="Models and providers" chevron onPress={() => router.push('/settings/models')} />
			</Group>
			<Group title="New chats">
				<ListRow icon="sparkles" label="Model" value={modelLabel(runtime, runtime.activeCatalogRef)} chevron onPress={() => setSheet('model')} />
				<ListRow icon="shield" label="Access" value={access.label} chevron onPress={() => setSheet('access')} />
			</Group>
			<Group>
				<ListRow icon="logOut" label={`Remove ${env.label}`} destructive onPress={() => setRemoving(true)} />
			</Group>
			<ActionSheet visible={!!sheet} onClose={() => setSheet(undefined)} title={sheet === 'model' ? 'Model for new chats' : 'Access for new chats'} actions={actions} />
			<ConfirmSheet visible={removing} onClose={() => setRemoving(false)} title={`Remove ${env.label}?`} body="This phone signs out and forgets the computer. Chats keep running there. Pair again with a new code to come back." confirm="Remove" destructive
				onConfirm={() => {
					const done = () => {
						void client.clearCache();
						void forget(env.environmentId);
						if (router.canDismiss()) {
							router.dismissAll();
						}
					};
					if (env.deviceId && env.deviceId !== 'owner') {
						void client.revokeDevice(env.deviceId).finally(done);
					} else {
						done();
					}
				}} />
		</>
	);
}
