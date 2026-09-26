/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Vertical divider of the stroked glyph shown in the sidebar header while it is open. */
export const PRIMARY_SIDEBAR_TOGGLE_OPEN_DIVIDER_PATH = 'M9 3V21';
/** Frame of the filled glyph shown in the title bar while the sidebar is closed. */
export const PRIMARY_SIDEBAR_TOGGLE_CLOSED_FRAME_PATH = 'M14 2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM2 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2z';
/** Filled bar of the glyph shown in the title bar while the sidebar is closed. */
export const PRIMARY_SIDEBAR_TOGGLE_CLOSED_BAR_PATH = 'M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z';

export type PrimarySidebarToggleGlyph = 'open' | 'closed';

/**
 * Agent layout shows this toggle in the sidebar header while the sidebar is open,
 * and in the primary title bar once that sidebar is closed.
 */
export function agentPrimarySidebarToggleInTitlebar(agentLayout: boolean, sidebarOpen: boolean): boolean {
	return !agentLayout || !sidebarOpen;
}

export function createPrimarySidebarToggleIcon(owner: HTMLElement, glyph: PrimarySidebarToggleGlyph): SVGElement {
	const doc = owner.ownerDocument;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('class', 'volt-primary-sidebar-toggle-icon');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('aria-hidden', 'true');
	if (glyph === 'open') {
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		const frame = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
		frame.setAttribute('x', '2');
		frame.setAttribute('y', '3');
		frame.setAttribute('width', '20');
		frame.setAttribute('height', '18');
		frame.setAttribute('rx', '2');
		frame.setAttribute('fill', 'none');
		frame.setAttribute('stroke', 'currentColor');
		frame.setAttribute('stroke-width', '1.5');
		frame.setAttribute('vector-effect', 'non-scaling-stroke');
		frame.setAttribute('stroke-linecap', 'round');
		frame.setAttribute('stroke-linejoin', 'round');
		const divider = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		divider.setAttribute('d', PRIMARY_SIDEBAR_TOGGLE_OPEN_DIVIDER_PATH);
		divider.setAttribute('fill', 'none');
		divider.setAttribute('stroke', 'currentColor');
		divider.setAttribute('stroke-width', '1.5');
		divider.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.append(frame, divider);
	} else if (glyph === 'closed') {
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'currentColor');
		const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
		group.setAttribute('fill', 'currentColor');
		const frame = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		frame.setAttribute('fill', 'currentColor');
		frame.setAttribute('d', PRIMARY_SIDEBAR_TOGGLE_CLOSED_FRAME_PATH);
		const bar = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		bar.setAttribute('fill', 'currentColor');
		bar.setAttribute('d', PRIMARY_SIDEBAR_TOGGLE_CLOSED_BAR_PATH);
		group.append(frame, bar);
		svg.appendChild(group);
	} else {
		const unexpected: never = glyph;
		return unexpected;
	}
	return svg;
}
