/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { describeModelOptions, IModelOptionDescriptor, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, optionValue } from '../../../services/voltRuntime/common/modelOptions.js';
import { IVoltCatalogItem } from '../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createBrandIcon, providerFamily, providerFamilyLabel } from '../../../services/voltRuntime/browser/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import { appendAgentScrollableList } from './agentScrollable.js';
import { setAgentTooltip } from './agentTooltip.js';

export interface IModelOption {
	ref: string;
	name: string;
	qualifier?: string;
	providerId: string;
	family: string;
	optionDescriptors: IModelOptionDescriptor[];
	detail?: string;
	description?: string;
	contextLabel?: string;
	contextWindow: number;
}

type AgentPickerFlyout = 'fast' | 'effort' | 'context' | 'models';

interface IProviderGroup {
	family: string;
	label: string;
	models: IModelOption[];
}

export interface IAgentModelPickerHost {
	onDidChange?: () => void;
}

function createSvgIcon(viewBox: string, pathD: string, extraClass?: string, stroke = false, strokeWidth = '1.5'): HTMLElement {
	const el = extraClass ? $(`span.volt-agent-svg-icon.${extraClass}`) : $('span.volt-agent-svg-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	const parts = viewBox.split(' ');
	svg.setAttribute('width', parts[2] || '24');
	svg.setAttribute('height', parts[3] || '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	if (stroke) {
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', strokeWidth);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
	} else {
		path.setAttribute('fill', 'currentColor');
	}
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createChevronRightIcon(): HTMLElement {
	return createSvgIcon('0 0 24 24', 'm9 18 6-6-6-6', 'chevron-right', true, '2');
}

export function catalogToOption(item: IVoltCatalogItem): IModelOption {
	return {
		ref: item.ref,
		name: item.label,
		qualifier: item.qualifier,
		providerId: item.providerId,
		family: providerFamily(item.providerId),
		optionDescriptors: item.optionDescriptors ?? [],
		detail: item.detail,
		description: item.description,
		contextLabel: item.contextLabel,
		contextWindow: item.capabilities.contextWindow,
	};
}

export function formatTokens(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
	}
	const k = n / 1000;
	return k >= 100 && Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
}

/** Shared Fast / Effort / Model card used by the agent composer and Browser. */
export class AgentModelPicker extends Disposable {

	catalog: IModelOption[] = [];
	currentModel = '';
	modelAuto = false;
	private pickerProviderId: string | undefined;
	private pickerFlyout: AgentPickerFlyout | undefined;

	constructor(
		private readonly host: IAgentModelPickerHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.syncCatalog();
		this._register(this.runtime.onDidChangeCatalog(() => {
			this.syncCatalog();
			this.host.onDidChange?.();
		}));
		this._register(this.runtime.onDidChangeActiveCatalog(() => {
			this.syncCatalog();
			this.host.onDidChange?.();
		}));
	}

	selectedModel(): IModelOption | undefined {
		return this.currentModel ? this.catalog.find(option => option.ref === this.currentModel) : undefined;
	}

	syncCatalog(): void {
		this.catalog = this.runtime.listCatalog()
			.filter(item => item.enabled)
			.map(catalogToOption)
			.filter(option => option.name.trim().toLowerCase() !== 'auto');
		const persisted = this.runtime.getActiveCatalogRef();
		if (persisted && this.catalog.some(item => item.ref === persisted)) {
			this.currentModel = persisted;
		}
		if (!this.currentModel || !this.catalog.some(item => item.ref === this.currentModel)) {
			this.currentModel = this.catalog[0]?.ref ?? '';
		}
		if (this.currentModel && this.currentModel !== persisted) {
			void this.runtime.setActiveCatalogRef(this.currentModel);
		}
	}

	modelProviderLabel(model: IModelOption): string | undefined {
		const label = model.qualifier?.trim() || providerFamilyLabel(model.providerId);
		if (!label || model.name.toLowerCase().includes(label.toLowerCase())) {
			return undefined;
		}
		return label;
	}

	modelOptionsLabel(model: IModelOption): string | undefined {
		return describeModelOptions(model.optionDescriptors, this.runtime.getModelOptions(model.ref));
	}

	modelTitle(model: IModelOption): string {
		return [this.modelProviderLabel(model), model.name, this.modelOptionsLabel(model)].filter(Boolean).join(' ');
	}

	cycleEffort(): void {
		const model = this.selectedModel();
		const reasoning = model?.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		if (!model || !reasoning?.options?.length) {
			return;
		}
		const options = this.runtime.getModelOptions(model.ref);
		const active = optionValue(reasoning, options);
		const index = Math.max(0, reasoning.options.findIndex(choice => choice.value === active));
		const next = reasoning.options[(index + 1) % reasoning.options.length];
		void this.runtime.setModelOptions(model.ref, { ...options, [reasoning.id]: next.value });
		this.host.onDidChange?.();
	}

	show(anchor: HTMLElement, onHide?: () => void): void {
		this.syncCatalog();
		if (!this.catalog.length || this.runtime.isCatalogLoading()) {
			void this.runtime.refreshCatalog();
		}
		const selected = this.catalog.find(option => option.ref === this.currentModel);
		this.pickerProviderId = selected?.family ?? this.pickerProviderId;
		this.pickerFlyout = undefined;

		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			onDOMEvent: (e: Event) => {
				if (e.type !== 'click' || !(e.target instanceof Node)) {
					return;
				}
				const view = this.contextViewService.getContextViewElement();
				if (view.contains(e.target) || anchor.contains(e.target)) {
					return;
				}
				this.contextViewService.hideContextView();
			},
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-agent-dropdown.models.picker'));
				const hover = append(container, $('.volt-agent-model-hover.hidden'));
				const card = append(menu, $('.volt-agent-model-card'));
				const flyout = append(menu, $('.volt-agent-picker-flyout.hidden'));
				const fastPanel = append(flyout, $('.volt-agent-picker-flyout-panel.fast.hidden'));
				append(fastPanel, $('div.volt-agent-picker-tip')).textContent = localize('voltAgent.fastHint', "Significantly faster but consumes more usage");
				const effortPanel = append(flyout, $('.volt-agent-picker-flyout-panel.effort.hidden'));
				const contextPanel = append(flyout, $('.volt-agent-picker-flyout-panel.context.hidden'));
				const modelsPanel = append(flyout, $('.volt-agent-picker-flyout-panel.models.hidden'));

				const searchRow = append(modelsPanel, $('.volt-agent-dropdown-search-row'));
				append(searchRow, createSvgIcon('0 0 24 24', 'M17 17L22 22M19.5 10.75C19.5 15.5825 15.5825 19.5 10.75 19.5C5.91751 19.5 2 15.5825 2 10.75C2 5.91751 5.91751 2 10.75 2C15.5825 2 19.5 5.91751 19.5 10.75Z', 'search', true));
				const search = append(searchRow, $('input.volt-agent-dropdown-search')) as HTMLInputElement;
				search.placeholder = localize('voltAgent.searchModels', "Search models");
				search.type = 'text';

				const body = append(modelsPanel, $('.volt-agent-picker-body'));
				const rail = append(body, $('.volt-agent-provider-rail'));
				const { list, scroll } = appendAgentScrollableList(body);
				store.add(scroll);
				store.add(scroll.onScroll(() => hover.classList.add('hidden')));

				const syncFlyout = () => {
					const open = this.pickerFlyout;
					flyout.classList.toggle('hidden', !open);
					flyout.classList.toggle('fast', open === 'fast');
					flyout.classList.toggle('effort', open === 'effort');
					flyout.classList.toggle('context', open === 'context');
					flyout.classList.toggle('models', open === 'models');
					fastPanel.classList.toggle('hidden', open !== 'fast');
					effortPanel.classList.toggle('hidden', open !== 'effort');
					contextPanel.classList.toggle('hidden', open !== 'context');
					modelsPanel.classList.toggle('hidden', open !== 'models');
					scheduleAtNextAnimationFrame(getWindow(menu), () => {
						this.placePickerFlyout(menu, flyout);
						if (open === 'models') {
							scroll.scanDomNode();
						}
					});
				};
				const openFlyout = (kind: AgentPickerFlyout) => {
					if (this.pickerFlyout === kind) {
						return;
					}
					this.pickerFlyout = kind;
					syncFlyout();
					renderCard();
					if (kind === 'effort') {
						renderEffort();
					}
					if (kind === 'context') {
						renderContext();
					}
				};
				const toggleFlyout = (kind: AgentPickerFlyout) => {
					this.pickerFlyout = this.pickerFlyout === kind ? undefined : kind;
					syncFlyout();
					renderCard();
					if (this.pickerFlyout === 'effort') {
						renderEffort();
					}
					if (this.pickerFlyout === 'context') {
						renderContext();
					}
				};

				const cardStore = store.add(new DisposableStore());
				const effortStore = store.add(new DisposableStore());
				const contextStore = store.add(new DisposableStore());
				const listStore = store.add(new DisposableStore());
				const renderCard = () => {
					cardStore.clear();
					this.renderModelCard(card, cardStore, renderAll, openFlyout, toggleFlyout);
				};
				const closeSelectFlyout = () => {
					this.pickerFlyout = undefined;
					syncFlyout();
					renderCard();
					renderEffort();
					renderContext();
				};
				const renderEffort = () => {
					effortStore.clear();
					this.renderEffortFlyout(effortPanel, effortStore, closeSelectFlyout);
				};
				const renderContext = () => {
					contextStore.clear();
					this.renderContextFlyout(contextPanel, contextStore, closeSelectFlyout);
				};
				const renderModels = () => {
					listStore.clear();
					const groups = this.providerGroups();
					if (!groups.some(group => group.family === this.pickerProviderId)) {
						this.pickerProviderId = groups[0]?.family;
					}
					this.renderProviderRail(rail, groups, listStore, renderModels);
					this.renderModelList(list, groups, search.value, listStore, hover, modelsPanel);
					scroll.scanDomNode();
				};
				const renderAll = () => {
					renderCard();
					renderEffort();
					renderContext();
					renderModels();
					syncFlyout();
				};
				renderAll();
				store.add(this.runtime.onDidChangeCatalog(() => {
					this.syncCatalog();
					this.host.onDidChange?.();
					renderAll();
				}));

				store.add(addDisposableListener(search, 'input', () => renderModels()));
				this.bindDropdownDismiss(store, menu, anchor, onHide);
				store.add(toDisposable(() => {
					menu.remove();
					onHide?.();
				}));
				scheduleAtNextAnimationFrame(getWindow(menu), () => scroll.scanDomNode());
				return store;
			}
		});
	}

	private providerGroups(): IProviderGroup[] {
		const groups = new Map<string, IProviderGroup>();
		for (const option of this.catalog) {
			let group = groups.get(option.family);
			if (!group) {
				group = { family: option.family, label: providerFamilyLabel(option.providerId), models: [] };
				groups.set(option.family, group);
			}
			group.models.push(option);
		}
		return [...groups.values()];
	}

	private placePickerFlyout(menu: HTMLElement, flyout: HTMLElement): void {
		flyout.style.left = '';
		flyout.style.right = '';
		flyout.style.top = '';
		flyout.style.bottom = '';
		flyout.style.maxHeight = '';
		flyout.style.width = '';
		flyout.classList.remove('place-start', 'overlap');
		if (flyout.classList.contains('hidden')) {
			return;
		}

		const win = getWindow(menu);
		const gap = 4;
		const pad = 8;
		const menuRect = menu.getBoundingClientRect();
		const flyoutRect = flyout.getBoundingClientRect();
		const viewW = win.innerWidth;
		const viewH = win.innerHeight;
		const flyoutW = Math.max(
			flyoutRect.width,
			flyout.classList.contains('models')
				? 280
				: (flyout.classList.contains('effort') || flyout.classList.contains('context'))
					? 164
					: flyout.classList.contains('fast')
						? 160
						: 228,
		);
		const flyoutH = Math.min(
			Math.max(flyout.scrollHeight, flyoutRect.height),
			360,
			viewH - pad * 2,
		);
		const spaceRight = viewW - pad - menuRect.right - gap;
		const spaceLeft = menuRect.left - pad - gap;

		if (spaceRight >= flyoutW) {
			flyout.style.left = `calc(100% + ${gap}px)`;
			flyout.style.right = 'auto';
		} else if (spaceLeft >= flyoutW) {
			flyout.style.left = 'auto';
			flyout.style.right = `calc(100% + ${gap}px)`;
			flyout.classList.add('place-start');
		} else {
			let left = 0;
			if (menuRect.left + flyoutW > viewW - pad) {
				left = viewW - pad - flyoutW - menuRect.left;
			}
			if (menuRect.left + left < pad) {
				left = pad - menuRect.left;
			}
			flyout.style.left = `${left}px`;
			flyout.style.right = 'auto';
			flyout.classList.add('overlap');
		}

		const spaceUp = menuRect.bottom - pad;
		const spaceDown = viewH - pad - menuRect.top;
		if (flyoutH <= spaceUp) {
			flyout.style.bottom = '0';
			flyout.style.top = 'auto';
		} else if (flyoutH <= spaceDown) {
			flyout.style.top = '0';
			flyout.style.bottom = 'auto';
		} else {
			flyout.style.maxHeight = `${Math.max(120, viewH - pad * 2)}px`;
			flyout.style.top = `${pad - menuRect.top}px`;
			flyout.style.bottom = 'auto';
		}
	}

	private renderModelCard(card: HTMLElement, store: DisposableStore, refresh: () => void, openFlyout: (kind: AgentPickerFlyout) => void, toggleFlyout: (kind: AgentPickerFlyout) => void): void {
		card.replaceChildren();
		const model = this.catalog.find(option => option.ref === this.currentModel);
		const options = model ? this.runtime.getModelOptions(model.ref) : undefined;
		const reasoning = model?.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		const context = model?.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT && !!descriptor.options?.length);
		const fast = model?.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_FAST);

		if (fast) {
			const row = append(card, $('.volt-agent-picker-row.fast'));
			row.classList.toggle('open', this.pickerFlyout === 'fast');
			append(row, $('span.label')).textContent = localize('voltAgent.fast', "Fast");
			const checked = optionValue(fast, options) === true;
			const toggle = append(row, $('button.volt-agent-switch')) as HTMLButtonElement;
			toggle.classList.toggle('on', checked);
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-checked', String(checked));
			append(toggle, $('span.volt-agent-switch-thumb'));
			store.add(addDisposableListener(row, 'mouseenter', () => openFlyout('fast')));
			store.add(addDisposableListener(toggle, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				if (!model) {
					return;
				}
				void this.runtime.setModelOptions(model.ref, { ...options, [fast.id]: !checked });
				this.host.onDidChange?.();
				refresh();
			}));
		}

		if (reasoning) {
			const row = append(card, $('button.volt-agent-picker-row.choice.effort')) as HTMLButtonElement;
			row.classList.toggle('open', this.pickerFlyout === 'effort');
			append(row, $('span.label')).textContent = localize('voltAgent.effort', "Effort");
			const value = optionValue(reasoning, options);
			const choice = reasoning.options?.find(option => option.value === value);
			const meta = append(row, $('span.meta'));
			append(meta, $('span.value')).textContent = choice?.label ?? '';
			meta.appendChild(createChevronRightIcon());
			store.add(addDisposableListener(row, 'mouseenter', () => openFlyout('effort')));
			store.add(addDisposableListener(row, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				toggleFlyout('effort');
			}));
		}

		if (context) {
			const row = append(card, $('button.volt-agent-picker-row.choice.context')) as HTMLButtonElement;
			row.classList.toggle('open', this.pickerFlyout === 'context');
			append(row, $('span.label')).textContent = localize('voltAgent.tokens', "Tokens");
			const value = optionValue(context, options);
			const choice = context.options?.find(option => option.value === value);
			const meta = append(row, $('span.meta'));
			append(meta, $('span.value')).textContent = choice?.label ?? '';
			meta.appendChild(createChevronRightIcon());
			store.add(addDisposableListener(row, 'mouseenter', () => openFlyout('context')));
			store.add(addDisposableListener(row, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				toggleFlyout('context');
			}));
		}

		if (card.childElementCount) {
			append(card, $('.volt-agent-picker-divider'));
		}

		const modelRow = append(card, $('button.volt-agent-picker-row.choice.model')) as HTMLButtonElement;
		modelRow.classList.toggle('open', this.pickerFlyout === 'models');
		append(modelRow, $('span.label')).textContent = localize('voltAgent.modelRow', "Model");
		const modelMeta = append(modelRow, $('span.meta'));
		append(modelMeta, $('span.value')).textContent = this.modelAuto
			? localize('voltAgent.auto', "Auto")
			: (model ? [this.modelProviderLabel(model), model.name].filter(Boolean).join(' ') : '');
		modelMeta.appendChild(createChevronRightIcon());
		store.add(addDisposableListener(modelRow, 'mouseenter', () => openFlyout('models')));
		store.add(addDisposableListener(modelRow, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			toggleFlyout('models');
		}));
	}

	private renderEffortFlyout(panel: HTMLElement, store: DisposableStore, close: () => void): void {
		this.renderSelectFlyout(panel, store, MODEL_OPTION_REASONING, localize('voltAgent.noEffort', "No effort options."), close);
	}

	private renderContextFlyout(panel: HTMLElement, store: DisposableStore, close: () => void): void {
		this.renderSelectFlyout(panel, store, MODEL_OPTION_CONTEXT, localize('voltAgent.noContext', "No token sizes."), close);
	}

	private renderSelectFlyout(panel: HTMLElement, store: DisposableStore, optionId: string, empty: string, close: () => void): void {
		panel.replaceChildren();
		const model = this.catalog.find(option => option.ref === this.currentModel);
		const descriptor = model?.optionDescriptors.find(option => option.id === optionId);
		if (!model || !descriptor?.options?.length) {
			append(panel, $('.volt-agent-picker-empty')).textContent = empty;
			return;
		}
		const options = this.runtime.getModelOptions(model.ref);
		const active = optionValue(descriptor, options);
		for (const choice of descriptor.options) {
			this.optionChoice(panel, choice.label, choice.value === active, store, () => {
				void this.runtime.setModelOptions(model.ref, { ...options, [descriptor.id]: choice.value });
				this.host.onDidChange?.();
				close();
			});
		}
	}

	private renderProviderRail(rail: HTMLElement, groups: IProviderGroup[], store: DisposableStore, refresh: () => void): void {
		rail.replaceChildren();
		if (!groups.length && this.runtime.isCatalogLoading()) {
			for (let i = 0; i < 4; i++) {
				append(rail, $('.volt-agent-provider-tab.skeleton'));
			}
			return;
		}
		for (const group of groups) {
			const tab = append(rail, $('button.volt-agent-provider-tab')) as HTMLButtonElement;
			tab.classList.toggle('active', group.family === this.pickerProviderId);
			setAgentTooltip(tab, group.label);
			tab.setAttribute('aria-label', group.label);
			tab.appendChild(createBrandIcon(group.family, 16));
			store.add(addDisposableListener(tab, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.pickerProviderId = group.family;
				refresh();
			}));
		}
	}

	private renderModelList(list: HTMLElement, groups: IProviderGroup[], query: string, store: DisposableStore, hover?: HTMLElement, listPanel?: HTMLElement): void {
		hover?.classList.add('hidden');
		list.replaceChildren();
		if (!groups.length) {
			if (this.runtime.isCatalogLoading()) {
				this.renderModelSkeleton(list);
				return;
			}
			const empty = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			append(empty, $('span.name')).textContent = localize('voltAgent.openSettings', "Open Volt Settings");
			store.add(addDisposableListener(empty, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.contextViewService.hideContextView();
				void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
			}));
			return;
		}

		const needle = query.trim().toLowerCase();
		const visibleGroups = groups
			.filter(group => {
				if (this.pickerProviderId === 'cursor' && group.family === 'opencode') {
					return false;
				}
				return !!needle || group.family === this.pickerProviderId;
			})
			.map(group => ({
				...group,
				models: group.models.filter(model => !needle || this.modelTitle(model).toLowerCase().includes(needle)),
			}))
			.filter(group => group.models.length);

		if (!needle) {
			const autoItem = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
			autoItem.classList.toggle('active', this.modelAuto);
			const autoName = append(autoItem, $('span.name'));
			append(autoName, $('span.label')).textContent = localize('voltAgent.auto', "Auto");
			const autoMeta = append(autoItem, $('span.meta'));
			if (this.modelAuto) {
				append(autoMeta, $('span.check')).appendChild(renderIcon(Codicon.check));
			}
			store.add(addDisposableListener(autoItem, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.modelAuto = true;
				this.host.onDidChange?.();
				this.contextViewService.hideContextView();
			}));
		}

		if (!visibleGroups.length) {
			append(list, $('.volt-agent-picker-empty')).textContent = localize('voltAgent.noModels', "No models match.");
			return;
		}

		for (const group of visibleGroups) {
			if (group.family !== 'cursor') {
				const heading = append(list, $('.volt-agent-picker-group'));
				heading.dataset.family = group.family;
				heading.appendChild(createBrandIcon(group.family, 12));
				append(heading, $('span')).textContent = group.label;
			}
			for (const model of group.models) {
				const item = append(list, $('button.volt-agent-dropdown-item')) as HTMLButtonElement;
				item.classList.toggle('active', !this.modelAuto && model.ref === this.currentModel);
				if (group.family !== 'cursor') {
					append(item, $('span.icon')).appendChild(createBrandIcon(model.family, 14));
				}
				const name = append(item, $('span.name'));
				append(name, $('span.label')).textContent = [model.name, this.modelOptionsLabel(model)].filter(Boolean).join(' ');
				const meta = append(item, $('span.meta'));
				if (!this.modelAuto && model.ref === this.currentModel) {
					append(meta, $('span.check')).appendChild(renderIcon(Codicon.check));
				}
				store.add(addDisposableListener(item, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.currentModel = model.ref;
					this.modelAuto = false;
					void this.runtime.setActiveCatalogRef(model.ref);
					this.pickerProviderId = model.family;
					this.host.onDidChange?.();
					this.contextViewService.hideContextView();
				}));
				if (hover && listPanel) {
					this.bindModelHover(item, model, hover, listPanel, store);
				}
			}
		}
	}

	private bindModelHover(item: HTMLElement, model: IModelOption, hover: HTMLElement, listPanel: HTMLElement, store: DisposableStore): void {
		const win = getWindow(item);
		let timer: number | undefined;
		const clearTimer = () => {
			if (timer !== undefined) {
				win.clearTimeout(timer);
				timer = undefined;
			}
		};
		const show = () => {
			this.fillModelHover(hover, model);
			hover.classList.remove('hidden');
			const itemRect = item.getBoundingClientRect();
			const panelRect = listPanel.getBoundingClientRect();
			const width = hover.offsetWidth || 228;
			const height = hover.offsetHeight || 80;
			let left = panelRect.right + 4;
			if (left + width > win.innerWidth - 8) {
				left = Math.max(8, panelRect.left - width - 4);
			}
			let top = itemRect.top;
			if (top + height > win.innerHeight - 8) {
				top = Math.max(8, win.innerHeight - height - 8);
			}
			hover.style.left = `${left}px`;
			hover.style.top = `${top}px`;
		};
		store.add(addDisposableListener(item, 'mouseenter', () => {
			clearTimer();
			timer = win.setTimeout(() => {
				timer = undefined;
				show();
			}, hover.classList.contains('hidden') ? 80 : 0);
		}));
		store.add(addDisposableListener(item, 'mouseleave', () => {
			clearTimer();
			timer = win.setTimeout(() => {
				timer = undefined;
				hover.classList.add('hidden');
			}, 160);
		}));
		store.add(toDisposable(() => {
			clearTimer();
			hover.classList.add('hidden');
		}));
	}

	private fillModelHover(hover: HTMLElement, model: IModelOption): void {
		hover.replaceChildren();
		append(hover, $('div.title')).textContent = this.modelTitle(model);
		const description = model.description?.trim();
		if (description) {
			append(hover, $('div.desc')).textContent = description;
		} else if (model.detail?.trim() && !this.modelVersionLabel(model)) {
			append(hover, $('div.desc')).textContent = model.detail.trim();
		}
		const context = this.modelContextLabel(model);
		if (context) {
			append(hover, $('div.context')).textContent = localize('voltAgent.contextWindow', "{0} context window", context);
		}
		const version = this.modelVersionLabel(model);
		if (version) {
			const line = append(hover, $('div.version'));
			line.append(localize('voltAgent.modelVersion', "Version: "));
			append(line, $('em')).textContent = version;
		}
	}

	private modelContextLabel(model: IModelOption): string | undefined {
		const context = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT);
		if (context) {
			const value = optionValue(context, this.runtime.getModelOptions(model.ref));
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
		return model.contextLabel ?? (model.contextWindow ? formatTokens(model.contextWindow) : undefined);
	}

	private modelVersionLabel(model: IModelOption): string | undefined {
		const reasoning = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		if (reasoning) {
			const value = optionValue(reasoning, this.runtime.getModelOptions(model.ref));
			const choice = reasoning.options?.find(option => option.value === value);
			if (choice) {
				const effort = choice.label.toLowerCase();
				return effort.includes('effort') ? effort : localize('voltAgent.effortVersion', "{0} effort", effort);
			}
		}
		return model.detail?.trim() || undefined;
	}

	private renderModelSkeleton(list: HTMLElement): void {
		const skeleton = append(list, $('.volt-agent-picker-skeleton'));
		for (let i = 0; i < 8; i++) {
			const row = append(skeleton, $('.volt-agent-skeleton-row'));
			append(row, $('span.volt-agent-skeleton-bar'));
		}
	}

	private optionChoice(parent: HTMLElement, label: string, checked: boolean, store: DisposableStore, onSelect: () => void): void {
		const row = append(parent, $('button.volt-agent-picker-row.choice')) as HTMLButtonElement;
		row.classList.toggle('active', checked);
		append(row, $('span.label')).textContent = label;
		if (checked) {
			append(row, $('span.check')).appendChild(renderIcon(Codicon.check));
		}
		store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			onSelect();
		}));
	}

	private bindDropdownDismiss(store: DisposableStore, menu: HTMLElement, anchor: HTMLElement, onHide?: () => void): void {
		const hideIfOutside = (target: EventTarget | null) => {
			if (!(target instanceof Node)) {
				return;
			}
			if (menu.contains(target) || anchor.contains(target)) {
				return;
			}
			this.contextViewService.hideContextView();
		};
		store.add(addDisposableListener(getWindow(menu).document, 'mousedown', e => hideIfOutside(e.target), true));
		store.add(addDisposableListener(getWindow(menu), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.contextViewService.hideContextView();
				onHide?.();
			}
		}));
	}
}
