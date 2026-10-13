/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The app icon's bolt (brand/volt-icon.svg), fitted where the terminal icon draws its `>`. */
const BOLT_PATH = 'M9.1 7.5 5.3 12.2l2.3.6-.3 3.7 3.8-4.7-2.3-.6z';
/** The prompt's cursor, as in the terminal icon. */
const CURSOR_PATH = 'M13.5 16.5h5';

/**
 * A terminal the agent started: the terminal icon's frame and cursor in line art, with Volt's bolt
 * in place of the prompt. Drawn in `currentColor` at 16px, the size of a codicon.
 */
export function createAgentTerminalIcon(doc: Document, size = 16): SVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('volt-agent-terminal-icon');
	const frame = doc.createElementNS(SVG_NS, 'rect');
	frame.setAttribute('x', '2.75');
	frame.setAttribute('y', '3.75');
	frame.setAttribute('width', '18.5');
	frame.setAttribute('height', '16.5');
	frame.setAttribute('rx', '2.5');
	const bolt = doc.createElementNS(SVG_NS, 'path');
	bolt.setAttribute('d', BOLT_PATH);
	const cursor = doc.createElementNS(SVG_NS, 'path');
	cursor.setAttribute('d', CURSOR_PATH);
	for (const part of [frame, bolt, cursor]) {
		part.setAttribute('stroke', 'currentColor');
		part.setAttribute('stroke-width', '1.5');
		part.setAttribute('stroke-linecap', 'round');
		part.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(part);
	}
	return svg;
}
