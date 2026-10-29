/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	ACCESS_MODES, type AccessMode, catalogItem, compactNumber, COMPOSER_MODES, type ComposerMode, type Delivery, type IconName, type IMcpServerStatus, type IPromptAttachment, type IPromptMention, modelLabel
} from '@volt/client-core';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { FileIcon } from '../files/FileIcon';
import { useAttachment, useClient, useRuntime } from '../state/client';
import { useTheme } from '../theme/theme';
import { haptic, Icon, Pill, T, Tap } from '../ui/core';
import { ActionSheet, type ISheetAction } from '../ui/sheets';
import Svg, { Circle } from 'react-native-svg';
import { type IComposerImage, imageKey, imageOnlyPrompt, pickImages, uploadImage } from './attachments';
import { fileFacts, fileKey, type IComposerFile, type IComposerMention, isSendableImage, MAX_FILES, pickFiles, promptParts, uploadFile } from './composerFiles';
import { ComposerSuggest, type ISlashItem, type ITrigger, triggerAt } from './ComposerSuggest';
import { useDictation } from './dictation';
import { McpSheet } from './McpSheet';
import { ModelSheet } from './ModelSheet';

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
	/**
	 * `false` keeps the text and images in the composer (the send is decided later, or refused).
	 * `extra`: the files and `/` command as mentions, and the text the transcript shows when the
	 * model's (`text`) differs (`@src/app.ts` reads `app.ts`; attached files add saved-path lines).
	 */
	readonly onSend: (text: string, delivery: Delivery, attachments: readonly IPromptAttachment[], extra?: IComposerSendExtra) => boolean | void;
	/** The chat (its `/` commands) and its folder (`@` files, MCP servers). */
	readonly chatId?: string;
	readonly folder?: string;
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
	/** The chat's context: tokens in use and the model's window (the desktop's context meter). */
	readonly contextUsed?: number;
	readonly contextWindow?: number;
}

export interface IComposerSendExtra {
	readonly mentions: readonly IPromptMention[];
	readonly displayText: string;
}

