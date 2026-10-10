/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Hatched bar chart from the usage spec. The source art lies on its side (bars grow to the
 * right); it is turned a quarter so the bars stand up from a baseline.
 */
const USAGE_ICON_PATH = 'M4.5 20.25V3.75M9 9.75V5.25M9 18.75V14.25M15 14.25V9.75M4.5 5.25H16.5V9.75M4.5 9.75H21V14.25H4.5M13.5 14.25V18.75H4.5M12.3138 5.31372L16.0384 9.03828M9.04895 6.54907L11.8888 9.38895';

/** Clockwise arrow before a reset countdown. */
const RESET_ICON_PATH = 'M20 11.5A8 8 0 1 1 17.66 6.34M20 4v4.5h-4.5';
/** Ticket for redeemable limit resets. */
const TICKET_ICON_PATH = 'M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5V14a2 2 0 0 0 0-4zM9 6v12';
/** Pace marks: usage slower than the window refills, or faster. */
const PACE_DOWN_PATH = 'M3 7l6 6 4-4 8 8M21 11v6h-6';
const PACE_UP_PATH = 'M3 17l6-6 4 4 8-8M21 13V7h-6';

function svgIcon(className: string, paths: string[], options: { size?: number; strokeWidth?: number; transform?: string } = {}): HTMLElement {
	const host = $(`span.volt-usage-icon.${className}`);
	const size = options.size ?? 16;
	const svg = host.ownerDocument.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const group = host.ownerDocument.createElementNS(SVG_NS, 'g');
	if (options.transform) {
		group.setAttribute('transform', options.transform);
	}
	for (const d of paths) {
		const path = host.ownerDocument.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', String(options.strokeWidth ?? 1.5));
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		group.appendChild(path);
	}
	svg.appendChild(group);
	host.appendChild(svg);
	return host;
}

export function createUsageIcon(size = 16): HTMLElement {
	return svgIcon('usage', [USAGE_ICON_PATH], { size, strokeWidth: 1.5, transform: 'rotate(-90 12 12)' });
}

export function createResetIcon(): HTMLElement {
	return svgIcon('reset', [RESET_ICON_PATH], { size: 12, strokeWidth: 2.2 });
}

export function createTicketIcon(): HTMLElement {
	return svgIcon('ticket', [TICKET_ICON_PATH], { size: 13, strokeWidth: 2 });
}

export function createPaceIcon(ahead: boolean): HTMLElement {
	return svgIcon(ahead ? 'pace-up' : 'pace-down', [ahead ? PACE_UP_PATH : PACE_DOWN_PATH], { size: 15, strokeWidth: 1.8 });
}

/** Spoke opacities for the refresh spinner, brightest at 180 degrees and fading back toward the top. */
const REFRESH_SPINNER_OPACITY = [0.14, 0.29, 0.43, 0.57, 0.71, 0.86, 1];

/**
 * Activity spinner shown in place of the usage refresh icon while a reload is in flight.
 * Twelve discrete 30-degree steps over 0.75s, same motion as the system activity indicator.
 */
export function createRefreshSpinner(): SVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'volt-usage-spinner');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '15');
	svg.setAttribute('height', '15');
	svg.setAttribute('aria-hidden', 'true');
	const group = document.createElementNS(SVG_NS, 'g');
	REFRESH_SPINNER_OPACITY.forEach((opacity, index) => {
		const rect = document.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('width', '2');
		rect.setAttribute('height', '5');
		rect.setAttribute('x', '11');
		rect.setAttribute('y', '1');
		rect.setAttribute('fill', 'currentColor');
		rect.setAttribute('opacity', String(opacity));
		if (index > 0) {
			rect.setAttribute('transform', `rotate(${index * 30} 12 12)`);
		}
		group.appendChild(rect);
	});
	const spin = document.createElementNS(SVG_NS, 'animateTransform');
	spin.setAttribute('attributeName', 'transform');
	spin.setAttribute('calcMode', 'discrete');
	spin.setAttribute('dur', '0.75s');
	spin.setAttribute('repeatCount', 'indefinite');
	spin.setAttribute('type', 'rotate');
	spin.setAttribute('values', '0 12 12;30 12 12;60 12 12;90 12 12;120 12 12;150 12 12;180 12 12;210 12 12;240 12 12;270 12 12;300 12 12;330 12 12;360 12 12');
	group.appendChild(spin);
	svg.appendChild(group);
	return svg;
}
