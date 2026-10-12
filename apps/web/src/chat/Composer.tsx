/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ACCESS_MODES, type AccessMode, catalogItem, COMPOSER_MODES, type ComposerMode, type Delivery, errorMessage, type IPromptAttachment, MODE_COLORS, modelLabel,
	selectModelGroups, SENDABLE_IMAGE_MIMES, uuid
} from '@volt/client-core';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAttachment, useClient, useRuntime } from '../app/client';
import { registerComposer } from '../ide/composerBridge';
import { fuzzyPath, rank } from '../ide/fuzzy';
import { FileIcon } from '../ide/icons';
import { type IMenuItem, MenuButton } from '../ui/overlays';
import { Icon, Kbd, Spinner } from '../ui/primitives';
import { openLightbox } from './Lightbox';

const DRAFT_PREFIX = 'volt.web.draft.';
const MAX_EDGE = 2048;
const MAX_BYTES = 4.5 * 1024 * 1024;

function loadDraft(key: string | undefined): string {
	if (!key) {
		return '';
	}
	try {
		return window.localStorage.getItem(DRAFT_PREFIX + key) ?? '';
	} catch {
		return '';
	}
}

function saveDraft(key: string | undefined, text: string): void {
	if (!key) {
		return;
	}
	try {
		if (text) {
			window.localStorage.setItem(DRAFT_PREFIX + key, text);
		} else {
			window.localStorage.removeItem(DRAFT_PREFIX + key);
		}
	} catch {
		// private mode
	}
}

/** An image in the composer: its preview at once, its upload in the background. */
interface IDraftImage {
	readonly id: string;
	readonly name: string;
	readonly preview: string;
	readonly state: 'uploading' | 'ready' | 'failed';
	readonly attachment?: IPromptAttachment;
	readonly error?: string;
}

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
		reader.readAsDataURL(blob);
	});
}

/** Big photos and retina screenshots shrink to what models take (2048px on the long edge). */
async function prepareImage(file: File): Promise<{ base64: string; mime: string; preview: string }> {
	const mime = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
	const original = await readAsDataUrl(file);
	const fits = (w: number, h: number) => Math.max(w, h) <= MAX_EDGE && file.size <= MAX_BYTES;
	if (mime === 'image/gif' && file.size <= MAX_BYTES) {
		return { base64: original.slice(original.indexOf(',') + 1), mime, preview: original };
	}
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('That image could not be read.'));
		img.src = original;
	});
	if (fits(image.naturalWidth, image.naturalHeight) && SENDABLE_IMAGE_MIMES.includes(mime)) {
		return { base64: original.slice(original.indexOf(',') + 1), mime, preview: original };
	}
	const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(image.naturalWidth * scale);
	canvas.height = Math.round(image.naturalHeight * scale);
	canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
	// Screenshots stay sharp as PNG; photos go out as JPEG.
	const asPng = mime === 'image/png' && canvas.width * canvas.height < 2_400_000;
	const out = canvas.toDataURL(asPng ? 'image/png' : 'image/jpeg', 0.88);
	return { base64: out.slice(out.indexOf(',') + 1), mime: asPng ? 'image/png' : 'image/jpeg', preview: out };
}

export interface IComposerProps {
	/** Drafts are kept per chat (and `new` for the new chat page). */
	readonly draftKey?: string;
	readonly running?: boolean;
	readonly mode: ComposerMode;
	readonly onModeChange: (mode: ComposerMode) => void;
	readonly modelRef: string | undefined;
	readonly onModelChange: (ref: string | undefined) => void;
	readonly accessMode: AccessMode | undefined;
	readonly onAccessChange: (mode: AccessMode) => void;
	readonly onSend: (text: string, delivery: Delivery, attachments: readonly IPromptAttachment[]) => boolean | void | Promise<boolean | void>;
	readonly onStop?: () => void;
	readonly placeholder?: string;
	readonly autoFocus?: boolean;
	readonly contextUsed?: number;
	readonly contextWindow?: number;
	readonly disabled?: boolean;
	readonly disabledReason?: string;
	/** Extra controls before the model picker (the new chat page's project picker). */
	readonly leading?: ReactNode;
	readonly large?: boolean;
	/** Editing a sent message: its text and images, a Cancel, and what the send button says. */
	readonly edit?: { readonly text: string; readonly attachments: readonly IPromptAttachment[]; readonly onCancel: () => void; readonly label: string };
	/** The project folder `@` completes file names from. */
	readonly mentionRoot?: string;
	/** Takes "Add to Chat" from the explorer and the editor. */
	readonly acceptsInserts?: boolean;
	/** Puts a prompt back into the composer (a rewound message); a new `key` applies it. */
	readonly seed?: { readonly key: number; readonly text: string; readonly attachments: readonly IPromptAttachment[] };
	/** The agent panel's narrow composer drops labels it has no room for. */
	readonly compact?: boolean;
}

