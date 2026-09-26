/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { editorWidgetBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { modelEditSections, modelHoverCard } from '../../../../services/voltRuntime/common/models/harnessCatalog.js';
import { compactEffortLabel, describeModelOptions, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, optionValue, splitModelDisplayName, type IVoltModelOptions } from '../../../../services/voltRuntime/common/models/modelOptions.js';
import type { IVoltCatalogItem } from '../../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createBrandIcon, providerFamily, providerFamilyLabel } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IModelPickerRow, ModelPickerListDelegate, ModelPickerListRenderer, pickerListHeight } from './agentModelPickerList.js';
import { filterPickerModels, MODEL_FAVORITES_STORAGE_KEY, parseFavoriteRefs, PICKER_FAVORITES_TAB, PICKER_SHORTCUT_COUNT, toggleFavoriteRefs, type IModelOption, type IProviderGroup } from './agentModelPickerModel.js';

export type { IModelOption, IProviderGroup } from './agentModelPickerModel.js';
export { PICKER_FAVORITES_TAB } from './agentModelPickerModel.js';

export interface IAgentModelPickerHost {
	onDidChange?: () => void;
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

function focusedRowIndex(rows: readonly IModelPickerRow[], modelIndex: number): number {
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind === 'model' && row.index === modelIndex) {
			return i;
		}
	}
	const fallback = rows.findIndex(row => row.kind === 'model' || row.kind === 'auto' || row.kind === 'settings');
	return fallback;
}

function isBooleanOn(descriptor: IModelOptionDescriptor, options: Readonly<Record<string, unknown>>): boolean {
	return optionValue(descriptor, options) === true;
}

/** Shared model picker used by the agent composer and Browser. */
export class AgentModelPicker extends Disposable {

	catalog: IModelOption[] = [];
	currentModel = '';
	modelAuto = false;
	private pickerProviderId: string | undefined;
	private pickerDetail: { mode: 'preview' | 'edit'; ref: string } | undefined;
	private pickerDetailAnchor: HTMLElement | undefined;
	private favorites = new Set<string>();

	constructor(
		private readonly host: IAgentModelPickerHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.favorites = new Set(parseFavoriteRefs(this.storageService.get(MODEL_FAVORITES_STORAGE_KEY, StorageScope.PROFILE)));
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
		return [this.modelProviderLabel(model), splitModelDisplayName(model.name).name, this.modelOptionsLabel(model)].filter(Boolean).join(' ');
	}

	triggerEffort(): { compact: string; full: string } | undefined {
		if (this.modelAuto) {
			return undefined;
		}
		const model = this.selectedModel();
		if (!model) {
			return undefined;
		}
		const reasoning = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		if (reasoning) {
			const value = optionValue(reasoning, this.runtime.getModelOptions(model.ref));
			const raw = String(value ?? '');
			const choice = reasoning.options?.find(option => option.value === value)
				?? reasoning.options?.find(option => option.value.toLowerCase() === raw.toLowerCase())
				?? reasoning.options?.find(option => compactEffortLabel(option.value, option.label) === compactEffortLabel(raw, raw));
			if (choice) {
				const compact = compactEffortLabel(raw, choice.label);
				if (!compact) {
					return undefined;
				}
				return { compact, full: choice.label };
			}
		}
		const fromName = splitModelDisplayName(model.name);
		if (fromName.effortCompact) {
			return { compact: fromName.effortCompact, full: fromName.effortFull ?? fromName.effortCompact };
		}
		return undefined;
	}

