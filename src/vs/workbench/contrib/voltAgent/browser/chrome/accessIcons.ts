/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { VoltAccessMode } from '../../../../services/voltRuntime/common/access/accessModes.js';

interface ISvgPath {
	d: string;
	fill?: 'none' | 'currentColor';
	strokeWidth?: string;
}

interface ISvgRect {
	x: string;
	y: string;
	width: string;
	height: string;
	rx?: string;
	ry?: string;
}

function svgIcon(paths: ISvgPath[], rects: ISvgRect[] = [], extraClass?: string, strokeWidth = '1.5'): HTMLElement {
	const el = extraClass ? $(`span.volt-agent-svg-icon.${extraClass}`) : $('span.volt-agent-svg-icon');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const rect of rects) {
		const node = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
		node.setAttribute('x', rect.x);
		node.setAttribute('y', rect.y);
		node.setAttribute('width', rect.width);
		node.setAttribute('height', rect.height);
		if (rect.rx) {
			node.setAttribute('rx', rect.rx);
		}
		if (rect.ry) {
			node.setAttribute('ry', rect.ry);
		}
		node.setAttribute('fill', 'none');
		node.setAttribute('stroke', 'currentColor');
		node.setAttribute('stroke-width', strokeWidth);
		node.setAttribute('stroke-linecap', 'round');
		node.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(node);
	}
	for (const path of paths) {
		const node = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		node.setAttribute('d', path.d);
		node.setAttribute('fill', path.fill ?? 'none');
		node.setAttribute('stroke', 'currentColor');
		node.setAttribute('stroke-width', path.strokeWidth ?? strokeWidth);
		node.setAttribute('stroke-linecap', 'round');
		node.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(node);
	}
	el.appendChild(svg);
	return el;
}

const LOCK_RECT: ISvgRect = { x: '3', y: '7', width: '10', height: '7', rx: '1.5', ry: '1.5' };

export function createAccessIcon(mode: VoltAccessMode): HTMLElement {
	switch (mode) {
		case 'supervised':
			return svgIcon([{ d: 'M5 7V5a3 3 0 0 1 6 0v2' }], [LOCK_RECT], 'access-lock');
		case 'auto-accept-edits':
			return svgIcon([
				{ d: 'M3 2.5h6.2L12 5.3V13.5H3z' },
				{ d: 'M9.2 2.5V5.3H12' },
				{ d: 'M5 7h4M5 9.2h2.4' },
				{ d: 'M10.2 11.2l1.6-1.6 1.4 1.4-1.6 1.6-.5.1.1-.5z' },
			], [], 'access-edit');
		case 'auto':
			return svgIcon([
				{ d: 'M6.2 2.4 7 5.1a3.6 3.6 0 0 0 2 2L11.6 8 9 8.9a3.6 3.6 0 0 0-2 2L6.2 13.6 5.4 10.9a3.6 3.6 0 0 0-2-2L.8 8 3.4 7.1a3.6 3.6 0 0 0 2-2z' },
				{ d: 'M12.4 1.6 12.8 3a1.6 1.6 0 0 0 .9.9l1.4.4-1.4.4a1.6 1.6 0 0 0-.9.9l-.4 1.4-.4-1.4a1.6 1.6 0 0 0-.9-.9L9.7 3.3l1.4-.4a1.6 1.6 0 0 0 .9-.9z' },
			], [], 'access-auto');
		case 'full-access':
		default:
			return svgIcon([{ d: 'M5 7V5a3 3 0 0 1 5.6-.8' }], [LOCK_RECT], 'access-unlock');
	}
}
