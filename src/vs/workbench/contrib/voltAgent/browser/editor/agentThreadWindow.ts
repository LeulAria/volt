/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a switch starts drawing a thread of `length` messages: the start of its last `keep`
 * exchanges, so the rest can be drawn while the window is idle. 0 (draw it all now) when fewer than
 * `minAbove` exchanges sit above those. `starts(index)` says whether message `index` opens an
 * exchange; message 0 always opens one.
 */
export function deferredHeadStart(length: number, starts: (index: number) => boolean, keep: number, minAbove: number): number {
	let seen = 0;
	for (let index = length - 1; index > 0; index--) {
		if (!starts(index)) {
			continue;
		}
		seen++;
		if (seen === keep) {
			let above = 1;
			for (let earlier = index - 1; earlier > 0 && above < minAbove; earlier--) {
				if (starts(earlier)) {
					above++;
				}
			}
			return above >= minAbove ? index : 0;
		}
	}
	return 0;
}

/**
 * An exchange off screen keeps the height it last had on screen only while it stays in the
 * document (content-visibility: auto in agentEditor.css): a thread parked and shown again came back
 * with every exchange at the 600px placeholder and settled over the next frames, moving the
 * scrollbar. Before the thread leaves, each exchange's height goes into its own placeholder.
 */
export function keepExchangeHeights(inner: HTMLElement): void {
	const exchanges = inner.children;
	for (let index = 0; index < exchanges.length - 1; index++) {
		const exchange = exchanges[index] as HTMLElement;
		// Fractional: a rounded height came back a few pixels off and moved the end of the thread.
		const height = exchange.getBoundingClientRect().height;
		if (height > 0) {
			exchange.style.containIntrinsicSize = `auto ${height}px`;
		}
	}
}
