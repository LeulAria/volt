/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltBadgeService = createDecorator<IVoltBadgeService>('voltBadgeService');
export const VOLT_BADGE_CHANNEL_NAME = 'voltBadge';

/**
 * The app icon's badge: the dock on macOS, the taskbar overlay on Windows, the launcher count on
 * Linux (Unity). Every window reports its own count; the badge shows their sum, and a window
 * that closes takes its count with it.
 */
export interface IVoltBadgeService {
	readonly _serviceBrand: undefined;

	/** `count` 0 removes this window's share. */
	setCount(windowId: number, count: number): Promise<void>;

	/** The number on the badge right now (tests and diagnostics). */
	getCount(): Promise<number>;
}

/** Sums every window's count; negative and fractional counts are ignored. */
export function totalBadgeCount(counts: Iterable<number>): number {
	let total = 0;
	for (const count of counts) {
		if (Number.isFinite(count) && count > 0) {
			total += Math.floor(count);
		}
	}
	return total;
}
