/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	ACCESS_MODES, type AccessMode, catalogItem, COMPOSER_MODES, type ComposerMode, type Delivery, type IconName, modelLabel, selectModelGroups
} from '@volt/client-core';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, Icon, Pill, Tap } from '../ui/core';
import { ActionSheet, type ISheetAction } from '../ui/sheets';

const DRAFT_PREFIX = 'volt.draft.';

export interface IComposerProps {
	readonly draftKey?: string;
	readonly running?: boolean;
	readonly mode: ComposerMode;
	readonly onModeChange: (mode: ComposerMode) => void;
	readonly modelRef: string | undefined;
	readonly onModelChange: (ref: string | undefined) => void;
	readonly accessMode: AccessMode | undefined;
	readonly onAccessChange: (mode: AccessMode) => void;
	readonly onSend: (text: string, delivery: Delivery) => boolean | void;
	readonly onStop?: () => void;
	readonly placeholder?: string;
	readonly autoFocus?: boolean;
	readonly disabled?: boolean;
	/** Controls before the model pill (the new chat sheet's project picker). */
	readonly leading?: ReactNode;
}

type SheetKind = 'mode' | 'model' | 'access' | 'send' | `option:${string}`;

function accessIcon(mode: AccessMode): IconName {
	return mode === 'supervised' ? 'shieldCheck' : mode === 'full-access' ? 'zap' : 'shield';
}

