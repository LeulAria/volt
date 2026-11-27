/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Slots: the places in the agent window that hold Volt's own buttons, and the buttons (items) that
 * can go in them. A layout's `slots` moves, reorders or hides items:
 *
 *   "slots": { "sidebar.header": ["volt.settings", "volt.newChat"], "hidden": ["volt.automations"] }
 *
 * An item named in a slot goes there, in that order. Items not named anywhere stay in their own
 * slot, in Volt's order, after the named ones. `hidden` takes items off screen. Items with no slot
 * of their own (the activity bar's views) show only where a layout names them.
 *
 * The activity bar is VS Code's icon column, at the left edge of the agent sidebar: it shows while
 * `activityBar.top` or `activityBar.bottom` holds an item.
 */

export type VoltSlotId =
	| 'sidebar.header' | 'sidebar.footer' | 'activityBar.top' | 'activityBar.bottom'
	| 'titlebar.left' | 'titlebar.center' | 'titlebar.right'
	| 'filesSidebar.header' | 'chat.toolbar' | 'chat.dock' | 'composer.chips' | 'rightPanel.launcher'
	| 'hidden';

/** The slots a button can be dragged into (every slot but `hidden`). */
export type VoltVisibleSlotId = Exclude<VoltSlotId, 'hidden'>;

export interface IVoltSlot {
	readonly id: VoltSlotId;
	readonly label: string;
	readonly description: string;
}

export interface IVoltSlotItem {
	/** `volt.settings`: what layouts, AGENTS.md and the Playground devtools call it. */
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Where Volt puts it; none: off screen until a layout places it. */
	readonly defaultSlot?: VoltVisibleSlotId;
	/** The extension that contributes it (plugin items only). */
	readonly extensionId?: string;
	/** Its icon: `aria:<set>:<name>`, `codicon:<id>` or a path in the extension (plugin items only). */
	readonly icon?: string;
	/** `button` (an icon), `chip` (icon and label) or `menu` (a chip that opens a list). */
	readonly kind?: 'button' | 'chip' | 'menu';
}

export const VOLT_SLOTS: readonly IVoltSlot[] = [
	{ id: 'sidebar.header', label: 'Sidebar header', description: 'The icon row at the top of the agent sidebar, right of Search.' },
	{ id: 'sidebar.footer', label: 'Sidebar footer', description: 'The icon row at the bottom-left of the agent sidebar.' },
	{ id: 'activityBar.top', label: 'Activity bar', description: 'VS Code\'s icon column at the left edge of the agent sidebar, from the top. Empty by default; the bar shows once either activity bar slot holds an item.' },
	{ id: 'activityBar.bottom', label: 'Activity bar (bottom)', description: 'The bottom of the activity bar, like VS Code\'s Accounts and Manage.' },
	{ id: 'titlebar.left', label: 'Title bar (left)', description: 'The top-left of the window, after VOLT and its back and forward arrows.' },
	{ id: 'titlebar.center', label: 'Chat title bar', description: 'The chat\'s title bar, left of IDE and the panel toggles.' },
	{ id: 'titlebar.right', label: 'Title bar (right)', description: 'The top-right corner, beside the files sidebar and right panel toggles.' },
	{ id: 'filesSidebar.header', label: 'Files sidebar header', description: 'The icon row at the top of the files sidebar (Explorer, Source Control, Pull Requests, Search).' },
	{ id: 'chat.toolbar', label: 'Chat side toolbar', description: 'The icon column at the right edge of the chat.' },
	{ id: 'chat.dock', label: 'Chat side toolbar menu', description: 'The menu that opens from the chat\'s side toolbar, under Plugins.' },
	{ id: 'composer.chips', label: 'Composer chips', description: 'The chips row right above the composer (Worked for, Compact, Push & Create PR).' },
	{ id: 'rightPanel.launcher', label: 'Right panel launcher', description: 'The list the empty right panel shows (File, Terminal, Browser, ...).' },
	{ id: 'hidden', label: 'Hidden', description: 'Items listed here are not shown.' },
];

/** The slots that existed before plugins could add buttons: the ones layouts validate today. */
const LAYOUT_SLOT_IDS: readonly VoltSlotId[] = ['sidebar.header', 'sidebar.footer', 'activityBar.top', 'activityBar.bottom', 'hidden'];

export const VOLT_SLOT_ITEMS: readonly IVoltSlotItem[] = [
	{ id: 'volt.filter', label: 'Filter and sort', description: 'Filters and sorts the chat list.', defaultSlot: 'sidebar.header' },
	{ id: 'volt.openWorkspace', label: 'Open Workspace', description: 'Opens a folder or repository as a project.', defaultSlot: 'sidebar.header' },
	{ id: 'volt.newChat', label: 'New Chat', description: 'Starts a new chat.', defaultSlot: 'sidebar.header' },
	{ id: 'volt.settings', label: 'Settings', description: 'Opens Volt Settings (the gear).', defaultSlot: 'sidebar.footer' },
	{ id: 'volt.usage', label: 'Usage', description: 'Opens Usage; hovering it shows every account\'s limits.', defaultSlot: 'sidebar.footer' },
	{ id: 'volt.pullRequestsPage', label: 'Pull Requests page', description: 'Opens the full-page Pull Requests view.', defaultSlot: 'sidebar.footer' },
	{ id: 'volt.automations', label: 'Automations', description: 'Opens Automations.', defaultSlot: 'sidebar.footer' },
	{ id: 'volt.customize', label: 'Skills & Plugins', description: 'Opens Skills & Plugins.', defaultSlot: 'sidebar.footer' },
	// The files sidebar's views, as in VS Code's activity bar: a click opens the view in the files
	// sidebar at the right edge, and clicking it again closes the sidebar.
	{ id: 'volt.explorer', label: 'Explorer', description: 'Opens the Explorer in the files sidebar.' },
	{ id: 'volt.search', label: 'Search', description: 'Opens Search in the files sidebar.' },
	{ id: 'volt.sourceControl', label: 'Source Control', description: 'Opens Source Control (the chat\'s changes) in the files sidebar.' },
	{ id: 'volt.runAndDebug', label: 'Run and Debug', description: 'Opens Run and Debug in the files sidebar.' },
	{ id: 'volt.pullRequests', label: 'Pull Requests', description: 'Opens Pull Requests in the files sidebar (Source Control when the repository has no origin).' },
	{ id: 'volt.extensions', label: 'Extensions', description: 'Opens Extensions in the files sidebar.' },
];

/** The activity bar VS Code ships with, for layouts that want it: views on top, Settings at the bottom. */
export const VOLT_VSCODE_ACTIVITY_BAR = {
	'activityBar.top': ['volt.explorer', 'volt.search', 'volt.sourceControl', 'volt.runAndDebug', 'volt.pullRequests', 'volt.extensions'],
	'activityBar.bottom': ['volt.settings'],
} as const;

export type VoltSlotPlacement = Readonly<Record<VoltSlotId, readonly string[]>>;

const SLOT_IDS = new Set<string>(LAYOUT_SLOT_IDS);
const ALL_SLOT_IDS = new Set<string>(VOLT_SLOTS.map(slot => slot.id));
const ITEM_IDS = new Set<string>(VOLT_SLOT_ITEMS.map(item => item.id));

/** A slot a layout file may name (the original five; plugins' slots live in `volt.layout.slots`). */
export function isVoltSlotId(id: string): id is VoltSlotId {
	return SLOT_IDS.has(id);
}

/** Any slot, including the ones plugins and drag and drop use. */
export function isAnyVoltSlotId(id: string): id is VoltSlotId {
	return ALL_SLOT_IDS.has(id);
}

export function emptyVoltSlotPlacement(): Record<VoltSlotId, string[]> {
	return Object.fromEntries(VOLT_SLOTS.map(slot => [slot.id, []])) as unknown as Record<VoltSlotId, string[]>;
}

export function isVoltSlotItemId(id: string): boolean {
	return ITEM_IDS.has(id);
}

/** Volt's own arrangement: every item in its default slot. */
export function defaultVoltSlotPlacement(): VoltSlotPlacement {
	return resolveVoltSlotPlacement(undefined);
}

/**
 * Where each item goes: the layout's lists first (unknown ids dropped, each item once, the first
 * mention wins), then every item it doesn't name in its own slot, in Volt's order. An item whose
 * feature is turned off (`isOn` says no) goes nowhere, whatever the layout says.
 */
export function resolveVoltSlotPlacement(slots: Readonly<Record<string, readonly string[]>> | undefined, isOn: (itemId: string) => boolean = () => true, extraItems: readonly IVoltSlotItem[] = [], userSlots?: Readonly<Record<string, readonly string[]>>): VoltSlotPlacement {
	const placement = emptyVoltSlotPlacement();
	const placed = new Set<string>();
	const known = new Set<string>([...ITEM_IDS, ...extraItems.map(item => item.id)]);
	// The user's own moves (drag and drop, Settings > Layout) first, then the layout's.
	for (const source of [userSlots, slots]) {
		for (const slot of VOLT_SLOTS) {
			for (const id of source?.[slot.id] ?? []) {
				if (known.has(id) && !placed.has(id)) {
					placed.add(id);
					if (isOn(id)) {
						placement[slot.id].push(id);
					}
				}
			}
		}
	}
	for (const item of [...VOLT_SLOT_ITEMS, ...extraItems]) {
		if (!placed.has(item.id) && item.defaultSlot && isOn(item.id)) {
			placement[item.defaultSlot].push(item.id);
			placed.add(item.id);
		}
	}
	return placement;
}

/**
 * Items in no slot at all and still on: not shown, ready to be placed (the devtools list them as
 * more buttons).
 */
export function unplacedVoltSlotItems(placement: VoltSlotPlacement, isOn: (itemId: string) => boolean = () => true): string[] {
	const placed = new Set(VOLT_SLOTS.flatMap(slot => placement[slot.id]));
	return VOLT_SLOT_ITEMS.filter(item => !placed.has(item.id) && isOn(item.id)).map(item => item.id);
}

export function sameVoltSlotPlacement(a: VoltSlotPlacement, b: VoltSlotPlacement): boolean {
	return VOLT_SLOTS.every(slot => (a[slot.id] ?? []).join('\n') === (b[slot.id] ?? []).join('\n'));
}

/**
 * The user's slots after moving `itemId` into `slot` before `beforeId` (or at the end): every list
 * the move touches is written in full, so the result doesn't depend on Volt's default order.
 */
export function moveVoltSlotItem(placement: VoltSlotPlacement, userSlots: Readonly<Record<string, readonly string[]>> | undefined, itemId: string, slot: VoltSlotId, beforeId?: string): Record<string, string[]> {
	const next: Record<string, string[]> = {};
	for (const [id, items] of Object.entries(userSlots ?? {})) {
		next[id] = items.filter(item => item !== itemId);
	}
	let from: VoltSlotId | undefined;
	for (const entry of VOLT_SLOTS) {
		if (placement[entry.id]?.includes(itemId)) {
			from = entry.id;
		}
	}
	if (from && from !== slot) {
		next[from] = (placement[from] ?? []).filter(item => item !== itemId);
	}
	const target = (placement[slot] ?? []).filter(item => item !== itemId);
	const index = beforeId ? target.indexOf(beforeId) : -1;
	target.splice(index < 0 ? target.length : index, 0, itemId);
	next[slot] = target;
	return next;
}

/**
 * The window's current placement. The customize service sets it from the active layout (or the
 * Playground draft); the views that host slots read it and redraw on change.
 */
export const IVoltSlotService = createDecorator<IVoltSlotService>('voltSlotService');

export interface IVoltSlotService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly placement: VoltSlotPlacement;
	/** Built-in and plugin items. */
	readonly items: readonly IVoltSlotItem[];
	setPlacement(placement: VoltSlotPlacement): void;
	/** The layout's slots and which items are on; the service adds plugin items and the user's moves. */
	setLayoutSlots(slots: Readonly<Record<string, readonly string[]>> | undefined, isOn: (itemId: string) => boolean): void;
	/** The user's own moves (`volt.layout.slots`). */
	setUserSlots(slots: Readonly<Record<string, readonly string[]>> | undefined): void;
	readonly userSlots: Readonly<Record<string, readonly string[]>> | undefined;
	/** Plugin items; replaced whole when plugins change. */
	setPluginItems(items: readonly IVoltSlotItem[]): void;
}

