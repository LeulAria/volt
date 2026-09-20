/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isHTMLElement } from '../../../../base/browser/dom.js';

const DEFAULT_STATUSBAR_HEIGHT = 22;

export function applyAgentStatusbarShift(root: HTMLElement, sidebarWidth: number): void {
	const width = Math.max(0, Math.round(sidebarWidth));
	const status = root.querySelector('.part.statusbar');
	const height = isHTMLElement(status)
		? (Math.round(status.getBoundingClientRect().height) || DEFAULT_STATUSBAR_HEIGHT)
		: DEFAULT_STATUSBAR_HEIGHT;
	root.style.setProperty('--volt-agent-sidebar-width', `${width}px`);
	root.style.setProperty('--volt-agent-statusbar-height', `${height}px`);
}

export function resetAgentStatusbarShift(root: HTMLElement): void {
	root.style.removeProperty('--volt-agent-sidebar-width');
	root.style.removeProperty('--volt-agent-statusbar-height');
	const statusWrap = root.querySelector('.part.statusbar')?.parentElement;
	if (isHTMLElement(statusWrap)) {
		statusWrap.style.left = '';
		statusWrap.style.width = '';
	}
}
