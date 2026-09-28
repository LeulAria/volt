/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoltEvent, IVoltToolDiff } from '../common/events.js';

/** What a finished edit replaced. `before` is undefined when the call created the file. */
export interface IEditBaseline {
	readonly uri: URI;
	readonly kind: 'edit' | 'create' | 'delete';
	readonly before?: string;
	readonly existed: boolean;
}

interface ICallRecord {
	readonly snapshots: Map<string, Promise<string | undefined>>;
	readonly uris: Map<string, URI>;
	diffs: IVoltToolDiff[];
}

/**
 * Recovers what each agent edit replaced, for agents that write files themselves instead of
 * through Volt. The first time a call names a file (its locations, or the diff it will apply)
 * the file is read, which is before the agent writes it: the call is announced while its input
 * streams and it runs only after that. When the call ends the snapshot is compared with the
 * file on disk. If they already match, the snapshot came too late, and the call's own diffs are
 * reversed on the current text instead. An edit that cannot be recovered is left out.
 */
export class EditBaselineTracker {

	private readonly calls = new Map<string, ICallRecord>();

	constructor(
		private readonly fileService: IFileService,
		private readonly resolve: (sessionId: string, path: string) => URI | undefined,
	) { }

	/** Returns the baselines to report once `event` finished an editing call. */
	observe(sessionId: string, event: IVoltEvent): Promise<IEditBaseline[]> | undefined {
		switch (event.type) {
			case 'tool.start':
			case 'tool.update': {
				// Volt's own tools report `file.change` with the exact text they replaced.
				if (event.type === 'tool.start' && event.card) {
					return undefined;
				}
				const editing = event.kind === 'edit' || !!event.diffs?.length || this.calls.has(`${sessionId}\u0000${event.callId}`);
				const record = editing ? this.record(sessionId, event.callId, true) : undefined;
				if (!record) {
					return undefined;
				}
				const paths = [...(event.diffs ?? []).map(diff => diff.path), ...(event.locations ?? []).map(location => location.path)];
				for (const path of paths) {
					this.snapshot(sessionId, record, path);
				}
				if (event.diffs?.length) {
					record.diffs = mergeDiffs(record.diffs, event.diffs);
				}
				return undefined;
			}
			case 'tool.end': {
				const key = `${sessionId}\u0000${event.callId}`;
				const record = this.calls.get(key);
				if (event.diffs?.length) {
					const target = record ?? this.record(sessionId, event.callId, true)!;
					target.diffs = mergeDiffs(target.diffs, event.diffs);
					for (const diff of event.diffs) {
						// Too late to snapshot; the reversed diff is all there is.
						if (!target.uris.has(diff.path)) {
							const uri = this.resolve(sessionId, diff.path);
							if (uri) {
								target.uris.set(diff.path, uri);
							}
						}
					}
				}
				const finished = this.calls.get(key);
				this.calls.delete(key);
				if (!finished || event.error) {
					return undefined;
				}
				return this.settle(finished);
			}
			case 'run.end':
				for (const key of [...this.calls.keys()]) {
					if (key.startsWith(`${sessionId}\u0000`)) {
						this.calls.delete(key);
					}
				}
				return undefined;
			default:
				return undefined;
		}
	}

	private record(sessionId: string, callId: string, create: boolean): ICallRecord | undefined {
		const key = `${sessionId}\u0000${callId}`;
		let record = this.calls.get(key);
		if (!record && create) {
			record = { snapshots: new Map(), uris: new Map(), diffs: [] };
			this.calls.set(key, record);
		}
		return record;
	}

	private snapshot(sessionId: string, record: ICallRecord, path: string): void {
		if (record.snapshots.has(path)) {
			return;
		}
		const uri = this.resolve(sessionId, path);
		if (!uri) {
			return;
		}
		record.uris.set(path, uri);
		record.snapshots.set(path, this.read(uri));
	}

	private async settle(record: ICallRecord): Promise<IEditBaseline[]> {
		const out: IEditBaseline[] = [];
		for (const [path, uri] of record.uris) {
			const current = await this.read(uri);
			const snapshot = record.snapshots.has(path) ? await record.snapshots.get(path) : NOT_READ;
			let before: string | undefined | typeof NOT_READ = NOT_READ;
			if (snapshot !== NOT_READ && snapshot !== current) {
				before = snapshot;
			} else {
				const reversed = reverseDiffs(current, record.diffs.filter(diff => diff.path === path));
				if (reversed !== NOT_READ && reversed !== current) {
					before = reversed;
				}
			}
			if (before === NOT_READ) {
				continue;
			}
			const existed = before !== undefined;
			out.push({
				uri,
				kind: !existed ? 'create' : current === undefined ? 'delete' : 'edit',
				...(existed ? { before } : {}),
				existed,
			});
		}
		return out;
	}

	private async read(uri: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}
}

const NOT_READ = Symbol('notRead');

function mergeDiffs(existing: IVoltToolDiff[], incoming: readonly IVoltToolDiff[]): IVoltToolDiff[] {
	const out = [...existing];
	for (const diff of incoming) {
		// Agents resend the same edit as its input settles, sometimes with more context lines.
		const same = out.findIndex(candidate => candidate.path === diff.path
			&& (candidate.newText === diff.newText || diff.newText.includes(candidate.newText)));
		if (same >= 0) {
			out[same] = diff;
		} else {
			out.push(diff);
		}
	}
	return out;
}

/**
 * Undo `diffs` on `current`, newest first. `oldText: null` means the call created the file.
 * Returns NOT_READ when a diff's new text is not found, since then the result is a guess.
 */
export function reverseDiffs(current: string | undefined, diffs: readonly IVoltToolDiff[]): string | undefined | typeof NOT_READ {
	if (!diffs.length) {
		return NOT_READ;
	}
	let text = current;
	for (let i = diffs.length - 1; i >= 0; i--) {
		const diff = diffs[i];
		if (diff.oldText === null) {
			return undefined;
		}
		if (text === undefined) {
			return diff.oldText;
		}
		if (text === diff.newText) {
			text = diff.oldText;
			continue;
		}
		const at = text.indexOf(diff.newText);
		if (at < 0 || !diff.newText) {
			return NOT_READ;
		}
		text = text.slice(0, at) + diff.oldText + text.slice(at + diff.newText.length);
	}
	return text;
}
