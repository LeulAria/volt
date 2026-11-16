/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';

export type VoiceIconName = 'mic' | 'mic-slash' | 'gear' | 'paragraph' | 'phone-disconnect' | 'waveform';

/** 16px stroke paths, in the weight of Cursor's call controls. */
const PATHS: Record<VoiceIconName, readonly string[]> = {
	'mic': ['M8 1.75a2.25 2.25 0 0 0-2.25 2.25v3.5a2.25 2.25 0 0 0 4.5 0V4A2.25 2.25 0 0 0 8 1.75Z', 'M3.75 7.25a4.25 4.25 0 0 0 8.5 0', 'M8 11.5v2.75'],
	'mic-slash': ['M10.25 6.6V4a2.25 2.25 0 0 0-4.4-.66', 'M5.75 6.1v1.4a2.25 2.25 0 0 0 3.6 1.8', 'M3.75 7.25a4.25 4.25 0 0 0 6.9 3.3M12.25 7.25c0 .7-.17 1.36-.47 1.95', 'M8 11.5v2.75', 'M2.5 2.5l11 11'],
	'gear': ['M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z', 'M6.9 1.75h2.2l.35 1.6 1.05.6 1.55-.5 1.1 1.9-1.2 1.1v1.1l1.2 1.1-1.1 1.9-1.55-.5-1.05.6-.35 1.6H6.9l-.35-1.6-1.05-.6-1.55.5-1.1-1.9 1.2-1.1v-1.1l-1.2-1.1 1.1-1.9 1.55.5 1.05-.6Z'],
	'paragraph': ['M2.75 4h10.5', 'M2.75 7h10.5', 'M2.75 10h10.5', 'M2.75 13h6'],
	'phone-disconnect': ['M1.9 9.35c3.4-3.1 8.8-3.1 12.2 0l-.95 1.9a.9.9 0 0 1-1.1.45l-1.7-.6a.9.9 0 0 1-.6-.8l-.05-1.15a6.3 6.3 0 0 0-3.4 0L6.25 10.3a.9.9 0 0 1-.6.8l-1.7.6a.9.9 0 0 1-1.1-.45Z'],
	'waveform': ['M2 6.5v3', 'M4.33 4.5v7', 'M6.67 5.5v5', 'M9 2.5v11', 'M11.33 5.5v5', 'M13.67 4.5v7'],
};

export function voiceIcon(name: VoiceIconName, size = 16): HTMLElement {
	const el = $(`span.volt-voice-icon.${name}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('fill', 'none');
	for (const d of PATHS[name]) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.2');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	el.appendChild(svg);
	return el;
}
