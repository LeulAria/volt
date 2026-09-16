/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/fileChangePreview.css';
import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { LineTokens } from '../../../../editor/common/tokens/lineTokens.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	computeFileChangePreview,
	FILE_CHANGE_PREVIEW_EXPANDED_MAX,
	FILE_CHANGE_PREVIEW_LARGE_MAX,
	formatChangeStats,
	IFileChangePreviewLine,
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
	readonly onToggle?: () => void;
	readonly onOpen?: (resource: URI, lineNumber?: number) => void;
}

export type IFileChangePreviewInput = IFileChangePreviewSource;

/**
 * File-change viewer used across agent surfaces.
 *
 * `accordion` - high-level `Edited filename.tsx +4 -1` row; expand for the diff.
 * `card` - the detailed file-diff card with the change body always visible.
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
	private model: IFileChangePreviewModel | undefined;
	private languageId: string | undefined;
	private lastInput: IFileChangePreviewInput | undefined;
	private options: IFileChangePreviewOptions = {};
	private expanded = false;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IThemeService private readonly themeService: IThemeService,
		@IEditorService private readonly editorService: IEditorService,
		@ILabelService private readonly labelService: ILabelService,
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

		this._register(addDisposableListener(this.head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
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
		this._register(this.themeService.onDidFileIconThemeChange(() => this.paintIcon()));
		this._register(TokenizationRegistry.onDidChange(e => {
			if (this.languageId && e.changedLanguages.includes(this.languageId)) {
				this.paintLines();
			}
		}));
	}

	get current(): IFileChangePreviewModel | undefined {
		return this.model;
	}

	setInput(input: IFileChangePreviewInput, options?: IFileChangePreviewOptions): void {
		this.lastInput = input;
		if (options) {
			this.options = options;
		}
		this.expanded = this.isCard() || !!this.options.expanded;
		this.model = computeFileChangePreview(input, {
			maxLines: this.expanded ? FILE_CHANGE_PREVIEW_EXPANDED_MAX : FILE_CHANGE_PREVIEW_LARGE_MAX,
		});
		this.languageId = this.resolveLanguage(input, this.model);
		this.paintHeader(input.verb);
		this.paintLines();
		this.scheduleHighlight();
	}

	clear(): void {
		this.lastInput = undefined;
		this.model = undefined;
		this.languageId = undefined;
		this.options = {};
		this.expanded = false;
		this.verbEl.textContent = '';
		this.nameEl.textContent = '';
		this.addedEl.textContent = '';
		this.removedEl.textContent = '';
		clearNode(this.chevron);
		clearNode(this.body);
		this.head.disabled = true;
		this.element.classList.remove('has-diff', 'clickable', 'expanded', 'collapsible', 'card', 'accordion');
		this.icon.className = 'volt-file-preview-icon';
	}

	private paintHeader(verb?: FileChangeVerb): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const action = verb ?? 'Edited';
		this.verbEl.textContent = action;
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
	}

	private paintChevron(): void {
		clearNode(this.chevron);
		if (!this.canToggle()) {
			return;
		}
		this.chevron.appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronRight));
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

	private paintLines(): void {
		const model = this.model;
		clearNode(this.body);
		if (!this.expanded || !model?.lines.length) {
			return;
		}
		const languageId = this.languageId;
		for (const line of model.lines) {
			this.body.appendChild(this.renderLine(line, languageId));
		}
	}

	private renderLine(line: IFileChangePreviewLine, languageId: string | undefined): HTMLElement {
		const row = $(`.volt-file-preview-line.${line.kind}`);
		const ln = append(row, $('span.volt-file-preview-ln'));
		ln.textContent = String(line.lineNumber);
		const mark = append(row, $('span.volt-file-preview-mark'));
		mark.textContent = line.kind === 'insert' ? '+' : line.kind === 'delete' ? '-' : '';
		const code = append(row, $('span.volt-file-preview-code'));
		renderHighlightedText(code, line.text, languageId, this.languageService);
		return row;
	}

	private resolveLanguage(input: IFileChangePreviewInput, model: IFileChangePreviewModel): string | undefined {
		if (input.language) {
			return this.languageService.getLanguageIdByLanguageName(input.language) ?? input.language;
		}
		const resource = model.resource;
		if (!resource) {
			return undefined;
		}
		const first = model.lines.find(line => line.kind !== 'delete')?.text
			?? model.lines[0]?.text;
		return this.languageService.guessLanguageIdByFilepathOrFirstLine(resource, first) ?? undefined;
	}

	private scheduleHighlight(): void {
		const languageId = this.languageId;
		if (!languageId || TokenizationRegistry.get(languageId)) {
			return;
		}
		void TokenizationRegistry.getOrCreate(languageId);
	}

	private isCard(): boolean {
		return this.options.style === 'card';
	}

	private canToggle(): boolean {
		if (this.isCard() || this.options.collapsible === false) {
			return false;
		}
		return this.options.collapsible === true || (this.model?.lines.length ?? 0) > 0 || (this.model?.additions ?? 0) + (this.model?.deletions ?? 0) > 0;
	}

	private canOpen(): boolean {
		return this.options.openOnClick !== false && !!(this.model?.resource || this.options.onOpen);
	}

	private open(): void {
		if (!this.canOpen()) {
			return;
		}
		const resource = this.model?.resource;
		const lineNumber = this.model?.lines[0]?.lineNumber;
		if (this.options.onOpen && resource) {
			this.options.onOpen(resource, lineNumber);
			return;
		}
		if (this.options.onOpen && this.lastInput) {
			const fallback = resourceFromPreviewSource(this.lastInput);
			if (fallback) {
				this.options.onOpen(fallback, lineNumber);
			}
			return;
		}
		if (!resource) {
			return;
		}
		void this.editorService.openEditor({
			resource,
			options: lineNumber ? { selection: { startLineNumber: lineNumber, startColumn: 1 }, pinned: true } : { pinned: true },
		});
	}
}

export {
	computeFileChangePreview,
	formatChangeStats,
	resourceFromPreviewSource,
	type IFileChangePreviewLine,
	type IFileChangePreviewModel,
	type IFileChangePreviewSource,
};

function renderHighlightedText(parent: HTMLElement, text: string, languageId: string | undefined, languageService: ILanguageService): void {
	if (!text) {
		parent.textContent = ' ';
		return;
	}
	const support = languageId ? TokenizationRegistry.get(languageId) : undefined;
	if (!support) {
		parent.textContent = text;
		return;
	}
	const result = support.tokenizeEncoded(text, true, support.getInitialState());
	LineTokens.convertToEndOffset(result.tokens, text.length);
	const tokens = new LineTokens(result.tokens, text, languageService.languageIdCodec).inflate();
	let start = 0;
	for (let i = 0, count = tokens.getCount(); i < count; i++) {
		const end = tokens.getEndOffset(i);
		const span = append(parent, $('span'));
		span.className = tokens.getClassName(i);
		span.textContent = text.slice(start, end);
		start = end;
	}
}
