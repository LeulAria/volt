/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IModelOption } from './agentModelPickerModel.js';

export const MODEL_PICKER_ROW_HEIGHT = 28;
export const MODEL_PICKER_LIST_MAX_HEIGHT = 280;

export type IModelPickerRow =
	| { readonly id: string; readonly kind: 'model'; readonly model: IModelOption; readonly index: number }
	| { readonly id: string; readonly kind: 'auto' }
	| { readonly id: string; readonly kind: 'message'; readonly text: string }
	| { readonly id: string; readonly kind: 'settings' }
	| { readonly id: string; readonly kind: 'skeleton' };

const AUTO_SPARK_PATH = 'M3 12C7.97053 12 12 7.97053 12 3C12 7.97053 16.0295 12 21 12C16.0295 12 12 16.0295 12 21C12 16.0295 7.97053 12 3 12Z';

/** Four-point spark next to Auto. Stroke is scaled so a 1px line at 24px still reads at trigger size. */
const STAR_POINTS = '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2';

/** Thin outline star; favorites fill it with the same stroke color. */
function createStarIcon(doc: Document, filled: boolean): SVGSVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const star = doc.createElementNS('http://www.w3.org/2000/svg', 'polygon');
	star.setAttribute('points', STAR_POINTS);
	star.setAttribute('fill', filled ? 'currentColor' : 'none');
	star.setAttribute('stroke', 'currentColor');
	star.setAttribute('stroke-width', '1');
	star.setAttribute('stroke-linecap', 'round');
	star.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(star);
	return svg;
}

export function createAutoSparkIcon(): HTMLElement {
	const size = 14;
	const host = $('span.volt-brand-icon.volt-auto-spark');
	const svg = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const path = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', AUTO_SPARK_PATH);
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.7');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	host.appendChild(svg);
	return host;
}

export function pickerListHeight(count: number): number {
	return Math.min(Math.max(count, 1) * MODEL_PICKER_ROW_HEIGHT, MODEL_PICKER_LIST_MAX_HEIGHT);
}

export interface IModelPickerListHost {
	selectedRef: string;
	modelAuto: boolean;
	/** Multi mode: the picked models; rows show a checkbox instead of the selected check. */
	multi?: ReadonlySet<string>;
	/** Overrides the Auto row's copy, for pickers where Auto means "no pinned model". */
	auto?: { readonly label: string; readonly description: string };
	favorites: ReadonlySet<string>;
	subtitle(model: IModelOption): string | undefined;
	rowLabel(model: IModelOption): string;
	canEdit(model: IModelOption): boolean;
	onToggleFavorite(ref: string): void;
	onEdit(model: IModelOption, anchor: HTMLElement): void;
	onPreview(model: IModelOption, anchor: HTMLElement): void;
	onPreviewEnd(): void;
}

interface IModelPickerTemplate {
	readonly container: HTMLElement;
	readonly check: HTMLElement;
	readonly copy: HTMLElement;
	readonly label: HTMLElement;
	readonly desc: HTMLElement;
	readonly trail: HTMLElement;
	readonly edit: HTMLButtonElement;
	readonly selected: HTMLElement;
	readonly star: HTMLButtonElement;
	readonly disposables: DisposableStore;
}

export class ModelPickerListDelegate implements IListVirtualDelegate<IModelPickerRow> {
	getHeight(): number {
		return MODEL_PICKER_ROW_HEIGHT;
	}

	getTemplateId(): string {
		return ModelPickerListRenderer.TEMPLATE_ID;
	}
}

