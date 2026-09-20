/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, reset } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { ZoneWidget } from '../../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { INLINE_COMMENT_KEEP_COMMAND_ID, SEND_SELECTION_TO_CHAT_COMMAND_ID } from './inlineCommentActions.js';
import { InlineCommentMode } from './inlineCommentModel.js';

export interface IInlineCommentSubmitEvent {
	mode: InlineCommentMode;
	text: string;
}

const MODE_LABELS: Record<InlineCommentMode, string> = {
	edit: localize('voltInlineComment.editSelection', "Edit Selection"),
	ask: localize('voltInlineComment.quickQuestion', "Quick Question"),
	chat: localize('voltInlineComment.sendToChat', "Send to Chat"),
};

const MODE_PLACEHOLDERS: Record<InlineCommentMode, string> = {
	edit: localize('voltInlineComment.editPlaceholder', "Edit selected code"),
	ask: localize('voltInlineComment.askPlaceholder', "Ask a question"),
	chat: localize('voltInlineComment.chatPlaceholder', "Send to chat"),
};

function createInlineSendIcon(): HTMLElement {
	const el = $('span.volt-inline-comment-send-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M12 19V5M5 12l7-7 7 7');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '2.4');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export class InlineCommentZoneWidget extends ZoneWidget {

	private readonly _onDidSubmit = this._disposables.add(new Emitter<IInlineCommentSubmitEvent>());
	readonly onDidSubmit = this._onDidSubmit.event;
	private readonly _onDidClose = this._disposables.add(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;
	private readonly _onDidAccept = this._disposables.add(new Emitter<void>());
	readonly onDidAccept = this._onDidAccept.event;
	private readonly _onDidReject = this._disposables.add(new Emitter<void>());
	readonly onDidReject = this._onDidReject.event;
	private readonly _onDidHeightChange = this._disposables.add(new Emitter<void>());
	readonly onDidHeightChange = this._onDidHeightChange.event;

	private root!: HTMLElement;
	private threadEl!: HTMLElement;
	private questionEl!: HTMLElement;
	private answerEl!: HTMLElement;
	private promptRow!: HTMLElement;
	private promptText!: HTMLElement;
	private reviewActions!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private modeButton!: HTMLButtonElement;
	private submitButton!: HTMLButtonElement;
	private mode: InlineCommentMode = 'edit';
	private followUp = false;
	private busy = false;
	private readonly markdown: MarkdownRenderer;
	private readonly answerStore = this._disposables.add(new DisposableStore());

	constructor(
		editor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(editor, {
			showFrame: false,
			showArrow: false,
			isResizeable: false,
			isAccessible: true,
			keepEditorSelection: true,
			showInHiddenAreas: true,
			className: 'volt-inline-comment-zone',
			ordinal: 50000,
		});
		this.markdown = instantiationService.createInstance(MarkdownRenderer, {});
		this.create();
	}

	protected override _fillContainer(container: HTMLElement): void {
		this.root = append(container, $('.volt-inline-comment'));
		this.threadEl = append(this.root, $('.volt-inline-comment-thread'));
		this.threadEl.style.display = 'none';
		this.questionEl = append(this.threadEl, $('.volt-inline-comment-question'));
		this.answerEl = append(this.threadEl, $('.volt-inline-comment-answer'));

		this.promptRow = append(this.root, $('.volt-inline-comment-prompt-row'));
		this.promptRow.style.display = 'none';
		this.promptText = append(this.promptRow, $('span.volt-inline-comment-prompt-text'));
		this.reviewActions = append(this.promptRow, $('.volt-inline-comment-review-actions'));
		const reject = append(this.reviewActions, $('button.volt-inline-comment-reject'));
		reject.textContent = localize('voltInlineComment.reject', "Reject");
		const accept = append(this.reviewActions, $('button.volt-inline-comment-accept'));
		append(accept, $('span')).textContent = localize('voltInlineComment.accept', "Accept");
		const keepKey = this.keybindingService.lookupKeybinding(INLINE_COMMENT_KEEP_COMMAND_ID)?.getLabel();
		if (keepKey) {
			append(accept, $('span.volt-inline-comment-accept-key')).textContent = keepKey;
		}
		this._disposables.add(addDisposableListener(reject, 'click', e => {
			e.preventDefault();
			this._onDidReject.fire();
		}));
		this._disposables.add(addDisposableListener(accept, 'click', e => {
			e.preventDefault();
			this._onDidAccept.fire();
		}));

		const close = append(this.root, $('button.volt-inline-comment-close'));
		const inputWrap = append(this.root, $('.volt-inline-comment-input-wrap'));
		this.input = append(inputWrap, $('textarea.volt-inline-comment-input')) as HTMLTextAreaElement;
		this.input.rows = 1;
		this.input.setAttribute('aria-label', localize('voltInlineComment.inputAria', "Inline comment"));
		close.setAttribute('aria-label', localize('voltInlineComment.close', "Close"));
		close.appendChild(renderIcon(Codicon.close));
		this._disposables.add(addDisposableListener(close, 'click', e => {
			e.preventDefault();
			this._onDidClose.fire();
		}));

		const toolbar = append(this.root, $('.volt-inline-comment-toolbar'));
		this.modeButton = append(toolbar, $('button.volt-inline-comment-mode'));
		this.submitButton = append(toolbar, $('button.volt-inline-comment-submit'));
		this.submitButton.setAttribute('aria-label', localize('voltInlineComment.submit', "Submit"));
		this.submitButton.appendChild(createInlineSendIcon());

		this._disposables.add(addDisposableListener(this.modeButton, 'click', e => {
			e.preventDefault();
			this.showModeMenu();
		}));
		this._disposables.add(addDisposableListener(this.submitButton, 'click', e => {
			e.preventDefault();
			this.submit();
		}));
		this._disposables.add(addDisposableListener(this.input, 'input', () => this.autosize()));
		this._disposables.add(addDisposableListener(this.input, 'keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.submit();
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				this._onDidClose.fire();
			}
		}));

		this.setMode('edit');
	}

	override show(position: Position): void {
		super.show(position, this.heightInLines());
		this.layout();
		this.input.focus();
	}

	override hide(): void {
		this.contextViewService.hideContextView();
		super.hide();
	}

	getMode(): InlineCommentMode {
		return this.mode;
	}

	setMode(mode: InlineCommentMode): void {
		this.mode = mode;
		this.renderModeButton();
		this.updatePlaceholder();
	}

	getValue(): string {
		return this.input.value;
	}

	focusInput(): void {
		this.input.focus();
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		this.root.classList.toggle('volt-inline-comment-busy', busy);
		this.submitButton.disabled = busy;
		this.input.readOnly = busy;
	}

	setAnswer(question: string, answer: string, streaming = false): void {
		this.followUp = true;
		this.threadEl.style.display = '';
		this.questionEl.textContent = question;
		this.answerStore.clear();
		reset(this.answerEl);
		if (streaming && !answer.trim()) {
			this.answerEl.textContent = localize('voltInlineComment.thinking', "Thinking...");
		} else {
			const result = this.markdown.render(new MarkdownString(answer, { supportThemeIcons: true }), { fillInIncompleteTokens: streaming });
			result.element.classList.add('volt-agent-markdown');
			this.answerEl.appendChild(result.element);
			this.answerStore.add(result);
		}
		this.input.value = '';
		this.updatePlaceholder();
		this.layout();
	}

	setPreviewPrompt(prompt: string, visible: boolean): void {
		this.followUp = visible;
		this.promptRow.style.display = visible ? 'flex' : 'none';
		this.promptText.textContent = prompt;
		this.promptText.title = prompt;
		this.updatePlaceholder();
		this.layout();
	}

	hideThread(): void {
		this.threadEl.style.display = 'none';
		this.answerStore.clear();
		reset(this.answerEl);
		this.questionEl.textContent = '';
		this.layout();
	}

	clearThread(): void {
		this.followUp = false;
		this.hideThread();
		this.promptRow.style.display = 'none';
		this.input.value = '';
		this.updatePlaceholder();
		this.layout();
	}

	resetForOpen(): void {
		this.setBusy(false);
		this.clearThread();
		this.setMode(this.mode);
	}

	layout(): void {
		this.autosize(false);
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		this._relayout(this.heightInLines());
		this._onDidHeightChange.fire();
		void lineHeight;
	}

	private heightInLines(): number {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const height = Math.max(this.root?.offsetHeight ?? 88, 88) + 20;
		return Math.max(5, Math.ceil(height / lineHeight));
	}

	private submit(): void {
		if (this.busy) {
			return;
		}
		const text = this.input.value.trim();
		if (!text) {
			return;
		}
		this._onDidSubmit.fire({ mode: this.mode, text });
	}

	private autosize(notify = true): void {
		this.input.style.height = 'auto';
		this.input.style.height = `${Math.min(120, Math.max(22, this.input.scrollHeight))}px`;
		if (notify) {
			const lineHeight = this.editor.getOption(EditorOption.lineHeight);
			this._relayout(this.heightInLines());
			void lineHeight;
		}
	}

	private updatePlaceholder(): void {
		this.input.placeholder = this.followUp
			? localize('voltInlineComment.followUp', "Add a follow-up")
			: MODE_PLACEHOLDERS[this.mode];
	}

	private renderModeButton(): void {
		reset(this.modeButton);
		append(this.modeButton, $('span')).textContent = MODE_LABELS[this.mode];
		this.modeButton.appendChild(renderIcon(Codicon.chevronDown));
	}

	private showModeMenu(): void {
		this.contextViewService.showContextView({
			getAnchor: () => this.modeButton,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.BELOW,
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-inline-comment-menu'));
				for (const mode of ['edit', 'ask', 'chat'] as InlineCommentMode[]) {
					const item = append(menu, $('button.volt-inline-comment-menu-item'));
					if (mode === this.mode) {
						item.classList.add('active');
					}
					append(item, $('span')).textContent = MODE_LABELS[mode];
					const trailing = append(item, $('span.volt-inline-comment-menu-trailing'));
					if (mode === this.mode) {
						trailing.appendChild(renderIcon(Codicon.check));
					}
					const key = append(trailing, $('span.volt-inline-comment-menu-key'));
					key.textContent = this.shortcutFor(mode);
					store.add(addDisposableListener(item, 'click', e => {
						e.preventDefault();
						this.setMode(mode);
						this.contextViewService.hideContextView();
						this.input.focus();
					}));
				}
				return store;
			},
		});
	}

	private shortcutFor(mode: InlineCommentMode): string {
		if (mode === 'chat') {
			return this.keybindingService.lookupKeybinding(SEND_SELECTION_TO_CHAT_COMMAND_ID)?.getLabel() ?? '';
		}
		if (mode === 'edit') {
			// allow-any-unicode-next-line
			return '↩';
		}
		// allow-any-unicode-next-line
		return '⌤';
	}
}
