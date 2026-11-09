/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { decisionRecord, IAccessRequest, IDecision, IDecisionLogRecord, IPolicySnapshotInput, PolicySnapshot, replayDecision, replayProvesRequest } from '../common/authority.js';
import { canonicalJson } from '../common/grants.js';
import { ICallContext } from '../common/principals.js';

/**
 * The decision log (spec G.11, INV-32, POL-DET-1): every decision as `(v, epoch, snapshotDigest,
 * request, reqDigest, ctxDigest, decision)`, one JSON object per line, with each snapshot written once per
 * file (by digest) before the first decision that used it, so a day's decisions replay against the
 * snapshots they were made on. Files are 0600 under `~/.volt/trust/decisions/` and rotate by size.
 */

export const DEFAULT_DECISION_LOG_DIR = join(homedir(), '.volt', 'trust', 'decisions');

interface ISnapshotLine {
	readonly type: 'snapshot';
	readonly digest: string;
	readonly snapshot: IPolicySnapshotInput;
}

interface IDecisionLine extends IDecisionLogRecord {
	readonly type: 'decision';
	readonly at: number;
}

export interface IDecisionLogOptions {
	/** Rotate when the current file passes this size. */
	readonly maxBytes?: number;
	/** Rotated files kept besides the current one. */
	readonly keep?: number;
	readonly now?: () => number;
}

export class DecisionLog {

	private readonly file: string;
	private readonly written = new Set<string>();
	private size = -1;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(readonly dir = DEFAULT_DECISION_LOG_DIR, private readonly options: IDecisionLogOptions = {}) {
		this.file = join(dir, 'decisions.log');
	}

	/** Appends one decision (and its snapshot, once per file). */
	append(snapshot: PolicySnapshot, request: IAccessRequest, context: ICallContext, decision: IDecision): Promise<void> {
		return this.appendRecord(snapshot, decisionRecord(snapshot, request, context, decision));
	}

	/** Appends a decision record made on `snapshot` (the Authority's `log` hands these over). */
	appendRecord(snapshot: PolicySnapshot, record: IDecisionLogRecord): Promise<void> {
		return this.serial(async () => {
			await this.ensureFile();
			let text = '';
			if (!this.written.has(record.snapshotDigest)) {
				const line: ISnapshotLine = { type: 'snapshot', digest: record.snapshotDigest, snapshot: snapshot.toJSON() };
				text += JSON.stringify(line) + '\n';
			}
			const line: IDecisionLine = { type: 'decision', at: (this.options.now ?? Date.now)(), ...record };
			text += JSON.stringify(line) + '\n';
			await fs.appendFile(this.file, text, { mode: 0o600 });
			this.written.add(record.snapshotDigest);
			this.size += Buffer.byteLength(text);
		});
	}

	flush(): Promise<void> {
		return this.serial(async () => undefined);
	}

	private async ensureFile(): Promise<void> {
		if (this.size < 0) {
			await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
			this.size = (await fs.stat(this.file).catch(() => undefined))?.size ?? 0;
			if (this.size > 0) {
				// Snapshots already in the file aren't known to this process: rotate so every file is self-contained.
				await this.rotate();
			}
		}
		if (this.size >= (this.options.maxBytes ?? 5 * 1024 * 1024)) {
			await this.rotate();
		}
	}

	private async rotate(): Promise<void> {
		const keep = this.options.keep ?? 5;
		await fs.unlink(join(this.dir, `decisions.${keep}.log`)).catch(() => undefined);
		for (let i = keep - 1; i >= 1; i--) {
			await fs.rename(join(this.dir, `decisions.${i}.log`), join(this.dir, `decisions.${i + 1}.log`)).catch(() => undefined);
		}
		await fs.rename(this.file, join(this.dir, 'decisions.1.log')).catch(() => undefined);
		this.size = 0;
		this.written.clear();
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

export interface IReplayMismatch {
	readonly line: number;
	readonly logged: IDecision;
	readonly replayed: IDecision | string;
}

/**
 * POL-DET-1: re-runs every decision in `file` against its logged snapshot; `mismatches` is empty
 * when all reproduce exactly. `unproven` counts version 1 records (an older Volt's), replayed
 * without proof that their request is the one decided.
 */
export async function replayDecisionLog(file: string): Promise<{ readonly decisions: number; readonly mismatches: readonly IReplayMismatch[]; readonly unproven: number }> {
	const text = await fs.readFile(file, 'utf8');
	const snapshots = new Map<string, PolicySnapshot>();
	const mismatches: IReplayMismatch[] = [];
	let decisions = 0;
	let unproven = 0;
	text.split('\n').forEach((raw, index) => {
		if (!raw.trim()) {
			return;
		}
		const line = JSON.parse(raw) as ISnapshotLine | IDecisionLine;
		if (line.type === 'snapshot') {
			snapshots.set(line.digest, PolicySnapshot.fromJSON(line.snapshot));
			return;
		}
		decisions++;
		if (!replayProvesRequest(line)) {
			unproven++;
		}
		const snapshot = snapshots.get(line.snapshotDigest);
		let replayed: IDecision | string;
		try {
			replayed = snapshot ? replayDecision(snapshot, line) : `snapshot ${line.snapshotDigest} is not in the file`;
		} catch (err) {
			replayed = err instanceof Error ? err.message : String(err);
		}
		if (typeof replayed === 'string' || canonicalJson(replayed) !== canonicalJson(line.decision)) {
			mismatches.push({ line: index + 1, logged: line.decision, replayed });
		}
	});
	return { decisions, mismatches, unproven };
}

/** Where the decision log of a store at `grantStorePath` lives. */
export function decisionLogDirFor(grantStorePath: string): string {
	return join(dirname(grantStorePath), 'decisions');
}
