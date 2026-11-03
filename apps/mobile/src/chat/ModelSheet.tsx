/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type ICatalogItem, type IModelGroup, type IModelOptionDescriptor, modelLabel, RUN_GROUP_MAX_MODELS, RUN_GROUP_MIN_MODELS, selectModelGroups, toggleRunModel } from '@volt/client-core';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { ProviderIcon } from '../ui/BrandIcon';
import { Button, haptic, Icon, IconButton, Ripple, Switch, T, Tap } from '../ui/core';
import { ListItem, SectionHeader } from '../ui/list';
import { SearchField } from '../ui/SearchField';
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
 * open its options (effort, fast, context) in their own popup over the picker.
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
	const editingItem = editing ? groups.flatMap(group => group.models).find(item => item.ref === editing) : undefined;
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
			<SearchField value={query} onChange={setQuery} placeholder="Search models" inset={8} bleed={12} />
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
								onEdit={editable ? () => setEditing(item.ref) : undefined}
								editing={editing === item.ref}
								onPress={() => pick(item.ref)}
							/>
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
							}} accessibilityLabel="Compare models" />
						</View>
					</>
				) : null}
			</View>
			{/* Inside the sheet's own modal, so it opens over the picker rather than behind it. */}
			<ModelOptionsPopup
				item={editingItem}
				options={editingItem ? optionsOf(editingItem.ref) : {}}
				onChange={(descriptor, value) => editingItem && setOption(editingItem.ref, descriptor, value)}
				onClose={() => setEditing(undefined)}
			/>
		</Sheet>
	);
}

/** One provider tab: its mark, with a short bar under it while selected. */
function ProviderTab({ label, active, onPress, children }: { readonly label: string; readonly active: boolean; readonly onPress: () => void; readonly children: ReactNode }) {
	const { p } = useTheme();
	return (
		<Ripple centered haptics="selection" onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}
			style={{ width: 52, height: 46, alignItems: 'center', justifyContent: 'center' }}>
			{children}
			<View style={{ position: 'absolute', bottom: 4, width: 18, height: 2, borderRadius: 1, backgroundColor: active ? p.fgTertiary : 'transparent' }} />
		</Ripple>
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
		<Ripple haptics="selection" onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: !!checked }} accessibilityLabel={label}
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
				<Ripple centered onPress={onEdit} accessibilityRole="button" accessibilityLabel="Model options" hitSlop={6} style={styles.trailing}>
					<Icon name="settings" size={18} color={editing ? p.fg : p.fgTertiary} />
				</Ripple>
			) : null}
			{checked && !multi ? <View style={styles.trailing}><Icon name="check" size={20} color={p.fg} /></View> : null}
			{onStar ? (
				<Ripple centered onPress={onStar} accessibilityRole="button" accessibilityLabel={starred ? 'Remove from favorites' : 'Add to favorites'} hitSlop={6} style={styles.trailing}>
					<Icon name={starred ? 'starFilled' : 'star'} size={19} color={starred ? p.warning : p.fgQuaternary} />
				</Ripple>
			) : <View style={styles.trailing} />}
		</Ripple>
	);
}

/**
 * The chosen model's options in a sheet of its own floating over the picker, rounded all round:
 * each choice (context, effort) as a list of rows with a radio, Fast as a switch row. A pick applies
 * at once; tap outside, swipe the grabber's area or the close button to go back.
 */
