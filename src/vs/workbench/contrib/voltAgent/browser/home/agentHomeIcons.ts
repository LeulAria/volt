/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';

export const AGENT_HOME_SEARCH_ICON_PATH = 'm21 21l-4.343-4.343m0 0A8 8 0 1 0 5.343 5.343a8 8 0 0 0 11.314 11.314';
export const AGENT_HOME_NEW_CHAT_ICON_PATH = 'm8.87 6.133l5.863-1.938c3.3-1.09 4.95-1.636 5.825-.76c.875.874.33 2.524-.761 5.825l-1.937 5.862c-1.236 3.74-1.854 5.61-2.98 5.838a2 2 0 0 1-.725.013c-1.136-.19-1.842-2.037-3.253-5.732c-.27-.703-.404-1.055-.645-1.328a2 2 0 0 0-.178-.178c-.273-.241-.624-.376-1.328-.644c-3.695-1.412-5.542-2.118-5.732-3.254c-.04-.24-.035-.486.013-.724c.228-1.126 2.098-1.744 5.838-2.98m3.93 5.054l2.698-2.698';

function createHomeSvgIcon(extraClass: string, pathD: string): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	path.setAttribute('fill', 'none');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '2');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createHomeSearchIcon(): HTMLElement {
	return createHomeSvgIcon('search', AGENT_HOME_SEARCH_ICON_PATH);
}

export function createHomeNewChatIcon(): HTMLElement {
	return createHomeSvgIcon('new-chat', AGENT_HOME_NEW_CHAT_ICON_PATH);
}
