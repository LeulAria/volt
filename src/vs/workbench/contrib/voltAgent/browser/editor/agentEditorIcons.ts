/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';

// The agent chat's own icons (composer, reply footer, prompt card). Shared by the chat panel and
// the web app, which draws the same chat.

export function createSvgIcon(viewBox: string, pathD: string, extraClass?: string, stroke = false, strokeWidth = '1.5'): HTMLElement {
	const el = extraClass ? $(`span.volt-agent-svg-icon.${extraClass}`) : $('span.volt-agent-svg-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	const parts = viewBox.split(' ');
	svg.setAttribute('width', parts[2] || '24');
	svg.setAttribute('height', parts[3] || '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	if (stroke) {
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', strokeWidth);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
	} else {
		path.setAttribute('fill', 'currentColor');
	}
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createStopIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.stop');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 384 512');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M0 128c0-35.3 28.7-64 64-64h256c35.3 0 64 28.7 64 64v256c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64z');
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createSendIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.send');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'm19.03 9.47l-6.145-6.145a1.26 1.26 0 0 0-1.77 0L4.97 9.47l1.06 1.06l5.22-5.22V21h1.5V5.31l5.22 5.22z');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.3');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createPlusIcon(): HTMLElement {
	return createSvgIcon('0 0 14 14', 'M7 2.5v9M2.5 7h9', 'plus', true, '1');
}

export function createOpenNewAgentIcon(): HTMLElement {
	return createStrokeIcon('open-new', [
		'M15 3h6v6',
		'M14 10l7-7',
		'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
	]);
}

export function createMicIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.mic');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const mic = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
	mic.setAttribute('x', '9');
	mic.setAttribute('y', '3');
	mic.setAttribute('width', '6');
	mic.setAttribute('height', '11');
	mic.setAttribute('rx', '3');
	mic.setAttribute('fill', 'currentColor');
	const stem = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	stem.setAttribute('d', 'M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6');
	stem.setAttribute('stroke', 'currentColor');
	stem.setAttribute('stroke-width', '1.8');
	stem.setAttribute('stroke-linecap', 'round');
	svg.appendChild(mic);
	svg.appendChild(stem);
	el.appendChild(svg);
	return el;
}

export function createChevronIcon(): HTMLElement {
	return createSvgIcon(
		'0 0 16 7',
		'M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z',
		'chevron'
	);
}

export function createExpandIcon(restored: boolean): HTMLElement {
	return createSvgIcon(
		'0 0 24 24',
		restored
			? 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'
			: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
		'expand',
		true,
		'2',
	);
}

export function createCopyIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.copy');
	const doc = el.ownerDocument;
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
	rect.setAttribute('width', '14');
	rect.setAttribute('height', '14');
	rect.setAttribute('x', '8');
	rect.setAttribute('y', '8');
	rect.setAttribute('rx', '2');
	rect.setAttribute('ry', '2');
	const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
	svg.appendChild(rect);
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createForkIcon(): HTMLElement {
	return createSvgIcon(
		'0 0 24 24',
		'M3 3L10.6575 9.80663C11.5114 10.5657 12 11.6537 12 12.7963V22M3 3V9M3 3H9M21 3L15 9M21 3V9M21 3H15',
		'fork',
		true,
		'1',
	);
}

export function createStrokeIcon(extraClass: string, paths: readonly string[]): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	el.appendChild(svg);
	return el;
}