export class VoltSlotService implements IVoltSlotService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private _placement = defaultVoltSlotPlacement();
	private layoutSlots: Readonly<Record<string, readonly string[]>> | undefined;
	private isOn: (itemId: string) => boolean = () => true;
	private _userSlots: Readonly<Record<string, readonly string[]>> | undefined;
	private pluginItems: readonly IVoltSlotItem[] = [];

	get placement(): VoltSlotPlacement {
		return this._placement;
	}

	get items(): readonly IVoltSlotItem[] {
		return [...VOLT_SLOT_ITEMS, ...this.pluginItems];
	}

	get userSlots(): Readonly<Record<string, readonly string[]>> | undefined {
		return this._userSlots;
	}

	setPlacement(placement: VoltSlotPlacement): void {
		if (sameVoltSlotPlacement(this._placement, placement)) {
			return;
		}
		this._placement = placement;
		this._onDidChange.fire();
	}

	setLayoutSlots(slots: Readonly<Record<string, readonly string[]>> | undefined, isOn: (itemId: string) => boolean): void {
		this.layoutSlots = slots;
		this.isOn = isOn;
		this.resolve();
	}

	setUserSlots(slots: Readonly<Record<string, readonly string[]>> | undefined): void {
		this._userSlots = slots;
		this.resolve();
	}

	setPluginItems(items: readonly IVoltSlotItem[]): void {
		this.pluginItems = items.filter(item => !ITEM_IDS.has(item.id));
		this.resolve();
	}

	private resolve(): void {
		this.setPlacement(resolveVoltSlotPlacement(this.layoutSlots, this.isOn, this.pluginItems, this._userSlots));
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
