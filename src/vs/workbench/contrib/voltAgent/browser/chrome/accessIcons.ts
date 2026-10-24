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
	if (extraClass?.startsWith('access-')) {
		// A class, not [class*="access-"]: an attribute selector on an ancestor restyles every svg under any element whose class changes.
		el.classList.add('volt-agent-access-icon');
	}
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
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

function circle(cx: number, cy: number, r: number): string {
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0`;
}

// Lucide line icons (24px grid, via Aria Icons), drawn at 16px with a 1.5 stroke so every row of
// the Permissions menu shares one weight and one optical size.
const LOCK_RECT: ISvgRect = { x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' };

/** `strokeWidth`: the composer's access trigger draws its icon lighter than the menu rows. */
export function createAccessIcon(mode: VoltAccessMode, strokeWidth?: string): HTMLElement {
	switch (mode) {
		case 'supervised':
			// lucide:lock
			return svgIcon([{ d: 'M7 11V7a5 5 0 0 1 10 0v4' }], [LOCK_RECT], 'access-lock', strokeWidth);
		case 'auto-accept-edits':
			// lucide:file-pen-line
			return svgIcon([
				{ d: 'm18.226 5.226-2.52-2.52A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-.351' },
				{ d: 'M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z' },
				{ d: 'M8 18h1' },
			], [], 'access-edit', strokeWidth);
		case 'auto':
			// lucide:shield-check: routine actions approved, the rest still asks
			return svgIcon([
				{ d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' },
				{ d: 'm9 12 2 2 4-4' },
			], [], 'access-auto', strokeWidth);
		case 'full-access':
		default:
			// lucide:lock-open
			return svgIcon([{ d: 'M7 11V7a5 5 0 0 1 9.9-1' }], [LOCK_RECT], 'access-unlock', strokeWidth);
	}
}

/** This Mac (a laptop) on the new chat's machine picker and its menu, drawn at the access trigger's weight. */
export function createThisMacIcon(): HTMLElement {
	return svgIcon([{ d: 'M1 20H23M4 16H20C20.5523 16 21 15.5523 21 15V5C21 4.44772 20.5523 4 20 4H4C3.44772 4 3 4.44772 3 5V15C3 15.5523 3.44772 16 4 16Z' }], [], 'this-mac', '1.3');
}

export type SandboxIconId = 'off' | 'workspace-write' | 'read-only' | 'network';

/** The Sandbox rows of the same menu, in the same set. */
export function createSandboxIcon(id: SandboxIconId): HTMLElement {
	switch (id) {
		case 'off':
			// lucide:ban
			return svgIcon([{ d: 'M4.929 4.929 19.07 19.071' }, { d: circle(12, 12, 10) }], [], 'sandbox-off');
		case 'workspace-write':
			// lucide:folder-pen
			return svgIcon([
				{ d: 'M2 11.5V5a2 2 0 0 1 2-2h3.9c.7 0 1.3.3 1.7.9l.8 1.2c.4.6 1 .9 1.7.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9.5' },
				{ d: 'M11.378 13.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z' },
			], [], 'sandbox-write');
		case 'read-only':
			// lucide:eye
			return svgIcon([
				{ d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' },
				{ d: circle(12, 12, 3) },
			], [], 'sandbox-read');
		case 'network':
			// lucide:globe
			return svgIcon([{ d: circle(12, 12, 10) }, { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }, { d: 'M2 12h20' }], [], 'sandbox-network');
	}
}
