/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What a list row grows by under a finger: a phone or tablet has no pointer precision. */
export const COARSE_POINTER_ROW_EXTRA = 10;

let coarse: boolean | undefined;

/** Whether the primary pointer is a finger (read once: a window does not trade its screen). */
export function isCoarsePointer(): boolean {
	return coarse ??= !!globalThis.matchMedia?.('(pointer: coarse)').matches;
}

/** A list row's height, with room for a finger on a touch screen. */
export function touchRowHeight(height: number): number {
	return isCoarsePointer() ? height + COARSE_POINTER_ROW_EXTRA : height;
}
