/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IEditorConstructionOptions } from '../../../../../editor/browser/config/editorConfiguration.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

export interface IWorkflowCodeEditorOptions {
	readonly value: string;
	readonly language: 'yaml' | 'json';
	readonly ariaLabel: string;
	/** The box's height (px); the width follows the parent. */
	readonly height: number;
	/** A view (a template's or a revision's YAML): selectable and searchable, not editable. */
	readonly readOnly?: boolean;
}

/**
 * YAML or JSON in a real editor (highlighting, folding, find, brackets), for dialogs and panes
 * that used to show code as a `<pre>` or a textarea. Same settings as the builder's YAML tab.
 */
export class WorkflowCodeEditor extends Disposable {

	readonly element: HTMLElement;
	private readonly editor: CodeEditorWidget;
	private readonly model: ITextModel;
	private height: number;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(
		parent: HTMLElement,
		private readonly options: IWorkflowCodeEditorOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.height = options.height;
		this.element = append(parent, $('.volt-wf-code-editor'));
		this.element.style.height = `${options.height}px`;
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, this.element, this.editorOptions(), {
			isSimpleWidget: false,
			contributions: EditorExtensionsRegistry.getEditorContributions(),
		}));
		languageService.requestRichLanguageFeatures(options.language);
		const uri = URI.from({ scheme: `volt-workflow-${options.language}`, path: `/${generateUuid()}/code.${options.language}` });
		this.model = this._register(modelService.createModel(options.value, languageService.createById(options.language), uri, false));
		this.model.updateOptions({ tabSize: 2, indentSize: 2, insertSpaces: true });
		this.editor.setModel(this.model);
		this._register(this.model.onDidChangeContent(() => this._onDidChange.fire(this.model.getValue())));
		this._register(this.configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				this.editor.updateOptions(this.editorOptions());
			}
		}));
		// Dialogs size themselves after the editor is built: follow the box's width.
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout());
		observer.observe(this.element);
		this._register(toDisposable(() => observer.disconnect()));
	}

	get value(): string {
		return this.model.getValue();
	}

	setValue(value: string): void {
		if (value !== this.model.getValue()) {
			this.model.setValue(value);
		}
	}

	setHeight(height: number): void {
		this.height = height;
		this.element.style.height = `${height}px`;
		this.layout();
	}

	layout(): void {
		this.editor.layout({ width: this.element.clientWidth, height: this.height });
	}

	/** On the next frame: after a dialog's own first focus, which would otherwise take it back. */
	focus(): void {
		getWindow(this.element).requestAnimationFrame(() => {
			if (this._store.isDisposed) {
				return;
			}
			this.editor.focus();
			if (!this.options.readOnly && this.model.getValueLength() < 20) {
				// An empty "{ }" template: inside the braces; any other short text: at its end.
				const inside = this.model.getLineCount() === 3 && !this.model.getLineContent(2).trim();
				this.editor.setPosition(inside ? { lineNumber: 2, column: this.model.getLineMaxColumn(2) } : this.model.getFullModelRange().getEndPosition());
			}
		});
	}

	private editorOptions(): IEditorConstructionOptions {
		const configured = this.configuration.getValue<IEditorConstructionOptions>('editor', { overrideIdentifier: this.options.language }) ?? {};
		return {
			...configured,
			ariaLabel: this.options.ariaLabel,
			readOnly: !!this.options.readOnly,
			domReadOnly: !!this.options.readOnly,
			wordWrap: 'off',
			minimap: { enabled: false },
			lineNumbers: 'on',
			lineNumbersMinChars: 3,
			glyphMargin: false,
			folding: true,
			scrollBeyondLastLine: false,
			automaticLayout: false,
			fixedOverflowWidgets: true,
			renderLineHighlight: this.options.readOnly ? 'none' : 'line',
			padding: { top: 8, bottom: 8 },
			overviewRulerBorder: false,
			overviewRulerLanes: 0,
			hideCursorInOverviewRuler: true,
			lineDecorationsWidth: 8,
			stickyScroll: { enabled: false },
			fontSize: Math.min(configured.fontSize ?? 12, 13),
			scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
		};
	}
}
