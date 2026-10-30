/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, markAsSingleton, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/** Codicon, or a factory so a card row can draw a custom SVG at show time. */
export type AgentTooltipIcon = ThemeIcon | (() => HTMLElement);

export interface IAgentTooltipRow {
	label: string;
	detail?: string;
	shortcut?: string;
	/** Card rows only: leading icon; the detail sits under the label. */
	icon?: AgentTooltipIcon;
	/** Card rows only: quieter label (e.g. folder path under the chat title). */
	muted?: boolean;
	/** Card rows only, without an icon: a "label … value" line (e.g. "Effort  High"). */
	value?: string;
	/** Card rows only: a hairline above the row. */
	separator?: boolean;
	/** Card rows only, without an icon: the label is a block of text that keeps its line breaks (a commit body). */
	body?: boolean;
	/**
	 * Card rows only: a block the caller draws in place of the row (a list widget, such as a
	 * chat's pull requests). Disposed when the card hides or draws again.
	 */
	render?: (parent: HTMLElement) => IDisposable;
	onClick?: () => void;
}

export type AgentTooltipPlacement = 'above' | 'below' | 'start' | 'end';

export type AgentTooltipVariant = 'default' | 'pill' | 'files' | 'card';

export interface IAgentTooltipShowOptions {
	gap?: number;
	fontSource?: HTMLElement | (() => HTMLElement | null | undefined);
	placement?: AgentTooltipPlacement;
	variant?: AgentTooltipVariant;
	/** Milliseconds the pointer must stay on the anchor before the tooltip appears. */
	delay?: number;
	/** A click anywhere on the tooltip runs this; it stays open while the pointer crosses to it. */
	onClick?: () => void;
	/**
	 * It stays open while the pointer crosses to it, to scroll or select its text. A function is
	 * asked when the pointer leaves (whether a row has pull requests is known only once they load).
	 */
	interactive?: boolean | (() => boolean);
	/** Long text stops at 300px and ends in an ellipsis (a whole queued prompt, say). */
	clamp?: boolean;
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

	private showHandle: number | undefined;
	private showWindow: Window | undefined;
	/**
	 * The pending hide after the pointer left an anchor (room to reach a clickable card). One for
	 * every anchor: moving onto the next row of a list cancels it, so the card stays up and moves.
	 */
	private hideHandle: number | undefined;
	private hideWindow: Window | undefined;
	/** The anchor the tooltip is shown for, or waits to show for. */
	private anchor: HTMLElement | undefined;
	/** What a click on the shown tooltip runs ({@link IAgentTooltipShowOptions.onClick}). */
	private click: (() => void) | undefined;
	/** The options the tooltip on screen was shown with; undefined while hidden. */
	private shownOptions: IAgentTooltipShowOptions | undefined;
	/** Blocks drawn by card rows ({@link IAgentTooltipRow.render}). */
	private readonly rendered = this._register(new DisposableStore());

