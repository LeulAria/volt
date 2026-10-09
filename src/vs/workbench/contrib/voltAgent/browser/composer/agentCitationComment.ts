/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getDomNodePagePosition, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

export interface ICitationCommentOptions {
	/** The chip being commented on; the editor opens under it. */
	readonly anchor: HTMLElement;
	readonly quote: string;
	readonly comment?: string;
	/** Enter: the new comment (empty removes it). Escape or a click outside changes nothing. */
	readonly onSave: (comment: string) => void;
	readonly onHide?: () => void;
}

const QUOTE_PREVIEW_CHARS = 160;

/**
 * T3's citation comment editor: the quote, muted, over one field for what the user wants to say
 * about it. Drawn in the Volt menu's chrome (opaque, it floats over the see-through window).
 */
export function showCitationCommentEditor(contextViewService: IContextViewService, options: ICitationCommentOptions): void {
	let saved = false;
	contextViewService.showContextView({
		getAnchor: () => {
			const page = getDomNodePagePosition(options.anchor);
			return { x: page.left, y: page.top - 4, width: page.width, height: page.height + 8 };
		},
		anchorAlignment: AnchorAlignment.LEFT,
		anchorPosition: AnchorPosition.ABOVE,
		canRelayout: true,
		render: container => {
			const store = new DisposableStore();
			const host = append(container, $('.volt-menu-host'));
			host.style.marginTop = '0';
			store.add(toDisposable(() => host.remove()));
			const root = append(host, $('.volt-menu.volt-agent-citation-comment'));
			root.setAttribute('role', 'dialog');
			root.setAttribute('aria-label', localize('voltAgent.citationComment', "Comment on quote"));
			const quote = options.quote.replace(/\s+/g, ' ').trim();
			append(root, $('.volt-agent-citation-comment-quote')).textContent = quote.length > QUOTE_PREVIEW_CHARS ? `${quote.slice(0, QUOTE_PREVIEW_CHARS - 3)}...` : quote;
			const row = append(root, $('.volt-menu-search'));
			const input = store.add(new InputBox(row, contextViewService, {
				placeholder: localize('voltAgent.citationCommentPlaceholder', "Add a comment about this quote"),
				ariaLabel: localize('voltAgent.citationComment', "Comment on quote"),
				tooltip: '',
				inputBoxStyles: { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' },
			}));
			input.value = options.comment ?? '';
			append(root, $('.volt-agent-citation-comment-hint')).textContent = localize('voltAgent.citationCommentHint', "Enter to save, Esc to cancel");
			store.add(addDisposableListener(input.inputElement, 'keydown', e => {
				const event = new StandardKeyboardEvent(e);
				if (event.keyCode === KeyCode.Enter) {
					event.preventDefault();
					event.stopPropagation();
					saved = true;
					const value = input.value.trim();
					contextViewService.hideContextView();
					options.onSave(value);
				} else if (event.keyCode === KeyCode.Escape) {
					event.preventDefault();
					event.stopPropagation();
					contextViewService.hideContextView();
				}
			}));
			// The context view reports only presses inside it; any other press closes the editor.
			store.add(addDisposableListener(getWindow(options.anchor).document, 'mousedown', e => {
				if (e.target instanceof Node && !contextViewService.getContextViewElement().contains(e.target)) {
					contextViewService.hideContextView();
				}
			}, true));
			getWindow(options.anchor).setTimeout(() => {
				input.focus();
				input.select();
			}, 0);
			return store;
		},
		onHide: () => {
			if (!saved) {
				options.onHide?.();
			}
		},
	});
}
