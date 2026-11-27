/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltViewLocation } from '../../../services/voltPlugins/common/voltContributions.js';
import type { VoltSlotId } from './voltSlots.js';

/**
 * A tiny map of the Volt window for each place an item or a view can go: the window's outline and
 * its parts faint, the place itself solid. Drawn as a mask (one colour, alpha for the faint parts),
 * so it takes the text colour like any icon. 24x24 drawing, shown at 16px.
 *
 * The window: title bar 3-7.25, agent sidebar 1-8, chat from 8, files sidebar or right panel from
 * 15.5 when the place is there.
 */

type Shape = string;

const FAINT = 0.3;
const LINE = 0.5;

const rect = (x: number, y: number, w: number, h: number, opacity = 1, r = 0.75): Shape =>
	`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#000" fill-opacity="${opacity}"/>`;
const outlineRect = (x: number, y: number, w: number, h: number, r = 1): Shape =>
	`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="#000" stroke-opacity="${LINE}" stroke-width="1"/>`;
const hline = (y: number, x1: number, x2: number): Shape =>
	`<path d="M${x1} ${y}H${x2}" fill="none" stroke="#000" stroke-opacity="${FAINT}" stroke-width="1"/>`;
const vline = (x: number, y1: number, y2: number): Shape =>
	`<path d="M${x} ${y1}V${y2}" fill="none" stroke="#000" stroke-opacity="${FAINT}" stroke-width="1"/>`;

/** The window: its frame, the title bar's line and the agent sidebar's edge. */
const WINDOW = [
	`<rect x="1" y="3" width="22" height="18" rx="2.5" fill="none" stroke="#000" stroke-opacity="${LINE}" stroke-width="1.5"/>`,
	hline(7.25, 1.75, 22.25),
	vline(8, 7.25, 20.25),
].join('');
/** The files sidebar's or right panel's edge. */
const RIGHT_EDGE = vline(15.5, 7.25, 20.25);
/** The composer, faint. */
const COMPOSER = outlineRect(9.5, 16.25, 12, 3.25, 1.25);

const GLYPHS: Record<VoltSlotId | VoltViewLocation, Shape> = {
	// Slots: where a button sits.
	'sidebar.header': rect(2.75, 8.5, 4.25, 2.5),
	'sidebar.footer': rect(2.75, 16.75, 4.25, 2.5),
	'activityBar.top': rect(2.75, 8.5, 2, 5.25),
	'activityBar.bottom': rect(2.75, 14, 2, 5.25),
	'titlebar.left': rect(2.75, 4.25, 4.5, 2),
	'titlebar.center': rect(9.5, 4.25, 6, 2),
	'titlebar.right': rect(16.5, 4.25, 5, 2),
	'filesSidebar.header': RIGHT_EDGE + rect(16.75, 8.5, 4.75, 2.5),
	'chat.toolbar': rect(19.5, 8.5, 2.25, 8),
	'chat.dock': rect(19.5, 8.5, 2.25, 8, FAINT) + rect(11.5, 9, 7, 7.5, 1, 1),
	'composer.chips': COMPOSER + rect(9.5, 12.5, 4, 2.25) + rect(14.25, 12.5, 4, 2.25),
	'rightPanel.launcher': RIGHT_EDGE + rect(16.75, 8.75, 4.75, 1.75) + rect(16.75, 11.75, 4.75, 1.75) + rect(16.75, 14.75, 4.75, 1.75),
	'hidden': `<path d="M4.5 19 19.5 5" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round"/>`,
	// Views: where a panel opens. The right panel: its tabs, then the tab in front. The files
	// sidebar: its icon row, then the view.
	rightPanel: RIGHT_EDGE + rect(16.75, 8.5, 2.25, 1.75) + rect(19.25, 8.5, 2.25, 1.75, FAINT) + rect(16.75, 11, 4.75, 8.5),
	filesSidebar: RIGHT_EDGE + rect(16.75, 8.5, 4.75, 1.75, FAINT) + rect(16.75, 11, 4.75, 8.5),
	page: rect(9.25, 8.5, 12.5, 11),
	popover: rect(10.5, 10.75, 9, 7, 1, 1) + `<path d="M13.75 10.75 15 8.75 16.25 10.75Z" fill="#000"/>`,
	aboveComposer: COMPOSER + rect(9.5, 8.5, 12, 6.25, 1, 1),
	sidebarSection: rect(2.75, 11, 4.25, 6),
};

/** The map for a slot or a view location, as SVG markup. */
export function voltLayoutGlyphSvg(target: VoltSlotId | VoltViewLocation): string {
	// Hidden: the whole window faint, struck through.
	const window = target === 'hidden' ? WINDOW.replaceAll(`stroke-opacity="${LINE}"`, `stroke-opacity="${FAINT}"`) : WINDOW;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">${window}${GLYPHS[target] ?? ''}</svg>`;
}

export const VOLT_LAYOUT_GLYPH_TARGETS = Object.keys(GLYPHS) as readonly (VoltSlotId | VoltViewLocation)[];
