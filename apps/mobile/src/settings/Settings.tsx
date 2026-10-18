/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ACCESS_MODES, type IVoltPalette, VOLT_THEMES, DENSITY_PREVIEW_STEPS, DENSITY_PREVIEW_SUMMARY, type IEnvironmentDescriptor, modelLabel, providerName, RADIUS, routeLabel, TOOL_DENSITIES, TOOL_DENSITY_LABELS, type ToolDensity } from '@volt/client-core';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionTone } from '../home/Connection';
import { useClient, useOptionalClient, useRuntime, useStatus } from '../state/client';
import { activate, forget, useEnvironments } from '../state/environments';
import { conversationPrefs, useConversationPrefs } from '../state/prefs';
import { type ThemePreference, useTheme } from '../theme/theme';
import { haptic, Icon, Segmented, T, Tap } from '../ui/core';
import { Group, ListRow } from '../ui/list';
import { ActionSheet, ConfirmSheet, type ISheetAction } from '../ui/sheets';

export default function SettingsScreen() {
	const insets = useSafeAreaInsets();
	return (
		<ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
			<SettingsBody />
		</ScrollView>
	);
}

/** Every setting, for the You tab and the settings screen. */
export function SettingsBody() {
	const { p } = useTheme();
	const client = useOptionalClient();
	const { catalog } = useEnvironments();
	return (
		<>
			<Group title="Computers" footer="Chats run on your computer. Pair as many as you like and switch between them here.">
				{catalog.environments.map(env => (
					<ListRow key={env.environmentId} icon="laptop" label={env.label} detail={env.routes.map(r => routeLabel(r.kind)).join(' · ')}
						checked={env.environmentId === client?.environment.environmentId} onPress={() => void activate(env.environmentId)} />
				))}
				<ListRow icon="plus" iconColor={p.accent} label="Pair another computer" onPress={() => router.push('/connect')} />
			</Group>
			{client ? <Connected /> : null}
			<Appearance />
			<AgentConversations />
			<Group title="About">
				<ListRow icon="bolt" label="Volt" value={`${Constants.expoConfig?.version ?? '0.1.0'} · ${Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'}`} />
			</Group>
		</>
	);
}

/** The desktop's theme gallery: System, then each Volt theme drawn as a little chat. */
function Appearance() {
	const { p, preference, setPreference } = useTheme();
	const options: readonly { readonly id: ThemePreference; readonly label: string; readonly palette?: IVoltPalette }[] = [
		{ id: 'system', label: 'System' },
		...VOLT_THEMES.map(theme => ({ id: theme.id, label: theme.label.replace(/^Volt /, ''), palette: theme.palette })),
	];
	return (
		<Group title="Theme" footer="System follows the phone: Volt Dark at night, Volt Light by day. The same themes as Volt on your computer.">
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12, gap: 10 }}>
				{options.map(option => {
					const on = option.id === preference;
					return (
						<Tap key={option.id} haptics="selection" onPress={() => setPreference(option.id)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={option.label} style={{ width: 104, gap: 6 }}>
							<View style={{ height: 76, borderRadius: 12, overflow: 'hidden', borderWidth: on ? 2 : StyleSheet.hairlineWidth, borderColor: on ? p.accent : p.stroke, flexDirection: 'row' }}>
								{option.palette ? <ThemeSwatch palette={option.palette} /> : <><ThemeSwatch palette={VOLT_THEMES[3]!.palette} /><ThemeSwatch palette={VOLT_THEMES[0]!.palette} /></>}
							</View>
							<View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
								{on ? <Icon name="check" size={13} color={p.accent} strokeWidth={2.4} /> : null}
								<T variant="footnote" weight={on ? '600' : '400'} color={on ? p.fg : p.fgSecondary} numberOfLines={1}>{option.label}</T>
							</View>
						</Tap>
					);
				})}
			</ScrollView>
		</Group>
	);
}

