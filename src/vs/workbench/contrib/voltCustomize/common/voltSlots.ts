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

export type VoltSlotId = 'sidebar.header' | 'sidebar.footer' | 'activityBar.top' | 'activityBar.bottom' | 'hidden';

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
	readonly defaultSlot?: Exclude<VoltSlotId, 'hidden'>;
}

export const VOLT_SLOTS: readonly IVoltSlot[] = [
	{ id: 'sidebar.header', label: 'Sidebar header', description: 'The icon row at the top of the agent sidebar, right of Search.' },
	{ id: 'sidebar.footer', label: 'Sidebar footer', description: 'The icon row at the bottom-left of the agent sidebar.' },
	{ id: 'activityBar.top', label: 'Activity bar', description: 'VS Code\'s icon column at the left edge of the agent sidebar, from the top. Empty by default; the bar shows once either activity bar slot holds an item.' },
	{ id: 'activityBar.bottom', label: 'Activity bar (bottom)', description: 'The bottom of the activity bar, like VS Code\'s Accounts and Manage.' },
	{ id: 'hidden', label: 'Hidden', description: 'Items listed here are not shown.' },
];

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

const SLOT_IDS = new Set<string>(VOLT_SLOTS.map(slot => slot.id));
const ITEM_IDS = new Set<string>(VOLT_SLOT_ITEMS.map(item => item.id));

export function isVoltSlotId(id: string): id is VoltSlotId {
	return SLOT_IDS.has(id);
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
export function resolveVoltSlotPlacement(slots: Readonly<Record<string, readonly string[]>> | undefined, isOn: (itemId: string) => boolean = () => true): VoltSlotPlacement {
	const placement: Record<VoltSlotId, string[]> = { 'sidebar.header': [], 'sidebar.footer': [], 'activityBar.top': [], 'activityBar.bottom': [], hidden: [] };
	const placed = new Set<string>();
	for (const slot of VOLT_SLOTS) {
		for (const id of slots?.[slot.id] ?? []) {
			if (ITEM_IDS.has(id) && !placed.has(id)) {
				placed.add(id);
				if (isOn(id)) {
					placement[slot.id].push(id);
				}
			}
		}
	}
	for (const item of VOLT_SLOT_ITEMS) {
		if (!placed.has(item.id) && item.defaultSlot && isOn(item.id)) {
			placement[item.defaultSlot].push(item.id);
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
	return VOLT_SLOTS.every(slot => a[slot.id].join('\n') === b[slot.id].join('\n'));
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
	setPlacement(placement: VoltSlotPlacement): void;
}

export class VoltSlotService implements IVoltSlotService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private _placement = defaultVoltSlotPlacement();

	get placement(): VoltSlotPlacement {
		return this._placement;
	}

	setPlacement(placement: VoltSlotPlacement): void {
		if (sameVoltSlotPlacement(this._placement, placement)) {
			return;
		}
		this._placement = placement;
		this._onDidChange.fire();
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
