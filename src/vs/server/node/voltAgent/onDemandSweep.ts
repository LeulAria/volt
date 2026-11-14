/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';

/**
 * A periodic check that only ticks while there is something to check: `wake()` (on a new client)
 * starts it when `needed()`, and it stops by itself once `needed()` is false after a sweep. An
 * agent server no device is connected to (the desktop's own, at rest) never wakes for it.
 */
export class OnDemandSweep implements IDisposable {

	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly intervalMs: number,
		private readonly needed: () => boolean,
		private readonly sweep: () => void,
	) { }

	get running(): boolean {
		return this.timer !== undefined;
	}

	wake(): void {
		if (!this.timer && !this.disposed && this.needed()) {
			this.schedule();
		}
	}

	private schedule(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) {
				return;
			}
			this.sweep();
			if (this.needed()) {
				this.schedule();
			}
		}, this.intervalMs);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
