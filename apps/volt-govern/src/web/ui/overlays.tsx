/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './controls';
import { Codicon, type CodiconName } from './icons';

//#region Popover

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start';

/** Anchored to an element or a point, kept on screen, closed by outside click and Escape. */
export function Popover({ anchor, point, open, onClose, children, placement = 'bottom-start', width, minWidth }: {
	readonly anchor?: RefObject<HTMLElement | null>;
	readonly point?: { readonly x: number; readonly y: number };
	readonly open: boolean;
	readonly onClose: () => void;
	readonly children: ReactNode;
	readonly placement?: Placement;
	readonly width?: number;
	readonly minWidth?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number }>();

	useLayoutEffect(() => {
		if (!open) {
			setPos(undefined);
			return;
		}
		const place = () => {
			const el = ref.current;
			const w = el?.offsetWidth ?? width ?? 220;
			const h = el?.offsetHeight ?? 200;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const a = anchor?.current?.getBoundingClientRect() ?? (point ? new DOMRect(point.x, point.y, 0, 0) : undefined);
			if (!a) {
				return;
			}
			if (placement === 'right-start') {
				setPos({ top: Math.min(a.top, vh - h - 8), left: Math.min(a.right + 2, vw - w - 8), maxHeight: vh - 16 });
				return;
			}
			const up = placement.startsWith('top') ? a.top - h - 4 > 8 || a.bottom + h + 4 > vh : a.bottom + h + 4 > vh && a.top - h - 4 > 8;
			const top = up ? Math.max(8, a.top - h - 4) : a.bottom + 4;
			let left = placement.endsWith('end') ? a.right - w : a.left;
			left = Math.min(Math.max(8, left), vw - w - 8);
			setPos({ top, left, maxHeight: up ? a.top - 12 : vh - a.bottom - 12 });
		};
		place();
		const raf = requestAnimationFrame(place);
		window.addEventListener('resize', place);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', place);
		};
	}, [open, anchor, point, placement, width]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const down = (e: PointerEvent) => {
			const target = e.target as Node;
			if (!ref.current?.contains(target) && !anchor?.current?.contains(target)) {
				onClose();
			}
		};
		const key = (e: globalThis.KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
				anchor?.current?.focus();
			}
		};
		document.addEventListener('pointerdown', down, true);
		document.addEventListener('keydown', key, true);
		return () => {
			document.removeEventListener('pointerdown', down, true);
			document.removeEventListener('keydown', key, true);
		};
	}, [open, onClose, anchor]);

	if (!open) {
		return null;
	}
	return createPortal(
		<div ref={ref} className="popover" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, minWidth, maxHeight: pos?.maxHeight, overflowY: 'auto', visibility: pos ? 'visible' : 'hidden' }}>
			{children}
		</div>,
		document.body,
	);
}

//#endregion

//#region Menus

export interface IMenuItem {
	readonly id: string;
	readonly label?: string;
	readonly icon?: CodiconName;
	readonly keys?: string;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly checked?: boolean;
	readonly separator?: boolean;
	readonly header?: string;
	readonly run?: () => void;
}

/** VS Code's context/dropdown menu: arrow keys, Enter, type-ahead, Escape. */
export function Menu({ items, onDone }: { readonly items: readonly IMenuItem[]; readonly onDone: () => void }) {
	const actionable = items.map((item, i) => ({ item, i })).filter(({ item }) => !item.separator && !item.header && !item.disabled);
	const [focus, setFocus] = useState(-1);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const run = (item: IMenuItem) => {
		onDone();
		item.run?.();
	};
	const onKey = (e: KeyboardEvent) => {
		const pos = actionable.findIndex(a => a.i === focus);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setFocus(actionable[(pos + 1) % actionable.length]?.i ?? -1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setFocus(actionable[(pos - 1 + actionable.length) % actionable.length]?.i ?? -1);
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			const item = items[focus];
			if (item && !item.disabled) {
				run(item);
			}
		} else if (e.key.length === 1) {
			const hit = actionable.find(a => a.i > focus && a.item.label?.toLowerCase().startsWith(e.key.toLowerCase())) ?? actionable.find(a => a.item.label?.toLowerCase().startsWith(e.key.toLowerCase()));
			if (hit) {
				setFocus(hit.i);
			}
		}
	};
	return (
		<div className="menu" role="menu" tabIndex={-1} ref={ref} onKeyDown={onKey}>
			{items.map((item, i) => item.separator
				? <div key={item.id} className="menu-sep" role="separator" />
				: item.header
					? <div key={item.id} className="menu-header">{item.header}</div>
					: (
						<button key={item.id} type="button" role="menuitem" disabled={item.disabled} className={`menu-item${item.danger ? ' danger' : ''}${focus === i ? ' focused' : ''}`}
							onMouseEnter={() => setFocus(i)} onClick={() => run(item)}>
							{item.checked !== undefined ? <Codicon name="check" className={item.checked ? undefined : 'faint'} /> : item.icon ? <Codicon name={item.icon} /> : <span style={{ width: 16 }} />}
							<span className="menu-label">{item.label}</span>
							{item.keys ? <span className="menu-keys">{item.keys}</span> : null}
						</button>
					))}
		</div>
	);
}

