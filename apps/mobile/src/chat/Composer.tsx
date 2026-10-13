/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	ACCESS_MODES, type AccessMode, catalogItem, COMPOSER_MODES, type ComposerMode, type Delivery, type IconName, type IPromptAttachment, modelLabel, selectModelGroups
} from '@volt/client-core';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useAttachment, useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, Icon, Pill, T, Tap } from '../ui/core';
import { ActionSheet, type ISheetAction } from '../ui/sheets';
import { type IComposerImage, imageKey, imageOnlyPrompt, pickImages, uploadImage } from './attachments';

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
	/** `false` keeps the text and images in the composer (the send is decided later, or refused). */
	readonly onSend: (text: string, delivery: Delivery, attachments: readonly IPromptAttachment[]) => boolean | void;
	readonly onStop?: () => void;
	readonly placeholder?: string;
	readonly autoFocus?: boolean;
	readonly disabled?: boolean;
	/** Controls before the model pill (the new chat sheet's project picker). */
	readonly leading?: ReactNode;
	/** Replaces the composer's text and images whenever `key` changes (edit, rewind, clear). */
	readonly prefill?: { readonly key: number; readonly text: string; readonly attachments: readonly IPromptAttachment[] };
	/** Above the box (the "Editing message" banner). */
	readonly banner?: ReactNode;
	/** Images can be attached (default true). */
	readonly allowImages?: boolean;
}

type SheetKind = 'mode' | 'model' | 'access' | 'send' | 'attach' | `option:${string}`;

const MAX_IMAGES = 8;

function accessIcon(mode: AccessMode): IconName {
	return mode === 'supervised' ? 'shieldCheck' : mode === 'full-access' ? 'zap' : 'shield';
}