/** A theme in miniature: its canvas, a prompt bubble, reply lines and the accent. */
function ThemeSwatch({ palette }: { readonly palette: IVoltPalette }) {
	return (
		<View style={{ flex: 1, backgroundColor: palette.canvas, padding: 8, gap: 5 }}>
			<View style={{ alignSelf: 'flex-end', width: '60%', height: 12, borderRadius: 4, backgroundColor: palette.bubble, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.bubbleBorder }} />
			<View style={{ width: '85%', height: 4, borderRadius: 2, backgroundColor: palette.fgSecondary }} />
			<View style={{ width: '65%', height: 4, borderRadius: 2, backgroundColor: palette.fgTertiary }} />
			<View style={{ flexDirection: 'row', gap: 4 }}>
				<View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: palette.diffAddedFg }} />
				<View style={{ width: 10, height: 4, borderRadius: 2, backgroundColor: palette.diffRemovedFg }} />
				<View style={{ width: 12, height: 4, borderRadius: 2, backgroundColor: palette.accent }} />
			</View>
		</View>
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
				<ListRow icon="plug" label="MCP servers" detail="Tools your agents can use" chevron onPress={() => router.push('/settings/mcp')} />
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

/** Tool call density, code wrap and diff tints, as on the desktop's Appearance page. */
function AgentConversations() {
	const { p } = useTheme();
	const prefs = useConversationPrefs();
	const toggle = (value: boolean, set: (next: boolean) => void) => (
		<Switch value={value} onValueChange={next => {
			haptic.selection();
			set(next);
		}} trackColor={{ true: p.success, false: p.fillStrong }} />
	);
	return (
		<Group title="Agent conversations" footer="These apply to chats on this phone.">
			<View style={{ padding: 14, gap: 10 }}>
				<View>
					<T variant="body">Tool call density</T>
					<T variant="footnote" color={p.fgTertiary}>Adjust how much detail is shown for tool calls</T>
				</View>
				<Segmented value={prefs.toolDensity} onChange={toolDensity => conversationPrefs.set({ toolDensity })} options={TOOL_DENSITIES.map(id => ({ id, label: TOOL_DENSITY_LABELS[id] }))} />
				<DensityPreview density={prefs.toolDensity} />
			</View>
			<ListRow label="Code block word wrap" detail="Wrap long lines in code blocks" right={toggle(prefs.codeWrap, codeWrap => conversationPrefs.set({ codeWrap }))} />
			<ListRow label="Themed diff backgrounds" detail="Use themed background colors for inline code diffs" right={toggle(prefs.themedDiffs, themedDiffs => conversationPrefs.set({ themedDiffs }))} />
		</Group>
	);
}

/** What a chat shows at each density, drawn small with made-up work. */
function DensityPreview({ density }: { readonly density: ToolDensity }) {
	const { p } = useTheme();
	const frame = { borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, backgroundColor: p.codeBg, padding: 10, gap: 8 };
	const bar = (color: string, short?: boolean) => <View style={{ height: 6, borderRadius: 2, width: short ? '75%' : '100%', backgroundColor: color }} />;
	if (density === 'compact') {
		return <View style={frame}><T variant="small" color={p.fgTertiary}><T variant="small" color={p.fgSecondary}>{DENSITY_PREVIEW_SUMMARY.verb}</T> {DENSITY_PREVIEW_SUMMARY.detail}</T></View>;
	}
	return (
		<View style={frame}>
			{DENSITY_PREVIEW_STEPS.map(step => {
				const line = (
					<T variant="small" color={p.fgTertiary} numberOfLines={1}>
						<T variant="small" color={p.fgSecondary}>{step.verb} {step.name}</T>
						{step.command ? ` ${step.command}` : ''}{step.additions ? ` +${step.additions}` : ''}{step.deletions ? ` -${step.deletions}` : ''}
					</T>
				);
				if (density === 'standard') {
					return <View key={step.name}>{line}</View>;
				}
				return (
					<View key={step.name} style={{ borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
						<View style={{ paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>{line}</View>
						<View style={{ padding: 10, gap: 4 }}>
							{step.kind === 'edit'
								? <>{bar(`${p.diffRemovedFg}70`)}{bar(`${p.diffRemovedFg}70`, true)}{bar(`${p.diffAddedFg}70`)}{bar(`${p.diffAddedFg}70`, true)}</>
								: <>{bar(p.fillStrong)}{bar(p.fillStrong, true)}</>}
						</View>
					</View>
				);
			})}
		</View>
	);
}
