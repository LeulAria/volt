/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/fileChangePreview.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/path.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { getCodeEditor, ICodeEditor, IDiffEditorConstructionOptions } from '../../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorWidgetOptions } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { EDITOR_FONT_DEFAULTS } from '../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CursorChangeReason } from '../../../../../editor/common/cursorEvents.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ColorDetector } from '../../../../../editor/contrib/colorPicker/browser/colorDetector.js';
import { ContextMenuController } from '../../../../../editor/contrib/contextmenu/browser/contextmenu.js';
import { ViewportSemanticTokensContribution } from '../../../../../editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TextEditorSelectionRevealType, TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { MenuPreventer } from '../../../codeEditor/browser/menuPreventer.js';
import { SelectionClipboardContributionID } from '../../../codeEditor/browser/selectionClipboard.js';
import { getSimpleEditorOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';
import {
	computeFileChangePreview,
	fileChangeOpenSelectionRange,
	fileChangePreviewDocuments,
	FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED,
	FILE_CHANGE_PREVIEW_CONTEXT_EXPANDED,
	FILE_CHANGE_PREVIEW_EXPANDED_MAX,
	FILE_CHANGE_PREVIEW_LARGE_MAX,
	formatChangeStats,
	guessPreviewLanguage,
	previewTokenizerSeed,
	wrapPreviewDocument,
	IFileChangePreviewModel,
	IFileChangePreviewSource,
	resourceFromPreviewSource,
	type FileChangeDiffStyle,
	type FileChangeVerb,
} from './fileChangePreviewModel.js';

export interface IFileChangePreviewOptions {
	readonly style?: FileChangeDiffStyle;
	readonly openOnClick?: boolean;
	readonly collapsible?: boolean;
	readonly expanded?: boolean;
	readonly reviewExpanded?: boolean;
	readonly onToggle?: () => void;
	readonly onOpen?: (resource: URI, startLine?: number, endLine?: number) => void;
}

export type IFileChangePreviewInput = IFileChangePreviewSource;

/**
 * File-change viewer used across agent surfaces.
 *
 * `card` - filename header; expand the down arrow for the Monaco diff.
 * `accordion` - high-level `Edited filename.tsx +4 -1` row; expand for the diff.
 */
export class FileChangePreview extends Disposable {

	readonly element: HTMLElement;

	private readonly head: HTMLButtonElement;
	private readonly verbEl: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly nameEl: HTMLElement;
	private readonly addedEl: HTMLElement;
	private readonly removedEl: HTMLElement;
	private readonly chevron: HTMLElement;
	private readonly body: HTMLElement;
	private readonly editorHost: HTMLElement;
	private readonly expandBtn: HTMLButtonElement;
	private model: IFileChangePreviewModel | undefined;
	private languageId: string | undefined;
	private lastInput: IFileChangePreviewInput | undefined;
	private options: IFileChangePreviewOptions = {};
	private expanded = false;
	private reviewExpanded = false;
	private diffEditor: DiffEditorWidget | undefined;
	private originalModel: ITextModel | undefined;
	private modifiedModel: ITextModel | undefined;
	private lastLayout: { width: number; height: number } | undefined;
	private originalLineNumbers: number[] = [];
	private modifiedLineNumbers: number[] = [];
	private prefixLineCount = 0;
	private readonly previewId = generateUuid();

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IThemeService private readonly themeService: IThemeService,
		@IEditorService private readonly editorService: IEditorService,
		@ILabelService private readonly labelService: ILabelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.element = $('.volt-file-preview.show-file-icons');
		this.element.setAttribute('role', 'group');

		this.head = append(this.element, $('button.volt-file-preview-head')) as HTMLButtonElement;
		this.head.type = 'button';
		this.head.disabled = true;
		this.verbEl = append(this.head, $('span.volt-file-preview-verb'));
		this.icon = append(this.head, $('span.volt-file-preview-icon'));
		this.icon.setAttribute('aria-hidden', 'true');
		this.nameEl = append(this.head, $('span.volt-file-preview-name'));
		const stats = append(this.head, $('span.volt-file-preview-stats'));
		this.addedEl = append(stats, $('span.volt-file-preview-add'));
		this.removedEl = append(stats, $('span.volt-file-preview-del'));
		this.chevron = append(this.head, $('span.volt-file-preview-chevron'));
		this.body = append(this.element, $('.volt-file-preview-body'));
		this.editorHost = append(this.body, $('.volt-file-preview-editor'));
		this.expandBtn = append(this.element, $('button.volt-file-preview-expand')) as HTMLButtonElement;
		this.expandBtn.type = 'button';
		this.expandBtn.hidden = true;

		this._register(addDisposableListener(this.head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.isCard()) {
				this.open();
				return;
			}
			if (this.canToggle()) {
				this.options.onToggle?.();
				return;
			}
			this.open();
		}));
		this._register(addDisposableListener(this.nameEl, 'click', e => {
			if (!this.canOpen()) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.open();
		}));
		this._register(addDisposableListener(this.expandBtn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleExpand();
		}));
		this._register(this.themeService.onDidFileIconThemeChange(() => this.paintIcon()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor') && this.diffEditor) {
				this.diffEditor.updateOptions(this.diffEditorOptions());
				this.applyPreviewChrome();
				this.layoutEditor();
			}
		}));
		this._register(toDisposable(() => this.disposeModels()));

		const Observer = getWindow(this.element).ResizeObserver;
		const observer = new Observer(() => this.layoutEditor());
		observer.observe(this.element);
		this._register(toDisposable(() => observer.disconnect()));
	}

	get current(): IFileChangePreviewModel | undefined {
		return this.model;
	}

	setInput(input: IFileChangePreviewInput, options?: IFileChangePreviewOptions): void {
		this.lastInput = input;
		if (options) {
			this.options = options;
		}
		this.expanded = !!this.options.expanded;
		this.reviewExpanded = this.isCard() && this.expanded && !!this.options.reviewExpanded;
		this.model = computeFileChangePreview(input, this.previewComputeOptions());
		this.languageId = this.resolveLanguage(input, this.model);
		this.paintHeader(input.verb);
		this.paintDiff();
	}

	clear(): void {
		this.lastInput = undefined;
		this.model = undefined;
		this.languageId = undefined;
		this.options = {};
		this.expanded = false;
		this.reviewExpanded = false;
		this.expandBtn.hidden = true;
		this.expandBtn.replaceChildren();
		this.originalLineNumbers = [];
		this.modifiedLineNumbers = [];
		this.verbEl.textContent = '';
		this.nameEl.textContent = '';
		this.addedEl.textContent = '';
		this.removedEl.textContent = '';
		this.diffEditor?.setModel(null);
		this.disposeModels();
		this.editorHost.style.height = '0px';
		this.lastLayout = undefined;
		this.head.disabled = true;
		this.element.classList.remove('has-diff', 'clickable', 'expanded', 'collapsible', 'card', 'accordion', 'reviewable', 'review-expanded', 'clamped');
		this.icon.className = 'volt-file-preview-icon';
	}

	private paintHeader(verb?: FileChangeVerb): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const action = verb ?? 'Edited';
		this.verbEl.textContent = this.isCard() ? '' : action;
		this.nameEl.textContent = model.name;
		const stats = formatChangeStats(model.additions, model.deletions);
		this.addedEl.textContent = stats.added ?? '';
		this.removedEl.textContent = stats.removed ?? '';
		this.paintIcon();
		this.paintChevron();

		const path = model.resource
			? this.labelService.getUriLabel(model.resource, { relative: true })
			: model.name;
		const insertions = model.additions === 1
			? localize('voltFilePreview.insertion', "1 insertion")
			: localize('voltFilePreview.insertions', "{0} insertions", model.additions);
		const deletions = model.deletions === 1
			? localize('voltFilePreview.deletion', "1 deletion")
			: localize('voltFilePreview.deletions', "{0} deletions", model.deletions);
		this.element.title = path;
		this.element.setAttribute('aria-label', localize('voltFilePreview.aria', "{0} {1}, {2}, {3}", action, model.name, insertions, deletions));

		const collapsible = this.canToggle();
		const clickable = this.canOpen() || collapsible;
		this.head.disabled = !clickable;
		this.head.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
		this.element.classList.toggle('card', this.isCard());
		this.element.classList.toggle('accordion', !this.isCard());
		this.element.classList.toggle('clickable', clickable);
		this.element.classList.toggle('collapsible', collapsible);
		this.element.classList.toggle('expanded', this.expanded);
		this.element.classList.toggle('has-diff', this.expanded && model.lines.length > 0);
		this.element.classList.toggle('reviewable', this.canShowExpand());
		this.element.classList.toggle('review-expanded', this.reviewExpanded);
		this.element.classList.toggle('clamped', this.expanded && !this.reviewExpanded && !!this.model?.expandable);
		this.paintExpand();
	}

	private paintChevron(): void {
		this.chevron.replaceChildren();
		if (this.isCard() || !this.canToggle()) {
			return;
		}
		this.chevron.appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronRight));
	}

	private paintExpand(): void {
		this.expandBtn.replaceChildren();
		if (!this.canShowExpand()) {
			this.expandBtn.hidden = true;
			return;
		}
		this.expandBtn.hidden = false;
		const showMore = !this.expanded || (!this.reviewExpanded && !!this.model?.expandable);
		this.expandBtn.appendChild(renderIcon(showMore ? Codicon.chevronDown : Codicon.chevronUp));
		this.expandBtn.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
		this.expandBtn.setAttribute('aria-label', !this.expanded
			? localize('voltFilePreview.showDiff', "Show diff")
			: this.reviewExpanded
				? localize('voltFilePreview.showLess', "Show less")
				: this.model?.expandable
					? localize('voltFilePreview.showMore', "Show more")
					: localize('voltFilePreview.hideDiff', "Hide diff"));
	}

	private paintIcon(): void {
		const resource = this.model?.resource ?? (this.lastInput ? resourceFromPreviewSource(this.lastInput) : undefined);
		this.icon.className = 'volt-file-preview-icon';
		if (resource && this.themeService.getFileIconTheme().hasFileIcons) {
			const kind = resource.path.endsWith('/') ? FileKind.FOLDER : FileKind.FILE;
			this.icon.classList.add(...getIconClasses(this.modelService, this.languageService, resource, kind));
			return;
		}
		this.icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
	}

	private paintDiff(): void {
		const model = this.model;
		if (!this.expanded || !model?.lines.length) {
			this.diffEditor?.setModel(null);
			this.editorHost.style.height = '0px';
			this.lastLayout = undefined;
			return;
		}
		const docs = fileChangePreviewDocuments(model.lines);
		this.originalLineNumbers = docs.originalLineNumbers;
		this.modifiedLineNumbers = docs.modifiedLineNumbers;
		this.setEditorModels(docs.original, docs.modified);
		this.diffEditor?.updateOptions(this.diffEditorOptions());
		this.applyPreviewChrome();
		this.applyLineNumbers();
		this.applyHiddenPrefixAreas();
		this.layoutEditor();
	}

	private ensureEditor(): DiffEditorWidget {
		if (this.diffEditor) {
			return this.diffEditor;
		}
		const widgetOptions: ICodeEditorWidgetOptions = {
			isSimpleWidget: true,
			contributions: EditorExtensionsRegistry.getSomeEditorContributions([
				MenuPreventer.ID,
				SelectionClipboardContributionID,
				ContextMenuController.ID,
				ViewportSemanticTokensContribution.ID,
				ColorDetector.ID,
			]),
		};
		this.diffEditor = this._register(this.instantiationService.createInstance(DiffEditorWidget, this.editorHost, {
			...getSimpleEditorOptions(this.configurationService),
			...this.diffEditorOptions(),
		}, { originalEditor: widgetOptions, modifiedEditor: widgetOptions }));
		this.bindPreviewEditor(this.diffEditor.getOriginalEditor());
		this.bindPreviewEditor(this.diffEditor.getModifiedEditor());
		this.applyPreviewChrome();
		this._register(this.diffEditor.onDidContentSizeChange(() => this.layoutEditor()));
		return this.diffEditor;
	}

	private previewChromeOptions() {
		return {
			renderLineHighlight: 'none' as const,
			renderLineHighlightOnlyWhenFocus: false,
			cursorWidth: 0,
			editContext: false,
			matchBrackets: 'never' as const,
			selectionHighlight: false,
			occurrencesHighlight: 'off' as const,
			defaultColorDecorators: 'always' as const,
		};
	}

	private applyPreviewChrome(): void {
		const chrome = this.previewChromeOptions();
		this.diffEditor?.getOriginalEditor().updateOptions(chrome);
		this.diffEditor?.getModifiedEditor().updateOptions(chrome);
	}

	private bindPreviewEditor(editor: ICodeEditor): void {
		const node = editor.getDomNode();
		if (node) {
			this._register(addDisposableListener(node, 'mousedown', e => {
				if (e.button !== 0) {
					return;
				}
				const target = e.target;
				if (isHTMLElement(target) && target.closest('.scrollbar')) {
					return;
				}
				e.preventDefault();
			}, true));
		}
		this._register(editor.onDidFocusEditorText(() => this.applyPreviewChrome()));
		this._register(editor.onDidChangeCursorSelection(e => {
			this.applyPreviewChrome();
			if (!editor.hasTextFocus() || !e.selection.isEmpty() || e.reason !== CursorChangeReason.Explicit) {
				return;
			}
			const node = editor.getDomNode();
			const active = node?.ownerDocument.activeElement;
			if (isHTMLElement(active) && node?.contains(active)) {
				active.blur();
			}
		}));
	}

	private diffEditorOptions(): IDiffEditorConstructionOptions {
		const fontFamily = this.configurationService.getValue<string>('editor.fontFamily');
		return {
			readOnly: true,
			domReadOnly: true,
			originalEditable: false,
			lineNumbers: 'on',
			lineNumbersMinChars: 3,
			selectOnLineNumbers: false,
			lineDecorationsWidth: 24,
			glyphMargin: false,
			folding: false,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			cursorWidth: 0,
			cursorStyle: 'line',
			hideCursorInOverviewRuler: true,
			renderLineHighlight: 'none',
			renderLineHighlightOnlyWhenFocus: false,
			editContext: false,
			defaultColorDecorators: 'always',
			renderOverviewRuler: false,
			renderMarginRevertIcon: false,
			renderGutterMenu: false,
			renderIndicators: true,
			renderSideBySide: false,
			compactMode: true,
			useInlineViewWhenSpaceIsLimited: true,
			experimental: { useTrueInlineView: false, showEmptyDecorations: false },
			hideUnchangedRegions: { enabled: false },
			diffAlgorithm: 'advanced',
			diffCodeLens: false,
			stickyScroll: { enabled: false },
			isInEmbeddedEditor: true,
			automaticLayout: false,
			padding: { top: 2, bottom: this.reviewExpanded ? 18 : 10 },
			mouseWheelZoom: false,
			contextmenu: true,
			links: false,
			matchBrackets: 'never',
			selectionHighlight: false,
			occurrencesHighlight: 'off',
			guides: { indentation: false, highlightActiveIndentation: false, bracketPairs: false },
			scrollbar: {
				vertical: 'hidden',
				horizontal: 'auto',
				alwaysConsumeMouseWheel: false,
				handleMouseWheel: false,
				useShadows: false,
				ignoreHorizontalScrollbarInContentHeight: true,
			},
			wordWrap: this.configurationService.getValue<string>('editor.wordWrap') === 'on' ? 'on' : 'off',
			diffWordWrap: 'inherit',
			fontFamily: !fontFamily || fontFamily === 'default' ? EDITOR_FONT_DEFAULTS.fontFamily : fontFamily,
			fontSize: this.configurationService.getValue<number>('editor.fontSize') || EDITOR_FONT_DEFAULTS.fontSize,
			fontWeight: this.configurationService.getValue<string>('editor.fontWeight') || EDITOR_FONT_DEFAULTS.fontWeight,
			lineHeight: this.configurationService.getValue<number>('editor.lineHeight') ?? EDITOR_FONT_DEFAULTS.lineHeight,
			fontLigatures: this.configurationService.getValue('editor.fontLigatures'),
			letterSpacing: this.configurationService.getValue<number>('editor.letterSpacing') ?? EDITOR_FONT_DEFAULTS.letterSpacing,
			renderWhitespace: this.configurationService.getValue('editor.renderWhitespace'),
			tabSize: this.configurationService.getValue('editor.tabSize'),
			insertSpaces: this.configurationService.getValue('editor.insertSpaces'),
			ariaLabel: localize('voltFilePreview.diffAria', "File change"),
		};
	}

	private setEditorModels(original: string, modified: string): void {
		const lines = this.model?.lines.map(line => line.text) ?? [];
		const seed = previewTokenizerSeed(this.languageId, lines);
		this.prefixLineCount = seed.prefixLines.length;
		this.languageService.requestRichLanguageFeatures(seed.language);
		const language = this.languageService.createById(seed.language);
		const wrappedOriginal = wrapPreviewDocument(original, seed.prefixLines);
		const wrappedModified = wrapPreviewDocument(modified, seed.prefixLines);
		const originalUri = this.previewModelUri('original');
		const modifiedUri = this.previewModelUri('modified');
		const canReuse = !!this.originalModel && !!this.modifiedModel
			&& this.originalModel.uri.toString() === originalUri.toString()
			&& this.modifiedModel.uri.toString() === modifiedUri.toString();
		if (canReuse && this.originalModel && this.modifiedModel) {
			this.originalModel.setLanguage(language);
			this.modifiedModel.setLanguage(language);
			if (this.originalModel.getValue() !== wrappedOriginal) {
				this.originalModel.setValue(wrappedOriginal);
			}
			if (this.modifiedModel.getValue() !== wrappedModified) {
				this.modifiedModel.setValue(wrappedModified);
			}
		} else {
			this.disposeModels();
			this.originalModel = this.modelService.createModel(wrappedOriginal, language, originalUri, false);
			this.modifiedModel = this.modelService.createModel(wrappedModified, language, modifiedUri, false);
		}
		this.ensureEditor().setModel({
			original: this.originalModel,
			modified: this.modifiedModel,
		});
	}

	private applyHiddenPrefixAreas(): void {
		const editor = this.diffEditor;
		if (!editor) {
			return;
		}
		if (this.prefixLineCount <= 0) {
			editor.getOriginalEditor().setHiddenAreas([], 'volt-file-preview', true);
			editor.getModifiedEditor().setHiddenAreas([], 'volt-file-preview', true);
			return;
		}
		const hidden = [new Range(1, 1, this.prefixLineCount, 1)];
		editor.getOriginalEditor().setHiddenAreas(hidden, 'volt-file-preview', true);
		editor.getModifiedEditor().setHiddenAreas(hidden, 'volt-file-preview', true);
	}

	private previewModelUri(side: 'original' | 'modified'): URI {
		const resource = this.model?.resource ?? (this.lastInput ? resourceFromPreviewSource(this.lastInput) : undefined);
		const fileName = basename(resource?.path ?? this.model?.name ?? 'file');
		return URI.from({
			scheme: Schemas.voltAgent,
			authority: 'file-preview',
			path: `/${this.previewId}/${side}/${fileName}`,
		});
	}

	private applyLineNumbers(): void {
		const editor = this.diffEditor;
		if (!editor) {
			return;
		}
		const originalLineNumbers = this.originalLineNumbers;
		const modifiedLineNumbers = this.modifiedLineNumbers;
		let max = 1;
		for (const n of originalLineNumbers) {
			if (n > max) {
				max = n;
			}
		}
		for (const n of modifiedLineNumbers) {
			if (n > max) {
				max = n;
			}
		}
		const lineNumbersMinChars = Math.max(3, String(max).length);
		const prefix = this.prefixLineCount;
		editor.getOriginalEditor().updateOptions({
			...this.previewChromeOptions(),
			lineNumbersMinChars,
			lineNumbers: lineNumber => {
				const mapped = lineNumber - prefix;
				return mapped >= 1 ? String(originalLineNumbers[mapped - 1] ?? '') : '';
			},
		});
		editor.getModifiedEditor().updateOptions({
			...this.previewChromeOptions(),
			lineNumbersMinChars,
			lineNumbers: lineNumber => {
				const mapped = lineNumber - prefix;
				return mapped >= 1 ? String(modifiedLineNumbers[mapped - 1] ?? '') : '';
			},
		});
	}

	private layoutEditor(): void {
		const editor = this.diffEditor;
		if (!editor || !this.expanded || !this.model?.lines.length) {
			return;
		}
		const width = this.body.clientWidth || this.element.clientWidth;
		if (width <= 0) {
			return;
		}
		const height = Math.max(editor.getContentHeight(), 20);
		if (this.lastLayout?.width === width && this.lastLayout.height === height) {
			return;
		}
		this.lastLayout = { width, height };
		this.editorHost.style.height = `${height}px`;
		editor.layout({ width, height });
	}

	private disposeModels(): void {
		this.prefixLineCount = 0;
		this.originalModel?.dispose();
		this.modifiedModel?.dispose();
		this.originalModel = undefined;
		this.modifiedModel = undefined;
	}

	private resolveLanguage(input: IFileChangePreviewInput, model: IFileChangePreviewModel): string | undefined {
		const named = input.language
			? this.languageService.getLanguageIdByLanguageName(input.language) ?? input.language
			: undefined;
		const resource = model.resource ?? (input ? resourceFromPreviewSource(input) : undefined);
		const fromPath = resource
			? this.languageService.guessLanguageIdByFilepathOrFirstLine(resource) ?? undefined
			: undefined;
		const first = model.lines.find(line => line.kind !== 'delete')?.text
			?? model.lines[0]?.text;
		const fallback = resource && !fromPath
			? this.languageService.guessLanguageIdByFilepathOrFirstLine(resource, first) ?? undefined
			: undefined;
		return guessPreviewLanguage(named ?? fromPath ?? fallback, model.lines.map(line => line.text));
	}

	private isCard(): boolean {
		return this.options.style === 'card';
	}

	private previewComputeOptions(): { maxLines: number; contextLines: number } {
		const review = this.isCard() ? this.reviewExpanded : this.expanded;
		return {
			maxLines: review ? FILE_CHANGE_PREVIEW_EXPANDED_MAX : FILE_CHANGE_PREVIEW_LARGE_MAX,
			contextLines: review ? FILE_CHANGE_PREVIEW_CONTEXT_EXPANDED : FILE_CHANGE_PREVIEW_CONTEXT_COLLAPSED,
		};
	}

	private toggleExpand(): void {
		if (!this.lastInput || !this.canShowExpand()) {
			return;
		}
		if (!this.expanded) {
			this.options.onToggle?.();
			return;
		}
		if (this.reviewExpanded || this.model?.expandable) {
			this.reviewExpanded = !this.reviewExpanded;
			this.options = { ...this.options, reviewExpanded: this.reviewExpanded };
			this.setInput(this.lastInput, this.options);
			return;
		}
		this.options.onToggle?.();
	}

	private canShowExpand(): boolean {
		return this.isCard() && this.hasDiff();
	}

	private canToggle(): boolean {
		if (this.options.collapsible === false) {
			return false;
		}
		if (this.isCard()) {
			return this.hasDiff();
		}
		return this.options.collapsible === true || this.hasDiff();
	}

	private hasDiff(): boolean {
		return (this.model?.lines.length ?? 0) > 0 || (this.model?.additions ?? 0) + (this.model?.deletions ?? 0) > 0;
	}

	private canOpen(): boolean {
		return this.options.openOnClick !== false && !!(this.model?.resource || this.options.onOpen);
	}

	private open(): void {
		if (!this.canOpen()) {
			return;
		}
		const resource = this.model?.resource;
		const selection = fileChangeOpenSelectionRange(this.lastInput, this.model?.lines);
		const startLine = selection?.startLineNumber;
		const endLine = selection?.endLineNumber;
		if (this.options.onOpen && resource) {
			this.options.onOpen(resource, startLine, endLine);
			return;
		}
		if (this.options.onOpen && this.lastInput) {
			const fallback = resourceFromPreviewSource(this.lastInput);
			if (fallback) {
				this.options.onOpen(fallback, startLine, endLine);
			}
			return;
		}
		if (!resource) {
			return;
		}
		void this.editorService.openEditor({
			resource,
			options: startLine ? {
				selection: {
					startLineNumber: startLine,
					startColumn: 1,
					endLineNumber: endLine ?? startLine,
					endColumn: Number.MAX_SAFE_INTEGER,
				},
				selectionRevealType: TextEditorSelectionRevealType.NearTopIfOutsideViewport,
				selectionSource: TextEditorSelectionSource.NAVIGATION,
				pinned: true,
			} : { pinned: true },
		}).then(pane => {
			if (!startLine) {
				return;
			}
			const editor = getCodeEditor(pane?.getControl());
			const model = editor?.getModel();
			if (!editor || !model) {
				return;
			}
			const start = Math.min(startLine, model.getLineCount());
			const end = Math.min(endLine ?? startLine, model.getLineCount());
			const range = {
				startLineNumber: start,
				startColumn: 1,
				endLineNumber: end,
				endColumn: model.getLineMaxColumn(end),
			};
			editor.setSelection(range, TextEditorSelectionSource.NAVIGATION);
			editor.revealRangeNearTopIfOutsideViewport(range);
		});
	}
}

export {
	computeFileChangePreview,
	fileChangeOpenSelectionRange,
	formatChangeStats,
	guessPreviewLanguage,
	previewTokenizerSeed,
	wrapPreviewDocument,
	resourceFromPreviewSource,
	type IFileChangePreviewLine,
	type IFileChangePreviewModel,
	type IFileChangePreviewSource,
} from './fileChangePreviewModel.js';
