/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { UniversalWatcher } from './watcher.js';

/**
 * Hosts the universal watcher inside the shared process instead of a
 * utility process per window, which saves a whole Node process.
 *
 * Every window still gets a watcher of its own: `watch()` replaces the
 * full set of requests of the caller, so windows must not share one.
 * Watchers are keyed by the connection context (`window:<id>`) and
 * stopped when the last connection with that context goes away.
 */
export class PerWindowWatcherChannel extends Disposable implements IServerChannel<string> {

	private readonly watchers = new Map<string, { readonly watcher: UniversalWatcher; readonly channel: IServerChannel<string>; readonly store: DisposableStore }>();

	constructor(private readonly server: IPCServer<string>) {
		super();

		this._register(server.onDidRemoveConnection(connection => {
			const ctx = connection.ctx;
			// A reloading window can connect again before its old connection
			// is gone; keep the watcher while any connection still uses it.
			if (!this.server.connections.some(other => other.ctx === ctx)) {
				this.release(ctx);
			}
		}));
	}

	call<T>(ctx: string, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		return this.acquire(ctx).channel.call<T>(ctx, command, arg, cancellationToken);
	}

	listen<T>(ctx: string, event: string, arg?: unknown): Event<T> {
		return this.acquire(ctx).channel.listen<T>(ctx, event, arg);
	}

	private acquire(ctx: string) {
		let entry = this.watchers.get(ctx);
		if (!entry) {
			const store = new DisposableStore();
			const watcher = store.add(new UniversalWatcher());
			entry = { watcher, channel: ProxyChannel.fromService(watcher, store), store };
			this.watchers.set(ctx, entry);
		}
		return entry;
	}

	private release(ctx: string): void {
		const entry = this.watchers.get(ctx);
		if (!entry) {
			return;
		}
		this.watchers.delete(ctx);
		// Stop before disposing: native watchers that are still subscribed
		// when they are torn down can crash the process.
		entry.watcher.stop().finally(() => entry.store.dispose());
	}

	override dispose(): void {
		for (const ctx of [...this.watchers.keys()]) {
			this.release(ctx);
		}
		super.dispose();
	}
}