export function Composer(props: IComposerProps) {
	const { p, mode: modeColors } = useTheme();
	const client = useClient();
	const runtime = useRuntime();
	const [text, setText] = useState('');
	const [images, setImages] = useState<readonly IComposerImage[]>([]);
	const [sheet, setSheet] = useState<SheetKind | undefined>();
	const input = useRef<TextInput>(null);
	const loadedKey = useRef<string | undefined>(undefined);
	const prefillKey = useRef<number | undefined>(props.prefill?.key);

	useEffect(() => {
		const prefill = props.prefill;
		if (!prefill || prefill.key === prefillKey.current) {
			return;
		}
		prefillKey.current = prefill.key;
		setText(prefill.text);
		setImages(prefill.attachments.map(attachment => ({ key: imageKey(), uri: client.getAttachmentUrl(attachment.ref) ?? '', name: attachment.name, state: 'ready', attachment })));
		if (prefill.text || prefill.attachments.length) {
			setTimeout(() => input.current?.focus(), 250);
		}
	}, [props.prefill, client]);

	const updateImage = useCallback((image: IComposerImage) => {
		setImages(list => list.some(i => i.key === image.key) ? list.map(i => i.key === image.key ? image : i) : [...list, image]);
	}, []);

	const attach = async (source: 'library' | 'camera') => {
		const room = MAX_IMAGES - images.length;
		if (room <= 0) {
			client.toast('info', `Up to ${MAX_IMAGES} images per message.`);
			return;
		}
		const picked = await pickImages(source, room);
		for (const image of picked) {
			haptic.light();
			void uploadImage(client, image, imageKey(), updateImage);
		}
	};

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
	const ready = images.filter(i => i.state === 'ready' && i.attachment).map(i => i.attachment!);
	const uploading = images.some(i => i.state === 'uploading');
	const sendable = (!!trimmed || ready.length > 0) && !uploading;
	const send = (delivery: Delivery) => {
		if (props.disabled) {
			return;
		}
		if (uploading) {
			client.toast('info', 'Images are still uploading.');
			return;
		}
		if (!trimmed && !ready.length) {
			return;
		}
		if (props.onSend(trimmed || imageOnlyPrompt(ready.length), delivery, ready) === false) {
			return;
		}
		haptic.light();
		setText('');
		setImages([]);
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
	const showStop = props.running && !sendable && !images.length && !!props.onStop;

	const sendScale = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(sendable || showStop ? 1 : 0.92, { damping: 18, stiffness: 300 }) }] }), [sendable, showStop]);

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
			case 'attach':
				return [
					// The picker opens once the sheet has gone (iOS presents one modal at a time).
					{ label: 'Photo Library', detail: `Up to ${MAX_IMAGES - images.length} images`, icon: 'image', onPress: () => setTimeout(() => void attach('library'), 420) },
					{ label: 'Take Photo', icon: 'camera', onPress: () => setTimeout(() => void attach('camera'), 420) },
				];
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

	const sheetTitle = sheet === 'mode' ? 'Mode' : sheet === 'model' ? 'Model' : sheet === 'access' ? 'Access' : sheet === 'send' ? 'Send while it works' : sheet === 'attach' ? 'Attach images' : options.find(d => sheet === `option:${d.id}`)?.label;

	return (
		<View style={{ paddingHorizontal: 16 }}>
			{props.banner}
			{/* agentEditor.css `.volt-agent-input-box`: 20px radius, a 1px edge, flat. */}
			<View style={{ backgroundColor: p.composer, borderRadius: 20, borderWidth: 1, borderColor: props.mode === 'Agent' ? p.bubbleBorder : `${tint.fg}66` }}>
				{images.length ? (
					<Animated.View entering={FadeIn.duration(160)} layout={LinearTransition.duration(180)}>
						<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 12 }}>
							{images.map(image => <ComposerThumb key={image.key} image={image} onRemove={() => setImages(list => list.filter(i => i.key !== image.key))} />)}
						</ScrollView>
					</Animated.View>
				) : null}
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
					{props.allowImages !== false ? (
						<Tap haptics="selection" onPress={() => setSheet('attach')} hitSlop={6} accessibilityLabel="Attach images" style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: p.fill }}>
							<Icon name="plus" size={17} color={p.fgSecondary} />
						</Tap>
					) : null}
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
								disabled={!sendable || props.disabled}
								onPress={() => send('auto')}
								onLongPress={() => {
									if (sendable && props.running) {
										haptic.medium();
										setSheet('send');
									}
								}}
								accessibilityLabel={props.running ? 'Queue' : 'Send'}
								style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: sendable ? tint.send : p.fill, alignItems: 'center', justifyContent: 'center' }}
							>
								{uploading ? <ActivityIndicator size="small" color={p.fgTertiary} /> : <Icon name={props.running && sendable ? 'queue' : 'arrowUp'} size={18} color={sendable ? tint.onSend : p.fgQuaternary} strokeWidth={2.2} />}
							</Tap>
						)}
					</Animated.View>
				</View>
			</View>
			<ActionSheet visible={!!sheet} onClose={() => setSheet(undefined)} title={sheetTitle} actions={sheet ? sheetActions() : []} />
		</View>
	);
}

/** A picked image in the composer: its thumbnail, an upload spinner or a retry mark, and remove. */
const ComposerThumb = memo(function ComposerThumb({ image, onRemove }: { readonly image: IComposerImage; readonly onRemove: () => void }) {
	const { p } = useTheme();
	const cached = useAttachment(image.uri ? undefined : image.attachment?.ref);
	const uri = image.uri || cached;
	return (
		<Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={{ width: 64, height: 64 }}>
			<View style={{ width: 64, height: 64, borderRadius: 12, overflow: 'hidden', backgroundColor: p.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: image.state === 'failed' ? p.danger : p.stroke }}>
				{uri ? <Image source={{ uri }} style={{ width: 64, height: 64 }} resizeMode="cover" /> : null}
				{image.state !== 'ready' ? (
					<View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }]}>
						{image.state === 'uploading' ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="alertCircle" size={18} color="#fff" />}
					</View>
				) : null}
			</View>
			<Tap haptics="light" onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${image.name}`} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: p.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, alignItems: 'center', justifyContent: 'center' }}>
				<Icon name="close" size={12} color={p.fg} strokeWidth={2.2} />
			</Tap>
			{image.state === 'failed' ? <T variant="caption" color={p.danger} numberOfLines={1} style={{ position: 'absolute', bottom: -16, left: 0, right: 0, textAlign: 'center' }}>Failed</T> : null}
		</Animated.View>
	);
});
