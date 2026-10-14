/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { THINKING_DOTS_SPEED, thinkingDotOpacities } from '../../common/agentThinkingDotsModel.js';

// The composer chips' working indicator and scroll rule, shared with the web app's composer.


/** A reader this close to the last line is at the end, so the arrow stays hidden. */
export const SCROLL_END_SLACK_PX = 96;

/** Empty chats and a thread already at the end do not offer the scroll-down arrow. */
export function shouldOfferScrollToBottom(hasMessages: boolean, distanceFromBottom: number): boolean {
	return hasMessages && distanceFromBottom > SCROLL_END_SLACK_PX;
}

export function createThinkingDots(): { root: HTMLElement; cells: HTMLElement[] } {
	const root = $('span.volt-browser-dock-dots');
	root.setAttribute('aria-hidden', 'true');
	const cells: HTMLElement[] = [];
	for (let i = 0; i < 9; i++) {
		cells.push(append(root, $('span.volt-browser-dock-dot')));
	}
	return { root, cells };
}

/** One frame of the dots' spin: a short bright trail runs around the ring of the 3x3 grid. */
export function paintThinkingDots(cells: readonly HTMLElement[], step: number): void {
	const opacities = thinkingDotOpacities(step);
	for (const [index, cell] of cells.entries()) {
		cell.style.opacity = String(opacities[index]);
	}
}

export { THINKING_DOTS_SPEED };
