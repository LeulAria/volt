/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';

/** The frame-end callback runs after every other callback of the frame (higher priorities run first). */
const FRAME_END_PRIORITY = -100_000;

/**
 * Input first. A key typed into the composer is drawn at the next animation frame (the editor
 * schedules its render there). While a reply streams, that frame would also patch the reply, lay it
 * out and paint it, so the key's echo waited for the stream's work. The gate lets a stream paint
 * that falls in a key's frame move to the next frame, so the frame that shows the key carries the
 * composer's own work only. A paint moves at most once in a row: however fast the user types (key
 * repeat included), the reply still paints at least every other frame.
 */
export class InputFirstGate implements IDisposable {

	private keyFrame: IDisposable | undefined;
	private yielded = false;

	/** `schedule` runs a callback at the next animation frame with a priority (the DOM frame runner). */
	constructor(private readonly schedule: (callback: () => void, priority: number) => IDisposable) { }

	/** The composer took a key: its echo is drawn at the next frame. */
	noteKey(): void {
		this.keyFrame ??= this.schedule(() => this.keyFrame = undefined, FRAME_END_PRIORITY);
	}

	/** Called by a stream paint in its frame callback: true to move the paint to the next frame. */
	shouldYield(): boolean {
		if (this.keyFrame && !this.yielded) {
			this.yielded = true;
			return true;
		}
		this.yielded = false;
		return false;
	}

	dispose(): void {
		this.keyFrame?.dispose();
		this.keyFrame = undefined;
	}
}