export class ModelPickerListRenderer implements IListRenderer<IModelPickerRow, IModelPickerTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentModelPicker';
	readonly templateId = ModelPickerListRenderer.TEMPLATE_ID;

	constructor(private readonly host: IModelPickerListHost) { }

	renderTemplate(container: HTMLElement): IModelPickerTemplate {
		container.classList.add('volt-agent-picker-row');
		const check = append(container, $('span.check'));
		const copy = append(container, $('span.copy'));
		const label = append(copy, $('span.label'));
		const desc = append(copy, $('span.desc'));
		const trail = append(container, $('span.trail'));
		const edit = append(trail, $('button.volt-agent-picker-edit')) as HTMLButtonElement;
		edit.type = 'button';
		edit.tabIndex = -1;
		edit.textContent = localize('voltAgent.editModel', "Edit");
		// Shares the Edit slot: hovering an editable selected row swaps the check for Edit.
		const selected = append(trail, $('span.volt-agent-picker-selected'));
		selected.appendChild(renderIcon(Codicon.check));
		const star = append(container, $('button.volt-agent-picker-star')) as HTMLButtonElement;
		star.type = 'button';
		star.tabIndex = -1;
		return { container, check, copy, label, desc, trail, edit, selected, star, disposables: new DisposableStore() };
	}

	renderElement(row: IModelPickerRow, _index: number, template: IModelPickerTemplate): void {
		template.disposables.clear();
		clearNode(template.check);
		template.star.replaceChildren();
		template.star.classList.add('hidden');
		template.selected.classList.add('hidden');
		template.edit.classList.add('hidden');
		template.desc.textContent = '';
		template.label.textContent = '';
		template.container.classList.toggle('message', row.kind === 'message' || row.kind === 'settings');
		template.container.classList.toggle('skeleton', row.kind === 'skeleton');
		template.container.classList.toggle('model', row.kind === 'model');
		template.container.classList.remove('multi', 'picked');

		if (row.kind === 'skeleton') {
			return;
		}
		if (row.kind === 'auto') {
			template.label.textContent = this.host.auto?.label ?? localize('voltAgent.auto', "Auto");
			template.desc.textContent = this.host.auto?.description ?? localize('voltAgent.autoDesc', "Let Volt pick a model");
			template.check.appendChild(createAutoSparkIcon());
			return;
		}
		if (row.kind === 'message') {
			template.label.textContent = row.text;
			return;
		}
		if (row.kind === 'settings') {
			template.label.textContent = localize('voltAgent.openSettings', "Open Volt Settings");
			return;
		}

		template.label.textContent = this.host.rowLabel(row.model);
		const subtitle = this.host.subtitle(row.model);
		if (subtitle) {
			template.desc.textContent = subtitle;
			template.desc.title = subtitle;
		}
		const canEdit = this.host.canEdit(row.model);
		template.container.classList.toggle('can-edit', canEdit);
		if (canEdit) {
			template.edit.classList.remove('hidden');
			template.edit.setAttribute('aria-label', localize('voltAgent.editModelOptions', "Edit {0}", row.model.name));
			const stop = (event: Event) => {
				event.preventDefault();
				event.stopPropagation();
			};
			template.disposables.add(addDisposableListener(template.edit, 'mousedown', stop));
			template.disposables.add(addDisposableListener(template.edit, 'mouseup', stop));
			template.disposables.add(addDisposableListener(template.edit, 'click', event => {
				stop(event);
				this.host.onEdit(row.model, template.container);
			}));
		}
		template.disposables.add(addDisposableListener(template.container, 'mouseenter', () => {
			this.host.onPreview(row.model, template.container);
		}));
		template.disposables.add(addDisposableListener(template.container, 'mouseleave', () => {
			this.host.onPreviewEnd();
		}));
		const multi = this.host.multi;
		if (multi) {
			const picked = multi.has(row.model.ref);
			template.container.classList.add('multi');
			template.container.classList.toggle('picked', picked);
			template.check.appendChild(renderIcon(picked ? Codicon.passFilled : Codicon.circleLargeOutline));
			template.container.setAttribute('aria-checked', String(picked));
		} else {
			template.container.removeAttribute('aria-checked');
		}
		const isSelected = !multi && !this.host.modelAuto && row.model.ref === this.host.selectedRef;
		template.selected.classList.toggle('hidden', !isSelected);
		template.star.classList.remove('hidden');
		const favorited = this.host.favorites.has(row.model.ref);
		template.star.classList.toggle('on', favorited);
		template.star.setAttribute('aria-label', favorited
			? localize('voltAgent.unstarModel', "Remove from favorites")
			: localize('voltAgent.starModel', "Add to favorites"));
		template.star.setAttribute('aria-pressed', String(favorited));
		template.star.appendChild(createStarIcon(template.star.ownerDocument, favorited));
		template.disposables.add(addDisposableListener(template.star, 'mousedown', e => e.stopPropagation()));
		template.disposables.add(addDisposableListener(template.star, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.host.onToggleFavorite(row.model.ref);
		}));
	}

	disposeElement(_row: IModelPickerRow, _index: number, template: IModelPickerTemplate): void {
		template.disposables.clear();
	}

	disposeTemplate(template: IModelPickerTemplate): void {
		template.disposables.dispose();
	}
}
