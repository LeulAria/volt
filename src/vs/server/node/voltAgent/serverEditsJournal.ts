/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../base/common/map.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ReplicatedCollection } from '../../../platform/voltAgentServer/common/collections.js';
import { IAgentBaselineOptions, IAgentBinaryBaseline, IAgentEditResolution, IAgentEditsService, IAgentPendingFile } from '../../../workbench/contrib/voltAgent/browser/review/agentEditsService.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { writeFileAtomic } from '../../../platform/voltAgentServer/node/agentServerFiles.js';
import { AgentEditsJournalEntry } from '../../../workbench/contrib/voltAgent/common/agentEditsJournal.js';

type EditsJournalEntry = AgentEditsJournalEntry;

const MAX_ENTRIES = 5_000;

/**
 * The server side of pending edits. The review itself needs editor models, so it stays in the
 * desktop window; the server journals everything that window would have seen and keeps it
 * (on disk) until a window applies it. Edits made while no window is open are reviewable later.
 */
export class ServerEditsJournal extends Disposable implements Partial<IAgentEditsService> {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidResolve = this._register(new Emitter<IAgentEditResolution>());
	readonly onDidResolve: Event<IAgentEditResolution> = this._onDidResolve.event;
	readonly onDidChange: Event<URI> = Event.None;

	private readonly entries = new Map<string, EditsJournalEntry>();
	private nextId = 1;
	/** Files a window reports as in review right now. */
	private pending = new ResourceMap<string>();
	private readonly saver: RunOnceScheduler;

	constructor(
		private readonly file: string,
		private readonly collection: ReplicatedCollection,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.saver = this._register(new RunOnceScheduler(() => void this.save(), 500));
		// The same events the desktop's edits service reads, in the same way.
		this._register(runtime.onDidEmit(envelope => {
			const event = envelope.event;
			if (event.type === 'file.change' && URI.isUri(event.uri)) {
				const existed = event.existed ?? event.kind !== 'create';
				if (existed && event.before === undefined) {
					return;
				}
				this.add({ kind: 'file', sessionId: envelope.sessionId, uri: event.uri.toJSON(), ...(existed ? { before: event.before } : {}) });
			} else if (event.type === 'run.end') {
				this.add({ kind: 'finished', sessionId: envelope.sessionId });
			}
		}));
	}

	async load(): Promise<void> {
		try {
			const stored = JSON.parse(await fs.readFile(this.file, 'utf8')) as { next: number; entries: [string, EditsJournalEntry][] };
			this.nextId = stored.next;
			for (const [id, entry] of stored.entries) {
				this.entries.set(id, entry);
			}
		} catch {
			// nothing journaled yet
		}
		this.collection.replace(Object.fromEntries(this.entries));
	}

	recordBaseline(sessionId: string, uri: URI, before: string | undefined, options?: IAgentBaselineOptions): void {
		this.add({
			kind: 'baseline', sessionId, uri: uri.toJSON(),
			...(before !== undefined ? { before } : {}),
			...(options?.agentText !== undefined ? { agentText: options.agentText } : {}),
			...(options?.renamedFrom ? { renamedFrom: options.renamedFrom.toJSON() } : {}),
		});
	}

	recordBinaryBaseline(sessionId: string, uri: URI, baseline: IAgentBinaryBaseline | undefined, options?: { readonly renamedFrom?: URI }): void {
		this.add({ kind: 'binary', sessionId, uri: uri.toJSON(), ...(baseline ? { baseline } : {}), ...(options?.renamedFrom ? { renamedFrom: options.renamedFrom.toJSON() } : {}) });
	}

	/** In review in a window: the checkpoint service leaves those files alone. */
	getPendingFile(uri: URI): IAgentPendingFile | undefined {
		const sessionId = this.pending.get(uri);
		if (!sessionId) {
			return undefined;
		}
		// Only whether it is in review matters here; the review itself is the window's.
		const pending: IAgentPendingFile = { uri, sessionId, baselineUri: uri, kind: 'modified', additions: 0, deletions: 0, changes: [] };
		return pending;
	}

	/** A window applied these entries. */
	ack(ids: readonly string[]): void {
		const removed: Record<string, undefined> = {};
		for (const id of ids) {
			if (this.entries.delete(id)) {
				removed[id] = undefined;
			}
		}
		this.collection.update(removed);
		this.saver.schedule();
	}

	/** A window's current review: which files are pending and for which chat. */
	setPending(files: readonly { readonly uri: UriComponents; readonly sessionId: string }[]): void {
		const next = new ResourceMap<string>();
		for (const file of files) {
			next.set(URI.revive(file.uri), file.sessionId);
		}
		this.pending = next;
	}

	resolved(resolution: { readonly sessionId: string; readonly uri: UriComponents; readonly outcome: 'kept' | 'undone' }): void {
		this._onDidResolve.fire({ sessionId: resolution.sessionId, uri: URI.revive(resolution.uri), outcome: resolution.outcome });
	}

	private add(entry: EditsJournalEntry): void {
		const id = String(this.nextId++).padStart(10, '0');
		this.entries.set(id, entry);
		const update: Record<string, unknown> = { [id]: entry };
		while (this.entries.size > MAX_ENTRIES) {
			const oldest = this.entries.keys().next().value!;
			this.entries.delete(oldest);
			update[oldest] = undefined;
		}
		this.collection.update(update);
		this.saver.schedule();
	}

	private async save(): Promise<void> {
		try {
			await writeFileAtomic(this.file, JSON.stringify({ next: this.nextId, entries: [...this.entries] }), 0o600);
		} catch (err) {
			this.logService.warn('[volt agent server] could not save the edits journal', err);
		}
	}

	async flush(): Promise<void> {
		this.saver.cancel();
		await this.save();
	}
}