export function MenuButton({ items, children, className, title, placement = 'bottom-start', disabled }: {
	readonly items: readonly IMenuItem[] | (() => readonly IMenuItem[]);
	readonly children: ReactNode;
	readonly className?: string;
	readonly title?: string;
	readonly placement?: Placement;
	readonly disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button ref={ref} type="button" className={className ?? 'action-btn'} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
				onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
				{children}
			</button>
			<Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement={placement}>
				<Menu items={typeof items === 'function' ? items() : items} onDone={() => setOpen(false)} />
			</Popover>
		</>
	);
}

/** Right-click menus: one at a time, anywhere. */
let contextMenu: { readonly x: number; readonly y: number; readonly items: readonly IMenuItem[] } | undefined;
const contextListeners = new Set<() => void>();

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: readonly IMenuItem[]): void {
	e.preventDefault();
	e.stopPropagation();
	contextMenu = { x: e.clientX, y: e.clientY, items };
	contextListeners.forEach(l => l());
}

function closeContextMenu(): void {
	contextMenu = undefined;
	contextListeners.forEach(l => l());
}

export function ContextMenuHost() {
	const menu = useSyncExternalStore(l => (contextListeners.add(l), () => contextListeners.delete(l)), () => contextMenu);
	return (
		<Popover open={!!menu} point={menu} onClose={closeContextMenu}>
			{menu ? <Menu items={menu.items} onDone={closeContextMenu} /> : null}
		</Popover>
	);
}

//#endregion

//#region Dialogs

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal's focus: into the dialog when it opens (unless a field took it with autoFocus), Tab
 * cycling inside it, and back to whatever had focus before when it closes.
 */
function useDialogFocus(ref: RefObject<HTMLDivElement | null>): (e: KeyboardEvent) => void {
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const el = ref.current;
		if (el && !el.contains(document.activeElement)) {
			(el.querySelector<HTMLElement>('[autofocus], input, textarea') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
		}
		return () => previous?.focus?.();
	}, [ref]);
	return e => {
		if (e.key !== 'Tab' || !ref.current) {
			return;
		}
		const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null);
		if (!items.length) {
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
}

interface IDialogRequest {
	readonly id: number;
	readonly title: string;
	readonly message?: ReactNode;
	readonly icon?: 'warning' | 'error' | 'info';
	readonly primary: string;
	readonly danger?: boolean;
	readonly cancel?: string;
	readonly input?: { readonly placeholder?: string; readonly value?: string; readonly validate?: (value: string) => string | undefined };
	readonly resolve: (value: string | boolean | undefined) => void;
}

let dialogs: readonly IDialogRequest[] = [];
const dialogListeners = new Set<() => void>();
let dialogSeq = 0;

function pushDialog(request: Omit<IDialogRequest, 'id' | 'resolve'>): Promise<string | boolean | undefined> {
	return new Promise(resolve => {
		const id = ++dialogSeq;
		dialogs = [...dialogs, { ...request, id, resolve }];
		dialogListeners.forEach(l => l());
	});
}

function popDialog(id: number, value: string | boolean | undefined): void {
	const d = dialogs.find(x => x.id === id);
	dialogs = dialogs.filter(x => x.id !== id);
	dialogListeners.forEach(l => l());
	d?.resolve(value);
}

/** VS Code's modal confirmation. Resolves true only on the primary button. */
export async function confirm(options: { readonly title: string; readonly message?: ReactNode; readonly primary: string; readonly danger?: boolean; readonly icon?: 'warning' | 'error' | 'info' }): Promise<boolean> {
	return await pushDialog({ icon: options.danger ? 'warning' : options.icon, ...options }) === true;
}

/** A single-input dialog. Resolves the text, or undefined when cancelled. */
export async function promptText(options: { readonly title: string; readonly message?: ReactNode; readonly primary: string; readonly placeholder?: string; readonly value?: string; readonly validate?: (value: string) => string | undefined }): Promise<string | undefined> {
	const value = await pushDialog({ title: options.title, message: options.message, primary: options.primary, input: { placeholder: options.placeholder, value: options.value, validate: options.validate } });
	return typeof value === 'string' ? value : undefined;
}