export function Composer(props: IComposerProps) {
	const client = useClient();
	const runtime = useRuntime();
	const [text, setText] = useState(() => props.edit?.text ?? loadDraft(props.draftKey));
	const [images, setImages] = useState<readonly IDraftImage[]>(() => (props.edit?.attachments ?? []).map(a => ({ id: a.id, name: a.name, preview: client.getAttachmentUrl(a.ref) ?? '', state: 'ready', attachment: a })));
	const [dragging, setDragging] = useState(false);
	const [sending, setSending] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const editing = !!props.edit;

	useEffect(() => {
		if (!editing) {
			setText(loadDraft(props.draftKey));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.draftKey]);

	useEffect(() => {
		if (editing) {
			return;
		}
		const timer = setTimeout(() => saveDraft(props.draftKey, text), 250);
		return () => clearTimeout(timer);
	}, [props.draftKey, text, editing]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		el.style.height = '0px';
		el.style.height = `${Math.min(el.scrollHeight, props.large ? 320 : 260)}px`;
	}, [text, props.large]);

	useEffect(() => {
		if ((props.autoFocus || editing) && window.matchMedia('(pointer: fine)').matches) {
			const el = ref.current;
			el?.focus();
			if (editing && el) {
				el.setSelectionRange(el.value.length, el.value.length);
			}
		}
	}, [props.autoFocus, props.draftKey, editing]);

	useEffect(() => {
		if (!props.seed) {
			return;
		}
		const seed = props.seed;
		setText(current => current.trim() ? `${current.trim()}\n\n${seed.text}` : seed.text);
		setImages(list => [...list, ...seed.attachments.map(a => ({ id: a.id, name: a.name, preview: client.getAttachmentUrl(a.ref) ?? '', state: 'ready' as const, attachment: a }))]);
		requestAnimationFrame(() => ref.current?.focus());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.seed?.key]);

	// "Add to Chat" lands here when this is the composer last typed in.
	const registration = useRef<ReturnType<typeof registerComposer> | undefined>(undefined);
	useEffect(() => {
		if (!props.acceptsInserts) {
			return;
		}
		const reg = registerComposer(insert => {
			setText(current => current && !/\s$/.test(current) ? `${current} ${insert}` : `${current}${insert}`);
			requestAnimationFrame(() => {
				const el = ref.current;
				el?.focus();
				el?.setSelectionRange(el.value.length, el.value.length);
			});
		});
		registration.current = reg;
		return () => {
			reg.dispose();
			registration.current = undefined;
		};
	}, [props.acceptsInserts]);

	const addFiles = (files: readonly File[]) => {
		for (const file of files) {
			if (!file.type.startsWith('image/')) {
				client.toast('info', `${file.name} isn't an image. Drop files into the project, then mention them with @.`);
				continue;
			}
			const id = uuid();
			const name = file.name && file.name !== 'image.png' ? file.name : `Image ${images.length + 1}.${(file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
			setImages(list => [...list, { id, name, preview: '', state: 'uploading' }]);
			void (async () => {
				try {
					const prepared = await prepareImage(file);
					setImages(list => list.map(i => i.id === id ? { ...i, preview: prepared.preview } : i));
					const attachment = await client.uploadAttachment({ base64: prepared.base64, mime: prepared.mime, name });
					setImages(list => list.map(i => i.id === id ? { ...i, state: 'ready', attachment } : i));
				} catch (err) {
					setImages(list => list.map(i => i.id === id ? { ...i, state: 'failed', error: errorMessage(err) } : i));
				}
			})();
		}
	};

	const trimmed = text.trim();
	const uploading = images.some(i => i.state === 'uploading');
	const ready = images.filter(i => i.state === 'ready' && i.attachment).map(i => i.attachment!);
	const canSend = (!!trimmed || ready.length > 0) && !uploading && !props.disabled && !sending;

	const send = async (delivery: Delivery) => {
		if (!canSend) {
			return;
		}
		const body = trimmed || (ready.length === 1 ? 'Take a look at this image.' : 'Take a look at these images.');
		setSending(true);
		try {
			if (await props.onSend(body, delivery, ready) === false) {
				return;
			}
		} finally {
			setSending(false);
		}
		setText('');
		setImages([]);
		if (!editing) {
			saveDraft(props.draftKey, '');
		}
	};

	const mention = useMention(text, ref, props.mentionRoot);

	const groups = useMemo(() => selectModelGroups(runtime), [runtime]);
	const model = catalogItem(runtime, props.modelRef);
	const modelItems: IMenuItem[] = [
		{ id: 'auto', label: 'Auto', detail: 'Volt picks the model', icon: 'sparkles', checked: !props.modelRef, onSelect: () => props.onModelChange(undefined) },
		...groups.flatMap(group => [
			{ id: `sep:${group.key}`, label: '', separator: true },
			{ id: `h:${group.key}`, label: group.label, header: true },
			...group.models.map(item => ({
				id: item.ref,
				label: item.qualifier ? `${item.label} ${item.qualifier}` : item.label,
				...(item.contextLabel || item.detail ? { detail: item.contextLabel ?? item.detail } : {}),
				checked: item.ref === props.modelRef,
				onSelect: () => props.onModelChange(item.ref),
			})),
		]),
	];
	if (!groups.length) {
		modelItems.push({ id: 'none', label: runtime.catalogLoading ? 'Loading models…' : 'No models are set up in Volt', disabled: true });
	}

	const options = model?.optionDescriptors?.filter(d => d.type === 'select' && d.options?.length).slice(0, 2) ?? [];
	const current = (props.modelRef && runtime.modelOptions?.[props.modelRef]) || {};

	const modeItems: IMenuItem[] = COMPOSER_MODES.map(m => ({
		id: m.id, label: m.id, detail: m.description, checked: m.id === props.mode,
		dot: m.id === 'Agent' ? 'var(--fg3)' : MODE_COLORS[m.id].fg,
		onSelect: () => props.onModeChange(m.id),
	}));
	const access = ACCESS_MODES.find(a => a.id === props.accessMode) ?? ACCESS_MODES[3];
	const accessItems: IMenuItem[] = ACCESS_MODES.map(a => ({
		id: a.id, label: a.label, detail: a.description, checked: a.id === access.id,
		icon: a.id === 'supervised' ? 'shieldCheck' : a.id === 'full-access' ? 'zap' : 'shield',
		onSelect: () => props.onAccessChange(a.id),
	}));

	const showStop = props.running && !trimmed && !ready.length && !!props.onStop && !editing;
	const used = props.contextUsed && props.contextWindow ? Math.min(1, props.contextUsed / props.contextWindow) : undefined;

	return (
		<div
			className={`composer${props.large ? ' large' : ''}${props.compact ? ' compact' : ''}${props.disabled ? ' disabled' : ''}${dragging ? ' dragging' : ''}${editing ? ' editing' : ''}`}
			data-mode={props.mode.toLowerCase()}
			onDragOver={e => {
				if ([...e.dataTransfer.items].some(item => item.kind === 'file')) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
			onDrop={e => {
				const files = [...e.dataTransfer.files];
				setDragging(false);
				if (files.length) {
					e.preventDefault();
					addFiles(files);
				}
			}}
		>
			{mention.open ? (
				<div className="mention-list" role="listbox">
					{mention.items.length ? mention.items.map((item, i) => (
						<button key={item} type="button" className={`mention-item${i === mention.index ? ' focused' : ''}`} onMouseDown={e => {
							e.preventDefault();
							setText(mention.apply(item));
						}} onMouseMove={() => mention.setIndex(i)}>
							<FileIcon path={item} />
							<span className="mention-name">{item.split('/').pop()}</span>
							<span className="mention-dir">{item.split('/').slice(0, -1).join('/')}</span>
						</button>
					)) : <div className="mention-empty">{mention.loading ? 'Indexing files…' : 'No matching files'}</div>}
				</div>
			) : null}
			{images.length ? (
				<div className="composer-images">
					{images.map(image => (
						<div key={image.id} className={`composer-image ${image.state}`} title={image.error ?? image.name}>
							{image.preview ? <img src={image.preview} alt={image.name} onClick={() => image.preview && openLightbox(image.preview, image.name)} /> : image.attachment ? <StoredThumb attachment={image.attachment} /> : <span className="composer-image-blank" />}
							{image.state === 'uploading' ? <span className="composer-image-busy"><Spinner size={14} /></span> : null}
							{image.state === 'failed' ? <span className="composer-image-busy failed"><Icon name="alertCircle" size={16} /></span> : null}
							<button type="button" className="composer-image-remove" aria-label={`Remove ${image.name}`} onClick={() => setImages(list => list.filter(i => i.id !== image.id))}><Icon name="close" size={11} strokeWidth={2.2} /></button>
						</div>
					))}
				</div>
			) : null}
			<textarea
				ref={ref}
				className="composer-input"
				value={text}
				rows={1}
				placeholder={props.disabledReason ?? props.placeholder ?? (props.running ? 'Add to the queue, or ⌘↵ to send now' : 'Ask Volt to build, fix or explain… @ to mention a file')}
				disabled={props.disabled}
				onFocus={() => registration.current?.focused()}
				onChange={e => setText(e.target.value)}
				onPaste={e => {
					const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
					if (files.length) {
						e.preventDefault();
						addFiles(files);
					}
				}}
				onKeyDown={e => {
					if (mention.onKeyDown(e, next => setText(next))) {
						return;
					}
					if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send(e.metaKey || e.ctrlKey ? 'now' : 'auto');
					} else if (e.key === 'Escape') {
						if (editing) {
							props.edit?.onCancel();
						} else {
							ref.current?.blur();
						}
					}
				}}
			/>
			<div className="composer-bar">
				<button type="button" className="pill pill-icon" title="Attach images" aria-label="Attach images" onClick={() => picker.current?.click()}>
					<Icon name="paperclip" size={14} />
				</button>
				<input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => {
					addFiles([...(e.target.files ?? [])]);
					e.target.value = '';
				}} />
				<MenuButton className={`pill pill-mode mode-${props.mode.toLowerCase()}`} items={modeItems} placement="top-start" width={280} label="Mode">
					<span className="mode-dot" />{props.mode}<Icon name="chevronDown" size={11} />
				</MenuButton>
				{props.leading}
				<MenuButton className="pill" items={modelItems} placement="top-start" width={300} label="Model">
					<Icon name="cpu" size={13} /><span className="pill-text">{modelLabel(runtime, props.modelRef)}</span><Icon name="chevronDown" size={11} />
				</MenuButton>
				{options.map(descriptor => {
					const value = String(current[descriptor.id] ?? descriptor.options?.find(o => o.isDefault)?.value ?? descriptor.options?.[0]?.value ?? '');
					const label = descriptor.options?.find(o => o.value === value)?.label ?? descriptor.label;
					return (
						<MenuButton key={descriptor.id} className="pill pill-quiet hide-compact" placement="top-start" width={220} label={descriptor.label} items={[
							{ id: 'h', label: descriptor.label, header: true },
							...(descriptor.options ?? []).map(o => ({ id: o.value, label: o.label, checked: o.value === value, onSelect: () => props.modelRef && void client.setModelOptions(props.modelRef, { ...current, [descriptor.id]: o.value }) })),
						]}>
							<span className="pill-text">{label}</span>
						</MenuButton>
					);
				})}
				<MenuButton className={`pill pill-quiet access-${access.id}`} items={accessItems} placement="top-start" width={300} label="Access">
					<Icon name={access.id === 'supervised' ? 'shieldCheck' : access.id === 'full-access' ? 'zap' : 'shield'} size={13} /><span className="pill-text hide-narrow hide-compact">{access.label}</span>
				</MenuButton>
				<span className="composer-spacer" />
				{used !== undefined ? (
					<span className="context-ring" title={`Context ${Math.round(used * 100)}% used`} style={{ ['--used' as string]: `${used * 360}deg` }}>
						<span className="context-ring-inner" />
					</span>
				) : null}
				{editing ? <button type="button" className="btn btn-ghost btn-sm" onClick={props.edit?.onCancel}>Cancel</button> : null}
				{showStop ? (
					<button type="button" className="send-btn stop" onClick={props.onStop} aria-label="Stop"><Icon name="stop" size={12} /></button>
				) : editing ? (
					<button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={() => void send('auto')}>{sending ? <Spinner size={12} /> : null}{props.edit?.label}</button>
				) : (
					<button type="button" className="send-btn" disabled={!canSend} onClick={() => void send('auto')} aria-label={props.running ? 'Queue' : 'Send'} title={uploading ? 'Uploading images…' : undefined}>
						{uploading || sending ? <Spinner size={13} /> : <Icon name={props.running ? 'queue' : 'arrowUp'} size={15} strokeWidth={2} />}
					</button>
				)}
			</div>
			{props.running && trimmed && !editing ? (
				<div className="composer-hint"><Kbd>{'↵'}</Kbd> queue <span className="dot-sep" /> <Kbd>{'⌘↵'}</Kbd> send now</div>
			) : null}
			{dragging ? <div className="composer-drop"><Icon name="image" size={18} />Drop images to attach</div> : null}
		</div>
	);
}

/** A sent image put back in the composer: shown from the attachment store. */
function StoredThumb({ attachment }: { readonly attachment: IPromptAttachment }) {
	const url = useAttachment(attachment.ref);
	return url ? <img src={url} alt={attachment.name} onClick={() => openLightbox(url, attachment.name)} /> : <span className="composer-image-blank" />;
}

const mentionIndexes = new Map<string, { readonly at: number; readonly files: Promise<readonly string[]> }>();

/** `@` completes file names of the chat's project, inserting `@path/to/file`. */
function useMention(text: string, ref: React.RefObject<HTMLTextAreaElement | null>, root: string | undefined) {
	const client = useClient();
	const [caret, setCaret] = useState(0);
	const [index, setIndex] = useState(0);
	const [files, setFiles] = useState<readonly string[] | undefined>();
	const [dismissed, setDismissed] = useState<string | undefined>();

	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		const update = () => setCaret(el.selectionStart ?? 0);
		el.addEventListener('keyup', update);
		el.addEventListener('click', update);
		el.addEventListener('input', update);
		return () => {
			el.removeEventListener('keyup', update);
			el.removeEventListener('click', update);
			el.removeEventListener('input', update);
		};
	}, [ref]);

	const token = useMemo(() => {
		const before = text.slice(0, caret);
		const m = /(^|\s)@([^\s@]*)$/.exec(before);
		return m ? { start: before.length - m[2].length - 1, query: m[2] } : undefined;
	}, [text, caret]);
	const open = !!root && !!token && dismissed !== `${token.start}`;

	useEffect(() => {
		if (!open || !root) {
			return;
		}
		let entry = mentionIndexes.get(root);
		if (!entry || Date.now() - entry.at > 30_000) {
			entry = { at: Date.now(), files: client.fileIndex(root).then(r => r.files) };
			mentionIndexes.set(root, entry);
			entry.files.catch(() => mentionIndexes.delete(root));
		}
		let cancelled = false;
		entry.files.then(f => !cancelled && setFiles(f), () => !cancelled && setFiles([]));
		return () => {
			cancelled = true;
		};
	}, [client, open, root]);

	const items = useMemo(() => {
		if (!open || !files) {
			return [];
		}
		return token?.query ? rank(files, token.query, f => f, fuzzyPath, 8).map(r => r.item) : files.slice(0, 8);
	}, [open, files, token?.query]);

	useEffect(() => setIndex(0), [token?.query]);

	const apply = (path: string) => {
		if (!token) {
			return text;
		}
		const next = `${text.slice(0, token.start)}@${path} ${text.slice(caret)}`;
		const at = token.start + path.length + 2;
		requestAnimationFrame(() => {
			ref.current?.setSelectionRange(at, at);
			setCaret(at);
		});
		return next;
	};

	return {
		open,
		items,
		index,
		setIndex,
		loading: !files,
		apply,
		onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, set: (next: string) => void): boolean => {
			if (!open || !items.length) {
				if (open && e.key === 'Escape') {
					e.preventDefault();
					setDismissed(`${token!.start}`);
					return true;
				}
				return false;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				setIndex(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
				return true;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				set(apply(items[index]));
				return true;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setDismissed(`${token!.start}`);
				return true;
			}
			return false;
		},
	};
}
