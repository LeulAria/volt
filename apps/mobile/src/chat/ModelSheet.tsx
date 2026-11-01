/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type ICatalogItem, type IModelGroup, type IModelOptionDescriptor, modelLabel, RUN_GROUP_MAX_MODELS, RUN_GROUP_MIN_MODELS, selectModelGroups, toggleRunModel } from '@volt/client-core';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { ProviderIcon } from '../ui/BrandIcon';
import { Button, haptic, Icon, T, Tap } from '../ui/core';
import { Sheet } from '../ui/sheets';

const FAVORITES = 'favorites';
/** The desktop's key (agentModelPickerModel.ts), kept on this phone. */
const FAVORITES_KEY = 'volt.agent.modelFavorites';
/** Provider tabs lead with these, as on the desktop; the rest follow in catalog order. */
const PROVIDER_ORDER = [/claude|anthropic/, /codex|openai/, /cursor/, /antigravity|gemini/];
const OPTION_REASONING = 'reasoning';
const OPTION_FAST = 'fastMode';

type ModelOptions = Readonly<Record<string, string | boolean>>;

function rank(group: IModelGroup): number {
	const index = PROVIDER_ORDER.findIndex(pattern => pattern.test(group.providerId.toLowerCase()));
	return index === -1 ? PROVIDER_ORDER.length : index;
}

function optionValue(descriptor: IModelOptionDescriptor, options: ModelOptions): string | boolean | undefined {
	return options[descriptor.id] ?? (descriptor.type === 'boolean' ? descriptor.defaultValue : descriptor.options?.find(o => o.isDefault)?.value);
}

/** The desktop's row name: the model, then its effort and Fast when on ("Opus 5.5 High Fast"). */
function rowLabel(item: ICatalogItem, options: ModelOptions): string {
	const parts = [item.label];
	const reasoning = item.optionDescriptors?.find(d => d.id === OPTION_REASONING);
	const effort = reasoning && reasoning.options?.find(o => o.value === optionValue(reasoning, options))?.label;
	if (effort) {
		parts.push(effort);
	}
	const fast = item.optionDescriptors?.find(d => d.id === OPTION_FAST);
	if (fast && optionValue(fast, options) === true) {
		parts.push('Fast');
	}
	return parts.join(' ');
}

let favoritesCache: readonly string[] | undefined;

function useFavorites(): readonly [ReadonlySet<string>, (ref: string) => void] {
	const [refs, setRefs] = useState<readonly string[]>(favoritesCache ?? []);
	useEffect(() => {
		if (favoritesCache) {
			return;
		}
		void AsyncStorage.getItem(FAVORITES_KEY).then(raw => {
			try {
				const parsed = raw ? JSON.parse(raw) as unknown : [];
				favoritesCache = Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
			} catch {
				favoritesCache = [];
			}
			setRefs(favoritesCache);
		});
	}, []);
	const toggle = (ref: string) => {
		haptic.selection();
		setRefs(prev => {
			const next = prev.includes(ref) ? prev.filter(r => r !== ref) : [...prev, ref];
			favoritesCache = next;
			void AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
			return next;
		});
	};
	return [useMemo(() => new Set(refs), [refs]), toggle] as const;
}

/**
 * The model picker, as the desktop's: a search, a tab per provider (Favorites first, a gear to
 * Settings at the end), then that provider's models as plain rows named with their effort and
 * Fast, a check on the chosen one and a star to keep it in Favorites. The chosen model's sliders
 * open its options (effort, fast, context) under its row.
 *
 * With `onMultiChange` (a new chat), "Compare models" turns it into the desktop's multi mode: tick
 * 2-4 models and the prompt runs on each in its own worktree and chat.
 */
