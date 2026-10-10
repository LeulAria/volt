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
import { IVoltEventEnvelope } from '../../common/events.js';
import { encodeTraceRecord, ITraceRecord, TraceRecorder } from '../../common/harness/eventStore.js';
import { IRunMetrics } from '../../common/harness/runMetrics.js';

/**
 * Each chat's event trace on disk, one JSON record per line, with timestamps: what happened in a
 * run (tools, edits, notices, retries, the answer text) and its timings, for post-mortems, replay
 * tests, and benchmarks. Live-only deltas are not stored. A write rewrites the file atomically (the
 * user-data provider has no reliable append), up to a few megabytes, so it happens when a run ends
 * ({@link RunTraceJournal.flush}); a run that goes on long is saved now and then, when the window
 * is idle. Old lines are dropped past a cap.
 */

/** A long run's trace is saved at most this often while it runs; its end saves it at once. */
const SAVE_DELAY_MS = 30_000;
/** How long an idle-time save may wait for the window to go idle. */
const SAVE_IDLE_TIMEOUT_MS = 5_000;
const MAX_CHARS = 4 * 1024 * 1024;

interface ITraceFile {
	readonly recorder: TraceRecorder;
	/** Existing file content, read once before the first write. */
	loaded?: Promise<string[]>;
	lines: string[];
	chars: number;
	dirty: boolean;
	timer?: ReturnType<typeof setTimeout>;
	/** A save waiting for the window to go idle. */
	idle?: IDisposable;
	writing: Promise<void>;
}

export class RunTraceJournal extends Disposable {

	private readonly files = new Map<string, ITraceFile>();

	constructor(
		private readonly root: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.flushAll() });
	}

	record(envelope: IVoltEventEnvelope): void {
		const file = this.file(envelope.sessionId);
		this.add(envelope.sessionId, file, file.recorder.push(envelope));
	}

	recordMetrics(metrics: IRunMetrics): void {
		const file = this.file(metrics.sessionId);
		this.add(metrics.sessionId, file, [{ kind: 'metrics', runId: metrics.runId, ts: Date.now(), metrics }]);
	}

	/** Writes now (end of a run) and lets go of the lines held in memory; the next run reads the file again. */
	flush(sessionId: string): Promise<void> {
		const file = this.files.get(sessionId);
		if (!file) {
			return Promise.resolve();
		}
		if (file.timer !== undefined) {
			clearTimeout(file.timer);
			file.timer = undefined;
		}
		file.idle?.dispose();
		file.idle = undefined;
		return this.write(sessionId, file).then(() => {
			if (!file.dirty && file.timer === undefined) {
				file.lines = [];
				file.chars = 0;
				file.loaded = undefined;
			}
		});
	}

	async read(sessionId: string): Promise<string> {
		await this.files.get(sessionId)?.writing;
		try {
			return (await this.fileService.readFile(this.uri(sessionId))).value.toString();
		} catch {
			return '';
		}
	}

	uri(sessionId: string): URI {
		return joinPath(this.root, `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`);
	}

	private file(sessionId: string): ITraceFile {
		let file = this.files.get(sessionId);
		if (!file) {
			file = { recorder: new TraceRecorder(), lines: [], chars: 0, dirty: false, writing: Promise.resolve() };
			this.files.set(sessionId, file);
		}
		return file;
	}

	private add(sessionId: string, file: ITraceFile, records: readonly ITraceRecord[]): void {
		if (!records.length) {
			return;
		}
		for (const record of records) {
			const line = encodeTraceRecord(record);
			file.lines.push(line);
			file.chars += line.length + 1;
		}
		file.dirty = true;
		if (file.timer === undefined && !file.idle) {
			file.timer = setTimeout(() => {
				file.timer = undefined;
				file.idle = runWhenGlobalIdle(() => {
					file.idle = undefined;
					void this.write(sessionId, file);
				}, SAVE_IDLE_TIMEOUT_MS);
			}, SAVE_DELAY_MS);
		}
	}

	private write(sessionId: string, file: ITraceFile): Promise<void> {
		file.writing = file.writing.then(async () => {
			if (!file.dirty) {
				return;
			}
			file.loaded ??= this.fileService.readFile(this.uri(sessionId)).then(content => content.value.toString().split('\n').filter(Boolean), () => []);
			const earlier = await file.loaded;
			if (earlier.length) {
				// Lines from before this window opened go first, once.
				file.lines = [...earlier, ...file.lines];
				file.chars += earlier.reduce((total, line) => total + line.length + 1, 0);
				file.loaded = Promise.resolve([]);
			}
			let drop = 0;
			while (file.chars > MAX_CHARS && drop < file.lines.length - 1) {
				file.chars -= file.lines[drop].length + 1;
				drop++;
			}
			if (drop) {
				file.lines = file.lines.slice(drop);
			}
			file.dirty = false;
			try {
				await this.fileService.writeFile(this.uri(sessionId), VSBuffer.fromString(`${file.lines.join('\n')}\n`), { atomic: { postfix: '.vsctmp' } });
			} catch (err) {
				file.dirty = true;
				this.logService.warn(`[volt] could not save the run trace for ${sessionId}`, err);
			}
		});
		return file.writing;
	}

	private flushAll(): void {
		for (const [sessionId, file] of this.files) {
			if (file.timer !== undefined) {
				clearTimeout(file.timer);
				file.timer = undefined;
			}
			file.idle?.dispose();
			file.idle = undefined;
			void this.write(sessionId, file);
		}
	}
}
