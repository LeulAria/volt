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
import { IArchivedMessage } from '../../common/harness/historySearch.js';
import { dropBoundReasoning } from '../../common/harness/nativeCompaction.js';
import { INativeLoopMessage } from '../../common/harness/nativeLoop.js';

/**
 * The native model transcript on disk: every tool call and result, not just the visible text.
 *
 * Two files per chat, after pi-durable's commit-before-continue rule at the cost of a few KB a step:
 * - The snapshot (`<id>.json`): the whole transcript, saved at the end of a run and during one at
 *   most every {@link SAVE_DELAY_MS} (once the window is idle), because it serializes megabytes.
 * - The live log (`<id>.live.json`): only what happened since that snapshot, rewritten after every
 *   model response and every tool result. It names the tool calls still running, so after a crash
 *   the next run knows exactly which calls were cut off, instead of losing the last seconds of work.
 *
 * Loading reads the snapshot and adds the live log when it continues that very snapshot.
 */

export interface INativeJournalEntry {
	readonly version: 1;
	readonly messages: INativeLoopMessage[];
	/** How many of the session's text messages the transcript contained when saved. */
	readonly synced: number;
	readonly effort?: string;
	readonly todo?: string;
	/** System prompt and tools the reasoning in `messages` was produced under. */
	readonly prefix?: string;
	readonly savedAt: number;
	/** First message the saved copy changed (images left out, results cut); later reasoning is gone. */
	readonly altered?: number;
	/** Ids of tool calls that were still running when the live log was written: a crash cut them off. */
	readonly running?: readonly string[];
	/** Ids of tool calls the model made that had not started (waiting for approval): nothing of them ran. */
	readonly pending?: readonly string[];
	/** Background subagents still working: each is started again from its own transcript after a crash. */
	readonly background?: readonly INativeBackgroundAgent[];
	/** Background subagent reports the agent has not read yet: delivered once, even across a crash. */
	readonly reports?: readonly string[];
}

/** A background subagent of a chat, as saved: enough to start it again where it left off. */
export interface INativeBackgroundAgent {
	/** Its transcript's journal key. */
	readonly id: string;
	/** The `task` call that started it. */
	readonly callId: string;
	readonly label: string;
	readonly request: { readonly description: string; readonly prompt: string; readonly kind: 'explore' | 'research'; readonly agent?: string };
}

/** What happened after a snapshot: the messages after its first `from`, and the calls still running. */
interface INativeLiveLog {
	readonly version: 1;
	/** `savedAt` of the snapshot this continues (0: none yet). */
	readonly base: number;
	readonly from: number;
	readonly messages: INativeLoopMessage[];
	readonly running?: readonly string[];
	readonly pending?: readonly string[];
	readonly background?: readonly INativeBackgroundAgent[];
	readonly reports?: readonly string[];
	readonly synced: number;
	readonly effort?: string;
	readonly todo?: string;
	readonly prefix?: string;
	readonly savedAt: number;
}

/** The snapshot on disk, as the live log continues it: the message at `count - 1` must still be `head`. */
interface IDurableBase {
	readonly savedAt: number;
	readonly count: number;
	readonly head: INativeLoopMessage | undefined;
}

/**
 * Longest a running turn's transcript waits for a full save; steps in between only update what
 * will be written. The live log keeps every step in the meantime, so this only bounds its size.
 */
const SAVE_DELAY_MS = 30_000;
/** How long a save may wait for the window to go idle. */
const SAVE_IDLE_TIMEOUT_MS = 3_000;
const MAX_BYTES = 8 * 1024 * 1024;
/** A live log past this asks for a full save soon, so each step's write stays small. */
const LOG_SAVE_BYTES = 1024 * 1024;
const KEEP_FULL_TAIL = 40;
/** One archived message keeps this much of its text; a tool's full output is rarely needed past it. */
const ARCHIVE_MESSAGE_CHARS = 60_000;
/** Archived messages a search reads back, newest last. */
const ARCHIVE_READ_LIMIT = 20_000;

