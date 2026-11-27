/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltSlotMenuEntry, VoltSlotItemKind, VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import { IVoltSlotItem, VoltSlotId } from '../common/voltSlots.js';

/**
 * Plugin UI: what extensions put on screen through `contributes.voltViews`, `voltSlotItems` and
 * `voltSettingsPages`, and where the user moved it.
 *
 * - An **item** is a button, chip or menu in a slot (`VoltSlotId`). The user drags it to another
 *   slot or moves it from its context menu; the moves are `volt.layout.slots`.
 * - A **view** is a webview the extension fills with `vscode.window.registerWebviewViewProvider`.
 *   It opens where `volt.layout.views` (else its manifest) puts it: a right panel tab, the files
 *   sidebar, a page, a popover under its button, a card above the composer or a section of the
 *   left sidebar.
 * - A **settings page** joins Volt Settings under Plugins: the extension's own settings as Volt's
 *   rows, and optionally one of its views below them.
 */

export const VOLT_LAYOUT_SLOTS_SETTING = 'volt.layout.slots';
export const VOLT_LAYOUT_VIEWS_SETTING = 'volt.layout.views';
export const VOLT_LAYOUT_ICONS_SETTING = 'volt.layout.icons';
/** What a dragged slot item carries. */
export const VOLT_SLOT_ITEM_MIME = 'application/vnd.volt.slot-item';

export interface IVoltPluginItem extends IVoltSlotItem {
	readonly extensionId: string;
	readonly extensionLocation?: URI;
	readonly kind: VoltSlotItemKind;
	readonly command?: string;
	readonly view?: string;
	readonly menu?: readonly IVoltSlotMenuEntry[];
}

export interface IVoltPluginView {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly icon?: string;
	readonly extensionId: string;
	readonly extensionLocation?: URI;
	readonly defaultLocation: VoltViewLocation;
	readonly locations: readonly VoltViewLocation[];
	/** The size it asked for (`voltViews[].size`), before the placement's bounds. */
	readonly size?: { readonly width?: number; readonly height?: number };
}

export interface IVoltPluginSettingsPage {
	/** `<extension id>/<page id>`, unique across plugins. */
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
	readonly extensionId: string;
	readonly extensionLabel: string;
	readonly extensionLocation?: URI;
	/** Setting keys and `prefix.` entries; empty: every key the extension contributes. */
	readonly settings: readonly string[];
	readonly view?: string;
}

/** What `vscode.volt.ui.update` changed on an item. */
export interface IVoltItemState {
	readonly label?: string;
	readonly description?: string;
	readonly badge?: string;
	readonly icon?: string;
	readonly hidden?: boolean;
	/** `error`, `warning`, `success` or none: tints a chip. */
	readonly tone?: 'error' | 'warning' | 'success';
}

/** How a built-in item draws outside the agent list (the agent list registers them). */
export interface IVoltSlotItemRenderer {
	readonly label: string;
	icon(): HTMLElement | SVGElement;
	wire(button: HTMLButtonElement, store: DisposableStore): void;
}

export type VoltSlotLook = 'icon' | 'row' | 'chip';

export interface IVoltSlotMountOptions {
	/** Classes every button gets (the host's own, so it looks like its neighbours). */
	readonly buttonClass: string;
	readonly look: VoltSlotLook;
	/** Items go before this node of the container (default: appended). */
	readonly before?: () => Node | null;
	/** Lays a horizontal or vertical row out for drop positions. Default horizontal. */
	readonly vertical?: boolean;
	/** The slot changed what it shows (the host may lay out again). */
	readonly onDidRender?: () => void;
}

export const IVoltPluginUiService = createDecorator<IVoltPluginUiService>('voltPluginUiService');

export interface IVoltPluginUiService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	items(): readonly IVoltPluginItem[];
	item(id: string): IVoltPluginItem | undefined;
	views(): readonly IVoltPluginView[];
	view(id: string): IVoltPluginView | undefined;
	settingsPages(): readonly IVoltPluginSettingsPage[];
	itemState(id: string): IVoltItemState | undefined;
	/** `vscode.volt.ui.update`: only the extension's own items. */
	updateItem(extensionId: string, itemId: string, state: IVoltItemState): void;

	/** Where a view opens now. */
	viewLocation(viewId: string): VoltViewLocation;
	setViewLocation(viewId: string, location: VoltViewLocation): Promise<void>;
	/** The icon the user picked for an item or view, else its own. */
	iconFor(id: string): string | undefined;
	setIcon(id: string, icon: string | undefined): Promise<void>;
	moveItem(itemId: string, slot: VoltSlotId, beforeId?: string): Promise<void>;
	resetLayout(): Promise<void>;

	/** Opens (or closes, when it is open there) a view in its location. */
	toggleView(viewId: string, anchor?: HTMLElement): Promise<void>;
	showView(viewId: string, anchor?: HTMLElement): Promise<void>;
	/** Views placed above the composer or in the left sidebar, and shown. */
	shownViews(location: 'aboveComposer' | 'sidebarSection' | 'filesSidebar'): readonly string[];
	readonly onDidChangeShownViews: Event<void>;
	/**
	 * A view's webview, filled by its extension, inside `container`, drawn for `location`: the Volt
	 * kit's gutters for it, and the height it gets there (above the composer, in the left sidebar).
	 */
	mountView(viewId: string, container: HTMLElement, location: VoltViewLocation): IDisposable;

	/** Draws a slot's items into `container` (and keeps them current), with drag and drop. */
	mountSlot(container: HTMLElement, slot: VoltSlotId, options: IVoltSlotMountOptions): IDisposable;
	/**
	 * Call after drawing a slot's buttons yourself (as the agent sidebar does): right after a drop
	 * they glide from where they were to their new places, and the drop's placeholder goes.
	 */
	animateSlotRender(buttons: readonly HTMLElement[]): void;
	/** One item's button, as a slot draws it. */
	createButton(itemId: string, slot: VoltSlotId, look: VoltSlotLook, buttonClass: string, store: DisposableStore): HTMLButtonElement | undefined;
	/** Lets a host that draws its own buttons (the agent list) join drag and drop. */
	makeDraggable(button: HTMLElement, itemId: string, slot: VoltSlotId, store: DisposableStore): void;
	makeDropTarget(container: HTMLElement, slot: VoltSlotId, store: DisposableStore, vertical?: boolean): void;
	/** The right-click menu of a slot button: Move To, Open In, Hide, Plugin Layout, Reset Layout. */
	showItemMenu(itemId: string, slot: VoltSlotId, anchor: HTMLElement): void;

	registerItemRenderer(id: string, renderer: IVoltSlotItemRenderer): IDisposable;
	readonly onDidChangeRenderers: Event<void>;
}
