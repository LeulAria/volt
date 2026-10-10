/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const LAYOUT_MODE_STORAGE_KEY = 'volt.layoutMode';
export const AGENT_LEFT_SIDEBAR_HIDDEN_KEY = 'volt.agent.leftSidebar.hidden';
export const SIDEBAR_LOCATION_KEY = 'workbench.sideBar.location';
export const AGENT_LIST_WIDTH = 260;
export const AGENT_SIDEBAR_MIN_WIDTH = 180;

/** Fired on the workbench root when a chat's tools open or close, so the layout can re-weigh the list. */
export const AGENT_TOOLS_VISIBILITY_EVENT = 'volt-agent-tools-visibility';

/** The agent list folded to an icon rail (new chat, search, projects, settings) instead of the full list. */
export const AGENT_SIDEBAR_RAIL_KEY = 'volt.agent.sidebar.rail';
/** Set on the workbench root while the rail is on; the list column then has the rail's fixed width. */
export const AGENT_SIDEBAR_RAIL_CLASS = 'volt-agent-sidebar-rail-mode';
export const AGENT_SIDEBAR_RAIL_WIDTH = 52;
/** Fired on the workbench root when the rail turns on or off, so the layout can size the column again. */
export const AGENT_SIDEBAR_RAIL_EVENT = 'volt-agent-sidebar-rail';

/** Room the chat needs beside the list, and the chat and tools together (about 300 each) when the tools are open. */
export const AGENT_DRAWER_CHAT_MIN_WIDTH = 480;
export const AGENT_DRAWER_CHAT_AND_TOOLS_MIN_WIDTH = 600;

export type LayoutMode = 'agent' | 'ide';

/**
 * The agent list floats over the chat as a drawer when the window cannot fit it beside the
 * chat (and the tools, when open). With room it stays a column on the left.
 */
export function agentNeedsSidebarDrawer(containerWidth: number, listWidth: number, toolsOpen: boolean, edgeWidth = 0): boolean {
	// The right-edge sidebar (Files, Source Control, Pull Requests) takes its own column on top
	// of the chat and tools, so the list folds away earlier while it is open.
	const needed = (toolsOpen ? AGENT_DRAWER_CHAT_AND_TOOLS_MIN_WIDTH : AGENT_DRAWER_CHAT_MIN_WIDTH) + edgeWidth;
	return containerWidth > 0 && containerWidth - listWidth < needed;
}

/**
 * The agent list's saved open/closed state. A window can carry its own choice (a new empty window
 * opens with the list closed), which wins over the profile's until the list is toggled there.
 */
export function readAgentLeftSidebarHidden(storageService: IStorageService): boolean {
	const own = storageService.get(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, StorageScope.WORKSPACE);
	if (own !== undefined) {
		return own === 'true';
	}
	return storageService.getBoolean(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, StorageScope.PROFILE, false);
}

/** Toggling the list is a choice for every window, so it drops this window's own. */
export function writeAgentLeftSidebarHidden(storageService: IStorageService, hidden: boolean): void {
	storageService.remove(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, StorageScope.WORKSPACE);
	storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, hidden, StorageScope.PROFILE, StorageTarget.USER);
}

/** A window opened empty just now (New Window), not one restored with its own state. */
export function isNewEmptyWindow(storageService: IStorageService, emptyWorkspace: boolean): boolean {
	return emptyWorkspace && storageService.isNew(StorageScope.WORKSPACE);
}

/** A new empty agent window starts on the New Agent composer, so the agent list starts closed there. */
export function markNewEmptyWindowSidebarHidden(storageService: IStorageService): void {
	storageService.store(AGENT_LEFT_SIDEBAR_HIDDEN_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/** Storage wins. With no stored mode, a right-hand primary sidebar is the agent window. */
export function readStoredLayoutModeValue(stored: string, sidebarOnRight: boolean): LayoutMode {
	if (stored === 'agent' || stored === 'ide') {
		return stored;
	}
	return sidebarOnRight ? 'agent' : 'ide';
}

export interface IAgentSidebarWidthLimits {
	readonly min: number;
	readonly max?: number;
	readonly fallback: number;
}

/**
 * Width the agent list should occupy on the first frame.
 * A hidden list is 0. An open list keeps the saved width, clamped to the window.
 */
export function agentStartupSidebarWidth(storedWidth: number, hidden: boolean, limits?: IAgentSidebarWidthLimits): number {
	if (hidden) {
		return 0;
	}
	const min = limits?.min ?? AGENT_SIDEBAR_MIN_WIDTH;
	const fallback = limits?.fallback ?? AGENT_LIST_WIDTH;
	const open = storedWidth >= min ? Math.round(storedWidth) : fallback;
	const max = limits?.max;
	if (typeof max === 'number' && Number.isFinite(max) && max >= min) {
		return Math.min(Math.max(open, min), max);
	}
	return Math.max(open, min);
}
