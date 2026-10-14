/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { highlightCodeLines } from '../../voltAgent/browser/blocks/agentCodeBlock.js';
import type { IFileChangePreviewInput, IFileChangePreviewOptions } from '../../voltAgent/browser/review/fileChangePreview.js';
import { computeFileChangePreview, formatChangeStats, IFileChangePreviewModel, resourceFromPreviewSource } from '../../voltAgent/browser/review/fileChangePreviewModel.js';

const noModels: Partial<IModelService> = { getModel: () => null };
const NO_MODELS = noModels as IModelService;

/**
 * The agent window's file change card, drawn in DOM: the same header (verb, file icon, name,
 * +/- counts, chevron) and states; the expanded diff uses the transcript's inline diff rows
 * instead of a Monaco diff editor.
 */
export class WebFileChangePreview extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLButtonElement;
	private readonly verbEl: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly nameEl: HTMLElement;
	private readonly addedEl: HTMLElement;
	private readonly removedEl: HTMLElement;
	private readonly chevron: HTMLElement;
	private readonly body: HTMLElement;
	private readonly diffHost: HTMLElement;
	private readonly bodyListeners = this._register(new DisposableStore());
	private model: IFileChangePreviewModel | undefined;
	private input: IFileChangePreviewInput | undefined;
	private options: IFileChangePreviewOptions = {};
	private expanded = false;

	constructor(private readonly languageService: ILanguageService) {
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
		this.diffHost = append(this.body, $('.volt-file-preview-editor'));
		this._register(addDisposableListener(this.head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.canToggle()) {
				this.options.onToggle?.();
			}
		}));
	}

	get current(): IFileChangePreviewModel | undefined {
		return this.model;
	}

	setInput(input: IFileChangePreviewInput, options?: IFileChangePreviewOptions): void {
		this.input = input;
		if (options) {
			this.options = options;
		}
		this.expanded = !!this.options.expanded;
		this.model = computeFileChangePreview(input, { contextLines: 3, maxLines: 400 });
		this.paint();
	}

	clear(): void {
		this.input = undefined;
		this.model = undefined;
		this.verbEl.textContent = this.nameEl.textContent = this.addedEl.textContent = this.removedEl.textContent = '';
		this.diffHost.replaceChildren();
		this.element.classList.remove('has-diff', 'clickable', 'expanded', 'collapsible', 'card', 'accordion');
	}

	private isCard(): boolean {
		return this.options.style === 'card';
	}

	private canToggle(): boolean {
		if (this.options.collapsible === false) {
			return false;
		}
		const hasDiff = !!this.model?.lines.length;
		return this.isCard() ? hasDiff : this.options.collapsible === true || hasDiff;
	}

	private paint(): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const verb = this.input?.verb ?? 'Edited';
		this.verbEl.textContent = this.isCard() ? '' : verb;
		this.nameEl.textContent = model.name;
		const stats = formatChangeStats(model.additions, model.deletions);
		this.addedEl.textContent = stats.added ?? '';
		this.removedEl.textContent = stats.removed ?? '';
		const resource = model.resource ?? (this.input ? resourceFromPreviewSource(this.input) : undefined);
		this.icon.className = 'volt-file-preview-icon';
		this.icon.classList.add(...(resource ? getIconClasses(NO_MODELS, this.languageService, resource, FileKind.FILE) : ThemeIcon.asClassNameArray(Codicon.file)));
		this.chevron.replaceChildren();
		const collapsible = this.canToggle();
		if (!this.isCard() && collapsible) {
			this.chevron.appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronRight));
		}
		this.head.disabled = !collapsible;
		this.head.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
		this.element.title = resource?.fsPath ?? model.name;
		this.element.setAttribute('aria-label', localize('voltFilePreview.webAria', "{0} {1}", verb, model.name));
		this.element.classList.toggle('card', this.isCard());
		this.element.classList.toggle('accordion', !this.isCard());
		this.element.classList.toggle('clickable', collapsible);
		this.element.classList.toggle('collapsible', collapsible);
		this.element.classList.toggle('expanded', this.expanded);
		this.element.classList.toggle('has-diff', this.expanded && model.lines.length > 0);
		this.paintDiff(model, resource ? extname(resource).replace(/^\./, '') : '');
	}

	private paintDiff(model: IFileChangePreviewModel, alias: string): void {
		this.bodyListeners.clear();
		this.diffHost.replaceChildren();
		if (!this.expanded || !model.lines.length) {
			return;
		}
		const card = append(this.diffHost, $('.volt-tr-diff'));
		const texts: HTMLElement[] = [];
		for (const line of model.lines) {
			const el = append(card, $(`.volt-tr-diff-line.${line.kind}`));
			append(el, $('.volt-tr-diff-strip'));
			const gutter = append(el, $('.volt-tr-diff-gutter'));
			append(gutter, $('span.volt-tr-diff-num')).textContent = String(line.lineNumber);
			append(gutter, $('span.volt-tr-diff-ind')).textContent = line.kind === 'insert' ? '+' : line.kind === 'delete' ? '-' : '';
			const text = append(el, $('.volt-tr-diff-text'));
			text.textContent = line.text || '​';
			texts.push(text);
		}
		if (alias) {
			void highlightCodeLines(this.languageService, alias, model.lines.map(line => line.text).join('\n')).done.then(lines => {
				texts.forEach((text, index) => {
					if (lines[index]?.length && text.isConnected) {
						text.replaceChildren(...lines[index]);
					}
				});
			});
		}
	}
}