	/** Icon + model name, with the selected effort as full text. */
	renderTrigger(button: HTMLElement): void {
		const selected = this.selectedModel();
		if (this.modelAuto) {
			button.appendChild(createBrandIcon('generic', 13));
		} else if (selected) {
			button.appendChild(createBrandIcon(selected.family, 13));
		}
		const label = append(button, $('span.volt-agent-model-label'));
		if (this.modelAuto) {
			label.textContent = localize('voltAgent.auto', "Auto");
		} else if (selected) {
			label.textContent = splitModelDisplayName(selected.name).name;
		} else {
			label.textContent = localize('voltAgent.connectModel', "Connect a model");
		}
		const effort = this.triggerEffort();
		if (effort) {
			const chip = append(button, $('span.volt-agent-model-effort'));
			chip.textContent = effort.full;
			chip.setAttribute('aria-label', effort.full);
			chip.title = effort.full;
		}
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
		this.pickerProviderId = selected?.family ?? this.pickerProviderId ?? this.providerGroups()[0]?.family;
		this.pickerDetail = undefined;
		this.pickerDetailAnchor = undefined;

		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.ABOVE,
			canRelayout: true,
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
				menu.setAttribute('role', 'dialog');
				menu.setAttribute('aria-label', localize('voltAgent.modelPickerAria', "Select a model"));
				const panel = append(menu, $('.volt-agent-picker-panel'));
				const flyout = append(menu, $('.volt-agent-picker-flyout.hidden'));
				const optionPanel = append(flyout, $('.volt-agent-picker-flyout-panel'));

				const tabs = append(panel, $('.volt-agent-provider-tabs'));
				tabs.setAttribute('role', 'tablist');
				tabs.setAttribute('aria-label', localize('voltAgent.providers', "Providers"));

				const searchRow = append(panel, $('.volt-agent-picker-search'));
				searchRow.appendChild(createHomeSearchIcon());
				const input = store.add(new InputBox(searchRow, undefined, {
					placeholder: localize('voltAgent.searchModelsPlaceholder', "Search models..."),
					ariaLabel: localize('voltAgent.searchModels', "Search models"),
					inputBoxStyles: {
						...defaultInputBoxStyles,
						inputBackground: 'transparent',
						inputBorder: 'transparent',
					},
				}));
				input.element.style.border = 'none';
				const search = input.inputElement;
				search.setAttribute('role', 'combobox');
				search.setAttribute('aria-autocomplete', 'list');
				search.setAttribute('aria-expanded', 'true');

				const body = append(panel, $('.volt-agent-picker-body'));
				const listHost = append(body, $('.volt-agent-picker-list'));
				let previewTimer: ReturnType<typeof setTimeout> | undefined;
				const listContext = {
					selectedRef: this.currentModel,
					modelAuto: this.modelAuto,
					favorites: this.favorites,
					subtitle: (model: IModelOption) => this.modelSubtitle(model),
					rowLabel: (model: IModelOption) => this.modelRowLabel(model),
					canEdit: (model: IModelOption) => modelEditSections(model.optionDescriptors).length > 0,
					onToggleFavorite: (ref: string) => {
						this.toggleFavorite(ref);
						renderList();
					},
					onEdit: (model: IModelOption, anchor: HTMLElement) => {
						this.pickerDetail = { mode: 'edit', ref: model.ref };
						this.pickerDetailAnchor = anchor;
						renderDetail();
						syncFlyout();
					},
					onPreview: (model: IModelOption, anchor: HTMLElement) => {
						if (previewTimer) {
							clearTimeout(previewTimer);
							previewTimer = undefined;
						}
						if (this.pickerDetail?.mode === 'edit') {
							return;
						}
						this.pickerDetail = { mode: 'preview', ref: model.ref };
						this.pickerDetailAnchor = anchor;
						renderDetail();
						syncFlyout();
					},
					onPreviewEnd: () => {
						if (this.pickerDetail?.mode === 'edit') {
							return;
						}
						if (previewTimer) {
							clearTimeout(previewTimer);
						}
						previewTimer = setTimeout(() => {
							previewTimer = undefined;
							if (this.pickerDetail?.mode === 'edit') {
								return;
							}
							this.pickerDetail = undefined;
							this.pickerDetailAnchor = undefined;
							renderDetail();
							syncFlyout();
						}, 120);
					},
				};
				const modelsList = store.add(this.instantiationService.createInstance(
					WorkbenchList<IModelPickerRow>,
					'VoltAgentModelPicker',
					listHost,
					new ModelPickerListDelegate(),
					[new ModelPickerListRenderer(listContext)],
					{
						identityProvider: { getId: (row: IModelPickerRow) => row.id },
						multipleSelectionSupport: false,
						keyboardSupport: false,
						mouseSupport: true,
						horizontalScrolling: false,
						alwaysConsumeMouseWheel: false,
						overrideStyles: {
							listBackground: editorWidgetBackground,
							listActiveSelectionBackground: editorWidgetBackground,
							listInactiveSelectionBackground: editorWidgetBackground,
							listFocusAndSelectionBackground: editorWidgetBackground,
						},
						accessibilityProvider: {
							getWidgetAriaLabel: () => localize('voltAgent.modelListAria', "Models"),
							getAriaLabel: (row: IModelPickerRow) => {
								if (row.kind === 'model') {
									return row.model.name;
								}
								if (row.kind === 'auto') {
									return localize('voltAgent.auto', "Auto");
								}
								if (row.kind === 'message') {
									return row.text;
								}
								if (row.kind === 'skeleton') {
									return localize('voltAgent.loadingModels', "Loading models");
								}
								return localize('voltAgent.openSettings', "Open Volt Settings");
							},
						},
					},
				));
				search.setAttribute('aria-controls', 'volt-agent-picker-models');
				modelsList.getHTMLElement().id = 'volt-agent-picker-models';

				let activeIndex = 0;
				const tabStore = store.add(new DisposableStore());
				const optionStore = store.add(new DisposableStore());

				const visibleModels = () => filterPickerModels(this.providerGroups(), this.pickerProviderId, input.value, this.favorites);
				const relayout = () => scheduleAtNextAnimationFrame(getWindow(menu), () => this.contextViewService.layout());

				const syncFlyout = () => {
					const open = !!this.pickerDetail;
					flyout.classList.toggle('hidden', !open);
					flyout.classList.toggle('card', this.pickerDetail?.mode === 'preview');
					flyout.classList.toggle('options', this.pickerDetail?.mode === 'edit');
					scheduleAtNextAnimationFrame(getWindow(menu), () => this.placePickerFlyout(menu, flyout, this.pickerDetailAnchor));
				};
				store.add(addDisposableListener(flyout, 'mouseenter', () => {
					if (previewTimer) {
						clearTimeout(previewTimer);
						previewTimer = undefined;
					}
				}));
				store.add(addDisposableListener(flyout, 'mouseleave', () => {
					if (this.pickerDetail?.mode !== 'preview') {
						return;
					}
					this.pickerDetail = undefined;
					this.pickerDetailAnchor = undefined;
					renderDetail();
					syncFlyout();
				}));

				const tabIds = () => [PICKER_FAVORITES_TAB, ...this.providerGroups().map(group => group.family)];

				const renderTabs = () => {
					tabStore.clear();
					tabs.replaceChildren();
					const groups = this.providerGroups();
					if (!groups.length && this.runtime.isCatalogLoading()) {
						for (let i = 0; i < 4; i++) {
							append(tabs, $('.volt-agent-provider-tab.skeleton'));
						}
						return;
					}
					const addTab = (id: string, label: string, icon: HTMLElement) => {
						const tab = append(tabs, $('button.volt-agent-provider-tab')) as HTMLButtonElement;
						tab.type = 'button';
						tab.setAttribute('role', 'tab');
						tab.setAttribute('aria-selected', String(id === this.pickerProviderId));
						tab.tabIndex = id === this.pickerProviderId ? 0 : -1;
						tab.classList.toggle('active', id === this.pickerProviderId);
						tab.setAttribute('aria-label', label);
						setAgentTooltip(tab, label);
						tab.appendChild(icon);
						tabStore.add(addDisposableListener(tab, 'click', e => {
							e.preventDefault();
							e.stopPropagation();
							this.pickerProviderId = id;
							this.pickerDetail = undefined;
							this.pickerDetailAnchor = undefined;
							activeIndex = 0;
							renderAll();
							search.focus();
						}));
					};
					addTab(PICKER_FAVORITES_TAB, localize('voltAgent.favorites', "Favorites"), renderIcon(Codicon.star));
					for (const group of groups) {
						addTab(group.family, group.label, createBrandIcon(group.family, 16));
					}
				};

				const renderList = () => {
					listContext.selectedRef = this.currentModel;
					listContext.modelAuto = this.modelAuto;
					listContext.favorites = this.favorites;
					const groups = this.providerGroups();
					const rows: IModelPickerRow[] = [];
					if (!groups.length) {
						if (this.runtime.isCatalogLoading()) {
							for (let i = 0; i < 8; i++) {
								rows.push({ id: `skeleton:${i}`, kind: 'skeleton' });
							}
						} else {
							rows.push({ id: 'settings', kind: 'settings' });
						}
					} else {
						if (!input.value.trim() && this.pickerProviderId === PICKER_FAVORITES_TAB) {
							rows.push({ id: 'auto', kind: 'auto' });
						}
						const models = visibleModels();
						if (!models.length) {
							rows.push({
								id: 'empty',
								kind: 'message',
								text: this.pickerProviderId === PICKER_FAVORITES_TAB && !input.value.trim()
									? localize('voltAgent.noFavorites', "No starred models.")
									: localize('voltAgent.noModels', "No models match."),
							});
						} else {
							if (activeIndex >= models.length) {
								activeIndex = Math.max(0, models.length - 1);
							}
							models.forEach((model, index) => rows.push({ id: model.ref, kind: 'model', model, index }));
						}
					}
					modelsList.splice(0, modelsList.length, rows);
					const height = pickerListHeight(rows.length);
					listHost.style.height = `${height}px`;
					modelsList.layout(height, listHost.clientWidth || undefined);
					const focusIndex = focusedRowIndex(rows, activeIndex);
					if (focusIndex >= 0) {
						modelsList.setFocus([focusIndex]);
						modelsList.reveal(focusIndex);
					} else {
						modelsList.setFocus([]);
					}
					relayout();
				};

				const renderDetail = () => {
					optionStore.clear();
					optionPanel.replaceChildren();
					const detail = this.pickerDetail;
					if (!detail) {
						return;
					}
					const model = this.catalog.find(option => option.ref === detail.ref);
					if (!model) {
						return;
					}
					const options = this.runtime.getModelOptions(model.ref);
					switch (detail.mode) {
						case 'preview':
							this.renderHoverCard(optionPanel, model, options);
							return;
						case 'edit':
							this.renderEditPanel(optionPanel, model, options, optionStore, () => {
								renderList();
								renderDetail();
								syncFlyout();
							});
							return;
						default: {
							const unexpected: never = detail.mode;
							return unexpected;
						}
					}
				};

				const renderAll = () => {
					const groups = this.providerGroups();
					if (this.pickerProviderId !== PICKER_FAVORITES_TAB && !groups.some(group => group.family === this.pickerProviderId)) {
						this.pickerProviderId = groups[0]?.family ?? PICKER_FAVORITES_TAB;
					}
					renderTabs();
					renderList();
					renderDetail();
					syncFlyout();
				};

				const activateRow = (row: IModelPickerRow | undefined) => {
					if (!row || row.kind === 'message' || row.kind === 'skeleton') {
						return;
					}
					if (row.kind === 'settings') {
						this.contextViewService.hideContextView();
						void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
						return;
					}
					if (row.kind === 'auto') {
						this.modelAuto = true;
						this.host.onDidChange?.();
					} else {
						this.selectModel(row.model);
					}
					this.contextViewService.hideContextView();
				};

				store.add(modelsList.onDidOpen(e => activateRow(e.element)));

				const activateTab = (id: string) => {
					if (!id || id === this.pickerProviderId) {
						return;
					}
					this.pickerProviderId = id;
					this.pickerDetail = undefined;
					this.pickerDetailAnchor = undefined;
					activeIndex = 0;
					renderAll();
					tabs.querySelector<HTMLElement>('.volt-agent-provider-tab.active')?.focus();
				};

				store.add(input.onDidChange(() => {
					activeIndex = 0;
					renderList();
				}));
				store.add(this.runtime.onDidChangeCatalog(() => {
					this.syncCatalog();
					this.host.onDidChange?.();
					renderAll();
				}));
				store.add(addDisposableListener(getWindow(menu), 'keydown', e => {
					const event = new StandardKeyboardEvent(e);
					if (event.keyCode === KeyCode.Escape) {
						event.preventDefault();
						event.stopPropagation();
						if (this.pickerDetail) {
							this.pickerDetail = undefined;
							this.pickerDetailAnchor = undefined;
							renderDetail();
							syncFlyout();
							return;
						}
						this.contextViewService.hideContextView();
						onHide?.();
						return;
					}
					const onTab = isHTMLElement(event.target) && event.target.classList.contains('volt-agent-provider-tab');
					if (onTab && (event.keyCode === KeyCode.LeftArrow || event.keyCode === KeyCode.RightArrow || event.keyCode === KeyCode.Home || event.keyCode === KeyCode.End)) {
						event.preventDefault();
						event.stopPropagation();
						const ids = tabIds();
						if (event.keyCode === KeyCode.Home) {
							activateTab(ids[0]);
						} else if (event.keyCode === KeyCode.End) {
							activateTab(ids[ids.length - 1]);
						} else {
							const index = Math.max(0, ids.indexOf(this.pickerProviderId ?? ''));
							activateTab(ids[Math.max(0, Math.min(ids.length - 1, index + (event.keyCode === KeyCode.RightArrow ? 1 : -1)))]);
						}
						return;
					}
					for (let i = 0; i < PICKER_SHORTCUT_COUNT; i++) {
						if (event.equals(KeyMod.CtrlCmd | (KeyCode.Digit1 + i))) {
							const model = visibleModels()[i];
							if (model) {
								event.preventDefault();
								this.selectModel(model);
								this.contextViewService.hideContextView();
							}
							return;
						}
					}
					if (event.keyCode === KeyCode.DownArrow || event.keyCode === KeyCode.UpArrow) {
						if (!modelsList.length) {
							return;
						}
						event.preventDefault();
						const current = modelsList.getFocus()[0] ?? (event.keyCode === KeyCode.DownArrow ? -1 : modelsList.length);
						const next = event.keyCode === KeyCode.DownArrow
							? Math.min(modelsList.length - 1, current + 1)
							: Math.max(0, current - 1);
						modelsList.setFocus([next]);
						modelsList.reveal(next);
						const row = modelsList.element(next);
						if (row.kind === 'model') {
							activeIndex = row.index;
						}
						return;
					}
					if (event.keyCode === KeyCode.Enter) {
						const focus = modelsList.getFocus()[0];
						if (typeof focus === 'number' && event.target === search) {
							event.preventDefault();
							activateRow(modelsList.element(focus));
						}
					}
				}, true));

				this.bindDropdownDismiss(store, menu, anchor);
				store.add(toDisposable(() => {
					menu.remove();
					onHide?.();
				}));
				renderAll();
				scheduleAtNextAnimationFrame(getWindow(menu), () => {
					const height = pickerListHeight(modelsList.length);
					modelsList.layout(height, listHost.clientWidth || undefined);
					this.contextViewService.layout();
					search.focus();
				});
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

	private selectModel(model: IModelOption): void {
		this.currentModel = model.ref;
		this.modelAuto = false;
		this.pickerProviderId = model.family;
		void this.runtime.setActiveCatalogRef(model.ref);
		this.host.onDidChange?.();
	}

	private toggleFavorite(ref: string): void {
		const next = toggleFavoriteRefs([...this.favorites], ref);
		this.favorites = new Set(next);
		this.storageService.store(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.USER);
	}

	private modelSubtitle(model: IModelOption): string | undefined {
		if (this.pickerProviderId === PICKER_FAVORITES_TAB) {
			return this.modelProviderLabel(model);
		}
		return undefined;
	}

	private modelRowLabel(model: IModelOption): string {
		const base = splitModelDisplayName(model.name).name;
		const options = describeModelOptions(model.optionDescriptors, this.runtime.getModelOptions(model.ref));
		return options ? `${base} ${options}` : base;
	}

	private renderHoverCard(panel: HTMLElement, model: IModelOption, options: IVoltModelOptions): void {
		const reasoning = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
		const fast = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_FAST);
		const effort = reasoning ? reasoning.options?.find(choice => choice.value === optionValue(reasoning, options))?.label : undefined;
		const context = this.selectedContextLabel(model, options);
		const card = modelHoverCard(splitModelDisplayName(model.name).name, model.description, context, effort, fast ? isBooleanOn(fast, options) : false);
		const root = append(panel, $('.volt-agent-model-card'));
		append(root, $('div.title')).textContent = card.title;
		if (card.description) {
			append(root, $('p.blurb')).textContent = card.description;
		}
		if (card.context) {
			append(root, $('p.meta')).textContent = card.context;
		}
		if (card.version) {
			append(root, $('p.meta.version')).textContent = card.version;
		}
	}

