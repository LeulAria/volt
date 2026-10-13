/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color, HSLA, RGBA } from '../../../../base/common/color.js';

/** At full intensity a surface takes this much of the tint. */
const MAX_TINT = 0.3;

/** The tint itself: the hue at a mid lightness, a little lighter on dark themes. */
export function tintColor(hue: number, dark: boolean): Color {
	return new Color(new HSLA(((hue % 360) + 360) % 360, 0.85, dark ? 0.6 : 0.5, 1));
}

/** `base` with `amount` (0-1) of `tint` mixed into its color; its alpha stays. */
export function mixTint(base: Color, tint: Color, amount: number): Color {
	const a = base.rgba;
	const b = tint.rgba;
	const lerp = (x: number, y: number) => Math.round(x + (y - x) * amount);
	return new Color(new RGBA(lerp(a.r, b.r), lerp(a.g, b.g), lerp(a.b, b.b), a.a));
}

/** The share of tint a surface takes for the Intensity setting (0-100). */
export function tintAmount(intensity: number): number {
	return Math.max(0, Math.min(100, intensity)) / 100 * MAX_TINT;
}
