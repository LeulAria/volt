/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { BrowserAgentComposer } from './browserComposer.js';
import { commentPreviewText } from './browserComments.js';

export interface IBrowserCommentCardOptions {
	index: number;
	preview: string;
	selectionLabel: string;
	onOpen(): void;
	createComposer(): BrowserAgentComposer;
	seed(composer: BrowserAgentComposer): void;
}

/**
 * One pinned browser comment. Collapsed it is a number bubble. Expanded it
 * keeps its own composer, separate from every other pin.
 */
export class BrowserCommentCard extends Disposable {

	readonly element: HTMLElement;

	private readonly badge: HTMLButtonElement;
	private readonly body: HTMLButtonElement;
	private readonly selectionLabel: string;
	private composer: BrowserAgentComposer | undefined;
	private seeded = false;
	private _expanded = false;
	private index: number;

	constructor(private readonly options: IBrowserCommentCardOptions) {
		super();
		this.index = options.index;
		this.selectionLabel = options.selectionLabel;
		this.element = $('.volt-browser-comment');
		this.badge = $('button.volt-browser-comment-badge') as HTMLButtonElement;
		this.badge.type = 'button';
		this.body = $('button.volt-browser-comment-body') as HTMLButtonElement;
		this.body.type = 'button';
		this.element.appendChild(this.badge);
		this.element.appendChild(this.body);
		this.setIndex(options.index);
		this.renderPreview(options.preview);
		this._register(addDisposableListener(this.element, 'pointerdown', e => {
			e.stopPropagation();
		}));
		const open = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this._expanded) {
				this.options.onOpen();
			}
		};
		this._register(addDisposableListener(this.badge, 'click', open));
		this._register(addDisposableListener(this.body, 'click', open));
	}

	get expanded(): boolean {
		return this._expanded;
	}

	get input(): BrowserAgentComposer | undefined {
		return this.composer;
	}

	setIndex(index: number): void {
		this.index = index;
		this.badge.textContent = String(index);
		this.badge.setAttribute('aria-label', localize('voltBrowser.openCommentNumber', "Open comment {0}", index));
	}

	expand(): void {
		if (this._expanded) {
			this.composer?.focus();
			return;
		}
		this._expanded = true;
		this.element.classList.add('expanded');
		const composer = this.ensureComposer();
		composer.layout();
		composer.focus();
	}

	collapse(): void {
		if (!this._expanded) {
			return;
		}
		if (this.composer) {
			this.renderPreview(commentPreviewText(this.composer.getDisplayText(), this.selectionLabel));
			this.composer.blur();
		}
		this._expanded = false;
		this.element.classList.remove('expanded');
	}

	layout(): void {
		this.composer?.layout();
	}

	focus(): void {
		this.composer?.focus();
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	private renderPreview(text: string): void {
		const shown = text.trim() || this.selectionLabel || String(this.index);
		this.body.textContent = shown;
		this.body.title = shown;
	}

	private ensureComposer(): BrowserAgentComposer {
		if (!this.composer) {
			this.composer = this._register(this.options.createComposer());
			this.element.appendChild(this.composer.element);
		}
		if (!this.seeded) {
			this.seeded = true;
			this.options.seed(this.composer);
		}
		return this.composer;
	}
}
