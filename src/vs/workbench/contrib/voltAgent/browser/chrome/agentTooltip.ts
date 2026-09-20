/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';

export interface IAgentTooltipRow {
	label: string;
	detail?: string;
	shortcut?: string;
	onClick?: () => void;
}

export type AgentTooltipPlacement = 'above' | 'below' | 'start';

export type AgentTooltipVariant = 'default' | 'pill' | 'files';

export interface IAgentTooltipShowOptions {
	gap?: number;
	fontSource?: HTMLElement | (() => HTMLElement | null | undefined);
	placement?: AgentTooltipPlacement;
	variant?: AgentTooltipVariant;
}

export interface IAgentTooltipShortcut {
	meta?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	key: string;
}

export function agentTooltipShortcutTokens(shortcut: IAgentTooltipShortcut): string[] {
	if (isMacintosh) {
		const tokens: string[] = [];
		if (shortcut.ctrl) {
			tokens.push('\u2303');
		}
		if (shortcut.alt) {
			tokens.push('\u2325');
		}
		if (shortcut.shift) {
			tokens.push('\u21E7');
		}
		if (shortcut.meta) {
			tokens.push('\u2318');
		}
		tokens.push(shortcut.key);
		return tokens;
	}
	const tokens: string[] = [];
	if (shortcut.ctrl || shortcut.meta) {
		tokens.push('Ctrl');
	}
	if (shortcut.alt) {
		tokens.push('Alt');
	}
	if (shortcut.shift) {
		tokens.push('Shift');
	}
	tokens.push(shortcut.key);
	return tokens;
}

export function formatAgentTooltipShortcut(shortcut: IAgentTooltipShortcut): string {
	return agentTooltipShortcutTokens(shortcut).join(' ');
}

export class AgentTooltip extends Disposable {

	readonly domNode: HTMLElement;

	constructor() {
		super();
		this.domNode = $('.volt-agent-tooltip.hidden');
		this.domNode.setAttribute('role', 'tooltip');
		this._register(toDisposable(() => this.domNode.remove()));
	}

	show(anchor: HTMLElement, rows: readonly IAgentTooltipRow[], options?: IAgentTooltipShowOptions): void {
		this.domNode.replaceChildren();
		this.domNode.classList.toggle('pill', options?.variant === 'pill');
		this.domNode.classList.toggle('files', options?.variant === 'files');
		this.domNode.classList.toggle('beside', options?.placement === 'start');
		for (const row of rows) {
			const rowEl = append(this.domNode, $(row.detail || row.onClick ? '.volt-agent-tooltip-row.file' : '.volt-agent-tooltip-row'));
			if (row.detail || row.onClick) {
				const icon = rowEl.appendChild(renderIcon(Codicon.file));
				icon.classList.add('volt-agent-tooltip-file-icon');
				const text = append(rowEl, $('.volt-agent-tooltip-file-text'));
				append(text, $('span.volt-agent-tooltip-label')).textContent = row.label;
				if (row.detail) {
					append(text, $('span.volt-agent-tooltip-file-path')).textContent = row.detail;
				}
			} else {
				append(rowEl, $('span.volt-agent-tooltip-label')).textContent = row.label;
			}
			if (row.shortcut) {
				append(rowEl, this.renderShortcut(row.shortcut, options?.variant === 'pill'));
			}
			if (row.onClick) {
				rowEl.classList.add('clickable');
				rowEl.addEventListener('mousedown', e => {
					e.preventDefault();
					e.stopPropagation();
					this.hide();
					row.onClick?.();
				});
			}
		}

		const doc = getWindow(anchor).document;
		const host = anchor.closest('.monaco-workbench') ?? doc.body;
		if (this.domNode.parentElement !== host) {
			host.appendChild(this.domNode);
		}
		if (options?.variant !== 'pill') {
			this.applyFont(anchor, options);
		} else {
			this.domNode.style.fontFamily = '';
			this.domNode.style.fontSize = '';
			this.domNode.style.fontWeight = '';
			this.domNode.style.letterSpacing = '';
			this.domNode.style.fontFeatureSettings = '';
		}

		this.domNode.classList.remove('hidden');
		const gap = options?.gap ?? 6;
		const rect = anchor.getBoundingClientRect();
		const width = this.domNode.offsetWidth;
		const height = this.domNode.offsetHeight;
		const win = getWindow(anchor);
		if (options?.placement === 'start') {
			const left = Math.max(8, rect.left - width - gap);
			const top = Math.max(8, Math.min(rect.top + (rect.height - height) / 2, win.innerHeight - height - 8));
			this.domNode.style.left = `${left}px`;
			this.domNode.style.top = `${top}px`;
			return;
		}
		let left = options?.variant === 'pill'
			? rect.left + rect.width / 2 - width / 2
			: rect.left;
		left = Math.max(8, Math.min(left, win.innerWidth - width - 8));
		const above = rect.top - height - gap;
		const below = rect.bottom + gap;
		const top = options?.placement === 'below' || above < 8 ? below : above;
		this.domNode.style.left = `${left}px`;
		this.domNode.style.top = `${top}px`;
	}

