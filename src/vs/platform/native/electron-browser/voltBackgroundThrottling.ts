/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { INativeHostService } from '../common/native.js';

const holds = new WeakMap<INativeHostService, Set<object>>();

/**
 * Keeps this window's timers at full speed while hidden or occluded (a closed lid occludes every
 * window). Holds are counted, so upstream chat and Volt's agents can both ask without the last
 * caller turning throttling back on under the other.
 */
export function preventBackgroundThrottling(host: INativeHostService): IDisposable {
	let set = holds.get(host);
	if (!set) {
		set = new Set();
		holds.set(host, set);
	}
	const token = {};
	set.add(token);
	if (set.size === 1) {
		void host.setBackgroundThrottling(false);
	}
	const owner = set;
	return toDisposable(() => {
		if (owner.delete(token) && owner.size === 0) {
			void host.setBackgroundThrottling(true);
		}
	});
}