function ModelOptionsPopup({ item, options, onChange, onClose }: {
	readonly item: ICatalogItem | undefined;
	readonly options: ModelOptions;
	readonly onChange: (descriptor: IModelOptionDescriptor, value: string | boolean) => void;
	readonly onClose: () => void;
}) {
	const { p } = useTheme();
	const insets = useSafeAreaInsets();
	const { width, height } = useWindowDimensions();
	// Keeps the last model while the sheet slides away.
	const shown = useRef(item);
	if (item) {
		shown.current = item;
	}
	const model = shown.current;
	return (
		<Modal visible={!!item} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
			{item && model ? (
				<View style={{ flex: 1, justifyContent: 'flex-end' }}>
					<Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(160)} style={[StyleSheet.absoluteFill, { backgroundColor: p.overlay }]}>
						<Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
					</Animated.View>
					<Animated.View entering={SlideInDown.springify().damping(22).stiffness(240).mass(0.8)} exiting={SlideOutDown.duration(200)}
						style={[styles.floating, { width: Math.min(width - 16, 560), backgroundColor: p.raised, borderColor: p.stroke, marginBottom: Math.max(insets.bottom, 10), maxHeight: height * 0.78 }]}>
						<View style={{ alignItems: 'center', paddingTop: 8 }}>
							<View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: p.fillStrong }} />
						</View>
						<View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, paddingTop: 6, paddingBottom: 2 }}>
							<View style={{ flex: 1, minWidth: 0 }}>
								<T variant="title3" weight="600" numberOfLines={1}>{rowLabel(model, options)}</T>
								<T variant="footnote" color={p.fgTertiary}>Model options</T>
							</View>
							<IconButton icon="close" size={18} label="Close" color={p.fgSecondary} onPress={onClose} />
						</View>
						<ScrollView bounces={false} contentContainerStyle={{ paddingBottom: 14 }}>
							{(model.optionDescriptors ?? []).map(descriptor => descriptor.type === 'boolean' ? (
								<View key={descriptor.id} style={{ marginTop: 10 }}>
									<ListItem onPress={() => onChange(descriptor, !optionValue(descriptor, options))} accessibilityLabel={descriptor.label} style={styles.optionRow}>
										<T variant="body" style={{ flex: 1, fontSize: 15 }}>{descriptor.label}</T>
										<Switch value={Boolean(optionValue(descriptor, options))} onValueChange={value => onChange(descriptor, value)} accessibilityLabel={descriptor.label} />
									</ListItem>
								</View>
							) : (
								<View key={descriptor.id} style={{ marginTop: 10 }}>
									<SectionHeader title={descriptor.label} />
									{(descriptor.options ?? []).map(option => {
										const on = String(optionValue(descriptor, options) ?? '') === option.value;
										return (
											<ListItem key={option.value} onPress={() => !on && onChange(descriptor, option.value)} accessibilityLabel={`${descriptor.label}: ${option.label}`} style={styles.optionRow}>
												<T variant="body" weight={on ? '600' : '400'} color={on ? p.fg : p.fgSecondary} style={{ flex: 1, fontSize: 15 }}>{option.label}</T>
												<Radio on={on} />
											</ListItem>
										);
									})}
								</View>
							))}
						</ScrollView>
					</Animated.View>
				</View>
			) : null}
		</Modal>
	);
}

/** A radio: a ring, filled with a dot that springs in when picked. */
function Radio({ on }: { readonly on: boolean }) {
	const { p } = useTheme();
	const fill = useSharedValue(on ? 1 : 0);
	useEffect(() => {
		fill.value = withSpring(on ? 1 : 0, { damping: 16, stiffness: 320, mass: 0.6 });
	}, [on, fill]);
	const dot = useAnimatedStyle(() => ({ transform: [{ scale: fill.value }], opacity: fill.value }));
	return (
		<View accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.radio, { borderColor: on ? p.fg : p.fgQuaternary }]}>
			<Animated.View style={[styles.radioDot, { backgroundColor: p.fg }, dot]} />
		</View>
	);
}

const styles = StyleSheet.create({
	rule: { height: StyleSheet.hairlineWidth, marginHorizontal: -12 },
	trailing: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
	raised: { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
	floating: { alignSelf: 'center', borderRadius: 30, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 30, shadowOffset: { width: 0, height: 10 }, elevation: 14 },
	optionRow: { minHeight: 48, paddingHorizontal: 20 },
	radio: { width: 21, height: 21, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
	radioDot: { width: 11, height: 11, borderRadius: 6 },
});
