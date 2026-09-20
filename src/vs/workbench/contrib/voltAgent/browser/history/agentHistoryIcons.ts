/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { AgentSessionStatus } from '../../../../services/voltRuntime/common/history/agentHistory.js';

function createHistorySvg(extraClass: string, inner: (svg: SVGSVGElement) => void): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	inner(svg);
	el.appendChild(svg);
	return el;
}

function strokeCircle(svg: SVGSVGElement, extra?: (circle: SVGCircleElement) => void): void {
	const circle = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
	circle.setAttribute('cx', '8');
	circle.setAttribute('cy', '8');
	circle.setAttribute('r', '5.25');
	circle.setAttribute('stroke', 'currentColor');
	circle.setAttribute('stroke-width', '1.5');
	extra?.(circle);
	svg.appendChild(circle);
}

/** Dashed ring used for drafts and idle sessions that have not finished a turn. */
export function createDraftHistoryIcon(): HTMLElement {
	return createHistorySvg('draft', svg => {
		strokeCircle(svg, circle => circle.setAttribute('stroke-dasharray', '2.4 1.8'));
	});
}

/** Check in a circle for finished sessions. */
export function createDoneHistoryIcon(): HTMLElement {
	return createHistorySvg('done', svg => {
		strokeCircle(svg);
		const check = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		check.setAttribute('d', 'M5.25 8.15l1.85 1.85 3.65-3.7');
		check.setAttribute('stroke', 'currentColor');
		check.setAttribute('stroke-width', '1.5');
		check.setAttribute('stroke-linecap', 'round');
		check.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(check);
	});
}

/** Burst used while a session is running; CSS spins the SVG. */
export function createRunningHistoryIcon(): HTMLElement {
	return createHistorySvg('running', svg => {
		const path = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M8 2.5v2.25M8 11.25V13.5M13.5 8h-2.25M4.75 8H2.5M11.9 4.1l-1.6 1.6M5.7 10.3l-1.6 1.6M11.9 11.9l-1.6-1.6M5.7 5.7L4.1 4.1');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		svg.appendChild(path);
	});
}

export function createHistoryStatusIcon(status: AgentSessionStatus, hasDraft?: boolean, turnCount = 0): HTMLElement {
	if (status === 'running') {
		return createRunningHistoryIcon();
	}
	if (status === 'done') {
		return createDoneHistoryIcon();
	}
	if (status === 'idle' && (hasDraft || turnCount === 0)) {
		return createDraftHistoryIcon();
	}
	if (status === 'error' || status === 'cancelled' || status === 'interrupted') {
		return createDraftHistoryIcon();
	}
	return createDoneHistoryIcon();
}
