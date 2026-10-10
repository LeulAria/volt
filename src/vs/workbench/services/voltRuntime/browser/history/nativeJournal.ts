/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { runWhenGlobalIdle } from '../../../../../base/common/async.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INativeLoopMessage } from '../../common/harness/nativeLoop.js';

/**
 * The native model transcript on disk: every tool call and result, not just the visible text.
 * Saved at the end of a run, and during one at most every {@link SAVE_DELAY_MS} (at a step
 * boundary, once the window is idle): a save serializes the whole transcript, up to megabytes.
 * After a reload (or a crash mid-run) the next message continues with everything the model had
 * seen as of the last save, and an interrupted tool batch is repaired on replay.
 */

export interface INativeJournalEntry {
	readonly version: 1;
	readonly messages: INativeLoopMessage[];
	/** How many of the session's text messages the transcript contained when saved. */
	readonly synced: number;
	readonly effort?: string;
	readonly todo?: string;
	readonly savedAt: number;
}

/** Longest a running turn's transcript waits to be saved; steps in between only update what will be written. */
const SAVE_DELAY_MS = 8_000;
/** How long a save may wait for the window to go idle. */
const SAVE_IDLE_TIMEOUT_MS = 3_000;
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_FULL_TAIL = 40;

export class NativeJournal extends Disposable {

	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly idle = new Map<string, IDisposable>();
	private readonly latest = new Map<string, () => INativeJournalEntry>();

	constructor(
		private readonly root: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.flushAll() });
	}

	async load(sessionId: string): Promise<INativeJournalEntry | undefined> {
		try {
			const content = await this.fileService.readFile(this.file(sessionId));
			const parsed = JSON.parse(content.value.toString()) as INativeJournalEntry;
			return parsed?.version === 1 && Array.isArray(parsed.messages) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Throttled save: the first step after a save starts the wait, later ones only replace the
	 * snapshot it will write (the latest). `now` writes immediately (end of a run).
	 */
	schedule(sessionId: string, snapshot: () => INativeJournalEntry, now = false): Promise<void> | void {
		this.latest.set(sessionId, snapshot);
		if (now) {
			this.cancel(sessionId);
			return this.write(sessionId);
		}
		if (this.timers.has(sessionId) || this.idle.has(sessionId)) {
			return;
		}
		this.timers.set(sessionId, setTimeout(() => {
			this.timers.delete(sessionId);
			this.idle.set(sessionId, runWhenGlobalIdle(() => {
				this.idle.delete(sessionId);
				void this.write(sessionId);
			}, SAVE_IDLE_TIMEOUT_MS));
		}, SAVE_DELAY_MS));
	}

	private cancel(sessionId: string): void {
		const pending = this.timers.get(sessionId);
		if (pending) {
			clearTimeout(pending);
			this.timers.delete(sessionId);
		}
		this.idle.get(sessionId)?.dispose();
		this.idle.delete(sessionId);
	}

	async delete(sessionId: string): Promise<void> {
		this.cancel(sessionId);
		this.latest.delete(sessionId);
		await this.fileService.del(this.file(sessionId)).catch(() => undefined);
	}

	private async write(sessionId: string): Promise<void> {
		const snapshot = this.latest.get(sessionId);
		if (!snapshot) {
			return;
		}
		try {
			const entry = snapshot();
			let text = JSON.stringify({ ...entry, messages: entry.messages.map(withoutImages) });
			if (text.length > MAX_BYTES) {
				text = JSON.stringify({ ...entry, messages: shrink(entry.messages) });
			}
			await this.fileService.writeFile(this.file(sessionId), VSBuffer.fromString(text), { atomic: { postfix: '.vsctmp' } });
		} catch (err) {
			this.logService.warn(`[volt] could not save the native transcript for ${sessionId}`, err);
		}
	}

	private flushAll(): void {
		const pending = new Set([...this.timers.keys(), ...this.idle.keys()]);
		for (const sessionId of pending) {
			this.cancel(sessionId);
			void this.write(sessionId);
		}
	}

	private file(sessionId: string): URI {
		return joinPath(this.root, `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
	}
}

function withoutImages(message: INativeLoopMessage): INativeLoopMessage {
	if (!message.images?.length) {
		return message;
	}
	const { images: _images, ...rest } = message;
	return { ...rest, content: `${message.content}\n[image omitted from saved transcript]` };
}

/** Over budget: older tool results are cut to their first lines; the recent tail stays whole. */
function shrink(messages: readonly INativeLoopMessage[]): INativeLoopMessage[] {
	const cutoff = Math.max(0, messages.length - KEEP_FULL_TAIL);
	return messages.map((message, index) => {
		const plain = withoutImages(message);
		if (index >= cutoff || plain.role !== 'tool' || plain.content.length <= 2_000) {
			return plain;
		}
		return { ...plain, content: `${plain.content.slice(0, 2_000)}\n[... trimmed in the saved transcript]` };
	});
}