export function ModelSheet({ visible, onClose, modelRef, onPick, multi, onMultiChange }: {
	readonly visible: boolean;
	readonly onClose: () => void;
	readonly modelRef: string | undefined;
	readonly onPick: (ref: string | undefined) => void;
	/** The models ticked for a comparison; undefined while comparing is off. */
	readonly multi?: readonly string[];
	readonly onMultiChange?: (refs: readonly string[] | undefined) => void;
}) {
	const { p } = useTheme();
	const client = useClient();
	const runtime = useRuntime();
	const [query, setQuery] = useState('');
	const [favorites, toggleFavorite] = useFavorites();
	const groups = useMemo(() => [...selectModelGroups(runtime)].sort((a, b) => rank(a) - rank(b)), [runtime]);
	const homeTab = useMemo(() => groups.find(group => group.models.some(item => item.ref === modelRef))?.key ?? FAVORITES, [groups, modelRef]);
	const [tab, setTab] = useState(homeTab);
	const [editing, setEditing] = useState<string | undefined>();
	useEffect(() => {
		if (visible) {
			setTab(homeTab);
		} else {
			setQuery('');
			setEditing(undefined);
		}
		// Opening lands on the chosen model's provider; switching models while open keeps the tab.
	}, [visible]);

	const q = query.trim().toLowerCase();
	const comparing = !!multi && !!onMultiChange;
	const providerOf = useMemo(() => new Map(groups.flatMap(group => group.models.map(item => [item.ref, group.label] as const))), [groups]);
	const rows = useMemo(() => {
		if (q) {
			return groups.flatMap(group => group.models.filter(item => `${item.label} ${item.qualifier ?? ''} ${item.description ?? ''} ${group.label}`.toLowerCase().includes(q)));
		}
		if (tab === FAVORITES) {
			return groups.flatMap(group => group.models.filter(item => favorites.has(item.ref)));
		}
		const models = groups.find(group => group.key === tab)?.models ?? [];
		return [...models.filter(item => favorites.has(item.ref)), ...models.filter(item => !favorites.has(item.ref))];
	}, [groups, tab, q, favorites]);

	const optionsOf = (ref: string): ModelOptions => runtime.modelOptions?.[ref] ?? {};
	const setOption = (ref: string, descriptor: IModelOptionDescriptor, value: string | boolean) => {
		haptic.selection();
		void client.setModelOptions(ref, { ...optionsOf(ref), [descriptor.id]: value });
	};
	const pick = (ref: string | undefined) => {
		if (comparing && ref) {
			onMultiChange(toggleRunModel(multi, ref));
			return;
		}
		onPick(ref);
		onClose();
	};

	const header = (
		<View>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 8 }}>
				<Icon name="search" size={18} color={p.fgTertiary} />
				<TextInput value={query} onChangeText={setQuery} placeholder="Search models..." placeholderTextColor={p.fgQuaternary} style={{ flex: 1, color: p.fg, fontSize: 16 }} autoCorrect={false} autoCapitalize="none" keyboardAppearance={p.scheme} clearButtonMode="while-editing" returnKeyType="search" />
			</View>
			<View style={[styles.rule, { backgroundColor: p.strokeFaint }]} />
			<View style={{ flexDirection: 'row', alignItems: 'center', height: 46 }}>
				<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ alignItems: 'center' }} style={{ flex: 1 }}>
					<ProviderTab label="Favorites" active={!q && tab === FAVORITES} onPress={() => setTab(FAVORITES)}>
						<Icon name="star" size={20} color={!q && tab === FAVORITES ? p.fg : p.fgTertiary} />
					</ProviderTab>
					{groups.map(group => (
						<ProviderTab key={group.key} label={group.label} active={!q && tab === group.key} onPress={() => setTab(group.key)}>
							<ProviderIcon providerId={group.providerId} size={20} color={!q && tab === group.key ? p.fg : p.fgTertiary} />
						</ProviderTab>
					))}
				</ScrollView>
				<Tap haptics="selection" onPress={() => {
					onClose();
					router.push('/settings/models');
				}} accessibilityRole="button" accessibilityLabel="Model settings" hitSlop={6} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
					<Icon name="gear" size={20} color={p.fgTertiary} />
				</Tap>
			</View>
			<View style={[styles.rule, { backgroundColor: p.strokeFaint }]} />
		</View>
	);

	const footer = comparing ? (
		<Button
			variant="primary"
			icon="layers"
			label={multi.length >= RUN_GROUP_MIN_MODELS ? `Compare ${multi.length} models` : `Pick ${RUN_GROUP_MIN_MODELS - multi.length} more`}
			disabled={multi.length < RUN_GROUP_MIN_MODELS}
			onPress={onClose}
		/>
	) : undefined;

	return (
		<Sheet
			visible={visible}
			onClose={onClose}
			title={comparing ? 'Compare models' : undefined}
			subtitle={comparing ? (multi.length ? `${multi.length} of ${RUN_GROUP_MAX_MODELS}: ${multi.map(ref => modelLabel(runtime, ref)).join(', ')}` : `Pick ${RUN_GROUP_MIN_MODELS} to ${RUN_GROUP_MAX_MODELS} models`) : undefined}
			header={header}
			footer={footer}
		>
			<View style={{ paddingTop: 4 }}>
				{!q && tab === FAVORITES && !comparing ? (
					<ModelRow label="Auto" detail="Volt picks the model for each turn" checked={!modelRef} onPress={() => pick(undefined)} />
				) : null}
				{rows.map(item => {
					const checked = comparing ? multi.includes(item.ref) : item.ref === modelRef;
					const editable = !comparing && checked && !!item.optionDescriptors?.length;
					return (
						<View key={item.ref}>
							<ModelRow
								label={rowLabel(item, optionsOf(item.ref))}
								detail={q || tab === FAVORITES ? providerOf.get(item.ref) : undefined}
								checked={checked}
								multi={comparing}
								disabled={comparing && !checked && multi.length >= RUN_GROUP_MAX_MODELS}
								starred={favorites.has(item.ref)}
								onStar={() => toggleFavorite(item.ref)}
								onEdit={editable ? () => {
									haptic.selection();
									setEditing(open => open === item.ref ? undefined : item.ref);
								} : undefined}
								editing={editing === item.ref}
								onPress={() => pick(item.ref)}
							/>
							{editable && editing === item.ref ? (
								<ModelOptionsPanel descriptors={item.optionDescriptors!} options={optionsOf(item.ref)} onChange={(descriptor, value) => setOption(item.ref, descriptor, value)} />
							) : null}
						</View>
					);
				})}
				{!rows.length && !(tab === FAVORITES && !q && !comparing) ? (
					<T variant="small" color={p.fgTertiary} align="center" style={{ paddingVertical: 28 }}>{q ? `No models match "${query.trim()}"` : tab === FAVORITES ? 'No starred models.' : 'No models.'}</T>
				) : null}
				{!rows.length && tab === FAVORITES && !q && !comparing ? (
					<T variant="footnote" color={p.fgQuaternary} style={{ paddingHorizontal: 8, paddingTop: 10 }}>Star a model to keep it here.</T>
				) : null}
				{onMultiChange && !q ? (
					<>
						<View style={[styles.rule, { backgroundColor: p.strokeFaint, marginTop: 8 }]} />
						<View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 8 }}>
							<Icon name="layers" size={18} color={comparing ? p.accent : p.fgSecondary} />
							<View style={{ flex: 1 }}>
								<T variant="callout">Compare models</T>
								<T variant="footnote" color={p.fgTertiary}>Each model runs in its own worktree and chat.</T>
							</View>
							<Switch value={comparing} onValueChange={on => {
								haptic.selection();
								// Comparing starts from the model already chosen, as the desktop's picker does.
								onMultiChange(on ? (modelRef ? [modelRef] : []) : undefined);
							}} trackColor={{ true: p.accent, false: p.fillStrong }} accessibilityLabel="Compare models" />
						</View>
					</>
				) : null}
			</View>
		</Sheet>
	);
}

