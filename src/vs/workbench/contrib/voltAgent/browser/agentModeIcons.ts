/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';

export type ModeIconId = 'agent' | 'plan' | 'debug' | 'multitask' | 'ask';

export function createStrokeIcon(extraClass: string, paths: readonly string[], strokeWidth = '1.5'): HTMLElement {
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
		path.setAttribute('stroke-width', strokeWidth);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	el.appendChild(svg);
	return el;
}

function createPlanIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.plan');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const group = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
	group.setAttribute('fill', 'none');
	group.setAttribute('stroke', 'currentColor');
	group.setAttribute('stroke-linecap', 'round');
	group.setAttribute('stroke-linejoin', 'round');
	group.setAttribute('stroke-width', '1.2');
	for (const [cx, cy] of [['5', '7'], ['5', '17']] as const) {
		const circle = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('cx', cx);
		circle.setAttribute('cy', cy);
		circle.setAttribute('r', '2.667');
		group.appendChild(circle);
	}
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M11.667 7h10m-10 10h10');
	group.appendChild(path);
	svg.appendChild(group);
	el.appendChild(svg);
	return el;
}

function createMultitaskIcon(): HTMLElement {
	return createStrokeIcon('multitask', [
		'M4.7576 14.6566L4.0503 13.9497C3.8804 13.7799 3.7193 13.6013 3.5678 13.4149L2.9371 12.6389M2.14 10.7141L2.0371 9.7194C1.9876 9.2411 1.9876 8.7589 2.0371 8.2806L2.14 7.2859M2.937 5.3611L3.5678 4.5851C3.8711 4.212 4.212 3.8711 4.5851 3.5678L5.3611 2.937M7.2859 2.14L8.2806 2.0371C8.7589 1.9876 9.2411 1.9876 9.7194 2.0371L10.7141 2.14M12.6389 2.9371L13.4149 3.5678C13.6013 3.7193 13.7799 3.8804 13.9497 4.0503L14.6566 4.7576M22 15C22 11.1339 18.8661 8 15 8C11.1339 8 8 11.1339 8 15C8 18.8661 11.1339 22 15 22C18.8661 22 22 18.8661 22 15Z',
	], '1.2');
}

export function createModeIcon(icon: ModeIconId): HTMLElement {
	switch (icon) {
		case 'plan':
			return createPlanIcon();
		case 'debug':
			return createStrokeIcon('debug', [
				'M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1',
				'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6',
				'M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4',
			]);
		case 'multitask':
			return createMultitaskIcon();
		case 'ask':
			return createStrokeIcon('ask', [
				'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20',
				'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4',
				'M12 17.5h.01',
			]);
		case 'agent':
		default:
			return createStrokeIcon('agent', [
				'M14 9L13.75 9.375M10 9C9.08779 7.78565 7.63574 7 6 7C3.23858 7 1 9.23858 1 12C1 14.7614 3.23858 17 6 17C7.63582 17 9.08816 16.2144 10.0004 15L10.3337 14.5',
				'M10 9L13.9996 15C14.9118 16.2144 16.3642 17 18 17C20.7614 17 23 14.7614 23 12C23 9.23858 20.7614 7 18 7C16.3642 7 14.9118 7.78555 13.9996 9',
			]);
	}
}
