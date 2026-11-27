/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltPluginUi.css';
import { $, addDisposableListener, append, EventHelper, getWindow } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltAgentWindowService } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IVoltPluginService } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltSlotMenuEntry, VOLT_VIEW_LOCATIONS, VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
// agentSurfaceHost first: it and agentFilesSidebar import each other, and the cycle must be entered from agentSurfaceHost.
import { closeAgentToolEditor, revealAgentToolEditor, shownAgentToolEditors, toggleAgentFilesSidebar } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { AgentFilesSidebar } from '../../voltAgent/browser/workspace/agentFilesSidebar.js';
import { isAnyVoltSlotId, IVoltSlotService, moveVoltSlotItem, VOLT_SLOTS, VoltSlotId } from '../common/voltSlots.js';
import { IVoltIconService, renderVoltLayoutGlyph } from './voltIconService.js';
import { IVoltItemState, IVoltPluginItem, IVoltPluginSettingsPage, IVoltPluginUiService, IVoltPluginView, IVoltSlotItemRenderer, IVoltSlotMountOptions, VOLT_LAYOUT_ICONS_SETTING, VOLT_LAYOUT_SLOTS_SETTING, VOLT_LAYOUT_VIEWS_SETTING, VOLT_SLOT_ITEM_MIME, VoltSlotLook } from './voltPluginUi.js';
import { IVoltPluginViewInfo, setVoltPluginViewLookup, VoltPluginPopover, voltPluginViewHostFactory, VoltPluginViewInput } from './voltPluginViews.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.layout',
	order: 7,
	title: localize('voltLayout.title', "Volt Layout"),
	type: 'object',
	properties: {
		[VOLT_LAYOUT_SLOTS_SETTING]: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'array', items: { type: 'string' } },
			markdownDescription: localize('voltLayout.slots', "Where you moved buttons, chips and menus: slot id → item ids, in order. Drag a button to another place in the agent window, or use Settings > Plugin Layout. Wins over the layout's `slots`."),
		},
		[VOLT_LAYOUT_VIEWS_SETTING]: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'string', enum: [...VOLT_VIEW_LOCATIONS] },
			markdownDescription: localize('voltLayout.views', "Where each plugin view opens: view id → `rightPanel`, `filesSidebar`, `page`, `popover`, `aboveComposer` or `sidebarSection`."),
		},
		[VOLT_LAYOUT_ICONS_SETTING]: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'string' },
			markdownDescription: localize('voltLayout.icons', "Icons you picked for plugin buttons and views: id → `aria:<set>:<name>` (Aria Icons) or `codicon:<id>`."),
		},
	},
});

const HIDDEN_VIEWS_KEY = 'volt.pluginUi.hiddenViews';
const VIEW_LOCATION_LABELS: Record<VoltViewLocation, string> = {
	rightPanel: localize('voltLayout.loc.rightPanel', "Right Panel Tab"),
	filesSidebar: localize('voltLayout.loc.filesSidebar', "Files Sidebar"),
	page: localize('voltLayout.loc.page', "Full Page"),
	popover: localize('voltLayout.loc.popover', "Popover"),
	aboveComposer: localize('voltLayout.loc.aboveComposer', "Above the Composer"),
	sidebarSection: localize('voltLayout.loc.sidebarSection', "Left Sidebar Section"),
};

