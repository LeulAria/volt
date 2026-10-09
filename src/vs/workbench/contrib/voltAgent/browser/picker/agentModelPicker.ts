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
import { enabledProfileIds, isPickerModelVisible } from '../../../../services/voltRuntime/common/models/modelVisibility.js';
import { compactEffortLabel, describeModelOptions, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, optionValue, splitModelDisplayName, type IModelOptionDescriptor, type IVoltModelOptions } from '../../../../services/voltRuntime/common/models/modelOptions.js';
import type { IVoltCatalogItem } from '../../../../services/voltRuntime/common/providers.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createBrandIcon, providerFamily, providerFamilyLabel } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAutoSparkIcon, IModelPickerRow, ModelPickerListDelegate, ModelPickerListRenderer, pickerListHeight } from './agentModelPickerList.js';
import { parseRememberedModels, RUN_GROUP_MAX_MODELS, RUN_GROUP_MODELS_STORAGE_KEY, toggleRunModel } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { filterPickerModels, sortProviderGroups, MODEL_FAVORITES_STORAGE_KEY, parseFavoriteRefs, PICKER_FAVORITES_TAB, PICKER_SHORTCUT_COUNT, toggleFavoriteRefs, type IModelOption, type IProviderGroup } from './agentModelPickerModel.js';

export type { IModelOption, IProviderGroup } from './agentModelPickerModel.js';
export { PICKER_FAVORITES_TAB } from './agentModelPickerModel.js';

/** Whether the last pick was Auto; the concrete model and its options are kept by the runtime. */
const MODEL_AUTO_STORAGE_KEY = 'volt.agent.modelAuto';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(doc: Document, name: string, attrs: Record<string, string>): SVGElement {
	const el = doc.createElementNS(SVG_NS, name);
	for (const [key, value] of Object.entries(attrs)) {
		el.setAttribute(key, value);
	}
	return el;
}

const SETTINGS_GEAR_PATH = 'M262.29 192.31a64 64 0 1 0 57.4 57.4a64.13 64.13 0 0 0-57.4-57.4M416.39 256a154 154 0 0 1-1.53 20.79l45.21 35.46a10.81 10.81 0 0 1 2.45 13.75l-42.77 74a10.81 10.81 0 0 1-13.14 4.59l-44.9-18.08a16.11 16.11 0 0 0-15.17 1.75A164.5 164.5 0 0 1 325 400.8a15.94 15.94 0 0 0-8.82 12.14l-6.73 47.89a11.08 11.08 0 0 1-10.68 9.17h-85.54a11.11 11.11 0 0 1-10.69-8.87l-6.72-47.82a16.07 16.07 0 0 0-9-12.22a155 155 0 0 1-21.46-12.57a16 16 0 0 0-15.11-1.71l-44.89 18.07a10.81 10.81 0 0 1-13.14-4.58l-42.77-74a10.8 10.8 0 0 1 2.45-13.75l38.21-30a16.05 16.05 0 0 0 6-14.08c-.36-4.17-.58-8.33-.58-12.5s.21-8.27.58-12.35a16 16 0 0 0-6.07-13.94l-38.19-30A10.81 10.81 0 0 1 49.48 186l42.77-74a10.81 10.81 0 0 1 13.14-4.59l44.9 18.08a16.11 16.11 0 0 0 15.17-1.75A164.5 164.5 0 0 1 187 111.2a15.94 15.94 0 0 0 8.82-12.14l6.73-47.89A11.08 11.08 0 0 1 213.23 42h85.54a11.11 11.11 0 0 1 10.69 8.87l6.72 47.82a16.07 16.07 0 0 0 9 12.22a155 155 0 0 1 21.46 12.57a16 16 0 0 0 15.11 1.71l44.89-18.07a10.81 10.81 0 0 1 13.14 4.58l42.77 74a10.8 10.8 0 0 1-2.45 13.75l-38.21 30a16.05 16.05 0 0 0-6.05 14.08c.33 4.14.55 8.3.55 12.47';

/** Gear on the provider tab bar; opens Volt Settings. */
function createSettingsIcon(): HTMLElement {
	const host = $('span.volt-agent-settings-icon');
	const doc = host.ownerDocument;
	const svg = svgEl(doc, 'svg', {
		viewBox: '0 0 512 512',
		width: '16',
		height: '16',
		fill: 'none',
		'aria-hidden': 'true',
		focusable: 'false',
	});
	svg.appendChild(svgEl(doc, 'path', {
		d: SETTINGS_GEAR_PATH,
		fill: 'none',
		stroke: 'currentColor',
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		'stroke-width': '21.333',
	}));
	host.appendChild(svg);
	return host;
}