/** One provider tab: its mark, with a short bar under it while selected. */
function ProviderTab({ label, active, onPress, children }: { readonly label: string; readonly active: boolean; readonly onPress: () => void; readonly children: ReactNode }) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}
			style={{ width: 52, height: 46, alignItems: 'center', justifyContent: 'center' }}>
			{children}
			<View style={{ position: 'absolute', bottom: 4, width: 18, height: 2, borderRadius: 1, backgroundColor: active ? p.fgTertiary : 'transparent' }} />
		</Tap>
	);
}

function ModelRow({ label, detail, checked, multi, disabled, starred, onStar, onEdit, editing, onPress }: {
	readonly label: string;
	readonly detail?: string;
	readonly checked?: boolean;
	readonly multi?: boolean;
	readonly disabled?: boolean;
	readonly starred?: boolean;
	readonly onStar?: () => void;
	readonly onEdit?: () => void;
	readonly editing?: boolean;
	readonly onPress: () => void;
}) {
	const { p } = useTheme();
	return (
		<Tap haptics="selection" onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: !!checked }} accessibilityLabel={label}
			style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 50, paddingLeft: 8, opacity: disabled ? 0.45 : 1 }}>
			{multi ? (
				<View style={{ width: 20, height: 20, borderRadius: 6, marginRight: 6, alignItems: 'center', justifyContent: 'center', borderWidth: checked ? 0 : 1.5, borderColor: p.fgQuaternary, backgroundColor: checked ? p.accent : 'transparent' }}>
					{checked ? <Icon name="check" size={13} color="#fff" strokeWidth={2.6} /> : null}
				</View>
			) : null}
			<View style={{ flex: 1, minWidth: 0, paddingVertical: 6 }}>
				<T variant="callout" numberOfLines={1}>{label}</T>
				{detail ? <T variant="footnote" color={p.fgTertiary} numberOfLines={1}>{detail}</T> : null}
			</View>
			{onEdit ? (
				<Tap onPress={onEdit} accessibilityRole="button" accessibilityLabel="Model options" hitSlop={6} style={styles.trailing}>
					<Icon name="settings" size={18} color={editing ? p.fg : p.fgTertiary} />
				</Tap>
			) : null}
			{checked && !multi ? <View style={styles.trailing}><Icon name="check" size={20} color={p.fg} /></View> : null}
			{onStar ? (
				<Tap onPress={onStar} accessibilityRole="button" accessibilityLabel={starred ? 'Remove from favorites' : 'Add to favorites'} hitSlop={6} style={styles.trailing}>
					<Icon name={starred ? 'starFilled' : 'star'} size={19} color={starred ? p.warning : p.fgQuaternary} />
				</Tap>
			) : <View style={styles.trailing} />}
		</Tap>
	);
}

