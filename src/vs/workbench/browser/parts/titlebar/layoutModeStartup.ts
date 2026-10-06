/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

/** Room the chat needs beside the list, and with the tools open beside it too. */
export const AGENT_DRAWER_CHAT_MIN_WIDTH = 480;
export const AGENT_DRAWER_CHAT_AND_TOOLS_MIN_WIDTH = 880;

export type LayoutMode = 'agent' | 'ide';

/**
 * The agent list floats over the chat as a drawer when the window cannot fit it beside the
 * chat (and the tools, when open). With room it stays a column on the left.
 */
export function agentNeedsSidebarDrawer(containerWidth: number, listWidth: number, toolsOpen: boolean): boolean {
	const needed = toolsOpen ? AGENT_DRAWER_CHAT_AND_TOOLS_MIN_WIDTH : AGENT_DRAWER_CHAT_MIN_WIDTH;
	return containerWidth > 0 && containerWidth - listWidth < needed;
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