function DialogView({ request }: { readonly request: IDialogRequest }) {
	const ref = useRef<HTMLDivElement>(null);
	const trap = useDialogFocus(ref);
	const [value, setValue] = useState(request.input?.value ?? '');
	const error = request.input?.validate?.(value);
	const submit = () => {
		if (request.input) {
			if (!error && value.trim()) {
				popDialog(request.id, value.trim());
			}
		} else {
			popDialog(request.id, true);
		}
	};
	return (
		<div className="dialog-backdrop" onMouseDown={e => e.target === e.currentTarget && popDialog(request.id, undefined)}
			onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); popDialog(request.id, undefined); } else { trap(e); } }}>
			<div className="dialog" role="alertdialog" aria-modal="true" aria-label={request.title} ref={ref} tabIndex={-1}>
				<div className="dialog-head"><div className="dialog-title">{request.title}</div></div>
				<div className="dialog-body">
					{request.icon ? <Codicon name={request.icon} className={`dialog-icon ${request.icon}`} /> : null}
					{request.message}
					{request.input ? (
						<div style={{ marginTop: 10 }}>
							<input className={`input${value && error ? ' invalid' : ''}`} autoFocus placeholder={request.input.placeholder} value={value}
								onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
							{value && error ? <div className="input-msg error">{error}</div> : null}
						</div>
					) : null}
				</div>
				<div className="dialog-foot">
					<Button variant="secondary" onClick={() => popDialog(request.id, undefined)}>{request.cancel ?? 'Cancel'}</Button>
					<Button variant={request.danger ? 'danger' : 'primary'} autoFocus={!request.input} disabled={!!request.input && (!value.trim() || !!error)} onClick={submit}>{request.primary}</Button>
				</div>
			</div>
		</div>
	);
}

export function DialogHost() {
	const list = useSyncExternalStore(l => (dialogListeners.add(l), () => dialogListeners.delete(l)), () => dialogs);
	const top = list.at(-1);
	return top ? createPortal(<DialogView key={top.id} request={top} />, document.body) : null;
}

/** A modal with arbitrary content (forms). */
export function Modal({ title, subtitle, children, onClose, footer, wide }: { readonly title: string; readonly subtitle?: ReactNode; readonly children: ReactNode; readonly onClose: () => void; readonly footer?: ReactNode; readonly wide?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const trap = useDialogFocus(ref);
	return createPortal(
		<div className="dialog-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } else { trap(e); } }}>
			<div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
				<div className="dialog-head">
					<div className="dialog-title">{title}</div>
					<button type="button" className="action-btn" title="Close" onClick={onClose}><Codicon name="close" /></button>
				</div>
				{subtitle ? <div className="dialog-sub">{subtitle}</div> : null}
				<div className="dialog-body">{children}</div>
				{footer ? <div className="dialog-foot">{footer}</div> : null}
			</div>
		</div>,
		document.body,
	);
}

//#endregion

//#region Notifications

export type Severity = 'info' | 'success' | 'warning' | 'error';

interface IToast {
	readonly id: number;
	readonly severity: Severity;
	readonly message: ReactNode;
	readonly source?: string;
	readonly actions?: readonly { readonly label: string; readonly run: () => void }[];
}

let toasts: readonly IToast[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;

export function notify(severity: Severity, message: ReactNode, options?: { readonly source?: string; readonly actions?: IToast['actions']; readonly sticky?: boolean }): void {
	const id = ++toastSeq;
	toasts = [...toasts.slice(-3), { id, severity, message, source: options?.source, actions: options?.actions }];
	toastListeners.forEach(l => l());
	if (!options?.sticky && severity !== 'error') {
		setTimeout(() => dismiss(id), severity === 'warning' ? 9000 : 5000);
	}
}

function dismiss(id: number): void {
	toasts = toasts.filter(t => t.id !== id);
	toastListeners.forEach(l => l());
}

const SEVERITY_ICON: Record<Severity, CodiconName> = { info: 'info', success: 'pass', warning: 'warning', error: 'error' };

export function NotificationHost() {
	const list = useSyncExternalStore(l => (toastListeners.add(l), () => toastListeners.delete(l)), () => toasts);
	return createPortal(
		<div className="notifications" role="status" aria-live="polite">
			{list.map(t => (
				<div key={t.id} className={`toast ${t.severity}`}>
					<Codicon name={SEVERITY_ICON[t.severity]} />
					<div className="toast-body">
						<div>{t.message}</div>
						{t.source ? <div className="toast-source">Source: {t.source}</div> : null}
						{t.actions?.length ? <div className="toast-actions">{t.actions.map(a => <Button key={a.label} size="sm" variant="secondary" onClick={() => { dismiss(t.id); a.run(); }}>{a.label}</Button>)}</div> : null}
					</div>
					<button type="button" className="action-btn" title="Clear notification" onClick={() => dismiss(t.id)}><Codicon name="close" /></button>
				</div>
			))}
		</div>,
		document.body,
	);
}

/** Runs an action, reporting failure (and optionally success) as a notification. */
export async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
	try {
		const result = await action();
		if (success) {
			notify('success', success);
		}
		return result;
	} catch (err) {
		notify('error', err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

//#endregion
