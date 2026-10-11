/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ACCESS_MODES, type AccessMode, catalogItem, COMPOSER_MODES, type ComposerMode, type Delivery, MODE_COLORS, modelLabel, selectModelGroups
} from '@volt/client-core';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useClient, useRuntime } from '../app/client';
import { type IMenuItem, MenuButton } from '../ui/overlays';
import { Icon, Kbd } from '../ui/primitives';

const DRAFT_PREFIX = 'volt.web.draft.';

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
	readonly onSend: (text: string, delivery: Delivery) => boolean | void;
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
}

export function Composer(props: IComposerProps) {
	const client = useClient();
	const runtime = useRuntime();
	const [text, setText] = useState(() => loadDraft(props.draftKey));
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		setText(loadDraft(props.draftKey));
	}, [props.draftKey]);

	useEffect(() => {
		const timer = setTimeout(() => saveDraft(props.draftKey, text), 250);
		return () => clearTimeout(timer);
	}, [props.draftKey, text]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		el.style.height = '0px';
		el.style.height = `${Math.min(el.scrollHeight, props.large ? 320 : 240)}px`;
	}, [text, props.large]);

	useEffect(() => {
		if (props.autoFocus && window.matchMedia('(pointer: fine)').matches) {
			ref.current?.focus();
		}
	}, [props.autoFocus, props.draftKey]);

	const trimmed = text.trim();
	const send = (delivery: Delivery) => {
		if (!trimmed || props.disabled) {
			return;
		}
		if (props.onSend(trimmed, delivery) === false) {
			return;
		}
		setText('');
		saveDraft(props.draftKey, '');
	};

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

	const showStop = props.running && !trimmed && !!props.onStop;
	const used = props.contextUsed && props.contextWindow ? Math.min(1, props.contextUsed / props.contextWindow) : undefined;

	return (
		<div className={`composer${props.large ? ' large' : ''}${props.disabled ? ' disabled' : ''}`} data-mode={props.mode.toLowerCase()}>
			<textarea
				ref={ref}
				className="composer-input"
				value={text}
				rows={1}
				placeholder={props.disabledReason ?? props.placeholder ?? (props.running ? 'Add to the queue, or ⌘↵ to send now' : 'Ask Volt to build, fix or explain…')}
				disabled={props.disabled}
				onChange={e => setText(e.target.value)}
				onKeyDown={e => {
					if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						send(e.metaKey || e.ctrlKey ? 'now' : 'auto');
					} else if (e.key === 'Escape') {
						ref.current?.blur();
					}
				}}
			/>
			<div className="composer-bar">
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
						<MenuButton key={descriptor.id} className="pill pill-quiet" placement="top-start" width={220} label={descriptor.label} items={[
							{ id: 'h', label: descriptor.label, header: true },
							...(descriptor.options ?? []).map(o => ({ id: o.value, label: o.label, checked: o.value === value, onSelect: () => props.modelRef && void client.setModelOptions(props.modelRef, { ...current, [descriptor.id]: o.value }) })),
						]}>
							<span className="pill-text">{label}</span>
						</MenuButton>
					);
				})}
				<MenuButton className={`pill pill-quiet access-${access.id}`} items={accessItems} placement="top-start" width={300} label="Access">
					<Icon name={access.id === 'supervised' ? 'shieldCheck' : access.id === 'full-access' ? 'zap' : 'shield'} size={13} /><span className="pill-text hide-narrow">{access.label}</span>
				</MenuButton>
				<span className="composer-spacer" />
				{used !== undefined ? (
					<span className="context-ring" title={`Context ${Math.round(used * 100)}% used`} style={{ ['--used' as string]: `${used * 360}deg` }}>
						<span className="context-ring-inner" />
					</span>
				) : null}
				{showStop ? (
					<button type="button" className="send-btn stop" onClick={props.onStop} aria-label="Stop"><Icon name="stop" size={12} /></button>
				) : (
					<button type="button" className="send-btn" disabled={!trimmed || props.disabled} onClick={() => send('auto')} aria-label={props.running ? 'Queue' : 'Send'}>
						<Icon name={props.running ? 'queue' : 'arrowUp'} size={15} strokeWidth={2} />
					</button>
				)}
			</div>
			{props.running && trimmed ? (
				<div className="composer-hint"><Kbd>{'↵'}</Kbd> queue <span className="dot-sep" /> <Kbd>{'⌘↵'}</Kbd> send now</div>
			) : null}
		</div>
	);
}