function editSectionHint(sectionId: 'options' | 'context' | 'effort' | 'custom'): string | undefined {
	switch (sectionId) {
		case 'effort':
			return localize('voltAgent.effortHint', "Effort the model uses to generate its response.");
		case 'context':
			return localize('voltAgent.contextHint', "Context size the model has available.");
		case 'options':
		case 'custom':
			return undefined;
		default: {
			const unexpected: never = sectionId;
			return unexpected;
		}
	}
}

export interface IAgentModelPickerHost {
	onDidChange?: () => void;
	/**
	 * Keeps the pick in a slot of its own (a Settings choice) instead of the composer's model.
	 * The Auto row clears the slot, which means "follow the chat's model".
	 */
	readonly binding?: {
		get(): string | undefined;
		set(ref: string | undefined): void;
		readonly autoLabel: string;
		readonly autoDescription: string;
	};
	/** Where the menu opens against its button. The composer opens it above. */
	readonly position?: AnchorPosition;
	/**
	 * Which button edge the menu lines up with. A right-aligned button grows to the left as its
	 * label changes, so its menu should hang from the right edge to stay put.
	 */
	readonly alignment?: AnchorAlignment;
	/**
	 * Lets the picker send one prompt to several models (each in its own worktree). The composer
	 * offers it only where a send can start them: a new chat in a git project.
	 */
	readonly multi?: {
		/** Undefined when several models can be picked now, else why not. */
		unavailableReason(): string | undefined;
	};
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

function isBooleanOn(descriptor: IModelOptionDescriptor, options: IVoltModelOptions): boolean {
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
	/** Models picked to run side by side; undefined in the usual one-model mode. */
	private multiRefs: string[] | undefined;

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
		this.modelAuto = !this.host.binding && this.storageService.getBoolean(MODEL_AUTO_STORAGE_KEY, StorageScope.APPLICATION, false);
		this.syncCatalog();
		this._register(this.runtime.onDidChangeCatalog(() => {
			this.syncCatalog();
			this.host.onDidChange?.();
		}));
		this._register(this.runtime.onDidChangeProfiles(() => {
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
		const profiles = enabledProfileIds(this.runtime.listProfiles());
		const all = this.runtime.listCatalog();
		this.catalog = all
			.filter(item => isPickerModelVisible(item, profiles))
			.map(catalogToOption)
			.filter(option => option.name.trim().toLowerCase() !== 'auto');
		const binding = this.host.binding;
		if (binding) {
			this.currentModel = binding.get() ?? '';
			this.modelAuto = !this.currentModel;
			return;
		}
		const persisted = this.runtime.getActiveCatalogRef();
		const persistedItem = persisted ? all.find(item => item.ref === persisted) : undefined;
		const persistedHidden = !!persistedItem && !isPickerModelVisible(persistedItem, profiles);
		if (persisted && this.catalog.some(item => item.ref === persisted)) {
			this.currentModel = persisted;
		}
		if (!this.currentModel || !this.catalog.some(item => item.ref === this.currentModel)) {
			// Only shown, never saved: a saved pick is the last model the user chose, and Volt's own runs
			// start on it, so the first catalog entry must not become that choice by default.
			this.currentModel = this.catalog[0]?.ref ?? '';
		}
		// The saved model was turned off (its switch, or its whole provider). Move the chat
		// onto one that is still shown. A model that is merely missing while the catalog
		// loads stays saved, so a new window lands on it once it shows up.
		if (persistedHidden && this.currentModel !== persisted) {
			void this.runtime.setActiveCatalogRef(this.currentModel || undefined);
			return;
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

	/**
	 * The models picked to compare, in pick order. Only where the composer can compare now: the
	 * editor is shared between chats, and a chat that already started keeps its own model.
	 */
	multiModels(): IModelOption[] | undefined {
		if (!this.isMulti()) {
			return undefined;
		}
		return this.multiRefs!.map(ref => this.catalog.find(option => option.ref === ref)).filter((option): option is IModelOption => !!option);
	}

	/** Several models are picked (two or more): a send starts a run per model. */
	isComparing(): boolean {
		return (this.multiModels()?.length ?? 0) >= 2;
	}

	/** In multi mode, whatever the count, where the composer can compare. */
	isMulti(): boolean {
		return !!this.multiRefs && !this.host.multi?.unavailableReason();
	}

	/** Enters multi mode with the remembered set (or the current model), or leaves it. `add` toggles a model in. */
	setMulti(on: boolean, add?: IModelOption): void {
		if (!on) {
			this.multiRefs = undefined;
			this.host.onDidChange?.();
			return;
		}
		if (!this.multiRefs) {
			const available = new Set(this.catalog.map(option => option.ref));
			const remembered = parseRememberedModels(this.storageService.get(RUN_GROUP_MODELS_STORAGE_KEY, StorageScope.APPLICATION), available);
			const current = this.currentModel && !this.modelAuto ? [this.currentModel] : [];
			this.multiRefs = add
				? [...new Set([...current, add.ref])].slice(0, RUN_GROUP_MAX_MODELS)
				: remembered.length ? remembered : current;
		} else if (add) {
			this.multiRefs = toggleRunModel(this.multiRefs.map(ref => ({ ref })), { ref: add.ref }).map(entry => entry.ref);
		}
		this.host.onDidChange?.();
	}

	/** Remembers the set that was just sent, for the next comparison. */
	rememberMulti(): void {
		if (this.multiRefs?.length) {
			this.storageService.store(RUN_GROUP_MODELS_STORAGE_KEY, JSON.stringify(this.multiRefs), StorageScope.APPLICATION, StorageTarget.USER);
		}
	}

	/** Icon + model name, with the selected effort as full text. */
	renderTrigger(button: HTMLElement): void {
		const picked = this.multiModels();
		if (picked) {
			const stack = append(button, $('span.volt-agent-model-stack'));
			for (const model of picked.slice(0, RUN_GROUP_MAX_MODELS)) {
				stack.appendChild(createBrandIcon(model.family, 13));
			}
			const label = append(button, $('span.volt-agent-model-label'));
			label.textContent = picked.length === 1
				? splitModelDisplayName(picked[0].name).name
				: localize('voltAgent.modelsPicked', "{0} models", picked.length);
			button.classList.add('comparing');
			return;
		}
		button.classList.remove('comparing');
		const selected = this.selectedModel();
		if (this.modelAuto) {
			button.appendChild(createAutoSparkIcon());
		} else if (selected) {
			button.appendChild(createBrandIcon(selected.family, 13));
		}
		const label = append(button, $('span.volt-agent-model-label'));
		if (this.modelAuto) {
			label.textContent = this.host.binding?.autoLabel ?? localize('voltAgent.auto', "Auto");
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
			anchorAlignment: this.host.alignment ?? AnchorAlignment.LEFT,
			anchorPosition: this.host.position ?? AnchorPosition.ABOVE,
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
				// The context view drops its own frame for the picker (agentEditor.css).
				const view = container.closest('.context-view');
				view?.classList.add('volt-agent-models-picker-view');
				store.add(toDisposable(() => view?.classList.remove('volt-agent-models-picker-view')));
				menu.setAttribute('role', 'dialog');
				menu.setAttribute('aria-label', localize('voltAgent.modelPickerAria', "Select a model"));
				const panel = append(menu, $('.volt-agent-picker-panel'));
				const flyout = append(menu, $('.volt-agent-picker-flyout.hidden'));
				const optionPanel = append(flyout, $('.volt-agent-picker-flyout-panel'));

				const searchRow = append(panel, $('.volt-agent-picker-search'));
				searchRow.appendChild(createHomeSearchIcon());
				const input = store.add(new InputBox(searchRow, undefined, {
					placeholder: localize('voltAgent.searchModelsPlaceholder', "Search models..."),
					ariaLabel: localize('voltAgent.searchModels', "Search models"),
					tooltip: '',
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

				const tabBar = append(panel, $('.volt-agent-picker-tabbar'));
				const scrollLeftBtn = append(tabBar, $('button.volt-agent-picker-scroll.left.is-hidden')) as HTMLButtonElement;
				scrollLeftBtn.type = 'button';
				scrollLeftBtn.appendChild(renderIcon(Codicon.chevronLeft));
				scrollLeftBtn.setAttribute('aria-label', localize('voltAgent.providersPrevious', "Show previous providers"));
				setAgentTooltip(scrollLeftBtn, localize('voltAgent.providersPrevious', "Show previous providers"));
				const tabs = append(tabBar, $('.volt-agent-provider-tabs'));
				tabs.setAttribute('role', 'tablist');
				tabs.setAttribute('aria-label', localize('voltAgent.providers', "Providers"));
				const scrollRightBtn = append(tabBar, $('button.volt-agent-picker-scroll.right.is-hidden')) as HTMLButtonElement;
				scrollRightBtn.type = 'button';
				scrollRightBtn.appendChild(renderIcon(Codicon.chevronRight));
				scrollRightBtn.setAttribute('aria-label', localize('voltAgent.providersNext', "Show more providers"));
				setAgentTooltip(scrollRightBtn, localize('voltAgent.providersNext', "Show more providers"));
				// Outside the scrolling tab strip, so it stays put however many providers there are.
				const multiHost = this.host.multi;
				let multiToggle: HTMLButtonElement | undefined;
				if (multiHost) {
					multiToggle = append(tabBar, $('button.volt-agent-picker-multi')) as HTMLButtonElement;
					multiToggle.type = 'button';
					multiToggle.appendChild(renderIcon(Codicon.layers));
					store.add(addDisposableListener(multiToggle, 'mousedown', e => e.stopPropagation()));
					store.add(addDisposableListener(multiToggle, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						if (multiHost.unavailableReason()) {
							return;
						}
						this.setMulti(!this.isMulti());
						renderAll();
						search.focus();
					}));
				}
				const settings = append(tabBar, $('button.volt-agent-picker-settings')) as HTMLButtonElement;
				settings.type = 'button';
				settings.appendChild(createSettingsIcon());
				settings.setAttribute('aria-label', localize('voltAgent.openSettings', "Open Volt Settings"));
				setAgentTooltip(settings, localize('voltAgent.openSettings', "Open Volt Settings"));
				store.add(addDisposableListener(settings, 'mousedown', e => e.stopPropagation()));
				store.add(addDisposableListener(settings, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.contextViewService.hideContextView();
					void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
				}));

				const TAB_SCROLL_EPS = 1;
				const scrollTabsBy = (direction: -1 | 1) => {
					const max = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
					const step = Math.max(36, tabs.clientWidth);
					const next = Math.min(max, Math.max(0, tabs.scrollLeft + direction * step));
					tabs.scrollTo({ left: next, behavior: 'smooth' });
				};
				const bindScrollBtn = (button: HTMLButtonElement, direction: -1 | 1) => {
					store.add(addDisposableListener(button, 'mousedown', e => e.stopPropagation()));
					store.add(addDisposableListener(button, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						scrollTabsBy(direction);
					}));
				};
				bindScrollBtn(scrollLeftBtn, -1);
				bindScrollBtn(scrollRightBtn, 1);
				const syncTabScroll = () => {
					if (tabs.clientWidth <= 0) {
						return;
					}
					for (let pass = 0; pass < 4; pass++) {
						const max = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
						const showLeft = tabs.scrollLeft > TAB_SCROLL_EPS;
						const showRight = max > TAB_SCROLL_EPS && tabs.scrollLeft < max - TAB_SCROLL_EPS;
						const leftMatches = scrollLeftBtn.classList.contains('is-hidden') === !showLeft;
						const rightMatches = scrollRightBtn.classList.contains('is-hidden') === !showRight;
						if (leftMatches && rightMatches) {
							break;
						}
						scrollLeftBtn.classList.toggle('is-hidden', !showLeft);
						scrollRightBtn.classList.toggle('is-hidden', !showRight);
					}
				};
				const revealActiveProvider = () => {
					const active = tabs.querySelector('.volt-agent-provider-tab.active');
					if (!isHTMLElement(active)) {
						return;
					}
					const view = tabs.getBoundingClientRect();
					const tab = active.getBoundingClientRect();
					if (tab.left < view.left - TAB_SCROLL_EPS) {
						tabs.scrollLeft -= view.left - tab.left;
					} else if (tab.right > view.right + TAB_SCROLL_EPS) {
						tabs.scrollLeft += tab.right - view.right;
					}
				};
				const updateTabScroll = () => {
					revealActiveProvider();
					syncTabScroll();
					scheduleAtNextAnimationFrame(getWindow(tabs), () => {
						revealActiveProvider();
						syncTabScroll();
					});
				};
				store.add(addDisposableListener(tabs, 'scroll', () => syncTabScroll()));
				const tabResize = new (getWindow(tabs).ResizeObserver)(() => syncTabScroll());
				tabResize.observe(tabs);
				store.add(toDisposable(() => tabResize.disconnect()));

				const body = append(panel, $('.volt-agent-picker-body'));
				const listHost = append(body, $('.volt-agent-picker-list'));
				const multiFooter = append(panel, $('.volt-agent-picker-multi-footer.hidden'));
				const multiCount = append(multiFooter, $('span.count'));
				const multiDone = append(multiFooter, $('button.volt-agent-picker-multi-done')) as HTMLButtonElement;
				multiDone.type = 'button';
				multiDone.textContent = localize('voltAgent.multiDone', "Done");
				store.add(addDisposableListener(multiDone, 'mousedown', e => e.stopPropagation()));
				store.add(addDisposableListener(multiDone, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.contextViewService.hideContextView();
				}));
				const syncMulti = () => {
					const on = this.isMulti();
					menu.classList.toggle('multi', on);
					multiFooter.classList.toggle('hidden', !on);
					if (multiToggle && multiHost) {
						const reason = multiHost.unavailableReason();
						multiToggle.classList.toggle('active', on);
						multiToggle.classList.toggle('disabled', !!reason);
						multiToggle.setAttribute('aria-pressed', String(on));
						const label = reason ?? (on
							? localize('voltAgent.multiOff', "Back to one model")
							: localize('voltAgent.multiOn', "Compare models: run this prompt on several models, each in its own worktree (⇧-click a model)"));
						multiToggle.setAttribute('aria-label', label);
						setAgentTooltip(multiToggle, label);
					}
					if (on) {
						const count = this.multiRefs!.length;
						multiCount.textContent = count < 2
							? localize('voltAgent.multiPickMore', "Pick 2 to {0} models · each runs in its own worktree", RUN_GROUP_MAX_MODELS)
							: localize('voltAgent.multiCount', "{0} of {1} models · each runs in its own worktree", count, RUN_GROUP_MAX_MODELS);
						multiDone.disabled = count < 2;
					}
				};
				let previewTimer: ReturnType<typeof setTimeout> | undefined;
				const listContext = {
					selectedRef: this.currentModel,
					modelAuto: this.modelAuto,
					multi: undefined as ReadonlySet<string> | undefined,
					auto: this.host.binding && { label: this.host.binding.autoLabel, description: this.host.binding.autoDescription },
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
						updateTabScroll();
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
					updateTabScroll();
				};

				const renderList = () => {
					listContext.selectedRef = this.currentModel;
					listContext.modelAuto = this.modelAuto;
					listContext.multi = this.isMulti() ? new Set(this.multiRefs) : undefined;
					syncMulti();
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
						if (!input.value.trim() && this.pickerProviderId === PICKER_FAVORITES_TAB && !this.isMulti()) {
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

				const activateRow = (row: IModelPickerRow | undefined, additive = false) => {
					if (!row || row.kind === 'message' || row.kind === 'skeleton') {
						return;
					}
					// Several models: every pick toggles (⇧/⌘-click starts it from one model, as in T3).
					if (row.kind === 'model' && (this.isMulti() || (additive && multiHost && !multiHost.unavailableReason()))) {
						this.setMulti(true, row.model);
						renderList();
						return;
					}
					if (row.kind === 'settings') {
						this.contextViewService.hideContextView();
						void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
						return;
					}
					if (row.kind === 'auto') {
						this.setModelAuto(true);
						this.host.onDidChange?.();
					} else {
						this.selectModel(row.model);
					}
					this.contextViewService.hideContextView();
				};

				store.add(modelsList.onDidOpen(e => {
					const event = e.browserEvent as MouseEvent | KeyboardEvent | undefined;
					activateRow(e.element, !!event && (event.shiftKey || event.metaKey || event.ctrlKey));
				}));

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
								if (this.isMulti()) {
									this.setMulti(true, model);
									renderList();
									return;
								}
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
							activateRow(modelsList.element(focus), event.shiftKey);
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
		return sortProviderGroups([...groups.values()]);
	}

	/** Selects a catalog model by ref (an agent handed the chat to it). False when it is not in the catalog. */
	selectRef(ref: string): boolean {
		const model = this.catalog.find(option => option.ref === ref);
		if (!model) {
			return false;
		}
		if (model.ref !== this.currentModel || this.modelAuto) {
			this.selectModel(model);
		}
		return true;
	}

	/** Shows a chat's own model without making it the default for new chats. False when it is not in the catalog. */
	showRef(ref: string): boolean {
		const model = this.catalog.find(option => option.ref === ref);
		if (!model) {
			return false;
		}
		if (model.ref !== this.currentModel || this.modelAuto) {
			this.currentModel = model.ref;
			this.modelAuto = false;
			this.pickerProviderId = model.family;
			this.host.onDidChange?.();
		}
		return true;
	}

	private selectModel(model: IModelOption): void {
		this.currentModel = model.ref;
		this.setModelAuto(false);
		this.pickerProviderId = model.family;
		if (this.host.binding) {
			this.host.binding.set(model.ref);
		} else {
			void this.runtime.setActiveCatalogRef(model.ref);
		}
		this.host.onDidChange?.();
	}

	/** Remembered like the picked model, so the next agent tab (in any window) starts on Auto too. */
	private setModelAuto(auto: boolean): void {
		this.modelAuto = auto;
		if (this.host.binding) {
			if (auto) {
				this.currentModel = '';
				this.host.binding.set(undefined);
			}
			return;
		}
		this.storageService.store(MODEL_AUTO_STORAGE_KEY, auto, StorageScope.APPLICATION, StorageTarget.USER);
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
		// Changing an option picks the model too. Select first: the options write resyncs the
		// catalog, which would otherwise snap back to the previously active model.
		const apply = (id: string, value: string | boolean) => {
			const tab = this.pickerProviderId;
			this.selectModel(model);
			this.pickerProviderId = tab;
			void this.runtime.setModelOptions(model.ref, { ...this.runtime.getModelOptions(model.ref), [id]: value });
			onChange();
		};
		for (const section of sections) {
			const block = append(panel, $('.volt-agent-picker-section'));
			const heading = append(block, $('div.volt-agent-picker-section-label'));
			heading.textContent = section.label;
			const hint = editSectionHint(section.id);
			if (hint) {
				if (section.id === 'effort') {
					heading.setAttribute('data-volt-tooltip-compact', '1');
				}
				setAgentTooltip(heading, hint, undefined, undefined, 'end');
			}
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
					const setOn = (next: boolean) => apply(descriptor.id, next);
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
						apply(descriptor.id, choice.value);
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
		flyout.style.position = '';
		flyout.classList.remove('place-start', 'overlap');
		if (flyout.classList.contains('hidden')) {
			return;
		}

		const win = getWindow(menu);
		const gap = 6;
		const pad = 8;
		menu.style.position = 'relative';
		menu.style.overflow = 'visible';
		if (menu.parentElement) {
			menu.parentElement.style.overflow = 'visible';
		}
		flyout.style.position = 'absolute';
		flyout.style.bottom = 'auto';
		const menuRect = menu.getBoundingClientRect();
		const flyoutRect = flyout.getBoundingClientRect();
		const viewW = win.innerWidth;
		const viewH = win.innerHeight;
		const flyoutW = Math.max(flyoutRect.width, 188);
		const flyoutH = Math.min(Math.max(flyout.scrollHeight, flyoutRect.height), 360, viewH - pad * 2);
		const spaceRight = viewW - pad - menuRect.right - gap;
		if (spaceRight >= flyoutW) {
			flyout.style.left = `calc(100% + ${gap}px)`;
			flyout.style.right = 'auto';
		} else {
			flyout.style.left = 'auto';
			flyout.style.right = `calc(100% + ${gap}px)`;
			flyout.classList.add('place-start');
		}

		const rowTop = anchorRow ? anchorRow.getBoundingClientRect().top - menuRect.top : 0;
		const minTop = pad - menuRect.top;
		const maxTop = Math.max(minTop, viewH - pad - flyoutH - menuRect.top);
		flyout.style.top = `${Math.min(Math.max(rowTop, minTop), maxTop)}px`;
		if (flyoutH > viewH - pad * 2) {
			flyout.style.maxHeight = `${Math.max(120, viewH - pad * 2)}px`;
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