	hide(): void {
		this.domNode.classList.add('hidden');
	}

	bind(anchor: HTMLElement, getRows: () => readonly IAgentTooltipRow[], options?: IAgentTooltipShowOptions): IDisposable {
		const store = new DisposableStore();
		const win = getWindow(anchor);
		let hideTimer: number | undefined;
		const clearTimer = () => {
			if (hideTimer !== undefined) {
				win.clearTimeout(hideTimer);
				hideTimer = undefined;
			}
		};
		const hide = () => {
			clearTimer();
			if (options?.variant === 'files') {
				hideTimer = win.setTimeout(() => {
					hideTimer = undefined;
					this.hide();
				}, 160);
				return;
			}
			this.hide();
		};
		store.add(addDisposableListener(anchor, 'mouseenter', () => {
			clearTimer();
			this.show(anchor, getRows(), options);
		}));
		store.add(addDisposableListener(anchor, 'mouseleave', hide));
		store.add(addDisposableListener(this.domNode, 'mouseenter', clearTimer));
		store.add(addDisposableListener(this.domNode, 'mouseleave', hide));
		store.add(toDisposable(() => {
			clearTimer();
			this.hide();
		}));
		return store;
	}

	private applyFont(anchor: HTMLElement, options?: IAgentTooltipShowOptions): void {
		const configured = typeof options?.fontSource === 'function' ? options.fontSource() : options?.fontSource;
		const source = configured
			?? anchor.closest('.volt-agent-monaco')?.querySelector('.view-lines, textarea, .monaco-editor')
			?? anchor.closest('.volt-agent-input-box')
			?? anchor;
		const style = getWindow(source).getComputedStyle(source);
		this.domNode.style.fontFamily = style.fontFamily;
		this.domNode.style.fontSize = '';
		this.domNode.style.fontWeight = '';
		this.domNode.style.letterSpacing = style.letterSpacing;
		this.domNode.style.fontFeatureSettings = style.fontFeatureSettings;
	}

	private renderShortcut(shortcut: string, bare = false): HTMLElement {
		const el = $('span.volt-agent-tooltip-kb');
		for (const token of shortcut.split(/\s+/).filter(Boolean)) {
			append(el, $(bare ? 'span.symbol' : 'span.key')).textContent = token;
		}
		return el;
	}
}

const TOOLTIP_ATTR = 'data-volt-tooltip';
const TOOLTIP_KB_ATTR = 'data-volt-tooltip-kb';
const TOOLTIP_EXTRA_ATTR = 'data-volt-tooltip-extra';
const TOOLTIP_EXTRA_KB_ATTR = 'data-volt-tooltip-extra-kb';
const TOOLTIP_PLACEMENT_ATTR = 'data-volt-tooltip-placement';
const TOOLTIP_VARIANT_ATTR = 'data-volt-tooltip-variant';

interface ITooltipDelegate {
	tooltip: AgentTooltip;
	current: HTMLElement | undefined;
}

const tooltipDelegates = new WeakMap<Document, ITooltipDelegate>();

function tooltipRowsFor(target: HTMLElement): IAgentTooltipRow[] {
	const text = target.getAttribute(TOOLTIP_ATTR);
	if (!text) {
		return [];
	}
	const rows: IAgentTooltipRow[] = [{ label: text, shortcut: target.getAttribute(TOOLTIP_KB_ATTR) ?? undefined }];
	const extra = target.getAttribute(TOOLTIP_EXTRA_ATTR);
	if (extra) {
		rows.push({ label: extra, shortcut: target.getAttribute(TOOLTIP_EXTRA_KB_ATTR) ?? undefined });
	}
	return rows;
}

function ensureTooltipDelegate(doc: Document): ITooltipDelegate {
	let delegate = tooltipDelegates.get(doc);
	if (delegate) {
		return delegate;
	}
	delegate = { tooltip: new AgentTooltip(), current: undefined };
	tooltipDelegates.set(doc, delegate);
	const show = (target: HTMLElement) => {
		const rows = tooltipRowsFor(target);
		if (rows.length) {
			const placement = target.getAttribute(TOOLTIP_PLACEMENT_ATTR);
			const variant = target.getAttribute(TOOLTIP_VARIANT_ATTR);
			delegate!.tooltip.show(target, rows, {
				placement: placement === 'start' || placement === 'below' || placement === 'above' ? placement : undefined,
				variant: variant === 'pill' || variant === 'files' ? variant : undefined,
			});
		} else {
			delegate!.tooltip.hide();
		}
	};
	doc.addEventListener('mouseover', e => {
		const target = (e.target as Element | null)?.closest?.(`[${TOOLTIP_ATTR}]`) as HTMLElement | null;
		if (target === delegate!.current) {
			return;
		}
		if (!target && (e.target as Element | null)?.closest?.('.volt-agent-tooltip')) {
			return;
		}
		delegate!.current = target ?? undefined;
		if (target) {
			show(target);
		} else {
			delegate!.tooltip.hide();
		}
	}, true);
	doc.addEventListener('mousedown', e => {
		const onTooltip = (e.target as Element | null)?.closest?.('.volt-agent-tooltip');
		if (onTooltip && delegate!.current) {
			e.preventDefault();
			e.stopPropagation();
			const target = delegate!.current;
			delegate!.current = undefined;
			delegate!.tooltip.hide();
			target.click();
			return;
		}
		delegate!.current = undefined;
		delegate!.tooltip.hide();
	}, true);
	return delegate;
}

