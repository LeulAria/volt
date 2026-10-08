/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { getSimpleCodeEditorWidgetOptions, getSimpleEditorOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';

const LINE_HEIGHT = 18;
const MAX_HEIGHT = 360;
const WIDTH = 640;

export interface IPastedTextPreviewRequest {
	readonly title: string;
	/** `JSON`, `48 KB`, `1,203 lines`. */
	readonly facts: readonly string[];
	readonly text: string;
	/** Monaco language id. */
	readonly language: string;
	readonly anchor: { readonly x: number; readonly y: number };
	/** Put the text back into the composer in place of the chip. */
	readonly onUnfold: () => void;
	readonly onOpen: () => void;
	readonly onRemove: () => void;
	readonly onHide?: () => void;
}

/**
 * The folded paste, read-only and highlighted, above its chip: what was pasted, without opening
 * an editor tab. Its actions turn it back into composer text, open the saved copy, or drop it.
 */
export class PastedTextPreview extends Disposable {

	private visible = false;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	get isVisible(): boolean {
		return this.visible;
	}

	hide(): void {
		if (this.visible) {
			this.contextViewService.hideContextView();
		}
		this.visible = false;
	}

	show(request: IPastedTextPreviewRequest): void {
		this.hide();
		this.visible = true;
		this.contextViewService.showContextView({
			getAnchor: () => ({ x: request.anchor.x, y: request.anchor.y, width: 1, height: 1 }),
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			layer: 2,
			onHide: () => {
				this.visible = false;
				request.onHide?.();
			},
			render: container => this.render(container, request),
		});
	}

	private render(container: HTMLElement, request: IPastedTextPreviewRequest): DisposableStore {
		const store = new DisposableStore();
		container.classList.add('volt-paste-preview');
		const close = () => this.hide();

		const head = append(container, $('.volt-paste-preview-head'));
		append(head, $('span.volt-paste-preview-icon')).appendChild(renderIcon(Codicon.note));
		append(head, $('span.volt-paste-preview-title')).textContent = request.title;
		append(head, $('span.volt-paste-preview-facts')).textContent = request.facts.join(' · ');

		const host = append(container, $('.volt-paste-preview-editor'));
		const lineCount = Math.max(1, request.text.split('\n', 1_000).length);
		const height = Math.min(MAX_HEIGHT, lineCount * LINE_HEIGHT + 16);
		host.style.height = `${height}px`;
		const fontSize = this.configurationService.getValue<number>('editor.fontSize') || 12;
		const editor = store.add(this.instantiationService.createInstance(
			CodeEditorWidget,
			host,
			{
				...getSimpleEditorOptions(this.configurationService),
				readOnly: true,
				domReadOnly: true,
				lineNumbers: 'on',
				lineNumbersMinChars: 3,
				renderLineHighlight: 'none',
				scrollbar: { vertical: 'auto', horizontal: 'auto', alwaysConsumeMouseWheel: true },
				wordWrap: 'off',
				fontFamily: this.configurationService.getValue<string>('editor.fontFamily'),
				fontSize: Math.min(fontSize, 13),
				lineHeight: LINE_HEIGHT,
				padding: { top: 8, bottom: 8 },
				folding: true,
			},
			getSimpleCodeEditorWidgetOptions(),
		));
		this.languageService.requestRichLanguageFeatures(request.language);
		const model = store.add(this.modelService.createModel(request.text, this.languageService.createById(request.language), URI.from({ scheme: 'volt-paste-preview', path: `/${generateUuid()}` }), true));
		editor.setModel(model);
		const width = Math.min(WIDTH, Math.round(getWindow(container).innerWidth * 0.72));
		host.style.width = `${width}px`;
		editor.layout({ width, height });

		const actions = append(container, $('.volt-paste-preview-actions'));
		const button = (label: string, icon: ThemeIcon | undefined, run: () => void, primary = false) => {
			const el = append(actions, $(`button.volt-paste-preview-btn${primary ? '.primary' : ''}`)) as HTMLButtonElement;
			if (icon) {
				el.appendChild(renderIcon(icon));
			}
			append(el, $('span')).textContent = label;
			store.add(addDisposableListener(el, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				close();
				run();
			}));
			return el;
		};
		button(localize('voltAgent.paste.unfold', "Paste as Text"), Codicon.textSize, request.onUnfold, true).title = localize('voltAgent.paste.unfoldHint', "Put the text back into the message in place of the attachment");
		button(localize('voltAgent.paste.open', "Open in Editor"), Codicon.goToFile, request.onOpen);
		append(actions, $('span.volt-paste-preview-spacer'));
		button(localize('voltAgent.paste.remove', "Remove"), Codicon.trash, request.onRemove);
		store.add(addDisposableListener(container, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				close();
			}
		}));
		return store;
	}
}
