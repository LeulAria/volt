/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { isValidItemName } from './agentCustomize.js';

export interface IAgentCustomizeInputDialogOptions {
	/** "New User Subagent". */
	readonly title: string;
	/** "Enter a name for the new subagent". */
	readonly subtitle?: string;
	readonly placeholder?: string;
	readonly value?: string;
	readonly confirmLabel?: string;
	/** A message to show under the field, or undefined when the value is acceptable. */
	readonly validate?: (value: string) => string | undefined;
	/** Runs on Confirm; a thrown error is shown under the field and the dialog stays open. */
	readonly onConfirm?: (value: string) => Promise<void> | void;
}

/** The message shown for a name Cursor and Claude would refuse. */
export function itemNameError(value: string): string | undefined {
	if (!value) {
		return undefined;
	}
	return isValidItemName(value)
		? undefined
		: localize('voltCustomize.nameRule', "Use lowercase letters, numbers, and hyphens (must start with a letter or number)");
}

/**
 * A small modal over a dimmed window, like Cursor's "New User Subagent": a title, a hint, one
 * field with live validation, Cancel (Esc) and Confirm (Enter). Resolves with the value, or
 * undefined when cancelled.
 */
export function showCustomizeInputDialog(host: HTMLElement, options: IAgentCustomizeInputDialogOptions): Promise<string | undefined> {
	return new Promise(resolve => {
		const store = new DisposableStore();
		const previousFocus = getActiveElement();
		const overlay = append(host, $('.volt-customize-dialog-overlay'));
		const dialog = append(overlay, $('.volt-customize-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', options.title);

		const body = append(dialog, $('.volt-customize-dialog-body'));
		append(body, $('.volt-customize-dialog-title')).textContent = options.title;
		if (options.subtitle) {
			append(body, $('.volt-customize-dialog-subtitle')).textContent = options.subtitle;
		}
		const input = append(body, $('input.volt-customize-dialog-input')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.placeholder = options.placeholder ?? '';
		input.value = options.value ?? '';
		input.setAttribute('aria-label', options.subtitle ?? options.title);
		const error = append(body, $('.volt-customize-dialog-error'));
		error.setAttribute('role', 'alert');

		const footer = append(dialog, $('.volt-customize-dialog-footer'));
		const cancel = append(footer, $('button.volt-customize-dialog-cancel')) as HTMLButtonElement;
		cancel.type = 'button';
		append(cancel, $('span')).textContent = localize('voltCustomize.cancel', "Cancel");
		append(cancel, $('span.key')).textContent = 'Esc';
		const confirm = append(footer, $('button.volt-customize-dialog-confirm')) as HTMLButtonElement;
		confirm.type = 'button';
		confirm.textContent = options.confirmLabel ?? localize('voltCustomize.confirm', "Confirm");

		let busy = false;
		let done = false;
		const finish = (value: string | undefined) => {
			if (done) {
				return;
			}
			done = true;
			store.dispose();
			overlay.remove();
			if (isHTMLElement(previousFocus) && previousFocus.isConnected) {
				previousFocus.focus();
			}
			resolve(value);
		};
		const validate = (): string | undefined => options.validate?.(input.value.trim());
		const sync = () => {
			const message = validate();
			error.textContent = message ?? '';
			dialog.classList.toggle('invalid', !!message);
			confirm.disabled = busy || !!message || !input.value.trim();
		};
		const submit = async () => {
			const value = input.value.trim();
			if (busy || !value || validate()) {
				sync();
				return;
			}
			if (!options.onConfirm) {
				finish(value);
				return;
			}
			busy = true;
			confirm.disabled = true;
			dialog.classList.add('busy');
			try {
				await options.onConfirm(value);
				finish(value);
			} catch (err) {
				busy = false;
				dialog.classList.remove('busy');
				error.textContent = err instanceof Error ? err.message : String(err);
				dialog.classList.add('invalid');
				confirm.disabled = false;
			}
		};

		store.add(addDisposableListener(input, 'input', sync));
		store.add(addDisposableListener(dialog, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finish(undefined);
			} else if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				e.stopPropagation();
				void submit();
			} else if (e.key === 'Tab') {
				// Keep focus inside the dialog.
				const focusable = [input, cancel, confirm].filter(element => !element.disabled);
				const index = focusable.indexOf(getActiveElement() as HTMLInputElement & HTMLButtonElement);
				const next = focusable[(index + (e.shiftKey ? focusable.length - 1 : 1)) % focusable.length];
				if (next) {
					e.preventDefault();
					next.focus();
				}
			}
		}));
		store.add(addDisposableListener(cancel, 'click', () => finish(undefined)));
		store.add(addDisposableListener(confirm, 'click', () => void submit()));
		store.add(addDisposableListener(overlay, 'mousedown', e => {
			if (e.target === overlay) {
				e.preventDefault();
				finish(undefined);
			}
		}));
		sync();
		input.focus();
		input.select();
	});
}

export interface IAgentCustomizeConfirmOptions {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel: string;
	readonly destructive?: boolean;
}

/** A confirm in the same style as the name dialog. Resolves true on Confirm. */
export function showCustomizeConfirmDialog(host: HTMLElement, options: IAgentCustomizeConfirmOptions): Promise<boolean> {
	return new Promise(resolve => {
		const store = new DisposableStore();
		const previousFocus = getActiveElement();
		const overlay = append(host, $('.volt-customize-dialog-overlay'));
		const dialog = append(overlay, $('.volt-customize-dialog'));
		dialog.setAttribute('role', 'alertdialog');
		dialog.setAttribute('aria-modal', 'true');
		const body = append(dialog, $('.volt-customize-dialog-body'));
		append(body, $('.volt-customize-dialog-title')).textContent = options.title;
		append(body, $('.volt-customize-dialog-subtitle')).textContent = options.message;
		const footer = append(dialog, $('.volt-customize-dialog-footer'));
		const cancel = append(footer, $('button.volt-customize-dialog-cancel')) as HTMLButtonElement;
		cancel.type = 'button';
		append(cancel, $('span')).textContent = localize('voltCustomize.cancel', "Cancel");
		append(cancel, $('span.key')).textContent = 'Esc';
		const confirm = append(footer, $('button.volt-customize-dialog-confirm')) as HTMLButtonElement;
		confirm.type = 'button';
		confirm.classList.toggle('destructive', !!options.destructive);
		confirm.textContent = options.confirmLabel;
		const finish = (value: boolean) => {
			store.dispose();
			overlay.remove();
			if (isHTMLElement(previousFocus) && previousFocus.isConnected) {
				previousFocus.focus();
			}
			resolve(value);
		};
		store.add(addDisposableListener(dialog, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finish(false);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				finish(true);
			}
		}));
		store.add(addDisposableListener(cancel, 'click', () => finish(false)));
		store.add(addDisposableListener(confirm, 'click', () => finish(true)));
		store.add(addDisposableListener(overlay, 'mousedown', e => {
			if (e.target === overlay) {
				e.preventDefault();
				finish(false);
			}
		}));
		confirm.focus();
	});
}
