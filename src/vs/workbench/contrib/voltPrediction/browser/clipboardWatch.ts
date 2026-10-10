/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

const MAX_CLIPBOARD_CHARS = 2_000;
const READ_EVERY_MS = 400;

/**
 * The clipboard and when it changed, as far as the predictions can tell (they read it on use, at
 * most every 400ms). What was on it when the window opened counts as old: a copy from yesterday
 * should not ride along in every prompt.
 */
export class ClipboardWatch {

	private text = '';
	private changedAt = 0;
	private readAt = 0;
	private read = false;

	constructor(@IClipboardService private readonly clipboardService: IClipboardService) {
		this.refresh();
	}

	/** Reads the clipboard in the background; the next call sees what it found. */
	refresh(): void {
		const now = Date.now();
		if (now - this.readAt < READ_EVERY_MS) {
			return;
		}
		this.readAt = now;
		this.clipboardService.readText().then(text => {
			text = text.slice(0, MAX_CLIPBOARD_CHARS);
			if (text !== this.text) {
				this.changedAt = this.read ? Date.now() : 0;
				this.text = text;
			}
			this.read = true;
		}, () => {
			// No clipboard access: the prompts go without it.
		});
	}

	/**
	 * The clipboard for a prompt: when it was copied in the last `maxAgeMs`, or when `relevant`
	 * says it bears on what is being written. Undefined otherwise, so it costs no tokens.
	 */
	recent(maxAgeMs: number, relevant?: (text: string) => boolean): string | undefined {
		if (!this.text.trim()) {
			return undefined;
		}
		const fresh = this.changedAt > 0 && Date.now() - this.changedAt <= maxAgeMs;
		return fresh || relevant?.(this.text) ? this.text : undefined;
	}
}
