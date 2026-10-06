/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { agentTooltipShortcutTokens, IAgentTooltipShortcut } from '../chrome/agentTooltip.js';
import { captureCitationSource, ICitationSource } from './agentCitationSource.js';

export interface IAgentThreadSelectionActionsDelegate {
	/** Whether this chat is the one on screen; a hidden chat ignores the shortcuts. */
	isVisible(): boolean;
	/** `source` is set when the selection lies in one assistant reply: the chip can lead back to it. */
	onAddToChat(text: string, source: ICitationSource | undefined): void;
	onAddToSideChat(text: string, source: ICitationSource | undefined): void;
}

type SelectionAction = (text: string, source: ICitationSource | undefined) => void;

const GAP_PX = 6;
const EDGE_PX = 8;

/**
 * The "Add to Chat / Add to Side Chat" bar over text selected in a chat transcript.
 * ⌘L and ⇧⌘S run the same actions while a selection is showing it.
 */
export class AgentThreadSelectionActions extends Disposable {

	private readonly domNode: HTMLElement;
	private readonly layoutFrame = this._register(new MutableDisposable());
	/** A drag is selecting: the bar waits for the pointer to lift. */
	private selecting = false;
	private text: string | undefined;
	private range: Range | undefined;

	constructor(
		private readonly thread: HTMLElement,
		private readonly delegate: IAgentThreadSelectionActionsDelegate,
	) {
		super();
		const doc = thread.ownerDocument;
		this.domNode = $('.volt-agent-thread-selection-actions');
		this.domNode.setAttribute('role', 'toolbar');
		this._register(toDisposable(() => this.domNode.remove()));
		this.addAction(localize('voltAgent.addToChat', "Add to Chat"), { meta: true, key: 'L' }, (text, source) => this.delegate.onAddToChat(text, source));
		append(this.domNode, $('span.volt-agent-thread-selection-divider'));
		this.addAction(localize('voltAgent.addToSideChat', "Add to Side Chat"), { meta: true, shift: true, key: 'S' }, (text, source) => this.delegate.onAddToSideChat(text, source));
		this.hide();

		const win = getWindow(thread);
		this._register(addDisposableListener(doc, 'selectionchange', () => this.scheduleLayout()));
		this._register(addDisposableListener(thread, 'pointerdown', e => {
			if (e.button === 0) {
				this.selecting = true;
				this.hide();
			}
		}));
		this._register(addDisposableListener(win, 'pointerup', () => {
			if (this.selecting) {
				this.selecting = false;
				this.scheduleLayout();
			}
		}, true));
		this._register(addDisposableListener(thread, 'scroll', () => this.scheduleLayout(), true));
		this._register(addDisposableListener(win, 'resize', () => this.scheduleLayout()));
		this._register(addDisposableListener(win, 'keydown', e => this.onKeyDown(e), true));
	}

	private addAction(label: string, shortcut: IAgentTooltipShortcut, run: SelectionAction): void {
		const button = append(this.domNode, $('span.volt-agent-thread-selection-action'));
		button.setAttribute('role', 'button');
		append(button, $('span.volt-agent-thread-selection-label')).textContent = label;
		const keys = append(button, $('span.volt-agent-thread-selection-keys'));
		for (const token of agentTooltipShortcutTokens(shortcut)) {
			append(keys, $('span.volt-agent-thread-selection-key')).textContent = token;
		}
		// mousedown, not click: a click would collapse the selection first.
		this._register(addDisposableListener(button, 'mousedown', e => {
			e.preventDefault();
			e.stopPropagation();
			this.run(run);
		}));
	}

	private run(action: SelectionAction): void {
		const text = this.text;
		if (!text) {
			return;
		}
		// Read before the selection is cleared: the range collapses with it.
		const source = this.range ? captureCitationSource(this.range, this.thread) : undefined;
		getWindow(this.thread).getSelection()?.removeAllRanges();
		this.hide();
		action(text, source);
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (!this.text || !this.delegate.isVisible() || e.altKey || !(e.metaKey || e.ctrlKey)) {
			return;
		}
		const key = e.key.toLowerCase();
		if (key === 'l' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			this.run((text, source) => this.delegate.onAddToChat(text, source));
		} else if (key === 's' && e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			this.run((text, source) => this.delegate.onAddToSideChat(text, source));
		}
	}

	private scheduleLayout(): void {
		this.layoutFrame.value = scheduleAtNextAnimationFrame(getWindow(this.thread), () => this.layout());
	}

	/** The selected range when it lies in the transcript, outside any editor or input. */
	private selectedRange(): Range | undefined {
		const selection = getWindow(this.thread).getSelection();
		if (!selection || selection.isCollapsed || !selection.rangeCount) {
			return undefined;
		}
		const { anchorNode, focusNode } = selection;
		if (!anchorNode || !focusNode || !this.thread.contains(anchorNode) || !this.thread.contains(focusNode)) {
			return undefined;
		}
		const anchor = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
		if (anchor?.closest('.monaco-editor, textarea, input, [contenteditable="true"]')) {
			return undefined;
		}
		return selection.getRangeAt(0);
	}

	private layout(): void {
		const range = this.selecting || !this.delegate.isVisible() ? undefined : this.selectedRange();
		const text = range?.toString().trim();
		if (!range || !text) {
			this.hide();
			return;
		}
		const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
		const first = rects[0] ?? range.getBoundingClientRect();
		const last = rects.at(-1) ?? first;
		const bounds = this.thread.getBoundingClientRect();
		// Off the visible transcript: nothing to point at.
		if (last.bottom < bounds.top || first.top > bounds.bottom) {
			this.hide();
			return;
		}
		this.text = text;
		this.range = range.cloneRange();
		// In the workbench, not <body>: it takes the theme's colors and font from there.
		const root = this.thread.closest<HTMLElement>('.monaco-workbench');
		if (root && this.domNode.parentElement !== root) {
			root.appendChild(this.domNode);
		}
		this.domNode.classList.add('visible');
		const width = this.domNode.offsetWidth;
		const height = this.domNode.offsetHeight;
		let top = first.top - height - GAP_PX;
		if (top < bounds.top + EDGE_PX) {
			top = last.bottom + GAP_PX;
		}
		const maxLeft = bounds.right - width - EDGE_PX;
		const left = Math.max(bounds.left + EDGE_PX, Math.min(first.left, maxLeft));
		this.domNode.style.left = `${Math.round(left)}px`;
		this.domNode.style.top = `${Math.round(top)}px`;
	}

	private hide(): void {
		this.text = undefined;
		this.range = undefined;
		this.domNode.classList.remove('visible');
	}
}
