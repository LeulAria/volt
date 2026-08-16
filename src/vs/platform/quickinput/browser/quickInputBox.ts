/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { FindInput } from '../../../base/browser/ui/findinput/findInput.js';
import { IInputBoxStyles, IRange, MessageType } from '../../../base/browser/ui/inputbox/inputBox.js';
import { IToggleStyles, Toggle } from '../../../base/browser/ui/toggle/toggle.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import Severity from '../../../base/common/severity.js';
import './media/quickInput.css';

const $ = dom.$;

export class QuickInputBox extends Disposable {

	private container: HTMLElement;
	private findInput: FindInput;

	constructor(
		private parent: HTMLElement,
		inputBoxStyles: IInputBoxStyles,
		toggleStyles: IToggleStyles
	) {
		super();
		this.container = dom.append(this.parent, $('.quick-input-box'));
		const searchIcon = dom.append(this.container, $('span.quick-input-search-icon'));
		searchIcon.setAttribute('aria-hidden', 'true');
		const svg = searchIcon.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('fill', 'none');
		const path = searchIcon.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M17 17L22 22M19.5 10.75C19.5 15.5825 15.5825 19.5 10.75 19.5C5.91751 19.5 2 15.5825 2 10.75C2 5.91751 5.91751 2 10.75 2C15.5825 2 19.5 5.91751 19.5 10.75Z');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		searchIcon.appendChild(svg);
		this.findInput = this._register(new FindInput(this.container, undefined, { label: '', inputBoxStyles, toggleStyles }));
		const input = this.findInput.inputBox.inputElement;
		input.role = 'textbox';
		input.ariaHasPopup = 'menu';
		input.ariaAutoComplete = 'list';
	}

	get onKeyDown() {
		return this.findInput.onKeyDown;
	}

	get onMouseDown() {
		return this.findInput.onMouseDown;
	}

	onDidChange = (handler: (event: string) => void): IDisposable => {
		return this.findInput.onDidChange(handler);
	};

	get value() {
		return this.findInput.getValue();
	}

	set value(value: string) {
		this.findInput.setValue(value);
	}

	select(range: IRange | null = null): void {
		this.findInput.inputBox.select(range);
	}

	getSelection(): IRange | null {
		return this.findInput.inputBox.getSelection();
	}

	isSelectionAtEnd(): boolean {
		return this.findInput.inputBox.isSelectionAtEnd();
	}

	setPlaceholder(placeholder: string): void {
		this.findInput.inputBox.setPlaceHolder(placeholder);
	}

	get placeholder() {
		return this.findInput.inputBox.inputElement.getAttribute('placeholder') || '';
	}

	set placeholder(placeholder: string) {
		this.findInput.inputBox.setPlaceHolder(placeholder);
	}

	get password() {
		return this.findInput.inputBox.inputElement.type === 'password';
	}

	set password(password: boolean) {
		this.findInput.inputBox.inputElement.type = password ? 'password' : 'text';
	}

	set enabled(enabled: boolean) {
		// We can't disable the input box because it is still used for
		// navigating the list. Instead, we disable the list and the OK
		// so that nothing can be selected.
		// TODO: should this be what we do for all find inputs? Or maybe some _other_ API
		// on findInput to change it to readonly?
		this.findInput.inputBox.inputElement.toggleAttribute('readonly', !enabled);
		// TODO: styles of the quick pick need to be moved to the CSS instead of being in line
		// so things like this can be done in CSS
		// this.findInput.inputBox.inputElement.classList.toggle('disabled', !enabled);
	}

	set toggles(toggles: Toggle[] | undefined) {
		this.findInput.setAdditionalToggles(toggles);
	}

	get ariaLabel(): string {
		return this.findInput.inputBox.inputElement.getAttribute('aria-label') || '';
	}

	set ariaLabel(ariaLabel: string) {
		this.findInput.inputBox.inputElement.setAttribute('aria-label', ariaLabel);
	}

	hasFocus(): boolean {
		return this.findInput.inputBox.hasFocus();
	}

	setAttribute(name: string, value: string): void {
		this.findInput.inputBox.inputElement.setAttribute(name, value);
	}

	removeAttribute(name: string): void {
		this.findInput.inputBox.inputElement.removeAttribute(name);
	}

	showDecoration(decoration: Severity): void {
		if (decoration === Severity.Ignore) {
			this.findInput.clearMessage();
		} else {
			this.findInput.showMessage({ type: decoration === Severity.Info ? MessageType.INFO : decoration === Severity.Warning ? MessageType.WARNING : MessageType.ERROR, content: '' });
		}
	}

	stylesForType(decoration: Severity) {
		return this.findInput.inputBox.stylesForType(decoration === Severity.Info ? MessageType.INFO : decoration === Severity.Warning ? MessageType.WARNING : MessageType.ERROR);
	}

	setFocus(): void {
		this.findInput.focus();
	}

	layout(): void {
		this.findInput.inputBox.layout();
	}
}
