/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { AgentCheckpointService } from '../../../workbench/contrib/voltAgent/browser/review/agentCheckpointService.js';

/** A recursive watcher reports nothing until it has scanned the tree; until then a change could go unseen. */
const WATCH_READY_MS = 3_000;
/** Work trees watched at once; the oldest is let go (its chat's turns then take fresh snapshots). */
const MAX_WATCHES = 16;
/** After a watcher error, snapshots are taken fresh for this long. */
const WATCH_ERROR_BACKOFF_MS = 60_000;

interface IWatch {
	readonly disposable: IDisposable;
	readonly readyAt: number;
}

/**
 * The checkpoints of the server's chats. The server has no workspace folders whose watcher would
 * see the user's changes, so it watches each chat's work tree itself: a turn whose project nothing
 * touched since the last turn ended then reuses that turn's final snapshot instead of scanning the
 * tree again. Any doubt (the watcher just started, or it reported an error) means a fresh snapshot.
 */
export class ServerAgentCheckpointService extends AgentCheckpointService {

	private readonly watches = new Map<string, IWatch>();
	private failedAt = 0;
	private listening = false;

	protected override onDidTrackWorkTree(workTree: string): void {
		if (this.watches.has(workTree)) {
			return;
		}
		if (!this.listening) {
			this.listening = true;
			this._register(this.fileService.onDidWatchError(() => this.failedAt = Date.now()));
			this._register(toDisposable(() => {
				for (const watch of this.watches.values()) {
					watch.disposable.dispose();
				}
				this.watches.clear();
			}));
		}
		if (this.watches.size >= MAX_WATCHES) {
			const [oldest, watch] = this.watches.entries().next().value!;
			watch.disposable.dispose();
			this.watches.delete(oldest);
		}
		try {
			// Git's own folders are skipped (snapshots write there; the base ignores them anyway).
			const disposable = this.fileService.watch(URI.file(workTree), { recursive: true, excludes: ['**/.git/**'] });
			this.watches.set(workTree, { disposable, readyAt: Date.now() + WATCH_READY_MS });
		} catch {
			// Unwatched: every turn takes a fresh snapshot, as before.
		}
	}

	protected override isWatched(workTree: string, since: number): boolean {
		const watch = this.watches.get(workTree);
		return !!watch && watch.readyAt <= since && Date.now() - this.failedAt > WATCH_ERROR_BACKOFF_MS && this.failedAt < since;
	}
}
