/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltAboutDialog.css';
import { $, addDisposableListener, append, EventType, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

export interface IVoltAboutDialogOptions {
	readonly title: string;
	/** The stock `Key: value` lines (createNativeAboutDialogDetails / createBrowserAboutDialogDetails). */
	readonly details: string;
	readonly copy: () => void;
}

/** Values the stock details print when a build does not stamp them; Volt leaves those rows out. */
const MISSING_VALUES = new Set(['', 'unknown', 'undefined']);

/**
 * Volt's About sheet, drawn like the workspace trust sheet (contrib/workspace/browser/voltTrustDialog.ts):
 * the Volt mark, name and version on top, the build details as label/value rows, Copy and OK.
 * Copy keeps the sheet open and says so; Escape, Enter and OK close it.
 */
export function showVoltAboutDialog(container: HTMLElement, options: IVoltAboutDialogOptions): Promise<void> {
	const overlay = $('.volt-about-overlay');
	try {
		return renderVoltAboutDialog(container, overlay, options);
	} catch (error) {
		overlay.remove(); // half-built sheet: drop it so the stock dialog can show
		throw error;
	}
}

function renderVoltAboutDialog(container: HTMLElement, overlay: HTMLElement, options: IVoltAboutDialogOptions): Promise<void> {
	const store = new DisposableStore();
	const previousFocus = getActiveElement();
	container.appendChild(overlay);
	const card = append(overlay, $('.volt-about-card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'volt-about-title' }));

	const rows = parseDetails(options.details);
	const versionIndex = rows.findIndex(([label]) => label === 'Version');
	const version = versionIndex >= 0 ? rows.splice(versionIndex, 1)[0][1] : undefined;

	// Header: the Volt mark, the product name, the version and what it is built on
	const header = append(card, $('.volt-about-header'));
	append(header, $('.volt-about-mark', { 'aria-hidden': 'true' }));
	append(header, $('.volt-about-title', { id: 'volt-about-title' })).textContent = options.title;
	if (version) {
		const match = /^(\S+)\s*\(([^)]+)\)\s*(.*)$/.exec(version);
		const versionEl = append(header, $('.volt-about-version'));
		append(versionEl, $('span.volt-about-version-number')).textContent = match ? `${match[1]}${match[3] ? ` ${match[3]}` : ''}` : version;
		if (match) {
			append(versionEl, $('span.volt-about-version-base')).textContent = match[2];
		}
	}

	// Build details: muted label, value in mono, selectable
	if (rows.length) {
		const list = append(card, $('.volt-about-rows', { role: 'list' }));
		for (const [label, value] of rows) {
			const row = append(list, $('.volt-about-row', { role: 'listitem' }));
			append(row, $('.volt-about-label')).textContent = label;
			append(row, $('.volt-about-value', { title: value })).textContent = value;
		}
	}

	// Buttons, primary last (macOS order)
	const actions = append(card, $('.volt-about-actions'));
	const copyLabel = localize('voltAbout.copy', "Copy Details");
	const copyButton = append(actions, $<HTMLButtonElement>('button.volt-button.volt-button-secondary.volt-about-button', { type: 'button' }));
	copyButton.textContent = copyLabel;
	const okButton = append(actions, $<HTMLButtonElement>('button.volt-button.volt-button-primary.volt-about-button', { type: 'button' }));
	okButton.textContent = localize('voltAbout.ok', "OK");

	return new Promise<void>(resolve => {
		const close = () => {
			store.dispose();
			overlay.remove();
			if (isHTMLElement(previousFocus) && previousFocus.isConnected) {
				previousFocus.focus();
			}
			resolve();
		};

		let copiedTimer: ReturnType<typeof setTimeout> | undefined;
		store.add(toDisposable(() => clearTimeout(copiedTimer)));
		store.add(addDisposableListener(copyButton, EventType.CLICK, () => {
			options.copy();
			copyButton.textContent = localize('voltAbout.copied', "Copied");
			copyButton.classList.add('copied');
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copyButton.textContent = copyLabel;
				copyButton.classList.remove('copied');
			}, 1400);
		}));
		store.add(addDisposableListener(okButton, EventType.CLICK, close));

		// Modal: keys stay inside the card, Tab cycles its buttons, Escape closes
		store.add(addDisposableListener(overlay, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Tab) || event.equals(KeyCode.Shift | KeyCode.Tab)) {
				const focusable = [copyButton, okButton];
				const index = focusable.indexOf(getActiveElement() as HTMLButtonElement);
				const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
				focusable[next].focus();
				event.preventDefault();
			} else if (event.equals(KeyCode.Escape)) {
				event.preventDefault();
				close();
			}
			e.stopPropagation();
		}));
		store.add(addDisposableListener(overlay, EventType.KEY_UP, e => e.stopPropagation()));
		store.add(addDisposableListener(overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === overlay) {
				e.preventDefault(); // clicks on the scrim keep focus in the card
			}
		}));

		okButton.focus();
	});
}

function parseDetails(details: string): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	for (const line of details.split('\n')) {
		const colon = line.indexOf(':');
		if (colon <= 0) {
			continue;
		}
		const label = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!MISSING_VALUES.has(value.toLowerCase())) {
			rows.push([label === 'ElectronBuildId' ? 'Electron build' : label, value]);
		}
	}
	return rows;
}