export function voltViewLocationLabel(location: VoltViewLocation): string {
	return VIEW_LOCATION_LABELS[location];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

type MenuPick = { readonly kind: 'entry'; readonly entry: IVoltSlotMenuEntry }
	| { readonly kind: 'move'; readonly slot: VoltSlotId }
	| { readonly kind: 'open'; readonly location: VoltViewLocation }
	| { readonly kind: 'reset' } | { readonly kind: 'layout' };

export class VoltPluginUiService extends Disposable implements IVoltPluginUiService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeShownViews = this._register(new Emitter<void>());
	readonly onDidChangeShownViews = this._onDidChangeShownViews.event;
	private readonly _onDidChangeRenderers = this._register(new Emitter<void>());
	readonly onDidChangeRenderers = this._onDidChangeRenderers.event;

	private _items: IVoltPluginItem[] = [];
	private _views = new Map<string, IVoltPluginView>();
	private _pages: IVoltPluginSettingsPage[] = [];
	private readonly states = new Map<string, IVoltItemState>();
	private readonly renderers = new Map<string, IVoltSlotItemRenderer>();
	private hiddenViews: Set<string>;
	private readonly popover = this._register(new MutableDisposable<VoltPluginPopover>());
	private readonly rebuild = this._register(new RunOnceScheduler(() => this.build(), 50));
	/** The slot being dragged over, for the drop marker. */
	private dragging: string | undefined;

	constructor(
		@IVoltPluginService private readonly pluginService: IVoltPluginService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IVoltSlotService private readonly slotService: IVoltSlotService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IVoltAgentWindowService private readonly agentWindow: IVoltAgentWindowService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IVoltIconService private readonly iconService: IVoltIconService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.hiddenViews = new Set(this.readHiddenViews());
		this._register(pluginService.onDidChange(() => this.rebuild.schedule()));
		this._register(extensionService.onDidChangeExtensions(() => this.rebuild.schedule()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_LAYOUT_SLOTS_SETTING)) {
				this.slotService.setUserSlots(this.readUserSlots());
			}
			if (e.affectsConfiguration(VOLT_LAYOUT_VIEWS_SETTING) || e.affectsConfiguration(VOLT_LAYOUT_ICONS_SETTING)) {
				this._onDidChange.fire();
				this._onDidChangeShownViews.fire();
			}
		}));
		this.slotService.setUserSlots(this.readUserSlots());
		setVoltPluginViewLookup(viewId => this.viewInfo(viewId));
		this.build();
		// Extensions are read once they are registered (the plugin service reads them too).
		void extensionService.whenInstalledExtensionsRegistered().then(() => this.rebuild.schedule());
	}

	// --- Model ---------------------------------------------------------------------------------

	private build(): void {
		const descriptions = new Map<string, IExtensionDescription>();
		for (const description of this.extensionService.extensions) {
			descriptions.set(ExtensionIdentifier.toKey(description.identifier), description);
		}
		const items: IVoltPluginItem[] = [];
		const views = new Map<string, IVoltPluginView>();
		const pages: IVoltPluginSettingsPage[] = [];
		const builtinItems = new Set(this.slotService.items.filter(item => !item.extensionId).map(item => item.id));
		for (const entry of this.pluginService.plugins()) {
			const contributes = entry.manifest.contributes ?? {};
			const description = descriptions.get(ExtensionIdentifier.toKey(entry.extensionId));
			const extensionLocation = description?.extensionLocation;
			for (const view of contributes.voltViews ?? []) {
				if (views.has(view.id)) {
					continue;
				}
				const locations = view.locations?.length ? view.locations : VOLT_VIEW_LOCATIONS;
				views.set(view.id, {
					id: view.id, title: view.title, description: view.description, icon: view.icon,
					extensionId: entry.extensionId, extensionLocation,
					defaultLocation: view.location && locations.includes(view.location) ? view.location : locations[0],
					locations,
					size: view.size,
				});
			}
			for (const item of contributes.voltSlotItems ?? []) {
				// Volt's own buttons (the built-in features' manifests list them) are the agent list's.
				if (builtinItems.has(item.id) || items.some(candidate => candidate.id === item.id)) {
					continue;
				}
				const slot = item.slot && isAnyVoltSlotId(item.slot) && item.slot !== 'hidden' ? item.slot : 'sidebar.footer';
				items.push({
					id: item.id, label: item.label, description: item.description ?? item.label,
					defaultSlot: slot, extensionId: entry.extensionId, extensionLocation,
					icon: item.icon, kind: item.kind ?? (item.menu?.length ? 'menu' : 'button'),
					command: item.command, view: item.view, menu: item.menu,
				});
			}
			if (entry.firstParty) {
				continue;
			}
			const extensionLabel = description?.displayName ?? description?.name ?? entry.extensionId;
			for (const page of contributes.voltSettingsPages ?? []) {
				pages.push({
					id: `${entry.extensionId}/${page.id}`, label: page.label, description: page.description, icon: page.icon,
					extensionId: entry.extensionId, extensionLabel, extensionLocation, settings: page.settings ?? [], view: page.view,
				});
			}
			// A plugin with settings and no page of its own still gets one: its settings, natively.
			if (!contributes.voltSettingsPages?.length && description && hasConfiguration(description) && (contributes.voltViews?.length || contributes.voltSlotItems?.length)) {
				pages.push({ id: `${entry.extensionId}/settings`, label: extensionLabel, extensionId: entry.extensionId, extensionLabel, extensionLocation, settings: [], icon: contributes.voltViews?.[0]?.icon ?? contributes.voltSlotItems?.[0]?.icon });
			}
		}
		this._items = items;
		this._views = views;
		this._pages = pages;
		this.slotService.setPluginItems(items);
		this._onDidChange.fire();
		this._onDidChangeShownViews.fire();
	}

	items(): readonly IVoltPluginItem[] {
		return this._items;
	}

	item(id: string): IVoltPluginItem | undefined {
		return this._items.find(item => item.id === id);
	}

	views(): readonly IVoltPluginView[] {
		return [...this._views.values()];
	}

	view(id: string): IVoltPluginView | undefined {
		return this._views.get(id);
	}

	settingsPages(): readonly IVoltPluginSettingsPage[] {
		return this._pages;
	}

	itemState(id: string): IVoltItemState | undefined {
		return this.states.get(id);
	}

	updateItem(extensionId: string, itemId: string, state: IVoltItemState): void {
		const item = this.item(itemId);
		if (!item || !ExtensionIdentifier.equals(item.extensionId, extensionId)) {
			throw new Error(`${extensionId} has no item ${itemId} (contributes.voltSlotItems)`);
		}
		this.states.set(itemId, { ...this.states.get(itemId), ...state });
		this._onDidChange.fire();
	}

	private viewInfo(viewId: string): IVoltPluginViewInfo | undefined {
		const view = this._views.get(viewId);
		return view ? { title: view.title, extensionId: view.extensionId, extensionLocation: view.extensionLocation, size: view.size } : undefined;
	}

	// --- The user's layout ---------------------------------------------------------------------

	private readUserSlots(): Record<string, string[]> | undefined {
		const value = this.configurationService.getValue<unknown>(VOLT_LAYOUT_SLOTS_SETTING);
		if (!isRecord(value)) {
			return undefined;
		}
		const slots: Record<string, string[]> = {};
		for (const [slot, items] of Object.entries(value)) {
			if (isAnyVoltSlotId(slot) && Array.isArray(items)) {
				slots[slot] = items.filter((item): item is string => typeof item === 'string');
			}
		}
		return Object.keys(slots).length ? slots : undefined;
	}

	viewLocation(viewId: string): VoltViewLocation {
		const view = this._views.get(viewId);
		const chosen = this.configurationService.getValue<Record<string, unknown>>(VOLT_LAYOUT_VIEWS_SETTING)?.[viewId];
		if (view && typeof chosen === 'string' && view.locations.includes(chosen as VoltViewLocation)) {
			return chosen as VoltViewLocation;
		}
		return view?.defaultLocation ?? 'rightPanel';
	}

	async setViewLocation(viewId: string, location: VoltViewLocation): Promise<void> {
		const before = this.viewLocation(viewId);
		await this.closeView(viewId, before);
		const current = this.configurationService.getValue<Record<string, unknown>>(VOLT_LAYOUT_VIEWS_SETTING);
		await this.configurationService.updateValue(VOLT_LAYOUT_VIEWS_SETTING, { ...(isRecord(current) ? current : {}), [viewId]: location }, ConfigurationTarget.USER);
		this.setViewHidden(viewId, false);
		await this.showView(viewId);
	}

	iconFor(id: string): string | undefined {
		const chosen = this.configurationService.getValue<Record<string, unknown>>(VOLT_LAYOUT_ICONS_SETTING)?.[id];
		if (typeof chosen === 'string' && chosen) {
			return chosen;
		}
		return this.states.get(id)?.icon ?? this.item(id)?.icon ?? this._views.get(id)?.icon;
	}

	async setIcon(id: string, icon: string | undefined): Promise<void> {
		const current = this.configurationService.getValue<Record<string, unknown>>(VOLT_LAYOUT_ICONS_SETTING);
		const next: Record<string, unknown> = { ...(isRecord(current) ? current : {}) };
		if (icon) {
			next[id] = icon;
		} else {
			delete next[id];
		}
		await this.configurationService.updateValue(VOLT_LAYOUT_ICONS_SETTING, next, ConfigurationTarget.USER);
	}

	async moveItem(itemId: string, slot: VoltSlotId, beforeId?: string): Promise<void> {
		const next = moveVoltSlotItem(this.slotService.placement, this.slotService.userSlots, itemId, slot, beforeId);
		// Shown at once; the setting follows.
		this.slotService.setUserSlots(next);
		await this.configurationService.updateValue(VOLT_LAYOUT_SLOTS_SETTING, next, ConfigurationTarget.USER);
	}

	async resetLayout(): Promise<void> {
		await this.configurationService.updateValue(VOLT_LAYOUT_SLOTS_SETTING, undefined, ConfigurationTarget.USER);
		await this.configurationService.updateValue(VOLT_LAYOUT_VIEWS_SETTING, undefined, ConfigurationTarget.USER);
		this.slotService.setUserSlots(undefined);
	}

	// --- Views ---------------------------------------------------------------------------------

	private readHiddenViews(): string[] {
		try {
			const value = JSON.parse(this.storageService.get(HIDDEN_VIEWS_KEY, StorageScope.PROFILE, '[]'));
			return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return [];
		}
	}

	private setViewHidden(viewId: string, hidden: boolean): void {
		if (this.hiddenViews.has(viewId) === hidden) {
			return;
		}
		if (hidden) {
			this.hiddenViews.add(viewId);
		} else {
			this.hiddenViews.delete(viewId);
		}
		this.storageService.store(HIDDEN_VIEWS_KEY, JSON.stringify([...this.hiddenViews]), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeShownViews.fire();
	}

	shownViews(location: 'aboveComposer' | 'sidebarSection' | 'filesSidebar'): readonly string[] {
		return this.views().filter(view => this.viewLocation(view.id) === location && !this.hiddenViews.has(view.id)).map(view => view.id);
	}

	mountView(viewId: string, container: HTMLElement, location: VoltViewLocation): IDisposable {
		return voltPluginViewHostFactory(this.instantiationService, viewId, this.viewInfo(viewId), container, location);
	}

	private isViewOpen(viewId: string, location: VoltViewLocation): boolean {
		switch (location) {
			case 'popover': return this.popover.value?.viewId === viewId;
			case 'rightPanel': return shownAgentToolEditors().some(editor => editor instanceof VoltPluginViewInput && editor.viewId === viewId);
			case 'page': return this.editorService.activeEditor instanceof VoltPluginViewInput && this.editorService.activeEditor.viewId === viewId;
			case 'filesSidebar': return AgentFilesSidebar.isOpen(this.storageService) && AgentFilesSidebar.view(this.storageService) === `plugin:${viewId}`;
			case 'aboveComposer':
			case 'sidebarSection': return !this.hiddenViews.has(viewId);
		}
	}

	async toggleView(viewId: string, anchor?: HTMLElement): Promise<void> {
		const location = this.viewLocation(viewId);
		if (this.isViewOpen(viewId, location)) {
			await this.closeView(viewId, location);
		} else {
			await this.showView(viewId, anchor);
		}
	}

	private async closeView(viewId: string, location: VoltViewLocation): Promise<void> {
		switch (location) {
			case 'popover':
				if (this.popover.value?.viewId === viewId) {
					this.popover.clear();
				}
				break;
			case 'rightPanel':
				for (const editor of shownAgentToolEditors()) {
					if (editor instanceof VoltPluginViewInput && editor.viewId === viewId) {
						closeAgentToolEditor(editor);
					}
				}
				break;
			case 'page': {
				const page = this.editorService.editors.find(editor => editor instanceof VoltPluginViewInput && editor.viewId === viewId && editor.asPage);
				if (page) {
					for (const identifier of this.editorService.findEditors(page.resource!)) {
						await this.editorService.closeEditor(identifier);
					}
				}
				break;
			}
			case 'filesSidebar':
				if (AgentFilesSidebar.view(this.storageService) === `plugin:${viewId}`) {
					AgentFilesSidebar.setOpen(this.storageService, false);
				}
				break;
			case 'aboveComposer':
			case 'sidebarSection':
				this.setViewHidden(viewId, true);
				break;
		}
	}

	async showView(viewId: string, anchor?: HTMLElement): Promise<void> {
		const info = this.viewInfo(viewId);
		if (!info) {
			this.logService.warn(`[volt] no plugin view ${viewId}`);
			return;
		}
		const location = this.viewLocation(viewId);
		switch (location) {
			case 'popover': {
				const popover = this.instantiationService.createInstance(VoltPluginPopover, viewId, info, anchor, this.layoutService.activeContainer);
				this.popover.value = popover;
				Event.once(popover.onDidClose)(() => {
					if (this.popover.value === popover) {
						this.popover.clearAndLeak();
					}
				});
				return;
			}
			case 'rightPanel': {
				const existing = shownAgentToolEditors().find(editor => editor instanceof VoltPluginViewInput && editor.viewId === viewId);
				if (existing && revealAgentToolEditor(existing)) {
					return;
				}
				const input = new VoltPluginViewInput(viewId, info, false);
				const opened = this.agentWindow.openInTools(input, this.agentWindow.visibleChat(), { pinned: true });
				if (opened) {
					await opened;
				} else {
					await this.editorService.openEditor(input, { pinned: true });
				}
				return;
			}
			case 'page':
				await this.editorService.openEditor(new VoltPluginViewInput(viewId, info, true), { pinned: true }, ACTIVE_GROUP);
				return;
			case 'filesSidebar':
				AgentFilesSidebar.show(this.storageService, `plugin:${viewId}`);
				if (!AgentFilesSidebar.isOpen(this.storageService)) {
					toggleAgentFilesSidebar(`plugin:${viewId}`);
				}
				return;
			case 'aboveComposer':
			case 'sidebarSection':
				this.setViewHidden(viewId, false);
				return;
		}
	}

	// --- Slots ---------------------------------------------------------------------------------

	registerItemRenderer(id: string, renderer: IVoltSlotItemRenderer): IDisposable {
		this.renderers.set(id, renderer);
		this._onDidChangeRenderers.fire();
		return toDisposable(() => {
			if (this.renderers.get(id) === renderer) {
				this.renderers.delete(id);
				this._onDidChangeRenderers.fire();
			}
		});
	}

	mountSlot(container: HTMLElement, slot: VoltSlotId, options: IVoltSlotMountOptions): IDisposable {
		const store = new DisposableStore();
		const rendered = store.add(new DisposableStore());
		let buttons: HTMLElement[] = [];
		const render = () => {
			rendered.clear();
			for (const button of buttons) {
				button.remove();
			}
			buttons = [];
			const before = options.before?.() ?? null;
			for (const id of this.slotService.placement[slot] ?? []) {
				const button = this.createButton(id, slot, options.look, options.buttonClass, rendered);
				if (button) {
					container.insertBefore(button, before && before.parentNode === container ? before : null);
					buttons.push(button);
				}
			}
			container.classList.toggle('volt-slot-empty', buttons.length === 0);
			// A move just landed: the icons glide from where they were, and the dropped one settles in.
			this.animateSlotRender(buttons);
			options.onDidRender?.();
		};
		container.classList.add('volt-slot-host');
		container.dataset.voltSlot = slot;
		this.makeDropTarget(container, slot, store, options.vertical);
		store.add(this.slotService.onDidChange(render));
		store.add(this.onDidChange(render));
		store.add(this.onDidChangeRenderers(render));
		render();
		store.add(toDisposable(() => {
			for (const button of buttons) {
				button.remove();
			}
		}));
		return store;
	}

	createButton(itemId: string, slot: VoltSlotId, look: VoltSlotLook, buttonClass: string, store: DisposableStore): HTMLButtonElement | undefined {
		const plugin = this.item(itemId);
		const renderer = plugin ? undefined : this.renderers.get(itemId);
		if (!plugin && !renderer) {
			return undefined;
		}
		const state = this.states.get(itemId);
		if (state?.hidden) {
			return undefined;
		}
		const button = $('button.volt-slot-button') as HTMLButtonElement;
		button.type = 'button';
		button.className = `${buttonClass} volt-slot-button is-${look}`;
		button.dataset.voltItem = itemId;
		const label = state?.label ?? plugin?.label ?? renderer!.label;
		const leading = append(button, $('span.volt-slot-button-icon'));
		if (plugin) {
			leading.appendChild(this.iconService.render(this.iconFor(itemId), plugin.extensionLocation));
		} else {
			leading.appendChild(renderer!.icon());
		}
		const showsLabel = look === 'row' || (look === 'chip' && (plugin?.kind !== 'button' || !!state?.label));
		if (showsLabel) {
			append(button, $('span.volt-slot-button-label')).textContent = label;
		}
		if (state?.badge) {
			append(button, $('span.volt-slot-button-badge')).textContent = state.badge;
		}
		if (plugin?.kind === 'menu' && look !== 'icon') {
			append(button, $('span.volt-slot-button-chevron')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		}
		if (state?.tone) {
			button.classList.add(`tone-${state.tone}`);
		}
		button.setAttribute('aria-label', label);
		const tooltip = state?.description ?? plugin?.description ?? label;
		setAgentTooltip(button, tooltip, undefined, undefined, slot === 'sidebar.footer' || slot === 'composer.chips' ? undefined : 'end');
		if (plugin) {
			const viewId = plugin.view;
			if (viewId) {
				const sync = () => button.classList.toggle('active', this.isViewOpen(viewId, this.viewLocation(viewId)));
				store.add(this.onDidChangeShownViews(sync));
				store.add(AgentFilesSidebar.onDidChange(sync));
				sync();
			}
			store.add(addDisposableListener(button, 'click', e => {
				EventHelper.stop(e, true);
				void this.runItem(plugin, button);
			}));
		} else {
			renderer!.wire(button, store);
		}
		store.add(addDisposableListener(button, 'contextmenu', e => {
			EventHelper.stop(e, true);
			this.showItemMenu(itemId, slot, button);
		}));
		this.makeDraggable(button, itemId, slot, store);
		return button;
	}

	private async runItem(item: IVoltPluginItem, anchor: HTMLElement): Promise<void> {
		if (item.kind === 'menu' || (item.menu?.length && !item.view && !item.command)) {
			this.showEntriesMenu(item, anchor);
			return;
		}
		if (item.view) {
			await this.toggleView(item.view, anchor);
			return;
		}
		if (item.command) {
			await this.runCommand(item.command);
		}
	}

	private async runCommand(command: string): Promise<void> {
		try {
			await this.commandService.executeCommand(command, { chatId: this.agentWindow.visibleChat() });
		} catch (err) {
			this.logService.error(`[volt] ${command} failed`, err);
		}
	}

	private showEntriesMenu(item: IVoltPluginItem, anchor: HTMLElement): void {
		const entries = item.menu ?? [];
		const rows: IVoltMenuItem<MenuPick>[] = entries.map((entry, index) => ({
			id: `entry-${index}`,
			label: entry.label,
			...(entry.icon ? { icon: () => this.iconService.render(entry.icon, item.extensionLocation) } : {}),
			data: { kind: 'entry', entry },
		}));
		if (item.view) {
			rows.unshift({ id: 'view', label: this._views.get(item.view)?.title ?? item.label, icon: () => this.iconService.render(this.iconFor(item.view!), item.extensionLocation), data: { kind: 'entry', entry: { label: item.label, view: item.view } } });
		}
		showVoltMenu<MenuPick>(this.contextViewService, {
			anchor,
			ariaLabel: item.label,
			sections: [{ id: 'entries', title: item.label, items: rows }],
			onPick: picked => {
				if (picked.data.kind === 'entry') {
					const entry = picked.data.entry;
					if (entry.view) {
						void this.toggleView(entry.view, anchor);
					} else if (entry.command) {
						void this.runCommand(entry.command);
					}
				}
			},
		});
	}

	/** Right click on any slot button: move it, open its view elsewhere, hide it, reset. */
	showItemMenu(itemId: string, slot: VoltSlotId, anchor: HTMLElement): void {
		const plugin = this.item(itemId);
		const view = plugin?.view ? this._views.get(plugin.view) : undefined;
		const moveRows: IVoltMenuItem<MenuPick>[] = VOLT_SLOTS.filter(entry => entry.id !== 'hidden').map(entry => ({
			id: `move-${entry.id}`, label: entry.label, icon: () => renderVoltLayoutGlyph(entry.id), checked: entry.id === slot, data: { kind: 'move', slot: entry.id },
		}));
		const moreRows: IVoltMenuItem<MenuPick>[] = [
			{ id: 'hide', label: localize('voltLayout.hide', "Hide"), icon: () => renderVoltLayoutGlyph('hidden'), data: { kind: 'move', slot: 'hidden' } },
			{ id: 'layout', label: localize('voltLayout.edit', "Plugin Layout"), data: { kind: 'layout' } },
			{ id: 'reset', label: localize('voltLayout.reset', "Reset Layout"), data: { kind: 'reset' } },
		];
		const sections = [
			{ id: 'move', title: localize('voltLayout.moveTo', "Move To"), items: moveRows },
			...(view ? [{
				id: 'open', title: localize('voltLayout.openIn', "Open {0} In", view.title),
				items: view.locations.map((location): IVoltMenuItem<MenuPick> => ({ id: `open-${location}`, label: VIEW_LOCATION_LABELS[location], icon: () => renderVoltLayoutGlyph(location), checked: this.viewLocation(view.id) === location, data: { kind: 'open', location } })),
			}] : []),
			{ id: 'more', items: moreRows },
		];
		showVoltMenu<MenuPick>(this.contextViewService, {
			anchor,
			ariaLabel: localize('voltLayout.itemMenu', "Move or hide"),
			sections,
			onPick: picked => {
				const pick = picked.data;
				switch (pick.kind) {
					case 'move': void this.moveItem(itemId, pick.slot); break;
					case 'open': if (view) { void this.setViewLocation(view.id, pick.location); } break;
					case 'reset': void this.resetLayout(); break;
					case 'layout': void this.commandService.executeCommand('workbench.action.openVoltSettings', 'pluginLayout'); break;
				}
			},
		});
	}

	// --- Drag and drop, with motion --------------------------------------------------------------
	//
	// Picked up, the icon lifts (the drag image) and its place closes. Over a slot, a placeholder opens
	// where it would land and the icons beside it slide apart. Dropped, every icon glides from where
	// it was to its new place (FLIP) and the dropped one settles in. Let go elsewhere, it all slides back.

	/** The size of the icon being dragged (its box plus its row's gap), for the placeholder. */
	private dragSize: { readonly width: number; readonly height: number } | undefined;
	/** Where each icon was when something was dropped, until the slots draw the move. */
	private moveOrigins: { readonly rects: Map<string, DOMRect>; readonly dropped: string; readonly until: number } | undefined;
	private dropCleanup: (() => void) | undefined;

	makeDraggable(button: HTMLElement, itemId: string, slot: VoltSlotId, store: DisposableStore): void {
		button.draggable = true;
		store.add(addDisposableListener(button, 'dragstart', e => {
			if (!e.dataTransfer) {
				return;
			}
			const win = getWindow(button);
			e.dataTransfer.setData(VOLT_SLOT_ITEM_MIME, itemId);
			e.dataTransfer.effectAllowed = 'move';
			this.dragging = itemId;
			this.dropCleanup = undefined;
			const rect = button.getBoundingClientRect();
			this.dragSize = { width: rect.width, height: rect.height };
			// The drag image is the icon as it looks now: lifted, on a fill, held by its middle.
			button.classList.add('volt-slot-drag-source');
			e.dataTransfer.setDragImage(button, rect.width / 2, rect.height / 2);
			// Empty slots show where they are while something is dragged.
			win.document.body.classList.add('volt-slot-dragging');
			const axis = button.parentElement?.dataset.voltSlotAxis === 'y' ? 'y' : 'x';
			button.style.setProperty('--volt-slot-gap', `${slotGap(button.parentElement, axis)}px`);
			button.style.width = `${rect.width}px`;
			button.style.height = `${rect.height}px`;
			// After the drag image is taken, its place closes.
			win.setTimeout(() => {
				button.classList.remove('volt-slot-drag-source');
				button.classList.add('volt-slot-dragged', `axis-${axis}`);
			}, 0);
		}));
		store.add(addDisposableListener(button, 'dragend', () => {
			const win = getWindow(button);
			this.dragging = undefined;
			this.dragSize = undefined;
			win.document.body.classList.remove('volt-slot-dragging');
			button.classList.remove('volt-slot-drag-source');
			const restore = () => {
				button.classList.remove('volt-slot-dragged', 'axis-x', 'axis-y');
				button.style.removeProperty('width');
				button.style.removeProperty('height');
				button.style.removeProperty('--volt-slot-gap');
				win.document.querySelectorAll('.volt-slot-placeholder').forEach(placeholder => closePlaceholder(placeholder as HTMLElement));
			};
			if (this.moveOrigins && Date.now() < this.moveOrigins.until) {
				// Dropped: the slots redraw with the move; until then nothing jumps back.
				this.dropCleanup = restore;
				win.setTimeout(() => { if (this.dropCleanup === restore) { this.dropCleanup = undefined; restore(); } }, 900);
			} else {
				restore();
			}
		}));
	}

	animateSlotRender(buttons: readonly HTMLElement[]): void {
		for (const button of buttons) {
			button.parentElement?.querySelectorAll(':scope > .volt-slot-placeholder').forEach(placeholder => placeholder.remove());
		}
		const origins = this.moveOrigins;
		if (!origins || Date.now() > origins.until || !buttons.length) {
			return;
		}
		const win = getWindow(buttons[0]);
		this.dropCleanup?.();
		this.dropCleanup = undefined;
		if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return;
		}
		for (const button of buttons) {
			const id = button.dataset.voltItem;
			const from = id ? origins.rects.get(id) : undefined;
			if (!from) {
				continue;
			}
			const to = button.getBoundingClientRect();
			const dx = from.left + from.width / 2 - (to.left + to.width / 2);
			const dy = from.top + from.height / 2 - (to.top + to.height / 2);
			if (id === origins.dropped) {
				button.animate([
					{ transform: `translate(${dx}px, ${dy}px) scale(0.85)`, opacity: 0.6 },
					{ transform: 'translate(0, 0) scale(1.08)', opacity: 1, offset: 0.65 },
					{ transform: 'none', opacity: 1 },
				], { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
			} else if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
				button.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
			}
		}
	}

	makeDropTarget(container: HTMLElement, slot: VoltSlotId, store: DisposableStore, vertical?: boolean): void {
		container.classList.add('volt-slot-drop-target');
		container.dataset.voltSlot = slot;
		container.dataset.voltSlotAxis = vertical ? 'y' : 'x';
		const accepts = (e: DragEvent) => !!e.dataTransfer?.types.includes(VOLT_SLOT_ITEM_MIME);
		const items = () => [...container.querySelectorAll<HTMLElement>(':scope > [data-volt-item]')].filter(child => !child.classList.contains('volt-slot-dragged'));
		const beforeAt = (e: DragEvent): HTMLElement | undefined => {
			for (const child of items()) {
				const rect = child.getBoundingClientRect();
				if (vertical ? e.clientY < rect.top + rect.height / 2 : e.clientX < rect.left + rect.width / 2) {
					return child;
				}
			}
			return undefined;
		};
		/** The gap that opens where the icon would land; moved, the old one closes and a new one opens. */
		const showPlaceholder = (e: DragEvent) => {
			const size = this.dragSize;
			if (!size) {
				return;
			}
			const before = beforeAt(e) ?? null;
			const anchor = before ?? (items().at(-1)?.nextSibling ?? null);
			const current = container.querySelector<HTMLElement>(':scope > .volt-slot-placeholder:not(.closing)');
			if (current && (current.nextElementSibling === before || (!before && current.previousElementSibling === items().at(-1)))) {
				return;
			}
			if (current) {
				closePlaceholder(current);
			}
			const placeholder = $('span.volt-slot-placeholder');
			placeholder.setAttribute('aria-hidden', 'true');
			placeholder.classList.add(vertical ? 'axis-y' : 'axis-x');
			placeholder.style.setProperty('--volt-slot-ph-width', `${size.width}px`);
			placeholder.style.setProperty('--volt-slot-ph-height', `${size.height}px`);
			placeholder.style.setProperty('--volt-slot-gap', `${slotGap(container, vertical ? 'y' : 'x')}px`);
			container.insertBefore(placeholder, anchor && anchor.parentNode === container ? anchor : null);
			// Open on the next frame, so it grows from nothing.
			getWindow(container).requestAnimationFrame(() => placeholder.classList.add('open'));
		};
		store.add(addDisposableListener(container, 'dragover', e => {
			if (accepts(e)) {
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'move';
				container.classList.add('volt-slot-drop-over');
				showPlaceholder(e);
			}
		}));
		store.add(addDisposableListener(container, 'dragleave', e => {
			if (!container.contains(e.relatedTarget as Node | null)) {
				container.classList.remove('volt-slot-drop-over');
				container.querySelectorAll(':scope > .volt-slot-placeholder').forEach(placeholder => closePlaceholder(placeholder as HTMLElement));
			}
		}));
		store.add(addDisposableListener(container, 'drop', e => {
			container.classList.remove('volt-slot-drop-over');
			const itemId = e.dataTransfer?.getData(VOLT_SLOT_ITEM_MIME) || this.dragging;
			if (!itemId || !accepts(e)) {
				return;
			}
			EventHelper.stop(e, true);
			const doc = getWindow(container).document;
			doc.body.classList.remove('volt-slot-dragging');
			const before = beforeAt(e)?.dataset.voltItem;
			// Where every icon is now; the dropped one starts from its placeholder.
			const rects = new Map<string, DOMRect>();
			doc.querySelectorAll<HTMLElement>('.volt-slot-drop-target > [data-volt-item]').forEach(button => {
				if (button.dataset.voltItem && !button.classList.contains('volt-slot-dragged')) {
					rects.set(button.dataset.voltItem, button.getBoundingClientRect());
				}
			});
			const placeholder = container.querySelector<HTMLElement>(':scope > .volt-slot-placeholder:not(.closing)');
			if (placeholder) {
				rects.set(itemId, placeholder.getBoundingClientRect());
			}
			this.moveOrigins = { rects, dropped: itemId, until: Date.now() + 1500 };
			void this.moveItem(itemId, slot, before === itemId ? undefined : before);
		}));
	}
}

/** A slot row's gap along its axis (px), which a collapsing icon or a placeholder takes with it. */
function slotGap(container: HTMLElement | null, axis: 'x' | 'y'): number {
	if (!container) {
		return 0;
	}
	const style = getWindow(container).getComputedStyle(container);
	const gap = parseFloat(axis === 'y' ? style.rowGap : style.columnGap);
	return Number.isFinite(gap) ? gap : 0;
}

/** Closes a placeholder (it shrinks to nothing), then removes it. */
function closePlaceholder(placeholder: HTMLElement): void {
	if (placeholder.classList.contains('closing')) {
		return;
	}
	placeholder.classList.add('closing');
	placeholder.classList.remove('open');
	getWindow(placeholder).setTimeout(() => placeholder.remove(), 200);
}

function hasConfiguration(description: IExtensionDescription): boolean {
	const configuration = description.contributes?.configuration;
	const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
	return sections.some(section => isRecord(section?.properties) && Object.keys(section.properties).length > 0);
}

/** Every setting key an extension contributes, in its order. */
export function extensionSettingKeys(description: IExtensionDescription | undefined): string[] {
	const configuration = description?.contributes?.configuration;
	const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
	return sections.flatMap(section => isRecord(section?.properties) ? Object.keys(section.properties) : []);
}
