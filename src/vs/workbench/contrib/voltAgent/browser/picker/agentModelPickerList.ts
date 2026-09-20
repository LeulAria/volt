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
import { splitModelDisplayName } from '../../../../services/voltRuntime/common/models/modelOptions.js';
import { pickerShortcutLabel, type IModelOption } from './agentModelPickerModel.js';

export const MODEL_PICKER_ROW_HEIGHT = 28;
export const MODEL_PICKER_LIST_MAX_HEIGHT = 220;

export type IModelPickerRow =
	| { readonly id: string; readonly kind: 'model'; readonly model: IModelOption; readonly index: number }
	| { readonly id: string; readonly kind: 'auto' }
	| { readonly id: string; readonly kind: 'message'; readonly text: string }
	| { readonly id: string; readonly kind: 'settings' }
	| { readonly id: string; readonly kind: 'skeleton' };

export function pickerListHeight(count: number): number {
	return Math.min(Math.max(count, 1) * MODEL_PICKER_ROW_HEIGHT, MODEL_PICKER_LIST_MAX_HEIGHT);
}

export interface IModelPickerListHost {
	selectedRef: string;
	modelAuto: boolean;
	favorites: ReadonlySet<string>;
	subtitle(model: IModelOption): string | undefined;
	onToggleFavorite(ref: string): void;
}

interface IModelPickerTemplate {
	readonly container: HTMLElement;
	readonly check: HTMLElement;
	readonly copy: HTMLElement;
	readonly label: HTMLElement;
	readonly desc: HTMLElement;
	readonly kb: HTMLElement;
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
		const kb = append(container, $('span.kb'));
		const star = append(container, $('button.volt-agent-picker-star')) as HTMLButtonElement;
		star.type = 'button';
		star.tabIndex = -1;
		return { container, check, copy, label, desc, kb, star, disposables: new DisposableStore() };
	}

	renderElement(row: IModelPickerRow, _index: number, template: IModelPickerTemplate): void {
		template.disposables.clear();
		clearNode(template.check);
		template.star.replaceChildren();
		template.star.classList.add('hidden');
		template.kb.textContent = '';
		template.desc.textContent = '';
		template.label.textContent = '';
		template.container.classList.toggle('message', row.kind === 'message' || row.kind === 'settings');
		template.container.classList.toggle('skeleton', row.kind === 'skeleton');

		if (row.kind === 'skeleton') {
			return;
		}
		if (row.kind === 'auto') {
			template.label.textContent = localize('voltAgent.auto', "Auto");
			template.desc.textContent = localize('voltAgent.autoDesc', "Let Volt pick a model");
			if (this.host.modelAuto) {
				template.check.appendChild(renderIcon(Codicon.check));
			}
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

		const selected = !this.host.modelAuto && row.model.ref === this.host.selectedRef;
		template.label.textContent = splitModelDisplayName(row.model.name).name;
		const subtitle = this.host.subtitle(row.model);
		if (subtitle) {
			template.desc.textContent = subtitle;
			template.desc.title = subtitle;
		}
		if (selected) {
			template.check.appendChild(renderIcon(Codicon.check));
		}
		const shortcut = pickerShortcutLabel(row.index);
		if (shortcut) {
			template.kb.textContent = shortcut;
		}
		template.star.classList.remove('hidden');
		const favorited = this.host.favorites.has(row.model.ref);
		template.star.classList.toggle('on', favorited);
		template.star.setAttribute('aria-label', favorited
			? localize('voltAgent.unstarModel', "Remove from favorites")
			: localize('voltAgent.starModel', "Add to favorites"));
		template.star.setAttribute('aria-pressed', String(favorited));
		template.star.appendChild(renderIcon(favorited ? Codicon.starFull : Codicon.starEmpty));
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
