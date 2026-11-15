/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { EditCheckPhase } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IDiagnostic } from '../../../services/voltRuntime/browser/tools/codeTools.js';
import { editCheckContext, postToolUseHookOutput } from '../../../services/voltRuntime/browser/tools/editDiagnostics.js';

/** The edit's start waits this long for the file's errors as they were (it holds up the edit). */
export const BASELINE_WAIT_MS = 1_500;
/** A read's check runs in the background and may take this long (a language server still loading the project). */
const READ_BASELINE_WAIT_MS = 30_000;
/**
 * A language service started by the edit itself (the first edit of a window) may take this long to
 * answer about the text before the edit; the document is held at that text meanwhile.
 */
export const COLD_BASELINE_WAIT_MS = 30_000;
/** The edit's end waits this long for the language server to report on the new text. */
export const AFTER_EDIT_WAIT_MS = 4_000;
/**
 * The edit's end waits this long when the language service was started by this edit (the hook's own
 * timeout is 8 s). An answer that takes longer goes out with the chat's next hook answer.
 */
export const COLD_AFTER_EDIT_WAIT_MS = 7_000;
const BASELINE_TTL_MS = 10 * 60_000;
/** Late answers kept per chat; older ones are dropped (the end-of-turn check still covers the files). */
const MAX_LATE = 8;

/** What the edit checks need from the window's code intelligence (`CodeIntelHost`). */
export interface IEditCheckHost {
	languageServiceRunning(uri: URI): boolean;
	settledErrorCounts(uri: URI, waitMs: number): Promise<Map<string, number> | undefined>;
	pinnedErrorCounts(uri: URI, waitMs: number): Promise<Map<string, number> | undefined>;
	noteWrite(uri: URI): void;
	errorCounts(uri: URI): Map<string, number>;
	newErrors(uri: URI, baseline: ReadonlyMap<string, number>): Promise<IDiagnostic[]>;
}

/**
 * Claude Code's hooks around its file tools (see `EDIT_CHECK_TOOL_NAME`): the edit's start notes the
 * file's errors, its end answers the errors it added, as the hook's context for the model.
 *
 * No language service is started for a file an agent only read: a read warms the file's errors only
 * when its language service is already up (an editor tab, an earlier edit). The first edit starts
 * it: the edit's start opens the file, and when the service has not answered by the time the edit
 * may go on, the document stays held at the text before the edit until it has, so the edit's end
 * still compares before and after. An answer later than the hook may wait is handed to the chat's
 * next hook answer.
 */
export class EditChecks {

	/** Each file's errors before an edit. */
	private readonly baselines = new ResourceMap<{ readonly counts: Map<string, number>; readonly at: number }>();
	/** Baselines still being read when the edit's start let the edit go on. */
	private readonly pending = new ResourceMap<{ readonly counts: Promise<Map<string, number> | undefined> }>();
	/** Checks that finished after their hook answered, per chat, for its next hook answer. */
	private readonly late = new Map<string, string[]>();

	constructor(private readonly host: IEditCheckHost) { }

	/**
	 * The hook's answer (JSON for Claude Code). `shown`: the file's path as the model knows it.
	 * `chat`: the chat whose agent made the call, when known.
	 */
	async run(phase: EditCheckPhase, uri: URI | undefined, shown: string, chat: string | undefined): Promise<string> {
		const own = uri ? await this.check(phase, uri, shown, chat).catch(() => undefined) : undefined;
		// Both hooks that can carry context for the model are PostToolUse hooks (`after`, `read`).
		const late = phase !== 'before' && chat ? this.late.get(chat) : undefined;
		if (late?.length) {
			this.late.delete(chat!);
		}
		return postToolUseHookOutput([...(late ?? []), ...(own ? [own] : [])]);
	}

	/** The context this hook call adds for the model, if any. */
	private async check(phase: EditCheckPhase, uri: URI, shown: string, chat: string | undefined): Promise<string | undefined> {
		this.forgetOldBaselines();
		switch (phase) {
			case 'read': {
				if (!this.host.languageServiceRunning(uri)) {
					return undefined; // the first edit starts it
				}
				// The file's errors are read now, while the model thinks, so the edit's start need not wait.
				const at = Date.now();
				void this.host.settledErrorCounts(uri, READ_BASELINE_WAIT_MS).then(counts => {
					if (counts && (this.baselines.get(uri)?.at ?? 0) < at) {
						this.baselines.set(uri, { counts, at });
					}
				}, () => { /* no baseline */ });
				return undefined;
			}
			case 'before': {
				// Opens the file, which starts its language service when none is up (the first edit).
				const reading = this.host.pinnedErrorCounts(uri, COLD_BASELINE_WAIT_MS).catch(() => undefined);
				const entry = { counts: reading };
				this.pending.set(uri, entry);
				void reading.then(counts => {
					if (this.pending.get(uri) === entry) { // else the edit's end (or a newer start) took it over
						this.pending.delete(uri);
						if (counts) {
							this.baselines.set(uri, { counts, at: Date.now() });
						}
						// Else the baseline the read (or the last edit) left stays, if any.
					}
				});
				// Still being read after this (a language service that is starting): the edit goes on, the
				// document stays held at the text before it, and the edit's end waits for the answer.
				await raceTimeout(reading, BASELINE_WAIT_MS);
				return undefined;
			}
			case 'after': {
				const pending = this.pending.get(uri);
				this.pending.delete(uri);
				if (!pending) {
					const baseline = this.baselines.get(uri);
					this.host.noteWrite(uri);
					if (!baseline) {
						return undefined;
					}
					const added = await raceTimeout(this.host.newErrors(uri, baseline.counts), AFTER_EDIT_WAIT_MS);
					// The next edit of this file is compared with the file as this one left it.
					this.baselines.set(uri, { counts: this.host.errorCounts(uri), at: Date.now() });
					return added?.length ? editCheckContext(added, shown) : undefined;
				}
				// The file's errors before this edit are still being read from a document held at that
				// text; the new text is checked after them.
				let answered = false;
				const check = pending.counts.then(async counts => {
					const baseline = counts ?? this.baselines.get(uri)?.counts;
					this.host.noteWrite(uri);
					if (!baseline) {
						return undefined;
					}
					const added = await this.host.newErrors(uri, baseline);
					this.baselines.set(uri, { counts: this.host.errorCounts(uri), at: Date.now() });
					const context = added.length ? editCheckContext(added, shown, answered) : undefined;
					if (context && answered && chat) {
						const late = this.late.get(chat) ?? [];
						late.push(context);
						this.late.set(chat, late.slice(-MAX_LATE));
					}
					return context;
				}).catch(() => undefined);
				const context = await raceTimeout(check, COLD_AFTER_EDIT_WAIT_MS);
				answered = true;
				return context;
			}
		}
	}

	private forgetOldBaselines(): void {
		const now = Date.now();
		for (const [uri, baseline] of this.baselines) {
			if (now - baseline.at > BASELINE_TTL_MS) {
				this.baselines.delete(uri);
			}
		}
	}
}