/**
 * Show the shared tooltip only when `element` is ellipsis-truncated, and only
 * after the pointer has stayed on it for `delayMs`.
 */
export function bindTruncatedHoverTooltip(element: HTMLElement, text: string, delayMs = 1000): IDisposable {
	const store = new DisposableStore();
	const win = getWindow(element);
	let timer: number | undefined;
	const clearTimer = () => {
		if (timer !== undefined) {
			win.clearTimeout(timer);
			timer = undefined;
		}
	};
	const hide = () => {
		clearTimer();
		element.removeAttribute(TOOLTIP_ATTR);
		const delegate = tooltipDelegates.get(element.ownerDocument);
		if (delegate?.current === element) {
			delegate.current = undefined;
			delegate.tooltip.hide();
		}
	};
	store.add(addDisposableListener(element, 'mouseenter', () => {
		clearTimer();
		timer = win.setTimeout(() => {
			timer = undefined;
			if (element.scrollWidth <= element.clientWidth + 1) {
				return;
			}
			const delegate = ensureTooltipDelegate(element.ownerDocument);
			element.setAttribute(TOOLTIP_ATTR, text);
			element.removeAttribute('title');
			delegate.current = element;
			delegate.tooltip.show(element, [{ label: text }]);
		}, delayMs);
	}));
	store.add(addDisposableListener(element, 'mouseleave', hide));
	store.add(toDisposable(hide));
	return store;
}

/**
 * Attach (or update) the shared styled tooltip on an element. Replaces the
 * native `title` attribute so every tooltip in the agent UI looks the same.
 * Optionally takes a formatted shortcut (see {@link formatAgentTooltipShortcut})
 * rendered as key chips next to the label, plus a second row for a modifier
 * variant of the same control (for example "⌥ Replace Agent").
 */
export function setAgentTooltip(element: HTMLElement, text: string | undefined | null, shortcut?: string, extra?: IAgentTooltipRow, placement?: AgentTooltipPlacement, variant?: AgentTooltipVariant): void {
	if (text) {
		element.setAttribute(TOOLTIP_ATTR, text);
		if (shortcut) {
			element.setAttribute(TOOLTIP_KB_ATTR, shortcut);
		} else {
			element.removeAttribute(TOOLTIP_KB_ATTR);
		}
		if (extra) {
			element.setAttribute(TOOLTIP_EXTRA_ATTR, extra.label);
			if (extra.shortcut) {
				element.setAttribute(TOOLTIP_EXTRA_KB_ATTR, extra.shortcut);
			} else {
				element.removeAttribute(TOOLTIP_EXTRA_KB_ATTR);
			}
		} else {
			element.removeAttribute(TOOLTIP_EXTRA_ATTR);
			element.removeAttribute(TOOLTIP_EXTRA_KB_ATTR);
		}
		if (placement) {
			element.setAttribute(TOOLTIP_PLACEMENT_ATTR, placement);
		} else {
			element.removeAttribute(TOOLTIP_PLACEMENT_ATTR);
		}
		if (variant && variant !== 'default') {
			element.setAttribute(TOOLTIP_VARIANT_ATTR, variant);
		} else {
			element.removeAttribute(TOOLTIP_VARIANT_ATTR);
		}
		element.removeAttribute('title');
		const delegate = ensureTooltipDelegate(element.ownerDocument);
		if (delegate.current === element) {
			delegate.tooltip.show(element, tooltipRowsFor(element), {
				placement,
				variant: variant === 'pill' || variant === 'files' ? variant : undefined,
			});
		}
	} else {
		element.removeAttribute(TOOLTIP_ATTR);
		element.removeAttribute(TOOLTIP_KB_ATTR);
		element.removeAttribute(TOOLTIP_EXTRA_ATTR);
		element.removeAttribute(TOOLTIP_EXTRA_KB_ATTR);
		element.removeAttribute(TOOLTIP_PLACEMENT_ATTR);
		element.removeAttribute(TOOLTIP_VARIANT_ATTR);
		const delegate = tooltipDelegates.get(element.ownerDocument);
		if (delegate?.current === element) {
			delegate.current = undefined;
			delegate.tooltip.hide();
		}
	}
}
