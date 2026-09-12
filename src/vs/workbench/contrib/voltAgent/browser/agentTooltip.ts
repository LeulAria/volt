/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';

export interface IAgentTooltipRow {
	label: string;
	shortcut?: string;
}

export interface IAgentTooltipShowOptions {
	gap?: number;
	fontSource?: HTMLElement | (() => HTMLElement | null | undefined);
	placement?: 'above' | 'below';
	variant?: 'default' | 'pill';
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
		for (const row of rows) {
			const rowEl = append(this.domNode, $('.volt-agent-tooltip-row'));
			append(rowEl, $('span.volt-agent-tooltip-label')).textContent = row.label;
			if (row.shortcut) {
				append(rowEl, this.renderShortcut(row.shortcut, options?.variant === 'pill'));
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
		store.add(addDisposableListener(anchor, 'mouseenter', () => this.show(anchor, getRows(), options)));
		store.add(addDisposableListener(anchor, 'mouseleave', () => this.hide()));
		store.add(toDisposable(() => this.hide()));
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
	return [{ label: text, shortcut: target.getAttribute(TOOLTIP_KB_ATTR) ?? undefined }];
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
			delegate!.tooltip.show(target, rows);
		} else {
			delegate!.tooltip.hide();
		}
	};
	doc.addEventListener('mouseover', e => {
		const target = (e.target as Element | null)?.closest?.(`[${TOOLTIP_ATTR}]`) as HTMLElement | null;
		if (target === delegate!.current) {
			return;
		}
		delegate!.current = target ?? undefined;
		if (target) {
			show(target);
		} else {
			delegate!.tooltip.hide();
		}
	}, true);
	doc.addEventListener('mousedown', () => {
		delegate!.current = undefined;
		delegate!.tooltip.hide();
	}, true);
	return delegate;
}

/**
 * Attach (or update) the shared styled tooltip on an element. Replaces the
 * native `title` attribute so every tooltip in the agent UI looks the same.
 * Optionally takes a formatted shortcut (see {@link formatAgentTooltipShortcut})
 * rendered as key chips next to the label.
 */
export function setAgentTooltip(element: HTMLElement, text: string | undefined | null, shortcut?: string): void {
	if (text) {
		element.setAttribute(TOOLTIP_ATTR, text);
		if (shortcut) {
			element.setAttribute(TOOLTIP_KB_ATTR, shortcut);
		} else {
			element.removeAttribute(TOOLTIP_KB_ATTR);
		}
		element.removeAttribute('title');
		const delegate = ensureTooltipDelegate(element.ownerDocument);
		if (delegate.current === element) {
			delegate.tooltip.show(element, tooltipRowsFor(element));
		}
	} else {
		element.removeAttribute(TOOLTIP_ATTR);
		element.removeAttribute(TOOLTIP_KB_ATTR);
		const delegate = tooltipDelegates.get(element.ownerDocument);
		if (delegate?.current === element) {
			delegate.current = undefined;
			delegate.tooltip.hide();
		}
	}
}
