/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IPairedDevice, relativeTime } from '@volt/client-core';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useOptionalClient, useStatus } from '../../src/state/client';
import { useTheme } from '../../src/theme/theme';
import { T } from '../../src/ui/core';
import { Group, ListRow } from '../../src/ui/list';
import { ConfirmSheet } from '../../src/ui/sheets';

export default function DevicesScreen() {
	return useOptionalClient() ? <Devices /> : null;
}

function Devices() {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const client = useClient();
	const status = useStatus();
	const [devices, setDevices] = useState<readonly IPairedDevice[] | undefined>();
	const [removing, setRemoving] = useState<IPairedDevice | undefined>();
	const [refreshing, setRefreshing] = useState(false);
	const owner = client.environment.role === 'owner';

	const refresh = useCallback(async () => {
		const list = await client.listDevices();
		if (list) {
			setDevices(list);
		}
	}, [client]);

	useEffect(() => {
		if (status.live) {
			void refresh();
		}
	}, [status.live, refresh]);

	return (
		<ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
			refreshControl={<RefreshControl refreshing={refreshing} tintColor={p.fgTertiary} onRefresh={async () => {
				setRefreshing(true);
				await refresh();
				setRefreshing(false);
			}} />}>
			<Group title="Paired with this computer" footer={owner ? 'Removing a device signs it out at once.' : 'To pair another device, use Volt on your computer: Pair a Phone or Browser…'}>
				{!devices ? (
					<View style={{ padding: 24, alignItems: 'center' }}><ActivityIndicator color={p.fgTertiary} /></View>
				) : devices.length ? devices.map(device => (
					<ListRow
						key={device.id}
						icon={device.kind === 'web' ? 'laptop' : 'phone'}
						iconColor={device.connected ? p.success : undefined}
						label={device.current ? `${device.label} (this phone)` : device.label}
						detail={[device.connected ? 'Connected' : device.lastSeenAt ? `Seen ${relativeTime(device.lastSeenAt)}` : 'Never connected', device.role === 'owner' ? 'Trusted' : undefined, device.os].filter(Boolean).join(' · ')}
						onPress={owner || device.current ? () => setRemoving(device) : undefined}
						right={owner || device.current ? <T variant="small" color={p.danger}>Remove</T> : undefined}
					/>
				)) : <ListRow label="No devices" />}
			</Group>
			<ConfirmSheet visible={!!removing} onClose={() => setRemoving(undefined)} title={`Remove ${removing?.label ?? 'device'}?`} body={removing?.current ? 'This phone signs out of the computer.' : 'It is signed out now and needs a new code to come back.'} confirm="Remove" destructive
				onConfirm={() => {
					if (removing) {
						void client.revokeDevice(removing.id).then(() => refresh());
					}
				}} />
		</ScrollView>
	);
}
