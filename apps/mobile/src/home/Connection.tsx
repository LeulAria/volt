/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IClientStatus } from '@volt/client-core';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useClient, useNow, useStatus } from '../state/client';
import { activate, useEnvironments } from '../state/environments';
import { useTheme } from '../theme/theme';
import { Icon, Shimmer, T, Tap } from '../ui/core';
import { ActionSheet, type ISheetAction } from '../ui/sheets';

export function describeConnection(status: IClientStatus, now: number): { readonly tone: 'ok' | 'busy' | 'warn' | 'error'; readonly text: string } {
	const c = status.connection;
	switch (c.phase) {
		case 'open':
			return { tone: 'ok', text: 'Connected' };
		case 'connecting':
		case 'idle':
			return { tone: 'busy', text: status.ready ? 'Reconnecting' : 'Connecting' };
		case 'waiting': {
			const s = c.retryAt ? Math.max(0, Math.ceil((c.retryAt - now) / 1000)) : 0;
			return { tone: 'warn', text: s > 1 ? `Retrying in ${s}s` : 'Retrying' };
		}
		case 'offline':
			return { tone: 'warn', text: 'Offline' };
		case 'blocked':
			return { tone: 'error', text: c.error?.code === 'Unauthorized' ? 'Signed out' : 'Update needed' };
		case 'stopped':
			return { tone: 'error', text: 'Disconnected' };
	}
}

export function useConnectionTone() {
	const status = useStatus();
	const now = useNow(1000, status.connection.phase === 'waiting');
	return describeConnection(status, now || Date.now());
}

/** The header's status dot and machine name; tap to switch machines or reconnect. */
export function ConnectionPill() {
	const { p } = useTheme();
	const client = useClient();
	const { catalog } = useEnvironments();
	const { tone, text } = useConnectionTone();
	const [open, setOpen] = useState(false);
	const color = tone === 'ok' ? p.success : tone === 'busy' ? p.info : tone === 'warn' ? p.warning : p.danger;
	const actions: ISheetAction[] = [
		{ label: 'Computers', header: true },
		...catalog.environments.map(env => ({
			label: env.label,
			detail: env.environmentId === client.environment.environmentId ? text : env.routes[0]?.baseUrl.replace(/^https?:\/\//, ''),
			icon: 'laptop' as const,
			checked: env.environmentId === client.environment.environmentId,
			onPress: () => void activate(env.environmentId),
		})),
		{ label: 'Pair another computer', icon: 'plus', onPress: () => router.push('/connect') },
		...(tone !== 'ok' ? [{ label: 'Reconnect now', icon: 'refresh' as const, onPress: () => client.reconnect() }] : []),
	];
	return (
		<>
			<Tap haptics="selection" onPress={() => setOpen(true)} accessibilityLabel={`${client.environment.label}, ${text}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingHorizontal: 11, borderRadius: 16, backgroundColor: p.fill, maxWidth: 190 }}>
				<Shimmer active={tone === 'busy'}>
					<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
				</Shimmer>
				<T variant="small" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>{tone === 'ok' ? client.environment.label : text}</T>
				<Icon name="chevronDown" size={12} color={p.fgTertiary} />
			</Tap>
			<ActionSheet visible={open} onClose={() => setOpen(false)} actions={actions} />
		</>
	);
}

export function OfflineBanner() {
	const { p } = useTheme();
	const client = useClient();
	const status = useStatus();
	const { tone, text } = useConnectionTone();
	if (status.live || tone === 'ok') {
		return null;
	}
	const blocked = status.connection.phase === 'blocked';
	return (
		<Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} style={{ marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: blocked ? `${p.danger}18` : `${p.warning}14`, borderWidth: StyleSheet.hairlineWidth, borderColor: blocked ? `${p.danger}55` : `${p.warning}44` }}>
			<Icon name={blocked ? 'alertCircle' : 'wifiOff'} size={17} color={blocked ? p.danger : p.warning} />
			<View style={{ flex: 1 }}>
				<T variant="small" weight="600">{blocked ? text : `${text} to ${client.environment.label}`}</T>
				<T variant="footnote" color={p.fgTertiary}>{blocked ? status.connection.error?.message : status.ready ? 'Showing what Volt last sent. Messages you send go out when it\'s back.' : 'Make sure Volt is open and this phone is on the same network.'}</T>
			</View>
			<Tap haptics="light" onPress={() => blocked ? router.push('/connect') : client.reconnect()} style={{ paddingHorizontal: 10, height: 30, borderRadius: 10, backgroundColor: p.fill, justifyContent: 'center' }}>
				<T variant="footnote" weight="600">{blocked ? 'Pair' : 'Retry'}</T>
			</Tap>
		</Animated.View>
	);
}
