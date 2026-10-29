/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IconName } from '@volt/client-core';
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClient, useToasts } from '../app/client';
import { Button, Icon } from './primitives';

export interface IMenuModifiers {
	readonly shiftKey: boolean;
}

export interface IMenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
	readonly detail?: string;
	readonly checked?: boolean;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly onSelect?: (modifiers: IMenuModifiers) => void;
	/** Leave the menu open after a pick (ticking several models); a function decides per click. */
	readonly keepOpen?: boolean | ((modifiers: IMenuModifiers) => boolean);
	/** A heading row (not selectable). */
	readonly header?: boolean;
	readonly separator?: boolean;
	/** A coloured dot before the label (modes). */
	readonly dot?: string;
}

/**
 * A popover anchored to a button, kept on screen. Closes on outside click, Escape and selection.
 * Arrow keys move between items.
 */
export function Popover({ anchor, open, onClose, children, placement = 'bottom-start', width }: {
	readonly anchor: RefObject<HTMLElement | null>;
	readonly open: boolean;
	readonly onClose: () => void;
	readonly children: ReactNode;
	readonly placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
	readonly width?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | undefined>();

	useLayoutEffect(() => {
		if (!open || !anchor.current) {
			setPos(undefined);
			return;
		}
		const place = () => {
			const a = anchor.current!.getBoundingClientRect();
			const el = ref.current;
			const w = el?.offsetWidth ?? width ?? 240;
			const h = el?.offsetHeight ?? 200;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const up = placement.startsWith('top') ? a.top - h - 6 > 8 || a.bottom + h + 6 > vh : a.bottom + h + 6 > vh && a.top - h - 6 > 8;
			const top = up ? Math.max(8, a.top - h - 6) : a.bottom + 6;
			let left = placement.endsWith('end') ? a.right - w : a.left;
			left = Math.min(Math.max(8, left), vw - w - 8);
			setPos({ top, left, maxHeight: up ? a.top - 14 : vh - a.bottom - 14 });
		};
		place();
		const frame = requestAnimationFrame(place);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, true);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', place, true);
		};
	}, [open, anchor, placement, width]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) {
				onClose();
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
				anchor.current?.focus();
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button.menu-item:not(:disabled)') ?? [])];
				if (!items.length) {
					return;
				}
				e.preventDefault();
				const index = items.indexOf(document.activeElement as HTMLButtonElement);
				const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
				items[next].focus();
			}
		};
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open, onClose, anchor]);

	if (!open) {
		return null;
	}
	return createPortal(
		<div ref={ref} className="popover" role="menu" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight, width, visibility: pos ? 'visible' : 'hidden' }}>
			{children}
		</div>,
		document.body,
	);
}

export function MenuList({ items, onClose }: { readonly items: readonly IMenuItem[]; readonly onClose: () => void }) {
	return (
		<div className="menu">
			{items.map(item => {
				if (item.separator) {
					return <div key={item.id} className="menu-sep" />;
				}
				if (item.header) {
					return <div key={item.id} className="menu-header">{item.label}</div>;
				}
				return (
					<button key={item.id} type="button" role="menuitem" className={`menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`} disabled={item.disabled}
						onClick={e => {
							const modifiers: IMenuModifiers = { shiftKey: e.shiftKey };
							const keep = typeof item.keepOpen === 'function' ? item.keepOpen(modifiers) : item.keepOpen;
							if (!keep) {
								onClose();
							}
							item.onSelect?.(modifiers);
						}}>
						{item.dot ? <span className="menu-dot" style={{ background: item.dot }} /> : item.icon ? <Icon name={item.icon} size={15} /> : <span className="menu-icon-space" />}
						<span className="menu-label">
							<span>{item.label}</span>
							{item.detail ? <span className="menu-detail">{item.detail}</span> : null}
						</span>
						{item.checked ? <Icon name="check" size={14} className="menu-check" /> : null}
					</button>
				);
			})}
		</div>
	);
}