type SheetKind = 'mode' | 'model' | 'access' | 'send' | 'attach' | 'mcp' | `option:${string}`;

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
	const [files, setFiles] = useState<readonly IComposerFile[]>([]);
	const [mentions, setMentions] = useState<readonly IComposerMention[]>([]);
	const [slash, setSlash] = useState<ISlashItem | undefined>();
	const [cursor, setCursor] = useState(0);
	const [sheet, setSheet] = useState<SheetKind | undefined>();
	const input = useRef<TextInput>(null);
	const dictation = useDictation(heard => {
		setText(heard);
		setCursor(heard.length);
	});
	const trigger: ITrigger | undefined = useMemo(() => dictation.listening ? undefined : triggerAt(text, Math.min(cursor, text.length)), [text, cursor, dictation.listening]);
	const loadedKey = useRef<string | undefined>(undefined);
	const prefillKey = useRef<number | undefined>(props.prefill?.key);

	useEffect(() => {
		const prefill = props.prefill;
		if (!prefill || prefill.key === prefillKey.current) {
			return;
		}
		prefillKey.current = prefill.key;
		setText(prefill.text);
		setFiles([]);
		setMentions([]);
		setSlash(undefined);
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

	const updateFile = useCallback((file: IComposerFile) => {
		setFiles(list => list.some(f => f.key === file.key) ? list.map(f => f.key === file.key ? file : f) : [...list, file]);
	}, []);

	const attachFiles = async () => {
		const room = MAX_FILES - files.length;
		if (room <= 0) {
			client.toast('info', `Up to ${MAX_FILES} files per message.`);
			return;
		}
		const picked = await pickFiles(room, name => client.toast('error', `${name} is too big to send from here (25 MB at most).`)).catch(err => {
			client.toast('error', `Couldn't open the file: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		});
		for (const file of picked) {
			haptic.light();
			if (isSendableImage(file.mime) && images.length < MAX_IMAGES) {
				// An image the model can see goes with the images, as a pasted one does on the desktop.
				void uploadImage(client, { uri: `data:${file.mime};base64,${file.base64}`, base64: file.base64, mime: file.mime, name: file.name }, imageKey(), updateImage);
			} else {
				void uploadFile(client, file, fileKey(), updateFile);
			}
		}
	};

	/** Replaces the `@`/`/` token being typed with `value` (and a space). */
	const replaceTrigger = (t: ITrigger, value: string) => {
		const next = `${text.slice(0, t.start)}${value} ${text.slice(t.end).replace(/^ /, '')}`;
		setText(next);
		setCursor(t.start + value.length + 1);
		setTimeout(() => input.current?.focus(), 30);
	};

	const insertToken = (value: string) => {
		const at = Math.min(cursor, text.length);
		const pad = at > 0 && !/\s$/.test(text.slice(0, at)) ? ' ' : '';
		const next = `${text.slice(0, at)}${pad}${value} ${text.slice(at)}`;
		setText(next);
		setCursor(at + pad.length + value.length + 1);
	};

	const pickFile = (rel: string) => {
		if (!trigger || !props.folder) {
			return;
		}
		const path = `${props.folder.replace(/\/+$/, '')}/${rel}`;
		setMentions(list => list.some(m => m.rel === rel) ? list : [...list, { rel, path }]);
		replaceTrigger(trigger, `@${rel}`);
	};

	const pickSlash = (item: ISlashItem) => {
		if (!trigger) {
			return;
		}
		setSlash(item);
		replaceTrigger(trigger, `/${item.name}`);
	};

	const pickMcp = (server: IMcpServerStatus) => {
		if (trigger?.kind === '@') {
			replaceTrigger(trigger, `@mcp/${server.name}`);
		} else {
			insertToken(`@mcp/${server.name}`);
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
	const readyFiles = files.filter(f => f.state === 'ready' && f.file).map(f => f.file!);
	const uploading = images.some(i => i.state === 'uploading') || files.some(f => f.state === 'uploading');
	const sendable = (!!trimmed || ready.length > 0 || readyFiles.length > 0) && !uploading;
	const send = async (delivery: Delivery) => {
		if (props.disabled) {
			return;
		}
		if (uploading) {
			client.toast('info', 'Attachments are still uploading.');
			return;
		}
		if (!trimmed && !ready.length && !readyFiles.length) {
			return;
		}
		if (dictation.listening) {
			dictation.stop();
		}
		let body = trimmed || (readyFiles.length ? '' : imageOnlyPrompt(ready.length));
		if (body.startsWith('/') && props.folder) {
			// `/skill` and `/command` entries go out as the desktop sends them: a tag, then their instructions.
			const expanded = await client.expandSlash(props.folder, body).catch(() => undefined);
			if (expanded?.used.length) {
				body = expanded.text;
			}
		}
		const parts = promptParts(body, mentions, readyFiles, slash);
		const shown = trimmed || parts.displayText;
		const display = body === trimmed ? parts.displayText : promptParts(shown, mentions, readyFiles, slash).displayText;
		const extra: IComposerSendExtra | undefined = parts.mentions.length || display !== parts.text ? { mentions: parts.mentions, displayText: display } : undefined;
		if (props.onSend(parts.text, delivery, ready, extra) === false) {
			return;
		}
		haptic.light();
		setText('');
		setCursor(0);
		setImages([]);
		setFiles([]);
		setMentions([]);
		setSlash(undefined);
		if (props.draftKey) {
			void AsyncStorage.removeItem(DRAFT_PREFIX + props.draftKey);
		}
	};

	const tint = modeColors(props.mode);
	const model = catalogItem(runtime, props.modelRef);
	const options = model?.optionDescriptors?.filter(d => d.type === 'select' && d.options?.length).slice(0, 1) ?? [];
	const current = (props.modelRef && runtime.modelOptions?.[props.modelRef]) || {};
	const access = ACCESS_MODES.find(a => a.id === props.accessMode) ?? ACCESS_MODES[3];
	const showStop = props.running && !sendable && !images.length && !files.length && !!props.onStop;

	const sendScale = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(sendable || showStop ? 1 : 0.92, { damping: 18, stiffness: 300 }) }] }), [sendable, showStop]);

	const sheetActions = (): ISheetAction[] => {
		switch (sheet) {
			case 'mode':
				return COMPOSER_MODES.map(m => ({ label: m.id, detail: m.description, checked: m.id === props.mode, dot: m.id === 'Agent' ? p.fgTertiary : modeColors(m.id).fg, onPress: () => props.onModeChange(m.id) }));
			case 'access':
				return ACCESS_MODES.map(a => ({ label: a.label, detail: a.description, icon: accessIcon(a.id), checked: a.id === access.id, onPress: () => props.onAccessChange(a.id) }));
			case 'attach':
				return [
					// The picker opens once the sheet has gone (iOS presents one modal at a time).
					{ label: 'Photo Library', detail: `Up to ${MAX_IMAGES - images.length} images`, icon: 'image', onPress: () => setTimeout(() => void attach('library'), 420) },
					{ label: 'Take Photo', icon: 'camera', onPress: () => setTimeout(() => void attach('camera'), 420) },
					{ label: 'Files', detail: 'PDFs, logs, archives… saved on your computer for the agent', icon: 'paperclip', onPress: () => setTimeout(() => void attachFiles(), 420) },
					...(props.folder ? [{ label: 'Mention a file', detail: 'Type @ to pick one from the project', icon: 'file' as const, onPress: () => insertToken('@') }] : []),
					{ label: 'MCP servers', detail: 'Tools your agents can call', icon: 'server', onPress: () => setTimeout(() => setSheet('mcp'), 420) },
					...(props.chatId ? [{ label: 'Commands', detail: 'Type / at the start of the message', icon: 'terminal' as const, onPress: () => {
						if (!text.startsWith('/')) {
							setText(`/${text}`);
							setCursor(1);
						}
						setTimeout(() => input.current?.focus(), 380);
					} }] : []),
				];
			case 'send':
				return [
					{ label: 'Add to queue', detail: 'Runs after the current turn', icon: 'queue', onPress: () => void send('queue') },
					{ label: 'Send now', detail: 'Steers the running agent, or stops it and runs this first', icon: 'zap', onPress: () => void send('now') },
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

	const sheetTitle = sheet === 'mode' ? 'Mode' : sheet === 'access' ? 'Access' : sheet === 'send' ? 'Send while it works' : sheet === 'attach' ? 'Add to the message' : options.find(d => sheet === `option:${d.id}`)?.label;
	const actionSheet = sheet && sheet !== 'model' && sheet !== 'mcp' ? sheet : undefined;

	return (
		<View style={{ paddingHorizontal: 14 }}>
			{props.banner}
			{trigger && (trigger.kind === '/' ? !!props.chatId : true) ? (
				<ComposerSuggest trigger={trigger} client={client} chatId={props.chatId} folder={props.folder} onPickFile={pickFile} onPickSlash={pickSlash} onPickMcp={pickMcp} />
			) : null}
			{/* agentEditor.css `.volt-agent-input-box`: 20px radius, a 1px edge, flat. */}
			<View style={{ backgroundColor: p.composer, borderRadius: 20, borderWidth: 1, borderColor: props.mode === 'Agent' ? p.bubbleBorder : `${tint.fg}66` }}>
				{images.length ? (
					<Animated.View entering={FadeIn.duration(160)} layout={LinearTransition.duration(180)}>
						<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 12 }}>
							{images.map(image => <ComposerThumb key={image.key} image={image} onRemove={() => setImages(list => list.filter(i => i.key !== image.key))} />)}
						</ScrollView>
					</Animated.View>
				) : null}
				{files.length ? (
					<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 12 }}>
						{files.map(file => <ComposerFileChip key={file.key} file={file} onRemove={() => setFiles(list => list.filter(f => f.key !== file.key))} />)}
					</ScrollView>
				) : null}
				<TextInput
					ref={input}
					value={text}
					onChangeText={value => {
						setText(value);
						// Selection events lag (and a browser sends none): typing moves the cursor to the end
						// until the next selection event says otherwise.
						setCursor(value.length);
						if (slash && !value.startsWith(`/${slash.name}`)) {
							setSlash(undefined);
						}
					}}
					onSelectionChange={e => setCursor(e.nativeEvent.selection.end)}
					multiline
					autoFocus={props.autoFocus}
					editable={!props.disabled}
					placeholder={dictation.listening ? 'Listening…' : props.placeholder ?? (props.running ? 'Queue a message, or hold send to steer' : 'Plan, build, / for commands, @ for context')}
					placeholderTextColor={p.fgQuaternary}
					selectionColor={p.accent}
					keyboardAppearance={p.scheme}
					style={{ color: p.fg, fontSize: 15, lineHeight: 22, minHeight: 44, maxHeight: 160, paddingHorizontal: 14, paddingTop: Platform.OS === 'ios' ? 12 : 9, paddingBottom: 4 }}
				/>
				<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 8, paddingTop: 2 }}>
					{props.allowImages !== false ? (
						<Tap haptics="selection" onPress={() => setSheet('attach')} hitSlop={6} accessibilityLabel="Add files, images, MCP servers or commands" style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: p.fill }}>
							<Icon name="plus" size={17} color={p.fgSecondary} />
						</Tap>
					) : null}
					{/* The chips scroll sideways when the phone is too narrow for all of them. */}
					<ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', gap: 6, paddingRight: 4 }}>
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
					</ScrollView>
					{props.contextUsed && props.contextWindow ? <ContextRing used={props.contextUsed} size={props.contextWindow} /> : null}
					{dictation.available ? <MicButton listening={dictation.listening} onPress={() => dictation.listening ? dictation.stop() : void dictation.start(text)} /> : null}
					<Animated.View style={sendScale}>
						{showStop ? (
							// agentEditor.css `.volt-agent-send.stop`: the near-white circle with a dark square.
							<Tap haptics="medium" hitSlop={8} onPress={props.onStop} accessibilityLabel="Stop" style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' }}>
								<View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: p.onPrimary }} />
							</Tap>
						) : (
							<Tap
								disabled={!sendable || props.disabled}
								onPress={() => void send('auto')}
								onLongPress={() => {
									if (sendable && props.running) {
										haptic.medium();
										setSheet('send');
									}
								}}
								accessibilityLabel={props.running ? 'Queue' : 'Send'}
								hitSlop={8}
								style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: sendable ? tint.send : p.fill, alignItems: 'center', justifyContent: 'center' }}
							>
								{uploading ? <ActivityIndicator size="small" color={p.fgTertiary} /> : <Icon name={props.running && sendable ? 'queue' : 'arrowUp'} size={16} color={sendable ? tint.onSend : p.fgQuaternary} strokeWidth={2.4} />}
							</Tap>
						)}
					</Animated.View>
				</View>
			</View>
			<ActionSheet visible={!!actionSheet} onClose={() => setSheet(undefined)} title={sheetTitle} actions={actionSheet ? sheetActions() : []} />
			<ModelSheet visible={sheet === 'model'} onClose={() => setSheet(undefined)} modelRef={props.modelRef} onPick={props.onModelChange} />
			<McpSheet visible={sheet === 'mcp'} onClose={() => setSheet(undefined)} folder={props.folder} onMention={pickMcp} />
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

/**
 * How full the chat's context is (agentEditor.css `.volt-agent-context-meter`): a ring that fills
 * as the context does, amber past 80% and red past 95%; tap for the numbers.
 */
function ContextRing({ used, size }: { readonly used: number; readonly size: number }) {
	const { p } = useTheme();
	const client = useClient();
	const share = Math.min(1, used / size);
	const r = 6.5;
	const c = 2 * Math.PI * r;
	const color = share > 0.95 ? p.danger : share > 0.8 ? p.warning : p.fgTertiary;
	return (
		<Tap hitSlop={8} haptics="selection" onPress={() => client.toast('info', `Context: ${compactNumber(used)} of ${compactNumber(size)} tokens (${Math.round(share * 100)}%)`)} accessibilityLabel={`Context ${Math.round(share * 100)} percent full`} style={{ width: 26, height: 30, alignItems: 'center', justifyContent: 'center' }}>
			<Svg width={16} height={16} viewBox="0 0 16 16">
				<Circle cx={8} cy={8} r={r} stroke={p.fillStrong} strokeWidth={2} fill="none" />
				<Circle cx={8} cy={8} r={r} stroke={color} strokeWidth={2} fill="none" strokeDasharray={`${c * share} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
			</Svg>
		</Tap>
	);
}

/** The mic: dictates into the box; red and pulsing while it listens (tap again to stop). */
function MicButton({ listening, onPress }: { readonly listening: boolean; readonly onPress: () => void }) {
	const { p } = useTheme();
	const pulse = useSharedValue(1);
	useEffect(() => {
		pulse.value = listening ? withRepeat(withSequence(withTiming(1.12, { duration: 520 }), withTiming(1, { duration: 520 })), -1) : withTiming(1, { duration: 120 });
	}, [listening, pulse]);
	const style = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
	return (
		<Animated.View style={style}>
			<Tap haptics="medium" onPress={onPress} hitSlop={4} accessibilityLabel={listening ? 'Stop dictation' : 'Dictate'} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? p.danger : 'transparent' }}>
				<Icon name={listening ? 'stop' : 'mic'} size={listening ? 13 : 19} color={listening ? '#fff' : p.fgSecondary} />
			</Tap>
		</Animated.View>
	);
}

/** A file from the device in the composer: its icon, name, type and size, upload state, remove. */
const ComposerFileChip = memo(function ComposerFileChip({ file, onRemove }: { readonly file: IComposerFile; readonly onRemove: () => void }) {
	const { p } = useTheme();
	return (
		<Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, maxWidth: 230, paddingLeft: 10, paddingRight: 30, borderRadius: 12, backgroundColor: p.fill, borderWidth: StyleSheet.hairlineWidth, borderColor: file.state === 'failed' ? p.danger : p.stroke }}>
			{file.state === 'uploading' ? <ActivityIndicator size="small" color={p.fgTertiary} /> : file.state === 'failed' ? <Icon name="alertCircle" size={18} color={p.danger} /> : <FileIcon path={file.name} size={20} />}
			<View style={{ flexShrink: 1 }}>
				<T variant="small" weight="600" numberOfLines={1}>{file.name}</T>
				<T variant="caption" color={file.state === 'failed' ? p.danger : p.fgTertiary} numberOfLines={1}>{file.state === 'failed' ? file.error ?? 'Failed' : fileFacts(file)}</T>
			</View>
			<Tap haptics="light" onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${file.name}`} style={{ position: 'absolute', top: 12, right: 6, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
				<Icon name="close" size={12} color={p.fgSecondary} strokeWidth={2.2} />
			</Tap>
		</Animated.View>
	);
});
