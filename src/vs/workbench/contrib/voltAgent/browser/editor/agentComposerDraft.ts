/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What of a composer draft decides the composer's layout other than its height: whether it is empty
 * (a resized composer goes back to its size, the placeholder shows) and whether it has several lines
 * (the follow-up pill opens into the full composer). A keystroke that keeps the shape and the
 * draft's height needs no layout.
 */
export function composerDraftShape(value: string): string {
	return `${value.trim() ? 'text' : 'empty'}:${value.includes('\n') ? 'lines' : 'line'}`;
}