/** The chosen model's options under its row: effort and context as tracks, Fast as a switch. */
function ModelOptionsPanel({ descriptors, options, onChange }: { readonly descriptors: readonly IModelOptionDescriptor[]; readonly options: ModelOptions; readonly onChange: (descriptor: IModelOptionDescriptor, value: string | boolean) => void }) {
	const { p } = useTheme();
	return (
		<View style={{ marginHorizontal: 8, marginBottom: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: p.strokeFaint, overflow: 'hidden' }}>
			{descriptors.map((descriptor, i) => (
				<View key={descriptor.id} style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: p.strokeFaint }}>
					{descriptor.type === 'boolean' ? (
						<View style={{ flexDirection: 'row', alignItems: 'center' }}>
							<T variant="callout" style={{ flex: 1 }}>{descriptor.label}</T>
							<Switch value={Boolean(optionValue(descriptor, options))} onValueChange={value => onChange(descriptor, value)} trackColor={{ true: p.accent, false: p.fillStrong }} accessibilityLabel={descriptor.label} />
						</View>
					) : (
						<>
							<T variant="footnote" weight="600" color={p.fgTertiary}>{descriptor.label}</T>
							<Choice value={String(optionValue(descriptor, options) ?? '')} options={descriptor.options ?? []} onChange={value => onChange(descriptor, value)} />
						</>
					)}
				</View>
			))}
		</View>
	);
}

/** A model option's values on one track, the picked one raised (Context: 200K | 1M). */
function Choice({ value, options, onChange }: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly onChange: (value: string) => void }) {
	const { p } = useTheme();
	return (
		<View style={{ flexDirection: 'row', padding: 3, gap: 3, borderRadius: 11, backgroundColor: p.fill }}>
			{options.map(option => {
				const on = option.value === value;
				return (
					<Tap key={option.value} onPress={() => onChange(option.value)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={option.label}
						style={{ flex: 1, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, backgroundColor: on ? p.raised : 'transparent', ...(on ? styles.raised : {}) }}>
						<T variant="small" weight={on ? '600' : '500'} color={on ? p.fg : p.fgTertiary} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{option.label}</T>
					</Tap>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	rule: { height: StyleSheet.hairlineWidth, marginHorizontal: -12 },
	trailing: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
	raised: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
});
