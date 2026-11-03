/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useWindowDimensions } from 'react-native';

/** Past this width the app lays out side by side (Material's "medium" window, an open fold, an iPad). */
export const EXPANDED_WIDTH = 600;
/** The tab rail that replaces the bottom bar on a wide window. */
export const RAIL_WIDTH = 76;
/** Lists and pages stop growing here, so lines stay readable on an iPad in landscape. */
export const READABLE_WIDTH = 720;

export interface IAdaptive {
	readonly width: number;
	readonly height: number;
	/** Wide enough for two panes: an open iPhone Duo or Android fold, a tablet, a phone in landscape. */
	readonly expanded: boolean;
	/**
	 * A wide, nearly square window: an open book-style foldable (iPhone Duo, Pixel Fold, Galaxy Z
	 * Fold). Two panes split exactly at the middle there, so the hinge falls between them, not
	 * across text, whether the phone lies flat or stands half open.
	 */
	readonly fold: boolean;
}

/**
 * The window's shape, live: folding or unfolding a phone (or turning a tablet) resizes the window
 * and every screen using this re-lays itself out on the spot.
 */
export function useAdaptive(): IAdaptive {
	const { width, height } = useWindowDimensions();
	const expanded = width >= EXPANDED_WIDTH && height >= 420;
	const aspect = width / Math.max(1, height);
	return { width, height, expanded, fold: expanded && aspect > 0.7 && aspect < 1.45 };
}

/**
 * How wide the leading pane is in a two-pane layout spanning the whole window: half of it on a
 * fold (the hinge between the panes), a sidebar elsewhere. `offset` is what sits to its left in the
 * window (the tab rail), so the split still lands on the hinge.
 */
export function leadingPaneWidth(layout: IAdaptive, offset = 0): number {
	if (layout.fold) {
		return Math.round(layout.width / 2) - offset;
	}
	return Math.round(Math.min(420, Math.max(320, (layout.width - offset) * 0.36)));
}

/** Side padding that keeps content to {@link READABLE_WIDTH} in the middle of a wide screen. */
export function readableInset(width: number): number {
	return Math.max(0, Math.round((width - READABLE_WIDTH) / 2));
}

/** {@link readableInset} for this screen; `rail`: it sits beside the tab rail on a wide window. */
export function useReadableInset(rail = false): number {
	const layout = useAdaptive();
	return readableInset(layout.width - (rail && layout.expanded ? RAIL_WIDTH : 0));
}
