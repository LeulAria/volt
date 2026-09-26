/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHTMLElement } from '../../../../base/browser/dom.js';
import { agentPrimarySidebarToggleInTitlebar } from './sidebarToggleIcon.js';

export const AGENT_SIDE_PANEL_ID = 'workbench.panel.voltAgent';

export function applyAgentStatusbarShift(root: HTMLElement, sidebarWidth: number, titlebarHeight?: number): void {
	const width = Math.max(0, Math.round(sidebarWidth));
	setCssPx(root, '--volt-agent-sidebar-width', width);
	const collapsed = width === 0;
	if (root.classList.contains('volt-agent-left-collapsed') !== collapsed) {
		root.classList.toggle('volt-agent-left-collapsed', collapsed);
	}
	if (typeof titlebarHeight === 'number' && titlebarHeight > 0) {
		setCssPx(root, '--volt-agent-titlebar-height', titlebarHeight);
	}
}

/** Mark agent or IDE chrome before the workbench is shown, so the first frame is already final. */
export function stampLayoutModeChrome(root: HTMLElement, agent: boolean, sidebarWidth: number, titlebarHeight?: number): void {
	const mode = agent ? 'agent' : 'ide';
	if (root.dataset.voltLayoutMode !== mode) {
		root.dataset.voltLayoutMode = mode;
	}
	root.classList.toggle('volt-layout-agent', agent);
	const sidebarOpen = agent && sidebarWidth > 0;
	root.classList.toggle('volt-primary-sidebar-toggle-in-titlebar', agentPrimarySidebarToggleInTitlebar(agent, sidebarOpen));
	if (!agent) {
		resetAgentStatusbarShift(root);
		return;
	}
	applyAgentStatusbarShift(root, sidebarWidth, titlebarHeight);
	setCssPx(root, '--volt-agent-right-dock-width', 0);
	root.classList.remove('volt-agent-right-collapsed');
}

function setCssPx(root: HTMLElement, name: string, value: number): void {
	const next = `${Math.max(0, Math.round(value))}px`;
	if (root.style.getPropertyValue(name) !== next) {
		root.style.setProperty(name, next);
	}
}

export function getAgentRightDockInset(root: HTMLElement): number {
	if (!root.classList.contains('volt-layout-agent')) {
		return 0;
	}
	const width = Number.parseInt(root.style.getPropertyValue('--volt-agent-right-dock-width'), 10);
	return Number.isFinite(width) && width > 0 ? width : 0;
}

export function resetAgentStatusbarShift(root: HTMLElement): void {
	root.style.removeProperty('--volt-agent-sidebar-width');
	root.style.removeProperty('--volt-agent-right-dock-width');
	root.style.removeProperty('--volt-agent-statusbar-height');
	root.style.removeProperty('--volt-agent-titlebar-height');
	root.classList.remove('volt-agent-right-collapsed');
	root.classList.remove('volt-agent-left-collapsed');
	const statusWrap = root.querySelector('.part.statusbar')?.parentElement;
	if (isHTMLElement(statusWrap)) {
		statusWrap.style.left = '';
		statusWrap.style.width = '';
	}
}
