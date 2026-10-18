/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { catalogItem, type IModelOptionDescriptor, type IProviderStatus, PROVIDER_COLORS, selectModelGroups } from '@volt/client-core';
import { useMemo, useState } from 'react';
import { StyleSheet, Switch, TextInput, View } from 'react-native';
import { useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, Icon, T, Tap } from '../ui/core';
import { Sheet } from '../ui/sheets';

const STATE_LABEL: Record<IProviderStatus['state'], string> = {
	authenticated: 'Signed in',
	available: 'Ready',
	checking: 'Checking…',
	disabled: 'Off',
	missing: 'Not installed',
};

function providerColor(providerId: string): string {
	const id = providerId.toLowerCase();
	const colors = PROVIDER_COLORS as Record<string, string>;
	const key = Object.keys(colors).find(name => id.includes(name));
	return key ? colors[key] : colors.generic;
}

/**
 * The model picker, as the desktop's: models grouped by provider account with the account's
 * state, a search, and the chosen model's options (reasoning effort, thinking...) below.
 */
export function ModelSheet({ visible, onClose, modelRef, onPick }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly modelRef: string | undefined;
	readonly onPick: (ref: string | undefined) => void;
}) {
	const { p } = useTheme();
	const client = useClient();
	const runtime = useRuntime();
	const [query, setQuery] = useState('');
	const groups = useMemo(() => selectModelGroups(runtime), [runtime]);
	const offline = useMemo(() => (runtime.providerStatuses ?? []).filter(s => s.state === 'missing' || s.state === 'disabled'), [runtime.providerStatuses]);
	const q = query.trim().toLowerCase();
	const model = catalogItem(runtime, modelRef);
	const descriptors = model?.optionDescriptors ?? [];
	const current = (modelRef && runtime.modelOptions?.[modelRef]) || {};

	const setOption = (descriptor: IModelOptionDescriptor, value: string | boolean) => {
		if (!modelRef) {
			return;
		}
		haptic.selection();
		void client.setModelOptions(modelRef, { ...current, [descriptor.id]: value });
	};

	return (
		<Sheet visible={visible} onClose={onClose} title="Model" subtitle={model ? `${model.label}${model.qualifier ? ` ${model.qualifier}` : ''}` : 'Auto: Volt picks the model'}>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, marginHorizontal: 8, marginBottom: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: p.fill }}>
				<Icon name="search" size={15} color={p.fgTertiary} />
				<TextInput value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={p.fgQuaternary} style={{ flex: 1, color: p.fg, fontSize: 15 }} autoCorrect={false} autoCapitalize="none" keyboardAppearance={p.scheme} />
			</View>
			{descriptors.length && !q ? (
				<View style={{ marginHorizontal: 8, marginBottom: 8, padding: 10, gap: 10, borderRadius: 14, backgroundColor: p.fillFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint }}>
					{descriptors.map(descriptor => descriptor.type === 'boolean' ? (
						<View key={descriptor.id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 32 }}>
							<T variant="small" weight="600" color={p.fgSecondary} style={{ flex: 1 }}>{descriptor.label}</T>
							<Switch value={Boolean(current[descriptor.id] ?? descriptor.defaultValue)} onValueChange={value => setOption(descriptor, value)} trackColor={{ true: p.accent, false: p.fillStrong }} />
						</View>
					) : (
						<View key={descriptor.id} style={{ gap: 6 }}>
							<T variant="small" weight="600" color={p.fgSecondary}>{descriptor.label}</T>
							<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
								{(descriptor.options ?? []).map(option => {
									const on = String(current[descriptor.id] ?? descriptor.options?.find(o => o.isDefault)?.value ?? '') === option.value;
									return (
										<Tap key={option.value} onPress={() => setOption(descriptor, option.value)} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: on ? p.primary : p.fill }}>
											<T variant="small" weight="600" color={on ? p.onPrimary : p.fgSecondary}>{option.label}</T>
										</Tap>
									);
								})}
							</View>
						</View>
					))}
				</View>
			) : null}
			{!q ? <Row label="Auto" detail="Volt picks the model" icon checked={!modelRef} onPress={() => {
				onPick(undefined);
				onClose();
			}} /> : null}
			{groups.map(group => {
				const models = group.models.filter(item => !q || `${item.label} ${item.qualifier ?? ''} ${group.label}`.toLowerCase().includes(q));
				if (!models.length) {
					return null;
				}
				return (
					<View key={group.key}>
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 }}>
							<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: providerColor(group.providerId) }} />
							<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, textTransform: 'uppercase', flex: 1 }}>{group.label}</T>
							{group.state ? <T variant="caption" weight="600" color={group.state === 'authenticated' || group.state === 'available' ? p.success : p.fgTertiary}>{STATE_LABEL[group.state]}</T> : null}
						</View>
						{models.map(item => (
							<Row
								key={item.ref}
								label={item.qualifier ? `${item.label} ${item.qualifier}` : item.label}
								detail={item.contextLabel ?? item.detail ?? item.description}
								checked={item.ref === modelRef}
								onPress={() => {
									onPick(item.ref);
									onClose();
								}}
							/>
						))}
					</View>
				);
			})}
			{offline.length && !q ? (
				<View style={{ paddingHorizontal: 12, paddingTop: 14, gap: 4 }}>
					<T variant="caption" weight="700" color={p.fgTertiary} style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}>Not set up</T>
					{offline.map(status => (
						<View key={status.profileId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34 }}>
							<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.fgQuaternary }} />
							<T variant="small" color={p.fgSecondary} style={{ flex: 1 }} numberOfLines={1}>{status.label}</T>
							<T variant="caption" color={p.fgQuaternary}>{STATE_LABEL[status.state]}</T>
						</View>
					))}
					<T variant="footnote" color={p.fgQuaternary}>Sign in to providers in Volt on your computer.</T>
				</View>
			) : null}
		</Sheet>
	);
}

function Row({ label, detail, checked, icon, onPress }: { readonly label: string; readonly detail?: string; readonly checked?: boolean; readonly icon?: boolean; readonly onPress: () => void }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: checked ? p.fill : 'transparent' }}>
			{icon ? <Icon name="sparkles" size={17} color={p.fgSecondary} /> : null}
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="callout" weight={checked ? '600' : '400'} numberOfLines={1}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{detail}</T> : null}
			</View>
			{checked ? <Icon name="check" size={18} color={p.accent} strokeWidth={2.2} /> : null}
		</Tap>
	);
}
