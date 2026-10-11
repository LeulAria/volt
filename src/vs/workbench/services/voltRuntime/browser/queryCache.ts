/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IndexedDB } from '../../../../base/browser/indexedDB.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Data that comes from the network or a slow scan (usage, marketplace listings, pull requests),
 * kept like React Query does: a page shows what it last fetched at once, from memory or from
 * IndexedDB after a restart, refetches behind it when that is stale, and every page showing the
 * same key updates together. Fetches of one key run once at a time.
 */

export const IVoltQueryCache = createDecorator<IVoltQueryCache>('voltQueryCache');

export interface IVoltQuery<T> {
	/** Names the data; `invalidate` takes a prefix of it ("marketplace.", "pr.list:owner/repo"). */
	readonly key: string;
	/** `force` is set by a refresh the user asked for: skip the source's own caches too. */
	readonly fetch: (force: boolean) => Promise<T>;
	/** How long data counts as fresh; older data still shows and refetches. Default 30 seconds. */
	readonly staleTime?: number;
	/** Kept in IndexedDB across restarts (the value must be structured-clonable). Default true. */
	readonly persist?: boolean;
	/** Data saved longer ago than this is not shown after a restart. Default 30 days. */
	readonly maxAge?: number;
}

export interface IVoltQueryState<T> {
	readonly data: T | undefined;
	/** When `data` was fetched (epoch ms). */
	readonly updatedAt: number | undefined;
	/** The last fetch failed; `data` is the last good value, if any. */
	readonly error: unknown;
	readonly fetching: boolean;
	/** False until memory or disk has been checked, so a page can tell "nothing yet" from "nothing cached". */
	readonly loaded: boolean;
}

export interface IVoltQueryHandle<T> extends IDisposable {
	readonly state: IVoltQueryState<T>;
	readonly onDidChange: Event<IVoltQueryState<T>>;
	/** Fetches now (the refresh button); resolves when it settles. */
	refetch(force?: boolean): Promise<void>;
}

export interface IVoltQueryCache {
	readonly _serviceBrand: undefined;
	/**
	 * Watches a key: the handle starts on the cached value (memory now, disk shortly) and fetches
	 * when there is none or it is stale. Dispose it when the page closes.
	 */
	watch<T>(query: IVoltQuery<T>): IVoltQueryHandle<T>;
	/** The value, cached when fresh, else fetched (one fetch per key at a time). */
	get<T>(query: IVoltQuery<T>, force?: boolean): Promise<T>;
	/**
	 * The value at hand however old, refetching behind it when stale; waits only when nothing is
	 * cached. A refetch that lands fires {@link onDidUpdate} with the key, so a service can tell its
	 * pages to redraw.
	 */
	read<T>(query: IVoltQuery<T>): Promise<T>;
	/** A key got new data from a fetch (not from disk). */
	readonly onDidUpdate: Event<string>;
	/** Replaces the value (after a change the page made itself, e.g. installing a skill). */
	set<T>(key: string, data: T, persist?: boolean): void;
	/** Marks every key with this prefix stale; watched ones refetch now. */
	invalidate(prefix: string): void;
}

const DB_NAME = 'volt-query-cache';
const STORE = 'entries';
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

interface IStored {
	readonly data: unknown;
	readonly updatedAt: number;
}

interface IEntry {
	data: unknown;
	updatedAt: number | undefined;
	error: unknown;
	fetching: Promise<unknown> | undefined;
	loaded: boolean;
	/** Reading the saved value from disk, once. */
	loading: Promise<void> | undefined;
	stale: boolean;
	readonly onDidChange: Emitter<void>;
	/** The latest query of each watcher, so `invalidate` can refetch with it. */
	readonly watchers: Set<IVoltQuery<unknown>>;
}

function isStored(value: unknown): value is IStored {
	return !!value && typeof value === 'object' && typeof (value as IStored).updatedAt === 'number' && 'data' in value;
}

export class VoltQueryCache extends Disposable implements IVoltQueryCache {

	declare readonly _serviceBrand: undefined;

