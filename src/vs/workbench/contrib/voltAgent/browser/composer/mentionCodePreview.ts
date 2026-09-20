/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { ILanguageSelection, ILanguageService } from '../../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { getSimpleCodeEditorWidgetOptions, getSimpleEditorOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';
import { ILineRange } from '../review/inlineCommentModel.js';

const PREVIEW_MAX_HEIGHT = 240;
const SHOW_DELAY = 280;
const HIDE_DELAY = 220;

export interface IMentionPreviewAnchor {
	x?: number;
	y?: number;
	element?: HTMLElement;
}

export interface IMentionPreviewTarget {
	resource?: URI;
	range?: ILineRange;
	label?: string;
	comment?: string;
}

export class MentionCodePreview extends Disposable {

	private readonly showTimer = this._register(new MutableDisposable());
	private readonly hideTimer = this._register(new MutableDisposable());
	private visible = false;
	private currentKey: string | undefined;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
	}

	scheduleShow(mention: IMentionPreviewTarget, anchor: IMentionPreviewAnchor): void {
		if (!mention.resource || !mention.range) {
			this.hide();
			return;
		}
		const key = `${mention.resource.toString()}:${mention.range.startLineNumber}:${mention.range.endLineNumber}:${mention.comment ?? ''}`;
		if (this.currentKey === key) {
			this.hideTimer.clear();
			return;
		}
		this.hideTimer.clear();
		this.currentKey = key;
		this.showTimer.value = disposableTimeout(() => {
			void this.show(mention, anchor, key);
		}, SHOW_DELAY);
	}

	scheduleHide(): void {
		this.showTimer.clear();
		this.hideTimer.value = disposableTimeout(() => this.hide(), HIDE_DELAY);
	}

	hide(): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		if (this.visible) {
			this.contextViewService.hideContextView();
		}
		this.visible = false;
		this.currentKey = undefined;
	}

	async reveal(mention: IMentionPreviewTarget): Promise<void> {
		if (!mention.resource) {
			return;
		}
		this.hide();
		const range = mention.range;
		await this.editorService.openEditor({
			resource: mention.resource,
			options: {
				pinned: true,
				revealIfOpened: true,
				selection: range ? {
					startLineNumber: range.startLineNumber,
					startColumn: 1,
					endLineNumber: range.endLineNumber,
					endColumn: Number.MAX_SAFE_INTEGER,
				} : undefined,
			},
		});
	}

	private async show(mention: IMentionPreviewTarget, anchor: IMentionPreviewAnchor, key: string): Promise<void> {
		const resource = mention.resource!;
		const range = mention.range!;
		const loaded = await this.loadPreview(resource, range);
		if (!loaded) {
			if (this.currentKey === key) {
				this.currentKey = undefined;
			}
			return;
		}
		this.hideTimer.clear();
		this.visible = true;
		this.currentKey = key;
		this.contextViewService.showContextView({
			getAnchor: () => this.anchorFor(anchor),
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			layer: 2,
			onHide: () => {
				this.visible = false;
				if (this.currentKey === key) {
					this.currentKey = undefined;
				}
			},
			render: container => {
				const store = new DisposableStore();
				container.classList.add('volt-mention-code-preview');
				store.add(addDisposableListener(container, 'mouseenter', () => this.hideTimer.clear()));
				store.add(addDisposableListener(container, 'mouseleave', () => this.scheduleHide()));

				const head = append(container, $('.volt-mention-code-preview-head'));
				if (mention.comment?.trim()) {
					append(head, $('span.volt-mention-code-preview-comment')).textContent = mention.comment.trim();
				}
				const fileBtn = append(head, $('button.volt-mention-code-preview-file'));
				const icon = append(fileBtn, $('span.volt-mention-code-preview-file-icon'));
				icon.classList.add(...getIconClasses(this.modelService, this.languageService, resource, FileKind.FILE));
				const fileName = mention.label || this.fileLabel(resource, range);
				append(fileBtn, $('span.volt-mention-code-preview-file-name')).textContent = fileName;
				store.add(addDisposableListener(fileBtn, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void this.reveal(mention);
				}));

				const host = append(container, $('.volt-mention-code-preview-editor'));
				const lineCount = Math.max(1, loaded.text.split(/\r?\n/).length);
				const lineHeight = 18;
				const height = Math.min(PREVIEW_MAX_HEIGHT, lineCount * lineHeight + 16);
				host.style.height = `${height}px`;
				const fontFamily = this.configurationService.getValue<string>('editor.fontFamily');
				const fontSize = this.configurationService.getValue<number>('editor.fontSize') || 12;
				const editor = store.add(this.instantiationService.createInstance(
					CodeEditorWidget,
					host,
					{
						...getSimpleEditorOptions(this.configurationService),
						readOnly: true,
						domReadOnly: true,
						lineNumbers: (n: number) => String(range.startLineNumber + n - 1),
						lineNumbersMinChars: Math.max(2, String(range.endLineNumber).length),
						renderLineHighlight: 'none',
						scrollbar: { vertical: lineCount > 10 ? 'auto' : 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false },
						wordWrap: 'off',
						fontFamily,
						fontSize: Math.min(fontSize, 13),
						lineHeight,
						padding: { top: 8, bottom: 8 },
					},
					getSimpleCodeEditorWidgetOptions(),
				));
				const previewUri = resource.with({ fragment: `volt-mention-preview-${generateUuid()}` });
				const model = this.modelService.createModel(loaded.text, loaded.language, previewUri, true);
				store.add(model);
				editor.setModel(model);
				editor.layout({ width: 520, height });
				return store;
			},
		});
	}

	private fileLabel(resource: URI, range: ILineRange): string {
		const name = basename(resource.path) || resource.path;
		const lines = range.startLineNumber === range.endLineNumber
			? `${range.startLineNumber}`
			: `${range.startLineNumber}-${range.endLineNumber}`;
		return `${name} (${lines})`;
	}

	private anchorFor(anchor: IMentionPreviewAnchor) {
		if (anchor.element) {
			return anchor.element;
		}
		const x = anchor.x ?? 0;
		const y = anchor.y ?? 0;
		return { x, y, width: 1, height: 1 };
	}

	private async loadPreview(resource: URI, range: ILineRange): Promise<{ text: string; language: ILanguageSelection } | undefined> {
		try {
			const ref = await this.textModelService.createModelReference(resource);
			try {
				const model = ref.object.textEditorModel;
				const languageId = model.getLanguageId();
				this.languageService.requestRichLanguageFeatures(languageId);
				await TokenizationRegistry.getOrCreate(languageId);
				const start = Math.max(1, range.startLineNumber);
				const end = Math.min(model.getLineCount(), Math.max(start, range.endLineNumber));
				const text = model.getValueInRange(new Range(start, 1, end, model.getLineMaxColumn(end)));
				return { text, language: this.languageService.createById(languageId) };
			} finally {
				ref.dispose();
			}
		} catch {
			try {
				const file = await this.fileService.readFile(resource);
				const content = file.value.toString();
				const lines = content.split(/\r?\n/);
				const start = Math.max(1, range.startLineNumber);
				const end = Math.min(lines.length, Math.max(start, range.endLineNumber));
				const text = lines.slice(start - 1, end).join('\n');
				const language = this.languageService.createByFilepathOrFirstLine(resource, text.split('\n')[0]);
				this.languageService.requestRichLanguageFeatures(language.languageId);
				await TokenizationRegistry.getOrCreate(language.languageId);
				return { text, language };
			} catch {
				return undefined;
			}
		}
	}
}

function disposableTimeout(handler: () => void, timeout: number) {
	const handle = setTimeout(handler, timeout);
	return { dispose: () => clearTimeout(handle) };
}
