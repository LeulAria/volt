/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltTrustDialog.css';
import { $, addDisposableListener, append, EventType, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';

export interface IVoltTrustDialogOptions {
	readonly title: string;
	readonly subtitle: string;
	/** Folder or workspace path; omitted for empty windows. */
	readonly location?: string;
	readonly locationLabel: string;
	readonly trustLabel: string;
	readonly restrictedLabel: string;
	/** Label for the "trust the parent folder" switch; omitted when that is not possible. */
	readonly parentFolderLabel?: string;
	readonly learnMoreUrl?: string;
}

export interface IVoltTrustDialogResult {
	readonly trusted: boolean;
	readonly parentFolder: boolean;
}

/** `&&Yes` mnemonics belong to native dialogs; Volt buttons show plain labels. */
export function stripMnemonic(label: string): string {
	return label.replace(/&&/g, '');
}

/**
 * Volt's workspace trust sheet: a compact card in place of the stock shield dialog, with the folder
 * as an info row, what trust turns on, the parent-folder switch and two buttons. Same
 * outcomes as the stock prompt: trust (optionally the parent folder) or restricted mode. Escape
 * does nothing, as before (the stock prompt has no close action).
 */
export function showVoltTrustDialog(options: IVoltTrustDialogOptions, layoutService: ILayoutService, openerService: IOpenerService): Promise<IVoltTrustDialogResult> {
	const overlay = $('.volt-trust-overlay');
	try {
		return renderVoltTrustDialog(overlay, options, layoutService, openerService);
	} catch (error) {
		overlay.remove(); // half-built sheet: drop it so the stock prompt can show
		throw error;
	}
}

function renderVoltTrustDialog(overlay: HTMLElement, options: IVoltTrustDialogOptions, layoutService: ILayoutService, openerService: IOpenerService): Promise<IVoltTrustDialogResult> {
	const store = new DisposableStore();
	const previousFocus = getActiveElement();
	layoutService.activeContainer.appendChild(overlay);
	const card = append(overlay, $('.volt-trust-card', { role: 'dialog', 'aria-modal': 'true' }));

	// Header: folder-lock glyph, title, subtitle
	const header = append(card, $('.volt-trust-header'));
	append(header, createFolderLockIcon(card.ownerDocument));
	const headerText = append(header, $('.volt-trust-header-text'));
	const titleEl = append(headerText, $('.volt-trust-title', { id: 'volt-trust-title' }));
	titleEl.textContent = options.title;
	const subtitleEl = append(headerText, $('.volt-trust-subtitle', { id: 'volt-trust-subtitle' }));
	subtitleEl.textContent = options.subtitle;
	card.setAttribute('aria-labelledby', 'volt-trust-title');
	card.setAttribute('aria-describedby', 'volt-trust-subtitle');

	// Location: muted label, path in mono, truncated in the middle
	if (options.location) {
		const info = append(card, $('.volt-trust-info'));
		append(info, $('.volt-trust-label')).textContent = options.locationLabel;
		const path = append(info, $('.volt-trust-path', { title: options.location }));
		const cut = Math.max(0, options.location.lastIndexOf('/', options.location.length - 2));
		const head = cut > 0 ? options.location.slice(0, cut) : options.location;
		const tail = cut > 0 ? options.location.slice(cut) : '';
		append(path, $('span.volt-trust-path-head')).textContent = head;
		if (tail) {
			append(path, $('span.volt-trust-path-tail')).textContent = tail;
		}
	}

	// What trust turns on: three columns
	const sectionHead = append(card, $('.volt-trust-section-head'));
	append(sectionHead, $('.volt-trust-section-label')).textContent = localize('voltTrust.section', "Needs trust");
	const list = append(card, $('.volt-trust-rows', { role: 'list' }));
	const rows: Array<[string, string]> = [
		[localize('voltTrust.tasks', "Tasks and debugging"), localize('voltTrust.tasksDesc', "Build scripts and launch configurations")],
		[localize('voltTrust.extensions', "Extensions and agents"), localize('voltTrust.extensionsDesc', "Tools that can run code from this folder")],
		[localize('voltTrust.settings', "Workspace settings"), localize('voltTrust.settingsDesc', "Settings that point at programs to run")],
	];
	for (const [name, description] of rows) {
		const row = append(list, $('.volt-trust-row', { role: 'listitem' }));
		const text = append(row, $('.volt-trust-row-text'));
		append(text, $('.volt-trust-row-name')).textContent = name;
		append(text, $('.volt-trust-row-desc')).textContent = description;
	}

	// Footer: parent-folder switch on the left, buttons on the right
	const footer = append(card, $('.volt-trust-footer'));

	// Parent folder switch
	let parentFolder = false;
	let toggle: HTMLElement | undefined;
	if (options.parentFolderLabel) {
		const toggleRow = append(footer, $('.volt-trust-toggle-row'));
		const labelId = 'volt-trust-parent-label';
		toggle = append(toggleRow, $('button.volt-trust-switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': labelId }));
		append(toggle, $('span.volt-trust-switch-knob'));
		append(toggleRow, $('.volt-trust-toggle-label', { id: labelId })).textContent = options.parentFolderLabel;
		const flip = () => {
			parentFolder = !parentFolder;
			toggle!.setAttribute('aria-checked', String(parentFolder));
			toggle!.classList.toggle('checked', parentFolder);
		};
		store.add(addDisposableListener(toggleRow, EventType.CLICK, e => {
			e.preventDefault();
			flip();
		}));
	}

	// Buttons, primary last (macOS order)
	const actions = append(footer, $('.volt-trust-actions'));
	const restrictedButton = store.add(createVoltButton(actions, 'secondary', { title: false }));
	restrictedButton.label = options.restrictedLabel;
	restrictedButton.element.classList.add('volt-trust-secondary');
	const trustButton = store.add(createVoltButton(actions, 'primary', { title: false }));
	trustButton.label = options.trustLabel;
	trustButton.element.classList.add('volt-trust-primary');

	if (options.learnMoreUrl) {
		subtitleEl.append(' ');
		const link = append(subtitleEl, $('a.volt-trust-learn', { href: '#', role: 'link' }));
		link.textContent = localize('voltTrust.learnMore', "Learn more");
		const url = options.learnMoreUrl;
		store.add(addDisposableListener(link, EventType.CLICK, e => {
			e.preventDefault();
			openerService.open(URI.parse(url), { openExternal: true });
		}));
	}

	return new Promise<IVoltTrustDialogResult>(resolve => {
		const close = (trusted: boolean) => {
			store.dispose();
			overlay.remove();
			if (isHTMLElement(previousFocus) && previousFocus.isConnected) {
				previousFocus.focus();
			}
			resolve({ trusted, parentFolder: trusted && parentFolder });
		};
		store.add(trustButton.onDidClick(() => close(true)));
		store.add(restrictedButton.onDidClick(() => close(false)));

		// Modal: keys stay inside the card, Tab cycles its controls, Escape is ignored like before
		store.add(addDisposableListener(overlay, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Tab) || event.equals(KeyCode.Shift | KeyCode.Tab)) {
				const focusable = Array.from(card.querySelectorAll<HTMLElement>('button, a[href]'));
				const index = focusable.indexOf(getActiveElement() as HTMLElement);
				const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
				focusable[next]?.focus();
				event.preventDefault();
			} else if (event.equals(KeyCode.Escape)) {
				event.preventDefault();
			}
			e.stopPropagation();
		}));
		store.add(addDisposableListener(overlay, EventType.KEY_UP, e => e.stopPropagation()));
		store.add(addDisposableListener(overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === overlay) {
				e.preventDefault(); // clicks on the scrim keep focus in the card
			}
		}));

		trustButton.focus();
	});
}

/** Lucide `folder-lock` (AriaIcons), drawn at a 1.3px stroke without a tile. */
function createFolderLockIcon(doc: Document): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = doc.createElementNS(ns, 'svg');
	svg.classList.add('volt-trust-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	const rect = doc.createElementNS(ns, 'rect');
	for (const [name, value] of [['width', '8'], ['height', '5'], ['x', '14'], ['y', '17'], ['rx', '1']]) {
		rect.setAttribute(name, value);
	}
	svg.appendChild(rect);
	for (const d of ['M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5', 'M20 17v-2a2 2 0 1 0-4 0v2']) {
		const path = doc.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}
