/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';

export interface IVoltModalOptions {
	readonly title: string;
	readonly subtitle?: string;
	readonly width?: number;
	readonly height?: number;
	readonly className?: string;
	/** No title bar or close button: the body fills the panel, and the title is only its label. */
	readonly headless?: boolean;
	/** Builds the body. The returned disposable is released when the modal closes. */
	readonly render: (body: HTMLElement, close: () => void) => IDisposable;
	readonly onDidClose?: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * A centred dialog inside the workbench window. The dim backdrop and the panel are separate
 * layers: the backdrop holds nothing that scrolls, and the panel is opaque and paint-contained,
 * which keeps the see-through agent window from smearing (see the volt-transparent-window skill).
 */
export function showVoltModal(layoutService: ILayoutService, options: IVoltModalOptions): IDisposable {
	const store = new DisposableStore();
	const container = layoutService.activeContainer;
	const previousFocus = getActiveElement();

	const backdrop = append(container, $('.volt-modal-backdrop'));
	const panel = append(container, $('.volt-modal'));
	if (options.className) {
		panel.classList.add(...options.className.split(' '));
	}
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-label', options.title);
	panel.tabIndex = -1;
	panel.style.width = `min(${options.width ?? 760}px, calc(100% - 32px))`;
	panel.style.height = `min(${options.height ?? 520}px, calc(100% - 48px))`;

	let closeButton: HTMLButtonElement | undefined;
	if (!options.headless) {
		const header = append(panel, $('.volt-modal-header'));
		const titles = append(header, $('.volt-modal-titles'));
		append(titles, $('.volt-modal-title')).textContent = options.title;
		if (options.subtitle) {
			append(titles, $('.volt-modal-subtitle')).textContent = options.subtitle;
		}
		closeButton = append(header, $('button.volt-modal-close')) as HTMLButtonElement;
		closeButton.type = 'button';
		closeButton.setAttribute('aria-label', localize('voltModal.close', "Close"));
		closeButton.appendChild(renderIcon(Codicon.close));
	}
	const body = append(panel, $('.volt-modal-body'));

	let closed = false;
	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		store.dispose();
	};

	store.add(toDisposable(() => {
		backdrop.remove();
		panel.remove();
		options.onDidClose?.();
		if (isHTMLElement(previousFocus) && previousFocus.isConnected) {
			previousFocus.focus();
		}
	}));
	store.add(addDisposableListener(backdrop, 'mousedown', e => {
		EventHelper.stop(e, true);
		close();
	}));
	if (closeButton) {
		store.add(addDisposableListener(closeButton, 'click', e => {
			EventHelper.stop(e, true);
			close();
		}));
	}
	store.add(addDisposableListener(panel, 'keydown', e => {
		const event = new StandardKeyboardEvent(e);
		if (event.keyCode === KeyCode.Escape && !e.defaultPrevented) {
			EventHelper.stop(e, true);
			close();
		} else if (event.keyCode === KeyCode.Tab) {
			// Keep Tab inside the dialog.
			const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null);
			if (!focusable.length) {
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = getActiveElement();
			if (event.shiftKey && (active === first || !panel.contains(active))) {
				EventHelper.stop(e, true);
				last.focus();
			} else if (!event.shiftKey && active === last) {
				EventHelper.stop(e, true);
				first.focus();
			}
		}
	}));
	// Keystrokes stay in the dialog instead of reaching workbench keybindings.
	store.add(addDisposableListener(panel, 'keydown', e => e.stopPropagation()));
	store.add(options.render(body, close));
	if (!panel.contains(getActiveElement())) {
		panel.focus();
	}
	return toDisposable(close);
}
