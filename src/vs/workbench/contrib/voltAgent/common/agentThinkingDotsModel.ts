/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The working indicator's motion, without the DOM: a 3x3 grid of dots where a short bright trail
// runs around the ring. The agent window, the web app and the mobile app all draw it from here.

const DOT_RING = [0, 1, 2, 5, 8, 7, 6, 3];
const DOT_TRAIL = 2;

/** How often the dots step, in ms. */
export const THINKING_DOTS_SPEED = 90;

/** The nine dots' opacities (row by row) at one step of the spin. */
export function thinkingDotOpacities(step: number): number[] {
	const opacities: number[] = [];
	for (let index = 0; index < 9; index++) {
		let opacity = index === 4 ? 0.16 : 0.1;
		const ring = DOT_RING.indexOf(index);
		if (ring >= 0) {
			const distance = (ring - (step % DOT_RING.length) + DOT_RING.length) % DOT_RING.length;
			if (distance <= DOT_TRAIL) {
				opacity = 1 - distance / (DOT_TRAIL + 1);
			}
		}
		opacities.push(opacity);
	}
	return opacities;
}
