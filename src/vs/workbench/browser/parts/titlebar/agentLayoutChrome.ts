/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHTMLElement } from '../../../../base/browser/dom.js';

export function applyAgentStatusbarShift(root: HTMLElement, sidebarWidth: number): void {
	const width = Math.max(0, Math.round(sidebarWidth));
	root.style.setProperty('--volt-agent-sidebar-width', `${width}px`);
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
	root.classList.remove('volt-agent-right-collapsed');
	const statusWrap = root.querySelector('.part.statusbar')?.parentElement;
	if (isHTMLElement(statusWrap)) {
		statusWrap.style.left = '';
		statusWrap.style.width = '';
	}
}