/** A menu at the pointer (right click), kept on screen. */
export function ContextMenu({ at, items, onClose, width = 230 }: { readonly at: { readonly x: number; readonly y: number } | undefined; readonly items: readonly IMenuItem[]; readonly onClose: () => void; readonly width?: number }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | undefined>();
	useLayoutEffect(() => {
		if (!at) {
			setPos(undefined);
			return;
		}
		const h = ref.current?.offsetHeight ?? 240;
		const w = ref.current?.offsetWidth ?? width;
		setPos({ top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)), left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)) });
	}, [at, width]);
	useEffect(() => {
		if (!at) {
			return;
		}
		const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		const onBlur = () => onClose();
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey, true);
		window.addEventListener('blur', onBlur);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey, true);
			window.removeEventListener('blur', onBlur);
		};
	}, [at, onClose]);
	if (!at) {
		return null;
	}
	return createPortal(
		<div ref={ref} className="popover context-menu" role="menu" style={{ top: pos?.top ?? at.y, left: pos?.left ?? at.x, width, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={e => e.preventDefault()}>
			<MenuList items={items} onClose={onClose} />
		</div>,
		document.body,
	);
}

/** A button that opens a menu. */
export function MenuButton({ items, children, className, placement, width, label, disabled }: {
	readonly items: readonly IMenuItem[] | (() => readonly IMenuItem[]);
	readonly children: ReactNode;
	readonly className?: string;
	readonly placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
	readonly width?: number;
	readonly label?: string;
	readonly disabled?: boolean;
}) {
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	return (
		<>
			<button ref={anchor} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} disabled={disabled} onClick={() => setOpen(o => !o)}>
				{children}
			</button>
			<Popover anchor={anchor} open={open} onClose={close} placement={placement} width={width}>
				<MenuList items={typeof items === 'function' ? items() : items} onClose={close} />
			</Popover>
		</>
	);
}

export function Dialog({ open, onClose, title, children, footer, width = 420 }: {
	readonly open: boolean;
	readonly onClose: () => void;
	readonly title: string;
	readonly children: ReactNode;
	readonly footer?: ReactNode;
	readonly width?: number;
}) {
	useEffect(() => {
		if (!open) {
			return;
		}
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [open, onClose]);
	if (!open) {
		return null;
	}
	return createPortal(
		<div className="dialog-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
			<div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
				<div className="dialog-title">{title}</div>
				<div className="dialog-body">{children}</div>
				{footer ? <div className="dialog-footer">{footer}</div> : null}
			</div>
		</div>,
		document.body,
	);
}

/** Asks for a line of text (rename). */
export function PromptDialog({ open, title, initial, placeholder, confirm = 'Save', onClose, onSubmit }: {
	readonly open: boolean;
	readonly title: string;
	readonly initial?: string;
	readonly placeholder?: string;
	readonly confirm?: string;
	readonly onClose: () => void;
	readonly onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState(initial ?? '');
	useEffect(() => {
		if (open) {
			setValue(initial ?? '');
		}
	}, [open, initial]);
	const submit = () => {
		onSubmit(value);
		onClose();
	};
	return (
		<Dialog open={open} onClose={onClose} title={title} footer={<>
			<Button variant="ghost" onClick={onClose}>Cancel</Button>
			<Button variant="primary" onClick={submit}>{confirm}</Button>
		</>}>
			<input className="input" autoFocus value={value} placeholder={placeholder} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
		</Dialog>
	);
}

export function ConfirmDialog({ open, title, body, confirm, danger, onClose, onConfirm }: {
	readonly open: boolean;
	readonly title: string;
	readonly body: ReactNode;
	readonly confirm: string;
	readonly danger?: boolean;
	readonly onClose: () => void;
	readonly onConfirm: () => void;
}) {
	return (
		<Dialog open={open} onClose={onClose} title={title} footer={<>
			<Button variant="ghost" onClick={onClose}>Cancel</Button>
			<Button variant={danger ? 'danger' : 'primary'} onClick={() => {
				onConfirm();
				onClose();
			}}>{confirm}</Button>
		</>}>
			<div className="dialog-text">{body}</div>
		</Dialog>
	);
}

export function Toasts() {
	const toasts = useToasts();
	const client = useClient();
	return (
		<div className="toasts" aria-live="polite">
			{toasts.map(toast => (
				<div key={toast.id} className={`toast toast-${toast.kind}`} onClick={() => client.dismissToast(toast.id)}>
					<Icon name={toast.kind === 'error' ? 'alertCircle' : toast.kind === 'success' ? 'checkCircle' : 'info'} size={15} />
					<span>{toast.message}</span>
				</div>
			))}
		</div>
	);
}
