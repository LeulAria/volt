/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

/** Small DOM pieces the Automations pages share: same sizes, same states everywhere. */

export function button(parent: HTMLElement, className: string, label: string, store: DisposableStore, onClick: (e: MouseEvent) => void, icon?: ThemeIcon | (() => Element)): HTMLButtonElement {
	const element = append(parent, $(`button.${className}`)) as HTMLButtonElement;
	element.type = 'button';
	if (icon) {
		element.appendChild(typeof icon === 'function' ? icon() : renderIcon(icon));
	}
	if (label) {
		append(element, $('span.label')).textContent = label;
	}
	store.add(addDisposableListener(element, 'click', e => {
		e.stopPropagation();
		if (!element.disabled) {
			onClick(e);
		}
	}));
	return element;
}

export function iconButton(parent: HTMLElement, icon: ThemeIcon | (() => Element), label: string, store: DisposableStore, onClick: (e: MouseEvent) => void, className = 'volt-auto-icon-button'): HTMLButtonElement {
	const element = button(parent, className, '', store, onClick, icon);
	element.setAttribute('aria-label', label);
	setAgentTooltip(element, label);
	return element;
}

/** The round on/off switch (green when on). */
export function toggleSwitch(parent: HTMLElement, on: boolean, label: string, store: DisposableStore, onChange: (on: boolean) => void): HTMLButtonElement {
	const element = append(parent, $('button.volt-auto-switch')) as HTMLButtonElement;
	element.type = 'button';
	element.setAttribute('role', 'switch');
	element.setAttribute('aria-label', label);
	append(element, $('span.thumb'));
	const sync = (value: boolean) => {
		element.classList.toggle('on', value);
		element.setAttribute('aria-checked', String(value));
	};
	sync(on);
	store.add(addDisposableListener(element, 'click', e => {
		e.stopPropagation();
		const next = !element.classList.contains('on');
		sync(next);
		onChange(next);
	}));
	return element;
}

/** Pill tabs ("Mine · Team", "Settings · Run History"). */
export function pillTabs<T extends string>(parent: HTMLElement, tabs: readonly { readonly id: T; readonly label: string }[], active: T, store: DisposableStore, onPick: (id: T) => void, className = ''): HTMLElement {
	const row = append(parent, $(`.volt-auto-tabs${className ? `.${className}` : ''}`));
	row.setAttribute('role', 'tablist');
	for (const tab of tabs) {
		const element = append(row, $('button.volt-auto-tab')) as HTMLButtonElement;
		element.type = 'button';
		element.setAttribute('role', 'tab');
		element.textContent = tab.label;
		element.classList.toggle('active', tab.id === active);
		element.setAttribute('aria-selected', String(tab.id === active));
		store.add(addDisposableListener(element, 'click', () => {
			for (const sibling of row.children) {
				sibling.classList.toggle('active', sibling === element);
				sibling.setAttribute('aria-selected', String(sibling === element));
			}
			onPick(tab.id);
		}));
	}
	return row;
}

/** "Automations > Find critical bugs > Runs"; every part but the last navigates. */
export function breadcrumb(parent: HTMLElement, parts: readonly { readonly label: string; readonly onClick?: () => void }[], store: DisposableStore): HTMLElement {
	const nav = append(parent, $('nav.volt-auto-breadcrumb'));
	nav.setAttribute('aria-label', localize('voltAutomations.breadcrumb', "Breadcrumb"));
	parts.forEach((part, index) => {
		if (index) {
			append(nav, $('span.sep')).appendChild(renderIcon(Codicon.chevronRight));
		}
		const last = index === parts.length - 1;
		const element = append(nav, $(last ? 'span.crumb.current' : 'a.crumb'));
		element.textContent = part.label;
		if (!last && part.onClick) {
			element.tabIndex = 0;
			const go = part.onClick;
			store.add(addDisposableListener(element, 'click', () => go()));
			store.add(addDisposableListener(element, 'keydown', e => {
				if (e.key === 'Enter') {
					go();
				}
			}));
		}
	});
	return nav;
}

export function sectionLabel(parent: HTMLElement, text: string): HTMLElement {
	const element = append(parent, $('.volt-auto-section-label'));
	element.textContent = text;
	return element;
}

/** A labelled field for dialogs: the label above, the control appended by the caller. */
export function field(parent: HTMLElement, label: string): HTMLElement {
	const box = append(parent, $('.volt-auto-field'));
	append(box, $('label.volt-auto-field-label')).textContent = label;
	return box;
}

export interface IAutomationDialog extends IDisposable {
	readonly body: HTMLElement;
	readonly footer: HTMLElement;
	readonly store: DisposableStore;
	close(): void;
}

/** The dialog on screen; opening another replaces it. */
let openDialog: IAutomationDialog | undefined;

/**
 * A modal card in the Automations look (Memory Notes, tool setup): title, muted subtitle, a rule,
 * the body, buttons at the bottom right. Escape and the close button dismiss it; focus stays in.
 */
export function showAutomationDialog(host: HTMLElement, title: string, subtitle: string | undefined, className = ''): IAutomationDialog {
	openDialog?.dispose();
	const store = new DisposableStore();
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const layer = append(host, $('.volt-auto-dialog-layer'));
	const backdrop = append(layer, $('.volt-auto-dialog-backdrop'));
	const card = append(layer, $(`.volt-auto-dialog${className ? `.${className}` : ''}`));
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');
	card.tabIndex = -1;
	const head = append(card, $('.volt-auto-dialog-head'));
	const heading = append(head, $('h2.volt-auto-dialog-title'));
	heading.textContent = title;
	heading.id = `volt-auto-dialog-${Date.now()}`;
	card.setAttribute('aria-labelledby', heading.id);
	if (subtitle) {
		append(head, $('p.volt-auto-dialog-subtitle')).textContent = subtitle;
	}
	const body = append(card, $('.volt-auto-dialog-body'));
	const footer = append(card, $('.volt-auto-dialog-footer'));
	const dialog: IAutomationDialog = {
		body,
		footer,
		store,
		close: () => store.dispose(),
		dispose: () => store.dispose(),
	};
	iconButton(card, Codicon.close, localize('voltAutomations.close', "Close"), store, () => dialog.close(), 'volt-auto-dialog-close');
	store.add(toDisposable(() => {
		layer.remove();
		if (openDialog === dialog) {
			openDialog = undefined;
		}
		previousFocus?.focus?.();
	}));
	store.add(addDisposableListener(backdrop, 'mousedown', () => dialog.close()));
	store.add(addDisposableListener(card, 'keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			dialog.close();
		} else if (e.key === 'Tab') {
			const stops = [...card.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]')]
				.filter(element => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0);
			const index = stops.indexOf(e.target as HTMLElement);
			const next = e.shiftKey ? (index <= 0 ? stops.at(-1) : undefined) : (index === -1 || index === stops.length - 1 ? stops[0] : undefined);
			if (next) {
				e.preventDefault();
				next.focus();
			}
		}
	}));
	openDialog = dialog;
	window.requestAnimationFrame(() => (card.querySelector<HTMLElement>('input, textarea, select') ?? card).focus());
	return dialog;
}

/** "Copied" for a moment on the button that copied. */
export function flashLabel(element: HTMLElement, text: string, ms = 1200): void {
	const label = element.querySelector('.label') ?? element;
	const before = label.textContent;
	label.textContent = text;
	getWindow(element).setTimeout(() => label.textContent = before, ms);
}