	constructor() {
		super();
		this.domNode = $('.volt-agent-tooltip.hidden');
		this.domNode.setAttribute('role', 'tooltip');
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'mousedown', e => {
			const click = this.click;
			if (click) {
				e.preventDefault();
				e.stopPropagation();
				this.hide();
				click();
			}
		}));
	}

	private cancelScheduledHide(): void {
		if (this.hideHandle !== undefined) {
			this.hideWindow?.clearTimeout(this.hideHandle);
			this.hideHandle = undefined;
		}
	}

	private cancelScheduledShow(): void {
		if (this.showHandle !== undefined) {
			this.showWindow?.clearTimeout(this.showHandle);
			this.showHandle = undefined;
		}
	}

	show(anchor: HTMLElement, rows: readonly IAgentTooltipRow[], options?: IAgentTooltipShowOptions): void {
		this.anchor = anchor;
		this.shownOptions = options ?? {};
		this.rendered.clear();
		this.domNode.replaceChildren();
		this.domNode.classList.toggle('pill', options?.variant === 'pill');
		this.domNode.classList.toggle('files', options?.variant === 'files');
		this.domNode.classList.toggle('card', options?.variant === 'card');
		this.domNode.classList.toggle('beside', options?.placement === 'start' || options?.placement === 'end');
		this.domNode.classList.toggle('compact', anchor.getAttribute('data-volt-tooltip-compact') === '1');
		this.domNode.classList.toggle('clamped', !!options?.clamp);
		this.click = options?.onClick;
		this.domNode.classList.toggle('clickable', !!this.click);
		// A drawn block (a list) has no width of its own: the card takes its full width instead.
		this.domNode.classList.toggle('has-block', options?.variant === 'card' && rows.some(row => !!row.render));
		for (const row of rows) {
			if (options?.variant === 'card') {
				this.renderCardRow(row);
				continue;
			}
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

		// Measure at the origin: a fixed box left near the right edge from the last show would
		// shrink-to-fit into the leftover width and wrap a short label.
		this.domNode.style.left = '0px';
		this.domNode.style.top = '0px';
		this.domNode.classList.remove('hidden');
		const gap = options?.gap ?? 6;
		const rect = anchor.getBoundingClientRect();
		const width = this.domNode.offsetWidth;
		const height = this.domNode.offsetHeight;
		const win = getWindow(anchor);
		if (options?.placement === 'start' || options?.placement === 'end') {
			const preferred = options.placement === 'end' ? rect.right + gap : rect.left - width - gap;
			const fallback = options.placement === 'end' ? rect.left - width - gap : rect.right + gap;
			const fits = options.placement === 'end'
				? preferred + width <= win.innerWidth - 8
				: preferred >= 8;
			const left = Math.max(8, Math.min(fits ? preferred : fallback, win.innerWidth - width - 8));
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
		let top = options?.placement === 'below' || above < 8 ? below : above;
		if (top === below && below + height > win.innerHeight - 8 && above >= 8) {
			top = above;
		}
		top = Math.max(8, Math.min(top, win.innerHeight - height - 8));
		this.domNode.style.left = `${left}px`;
		this.domNode.style.top = `${top}px`;
	}

	hide(): void {
		this.cancelScheduledShow();
		this.anchor = undefined;
		this.shownOptions = undefined;
		this.domNode.classList.add('hidden');
		this.rendered.clear();
	}

	bind(anchor: HTMLElement, getRows: () => readonly IAgentTooltipRow[], options?: IAgentTooltipShowOptions): IDisposable {
		const store = new DisposableStore();
		const win = getWindow(anchor);
		const clearTimer = () => this.cancelScheduledHide();
		const hide = () => {
			clearTimer();
			this.cancelScheduledShow();
			// Room to cross the gap to a tooltip the pointer can use (a file list, a clickable card).
			// The card on screen decides: crossing another row on the way to it must not close it.
			const shown = this.shownOptions ?? options;
			const interactive = typeof shown?.interactive === 'function' ? shown.interactive() : shown?.interactive;
			if (shown?.variant === 'files' || shown?.onClick || interactive) {
				this.hideWindow = win;
				this.hideHandle = win.setTimeout(() => {
					this.hideHandle = undefined;
					this.hide();
				}, 160);
				return;
			}
			this.hide();
		};
		store.add(addDisposableListener(anchor, 'mouseenter', () => {
			clearTimer();
			this.cancelScheduledShow();
			const delay = options?.delay ?? 0;
			if (delay <= 0) {
				this.show(anchor, getRows(), options);
				return;
			}
			this.anchor = anchor;
			this.showWindow = win;
			this.showHandle = win.setTimeout(() => {
				this.showHandle = undefined;
				this.show(anchor, getRows(), options);
			}, delay);
		}));
		store.add(addDisposableListener(anchor, 'mouseleave', hide));
		store.add(addDisposableListener(this.domNode, 'mouseenter', clearTimer));
		store.add(addDisposableListener(this.domNode, 'mouseleave', hide));
		store.add(toDisposable(() => {
			// Another anchor's tooltip stays. So does this one's while the pointer is still on it:
			// a list rendering the row again binds it anew.
			if (this.anchor !== anchor || (anchor.isConnected && anchor.matches(':hover'))) {
				return;
			}
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

	/** A card: a title row, then icon rows whose detail sits under the label. */
	private renderCardRow(row: IAgentTooltipRow): void {
		if (row.separator) {
			append(this.domNode, $('.volt-agent-tooltip-card-sep'));
		}
		if (row.render) {
			this.rendered.add(row.render(append(this.domNode, $('.volt-agent-tooltip-card-block'))));
			return;
		}
		if (row.body && !row.icon) {
			append(this.domNode, $('.volt-agent-tooltip-card-body')).textContent = row.label;
			return;
		}
		if (!row.icon && (row.value !== undefined || row.shortcut)) {
			const line = append(this.domNode, $('.volt-agent-tooltip-card-line'));
			append(line, $('span.volt-agent-tooltip-label')).textContent = row.label;
			if (row.value !== undefined) {
				append(line, $('span.volt-agent-tooltip-card-value')).textContent = row.value;
			}
			if (row.shortcut) {
				append(line, this.renderShortcut(row.shortcut));
			}
			return;
		}
		if (!row.icon) {
			append(this.domNode, $('.volt-agent-tooltip-card-title')).textContent = row.label;
			return;
		}
		const rowEl = append(this.domNode, $('.volt-agent-tooltip-card-row'));
		rowEl.appendChild(renderCardIcon(row.icon));
		const text = append(rowEl, $('.volt-agent-tooltip-card-text'));
		const label = append(text, $('span.volt-agent-tooltip-label'));
		label.textContent = row.label;
		if (row.muted) {
			label.classList.add('muted');
		}
		if (row.detail) {
			append(text, $('span.volt-agent-tooltip-card-detail')).textContent = row.detail;
		}
	}

	private renderShortcut(shortcut: string, bare = false): HTMLElement {
		const el = $('span.volt-agent-tooltip-kb');
		for (const token of shortcut.split(/\s+/).filter(Boolean)) {
			append(el, $(bare ? 'span.symbol' : 'span.key')).textContent = token;
		}
		return el;
	}
}

function renderCardIcon(icon: AgentTooltipIcon): HTMLElement {
	const node = typeof icon === 'function' ? icon() : renderIcon(icon);
	node.classList.add('volt-agent-tooltip-card-icon');
	return node;
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
	// One delegate per document for the window's lifetime.
	delegate = { tooltip: markAsSingleton(new AgentTooltip()), current: undefined };
	tooltipDelegates.set(doc, delegate);
	const show = (target: HTMLElement) => {
		const rows = tooltipRowsFor(target);
		if (rows.length) {
			const placement = target.getAttribute(TOOLTIP_PLACEMENT_ATTR);
			const variant = target.getAttribute(TOOLTIP_VARIANT_ATTR);
			delegate!.tooltip.show(target, rows, {
				placement: placement === 'start' || placement === 'end' || placement === 'below' || placement === 'above' ? placement : undefined,
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
		if (!target && (e.target as Element | null)?.closest?.('.volt-agent-tooltip') === delegate!.tooltip.domNode) {
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
		// Only this delegate's tooltip: a click on another card (a chat's pull requests) is that card's own.
		const onTooltip = (e.target as Element | null)?.closest?.('.volt-agent-tooltip') === delegate!.tooltip.domNode;
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
/** More than a 300px clamped tooltip can show. */
const TRUNCATED_HOVER_MAX_CHARS = 1500;

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
			// The box shows at most 300px of it; no need to lay out a whole pasted document.
			delegate.tooltip.show(element, [{ label: text.length > TRUNCATED_HOVER_MAX_CHARS ? `${text.slice(0, TRUNCATED_HOVER_MAX_CHARS)}…` : text }], { clamp: true });
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