export class NativeJournal extends Disposable {

	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly idle = new Map<string, IDisposable>();
	private readonly latest = new Map<string, () => INativeJournalEntry>();
	/** The snapshot each chat's live log continues; `stale` until a save after an edit lands. */
	private readonly durable = new Map<string, IDurableBase | 'stale'>();
	/** Bumped by every edit before the snapshot's end; a save captured before it does not count. */
	private readonly edits = new Map<string, number>();
	private readonly views = new Map<string, () => INativeJournalEntry>();
	private readonly logging = new Set<string>();
	/** Asked for while a write was in flight: written once it lands. */
	private readonly logAgain = new Set<string>();
	/** Waiting for the full save an edit asked for: written once it lands. */
	private readonly logAfterSave = new Set<string>();
	/** Writes on their way to disk, by chat: a delete waits for them, or they would bring the files back. */
	private readonly inflight = new Map<string, Set<Promise<void>>>();
	/** Archive files written by this window, so two in one millisecond get different names. */
	private archived = 0;

	constructor(
		private readonly root: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.flushAll() });
	}

	async load(sessionId: string): Promise<INativeJournalEntry | undefined> {
		const [entry, log] = await Promise.all([
			this.read<INativeJournalEntry>(this.file(sessionId)),
			this.read<INativeLiveLog>(this.logFile(sessionId)),
		]);
		const snapshot = entry?.version === 1 && Array.isArray(entry.messages) ? entry : undefined;
		const count = snapshot?.messages.length ?? 0;
		if (log?.version !== 1 || !Array.isArray(log.messages) || log.base !== (snapshot?.savedAt ?? 0) || log.from !== count) {
			// No live log, or one an older snapshot left: the snapshot has everything.
			this.durable.set(sessionId, { savedAt: snapshot?.savedAt ?? 0, count, head: snapshot?.messages.at(-1) });
			return snapshot;
		}
		const messages = [...(snapshot?.messages ?? []), ...log.messages];
		if (snapshot?.altered !== undefined) {
			// The live log's reasoning was produced over the full prefix the snapshot left out.
			dropBoundReasoning(messages, count);
		}
		this.durable.set(sessionId, { savedAt: snapshot?.savedAt ?? 0, count, head: messages[count - 1] });
		return {
			version: 1,
			messages,
			synced: log.synced,
			effort: log.effort,
			todo: log.todo,
			prefix: log.prefix,
			savedAt: snapshot?.savedAt ?? 0,
			...(log.running?.length ? { running: log.running } : {}),
			...(log.pending?.length ? { pending: log.pending } : {}),
			...(log.background?.length ? { background: log.background } : {}),
			...(log.reports?.length ? { reports: log.reports } : {}),
		};
	}

	private async read<T>(file: URI): Promise<T | undefined> {
		try {
			return JSON.parse((await this.fileService.readFile(file)).value.toString()) as T;
		} catch {
			return undefined;
		}
	}

	/**
	 * Saves what the run did since the last snapshot now: after a model response, before its tools
	 * run, and as each tool finishes. `view` is the transcript with the finished results of the
	 * batch that is still running and the ids of its other calls. The full save stays throttled.
	 */
	log(sessionId: string, snapshot: () => INativeJournalEntry, view: () => INativeJournalEntry): void {
		this.schedule(sessionId, snapshot);
		this.views.set(sessionId, view);
		if (this.logging.has(sessionId)) {
			this.logAgain.add(sessionId);
			return;
		}
		this.logging.add(sessionId);
		void this.track(sessionId, this.writeLog(sessionId)).finally(() => {
			this.logging.delete(sessionId);
			const view = this.logAgain.delete(sessionId) ? this.views.get(sessionId) : undefined;
			const latest = this.latest.get(sessionId);
			if (view && latest) {
				this.log(sessionId, latest, view);
			}
		});
	}

	/**
	 * The transcript changed before the snapshot's end (compaction, cleared results, pruned images,
	 * a cut): a live log can no longer continue the snapshot, so a full save goes out soon and the
	 * live log waits for it. A crash in between resumes from the last consistent pair.
	 */
	invalidate(sessionId: string): void {
		this.edits.set(sessionId, (this.edits.get(sessionId) ?? 0) + 1);
		this.durable.set(sessionId, 'stale');
		this.saveSoon(sessionId);
	}

	private saveSoon(sessionId: string): void {
		if (this.idle.has(sessionId) || !this.latest.has(sessionId)) {
			return;
		}
		const pending = this.timers.get(sessionId);
		if (pending) {
			clearTimeout(pending);
			this.timers.delete(sessionId);
		}
		this.idle.set(sessionId, runWhenGlobalIdle(() => {
			this.idle.delete(sessionId);
			void this.track(sessionId, this.write(sessionId));
		}, SAVE_IDLE_TIMEOUT_MS));
	}

	private async writeLog(sessionId: string): Promise<void> {
		const view = this.views.get(sessionId);
		const base = this.durable.get(sessionId) ?? { savedAt: 0, count: 0, head: undefined };
		if (!view || base === 'stale') {
			// The save that makes the log valid again writes it once it lands.
			this.logAfterSave.add(sessionId);
			return;
		}
		try {
			const entry = view();
			if (entry.messages.length < base.count || (base.count > 0 && entry.messages[base.count - 1] !== base.head)) {
				this.invalidate(sessionId);
				this.logAfterSave.add(sessionId);
				return;
			}
			const tail = entry.messages.slice(base.count);
			const messages = replayable(tail, tail.map(withoutImages)).saved;
			const text = JSON.stringify({
				version: 1,
				base: base.savedAt,
				from: base.count,
				messages,
				...(entry.running?.length ? { running: entry.running } : {}),
				...(entry.pending?.length ? { pending: entry.pending } : {}),
				...(entry.background?.length ? { background: entry.background } : {}),
				...(entry.reports?.length ? { reports: entry.reports } : {}),
				synced: entry.synced,
				effort: entry.effort,
				todo: entry.todo,
				prefix: entry.prefix,
				savedAt: Date.now(),
			} satisfies INativeLiveLog);
			if (text.length > LOG_SAVE_BYTES) {
				this.saveSoon(sessionId);
			}
			await this.fileService.writeFile(this.logFile(sessionId), VSBuffer.fromString(text), { atomic: { postfix: '.vsctmp' } });
		} catch (err) {
			this.logService.warn(`[volt] could not save the live log for ${sessionId}`, err);
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
			return this.track(sessionId, this.write(sessionId));
		}
		if (this.timers.has(sessionId) || this.idle.has(sessionId)) {
			return;
		}
		this.timers.set(sessionId, setTimeout(() => {
			this.timers.delete(sessionId);
			this.idle.set(sessionId, runWhenGlobalIdle(() => {
				this.idle.delete(sessionId);
				void this.track(sessionId, this.write(sessionId));
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

	/**
	 * Writes the session's pending snapshot now, if one waits, and forgets its snapshot source:
	 * that closure holds the whole native state in memory for as long as it is kept.
	 */
	release(sessionId: string): Promise<void> {
		const pending = this.timers.has(sessionId) || this.idle.has(sessionId);
		this.cancel(sessionId);
		const written = pending ? this.track(sessionId, this.write(sessionId)) : Promise.resolve();
		this.latest.delete(sessionId);
		this.views.delete(sessionId);
		return written;
	}

	async delete(sessionId: string): Promise<void> {
		this.cancel(sessionId);
		this.latest.delete(sessionId);
		this.views.delete(sessionId);
		this.durable.delete(sessionId);
		this.edits.delete(sessionId);
		this.logAfterSave.delete(sessionId);
		this.logAgain.delete(sessionId);
		await Promise.all(this.inflight.get(sessionId) ?? []);
		await Promise.all([
			this.fileService.del(this.file(sessionId)).catch(() => undefined),
			this.fileService.del(this.logFile(sessionId)).catch(() => undefined),
		]);
	}

	/**
	 * Messages compaction or clearing took out of the model's view go to the chat's archive, one
	 * file per batch that is never rewritten: storage keeps every message, as pi-durable keeps every
	 * entry, and `search_history` reads them back.
	 */
	archive(sessionId: string, messages: readonly INativeLoopMessage[]): Promise<void> {
		if (!messages.length) {
			return Promise.resolve();
		}
		const at = Date.now();
		const saved: IArchivedMessage[] = messages.map(message => {
			const plain = withoutImages(message);
			return { at, message: plain.content.length > ARCHIVE_MESSAGE_CHARS ? { ...plain, content: `${plain.content.slice(0, ARCHIVE_MESSAGE_CHARS)}\n[... ${plain.content.length - ARCHIVE_MESSAGE_CHARS} more characters not kept]` } : plain };
		});
		const file = joinPath(this.archiveFolder(sessionId), `${at.toString(36).padStart(10, '0')}-${(this.archived++).toString(36)}.json`);
		return this.track(sessionId, this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(saved))).then(() => undefined, err => {
			this.logService.warn(`[volt] could not archive compacted messages for ${sessionId}`, err);
		}));
	}

	/** The chat's archived messages, oldest first (the newest {@link ARCHIVE_READ_LIMIT}). */
	async readArchive(sessionId: string): Promise<IArchivedMessage[]> {
		await Promise.all(this.inflight.get(sessionId) ?? []);
		let names: string[];
		try {
			names = ((await this.fileService.resolve(this.archiveFolder(sessionId))).children ?? []).filter(child => child.name.endsWith('.json')).map(child => child.name).sort();
		} catch {
			return [];
		}
		const batches = await Promise.all(names.map(name => this.read<IArchivedMessage[]>(joinPath(this.archiveFolder(sessionId), name))));
		return batches.flatMap(batch => Array.isArray(batch) ? batch : []).slice(-ARCHIVE_READ_LIMIT);
	}

	private archiveFolder(sessionId: string): URI {
		return joinPath(this.root, 'archive', sessionId.replace(/[^\w.-]/g, '_'));
	}

	private track(sessionId: string, write: Promise<void>): Promise<void> {
		let writes = this.inflight.get(sessionId);
		if (!writes) {
			this.inflight.set(sessionId, writes = new Set());
		}
		writes.add(write);
		return write.finally(() => {
			writes.delete(write);
			if (!writes.size && this.inflight.get(sessionId) === writes) {
				this.inflight.delete(sessionId);
			}
		});
	}

	private async write(sessionId: string): Promise<void> {
		const snapshot = this.latest.get(sessionId);
		if (!snapshot) {
			return;
		}
		try {
			const entry = snapshot();
			const edits = this.edits.get(sessionId) ?? 0;
			const count = entry.messages.length;
			const head = entry.messages[count - 1];
			let saved = replayable(entry.messages, entry.messages.map(withoutImages));
			let text = JSON.stringify({ ...entry, messages: saved.saved, ...(saved.altered >= 0 ? { altered: saved.altered } : {}) });
			if (text.length > MAX_BYTES) {
				saved = replayable(entry.messages, shrink(entry.messages));
				text = JSON.stringify({ ...entry, messages: saved.saved, ...(saved.altered >= 0 ? { altered: saved.altered } : {}) });
			}
			await this.fileService.writeFile(this.file(sessionId), VSBuffer.fromString(text), { atomic: { postfix: '.vsctmp' } });
			if ((this.edits.get(sessionId) ?? 0) === edits) {
				this.durable.set(sessionId, { savedAt: entry.savedAt, count, head });
				const view = this.logAfterSave.delete(sessionId) ? this.views.get(sessionId) : undefined;
				if (view) {
					this.log(sessionId, snapshot, view);
				}
			} else {
				// Edited while this save was being written: only the next one matches the transcript.
				this.saveSoon(sessionId);
			}
		} catch (err) {
			this.logService.warn(`[volt] could not save the native transcript for ${sessionId}`, err);
		}
	}

	private flushAll(): void {
		const pending = new Set([...this.timers.keys(), ...this.idle.keys()]);
		for (const sessionId of pending) {
			this.cancel(sessionId);
			void this.track(sessionId, this.write(sessionId));
		}
	}

	private file(sessionId: string): URI {
		return joinPath(this.root, `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
	}

	private logFile(sessionId: string): URI {
		return joinPath(this.root, `${sessionId.replace(/[^\w.-]/g, '_')}.live.json`);
	}
}

/**
 * The saved copy differs from what the model saw wherever images were left out or results cut,
 * so Claude's reasoning after the first such message would be rejected when the chat resumes.
 */
function replayable(original: readonly INativeLoopMessage[], saved: INativeLoopMessage[]): { readonly saved: INativeLoopMessage[]; readonly altered: number } {
	const first = saved.findIndex((message, index) => message !== original[index]);
	if (first >= 0) {
		dropBoundReasoning(saved, first);
	}
	return { saved, altered: first };
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