export function Composer(props: IComposerProps) {
	const { p, mode: modeColors } = useTheme();
	const client = useClient();
	const runtime = useRuntime();
	const [text, setText] = useState('');
	const [sheet, setSheet] = useState<SheetKind | undefined>();
	const input = useRef<TextInput>(null);
	const loadedKey = useRef<string | undefined>(undefined);

	useEffect(() => {
		loadedKey.current = undefined;
		if (!props.draftKey) {
			setText('');
			return;
		}
		const key = props.draftKey;
		void AsyncStorage.getItem(DRAFT_PREFIX + key).then(value => {
			loadedKey.current = key;
			setText(value ?? '');
		});
	}, [props.draftKey]);

	useEffect(() => {
		const key = props.draftKey;
		if (!key || loadedKey.current !== key) {
			return;
		}
		const timer = setTimeout(() => void (text ? AsyncStorage.setItem(DRAFT_PREFIX + key, text) : AsyncStorage.removeItem(DRAFT_PREFIX + key)), 300);
		return () => clearTimeout(timer);
	}, [text, props.draftKey]);

	const trimmed = text.trim();
	const send = (delivery: Delivery) => {
		if (!trimmed || props.disabled) {
			return;
		}
		if (props.onSend(trimmed, delivery) === false) {
			return;
		}
		haptic.light();
		setText('');
		if (props.draftKey) {
			void AsyncStorage.removeItem(DRAFT_PREFIX + props.draftKey);
		}
	};

	const tint = modeColors(props.mode);
	const groups = useMemo(() => selectModelGroups(runtime), [runtime]);
	const model = catalogItem(runtime, props.modelRef);
	const options = model?.optionDescriptors?.filter(d => d.type === 'select' && d.options?.length).slice(0, 1) ?? [];
	const current = (props.modelRef && runtime.modelOptions?.[props.modelRef]) || {};
	const access = ACCESS_MODES.find(a => a.id === props.accessMode) ?? ACCESS_MODES[3];
	const showStop = props.running && !trimmed && !!props.onStop;

	const sendScale = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(trimmed || showStop ? 1 : 0.92, { damping: 18, stiffness: 300 }) }] }), [trimmed, showStop]);

	const sheetActions = (): ISheetAction[] => {
		switch (sheet) {
			case 'mode':
				return COMPOSER_MODES.map(m => ({ label: m.id, detail: m.description, checked: m.id === props.mode, dot: m.id === 'Agent' ? p.fgTertiary : modeColors(m.id).fg, onPress: () => props.onModeChange(m.id) }));
			case 'model':
				return [
					{ label: 'Auto', detail: 'Volt picks the model', icon: 'sparkles', checked: !props.modelRef, onPress: () => props.onModelChange(undefined) },
					...groups.flatMap(group => [
						{ label: group.label, header: true },
						...group.models.map(item => ({
							label: item.qualifier ? `${item.label} ${item.qualifier}` : item.label,
							...(item.contextLabel || item.detail ? { detail: item.contextLabel ?? item.detail } : {}),
							checked: item.ref === props.modelRef,
							onPress: () => props.onModelChange(item.ref),
						})),
					]),
				];
			case 'access':
				return ACCESS_MODES.map(a => ({ label: a.label, detail: a.description, icon: accessIcon(a.id), checked: a.id === access.id, onPress: () => props.onAccessChange(a.id) }));
			case 'send':
				return [
					{ label: 'Add to queue', detail: 'Runs after the current turn', icon: 'queue', onPress: () => send('queue') },
					{ label: 'Send now', detail: 'Steers the running agent, or stops it and runs this first', icon: 'zap', onPress: () => send('now') },
				];
			default: {
				const descriptor = options.find(d => sheet === `option:${d.id}`);
				if (!descriptor) {
					return [];
				}
				const value = String(current[descriptor.id] ?? descriptor.options?.find(o => o.isDefault)?.value ?? '');
				return (descriptor.options ?? []).map(o => ({ label: o.label, checked: o.value === value, onPress: () => props.modelRef && void client.setModelOptions(props.modelRef, { ...current, [descriptor.id]: o.value }) }));
			}
		}
	};

	const sheetTitle = sheet === 'mode' ? 'Mode' : sheet === 'model' ? 'Model' : sheet === 'access' ? 'Access' : sheet === 'send' ? 'Send while it works' : options.find(d => sheet === `option:${d.id}`)?.label;

	return (
		<View style={{ paddingHorizontal: 10 }}>
			<View style={{
				backgroundColor: p.composer, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: props.mode === 'Agent' ? p.stroke : `${tint.fg}66`,
				shadowColor: '#000', shadowOpacity: p.scheme === 'dark' ? 0.35 : 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 4,
			}}>
				<TextInput
					ref={input}
					value={text}
					onChangeText={setText}
					multiline
					autoFocus={props.autoFocus}
					editable={!props.disabled}
					placeholder={props.placeholder ?? (props.running ? 'Queue a message, or hold send to steer' : 'Ask Volt to build, fix or explain…')}
					placeholderTextColor={p.fgQuaternary}
					selectionColor={p.accent}
					keyboardAppearance={p.scheme}
					style={{ color: p.fg, fontSize: 16, lineHeight: 22, minHeight: 46, maxHeight: 150, paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 13 : 10, paddingBottom: 6 }}
				/>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 8, paddingTop: 2 }}>
					<Pill label={props.mode} color={props.mode === 'Agent' ? p.fgSecondary : tint.fg} bg={tint.bg} onPress={() => setSheet('mode')} />
					{props.leading}
					<Pill label={modelLabel(runtime, props.modelRef)} icon="cpu" onPress={() => setSheet('model')} maxWidth={props.leading ? 110 : 150} bg="transparent" />
					{options.map(descriptor => {
						const value = String(current[descriptor.id] ?? descriptor.options?.find(o => o.isDefault)?.value ?? '');
						return <Pill key={descriptor.id} label={descriptor.options?.find(o => o.value === value)?.label ?? descriptor.label} onPress={() => setSheet(`option:${descriptor.id}`)} bg="transparent" maxWidth={90} />;
					})}
					<Tap haptics="selection" onPress={() => setSheet('access')} hitSlop={6} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`Access: ${access.label}`}>
						<Icon name={accessIcon(access.id)} size={16} color={access.id === 'full-access' ? p.warning : p.fgTertiary} />
					</Tap>
					<View style={{ flex: 1 }} />
					<Animated.View style={sendScale}>
						{showStop ? (
							<Tap haptics="medium" onPress={props.onStop} accessibilityLabel="Stop" style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: p.fillStrong, alignItems: 'center', justifyContent: 'center' }}>
								<Icon name="stop" size={13} color={p.fg} />
							</Tap>
						) : (
							<Tap
								disabled={!trimmed || props.disabled}
								onPress={() => send('auto')}
								onLongPress={() => {
									if (trimmed && props.running) {
										haptic.medium();
										setSheet('send');
									}
								}}
								accessibilityLabel={props.running ? 'Queue' : 'Send'}
								style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: trimmed ? tint.send : p.fill, alignItems: 'center', justifyContent: 'center' }}
							>
								<Icon name={props.running && trimmed ? 'queue' : 'arrowUp'} size={18} color={trimmed ? tint.onSend : p.fgQuaternary} strokeWidth={2.2} />
							</Tap>
						)}
					</Animated.View>
				</View>
			</View>
			<ActionSheet visible={!!sheet} onClose={() => setSheet(undefined)} title={sheetTitle} actions={sheet ? sheetActions() : []} />
		</View>
	);
}