	private renderEditPanel(
		panel: HTMLElement,
		model: IModelOption,
		options: IVoltModelOptions,
		store: DisposableStore,
		onChange: () => void,
	): void {
		panel.setAttribute('role', 'menu');
		panel.setAttribute('aria-label', localize('voltAgent.modelOptions', "Model options"));
		const sections = modelEditSections(model.optionDescriptors);
		for (const section of sections) {
			const block = append(panel, $('.volt-agent-picker-section'));
			append(block, $('div.volt-agent-picker-section-label')).textContent = section.label;
			for (const descriptor of section.descriptors) {
				if (descriptor.type === 'boolean') {
					const on = isBooleanOn(descriptor, options);
					const row = append(block, $('.volt-agent-picker-row.toggle'));
					append(row, $('span.label')).textContent = descriptor.label;
					const toggle = append(row, $('button.volt-agent-switch')) as HTMLButtonElement;
					toggle.type = 'button';
					toggle.classList.toggle('on', on);
					toggle.setAttribute('role', 'switch');
					toggle.setAttribute('aria-checked', String(on));
					toggle.setAttribute('aria-label', descriptor.label);
					append(toggle, $('span.volt-agent-switch-thumb'));
					const setOn = (next: boolean) => {
						void this.runtime.setModelOptions(model.ref, { ...this.runtime.getModelOptions(model.ref), [descriptor.id]: next });
						this.host.onDidChange?.();
						onChange();
					};
					store.add(addDisposableListener(toggle, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						setOn(!on);
					}));
					store.add(addDisposableListener(row, 'click', e => {
						if (e.target === toggle || toggle.contains(e.target as Node)) {
							return;
						}
						e.preventDefault();
						e.stopPropagation();
						setOn(!on);
					}));
					continue;
				}
				const active = String(optionValue(descriptor, options) ?? '');
				for (const choice of descriptor.options ?? []) {
					const row = append(block, $('button.volt-agent-picker-row.choice')) as HTMLButtonElement;
					row.type = 'button';
					row.setAttribute('role', 'menuitemradio');
					row.setAttribute('aria-checked', String(choice.value === active));
					append(row, $('span.label')).textContent = choice.label;
					const check = append(row, $('span.check'));
					if (choice.value === active) {
						check.appendChild(renderIcon(Codicon.check));
					}
					store.add(addDisposableListener(row, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						void this.runtime.setModelOptions(model.ref, { ...this.runtime.getModelOptions(model.ref), [descriptor.id]: choice.value });
						this.host.onDidChange?.();
						onChange();
					}));
				}
			}
		}
	}

	private selectedContextLabel(model: IModelOption, options: IVoltModelOptions): string | undefined {
		const context = model.optionDescriptors.find(descriptor => descriptor.id === MODEL_OPTION_CONTEXT);
		if (context?.options?.length) {
			const value = optionValue(context, options);
			return context.options.find(choice => choice.value === value)?.label ?? model.contextLabel;
		}
		return model.contextLabel;
	}

	private placePickerFlyout(menu: HTMLElement, flyout: HTMLElement, anchorRow?: HTMLElement): void {
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
		const gap = 6;
		const pad = 8;
		const menuRect = menu.getBoundingClientRect();
		const flyoutRect = flyout.getBoundingClientRect();
		const viewW = win.innerWidth;
		const viewH = win.innerHeight;
		const flyoutW = Math.max(flyoutRect.width, 188);
		const flyoutH = Math.min(Math.max(flyout.scrollHeight, flyoutRect.height), 360, viewH - pad * 2);
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

		const rowTop = anchorRow ? anchorRow.getBoundingClientRect().top - menuRect.top : undefined;
		if (rowTop !== undefined) {
			const maxTop = Math.max(pad - menuRect.top, viewH - pad - flyoutH - menuRect.top);
			const top = Math.min(Math.max(rowTop, pad - menuRect.top), maxTop);
			flyout.style.top = `${top}px`;
			flyout.style.bottom = 'auto';
			if (flyoutH > viewH - pad * 2) {
				flyout.style.maxHeight = `${Math.max(120, viewH - pad * 2)}px`;
			}
			return;
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

	private bindDropdownDismiss(store: DisposableStore, menu: HTMLElement, anchor: HTMLElement): void {
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
	}
}
