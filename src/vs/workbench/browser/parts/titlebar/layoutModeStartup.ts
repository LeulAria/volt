/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const LAYOUT_MODE_STORAGE_KEY = 'volt.layoutMode';
export const AGENT_LEFT_SIDEBAR_HIDDEN_KEY = 'volt.agent.leftSidebar.hidden';
export const SIDEBAR_LOCATION_KEY = 'workbench.sideBar.location';
export const AGENT_LIST_WIDTH = 290;
export const AGENT_SIDEBAR_MIN_WIDTH = 180;

export type LayoutMode = 'agent' | 'ide';

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