	private readonly entries = new Map<string, IEntry>();
	private readonly _onDidUpdate = this._register(new Emitter<string>());
	readonly onDidUpdate = this._onDidUpdate.event;
	private db: Promise<IndexedDB | undefined> | undefined;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) {
				entry.onDidChange.dispose();
			}
			void this.db?.then(db => db?.close());
		}));
	}

	watch<T>(query: IVoltQuery<T>): IVoltQueryHandle<T> {
		const entry = this.entry(query.key);
		const watcher = query as IVoltQuery<unknown>;
		entry.watchers.add(watcher);
		const onDidChange = new Emitter<IVoltQueryState<T>>();
		const stateOf = (): IVoltQueryState<T> => ({ data: entry.data as T | undefined, updatedAt: entry.updatedAt, error: entry.error, fetching: !!entry.fetching, loaded: entry.loaded });
		const listener = entry.onDidChange.event(() => onDidChange.fire(stateOf()));
		void this.load(query).then(() => {
			if (entry.watchers.has(watcher) && this.isStale(entry, query)) {
				void this.fetch(query, false).catch(() => undefined);
			}
		});
		return {
			get state() {
				return stateOf();
			},
			onDidChange: onDidChange.event,
			refetch: force => this.fetch(query, !!force).then(() => undefined, () => undefined),
			dispose: () => {
				entry.watchers.delete(watcher);
				listener.dispose();
				onDidChange.dispose();
			},
		};
	}

	async get<T>(query: IVoltQuery<T>, force = false): Promise<T> {
		await this.load(query);
		const entry = this.entry(query.key);
		if (!force && entry.updatedAt !== undefined && !this.isStale(entry, query)) {
			return entry.data as T;
		}
		return this.fetch(query, force);
	}

	async read<T>(query: IVoltQuery<T>): Promise<T> {
		await this.load(query);
		const entry = this.entry(query.key);
		if (entry.updatedAt === undefined) {
			return this.fetch(query, false);
		}
		if (this.isStale(entry, query)) {
			void this.fetch(query, false).catch(() => undefined);
		}
		return entry.data as T;
	}

	set<T>(key: string, data: T, persist = true): void {
		const entry = this.entry(key);
		entry.data = data;
		entry.updatedAt = Date.now();
		entry.error = undefined;
		entry.stale = false;
		entry.loaded = true;
		entry.onDidChange.fire();
		if (persist) {
			this.save(key, { data, updatedAt: entry.updatedAt });
		}
	}

	invalidate(prefix: string): void {
		for (const [key, entry] of this.entries) {
			if (!key.startsWith(prefix)) {
				continue;
			}
			entry.stale = true;
			const watcher = [...entry.watchers].pop();
			if (watcher) {
				void this.fetch(watcher, false).catch(() => undefined);
			}
		}
	}

	private entry(key: string): IEntry {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { data: undefined, updatedAt: undefined, error: undefined, fetching: undefined, loaded: false, loading: undefined, stale: false, onDidChange: new Emitter<void>(), watchers: new Set() };
			this.entries.set(key, entry);
		}
		return entry;
	}

	private isStale(entry: IEntry, query: IVoltQuery<unknown>): boolean {
		return entry.stale || entry.updatedAt === undefined || Date.now() - entry.updatedAt >= (query.staleTime ?? DEFAULT_STALE_MS);
	}

	/** Memory first; the saved value once per key (unless something newer arrived meanwhile). */
	private load(query: IVoltQuery<unknown>): Promise<void> {
		const entry = this.entry(query.key);
		if (entry.loaded || query.persist === false) {
			if (!entry.loaded) {
				entry.loaded = true;
				entry.onDidChange.fire();
			}
			return Promise.resolve();
		}
		entry.loading ??= this.readStored(query.key).then(stored => {
			if (stored && entry.updatedAt === undefined && Date.now() - stored.updatedAt < (query.maxAge ?? DEFAULT_MAX_AGE_MS)) {
				entry.data = stored.data;
				entry.updatedAt = stored.updatedAt;
			}
			entry.loaded = true;
			entry.onDidChange.fire();
		});
		return entry.loading;
	}

	private fetch<T>(query: IVoltQuery<T>, force: boolean): Promise<T> {
		const entry = this.entry(query.key);
		if (entry.fetching && !force) {
			return entry.fetching as Promise<T>;
		}
		const fetching = query.fetch(force).then(data => {
			if (entry.fetching === fetching) {
				entry.data = data;
				entry.updatedAt = Date.now();
				entry.error = undefined;
				entry.stale = false;
				entry.loaded = true;
				if (query.persist !== false) {
					this.save(query.key, { data, updatedAt: entry.updatedAt });
				}
				this._onDidUpdate.fire(query.key);
			}
			return data;
		}, error => {
			if (entry.fetching === fetching) {
				entry.error = error;
			}
			throw error;
		}).finally(() => {
			if (entry.fetching === fetching) {
				entry.fetching = undefined;
				entry.onDidChange.fire();
			}
		});
		entry.fetching = fetching;
		entry.onDidChange.fire();
		return fetching;
	}

	private database(): Promise<IndexedDB | undefined> {
		this.db ??= IndexedDB.create(DB_NAME, 1, [STORE]).catch(error => {
			this.logService.warn('[volt-cache] IndexedDB unavailable; caching in memory only', error);
			return undefined;
		});
		return this.db;
	}

	private async readStored(key: string): Promise<IStored | undefined> {
		try {
			const db = await this.database();
			const value = db ? await db.runInTransaction(STORE, 'readonly', store => store.get(key)) : undefined;
			return isStored(value) ? value : undefined;
		} catch (error) {
			this.logService.trace('[volt-cache] read failed', key, error);
			return undefined;
		}
	}

	private save(key: string, value: IStored): void {
		void this.database().then(db => db?.runInTransaction(STORE, 'readwrite', store => store.put(value, key))).catch(error => {
			// Not structured-clonable, or out of quota: the value still lives in memory.
			this.logService.trace('[volt-cache] write failed', key, error);
		});
	}
}

registerSingleton(IVoltQueryCache, VoltQueryCache, InstantiationType.Delayed);
